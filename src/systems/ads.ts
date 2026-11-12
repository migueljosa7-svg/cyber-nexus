import type { GameContext } from '../context';
import { detectSdk, loadSdk, sdkGameplay, sdkLoadingFinished, type SdkKind } from './sdk';

/**
 * Rewarded-ad ("watch-to-earn") architecture.
 *
 *   AdService ── request(placement) ──► AdProvider.show(...)  ──►  onAdStarted / onAdCompleted / onAdFailed
 *
 * Gameplay code only talks to `AdService`. The platform SDK (CrazyGames / Poki / AdSense H5) is detected, loaded and
 * initialised automatically by `sdk.ts`; its native callbacks are mapped onto the hooks below. Only when no platform
 * is detected (local dev) the built-in `BroadcastProvider` plays a 30 s corporate-broadcast placeholder.
 * Never grant a reward from anywhere except the `completed` hook.
 */

export type AdPlacement = 'double_reward' | 'ram_refill' | 'rescue_credits' | 'daily_double';

export interface AdHooks {
  onAdStarted?(placement: AdPlacement): void;
  onAdCompleted?(placement: AdPlacement): void;
  onAdFailed?(placement: AdPlacement, reason: string): void;
}

/** What a provider must call back while an ad is showing. */
export interface ProviderCallbacks {
  started(): void;
  completed(): void;
  failed(reason: string): void;
}

export interface AdProvider {
  readonly name: string;
  isAvailable(): boolean;
  /** Shows a rewarded ad. Returns an optional cancel function used if the game has to abort it. */
  show(placement: AdPlacement, cb: ProviderCallbacks): (() => void) | void;
}

interface Limit { max: number; cooldown: number }

/** Session limits so rewards stay balanced (seconds / counts). */
const LIMITS: Record<AdPlacement, Limit> = {
  double_reward: { max: 99, cooldown: 0 },
  daily_double: { max: 1, cooldown: 0 },
  ram_refill: { max: 8, cooldown: 45 },
  rescue_credits: { max: 4, cooldown: 30 },
};

const AD_SECONDS = 30;

// ───────────────────────────── real SDK adapters (feature-detected) ─────────────────────────────

interface CrazySdk { ad: { requestAd(type: 'rewarded' | 'midgame', cb: { adStarted?: () => void; adFinished?: () => void; adError?: (e: unknown) => void }): void } }
interface PokiSdk { rewardedBreak(opts?: { onStart?: () => void } | (() => void)): Promise<boolean> }
type AdBreakFn = (o: {
  type: string; name: string;
  beforeReward?: (show: () => void) => void;
  adDismissed?: () => void; adViewed?: () => void;
  adBreakDone?: (info: { breakStatus: string }) => void;
}) => void;

const w = (): Record<string, unknown> => window as unknown as Record<string, unknown>;

export class CrazyGamesProvider implements AdProvider {
  readonly name = 'CrazyGames';
  private sdk(): CrazySdk | undefined { return (w().CrazyGames as { SDK?: CrazySdk } | undefined)?.SDK; }
  isAvailable(): boolean { return !!this.sdk()?.ad; }
  show(_p: AdPlacement, cb: ProviderCallbacks): void {
    const sdk = this.sdk();
    if (!sdk) { cb.failed('sdk_missing'); return; }
    sdk.ad.requestAd('rewarded', { adStarted: () => cb.started(), adFinished: () => cb.completed(), adError: (e) => cb.failed(String(e)) });
  }
}

export class PokiProvider implements AdProvider {
  readonly name = 'Poki';
  private sdk(): PokiSdk | undefined { return w().PokiSDK as PokiSdk | undefined; }
  isAvailable(): boolean { return typeof this.sdk()?.rewardedBreak === 'function'; }
  show(_p: AdPlacement, cb: ProviderCallbacks): void {
    const sdk = this.sdk();
    if (!sdk) { cb.failed('sdk_missing'); return; }
    let started = false;
    const onStart = (): void => { started = true; cb.started(); };
    sdk.rewardedBreak({ onStart }).then((ok) => {
      if (!started) cb.started();
      if (ok) cb.completed(); else cb.failed('not_rewarded');
    }).catch((e) => cb.failed(String(e)));
  }
}

/** Google AdSense for Games (H5) — `adBreak` rewarded format. */
export class AdSenseH5Provider implements AdProvider {
  readonly name = 'AdSense H5';
  isAvailable(): boolean { return typeof w().adBreak === 'function'; }
  show(p: AdPlacement, cb: ProviderCallbacks): void {
    const adBreak = w().adBreak as AdBreakFn | undefined;
    if (!adBreak) { cb.failed('sdk_missing'); return; }
    let viewed = false;
    adBreak({
      type: 'reward',
      name: p,
      beforeReward: (showAd) => { cb.started(); showAd(); },
      adViewed: () => { viewed = true; cb.completed(); },
      adDismissed: () => cb.failed('dismissed'),
      adBreakDone: (info) => { if (!viewed && info.breakStatus !== 'viewed' && info.breakStatus !== 'dismissed') cb.failed(info.breakStatus); },
    });
  }
}

// ───────────────────────────── built-in placeholder: corporate broadcast ─────────────────────────────

const SLIDES: Array<{ brand: string; line: string }> = [
  { brand: 'NEXUS CORP', line: 'Your memories, backed up nightly. Forget nothing. Remember everything we allow.' },
  { brand: 'ARASAKI-9 SYNTHETICS', line: 'Tired of flesh? Upgrade to chrome. Financing available at 0.1% (terms apply).' },
  { brand: 'NOODLE-DROME', line: 'Hot ramen in 90 seconds, delivered by drone. Rain-proof since 2064.' },
  { brand: 'OMNI-SEC GUARD', line: 'Security is a subscription. Safety is a rumour. Stay subscribed.' },
];

/** Full-screen 30 s "corporate broadcast" modal. Time only advances while the tab is visible. */
export class BroadcastProvider implements AdProvider {
  readonly name = 'Nexus Broadcast (placeholder)';
  private seconds = AD_SECONDS;
  constructor(private root: HTMLElement, seconds = AD_SECONDS) { this.seconds = seconds; }

  isAvailable(): boolean { return true; }

  show(placement: AdPlacement, cb: ProviderCallbacks): () => void {
    const reward = placement === 'ram_refill' ? 'FULL RAM REFILL' : placement === 'rescue_credits' ? 'RESCUE CREDITS' : placement === 'daily_double' ? 'DOUBLE DAILY REWARD' : 'DOUBLE MISSION REWARD';
    const el = document.createElement('div');
    el.className = 'screen ad-modal';
    el.innerHTML = `
      <div class="ad-box" role="dialog" aria-label="Sponsored broadcast">
        <div class="ad-top"><span class="ad-live"><i></i>LIVE</span><span class="ad-net">NEXUS NEWS NETWORK // SPONSORED BROADCAST</span><span class="ad-ch">CH-07</span></div>
        <div class="ad-screen">
          <div class="ad-scan"></div>
          <div class="ad-brand"></div>
          <div class="ad-line"></div>
          <div class="ad-bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        </div>
        <div class="ad-prog"><i></i></div>
        <div class="ad-bottom">
          <span class="ad-reward">REWARD: <b>${reward}</b></span>
          <span class="ad-count"></span>
          <button class="btn ad-btn" type="button" disabled>WAIT</button>
        </div>
        <div class="ad-ticker"><span>BREAKING: district curfew extended // synth-coffee futures up 4% // stay hydrated, citizens // this broadcast is mandatory for reward eligibility //</span></div>
      </div>`;
    this.root.appendChild(el);
    const q = <T extends HTMLElement>(s: string): T => el.querySelector(s) as T;
    const brand = q('.ad-brand');
    const line = q('.ad-line');
    const prog = q<HTMLElement>('.ad-prog i');
    const count = q('.ad-count');
    const btn = q<HTMLButtonElement>('.ad-btn');
    let finished = false;
    let elapsed = 0;
    let last = performance.now();
    let raf = 0;
    let slide = -1;
    let skipReady = false;

    const close = (): void => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      el.remove();
    };
    const finish = (ok: boolean, reason = ''): void => {
      if (finished) return;
      finished = true;
      close();
      if (ok) cb.completed(); else cb.failed(reason);
    };
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.code === 'Escape' && skipReady) finish(false, 'skipped');
    };
    window.addEventListener('keydown', onKey, true);
    btn.addEventListener('click', () => {
      if (elapsed >= this.seconds) finish(true);
      else if (skipReady) finish(false, 'skipped');
    });

    const loop = (now: number): void => {
      if (finished) return;
      elapsed += Math.min(0.25, (now - last) / 1000);
      last = now;
      const left = Math.max(0, this.seconds - elapsed);
      prog.style.width = `${Math.min(100, (elapsed / this.seconds) * 100)}%`;
      const s = Math.min(SLIDES.length - 1, Math.floor(elapsed / (this.seconds / SLIDES.length)));
      if (s !== slide) {
        slide = s;
        brand.textContent = SLIDES[s].brand;
        line.textContent = SLIDES[s].line;
      }
      if (left > 0) {
        count.textContent = `REWARD IN ${Math.ceil(left)}s`;
        if (!skipReady && elapsed > 6) { skipReady = true; btn.disabled = false; btn.textContent = 'SKIP · NO REWARD'; btn.classList.add('ghost'); }
      } else {
        count.textContent = 'BROADCAST COMPLETE';
        btn.disabled = false;
        btn.textContent = 'CLAIM REWARD';
        btn.classList.remove('ghost');
        btn.classList.add('primary');
      }
      raf = requestAnimationFrame(loop);
    };
    cb.started();
    raf = requestAnimationFrame(loop);
    return () => finish(false, 'cancelled');
  }
}

// ───────────────────────────── service ─────────────────────────────

/** Used while a platform SDK is still loading, or when it failed (ad blocker): never grants rewards. */
class UnavailableProvider implements AdProvider {
  readonly name = 'unavailable';
  isAvailable(): boolean { return false; }
  show(_p: AdPlacement, cb: ProviderCallbacks): void { cb.failed('unavailable'); }
}

export class AdService {
  /** Global hooks (analytics, mute music, pause SDK gameplay tracking, ...). */
  onAdStarted: (placement: AdPlacement) => void = () => undefined;
  onAdCompleted: (placement: AdPlacement) => void = () => undefined;
  onAdFailed: (placement: AdPlacement, reason: string) => void = () => undefined;

  private provider: AdProvider;
  private busy = false;
  private cancelCurrent: (() => void) | null = null;
  private uses = new Map<AdPlacement, number>();
  private lastEnd = new Map<AdPlacement, number>();

  /** Which platform SDK is in use ('none' = local simulator). */
  readonly sdk: SdkKind = detectSdk();
  /** Resolves once the SDK (if any) finished initialising. */
  readonly ready: Promise<void>;

  constructor(private ctx: GameContext, root: HTMLElement) {
    const qs = new URLSearchParams(location.search);
    // `?adseconds=N` shortens the local simulator, but only together with ?debug (QA builds).
    const secs = qs.has('debug') ? Math.max(1, Number(qs.get('adseconds')) || AD_SECONDS) : AD_SECONDS;
    if (this.sdk === 'none') {
      this.provider = new BroadcastProvider(root, secs);
      this.ready = Promise.resolve();
    } else {
      this.provider = new UnavailableProvider();
      this.ready = loadSdk(this.sdk).then((ok) => {
        if (!ok) return;
        this.provider = this.sdk === 'crazygames' ? new CrazyGamesProvider() : this.sdk === 'poki' ? new PokiProvider() : new AdSenseH5Provider();
        sdkLoadingFinished(this.sdk);
      });
    }
  }

  /** Platform gameplay signal (CrazyGames / Poki use it to schedule ads and analytics). */
  gameplay(playing: boolean): void { sdkGameplay(this.sdk, playing); }

  get providerName(): string { return this.provider.name; }
  get isBusy(): boolean { return this.busy; }

  setProvider(p: AdProvider): void { this.provider = p; }

  /** Remaining uses this session / seconds until the next one. */
  status(p: AdPlacement): { ok: boolean; left: number; wait: number } {
    const lim = LIMITS[p];
    const used = this.uses.get(p) ?? 0;
    const since = (performance.now() - (this.lastEnd.get(p) ?? -1e9)) / 1000;
    const wait = Math.max(0, Math.ceil(lim.cooldown - since));
    return { ok: used < lim.max && wait <= 0 && !this.busy && this.provider.isAvailable(), left: Math.max(0, lim.max - used), wait };
  }

  /** Shows a rewarded ad. Resolves `true` only when the viewer earned the reward (after `onAdCompleted`). */
  request(placement: AdPlacement, hooks: AdHooks = {}): Promise<boolean> {
    const st = this.status(placement);
    if (this.busy || !st.ok) {
      const reason = this.busy ? 'busy' : st.left <= 0 ? 'limit' : st.wait > 0 ? 'cooldown' : 'unavailable';
      hooks.onAdFailed?.(placement, reason);
      this.onAdFailed(placement, reason);
      return Promise.resolve(false);
    }
    this.busy = true;
    const { audio, modal } = this.ctx;
    const wasMuted = audio.muted;
    audio.setMuted(true);
    modal.open();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let started = false;
      let guard = 0;
      const settle = (ok: boolean, reason: string): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(guard);
        this.cancelCurrent = null;
        this.busy = false;
        this.lastEnd.set(placement, performance.now());
        audio.setMuted(wasMuted);
        modal.close();
        if (ok) {
          this.uses.set(placement, (this.uses.get(placement) ?? 0) + 1);
          this.ctx.progress.meta.data.counters.adsWatched++;
          this.ctx.progress.meta.save();
          try { hooks.onAdCompleted?.(placement); this.onAdCompleted(placement); } catch (e) { console.error(e); }
        } else {
          try { hooks.onAdFailed?.(placement, reason); this.onAdFailed(placement, reason); } catch (e) { console.error(e); }
        }
        resolve(ok);
      };
      // A provider that never reports back must not freeze the game.
      guard = window.setTimeout(() => { if (!started) { this.cancelCurrent?.(); settle(false, 'timeout'); } }, 15000);
      try {
        const cancel = this.provider.show(placement, {
          started: () => {
            if (started || settled) return;
            started = true;
            window.clearTimeout(guard);
            try { hooks.onAdStarted?.(placement); this.onAdStarted(placement); } catch (e) { console.error(e); }
          },
          completed: () => settle(true, ''),
          failed: (reason) => settle(false, reason),
        });
        this.cancelCurrent = cancel ?? null;
      } catch (e) {
        settle(false, `exception: ${String(e)}`);
      }
    });
  }
}
