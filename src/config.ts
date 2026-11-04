export const IS_TOUCH: boolean =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches);

export const CFG = {
  chunkSize: 56,
  viewRadius: IS_TOUCH ? 1 : 2,
  chunksPerFrame: 1,
  maxPixelRatio: IS_TOUCH ? 1.5 : 2,
  shadowMapSize: IS_TOUCH ? 1024 : 2048,
  rainCount: IS_TOUCH ? 900 : 2200,
  maxEnemiesCap: IS_TOUCH ? 10 : 16,
  particleCap: IS_TOUCH ? 1400 : 3000,
  gravity: 34,
  playerRadius: 0.55,
} as const;

export interface Palette {
  name: string;
  primary: number;
  secondary: number;
  accent: number;
  fog: number;
}

export const PALETTES: Palette[] = [
  { name: 'NEON-GRID', primary: 0x00f0ff, secondary: 0xff2bd6, accent: 0xb6ff00, fog: 0x05061a },
  { name: 'CRIMSON-NET', primary: 0xff2b5e, secondary: 0x00e5ff, accent: 0xffc400, fog: 0x14040c },
  { name: 'TOXIC-CORE', primary: 0x39ff14, secondary: 0xb400ff, accent: 0x00f0ff, fog: 0x04120a },
  { name: 'VIOLET-VOID', primary: 0xa855ff, secondary: 0x00ffd5, accent: 0xff7a18, fog: 0x0b0520 },
];

export const BEST_KEY = 'cybernexus_protocol_zero_best';
