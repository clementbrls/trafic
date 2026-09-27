export const LAND = 0;
export const WATER = 1;

export interface Bounds {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

/** Static terrain + unlocked playable bounds. */
export class World {
  readonly w: number;
  readonly h: number;
  readonly terrain: Uint8Array;
  /** decorative tree density per tile (0 = none, 1..3) */
  readonly trees: Uint8Array;
  /** random per-tile value for decoration variety */
  readonly jitter: Float32Array;
  bounds: Bounds;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.terrain = new Uint8Array(w * h);
    this.trees = new Uint8Array(w * h);
    this.jitter = new Float32Array(w * h);
    this.bounds = { x0: 0, y0: 0, x1: w, y1: h };
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inMap(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  inBounds(x: number, y: number): boolean {
    const b = this.bounds;
    return x >= b.x0 && y >= b.y0 && x < b.x1 && y < b.y1;
  }

  isWater(x: number, y: number): boolean {
    return this.inMap(x, y) && this.terrain[this.idx(x, y)] === WATER;
  }

  isLand(x: number, y: number): boolean {
    return this.inMap(x, y) && this.terrain[this.idx(x, y)] === LAND;
  }

  /** Count water tiles inside the current bounds. */
  waterInBounds(): number {
    const b = this.bounds;
    let n = 0;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) if (this.terrain[this.idx(x, y)] === WATER) n++;
    return n;
  }
}
