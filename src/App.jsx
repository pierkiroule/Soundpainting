import { useCallback, useEffect, useRef, useState } from 'react'

const SESSION_DURATION = 60
const FFT_SIZE = 2048
const BRISTLE_COUNT = 620
const PAPER = '#ebe6da'
const PALETTES = {
  sumi: { name: 'Encre', ink: '8,10,9', accent: '#d95535' },
  indigo: { name: 'Nuit', ink: '29,45,72', accent: '#315d83' },
  ember: { name: 'Terre', ink: '91,37,25', accent: '#b64b32' },
}

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const lerp = (a, b, t) => a + (b - a) * t
const rand = (a, b) => a + Math.random() * (b - a)
const gaussian = () => {
  let u = 0
  let v = 0
  while (!u) u = Math.random()
  while (!v) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function createBristles(binCount) {
  return Array.from({ length: BRISTLE_COUNT }, (_, index) => {
    const q = index / (BRISTLE_COUNT - 1)
    const u = Math.sign(q - 0.5) * Math.pow(Math.abs(q - 0.5) * 2, 0.68)
    return {
      u,
      bin: Math.floor(Math.pow(Math.abs(u), 1.55) * (binCount - 1)),
      phase: Math.random() * Math.PI * 2,
      width: rand(0.12, 1.1),
      bend: gaussian(),
    }
  })
}

function App() {
  const canvasRef = useRef(null)
  const engine = useRef({
    state: 'IDLE', context: null, audioContext: null, stream: null, analyser: null,
    frequency: null, waveform: null, spectrum: null, lastSpectrum: null, features: null,
    bristles: createBristles(FFT_SIZE / 2), pointerDown: false, lastPoint: null,
    cursor: null, palette: PALETTES.sumi,
    animation: null, dryingAnimation: null, startedAt: 0, width: 0, height: 0,
  })
  const [status, setStatus] = useState('Prêt à créer')
  const [phase, setPhase] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [energy, setEnergy] = useState(0)
  const [endOpen, setEndOpen] = useState(false)
  const [introOpen, setIntroOpen] = useState(true)
  const [palette, setPalette] = useState('sumi')
  const [features, setFeatures] = useState({ low: 0, mid: 0, high: 0, flux: 0 })
  const [error, setError] = useState('')

  const makePaper = useCallback(() => {
    const e = engine.current
    const ctx = e.context
    if (!ctx) return
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, e.width, e.height)
    for (let i = 0; i < (e.width * e.height) / 210; i += 1) {
      const x = Math.random() * e.width
      const y = Math.random() * e.height
      const angle = Math.random() * Math.PI
      const length = rand(2, 20)
      ctx.strokeStyle = Math.random() > 0.5
        ? `rgba(70,58,40,${rand(0.006, 0.022)})`
        : `rgba(255,255,250,${rand(0.025, 0.07)})`
      ctx.lineWidth = rand(0.12, 0.4)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
      ctx.stroke()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const e = engine.current
    e.context = canvas.getContext('2d', { alpha: false, desynchronized: true })
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      e.width = window.innerWidth
      e.height = window.innerHeight
      canvas.width = e.width * dpr
      canvas.height = e.height * dpr
      e.context.setTransform(dpr, 0, 0, dpr, 0, 0)
      makePaper()
    }
    resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(e.animation)
      cancelAnimationFrame(e.dryingAnimation)
      e.stream?.getTracks().forEach((track) => track.stop())
      e.audioContext?.close()
    }
  }, [makePaper])

  const analyse = useCallback(() => {
    const e = engine.current
    e.analyser.getByteFrequencyData(e.frequency)
    e.analyser.getByteTimeDomainData(e.waveform)
    let total = 0, weighted = 0, low = 0, mid = 0, high = 0, flux = 0
    for (let i = 0; i < e.frequency.length; i += 1) {
      const value = Math.pow(e.frequency[i] / 255, 0.68)
      e.spectrum[i] = value
      total += value
      weighted += value * i
      const f = i / e.frequency.length
      if (f < 0.07) low += value
      else if (f < 0.32) mid += value
      else high += value
      flux += Math.max(0, value - e.lastSpectrum[i])
      e.lastSpectrum[i] = value
    }
    let rms = 0, zeroCross = 0
    let previous = (e.waveform[0] - 128) / 128
    for (const byte of e.waveform) {
      const value = (byte - 128) / 128
      rms += value * value
      if ((value >= 0) !== (previous >= 0)) zeroCross += 1
      previous = value
    }
    const measuredEnergy = clamp(Math.sqrt(rms / e.waveform.length) * 5)
    e.features = {
      energy: measuredEnergy, low: clamp(low / 45), mid: clamp(mid / 110), high: clamp(high / 180),
      centroid: total ? weighted / total / e.frequency.length : 0,
      flux: clamp(flux / 30), noise: clamp((zeroCross / e.waveform.length) * 15),
    }
    return measuredEnergy
  }, [])

  const finishSession = useCallback(() => {
    const e = engine.current
    e.state = 'DRYING'
    e.pointerDown = false
    e.lastPoint = null
    e.stream?.getTracks().forEach((track) => track.stop())
    setPhase('drying')
    setStatus("L'encre se pose")
    setProgress(1)
    setEnergy(0)
    const started = performance.now()
    const dry = (now) => {
      const amount = clamp((now - started) / 2800)
      if (Math.random() < 0.35) {
        const ctx = e.context
        ctx.fillStyle = `rgba(30,27,22,${0.004 * (1 - amount)})`
        ctx.beginPath()
        ctx.arc(Math.random() * e.width, Math.random() * e.height, rand(0.2, 1), 0, Math.PI * 2)
        ctx.fill()
      }
      if (amount < 1) e.dryingAnimation = requestAnimationFrame(dry)
      else {
        e.state = 'FINISHED'
        setPhase('finished')
        setStatus('Empreinte terminée')
        setEndOpen(true)
      }
    }
    e.dryingAnimation = requestAnimationFrame(dry)
  }, [])

  const runLoop = useCallback((now = performance.now()) => {
    const e = engine.current
    if (e.state !== 'LIVE') return
    const currentEnergy = analyse()
    // Percussive changes answer the hand with a small, autonomous resonance.
    if (e.cursor && e.features.flux > 0.16 && Math.random() < e.features.flux * 0.32) {
      const ctx = e.context
      const radius = 5 + e.features.low * 24 + Math.random() * 8
      ctx.save()
      ctx.globalCompositeOperation = 'multiply'
      ctx.strokeStyle = `rgba(${e.palette.ink},${0.025 + e.features.flux * 0.08})`
      ctx.lineWidth = 0.4 + e.features.high * 1.2
      ctx.beginPath()
      ctx.ellipse(e.cursor.x + gaussian() * 16, e.cursor.y + gaussian() * 16, radius, radius * (0.25 + e.features.mid * 0.6), Math.random() * Math.PI, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
    const elapsed = (now - e.startedAt) / 1000
    setProgress(clamp(elapsed / SESSION_DURATION))
    setEnergy(currentEnergy)
    setFeatures(e.features)
    if (elapsed >= SESSION_DURATION) finishSession()
    else e.animation = requestAnimationFrame(runLoop)
  }, [analyse, finishSession])

  const choosePalette = (key) => {
    if (phase === 'live' || phase === 'drying') return
    engine.current.palette = PALETTES[key]
    setPalette(key)
  }

  const startSession = async () => {
    const e = engine.current
    if (e.state === 'LIVE') return
    setError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone indisponible')
      e.audioContext ||= new AudioContext()
      await e.audioContext.resume()
      e.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      const source = e.audioContext.createMediaStreamSource(e.stream)
      e.analyser = e.audioContext.createAnalyser()
      e.analyser.fftSize = FFT_SIZE
      e.analyser.smoothingTimeConstant = 0.1
      source.connect(e.analyser)
      e.frequency = new Uint8Array(e.analyser.frequencyBinCount)
      e.waveform = new Uint8Array(e.analyser.fftSize)
      e.spectrum = new Float32Array(e.analyser.frequencyBinCount)
      e.lastSpectrum = new Float32Array(e.analyser.frequencyBinCount)
      e.bristles = createBristles(e.analyser.frequencyBinCount)
      e.state = 'LIVE'
      e.startedAt = performance.now()
      setPhase('live')
      setStatus('Écoutez · tracez')
      setEndOpen(false)
      runLoop()
    } catch (err) {
      console.error(err)
      setStatus('Micro non disponible')
      setError("Autorisez l'accès au microphone pour commencer.")
    }
  }

  const paint = (a, b) => {
    const e = engine.current
    const f = e.features
    if (!f) return
    const ctx = e.context
    const dx = b.x - a.x, dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (!length) return
    const tx = dx / length, ty = dy / length, nx = -ty, ny = tx
    const velocity = length / Math.max(1, b.time - a.time)
    const voice = clamp((f.energy - 0.012) * 1.4)
    const width = (7 + f.low * 68 + f.energy * 28) * (0.65 + b.pressure * 0.7)
    const dryness = clamp(0.25 + velocity * 0.28 + f.noise * 0.16 + (1 - f.energy) * 0.28 - f.low * 0.12)
    ctx.lineCap = 'round'
    if (voice > 0.025) {
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = `rgba(${e.palette.ink},${0.003 + voice * 0.018})`; ctx.lineWidth = width * 1.32
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore()
    }
    if (voice > 0.018) {
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = `rgba(${e.palette.ink},${0.008 + voice * 0.085})`; ctx.lineWidth = width * 0.58
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo((a.x + b.x) / 2 + nx * gaussian() * f.mid * 4, (a.y + b.y) / 2 + ny * gaussian() * f.mid * 4, b.x, b.y); ctx.stroke(); ctx.restore()
    }
    for (let i = 0; i < e.bristles.length; i += 2) {
      const bristle = e.bristles[i]
      const spectral = e.spectrum[bristle.bin] || 0
      const activation = spectral * (0.25 + voice * 0.9)
      if (Math.random() > 0.015 + activation * 0.82) continue
      const oscillation = Math.sin(bristle.phase + performance.now() * 0.012 + spectral * 8)
      const spread = bristle.u * width * 0.52
      const deformation = oscillation * spectral * (1 + f.centroid * 11)
      const bend = bristle.bend * f.mid * 2.5
      const ax = a.x + nx * (spread + deformation) + tx * bend
      const ay = a.y + ny * (spread + deformation) + ty * bend
      const bx = b.x + nx * (spread + deformation), by = b.y + ny * (spread + deformation)
      ctx.strokeStyle = `rgba(${e.palette.ink},${(0.006 + activation * 0.16) * (1 - dryness * 0.5)})`
      ctx.lineWidth = bristle.width * (0.35 + spectral * 1.5)
      ctx.beginPath(); ctx.moveTo(ax + gaussian() * 0.2, ay + gaussian() * 0.2)
      ctx.quadraticCurveTo((ax + bx) / 2 + nx * oscillation * f.high * 4, (ay + by) / 2 + ny * oscillation * f.high * 4, bx, by); ctx.stroke()
    }
    const breath = f.noise * (0.3 + f.high * 0.7) * voice
    for (let i = 0; i < Math.floor(breath * 32); i += 1) {
      const along = Math.random(), lateral = gaussian() * width * (0.3 + breath * 0.8)
      ctx.fillStyle = `rgba(${e.palette.ink},${rand(0.006, 0.045)})`; ctx.beginPath()
      ctx.arc(lerp(a.x, b.x, along) + nx * lateral, lerp(a.y, b.y, along) + ny * lateral, rand(0.15, 1.8), 0, Math.PI * 2); ctx.fill()
    }
    for (let i = 0; i < Math.floor(voice * 18 + f.mid * 10); i += 1) {
      const along = Math.random(), lateral = gaussian() * width * 0.27
      ctx.fillStyle = `rgba(${e.palette.ink},${rand(0.01, 0.08) * voice})`; ctx.beginPath()
      ctx.arc(lerp(a.x, b.x, along) + nx * lateral, lerp(a.y, b.y, along) + ny * lateral, rand(0.12, 1.2), 0, Math.PI * 2); ctx.fill()
    }
    if (dryness > 0.4) {
      ctx.save(); ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < Math.floor(dryness * 10); i += 1) {
        const offset = gaussian() * width * 0.2
        ctx.strokeStyle = `rgba(238,233,223,${rand(0.01, 0.045)})`; ctx.lineWidth = rand(0.15, 0.8)
        ctx.beginPath(); ctx.moveTo(a.x + nx * offset, a.y + ny * offset); ctx.lineTo(b.x + nx * offset, b.y + ny * offset); ctx.stroke()
      }
      ctx.restore()
    }
  }

  const pointerDown = (event) => {
    const e = engine.current
    if (e.state !== 'LIVE') return
    e.pointerDown = true
    e.cursor = { x: event.clientX, y: event.clientY }
    e.lastPoint = { x: event.clientX, y: event.clientY, time: performance.now(), pressure: event.pressure > 0 ? event.pressure : 0.5 }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const pointerMove = (event) => {
    const e = engine.current
    if (e.state !== 'LIVE' || !e.pointerDown || !e.lastPoint) return
    const point = { x: event.clientX, y: event.clientY, time: performance.now(), pressure: event.pressure > 0 ? event.pressure : 0.5 }
    e.cursor = point
    const distance = Math.hypot(point.x - e.lastPoint.x, point.y - e.lastPoint.y)
    if (distance < 0.5) return
    const steps = Math.min(8, Math.max(1, Math.ceil(distance / 5)))
    let previous = e.lastPoint
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      const next = { x: lerp(e.lastPoint.x, point.x, t), y: lerp(e.lastPoint.y, point.y, t), time: lerp(e.lastPoint.time, point.time, t), pressure: lerp(e.lastPoint.pressure, point.pressure, t) }
      paint(previous, next); previous = next
    }
    e.lastPoint = point
  }
  const lift = () => { engine.current.pointerDown = false; engine.current.lastPoint = null }
  const reset = () => {
    const e = engine.current
    setEndOpen(false); makePaper(); e.bristles = createBristles(FFT_SIZE / 2); e.state = 'IDLE'
    setPhase('idle'); setStatus('Prêt à créer'); setProgress(0); setEnergy(0); setFeatures({ low: 0, mid: 0, high: 0, flux: 0 }); setError('')
  }

  const hint = phase === 'live' ? 'LEVEZ · REPRENEZ · PARLEZ · SOUFFLEZ' : phase === 'drying' ? 'NE TOUCHEZ PLUS' : phase === 'finished' ? 'UNE MINUTE DE VOIX · UNE EMPREINTE' : 'VOIX = MATIÈRE · GESTE = FORME'

  return (
    <main className={`app phase-${phase}`}>
      <canvas ref={canvasRef} className="paper" aria-label="Surface de dessin réactive à la voix" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={lift} onPointerCancel={lift} />
      <header className="brand" aria-label="Koe no Fude">
        <span className="brand-mark" aria-hidden="true">声</span>
        <span><strong>Koe no Fude</strong><small>声の筆 · LE PINCEAU DE LA VOIX</small></span>
      </header>
      <aside className="sound-panel" aria-label="Le son en matière">
        <span className="panel-kicker">LE SON EN MATIÈRE</span>
        {[['low', 'GRAVE', 'épaisseur'], ['mid', 'VOIX', 'mouvement'], ['high', 'AIGU', 'grain']].map(([key, label, effect]) => (
          <div className="sound-row" key={key}>
            <span>{label}</span><i><b style={{ transform: `scaleX(${0.06 + features[key] * .94})` }} /></i><em>{effect}</em>
          </div>
        ))}
      </aside>
      <section className="controls" aria-live="polite">
        <button className="start-button" onClick={startSession} disabled={phase === 'live' || phase === 'drying'}>
          <span className="button-dot" />{phase === 'finished' ? 'TERMINÉ' : 'COMMENCER'}
        </button>
        <div className="voice-orb" aria-hidden="true"><span style={{ transform: `scale(${0.42 + energy * 1.5})`, opacity: 0.38 + energy * 0.62 }} /></div>
        <div className="session-info">
          <div><span>{status}</span><span className="timer">{phase === 'live' ? `${Math.max(0, Math.ceil(60 - progress * 60))}s` : phase === 'finished' ? '60s' : '—'}</span></div>
          <div className="progress"><span style={{ transform: `scaleX(${progress})` }} /></div>
        </div>
      </section>
      {error && <p className="error-message">{error}</p>}
      <div className="edition"><span>EXPÉRIENCE SONORE</span><i /><span>ÉDITION 01</span></div>
      <p className="hint">{hint}</p>
      <section className={`intro ${introOpen ? 'is-open' : ''}`} aria-hidden={!introOpen}>
        <div className="intro-art" aria-hidden="true">
          <span className="orbit orbit-one" /><span className="orbit orbit-two" />
          <svg viewBox="0 0 600 760" role="presentation"><path d="M108 618 C 33 508, 161 464, 271 526 S 527 570, 494 422 C 466 296, 211 371, 173 236 C 139 116, 365 64, 451 177 C 535 286, 313 340, 286 197 C 271 119, 370 111, 394 172" /></svg>
          <small>votre geste</small><small>le monde sonore</small>
        </div>
        <div className="intro-content">
          <p className="intro-number">EXPÉRIENCE 01 <span>~ 60 SECONDES</span></p>
          <h1>Le son<br />prend <i>trait.</i></h1>
          <p className="intro-lead">Dessinez. Parlez, fredonnez, soufflez.<br />Le pinceau écoute et vous répond.</p>
          <div className="legend">
            <div><b>01</b><span>Votre geste<br /><em>donne la direction</em></span></div>
            <div><b>02</b><span>Votre voix<br /><em>transforme la matière</em></span></div>
            <div><b>03</b><span>L’ambiance<br /><em>laisse sa surprise</em></span></div>
          </div>
          <div className="palette-picker">
            <span>CHOISISSEZ UNE MATIÈRE</span>
            <div>{Object.entries(PALETTES).map(([key, value]) => <button key={key} className={palette === key ? 'active' : ''} onClick={() => choosePalette(key)} style={{ '--swatch': value.accent }}><i />{value.name}</button>)}</div>
          </div>
          <button className="enter-button" onClick={() => setIntroOpen(false)}>ENTRER DANS L’ATELIER <span>↗</span></button>
          <p className="privacy">Votre micro reste ici. Aucun son n’est enregistré.</p>
        </div>
      </section>
      <div className={`end-overlay ${endOpen ? 'is-open' : ''}`} aria-hidden={!endOpen}>
        <section className="end-card" role="dialog" aria-modal="true" aria-labelledby="end-title">
          <span className="end-stamp">声</span>
          <p className="eyebrow">VOTRE EMPREINTE</p>
          <h2 id="end-title">Une voix.<br />Une trace.</h2>
          <p className="end-copy">Votre minute de voix et de geste s’est déposée sur le papier.</p>
          <div className="end-actions"><button onClick={reset}>NOUVELLE</button><button className="secondary" onClick={() => setEndOpen(false)}>CONTEMPLER</button></div>
        </section>
      </div>
    </main>
  )
}

export default App
