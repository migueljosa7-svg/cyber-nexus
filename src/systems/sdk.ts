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

interface CrazySdk { init(): Promise<void>; game: { gameplayStart(): void; gameplayStop(): void; loadingStart?(): void; loadingStop?(): void } }
interface PokiSdkFull { init(): Promise<void>; gameLoadingFinished(): void; gameplayStart(): void; gameplayStop(): void }

/** Loads and initialises the SDK. Resolves true when it is ready for ad requests. */
export async function loadSdk(kind: SdkKind): Promise<boolean> {
  try {
    if (kind === 'crazygames') {
      if (!(w().CrazyGames as { SDK?: unknown } | undefined)?.SDK && !(await injectScript(SDK_SCRIPTS.crazygames))) return false;
      await (w().CrazyGames as { SDK: CrazySdk }).SDK.init();
      return true;
    }
    if (kind === 'poki') {
      if (!w().PokiSDK && !(await injectScript(SDK_SCRIPTS.poki))) return false;
      const poki = w().PokiSDK as PokiSdkFull;
      await poki.init();
      return true;
    }
    if (kind === 'adsense') {
      const client = import.meta.env.VITE_ADSENSE_CLIENT;
      if (typeof w().adBreak !== 'function') {
        if (!client) return false;
        // Official H5 Games Ads bootstrap: queue calls until adsbygoogle.js has loaded.
        const q = (w().adsbygoogle = (w().adsbygoogle as unknown[] | undefined) ?? []) as unknown[];
        w().adBreak = w().adConfig = (o: unknown): void => { q.push(o); };
        const testMode = new URLSearchParams(location.search).has('adtest') || location.hostname === 'localhost';
        const ok = await injectScript(`${SDK_SCRIPTS.adsense}?client=${client}`, {
          'data-ad-client': client,
          'data-adbreak-test': testMode ? 'on' : 'off',
          crossorigin: 'anonymous',
        });
        if (!ok) return false;
        (w().adConfig as (o: unknown) => void)({ preloadAdBreaks: 'on', sound: 'on' });
      }
      return true;
    }
  } catch (e) {
    console.warn('[sdk] init failed', e);
  }
  return false;
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

/** Poki wants an explicit "loading finished" signal. */
export function sdkLoadingFinished(kind: SdkKind): void {
  try { if (kind === 'poki') (w().PokiSDK as PokiSdkFull | undefined)?.gameLoadingFinished?.(); } catch { /* best-effort */ }
}
