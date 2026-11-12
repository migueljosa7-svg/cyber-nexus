import type { AudioFX } from '../audio';

/** One hotkey per grid cell so the board is playable from the keyboard as well as with mouse / touch. */
const HOTKEYS = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
const CELLS = 12;

type Kind = 'data' | 'ice' | 'empty';

/**
 * ICE BREAKER: a single, instantly readable hacking board.
 *  - CYAN nodes (◆) are data: click / tap / press the key on each one before the timer runs out.
 *  - RED nodes (✕) are ICE countermeasures: touching one costs time. Don't.
 * From threat level 5 the remaining nodes shuffle every few seconds. Everything is one-click, no typing.
 */
export class Minigame {
  private root: HTMLDivElement;
  private active = false;
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
      const cleanups: Array<() => void> = [];
      let done = false;
      const end = (ok: boolean): void => {
        if (done) return;
        done = true;
        for (const c of cleanups) c();
        this.finish = null;
        this.root.classList.add('hidden');
        this.root.innerHTML = '';
        this.active = false;
        resolve(ok);
      };
      this.finish = end;
      this.run(level, end, cleanups);
    });
  }

  private run(level: number, end: (ok: boolean) => void, cleanups: Array<() => void>): void {
    const need = Math.min(6, 3 + Math.floor(level / 3));
    const iceCount = Math.min(CELLS - need - 1, 2 + Math.floor(level / 2));
    const total = Math.max(6, 10 - level * 0.3);
    const shuffles = level >= 5;

    this.root.innerHTML = `
      <div class="hack-panel">
        <div class="hack-head"><span class="hack-title">// ICE BREAKER</span><button class="hack-abort" type="button">ABORT [ESC]</button></div>
        <div class="hack-legend"><span class="lg-data">◆ CYAN = HACK IT</span><span class="lg-ice">✕ RED = AVOID</span><span class="lg-left"></span></div>
        <div class="hack-timer"><i></i></div>
        <div class="ice-grid"></div>
      </div>`;
    const grid = this.root.querySelector('.ice-grid') as HTMLDivElement;
    const bar = this.root.querySelector('.hack-timer i') as HTMLElement;
    const leftEl = this.root.querySelector('.lg-left') as HTMLElement;

    const kinds: Kind[] = Array.from({ length: CELLS }, () => 'empty' as Kind);
    const claimed = new Set<number>();
    let remaining = need;

    const layout = (): void => {
      // Keep claimed data cells where they are; scatter the rest.
      const free: number[] = [];
      for (let i = 0; i < CELLS; i++) {
        if (claimed.has(i)) continue;
        kinds[i] = 'empty';
        free.push(i);
      }
      free.sort(() => Math.random() - 0.5);
      for (let k = 0; k < remaining && free.length; k++) kinds[free.pop()!] = 'data';
      for (let k = 0; k < iceCount && free.length; k++) kinds[free.pop()!] = 'ice';
    };

    const cells: HTMLButtonElement[] = [];
    for (let i = 0; i < CELLS; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ice-cell';
      b.innerHTML = `<span class="ic-sym"></span><kbd>${HOTKEYS[i]}</kbd>`;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); press(i); });
      grid.appendChild(b);
      cells.push(b);
    }

    const paint = (): void => {
      cells.forEach((b, i) => {
        const k = claimed.has(i) ? 'done' : kinds[i];
        b.dataset.k = k;
        (b.firstElementChild as HTMLElement).textContent = k === 'data' ? '◆' : k === 'ice' ? '✕' : k === 'done' ? '✔' : '';
      });
      leftEl.textContent = `${remaining} LEFT`;
    };

    let penalty = 0;
    const press = (i: number): void => {
      if (claimed.has(i)) return;
      const k = kinds[i];
      if (k === 'data') {
        claimed.add(i);
        remaining--;
        this.audio.click();
        paint();
        if (remaining <= 0) {
          this.audio.success();
          window.setTimeout(() => end(true), 220);
        }
      } else {
        penalty += k === 'ice' ? 1.6 : 0.5;
        cells[i].classList.remove('hit');
        void cells[i].offsetWidth;
        cells[i].classList.add('hit');
        grid.classList.remove('shake');
        void grid.offsetWidth;
        grid.classList.add('shake');
        this.audio.error();
      }
    };

    layout();
    paint();

    this.root.querySelector('.hack-abort')!.addEventListener('click', () => end(false));
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') { e.preventDefault(); end(false); return; }
      const idx = HOTKEYS.indexOf(e.key.length === 1 ? e.key.toUpperCase() : '');
      if (idx >= 0 && !e.repeat && !e.ctrlKey && !e.metaKey) { e.preventDefault(); press(idx); }
    };
    window.addEventListener('keydown', onKey);
    cleanups.push(() => window.removeEventListener('keydown', onKey));

    // Timer: accumulate clamped frame deltas so a hidden tab can't be used to stall the clock.
    let elapsed = 0;
    let lastShuffle = 0;
    let last = performance.now();
    let raf = 0;
    const loop = (now: number): void => {
      elapsed += Math.min(0.1, (now - last) / 1000);
      last = now;
      const left = total - elapsed - penalty;
      bar.style.width = `${Math.max(0, (left / total) * 100)}%`;
      bar.classList.toggle('low', left < total * 0.3);
      if (left <= 0) { this.audio.error(); end(false); return; }
      if (shuffles && elapsed - lastShuffle > 2.6) {
        lastShuffle = elapsed;
        layout();
        paint();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    cleanups.push(() => cancelAnimationFrame(raf));
  }
}
