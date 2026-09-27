/**
 * Polylines with cumulative arc length, used for every path a car can follow.
 */
export interface Poly {
  xs: Float32Array;
  ys: Float32Array;
  /** cumulative length at each vertex, cum[0] = 0 */
  cum: Float32Array;
  len: number;
}

export interface PosOut {
  x: number;
  y: number;
  a: number; // heading (radians)
}

export function polyFromPoints(pts: number[]): Poly {
  // pts = [x0, y0, x1, y1, ...]; drop duplicate consecutive points
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    const n = xs.length;
    if (n > 0 && Math.abs(xs[n - 1] - x) < 1e-6 && Math.abs(ys[n - 1] - y) < 1e-6) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 1) {
    // degenerate: make a tiny segment so heading is defined
    xs.push(xs[0] + 1e-4);
    ys.push(ys[0]);
  }
  const n = xs.length;
  const cum = new Float32Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    cum[i] = acc;
  }
  return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), cum, len: acc };
}

/** Sample a cubic Bezier into flat point list (appends, skipping the first point if skipFirst). */
export function sampleCubic(
  out: number[],
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  steps: number, skipFirst = false,
): void {
  for (let i = skipFirst ? 1 : 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
  }
}

export function sampleLine(out: number[], x0: number, y0: number, x1: number, y1: number, skipFirst = false): void {
  if (!skipFirst) out.push(x0, y0);
  out.push(x1, y1);
}

/** Find the vertex index i such that cum[i] <= s < cum[i+1]. */
function locate(p: Poly, s: number): number {
  const cum = p.cum;
  let lo = 0;
  let hi = cum.length - 2;
  if (s <= 0) return 0;
  if (s >= p.len) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function polyAt(p: Poly, s: number, out: PosOut): PosOut {
  const i = locate(p, s);
  const x0 = p.xs[i];
  const y0 = p.ys[i];
  const x1 = p.xs[i + 1];
  const y1 = p.ys[i + 1];
  const segLen = p.cum[i + 1] - p.cum[i];
  let t = segLen > 1e-9 ? (s - p.cum[i]) / segLen : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  out.x = x0 + (x1 - x0) * t;
  out.y = y0 + (y1 - y0) * t;
  out.a = Math.atan2(y1 - y0, x1 - x0);
  return out;
}

/** Arc-length positions where the polyline first enters / last leaves a disc. */
export function discRange(p: Poly, cx: number, cy: number, r: number): [number, number] | null {
  const n = p.xs.length;
  let first = -1;
  let last = -1;
  // fine sampling along the polyline to be robust with long segments
  const step = 0.02;
  for (let s = 0; s <= p.len + 1e-6; s += step) {
    const q = polyAt(p, Math.min(s, p.len), tmp);
    const inside = Math.hypot(q.x - cx, q.y - cy) < r;
    if (inside) {
      if (first < 0) first = s;
      last = s;
    }
  }
  if (first < 0 || n < 2) return null;
  return [Math.max(0, first), Math.min(p.len, last)];
}

const tmp: PosOut = { x: 0, y: 0, a: 0 };

/** Minimum distance between two polylines restricted to arc ranges. */
export function polyMinDist(
  a: Poly, a0: number, a1: number,
  b: Poly, b0: number, b1: number,
  step = 0.03,
): number {
  let best = Infinity;
  const pa: PosOut = { x: 0, y: 0, a: 0 };
  const pb: PosOut = { x: 0, y: 0, a: 0 };
  const ptsB: number[] = [];
  for (let s = b0; s <= b1 + 1e-6; s += step) {
    polyAt(b, Math.min(s, b1), pb);
    ptsB.push(pb.x, pb.y);
  }
  for (let s = a0; s <= a1 + 1e-6; s += step) {
    polyAt(a, Math.min(s, a1), pa);
    for (let j = 0; j < ptsB.length; j += 2) {
      const d = Math.hypot(pa.x - ptsB[j], pa.y - ptsB[j + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}
