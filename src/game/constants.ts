import { SQRT2 } from '../core/math';

/**
 * 8 directions, clockwise on screen (y grows downward), starting East.
 * 0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE
 */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;
/** unit vectors */
export const UX = DX.map((d, i) => (i & 1 ? d / SQRT2 : d));
export const UY = DY.map((d, i) => (i & 1 ? d / SQRT2 : d));
/** distance from a tile centre to its boundary along a direction */
export const BOUND = [0.5, SQRT2 / 2, 0.5, SQRT2 / 2, 0.5, SQRT2 / 2, 0.5, SQRT2 / 2];
export const DIR_ANGLE = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => Math.atan2(UY[d], UX[d]));

/** pseudo-direction used for path ends (house / parking) */
export const TERM = 8;

export const opp = (d: number): number => (d + 4) & 7;
export const isDiag = (d: number): boolean => (d & 1) === 1;

export function dirBetween(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.sign(bx - ax);
  const dy = Math.sign(by - ay);
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}

// ---- Geometry (tile units) ----
export const ROAD_W = 0.44;
export const AVE_W = 0.56;
export const DRIVE_W = 0.3;
export const LANE = 0.1;
export const CAR_LEN = 0.22;
export const CAR_WID = 0.12;
export const MIN_GAP = 0.06;
export const SPACING = CAR_LEN + MIN_GAP;
export const BOX_R = 0.29;
export const RING_R = 0.27;

// ---- Dynamics ----
export const BASE_SPEED = 1.9; // tiles / s
export const ACCEL = 2.6;
export const DECEL = 5.5;
export const LOOKAHEAD = 1.8;
export const REQ_DIST = 0.42;

export const SPEED_MOTORWAY = 1.85;
export const SPEED_AVENUE = 1.3;
export const SPEED_BOX_DEFAULT = 0.5;
export const SPEED_BOX_MAJOR = 0.86;
export const SPEED_BOX_LIGHT = 1.0;
export const SPEED_BOX_RING = 0.66;
export const SPEED_TERMINAL = 0.62;

// ---- Rules ----
export const MAX_BRIDGE_SPAN = 6; // water tiles
export const MAX_MOTORWAY_LEN = 13; // distance between endpoint tiles
export const MIN_MOTORWAY_LEN = 2;
export const PARK_SLOTS = 4;
export const PARK_TIME = 0.6;
/** a demand is late after waiting this long (s) */
export const PIN_PATIENCE = 30;
/** late demands that start the overflow timer */
export const LATE_OVERFLOW = 3;
/** demands piling up beyond this also overflow */
export const PIN_HARD_CAP = 12;
export const OVERFLOW_TIME = 45;
export const CARS_PER_HOUSE = 4;
export const DAY_LENGTH = 10; // seconds
export const WEEK_DAYS = 7;
export const STUCK_TIMEOUT = 45;

export const PALETTE = [
  { id: 'coral', base: '#F06B5B', dark: '#C9483B', light: '#FBD3CD' },
  { id: 'blue', base: '#3F8FDB', dark: '#2A6BAE', light: '#CFE3F7' },
  { id: 'yellow', base: '#F2B233', dark: '#C98A12', light: '#FCEBC5' },
  { id: 'green', base: '#3FB57C', dark: '#2B8A5C', light: '#CBEEDB' },
  { id: 'purple', base: '#9A6BDB', dark: '#7448B3', light: '#E6DAF7' },
  { id: 'teal', base: '#2CB5B5', dark: '#1B8A8A', light: '#C6EEEE' },
] as const;

export const COLOR_COUNT = PALETTE.length;
