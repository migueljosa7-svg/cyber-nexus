import { QUALITY_KEY } from './graphics/renderer';

/**
 * Last line of defence against the dreaded white screen on portals (CrazyGames / Poki iframes, in-app browsers):
 *  - `showFatal()` paints a self-contained recovery panel (no dependency on the game CSS or the 3D renderer),
 *  - `installErrorHandlers()` routes window errors / rejected promises: before the game finished booting they are
 *    fatal (a stuck loading screen is worse than a clear message), afterwards they are logged and the game keeps running.
 */

declare global {
  interface Window { __booted?: boolean }
}

let shown = false;
const seen = new Set<string>();

export function showFatal(title: string, detail: string): void {
  if (shown) return;
  shown = true;
  try {
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#02040a;color:#d8f8ff;font:14px/1.5 Consolas,"Courier New",monospace;padding:20px;text-align:center';
    const box = document.createElement('div');
    box.style.cssText = 'max-width:520px;border:1px solid #ff2bd6;padding:26px 28px;box-shadow:0 0 40px rgba(255,43,214,.35);background:rgba(2,6,14,.95)';
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font:900 22px/1.2 Orbitron,"Segoe UI",sans-serif;letter-spacing:.12em;color:#fff;margin-bottom:12px';
    const p = document.createElement('div');
    p.textContent = detail;
    p.style.cssText = 'opacity:.8;margin-bottom:20px;word-break:break-word';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap';
    const btn = (label: string, onClick: () => void, primary: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = `cursor:pointer;padding:12px 18px;font:700 12px Orbitron,sans-serif;letter-spacing:.14em;color:${primary ? '#14000f' : '#00f0ff'};background:${primary ? '#ff2bd6' : 'transparent'};border:1px solid ${primary ? '#ff2bd6' : '#00f0ff'}`;
      b.addEventListener('click', onClick);
      return b;
    };
    row.append(
      btn('RELOAD', () => location.reload(), true),
      btn('RELOAD · LOW GRAPHICS', () => {
        try { localStorage.setItem(QUALITY_KEY, 'low'); } catch { /* storage blocked */ }
        location.reload();
      }, false),
    );
    box.append(h, p, row);
    el.appendChild(box);
    document.body.appendChild(el);
    document.getElementById('boot-fallback')?.remove();
  } catch { /* nothing left to do */ }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return String(e); } catch { return 'unknown error'; }
}

export function installErrorHandlers(): void {
  window.addEventListener('error', (ev) => {
    // Resource load failures (fonts, SDK script blocked by an ad blocker) bubble here as plain Events: never fatal.
    if (!(ev instanceof ErrorEvent)) return;
    const msg = describe(ev.error ?? ev.message);
    if (!seen.has(msg)) { seen.add(msg); console.error('[error]', msg, ev.error); }
    if (!window.__booted) showFatal('SYSTEM FAILURE', `The game could not start (${msg}). Try reloading, or low graphics if your device is limited.`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = describe(ev.reason);
    if (!seen.has(msg)) { seen.add(msg); console.error('[unhandledrejection]', msg); }
    ev.preventDefault();
    if (!window.__booted) showFatal('SYSTEM FAILURE', `The game could not start (${msg}). Try reloading, or low graphics if your device is limited.`);
  });
}

/** True if a WebGL2 context can be created (checked on a throw-away canvas before building the renderer). */
export function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    (gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    return !!gl;
  } catch { return false; }
}
