import type { AudioFX } from './audio';
import type { GfxRenderer } from './engine/renderer';

export type LogLine = string | { text: string; cls?: 'ok' | 'warn' | 'err' | 'dim' | 'big' };

export interface TransitionOpts {
  title?: string;
  subtitle?: string;
  lines: LogLine[];
  /** Heavy work (world generation...) executed while the logs are being typed, once the screen is fully black. */
  work?: () => void | Promise<void>;
  /** Milliseconds per character. */
  charMs?: number;
}

const hex = (n: number): string => Math.floor(Math.random() * 16 ** n).toString(16).toUpperCase().padStart(n, '0');
const ip = (): string => `${10 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`;
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

export function bootLines(): LogLine[] {
  return [
    { text: '> CYBER-NEXUS // PROTOCOL ZERO', cls: 'big' },
    `> SYSTEM BREACH INITIATED...`,
    `> bypassing perimeter ICE @ ${ip()}:${1024 + Math.floor(Math.random() * 60000)}`,
    `> injecting payload 0x${hex(8)} ............ [OK]`,
    { text: `> spoofing MAC ${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)} [OK]`, cls: 'ok' },
    `> decrypting neural uplink (AES-4096) ............ ${hex(6)}`,
    { text: '> WARNING: corporate counter-intrusion daemons detected', cls: 'warn' },
    `> mounting virtual city grid ... ${hex(4)}:${hex(4)}`,
    { text: '> ACCESS GRANTED. WELCOME, RUNNER.', cls: 'ok' },
  ];
}

export function sectorLines(level: number, palette: string): LogLine[] {
  return [
    { text: `> SECTOR ${String(level).padStart(2, '0')} // PROTECTED ZONE`, cls: 'big' },
    `> SYSTEM BREACH... tracing node ${ip()}`,
    `> bypassing firewall layer ${level + 2}/${level + 2} ... 0x${hex(6)}`,
    `> flushing hostile process table (${3 + level * 2} agents queued)`,
    `> loading district theme "${palette}" ............ [OK]`,
    { text: `> ICE strength raised to ${100 + level * 35}%`, cls: 'warn' },
    `> streaming geometry chunks 0x${hex(4)}..0x${hex(4)}`,
    { text: '> BREACH COMPLETE. ENTERING SECTOR.', cls: 'ok' },
  ];
}

export function deathLines(score: number): LogLine[] {
  return [
    { text: '> !! CRITICAL: NEURAL LINK SEVERED !!', cls: 'err' },
    `> dumping core 0x${hex(8)} ...`,
    { text: '> runner signal lost', cls: 'err' },
    `> final data packet: ${score} pts`,
    { text: '> CONNECTION TERMINATED', cls: 'dim' },
  ];
}

export function hackLines(ok: boolean): LogLine[] {
  return ok
    ? [{ text: `> NODE 0x${hex(4)} OWNED`, cls: 'ok' }, `> uploading exploit ... [OK]`]
    : [{ text: '> ICE FEEDBACK DETECTED', cls: 'err' }, '> node locked'];
}

/** Hacker-terminal transitions: CRT scanlines, typewriter logs, glitch burst, fade into the 3D scene. */
export class Transitions {
  private root: HTMLDivElement;
  private log: HTMLPreElement;
  private title: HTMLDivElement;
  private sub: HTMLDivElement;
  private bar: HTMLElement;
  private skip = false;
  private running = false;

  constructor(parent: HTMLElement, private audio: AudioFX, private gfx: GfxRenderer) {
    this.root = document.createElement('div');
    this.root.className = 'tx';
    this.root.innerHTML = `
      <div class="tx-crt"></div>
      <div class="tx-scan"></div>
      <div class="tx-inner">
        <div class="tx-title glitch" data-text=""></div>
        <div class="tx-sub"></div>
        <pre class="tx-log"></pre>
        <div class="tx-progress"><i></i></div>
        <div class="tx-skip">[ click / press any key to speed up ]</div>
      </div>`;
    parent.appendChild(this.root);
    this.log = this.root.querySelector('.tx-log') as HTMLPreElement;
    this.title = this.root.querySelector('.tx-title') as HTMLDivElement;
    this.sub = this.root.querySelector('.tx-sub') as HTMLDivElement;
    this.bar = this.root.querySelector('.tx-progress i') as HTMLElement;
    const speedUp = (): void => { this.skip = true; };
    this.root.addEventListener('pointerdown', speedUp);
    window.addEventListener('keydown', speedUp);
  }

  get busy(): boolean {
    return this.running;
  }

  /** Full-screen terminal transition. Resolves when the new scene should start receiving input. */
  async run(o: TransitionOpts): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.skip = false;
    const charMs = o.charMs ?? 11;
    this.log.textContent = '';
    this.title.textContent = o.title ?? '';
    this.title.dataset.text = o.title ?? '';
    this.sub.textContent = o.subtitle ?? '';
    this.bar.style.width = '0%';
    this.root.classList.remove('quick', 'out');
    this.root.classList.add('on');
    this.audio.glitch();
    this.gfx.glitch = 1;
    await sleep(380);

    const workAt = Math.max(1, Math.floor(o.lines.length / 2));
    let workPromise: Promise<void> | null = null;
    for (let i = 0; i < o.lines.length; i++) {
      if (i === workAt && o.work) {
        await nextFrame();
        await nextFrame();
        workPromise = Promise.resolve(o.work());
      }
      const line = o.lines[i];
      const text = typeof line === 'string' ? line : line.text;
      const cls = typeof line === 'string' ? '' : line.cls ?? '';
      const span = document.createElement('span');
      span.className = `ln ${cls}`;
      this.log.appendChild(span);
      for (let c = 0; c < text.length; c++) {
        span.textContent = text.slice(0, c + 1) + '█';
        if (c % 2 === 0) this.audio.key();
        if (!this.skip) await sleep(charMs + Math.random() * charMs);
        else if (c % 8 === 0) await nextFrame();
      }
      span.textContent = text;
      this.log.appendChild(document.createTextNode('\n'));
      this.bar.style.width = `${((i + 1) / o.lines.length) * 100}%`;
      await sleep(this.skip ? 10 : 70 + Math.random() * 140);
    }
    if (workPromise) await workPromise;
    else if (o.work) await o.work();

    await sleep(this.skip ? 80 : 320);
    this.audio.glitch();
    this.gfx.glitch = 1;
    this.root.classList.add('flash');
    await sleep(260);
    this.root.classList.remove('flash');
    this.root.classList.add('out');
    this.running = false;
    window.setTimeout(() => this.root.classList.remove('on', 'out'), 650);
  }

  /** Short translucent "protected zone" glitch used for small events (e.g. a finished hack). */
  async quick(lines: LogLine[], ms = 1100): Promise<void> {
    if (this.running) return;
    this.log.textContent = '';
    this.title.textContent = '';
    this.title.dataset.text = '';
    this.sub.textContent = '';
    this.bar.style.width = '100%';
    this.root.classList.remove('out');
    this.root.classList.add('on', 'quick');
    this.audio.glitch();
    this.gfx.glitch = 0.8;
    for (const l of lines) {
      const span = document.createElement('span');
      const text = typeof l === 'string' ? l : l.text;
      span.className = `ln ${typeof l === 'string' ? '' : l.cls ?? ''}`;
      span.textContent = text + '\n';
      this.log.appendChild(span);
      this.audio.key();
      await sleep(120);
    }
    await sleep(ms);
    this.root.classList.add('out');
    window.setTimeout(() => this.root.classList.remove('on', 'out', 'quick'), 450);
  }
}
