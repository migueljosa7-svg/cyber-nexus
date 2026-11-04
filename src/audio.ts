/** Fully synthesized sound effects (no asset files) built on the Web Audio API. */
export class AudioFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private ambient: { stop: () => void } | null = null;
  private lastTick = 0;
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.55;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, filterFreq: number, type: BiquadFilterType = 'lowpass', delay = 0): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(filterFreq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, filterFreq * 0.15), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  swing(i = 0): void { this.noise(0.18, 0.35, 5200 - i * 900, 'bandpass'); this.tone(380 + i * 120, 0.14, 'sawtooth', 0.07, 120); }
  hit(): void { this.tone(220, 0.1, 'square', 0.18, 70); this.noise(0.09, 0.3, 3000); }
  crit(): void { this.tone(880, 0.18, 'sawtooth', 0.2, 220); this.tone(1320, 0.12, 'square', 0.1, 440); this.noise(0.2, 0.4, 6000); }
  shot(): void { this.tone(1100, 0.12, 'square', 0.1, 260); }
  enemyShot(): void { this.tone(500, 0.16, 'sawtooth', 0.09, 160); }
  jump(): void { this.tone(260, 0.16, 'triangle', 0.14, 620); }
  land(): void { this.noise(0.1, 0.18, 800); }
  dash(): void { this.noise(0.28, 0.45, 7000, 'bandpass'); this.tone(180, 0.25, 'sawtooth', 0.1, 900); }
  emp(): void { this.tone(70, 0.9, 'sawtooth', 0.35, 30); this.tone(900, 0.6, 'sine', 0.15, 80); this.noise(0.7, 0.5, 1800); }
  shield(): void { this.tone(300, 0.5, 'sine', 0.2, 900); this.tone(450, 0.5, 'triangle', 0.1, 1350, 0.05); }
  shieldHit(): void { this.tone(1400, 0.1, 'triangle', 0.14, 700); }
  burst(): void { for (let i = 0; i < 6; i++) this.tone(700 + i * 90, 0.09, 'square', 0.07, 200, i * 0.04); }
  explode(): void { this.noise(0.5, 0.55, 2400); this.tone(110, 0.4, 'sawtooth', 0.25, 30); }
  hurt(): void { this.tone(140, 0.28, 'sawtooth', 0.28, 45); this.noise(0.2, 0.35, 1500); }
  error(): void { this.tone(160, 0.2, 'square', 0.12); this.tone(120, 0.2, 'square', 0.12, undefined, 0.11); }
  success(): void { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.16, 'square', 0.1, undefined, i * 0.07)); }
  click(): void { this.tone(900, 0.05, 'square', 0.07); }
  glitch(): void { this.noise(0.25, 0.4, 9000, 'highpass'); this.tone(90, 0.2, 'square', 0.12, 700); }
  portal(): void { this.tone(220, 1.2, 'sine', 0.25, 880); this.tone(330, 1.2, 'triangle', 0.15, 1320); }
  pickup(): void { this.tone(660, 0.1, 'triangle', 0.12, 1320); }

  key(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastTick < 0.028) return;
    this.lastTick = now;
    this.tone(1500 + Math.random() * 700, 0.025, 'square', 0.035);
  }

  startAmbient(): void {
    if (!this.ctx || !this.master || this.ambient) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.12;
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(lp.frequency);
    const oscs = [55, 55.4, 82.4, 110.3].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
      return o;
    });
    lp.connect(g).connect(this.master);
    lfo.start();
    this.ambient = {
      stop: () => {
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1);
        window.setTimeout(() => { oscs.forEach((o) => o.stop()); lfo.stop(); }, 1100);
      },
    };
  }

  stopAmbient(): void {
    this.ambient?.stop();
    this.ambient = null;
  }
}
