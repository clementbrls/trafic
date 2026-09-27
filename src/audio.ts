/**
 * Tiny procedural sound engine (WebAudio). Everything is synthesised,
 * no audio files needed. Deliveries play notes that follow the ambient
 * chord progression so the city composes its own soundtrack.
 */

const PENTA = [0, 2, 4, 7, 9];
// chord roots / tones (semitones from C) — Cmaj7, Am7, Fmaj7, G6
const CHORDS = [
  [0, 4, 7, 11],
  [9, 12, 16, 19],
  [5, 9, 12, 16],
  [7, 11, 14, 16],
];

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private delaySend: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  sfxOn = true;
  musicOn = true;
  volume = 0.8;
  private lastTick = 0;
  private lastDeliver = 0;
  private deliverCount = 0;
  private musicTimer: number | null = null;
  private chordIdx = 0;
  private chordStart = 0;
  private musicPlaying = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxOn ? 0.9 : 0;
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicOn ? 0.55 : 0;
    this.musicBus.connect(this.master);
    // shared echo
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.3;
    this.delaySend.connect(delay);
    delay.connect(lp).connect(fb).connect(delay);
    lp.connect(this.master);
    // noise buffer
    const len = Math.floor(ctx.sampleRate * 0.4);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.chordStart = ctx.currentTime;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setSfx(on: boolean): void {
    this.sfxOn = on;
    if (this.sfx && this.ctx) this.sfx.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.3);
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private get ready(): boolean {
    return !!this.ctx && !!this.sfx && this.ctx.state === 'running';
  }

  private tone(
    freq: number, dur: number, type: OscillatorType, gain: number,
    opts: { attack?: number; bus?: GainNode | null; echo?: number; when?: number; slide?: number; filter?: number } = {},
  ): void {
    const ctx = this.ctx as AudioContext;
    const t0 = ctx.currentTime + (opts.when ?? 0);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * opts.slide), t0 + dur);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node: AudioNode = osc.connect(g);
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filter;
      node = node.connect(f);
    }
    node.connect(opts.bus ?? (this.sfx as GainNode));
    if (opts.echo && this.delaySend) {
      const s = ctx.createGain();
      s.gain.value = opts.echo;
      node.connect(s).connect(this.delaySend);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, gain: number, f0: number, f1: number): void {
    const ctx = this.ctx as AudioContext;
    if (!this.noiseBuf) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.sfx as GainNode);
    src.start(t0);
    src.stop(t0 + dur);
  }

  private chordNote(octave: number, pick: number): number {
    const ch = CHORDS[this.chordIdx];
    return 12 * octave + ch[pick % ch.length];
  }

  // ------------------------------------------------------------------
  // Game sounds
  // ------------------------------------------------------------------

  road(n: number): void {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this.lastTick < 35) return;
    this.lastTick = now;
    const step = PENTA[n % 5] + 12 * Math.floor((n % 15) / 5);
    this.tone(midiToFreq(72 + step), 0.07, 'sine', 0.12);
  }

  link(): void {
    if (!this.ready) return;
    this.tone(midiToFreq(79), 0.06, 'sine', 0.08);
  }

  erase(): void {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this.lastTick < 45) return;
    this.lastTick = now;
    this.noise(0.12, 0.22, 2400, 500);
  }

  bridge(): void {
    if (!this.ready) return;
    this.tone(midiToFreq(67), 0.25, 'triangle', 0.14, { echo: 0.4 });
    this.tone(midiToFreq(74), 0.3, 'triangle', 0.12, { when: 0.07, echo: 0.4 });
  }

  item(): void {
    if (!this.ready) return;
    this.tone(midiToFreq(76), 0.2, 'triangle', 0.14, { echo: 0.3 });
    this.tone(midiToFreq(83), 0.3, 'sine', 0.1, { when: 0.06, echo: 0.3 });
  }

  motorway(): void {
    if (!this.ready) return;
    this.noise(0.5, 0.12, 300, 1800);
    this.tone(midiToFreq(62), 0.4, 'triangle', 0.12, { slide: 2, echo: 0.3 });
  }

  deliver(color: number): void {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this.lastDeliver < 110) return;
    this.lastDeliver = now;
    this.deliverCount++;
    const pick = (color + this.deliverCount) % 4;
    const m = this.chordNote(6, pick);
    this.tone(midiToFreq(m), 0.5, 'triangle', 0.075, { echo: 0.5, filter: 3000 });
    this.tone(midiToFreq(m + 12), 0.25, 'sine', 0.03, { echo: 0.3 });
  }

  house(): void {
    if (!this.ready) return;
    this.tone(midiToFreq(this.chordNote(5, 2)), 0.18, 'sine', 0.07, { echo: 0.25 });
  }

  destination(): void {
    if (!this.ready) return;
    const base = this.chordNote(5, 0);
    this.tone(midiToFreq(base), 0.5, 'triangle', 0.12, { echo: 0.5 });
    this.tone(midiToFreq(base + 7), 0.6, 'triangle', 0.1, { when: 0.12, echo: 0.5 });
    this.tone(midiToFreq(base + 12), 0.8, 'sine', 0.08, { when: 0.24, echo: 0.5 });
  }

  warn(): void {
    if (!this.ready) return;
    this.tone(220, 0.35, 'sine', 0.12, { attack: 0.05 });
    this.tone(207.65, 0.35, 'sine', 0.1, { attack: 0.05, when: 0.18 });
  }

  error(): void {
    if (!this.ready) return;
    this.tone(196, 0.12, 'square', 0.05, { filter: 900 });
    this.tone(165, 0.16, 'square', 0.05, { filter: 900, when: 0.08 });
  }

  click(): void {
    if (!this.ready) return;
    this.tone(1320, 0.04, 'sine', 0.06);
  }

  week(): void {
    if (!this.ready) return;
    const notes = [60, 64, 67, 72, 76];
    notes.forEach((m, i) => this.tone(midiToFreq(m), 0.7, 'triangle', 0.1, { when: i * 0.09, echo: 0.45 }));
  }

  gameOver(): void {
    if (!this.ready) return;
    const notes = [67, 63, 60, 55];
    notes.forEach((m, i) => this.tone(midiToFreq(m), 0.9, 'triangle', 0.12, { when: i * 0.22, echo: 0.4, filter: 2000 }));
  }

  poof(): void {
    if (!this.ready) return;
    this.noise(0.2, 0.08, 800, 3000);
  }

  // ------------------------------------------------------------------
  // Generative ambient music
  // ------------------------------------------------------------------

  startMusic(): void {
    if (!this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    this.chordStart = this.ctx.currentTime - 6.5;
    const tick = () => {
      if (!this.musicPlaying) return;
      this.musicStep();
      this.musicTimer = window.setTimeout(tick, 1000);
    };
    tick();
  }

  stopMusic(): void {
    this.musicPlaying = false;
    if (this.musicTimer !== null) window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
  }

  private musicStep(): void {
    if (!this.ready || !this.musicOn) return;
    const ctx = this.ctx as AudioContext;
    const bar = 7;
    if (ctx.currentTime - this.chordStart >= bar) {
      this.chordStart = ctx.currentTime;
      this.chordIdx = (this.chordIdx + 1) % CHORDS.length;
      // soft pad
      const ch = CHORDS[this.chordIdx];
      for (let k = 0; k < 3; k++) {
        this.tone(midiToFreq(48 + ch[k]), bar + 1, 'sine', 0.035, { attack: 2.2, bus: this.musicBus, filter: 900 });
      }
      this.tone(midiToFreq(36 + ch[0]), bar, 'sine', 0.04, { attack: 1.5, bus: this.musicBus, filter: 400 });
    }
    // sparse bell notes
    if (Math.random() < 0.28) {
      const m = 72 + PENTA[Math.floor(Math.random() * 5)] + (Math.random() < 0.3 ? 12 : 0);
      this.tone(midiToFreq(m), 1.4, 'sine', 0.025, { attack: 0.02, bus: this.musicBus, echo: 0.6 });
    }
  }
}

export const sound = new Sound();
