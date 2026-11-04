import type { AudioFX } from '../audio';

type Dir = 'up' | 'down' | 'left' | 'right';
const ARROWS: Record<Dir, string> = { up: '▲', down: '▼', left: '◀', right: '▶' };
const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};

/**
 * Terminal hacking mini-games (keyboard + touch), difficulty scales with `level`:
 *  - SECURITY NODES: activate the scattered nodes in numeric order against the clock.
 *  - FIREWALL SEQUENCE: repeat an arrow sequence before the timer ends.
 *  - BYTE DECRYPT: pick the target bytes, in order, out of a noisy matrix.
 */
export class Minigame {
  private root: HTMLDivElement;
  private active = false;
  private cleanup: (() => void) | null = null;
  private finish: ((ok: boolean) => void) | null = null;

  constructor(parent: HTMLElement, private audio: AudioFX) {
    this.root = document.createElement('div');
    this.root.className = 'hack hidden';
    parent.appendChild(this.root);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Aborts a running hack (counts as a failure). */
  abort(): void {
    this.finish?.(false);
  }

  start(level: number): Promise<boolean> {
    if (this.active) return Promise.resolve(false);
    this.active = true;
    this.root.classList.remove('hidden');
    return new Promise<boolean>((resolve) => {
      let done = false;
      const end = (ok: boolean): void => {
        if (done) return;
        done = true;
        this.cleanup?.();
        this.cleanup = null;
        this.finish = null;
        this.root.classList.add('hidden');
        this.root.innerHTML = '';
        this.active = false;
        resolve(ok);
      };
      this.finish = end;
      const r = Math.random();
      if (r < 0.34) this.runSequence(level, end);
      else if (r < 0.67) this.runDecrypt(level, end);
      else this.runNodes(level, end);
    });
  }

  private shell(title: string, hint: string, time: number, onTick: (left: number) => void, end: (ok: boolean) => void): { body: HTMLDivElement; setBar: (f: number) => void } {
    this.root.innerHTML = `
      <div class="hack-panel">
        <div class="hack-head"><span class="hack-title">${title}</span><button class="hack-abort" type="button">ABORT [ESC]</button></div>
        <div class="hack-hint">${hint}</div>
        <div class="hack-timer"><i></i></div>
        <div class="hack-body"></div>
      </div>`;
    const bar = this.root.querySelector('.hack-timer i') as HTMLElement;
    const body = this.root.querySelector('.hack-body') as HTMLDivElement;
    const abortBtn = this.root.querySelector('.hack-abort') as HTMLButtonElement;
    abortBtn.addEventListener('click', () => end(false));
    const start = performance.now();
    let penalty = 0;
    let raf = 0;
    const loop = (): void => {
      const left = time - (performance.now() - start) / 1000 - penalty;
      bar.style.width = `${Math.max(0, (left / time) * 100)}%`;
      bar.classList.toggle('low', left < time * 0.3);
      onTick(left);
      if (left <= 0) { this.audio.error(); end(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const esc = (e: KeyboardEvent): void => { if (e.code === 'Escape') { e.preventDefault(); end(false); } };
    window.addEventListener('keydown', esc);
    const prev = this.cleanup;
    this.cleanup = () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', esc); prev?.(); };
    (body as HTMLDivElement & { penalize?: (s: number) => void }).penalize = (s: number) => { penalty += s; };
    return { body, setBar: (f) => (bar.style.width = `${f * 100}%`) };
  }

  private penalize(body: HTMLElement, seconds: number): void {
    (body as HTMLElement & { penalize?: (s: number) => void }).penalize?.(seconds);
    body.classList.remove('shake');
    void body.offsetWidth;
    body.classList.add('shake');
    this.audio.error();
  }

  // ───────────────────── FIREWALL SEQUENCE ─────────────────────

  private runSequence(level: number, end: (ok: boolean) => void): void {
    const len = Math.min(10, 5 + Math.floor(level / 2));
    const time = Math.max(6, 10 - level * 0.35);
    const dirs: Dir[] = ['up', 'down', 'left', 'right'];
    const seq: Dir[] = Array.from({ length: len }, () => dirs[Math.floor(Math.random() * 4)]);
    let idx = 0;

    const { body } = this.shell('// FIREWALL SEQUENCE', 'Repeat the sequence — arrows / WASD or tap the pad', time, () => undefined, end);
    body.innerHTML = `
      <div class="seq">${seq.map((d, i) => `<span class="seq-cell${i === 0 ? ' cur' : ''}">${ARROWS[d]}</span>`).join('')}</div>
      <div class="pad">
        <button data-d="up" type="button">▲</button>
        <button data-d="left" type="button">◀</button>
        <button data-d="down" type="button">▼</button>
        <button data-d="right" type="button">▶</button>
      </div>`;
    const cells = [...body.querySelectorAll('.seq-cell')] as HTMLElement[];

    const input = (d: Dir): void => {
      if (d === seq[idx]) {
        cells[idx].classList.remove('cur');
        cells[idx].classList.add('ok');
        idx++;
        this.audio.click();
        if (idx >= seq.length) { this.audio.success(); window.setTimeout(() => end(true), 250); return; }
        cells[idx].classList.add('cur');
      } else {
        idx = 0;
        cells.forEach((c, i) => { c.classList.remove('ok'); c.classList.toggle('cur', i === 0); });
        this.penalize(body, 1.2);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      const d = KEY_DIRS[e.code];
      if (d) { e.preventDefault(); input(d); }
    };
    window.addEventListener('keydown', onKey);
    body.querySelectorAll('.pad button').forEach((b) =>
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); input((b as HTMLElement).dataset.d as Dir); }),
    );
    const prev = this.cleanup;
    this.cleanup = () => { window.removeEventListener('keydown', onKey); prev?.(); };
  }

  // ───────────────────── BYTE DECRYPT ─────────────────────

  private runDecrypt(level: number, end: (ok: boolean) => void): void {
    const need = Math.min(6, 3 + Math.floor(level / 3));
    const time = Math.max(7, 11 - level * 0.35);
    const pool = new Set<string>();
    while (pool.size < 12) pool.add(Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0'));
    const cellsData = [...pool];
    const target = [...cellsData].sort(() => Math.random() - 0.5).slice(0, need);
    let idx = 0;
    let typed = '';

    const { body } = this.shell('// BYTE DECRYPT', 'Select the bytes in order — click/tap or type the hex digits', time, () => undefined, end);
    body.innerHTML = `
      <div class="seq">${target.map((t, i) => `<span class="seq-cell${i === 0 ? ' cur' : ''}">${t}</span>`).join('')}</div>
      <div class="matrix">${cellsData.map((c) => `<button type="button" data-b="${c}">${c}</button>`).join('')}</div>
      <div class="typed">&gt; <span></span>_</div>`;
    const targetCells = [...body.querySelectorAll('.seq .seq-cell')] as HTMLElement[];
    const typedEl = body.querySelector('.typed span') as HTMLElement;

    const choose = (b: string): void => {
      typed = '';
      typedEl.textContent = '';
      if (b === target[idx]) {
        targetCells[idx].classList.remove('cur');
        targetCells[idx].classList.add('ok');
        const btn = body.querySelector(`button[data-b="${b}"]`) as HTMLElement | null;
        btn?.classList.add('used');
        idx++;
        this.audio.click();
        if (idx >= target.length) { this.audio.success(); window.setTimeout(() => end(true), 250); return; }
        targetCells[idx].classList.add('cur');
      } else {
        this.penalize(body, 1.5);
      }
    };
    body.querySelectorAll('.matrix button').forEach((b) =>
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); choose((b as HTMLElement).dataset.b!); }),
    );
    const onKey = (e: KeyboardEvent): void => {
      const ch = e.key.length === 1 ? e.key.toUpperCase() : '';
      if (!/[0-9A-F]/.test(ch)) return;
      typed += ch;
      typedEl.textContent = typed;
      this.audio.key();
      if (typed.length === 2) choose(typed);
    };
    window.addEventListener('keydown', onKey);
    const prev = this.cleanup;
    this.cleanup = () => { window.removeEventListener('keydown', onKey); prev?.(); };
  }

  // ───────────────────── SECURITY NODES ─────────────────────

  private runNodes(level: number, end: (ok: boolean) => void): void {
    const count = Math.min(9, 4 + Math.floor(level / 2));
    const time = Math.max(5.5, 10 - level * 0.3);
    const cells: number[] = [];
    for (let i = 0; i < 24; i++) cells.push(i);
    cells.sort(() => Math.random() - 0.5);
    const picked = cells.slice(0, count);
    let next = 1;

    const { body } = this.shell('// SECURITY NODES', 'Activate the nodes in order 1 → ' + count + ' (click / tap / type the digit)', time, () => undefined, end);
    body.innerHTML = `<div class="nodes">${picked.map((c, i) => `<button type="button" class="node" data-n="${i + 1}" style="left:${(c % 6) * 16.6 + 1}%;top:${Math.floor(c / 6) * 25 + 2}%">${i + 1}</button>`).join('')}</div>`;

    const press = (n: number): void => {
      if (n !== next) { this.penalize(body, 1.5); return; }
      const el = body.querySelector(`.node[data-n="${n}"]`) as HTMLElement | null;
      el?.classList.add('done');
      this.audio.click();
      next++;
      if (next > count) { this.audio.success(); window.setTimeout(() => end(true), 250); }
    };
    body.querySelectorAll('.node').forEach((b) =>
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); press(Number((b as HTMLElement).dataset.n)); }),
    );
    const onKey = (e: KeyboardEvent): void => {
      if (/^[1-9]$/.test(e.key)) press(Number(e.key));
    };
    window.addEventListener('keydown', onKey);
    const prev = this.cleanup;
    this.cleanup = () => { window.removeEventListener('keydown', onKey); prev?.(); };
  }
}
