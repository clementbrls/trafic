import { Rng, ValueNoise } from '../core/rng';
import { World, LAND, WATER, type Bounds } from './world';

export type MapId = 'plaine' | 'riviere' | 'archipel';

export interface MapPreset {
  id: MapId;
  seed: number;
  difficulty: 1 | 2 | 3;
  startBridges: number;
  /** relative weight of bridge upgrades */
  bridgeWeight: number;
  /** demand multiplier */
  demand: number;
}

export const MAPS: MapPreset[] = [
  { id: 'plaine', seed: 1307, difficulty: 1, startBridges: 0, bridgeWeight: 0.6, demand: 0.95 },
  { id: 'riviere', seed: 4242, difficulty: 2, startBridges: 2, bridgeWeight: 1.4, demand: 1.0 },
  { id: 'archipel', seed: 777, difficulty: 3, startBridges: 3, bridgeWeight: 2.4, demand: 1.06 },
];

export function getMap(id: MapId): MapPreset {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

/** canonical (landscape) map size */
export const CANON_W = 30;
export const CANON_H = 20;

/** Bounds growth schedule (landscape orientation), index = week - 1 */
const GROWTH: [number, number][] = [
  [14, 9], [16, 10], [18, 11], [20, 12], [22, 13], [24, 14], [26, 16], [28, 18], [30, 20],
];

export function boundsForWeek(world: World, week: number, portrait: boolean): Bounds {
  const g = GROWTH[Math.min(GROWTH.length - 1, Math.max(0, week - 1))];
  const bw = portrait ? g[1] : g[0];
  const bh = portrait ? g[0] : g[1];
  const x0 = Math.floor((world.w - bw) / 2);
  const y0 = Math.floor((world.h - bh) / 2);
  return { x0, y0, x1: x0 + bw, y1: y0 + bh };
}

interface Canvas {
  w: number;
  h: number;
  water: Uint8Array;
}

function blob(c: Canvas, noise: ValueNoise, cx: number, cy: number, rx: number, ry: number, value: number, wobble = 0.45): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(c.w - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(c.h - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const n = noise.fbm((x + cx * 3.1) * 0.35, (y + cy * 1.7) * 0.35, 2);
      if (dx * dx + dy * dy < 1 + wobble * (n - 0.5)) c.water[y * c.w + x] = value;
    }
  }
}

function genPlaine(c: Canvas, rng: Rng, noise: ValueNoise): void {
  // A couple of ponds away from the centre
  const ponds: [number, number][] = [
    [rng.range(3, 7), rng.range(3, 6)],
    [rng.range(22, 27), rng.range(13, 17)],
    [rng.range(20, 25), rng.range(2, 5)],
  ];
  for (const [px, py] of ponds) blob(c, noise, px, py, rng.range(1.6, 2.6), rng.range(1.3, 2.1), 1);
}

function genRiviere(c: Canvas, rng: Rng, noise: ValueNoise): void {
  const phase = rng.range(0, Math.PI * 2);
  const phase2 = rng.range(0, Math.PI * 2);
  // main river, meandering horizontally below the centre
  for (let x = 0; x < c.w; x++) {
    const fx = x + 0.5;
    const yc = c.h * 0.5 + 3.4 + 1.7 * Math.sin(fx * 0.23 + phase) + 1.1 * Math.sin(fx * 0.09 + phase2);
    const halfW = 0.85 + 0.35 * noise.sample(fx * 0.3, 3.3);
    for (let y = 0; y < c.h; y++) {
      if (Math.abs(y + 0.5 - yc) < halfW) c.water[y * c.w + x] = 1;
    }
  }
  // tributary from the top joining the river, right of centre
  const tx0 = c.w * 0.68 + rng.range(-1, 1);
  for (let y = 0; y < c.h; y++) {
    const fy = y + 0.5;
    const xc = tx0 + 1.4 * Math.sin(fy * 0.35 + phase2) - fy * 0.18;
    const halfW = 0.6 + 0.2 * noise.sample(4.4, fy * 0.4);
    let reached = false;
    for (let x = 0; x < c.w; x++) {
      if (Math.abs(x + 0.5 - xc) < halfW) {
        if (c.water[y * c.w + x] && y > c.h * 0.5) reached = true;
        c.water[y * c.w + x] = 1;
      }
    }
    if (reached) break;
  }
  // a small lake top-left
  blob(c, noise, rng.range(4, 7), rng.range(3, 5), 2.2, 1.6, 1);
}

function genArchipel(c: Canvas, rng: Rng, noise: ValueNoise): void {
  // start with water everywhere, then raise islands
  c.water.fill(1);
  const cx = c.w / 2;
  const cy = c.h / 2;
  blob(c, noise, cx, cy, 6.8, 4.6, 0, 0.5);
  const islands: [number, number, number, number][] = [
    [cx - 10.5, cy - 4.5, 4.2, 3.6],
    [cx - 10.5, cy + 4.8, 4.5, 3.8],
    [cx + 10.5, cy - 4.8, 4.4, 3.6],
    [cx + 10.8, cy + 4.6, 4.2, 3.8],
    [cx + 0.5, cy - 9.5, 5.5, 2.6],
    [cx - 0.5, cy + 9.6, 5.8, 2.6],
    [cx - 15, cy, 2.6, 3.4],
    [cx + 15, cy, 2.6, 3.4],
  ];
  for (const [ix, iy, rx, ry] of islands) {
    blob(c, noise, ix + rng.range(-0.6, 0.6), iy + rng.range(-0.5, 0.5), rx, ry, 0, 0.55);
  }
}

/** Remove single-tile water specks and single-tile islands for a cleaner look. */
function cleanup(c: Canvas): void {
  for (let pass = 0; pass < 2; pass++) {
    const copy = c.water.slice();
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        let same = 0;
        let total = 0;
        const v = copy[y * c.w + x];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (dx && dy) continue; // orthogonal only
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= c.w || ny >= c.h) continue;
            total++;
            if (copy[ny * c.w + nx] === v) same++;
          }
        }
        if (total >= 3 && same === 0) c.water[y * c.w + x] = v ? 0 : 1;
      }
    }
  }
}

export function generateWorld(preset: MapPreset, portrait: boolean): World {
  const rng = new Rng(preset.seed);
  const noise = new ValueNoise(preset.seed * 7 + 3);
  const c: Canvas = { w: CANON_W, h: CANON_H, water: new Uint8Array(CANON_W * CANON_H) };
  if (preset.id === 'plaine') genPlaine(c, rng, noise);
  else if (preset.id === 'riviere') genRiviere(c, rng, noise);
  else genArchipel(c, rng, noise);
  cleanup(c);

  // keep the heart of the map dry so the first destination has room
  const cx = CANON_W / 2;
  const cy = CANON_H / 2;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const dx = (x + 0.5 - cx) / 4.2;
      const dy = (y + 0.5 - cy) / 2.6;
      if (dx * dx + dy * dy < 1) c.water[y * c.w + x] = 0;
    }
  }

  const w = portrait ? CANON_H : CANON_W;
  const h = portrait ? CANON_W : CANON_H;
  const world = new World(w, h);
  const treeNoise = new ValueNoise(preset.seed * 13 + 11);
  const jit = new Rng(preset.seed * 31 + 5);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cxI = portrait ? y : x;
      const cyI = portrait ? x : y;
      const wat = c.water[cyI * CANON_W + cxI];
      const i = world.idx(x, y);
      world.terrain[i] = wat ? WATER : LAND;
      world.jitter[i] = jit.next();
      if (!wat) {
        const n = treeNoise.fbm(cxI * 0.21, cyI * 0.21, 3);
        const centre = Math.hypot((cxI + 0.5 - cx) / 6, (cyI + 0.5 - cy) / 4);
        const t = n - (centre < 1 ? 0.12 : 0);
        world.trees[i] = t > 0.66 ? 3 : t > 0.6 ? 2 : t > 0.55 ? 1 : 0;
      }
    }
  }
  world.bounds = boundsForWeek(world, 1, portrait);
  return world;
}

/** Terrain constant re-export for callers that only import maps */
export { LAND, WATER };
