/** Touch-first devices only (a laptop with a touchscreen still has hover + fine pointer). */
export const IS_TOUCH: boolean =
  typeof window !== 'undefined' &&
  (window.matchMedia('(pointer: coarse)').matches ||
    ('ontouchstart' in window && !window.matchMedia('(hover: hover)').matches));

/** City grid. Roads are centred on multiples of S; a chunk spans [cx*S, (cx+1)*S) on both axes. */
export const CITY = {
  S: 64,
  /** Half width of the whole street (carriageway + sidewalks). */
  ROAD_HALF: 7,
  /** Half width of the carriageway (asphalt). */
  CARRIAGE_HALF: 4,
  /** Lateral offset from the road centreline where pedestrians walk. */
  WALK: 5.2,
  /** Distance from a road centreline to the first lot. */
  LOT_INSET: 8.5,
} as const;

export const CFG = {
  viewRadius: IS_TOUCH ? 1 : 2,
  maxPixelRatio: IS_TOUCH ? 1.25 : 1.5,
  rainCount: IS_TOUCH ? 600 : 1400,
  particleCap: IS_TOUCH ? 900 : 2000,
  groundCars: IS_TOUCH ? 30 : 60,
  flyers: IS_TOUCH ? 20 : 40,
  npcCount: IS_TOUCH ? 22 : 44,
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

export const PALETTE: Palette = { name: 'NEON-GRID', primary: 0x00f0ff, secondary: 0xff2bd6, accent: 0xb6ff00, fog: 0x05061a };

export const SAVE_KEY = 'cybernexus_open_world_save_v1';
