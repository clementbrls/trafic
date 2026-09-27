import { polyFromPoints, sampleCubic, sampleLine, discRange, type Poly } from '../core/poly';
import { clamp, mod, TAU } from '../core/math';
import { UX, UY, BOUND, DIR_ANGLE, TERM, LANE, RING_R, BOX_R, opp, SPEED_TERMINAL } from './constants';
import type { Link, RNode } from './network';

/** Geometry of one way through a node (entry arm -> exit arm). */
export interface MoveGeom {
  poly: Poly;
  entry: number;
  exit: number;
  /** arc-length range of the conflict zone (used when the node is a junction) */
  boxIn: number;
  boxOut: number;
  /** curvature-based speed factor */
  speed: number;
  /** roundabout: arc-length range spent on the ring, and ring entry angle */
  ringIn: number;
  ringOut: number;
  thetaIn: number;
  ring: boolean;
}

interface NodeGeoCache {
  version: number;
  ring: boolean;
  moves: Map<number, MoveGeom>;
}

/** right-hand normal of a travel direction (screen coordinates, y down) */
function rightX(_vx: number, vy: number): number {
  return -vy;
}
function rightY(vx: number, _vy: number): number {
  return vx;
}

/** Boundary lane point for a car entering the node through arm `a`. */
export function inPoint(n: RNode, a: number): [number, number] {
  const vx = -UX[a];
  const vy = -UY[a];
  return [n.cx + UX[a] * BOUND[a] + rightX(vx, vy) * LANE, n.cy + UY[a] * BOUND[a] + rightY(vx, vy) * LANE];
}

/** Boundary lane point for a car leaving the node through arm `b`. */
export function outPoint(n: RNode, b: number): [number, number] {
  const vx = UX[b];
  const vy = UY[b];
  return [n.cx + UX[b] * BOUND[b] + rightX(vx, vy) * LANE, n.cy + UY[b] * BOUND[b] + rightY(vx, vy) * LANE];
}

function turnSpeed(entry: number, exit: number): number {
  if (entry === TERM || exit === TERM) return SPEED_TERMINAL;
  // angle between travel directions
  const vin = DIR_ANGLE[opp(entry)];
  const vout = DIR_ANGLE[exit];
  let a = Math.abs(mod(vout - vin + Math.PI, TAU) - Math.PI);
  if (entry === exit) a = Math.PI;
  return clamp(1 - 0.35 * Math.pow(a / (Math.PI / 2), 1.3), 0.36, 1);
}

function buildPlain(n: RNode, entry: number, exit: number): MoveGeom {
  const pts: number[] = [];
  const cx = n.cx;
  const cy = n.cy;
  if (entry === TERM && exit === TERM) {
    sampleLine(pts, cx, cy, cx + 0.01, cy);
  } else if (entry === TERM) {
    // leaving a house / parking
    const vx = UX[exit];
    const vy = UY[exit];
    const [ex, ey] = outPoint(n, exit);
    sampleLine(pts, cx + rightX(vx, vy) * LANE - vx * 0.1, cy + rightY(vx, vy) * LANE - vy * 0.1, ex, ey);
  } else if (exit === TERM) {
    const vx = -UX[entry];
    const vy = -UY[entry];
    const [sx, sy] = inPoint(n, entry);
    sampleLine(pts, sx, sy, cx + rightX(vx, vy) * LANE - vx * 0.04, cy + rightY(vx, vy) * LANE - vy * 0.04);
  } else {
    const [x0, y0] = inPoint(n, entry);
    const [x3, y3] = outPoint(n, exit);
    const vinx = -UX[entry];
    const viny = -UY[entry];
    const voutx = UX[exit];
    const vouty = UY[exit];
    if (exit === opp(entry)) {
      sampleLine(pts, x0, y0, x3, y3);
    } else if (entry === exit) {
      const h = 0.42;
      sampleCubic(pts, x0, y0, x0 + vinx * h, y0 + viny * h, x3 + vinx * h, y3 + viny * h, x3, y3, 14);
    } else {
      const dx = x3 - x0;
      const dy = y3 - y0;
      const det = vinx * vouty - viny * voutx;
      const t = (dx * vouty - dy * voutx) / det;
      const s = (vinx * dy - viny * dx) / det;
      if (t > 0.02 && s > 0.02 && t < 1.5 && s < 1.5) {
        const X = x0 + vinx * t;
        const Y = y0 + viny * t;
        sampleCubic(
          pts, x0, y0,
          x0 + ((X - x0) * 2) / 3, y0 + ((Y - y0) * 2) / 3,
          x3 + ((X - x3) * 2) / 3, y3 + ((Y - y3) * 2) / 3,
          x3, y3, 12,
        );
      } else {
        const h = 0.3;
        sampleCubic(pts, x0, y0, x0 + vinx * h, y0 + viny * h, x3 - voutx * h, y3 - vouty * h, x3, y3, 12);
      }
    }
  }
  const poly = polyFromPoints(pts);
  let boxIn = 0;
  let boxOut = 0;
  if (entry !== TERM && exit !== TERM) {
    const r = discRange(poly, cx, cy, BOX_R);
    if (r && r[1] - r[0] > 0.04) {
      boxIn = r[0];
      boxOut = r[1];
    } else {
      boxIn = poly.len * 0.35;
      boxOut = poly.len * 0.65;
    }
  }
  return {
    poly, entry, exit, boxIn, boxOut,
    speed: turnSpeed(entry, exit),
    ringIn: 0, ringOut: 0, thetaIn: 0, ring: false,
  };
}

const RING_DELTA = Math.asin(LANE / RING_R);

function buildRing(n: RNode, entry: number, exit: number): MoveGeom {
  if (entry === TERM || exit === TERM) return buildPlain(n, entry, exit);
  const cx = n.cx;
  const cy = n.cy;
  const R = RING_R;
  const thetaIn = DIR_ANGLE[entry] - RING_DELTA;
  let arc: number;
  if (entry === exit) arc = TAU - 2 * RING_DELTA;
  else arc = Math.max(0.06, mod(DIR_ANGLE[entry] - DIR_ANGLE[exit], TAU) - 2 * RING_DELTA);
  const thetaOut = thetaIn - arc;
  const pts: number[] = [];
  const [x0, y0] = inPoint(n, entry);
  const [x3, y3] = outPoint(n, exit);
  const vinx = -UX[entry];
  const viny = -UY[entry];
  const voutx = UX[exit];
  const vouty = UY[exit];
  const qix = cx + R * Math.cos(thetaIn);
  const qiy = cy + R * Math.sin(thetaIn);
  // tangent of CCW (visual) motion = decreasing theta
  const tix = Math.sin(thetaIn);
  const tiy = -Math.cos(thetaIn);
  const qox = cx + R * Math.cos(thetaOut);
  const qoy = cy + R * Math.sin(thetaOut);
  const tox = Math.sin(thetaOut);
  const toy = -Math.cos(thetaOut);
  const h1 = 0.1;
  const h2 = 0.09;
  sampleCubic(pts, x0, y0, x0 + vinx * h1, y0 + viny * h1, qix - tix * h2, qiy - tiy * h2, qix, qiy, 8);
  const merge = polyFromPoints(pts).len;
  const steps = Math.max(2, Math.ceil(arc / 0.18));
  for (let i = 1; i <= steps; i++) {
    const th = thetaIn - (arc * i) / steps;
    pts.push(cx + R * Math.cos(th), cy + R * Math.sin(th));
  }
  const withArc = polyFromPoints(pts).len;
  sampleCubic(pts, qox, qoy, qox + tox * h2, qoy + toy * h2, x3 - voutx * h1, y3 - vouty * h1, x3, y3, 8, true);
  const poly = polyFromPoints(pts);
  const r = discRange(poly, cx, cy, R + 0.1);
  const boxIn = r ? r[0] : merge * 0.5;
  const boxOut = r ? r[1] : withArc + (poly.len - withArc) * 0.5;
  return {
    poly, entry, exit, boxIn, boxOut,
    speed: 1,
    ringIn: merge, ringOut: withArc, thetaIn, ring: true,
  };
}

/** Get (cached) geometry for travelling through `n` from arm `entry` to arm `exit`. */
export function moveGeom(n: RNode, entry: number, exit: number): MoveGeom {
  const ring = n.control === 'roundabout' && n.kind === 'road';
  let cache = n.geo as NodeGeoCache | null;
  if (!cache || cache.version !== n.version || cache.ring !== ring) {
    cache = { version: n.version, ring, moves: new Map() };
    n.geo = cache;
  }
  const key = entry * 9 + exit;
  let g = cache.moves.get(key);
  if (!g) {
    g = ring ? buildRing(n, entry, exit) : buildPlain(n, entry, exit);
    cache.moves.set(key, g);
  }
  return g;
}

const linkCache = new WeakMap<Link, [Poly | null, Poly | null]>();

/** Straight lane of a long link (bridge / motorway), travelling away from `from`. */
export function linkPoly(l: Link, from: RNode): Poly {
  let c = linkCache.get(l);
  if (!c) {
    c = [null, null];
    linkCache.set(l, c);
  }
  const idx = from === l.a ? 0 : 1;
  let p = c[idx];
  if (!p) {
    const d = l.dirFrom(from);
    const to = l.other(from);
    const [x0, y0] = outPoint(from, d);
    const [x1, y1] = inPoint(to, opp(d));
    p = polyFromPoints([x0, y0, x1, y1]);
    c[idx] = p;
  }
  return p;
}
