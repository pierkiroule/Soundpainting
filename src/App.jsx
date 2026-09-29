import { useCallback, useEffect, useRef, useState } from 'react'

const PAPER = '#f4f0e8'
const BRUSHES = [
  { id: 'silk', name: 'Fil de lune', detail: 'filaments', color: '#8c9fc8', rgb: '140,159,200' },
  { id: 'bloom', name: 'Pétale', detail: 'auréoles', color: '#d99aa4', rgb: '217,154,164' },
  { id: 'mist', name: 'Pollen', detail: 'poussière', color: '#d8b66f', rgb: '216,182,111' },
]

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const lerp = (a, b, amount) => a + (b - a) * amount
const random = (min, max) => min + Math.random() * (max - min)

function makeTunnel(count = 90) {
  return Array.from({ length: count }, () => ({
    angle: Math.random() * Math.PI * 2,
    radius: random(.35, 1.2),
    depth: Math.random(),
    length: random(.04, .18),
  }))
}

function App() {
  const canvasRef = useRef(null)
  const engine = useRef({
    ctx: null, width: 0, height: 0, dpr: 1, frame: null, lastTime: 0,
    audioContext: null, stream: null, analyser: null, frequency: null, waveform: null,
    live: false, spraying: false, brush: BRUSHES[0], particles: [], tunnel: makeTunnel(),
    point: { x: 0, y: 0, vx: 0, vy: 0, phase: 0 }, camera: { x: 0, y: 0, zoom: 1, roll: 0 },
    features: { energy: 0, bass: 0, mid: 0, high: 0, flux: 0 }, previousEnergy: 0,
  })
  const [phase, setPhase] = useState('idle')
  const [brush, setBrush] = useState(BRUSHES[0])
  const [energy, setEnergy] = useState(0)
  const [error, setError] = useState('')

  const paintPaper = useCallback(() => {
    const e = engine.current
    if (!e.ctx) return
    e.ctx.setTransform(e.dpr, 0, 0, e.dpr, 0, 0)
    e.ctx.fillStyle = PAPER
    e.ctx.fillRect(0, 0, e.width, e.height)
    for (let index = 0; index < e.width * e.height / 900; index += 1) {
      e.ctx.fillStyle = `rgba(85,72,58,${random(.008, .025)})`
      e.ctx.fillRect(Math.random() * e.width, Math.random() * e.height, random(.2, .7), random(.2, .7))
    }
  }, [])

  const readSound = () => {
    const e = engine.current
    if (!e.analyser) return e.features
    e.analyser.getByteFrequencyData(e.frequency)
    e.analyser.getByteTimeDomainData(e.waveform)
    let rms = 0, bass = 0, mid = 0, high = 0
    for (const value of e.waveform) rms += ((value - 128) / 128) ** 2
    for (let index = 0; index < e.frequency.length; index += 1) {
      const value = e.frequency[index] / 255
      const ratio = index / e.frequency.length
      if (ratio < .08) bass += value / (e.frequency.length * .08)
      else if (ratio < .34) mid += value / (e.frequency.length * .26)
      else high += value / (e.frequency.length * .66)
    }
    const measured = clamp(Math.sqrt(rms / e.waveform.length) * 4.5)
    e.features = { energy: measured, bass: clamp(bass * 1.6), mid: clamp(mid * 2), high: clamp(high * 2.8), flux: clamp(Math.abs(measured - e.previousEnergy) * 5) }
    e.previousEnergy = measured
    return e.features
  }

  const emit = (x, y, features) => {
    const e = engine.current
    const amount = Math.floor(2 + features.energy * 9 + features.high * 4)
    for (let index = 0; index < amount; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = random(.15, 1.3) * (1 + features.high * 2)
      e.particles.push({
        x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 1, decay: random(.003, .009), size: random(.5, 2.2) * (1 + features.bass * 2),
        wobble: random(0, Math.PI * 2), brush: e.brush,
      })
    }
    if (e.particles.length > 1400) e.particles.splice(0, e.particles.length - 1400)
  }

  const drawParticle = (ctx, particle, features) => {
    const alpha = particle.life * (.12 + features.energy * .25)
    const { rgb, id } = particle.brush
    if (id === 'silk') {
      ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = .35 + features.high * .8
      ctx.beginPath(); ctx.moveTo(particle.px, particle.py); ctx.quadraticCurveTo(particle.x + Math.sin(particle.wobble) * 4, particle.y + Math.cos(particle.wobble) * 4, particle.x, particle.y); ctx.stroke()
    } else if (id === 'bloom') {
      ctx.strokeStyle = `rgba(${rgb},${alpha * .55})`; ctx.lineWidth = random(.4, 1.2)
      ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.size * (2.5 + (1 - particle.life) * 5), 0, Math.PI * 2); ctx.stroke()
    } else {
      ctx.fillStyle = `rgba(${rgb},${alpha * .8})`; ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.size * random(.25, 1), 0, Math.PI * 2); ctx.fill()
    }
  }

  const drawTunnel = (ctx, time, camera, features) => {
    const e = engine.current
    ctx.save(); ctx.translate(e.width / 2, e.height / 2); ctx.rotate(camera.roll)
    for (const mote of e.tunnel) {
      mote.depth -= (.0014 + features.energy * .003)
      if (mote.depth <= 0) mote.depth = 1
      const perspective = 1 / (.12 + mote.depth)
      const radius = mote.radius * Math.min(e.width, e.height) * .52 * perspective
      const x = Math.cos(mote.angle + time * .00003) * radius - camera.x * perspective * .12
      const y = Math.sin(mote.angle + time * .00003) * radius - camera.y * perspective * .12
      ctx.strokeStyle = `rgba(116,139,157,${(1 - mote.depth) * .09})`; ctx.lineWidth = .45
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x * (1 + mote.length), y * (1 + mote.length)); ctx.stroke()
    }
    ctx.restore()
  }

  const animate = useCallback((time) => {
    const e = engine.current
    if (!e.ctx) return
    const dt = Math.min(32, time - (e.lastTime || time)); e.lastTime = time
    const sound = readSound(); setEnergy(sound.energy)
    const point = e.point
    point.phase += .008 * dt * (1 + sound.mid * 2)
    const targetVx = Math.cos(point.phase * .71) * (1.2 + sound.high * 5) + Math.sin(point.phase * 2.7) * sound.flux * 8
    const targetVy = Math.sin(point.phase) * (1 + sound.mid * 4) + Math.cos(point.phase * 1.9) * sound.bass * 5
    point.vx = lerp(point.vx, targetVx, .025 + sound.flux * .12)
    point.vy = lerp(point.vy, targetVy, .025 + sound.flux * .12)
    point.x += point.vx * dt * .055; point.y += point.vy * dt * .055
    const limit = Math.min(e.width, e.height) * .26
    if (Math.abs(point.x) > limit) point.vx -= Math.sign(point.x) * .8
    if (Math.abs(point.y) > limit) point.vy -= Math.sign(point.y) * .8
    e.camera.x = lerp(e.camera.x, point.x, .018 + sound.bass * .02)
    e.camera.y = lerp(e.camera.y, point.y, .018 + sound.bass * .02)
    e.camera.zoom = lerp(e.camera.zoom, .92 + sound.bass * .3 - sound.high * .08, .025)
    e.camera.roll = lerp(e.camera.roll, Math.sin(point.phase * .22) * (.035 + sound.mid * .09), .018)

    const ctx = e.ctx
    ctx.setTransform(e.dpr, 0, 0, e.dpr, 0, 0)
    ctx.fillStyle = 'rgba(244,240,232,.065)'; ctx.fillRect(0, 0, e.width, e.height)
    drawTunnel(ctx, time, e.camera, sound)
    ctx.save(); ctx.translate(e.width / 2, e.height / 2); ctx.rotate(-e.camera.roll); ctx.scale(e.camera.zoom, e.camera.zoom); ctx.translate(-e.camera.x, -e.camera.y)
    if (e.spraying) emit(point.x, point.y, sound)
    for (let index = e.particles.length - 1; index >= 0; index -= 1) {
      const particle = e.particles[index]
      particle.px = particle.x; particle.py = particle.y
      particle.wobble += .04 + sound.high * .1
      particle.vx += Math.sin(particle.wobble) * sound.mid * .025
      particle.vy += Math.cos(particle.wobble * .8) * sound.high * .025
      particle.x += particle.vx * dt * .045; particle.y += particle.vy * dt * .045
      particle.life -= particle.decay * dt
      if (particle.life <= 0) e.particles.splice(index, 1)
      else drawParticle(ctx, particle, sound)
    }
    const glow = 7 + sound.energy * 22
    ctx.fillStyle = `rgba(${e.brush.rgb},.12)`; ctx.beginPath(); ctx.arc(point.x, point.y, glow, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = e.brush.color; ctx.beginPath(); ctx.arc(point.x, point.y, 3 + sound.energy * 5, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
    e.frame = requestAnimationFrame(animate)
  }, [])

  useEffect(() => {
    const e = engine.current
    const canvas = canvasRef.current
    e.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    const resize = () => {
      e.dpr = Math.min(devicePixelRatio || 1, 2); e.width = innerWidth; e.height = innerHeight
      canvas.width = e.width * e.dpr; canvas.height = e.height * e.dpr
      paintPaper()
    }
    resize(); addEventListener('resize', resize); e.frame = requestAnimationFrame(animate)
    return () => { removeEventListener('resize', resize); cancelAnimationFrame(e.frame); e.stream?.getTracks().forEach((track) => track.stop()); e.audioContext?.close() }
  }, [animate, paintPaper])

  const start = async () => {
    const e = engine.current
    setError('')
    try {
      e.audioContext ||= new AudioContext(); await e.audioContext.resume()
      e.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      const source = e.audioContext.createMediaStreamSource(e.stream)
      e.analyser = e.audioContext.createAnalyser(); e.analyser.fftSize = 1024; e.analyser.smoothingTimeConstant = .28
      source.connect(e.analyser); e.frequency = new Uint8Array(e.analyser.frequencyBinCount); e.waveform = new Uint8Array(e.analyser.fftSize)
      e.live = true; setPhase('live')
    } catch (microphoneError) { console.error(microphoneError); setError('Autorisez le microphone pour entrer dans le flux.') }
  }

  const selectBrush = (nextBrush) => { engine.current.brush = nextBrush; setBrush(nextBrush) }
  const setSpray = (active) => { engine.current.spraying = active }
  const clear = () => { engine.current.particles = []; paintPaper() }
  const download = () => { const link = document.createElement('a'); link.download = 'flux-sonore.png'; link.href = canvasRef.current.toDataURL('image/png'); link.click() }

  return (
    <main className={`app ${phase === 'live' ? 'is-live' : ''}`}>
      <canvas ref={canvasRef} className="space" aria-label="Tunnel sonore génératif" />
      <header className="brand"><span className="brand-mark">音</span><span><strong>Flux</strong><small>PEINDRE LE MOUVEMENT DU SON</small></span></header>
      {phase === 'idle' && <section className="welcome"><p>EXPÉRIENCE AUDIOVISUELLE</p><h1>Suivez le son<br />dans l’espace.</h1><p className="welcome-copy">Un point écoute, vole et ouvre un tunnel. Maintenez le spray pour déposer sa trajectoire.</p><button onClick={start}>ENTRER DANS LE FLUX <span>→</span></button>{error && <em>{error}</em>}</section>}
      {phase === 'live' && <>
        <div className="sound-status"><i style={{ transform: `scale(${.6 + energy})` }} /><span>SON ACTIF</span></div>
        <nav className="brushes" aria-label="Choisir une brosse">{BRUSHES.map((item, index) => <button key={item.id} className={brush.id === item.id ? 'active' : ''} onClick={() => selectBrush(item)} style={{ '--brush': item.color }} aria-pressed={brush.id === item.id}><i /><span><b>0{index + 1} · {item.name}</b><small>{item.detail}</small></span></button>)}</nav>
        <button className="spray" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setSpray(true) }} onPointerUp={() => setSpray(false)} onPointerCancel={() => setSpray(false)}><span>MAINTENIR</span><b>SPRAY</b><i /></button>
        <div className="actions"><button onClick={clear}>EFFACER</button><button onClick={download}>EXPORTER</button></div>
        <p className="instruction">LE SON DIRIGE LE VOL · VOUS DÉCIDEZ QUAND IL LAISSE UNE TRACE</p>
      </>}
    </main>
  )
}

export default App
