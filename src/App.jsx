import { useCallback, useEffect, useRef, useState } from 'react'

const SESSION_DURATION = 60
const FFT_SIZE = 2048
const BRISTLE_COUNT = 620
const PAPER = '#f2eee5'
const TOOLS = [
  { id: 'brush', label: 'Lavis', glyph: '◒' },
  { id: 'ribbon', label: 'Nappe', glyph: '≈' },
  { id: 'spray', label: 'Brume', glyph: '⁙' },
  { id: 'pulse', label: 'Éclosion', glyph: '◌' },
  { id: 'eraser', label: 'Gomme', glyph: '◇' },
]
const INKS = [
  { id: 'sakura', label: 'Pétale', rgb: '212,139,143', hex: '#d48b8f' },
  { id: 'wisteria', label: 'Glycine', rgb: '132,132,169', hex: '#8484a9' },
  { id: 'mist', label: 'Brume', rgb: '116,158,161', hex: '#749ea1' },
  { id: 'moss', label: 'Mousse', rgb: '128,145,111', hex: '#80916f' },
  { id: 'ochre', label: 'Pollen', rgb: '202,164,102', hex: '#caa466' },
  { id: 'sumi', label: 'Sumi doux', rgb: '74,72,75', hex: '#4a484b' },
]

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
    animation: null, dryingAnimation: null, startedAt: 0, width: 0, height: 0, history: [],
    previewContext: null, gesture: null, recorder: null, recorderChunks: [], samples: [],
  })
  const [status, setStatus] = useState('Prêt à créer')
  const [phase, setPhase] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [energy, setEnergy] = useState(0)
  const [endOpen, setEndOpen] = useState(false)
  const [error, setError] = useState('')
  const [tool, setTool] = useState('brush')
  const [ink, setInk] = useState(INKS[0])
  const [brushSize, setBrushSize] = useState(1)
  const [hasMarks, setHasMarks] = useState(false)
  const [sampleCount, setSampleCount] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const previewRef = useRef(null)

  const makePaper = useCallback(() => {
    const e = engine.current
    const ctx = e.context
    if (!ctx) return
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, e.width, e.height)
    const wash = ctx.createRadialGradient(e.width * .52, e.height * .42, 0, e.width * .52, e.height * .42, Math.max(e.width, e.height) * .72)
    wash.addColorStop(0, 'rgba(255,253,247,.34)')
    wash.addColorStop(1, 'rgba(214,202,183,.12)')
    ctx.fillStyle = wash
    ctx.fillRect(0, 0, e.width, e.height)
    for (let i = 0; i < (e.width * e.height) / 145; i += 1) {
      const x = Math.random() * e.width
      const y = Math.random() * e.height
      const angle = Math.random() * Math.PI
      const length = rand(3, 28)
      ctx.strokeStyle = Math.random() > 0.5
        ? `rgba(92,76,59,${rand(0.008, 0.026)})`
        : `rgba(255,255,250,${rand(0.03, 0.09)})`
      ctx.lineWidth = rand(0.12, 0.55)
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
    e.previewContext = previewRef.current.getContext('2d', { alpha: true, desynchronized: true })
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      e.width = window.innerWidth
      e.height = window.innerHeight
      canvas.width = e.width * dpr
      canvas.height = e.height * dpr
      previewRef.current.width = e.width * dpr
      previewRef.current.height = e.height * dpr
      e.context.setTransform(dpr, 0, 0, dpr, 0, 0)
      e.previewContext.setTransform(dpr, 0, 0, dpr, 0, 0)
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
    const elapsed = (now - e.startedAt) / 1000
    setProgress(clamp(elapsed / SESSION_DURATION))
    setEnergy(currentEnergy)
    if (elapsed >= SESSION_DURATION && !e.pointerDown) finishSession()
    else e.animation = requestAnimationFrame(runLoop)
  }, [analyse, finishSession])

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
      setStatus('Touchez · jouez · fixez')
      setEndOpen(false)
      runLoop()
    } catch (err) {
      console.error(err)
      setStatus('Micro non disponible')
      setError("Autorisez l'accès au microphone pour commencer.")
    }
  }

  const paint = (a, b, target, recordedStyle, recordedFeatures) => {
    const e = engine.current
    const f = recordedFeatures || e.features
    if (!f) return
    const ctx = target || e.context
    const activeTool = recordedStyle?.tool || tool
    const activeInk = recordedStyle?.ink || ink
    const activeSize = recordedStyle?.brushSize || brushSize
    const dx = b.x - a.x, dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (!length) return
    const tx = dx / length, ty = dy / length, nx = -ty, ny = tx
    const velocity = length / Math.max(1, b.time - a.time)
    const voice = clamp((f.energy - 0.012) * 1.4)
    const width = (7 + f.low * 68 + f.energy * 28) * (0.65 + b.pressure * 0.7) * activeSize
    const dryness = clamp(0.25 + velocity * 0.28 + f.noise * 0.16 + (1 - f.energy) * 0.28 - f.low * 0.12)
    ctx.lineCap = 'round'
    if (activeTool === 'eraser') {
      ctx.save(); ctx.strokeStyle = PAPER; ctx.lineWidth = Math.max(18, width * 1.25); ctx.globalAlpha = 0.92
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore(); return
    }
    if (activeTool === 'spray') {
      const particles = Math.floor(8 + voice * 65 + f.high * 22)
      for (let i = 0; i < particles; i += 1) {
        const along = Math.random(), radius = Math.abs(gaussian()) * width * (0.35 + f.noise)
        const angle = Math.random() * Math.PI * 2
        ctx.fillStyle = `rgba(${activeInk.rgb},${rand(0.018, 0.1) * (0.4 + voice)})`; ctx.beginPath()
        ctx.arc(lerp(a.x, b.x, along) + Math.cos(angle) * radius, lerp(a.y, b.y, along) + Math.sin(angle) * radius, rand(.25, 1.5 + f.high * 2), 0, Math.PI * 2); ctx.fill()
      }
      return
    }
    if (activeTool === 'pulse') {
      if (Math.random() < .18 + f.flux * .5) {
        const bloom = 5 + width * (.3 + f.low)
        for (let ring = 0; ring < 4; ring += 1) {
          ctx.save(); ctx.strokeStyle = `rgba(${activeInk.rgb},${(.07 + voice * .18) / (ring + 1)})`; ctx.lineWidth = 1.4 + ring * 2.2
          ctx.beginPath(); ctx.arc(b.x + gaussian() * ring, b.y + gaussian() * ring, bloom + ring * 2.5, 0, Math.PI * 2); ctx.stroke(); ctx.restore()
        }
      }
      return
    }
    if (activeTool === 'ribbon') {
      for (let layer = 0; layer < 4; layer += 1) {
        ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = `rgba(${activeInk.rgb},${(.025 + voice * .11) / (1 + layer * .32)})`
        ctx.lineWidth = Math.max(3, width * (.5 + layer * .08)); ctx.beginPath(); ctx.moveTo(a.x + nx * width * .22, a.y + ny * width * .22)
        ctx.bezierCurveTo(a.x - nx * width * f.mid, a.y - ny * width * f.mid, b.x + nx * width * f.high, b.y + ny * width * f.high, b.x - nx * width * .22, b.y - ny * width * .22); ctx.stroke(); ctx.restore()
      }
      return
    }
    const pigment = .035 + voice * .12
    for (let layer = 0; layer < 5; layer += 1) {
      const drift = gaussian() * width * .045
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = `rgba(${activeInk.rgb},${pigment / (1 + layer * .42)})`; ctx.lineWidth = width * (1.18 - layer * .12)
      ctx.beginPath(); ctx.moveTo(a.x + nx * drift, a.y + ny * drift)
      ctx.quadraticCurveTo((a.x + b.x) / 2 + nx * (drift + gaussian() * f.mid * 3), (a.y + b.y) / 2 + ny * (drift + gaussian() * f.mid * 3), b.x + nx * drift, b.y + ny * drift); ctx.stroke(); ctx.restore()
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
      ctx.strokeStyle = `rgba(${activeInk.rgb},${(0.012 + activation * 0.13) * (1 - dryness * 0.45)})`
      ctx.lineWidth = bristle.width * (0.35 + spectral * 1.5)
      ctx.beginPath(); ctx.moveTo(ax + gaussian() * 0.2, ay + gaussian() * 0.2)
      ctx.quadraticCurveTo((ax + bx) / 2 + nx * oscillation * f.high * 4, (ay + by) / 2 + ny * oscillation * f.high * 4, bx, by); ctx.stroke()
    }
    const breath = f.noise * (0.3 + f.high * 0.7) * voice
    for (let i = 0; i < Math.floor(breath * 32); i += 1) {
      const along = Math.random(), lateral = gaussian() * width * (0.3 + breath * 0.8)
      ctx.fillStyle = `rgba(${activeInk.rgb},${rand(0.006, 0.038)})`; ctx.beginPath()
      ctx.arc(lerp(a.x, b.x, along) + nx * lateral, lerp(a.y, b.y, along) + ny * lateral, rand(0.15, 1.8), 0, Math.PI * 2); ctx.fill()
    }
    for (let i = 0; i < Math.floor(voice * 18 + f.mid * 10); i += 1) {
      const along = Math.random(), lateral = gaussian() * width * 0.27
      ctx.fillStyle = `rgba(${activeInk.rgb},${rand(0.01, 0.07) * (.35 + voice)})`; ctx.beginPath()
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

  const decodeRecording = async (chunks, sample) => {
    if (!chunks.length) return
    try {
      const encoded = await new Blob(chunks).arrayBuffer()
      const decoded = await engine.current.audioContext.decodeAudioData(encoded)
      const frames = Math.min(decoded.length, Math.floor(decoded.sampleRate * 2))
      const clipped = engine.current.audioContext.createBuffer(decoded.numberOfChannels, frames, decoded.sampleRate)
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        clipped.copyToChannel(decoded.getChannelData(channel).slice(decoded.length - frames), channel)
      }
      sample.audio = clipped
    } catch (recordingError) {
      console.warn('Échantillon audio non décodable', recordingError)
    }
  }

  const renderGesture = (gesture) => {
    const e = engine.current
    e.previewContext.clearRect(0, 0, e.width, e.height)
    for (let index = 1; index < gesture.points.length; index += 1) {
      paint(gesture.points[index - 1], gesture.points[index], e.previewContext, gesture.style, gesture.points[index].features)
    }
  }

  const pointerDown = (event) => {
    const e = engine.current
    if (e.state !== 'LIVE' || isPlaying) return
    try {
      e.history.push({ pixels: e.context.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height), sampleCount: e.samples.length })
      if (e.history.length > 8) e.history.shift()
    } catch { e.history = [] }
    e.pointerDown = true
    setHasMarks(true)
    const firstPoint = { x: event.clientX, y: event.clientY, time: performance.now(), pressure: event.pressure > 0 ? event.pressure : 0.5, features: { ...e.features } }
    e.lastPoint = firstPoint
    e.gesture = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, points: [firstPoint], style: { tool, ink, brushSize } }
    e.recorderChunks = []
    if (typeof MediaRecorder !== 'undefined' && e.stream) {
      try {
        e.recorder = new MediaRecorder(e.stream)
        e.recorder.ondataavailable = ({ data }) => { if (data.size) e.recorderChunks.push(data) }
        e.recorder.start(100)
      } catch (recordingError) { console.warn('Enregistrement indisponible', recordingError) }
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const pointerMove = (event) => {
    const e = engine.current
    if (e.state !== 'LIVE' || !e.pointerDown || !e.lastPoint) return
    const point = { x: event.clientX, y: event.clientY, time: performance.now(), pressure: event.pressure > 0 ? event.pressure : 0.5, features: { ...e.features } }
    const distance = Math.hypot(point.x - e.lastPoint.x, point.y - e.lastPoint.y)
    if (distance < 0.5) return
    const steps = Math.min(8, Math.max(1, Math.ceil(distance / 5)))
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      const next = { x: lerp(e.lastPoint.x, point.x, t), y: lerp(e.lastPoint.y, point.y, t), time: lerp(e.lastPoint.time, point.time, t), pressure: lerp(e.lastPoint.pressure, point.pressure, t), features: point.features }
      e.gesture.points.push(next)
    }
    const cutoff = point.time - 2000
    const firstVisible = Math.max(0, e.gesture.points.findIndex((item) => item.time >= cutoff) - 1)
    if (firstVisible > 0) e.gesture.points.splice(0, firstVisible)
    renderGesture(e.gesture)
    e.lastPoint = point
  }
  const lift = () => {
    const e = engine.current
    if (!e.pointerDown || !e.gesture) return
    e.pointerDown = false; e.lastPoint = null
    const gesture = e.gesture
    if (gesture.points.length < 2) {
      if (e.recorder?.state === 'recording') e.recorder.stop()
      e.gesture = null; e.recorder = null; return
    }
    gesture.duration = Math.max(120, gesture.points.at(-1).time - gesture.points[0].time)
    e.context.drawImage(previewRef.current, 0, 0, previewRef.current.width, previewRef.current.height, 0, 0, e.width, e.height)
    e.previewContext.clearRect(0, 0, e.width, e.height)
    const sample = { ...gesture, audio: null }
    e.samples.push(sample); setSampleCount(e.samples.length)
    if (e.recorder?.state === 'recording') {
      const chunks = e.recorderChunks
      e.recorder.onstop = () => decodeRecording(chunks, sample)
      e.recorder.stop()
    }
    e.gesture = null; e.recorder = null
  }
  const reset = () => {
    const e = engine.current
    setEndOpen(false); makePaper(); e.bristles = createBristles(FFT_SIZE / 2); e.state = 'IDLE'
    e.history = []; e.samples = []; setHasMarks(false); setSampleCount(0)
    setPhase('idle'); setStatus('Prêt à créer'); setProgress(0); setEnergy(0); setError('')
  }

  const undo = () => {
    const e = engine.current
    const previous = e.history.pop()
    if (previous) e.context.putImageData(previous.pixels, 0, 0)
    if (previous) e.samples.splice(previous.sampleCount)
    setSampleCount(e.samples.length)
    setHasMarks(Boolean(previous?.sampleCount))
  }

  const clearPaper = () => {
    const e = engine.current
    if (hasMarks) e.history.push({ pixels: e.context.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height), sampleCount: e.samples.length })
    makePaper(); setHasMarks(e.history.length > 0)
  }

  const download = () => {
    const link = document.createElement('a')
    link.download = `koe-no-fude-${new Date().toISOString().slice(0, 10)}.png`
    link.href = canvasRef.current.toDataURL('image/png')
    link.click()
  }

  const replay = async () => {
    const e = engine.current
    if (!e.samples.length || isPlaying) return
    setIsPlaying(true); setStatus('Relecture des gestes')
    await e.audioContext?.resume()
    makePaper(); e.history = []
    for (const sample of e.samples) {
      if (sample.audio && e.audioContext) {
        const source = e.audioContext.createBufferSource()
        source.buffer = sample.audio; source.connect(e.audioContext.destination); source.start()
      }
      await new Promise((resolve) => {
        const started = performance.now()
        let rendered = 1
        const frame = (now) => {
          const elapsed = now - started
          while (rendered < sample.points.length && sample.points[rendered].time - sample.points[0].time <= elapsed) {
            paint(sample.points[rendered - 1], sample.points[rendered], e.context, sample.style, sample.points[rendered].features)
            rendered += 1
          }
          if (elapsed < sample.duration) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
    }
    setHasMarks(true); setIsPlaying(false); setStatus(e.state === 'LIVE' ? 'Touchez · jouez · fixez' : 'Séquence terminée')
  }

  const hint = isPlaying ? 'VOS GESTES REPRENNENT VIE' : phase === 'live' ? 'MAINTENEZ · JOUEZ 2 SECONDES · RELÂCHEZ POUR FIXER' : phase === 'drying' ? 'NE TOUCHEZ PLUS' : phase === 'finished' ? 'UNE MINUTE DE VOIX · UNE EMPREINTE' : 'VOIX = MATIÈRE · GESTE = FORME'

  return (
    <main className={`app phase-${phase}`}>
      <canvas ref={canvasRef} className="paper" aria-label="Surface de dessin réactive à la voix" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={lift} onPointerCancel={lift} />
      <canvas ref={previewRef} className="paper live-layer" aria-hidden="true" />
      <header className="brand" aria-label="Koe no Fude">
        <span className="brand-mark" aria-hidden="true">声</span>
        <span><strong>Koe no Fude</strong><small>声の筆 · LE PINCEAU DE LA VOIX</small></span>
      </header>
      <aside className="studio-tools" aria-label="Atelier de peinture">
        <div className="tool-heading"><span>OUTILS</span><small>05</small></div>
        <div className="tool-list">
          {TOOLS.map((item, index) => <button key={item.id} className={tool === item.id ? 'active' : ''} onClick={() => setTool(item.id)} title={item.label} aria-label={item.label} aria-pressed={tool === item.id}><span>{item.glyph}</span><em>0{index + 1}</em></button>)}
        </div>
        <div className="size-control">
          <label htmlFor="brush-size"><span>ÉPAISSEUR</span><b>{Math.round(brushSize * 100)}</b></label>
          <input id="brush-size" type="range" min="0.45" max="1.8" step="0.05" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
        </div>
        <div className="ink-control"><span>PIGMENTS</span><div>{INKS.map((color) => <button key={color.id} className={ink.id === color.id ? 'active' : ''} style={{ '--ink': color.hex }} onClick={() => setInk(color)} aria-label={color.label} title={color.label} />)}</div></div>
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
      <nav className="canvas-actions" aria-label="Actions de la toile">
        <button className="replay-button" onClick={replay} disabled={!sampleCount || isPlaying} title="Rejouer les gestes"><span>▶</span> REJOUER <b>{sampleCount}</b></button>
        <button onClick={undo} disabled={!hasMarks} title="Annuler"><span>↶</span> ANNULER</button>
        <button onClick={clearPaper} disabled={!hasMarks} title="Effacer la toile"><span>×</span> EFFACER</button>
        <button onClick={download} title="Exporter l’œuvre"><span>↓</span> EXPORTER</button>
      </nav>
      <div className="sound-legend" aria-hidden="true"><span>GRAVE</span><i /><i /><i /><i className="lit" style={{ transform: `scaleY(${.25 + energy * .75})` }} /><span>AIGU</span></div>
      {error && <p className="error-message">{error}</p>}
      <div className="edition"><span>EXPÉRIENCE SONORE</span><i /><span>ÉDITION 01</span></div>
      <p className="hint">{hint}</p>
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
