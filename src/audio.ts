// Synthesized sound effects (Web Audio). No audio files needed.
import { W } from "./config"
import { GameEvent } from "./sim"

export class Sfx {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private noise!: AudioBuffer
  private eng: {
    osc: OscillatorNode
    gain: GainNode
    pan: StereoPannerNode
  }[] = []
  muted = false

  init() {
    // must be called from a user gesture
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume()
      return
    }
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return
    const c = (this.ctx = new AC())
    this.master = c.createGain()
    this.master.gain.value = this.muted ? 0 : 0.5
    this.master.connect(c.destination)
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    for (const base of [55, 65]) {
      // one buzzing, chopping engine per plane
      const osc = c.createOscillator()
      osc.type = "sawtooth"
      osc.frequency.value = base
      const lp = c.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = 500
      const trem = c.createGain()
      trem.gain.value = 0.7
      const lfo = c.createOscillator()
      lfo.frequency.value = 16 + base / 10
      const depth = c.createGain()
      depth.gain.value = 0.3
      lfo.connect(depth)
      depth.connect(trem.gain)
      const gain = c.createGain()
      gain.gain.value = 0
      const pan = c.createStereoPanner()
      osc.connect(lp)
      lp.connect(trem)
      trem.connect(gain)
      gain.connect(pan)
      pan.connect(this.master)
      osc.start()
      lfo.start()
      this.eng.push({ osc, gain, pan })
    }
  }
  toggleMute() {
    this.muted = !this.muted
    if (this.ctx) this.master.gain.value = this.muted ? 0 : 0.5
  }
  private pan(x: number) {
    return Math.max(-1, Math.min(1, (x / W) * 2 - 1)) * 0.7
  }
  engine(i: number, on: boolean, speed: number, x: number) {
    if (!this.ctx) return
    const e = this.eng[i],
      t = this.ctx.currentTime
    e.gain.gain.setTargetAtTime(on ? 0.06 : 0, t, 0.08)
    e.osc.frequency.setTargetAtTime((i ? 65 : 55) + speed * 0.3, t, 0.1)
    e.pan.pan.setTargetAtTime(this.pan(x), t, 0.05)
  }
  play(e: GameEvent) {
    switch (e.type) {
      case "shoot":
        this.tone("square", 1200, 180, 0.09, 0.1, 0, this.pan(e.x))
        this.burst(0.06, 0.15, 4000, 1500, "bandpass", this.pan(e.x))
        break
      case "whistle":
        this.tone("triangle", 1100, 250, 1.0, 0.08, 0, this.pan(e.x))
        break
      case "explode":
        this.burst(1.0, 0.7, 2000, 80, "lowpass", this.pan(e.x))
        this.tone("sine", 110, 25, 0.6, 0.5, 0, this.pan(e.x))
        break
      case "start":
        ;[392, 523, 659, 784].forEach((f, i) =>
          this.tone("square", f, f, 0.12, 0.08, i * 0.1),
        )
        break
      case "gameOver":
        ;[523, 440, 349, 262].forEach((f, i) =>
          this.tone("sawtooth", f, f, 0.25, 0.1, i * 0.18),
        )
        break
    }
  }
  private tone(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    vol: number,
    delay = 0,
    pan = 0,
  ) {
    const c = this.ctx
    if (!c) return
    const t = c.currentTime + delay
    const o = c.createOscillator(),
      g = c.createGain(),
      p = c.createStereoPanner()
    o.type = type
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    p.pan.value = pan
    o.connect(g)
    g.connect(p)
    p.connect(this.master)
    o.start(t)
    o.stop(t + dur)
  }
  private burst(
    dur: number,
    vol: number,
    f0: number,
    f1: number,
    type: BiquadFilterType,
    pan = 0,
  ) {
    const c = this.ctx
    if (!c) return
    const t = c.currentTime
    const src = c.createBufferSource()
    src.buffer = this.noise
    const f = c.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(f0, t)
    f.frequency.exponentialRampToValueAtTime(f1, t + dur)
    const g = c.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    const p = c.createStereoPanner()
    p.pan.value = pan
    src.connect(f)
    f.connect(g)
    g.connect(p)
    p.connect(this.master)
    src.start(t)
    src.stop(t + dur)
  }
}
