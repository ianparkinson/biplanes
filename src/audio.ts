// Synthesized sound effects (Web Audio). No audio files needed: every sound is
// built from oscillators and filtered noise when it plays.
import { WORLD_WIDTH } from "./config"
import { GameEvent } from "./sim"

const VOLUME = 0.5
const ENGINE_PITCHES = [55, 65] // Hz at a standstill; slightly different per plane
const ENGINE_VOLUME = 0.06
const STEREO_WIDTH = 0.7 // how far left/right a sound at the screen edge pans (0..1)

interface Engine {
  oscillator: OscillatorNode
  gain: GainNode
  panner: StereoPannerNode
}

export class Sfx {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private noise!: AudioBuffer // one second of white noise, reused for bursts
  private engines: Engine[] = []
  muted = false

  // Creates (or resumes) the audio context. Browsers only allow this from a
  // user gesture, so it's called from input handlers.
  init() {
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume()
      return
    }
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextClass) return
    const ctx = (this.ctx = new AudioContextClass())
    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : VOLUME
    this.master.connect(ctx.destination)

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const samples = this.noise.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1

    for (const pitch of ENGINE_PITCHES)
      this.engines.push(this.createEngine(ctx, pitch))
  }

  // A buzzing, chopping engine: a sawtooth wave, muffled by a low-pass filter,
  // with its volume wobbled ~20 times a second (tremolo) by a second oscillator.
  // It runs continuously; engine() fades it in and out.
  private createEngine(ctx: AudioContext, pitch: number): Engine {
    const oscillator = ctx.createOscillator()
    oscillator.type = "sawtooth"
    oscillator.frequency.value = pitch
    const lowPass = ctx.createBiquadFilter()
    lowPass.type = "lowpass"
    lowPass.frequency.value = 500
    const tremolo = ctx.createGain()
    tremolo.gain.value = 0.7
    const wobble = ctx.createOscillator()
    wobble.frequency.value = 16 + pitch / 10
    const wobbleDepth = ctx.createGain()
    wobbleDepth.gain.value = 0.3
    wobble.connect(wobbleDepth)
    wobbleDepth.connect(tremolo.gain)
    const gain = ctx.createGain()
    gain.gain.value = 0
    const panner = ctx.createStereoPanner()
    oscillator.connect(lowPass)
    lowPass.connect(tremolo)
    tremolo.connect(gain)
    gain.connect(panner)
    panner.connect(this.master)
    oscillator.start()
    wobble.start()
    return { oscillator, gain, panner }
  }

  toggleMute() {
    this.muted = !this.muted
    if (this.ctx) this.master.gain.value = this.muted ? 0 : VOLUME
  }

  // Stereo position for something at world x: -1 (left) to 1 (right), narrowed.
  private panFor(x: number) {
    return Math.max(-1, Math.min(1, (x / WORLD_WIDTH) * 2 - 1)) * STEREO_WIDTH
  }

  // Call every frame for each plane: fades its engine in or out, and raises the
  // pitch with speed. setTargetAtTime glides to the new value to avoid clicks.
  engine(planeId: number, running: boolean, speed: number, x: number) {
    if (!this.ctx) return
    const engine = this.engines[planeId]
    const now = this.ctx.currentTime
    engine.gain.gain.setTargetAtTime(running ? ENGINE_VOLUME : 0, now, 0.08)
    engine.oscillator.frequency.setTargetAtTime(
      ENGINE_PITCHES[planeId] + speed * 0.3,
      now,
      0.1,
    )
    engine.panner.pan.setTargetAtTime(this.panFor(x), now, 0.05)
  }

  play(event: GameEvent) {
    switch (event.type) {
      case "shoot": // a falling blip plus a click of noise
        this.tone("square", 1200, 180, 0.09, 0.1, 0, this.panFor(event.x))
        this.burst(0.06, 0.15, 4000, 1500, "bandpass", this.panFor(event.x))
        break
      case "whistle": // a falling plane
        this.tone("triangle", 1100, 250, 1.0, 0.08, 0, this.panFor(event.x))
        break
      case "explode": // a rumble of noise plus a low thud
        this.burst(1.0, 0.7, 2000, 80, "lowpass", this.panFor(event.x))
        this.tone("sine", 110, 25, 0.6, 0.5, 0, this.panFor(event.x))
        break
      case "start": // rising arpeggio: G C E G
        ;[392, 523, 659, 784].forEach((frequency, i) =>
          this.tone("square", frequency, frequency, 0.12, 0.08, i * 0.1),
        )
        break
      case "gameOver": // falling arpeggio: C A F C
        ;[523, 440, 349, 262].forEach((frequency, i) =>
          this.tone("sawtooth", frequency, frequency, 0.25, 0.1, i * 0.18),
        )
        break
    }
  }

  // A note that slides from one frequency to another while fading out.
  private tone(
    type: OscillatorType,
    startHz: number,
    endHz: number,
    duration: number,
    volume: number,
    delay = 0,
    pan = 0,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    const start = ctx.currentTime + delay
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    const panner = ctx.createStereoPanner()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(startHz, start)
    // Exponential ramps can't reach zero, hence the floors of 1 Hz and 0.001.
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(1, endHz),
      start + duration,
    )
    gain.gain.setValueAtTime(volume, start)
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
    panner.pan.value = pan
    oscillator.connect(gain)
    gain.connect(panner)
    panner.connect(this.master)
    oscillator.start(start)
    oscillator.stop(start + duration)
  }

  // Filtered white noise whose filter frequency sweeps while it fades out.
  private burst(
    duration: number,
    volume: number,
    startHz: number,
    endHz: number,
    filterType: BiquadFilterType,
    pan = 0,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    const start = ctx.currentTime
    const source = ctx.createBufferSource()
    source.buffer = this.noise
    const filter = ctx.createBiquadFilter()
    filter.type = filterType
    filter.frequency.setValueAtTime(startHz, start)
    filter.frequency.exponentialRampToValueAtTime(endHz, start + duration)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(volume, start)
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    source.connect(filter)
    filter.connect(gain)
    gain.connect(panner)
    panner.connect(this.master)
    source.start(start)
    source.stop(start + duration)
  }
}
