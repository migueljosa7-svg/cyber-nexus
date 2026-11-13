/**
 * Platform SDK bootstrap (CrazyGames, Poki, Google AdSense H5 Games).
 *
 * The right SDK is chosen automatically:
 *   1. `?adprovider=crazygames|poki|adsense` (QA override),
 *   2. the page host / referrer / ancestor origin (crazygames.com, poki.com),
 *   3. an SDK already present on `window`,
 *   4. `VITE_ADSENSE_CLIENT` (e.g. `ca-pub-1234567890123456`) set at build time => AdSense H5.
 * Otherwise (local dev, own domain without a network) `kind === 'none'` and the corporate-broadcast simulator is used.
 */

export type SdkKind = 'crazygames' | 'poki' | 'adsense' | 'none';

export const SDK_SCRIPTS = {
  crazygames: 'https://sdk.crazygames.com/crazygames-sdk-v3.js',
  poki: 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js',
  adsense: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
} as const;

const w = (): Record<string, unknown> => window as unknown as Record<string, unknown>;

function context(): string {
  let anc = '';
  try { anc = Array.from(location.ancestorOrigins ?? []).join(' '); } catch { /* not available */ }
  return `${location.hostname} ${document.referrer} ${anc}`.toLowerCase();
}

export function detectSdk(): SdkKind {
  const forced = new URLSearchParams(location.search).get('adprovider')?.toLowerCase();
  if (forced === 'crazygames' || forced === 'poki' || forced === 'adsense') return forced;
  if (forced === 'none' || forced === 'simulator') return 'none';
  const ctx = context();
  if (ctx.includes('crazygames')) return 'crazygames';
  if (ctx.includes('poki')) return 'poki';
  if ((w().CrazyGames as { SDK?: unknown } | undefined)?.SDK) return 'crazygames';
  if (w().PokiSDK) return 'poki';
  if (typeof w().adBreak === 'function') return 'adsense';
  if (import.meta.env.VITE_ADSENSE_CLIENT) return 'adsense';
  return 'none';
}

function injectScript(src: string, attrs: Record<string, string> = {}, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.querySelector(`script[src^="${src}"]`)) { resolve(true); return; }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    const t = window.setTimeout(() => resolve(false), timeoutMs);
    s.onload = () => { window.clearTimeout(t); resolve(true); };
    s.onerror = () => { window.clearTimeout(t); resolve(false); };
    document.head.appendChild(s);
  });
}

interface CrazySdk { init(): Promise<void>; environment?: string; game: { gameplayStart(): void; gameplayStop(): void; loadingStart?(): void; loadingStop?(): void } }
interface PokiSdkFull { init(): Promise<void>; gameLoadingFinished(): void; gameplayStart(): void; gameplayStop(): void }

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => window.setTimeout(() => rej(new Error('sdk timeout')), ms))]);

/** Waits for a global that a (possibly still loading, possibly blocked) script should define. */
function waitFor(test: () => unknown, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (): void => {
      if (test()) { resolve(true); return; }
      if (performance.now() - t0 > ms || (w() as { __sdkBlocked?: boolean }).__sdkBlocked) { resolve(false); return; }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Loads and initialises the SDK. Never throws and never blocks the game for more than a few seconds:
 *  - 'ready'    the platform SDK is usable,
 *  - 'disabled' the SDK loaded but reports it is not running on its platform (use the local simulator),
 *  - 'failed'   blocked (ad blocker), offline, timed out or crashed: ads are simply unavailable.
 */
export async function loadSdk(kind: SdkKind): Promise<'ready' | 'disabled' | 'failed'> {
  try {
    if (kind === 'crazygames') {
      const has = (): unknown => (w().CrazyGames as { SDK?: unknown } | undefined)?.SDK;
      // index.html already carries the official tag; inject it ourselves only if it was stripped.
      if (!has() && !document.querySelector(`script[src^="${SDK_SCRIPTS.crazygames}"]`)) void injectScript(SDK_SCRIPTS.crazygames);
      if (!(await waitFor(has, 8000))) return 'failed';
      const sdk = (w().CrazyGames as { SDK: CrazySdk }).SDK;
      await withTimeout(sdk.init(), 8000);
      if (sdk.environment === 'disabled') return 'disabled';
      try { sdk.game.loadingStart?.(); } catch { /* optional */ }
      return 'ready';
    }
    if (kind === 'poki') {
      if (!w().PokiSDK && !document.querySelector(`script[src^="${SDK_SCRIPTS.poki}"]`)) void injectScript(SDK_SCRIPTS.poki);
      if (!(await waitFor(() => w().PokiSDK, 8000))) return 'failed';
      await withTimeout((w().PokiSDK as PokiSdkFull).init(), 8000);
      return 'ready';
    }
    if (kind === 'adsense') {
      const client = import.meta.env.VITE_ADSENSE_CLIENT;
      if (typeof w().adBreak !== 'function') {
        if (!client) return 'failed';
        // Official H5 Games Ads bootstrap: queue calls until adsbygoogle.js has loaded.
        const q = (w().adsbygoogle = (w().adsbygoogle as unknown[] | undefined) ?? []) as unknown[];
        w().adBreak = w().adConfig = (o: unknown): void => { q.push(o); };
        const testMode = new URLSearchParams(location.search).has('adtest') || location.hostname === 'localhost';
        const ok = await injectScript(`${SDK_SCRIPTS.adsense}?client=${client}`, {
          'data-ad-client': client,
          'data-adbreak-test': testMode ? 'on' : 'off',
          crossorigin: 'anonymous',
        });
        if (!ok) return 'failed';
        (w().adConfig as (o: unknown) => void)({ preloadAdBreaks: 'on', sound: 'on' });
      }
      return 'ready';
    }
  } catch (e) {
    console.warn('[sdk] init failed', e);
  }
  return 'failed';
}

/** Tells the platform when the player is actively playing (required by CrazyGames / Poki for ad timing). */
export function sdkGameplay(kind: SdkKind, playing: boolean): void {
  try {
    if (kind === 'crazygames') {
      const g = (w().CrazyGames as { SDK?: CrazySdk } | undefined)?.SDK?.game;
      if (playing) g?.gameplayStart(); else g?.gameplayStop();
    } else if (kind === 'poki') {
      const p = w().PokiSDK as PokiSdkFull | undefined;
      if (playing) p?.gameplayStart?.(); else p?.gameplayStop?.();
    }
  } catch { /* platform signals are best-effort */ }
}

/** "Loading finished" signal (CrazyGames loadingStop, Poki gameLoadingFinished). */
export function sdkLoadingFinished(kind: SdkKind): void {
  try {
    if (kind === 'poki') (w().PokiSDK as PokiSdkFull | undefined)?.gameLoadingFinished?.();
    else if (kind === 'crazygames') (w().CrazyGames as { SDK?: CrazySdk } | undefined)?.SDK?.game.loadingStop?.();
  } catch { /* best-effort */ }
}
