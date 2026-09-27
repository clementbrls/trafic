import { polyAt, polyFromPoints, sampleCubic, type Poly, type PosOut } from '../core/poly';
import { mod, TAU, clamp } from '../core/math';
import {
  TERM, opp, RING_R, CAR_LEN, CAR_WID, SPACING,
  BASE_SPEED, ACCEL, DECEL, LOOKAHEAD, REQ_DIST, SPEED_MOTORWAY, SPEED_AVENUE, SPEED_BOX_DEFAULT,
  SPEED_BOX_MAJOR, SPEED_BOX_LIGHT, SPEED_BOX_RING, SPEED_TERMINAL, PARK_TIME, STUCK_TIMEOUT,
} from './constants';
import { moveGeom, linkPoly, type MoveGeom } from './geometry';
import { findRoute, type Route } from './pathfind';
import { polyMinDist } from '../core/poly';
import {
  Car, SEG_APPROACH, SEG_BOX, SEG_DEPART, SEG_END, SEG_LINK, SEG_MOVE, SEG_START,
  type Seg, type JunctionRef,
} from './car';
import type { Link, Network, RNode } from './network';
import type { Destination } from './entities';

const KEY_NODE = 2048;
const PLATOON_EXTRA = 0.75;
/** extra request distance for cars that may keep going (green light, through road) */
const FLOW_EXTRA = 0.7;
const RING_CAP = 4;
const MIN_GREEN = 2.6;
const MAX_GREEN = 9;
const CLEAR_MIN = 0.5;
const CLEAR_MAX = 3.5;
const MINOR_PATIENCE = 5;
/** speed under which a car counts as stopped at a stop line */
const STOP_SPEED = 0.16;
/** distance (tiles) at which a car approaching a junction is visible to yielding cars */
const PRIORITY_WATCH = 1.3;

function nodeKey(n: RNode, type: number, entry: number, exit: number): number {
  return n.id * KEY_NODE + type * 256 + entry * 16 + exit;
}

function linkKey(l: Link, from: RNode): number {
  return -(l.id * 2 + (from === l.a ? 0 : 1) + 1);
}

/** speed factor of the road class on one arm of a node */
function armSpeed(n: RNode, arm: number): number {
  if (arm === TERM) return 1;
  const l = n.links[arm];
  if (!l) return 1;
  if (l.tier === 'avenue') return SPEED_AVENUE;
  return 1;
}

export interface TrafficHost {
  now(): number;
  destOfGate(n: RNode): Destination | undefined;
  onDeliver(car: Car, dest: Destination): void;
  onArriveHome(car: Car): void;
  onPoof(car: Car, x: number, y: number): void;
  onAbandon(car: Car, dest: Destination): void;
}

type LightState = 0 | 1 | 2; // green, amber, red

/** Right-of-way manager for a node with 3+ arms (or a roundabout). */
export class Junction implements JunctionRef {
  readonly node: RNode;
  inside: Car[] = [];
  requests: Car[] = [];
  /** cars close to the stop line (used by yielding cars to find a gap) */
  approaching: Car[] = [];
  /** light phases: axis (d & 3) per phase */
  phases: number[] = [];
  phase = 0;
  phaseT = 0;
  clearing = false;
  clearT = 0;
  avgWait = 0;
  /** smoothed number of cars queuing at the stop lines */
  queue = 0;
  /** cars that crossed recently (smoothed per second) */
  flow = 0;
  /** arms of the through (priority) road; 0 = all arms are equal */
  majorMask = 0;
  /** arms where cars must stop before entering */
  stopMask = 0;
  private conflictCache = new Map<number, boolean>();
  private version = -1;

  constructor(node: RNode) {
    this.node = node;
    this.refresh();
  }

  get isLight(): boolean {
    return this.node.control === 'light' && this.phases.length > 1;
  }

  get isRing(): boolean {
    return this.node.control === 'roundabout';
  }

  refresh(): void {
    const n = this.node;
    if (this.version === n.version) return;
    this.version = n.version;
    this.conflictCache.clear();
    const axes: number[] = [];
    // Road class per arm: driveway 0, street 1, avenue / motorway 2.
    // The highest class forms the through road if it has at most 2 arms,
    // otherwise the junction works as an all-way stop.
    const cls: number[] = [];
    let top = -1;
    for (let d = 0; d < 8; d++) {
      const l = n.links[d];
      cls[d] = -1;
      if (!l) continue;
      cls[d] = l.other(n).isTerminal ? 0 : l.priority ? 2 : 1;
      if (cls[d] > top) top = cls[d];
      const ax = d & 3;
      if (!axes.includes(ax)) axes.push(ax);
    }
    let topMask = 0;
    let topCount = 0;
    for (let d = 0; d < 8; d++) {
      if (cls[d] === top) {
        topMask |= 1 << d;
        topCount++;
      }
    }
    const forced = n.priorityAxis;
    if (forced >= 0 && n.links[forced] && n.links[forced + 4]) {
      // the player chose which straight road has priority
      this.majorMask = (1 << forced) | (1 << (forced + 4));
    } else if (topCount <= 2) this.majorMask = topMask;
    else {
      // the road that goes straight on keeps priority (T junctions); two crossing
      // straight roads (or a star) are an all-way stop
      let pairs = 0;
      let pairMask = 0;
      for (let d = 0; d < 4; d++) {
        if (topMask & (1 << d) && topMask & (1 << (d + 4))) {
          pairs++;
          pairMask = (1 << d) | (1 << (d + 4));
        }
      }
      this.majorMask = pairs === 1 ? pairMask : 0;
    }
    this.stopMask = n.armMask() & ~this.majorMask;
    // keep the current phase axis if still present
    const cur = this.phases[this.phase];
    this.phases = axes;
    const idx = axes.indexOf(cur);
    this.phase = idx >= 0 ? idx : 0;
  }

  /** arm must give way to the through road */
  isMinor(arm: number): boolean {
    return this.majorMask !== 0 && (this.majorMask & (1 << arm)) === 0;
  }

  isMajor(arm: number): boolean {
    return (this.majorMask & (1 << arm)) !== 0;
  }

  /** cars entering from this arm must (almost) stop first */
  mustStop(arm: number): boolean {
    if (this.node.control !== 'none') return false;
    return (this.stopMask & (1 << arm)) !== 0;
  }

  green(arm: number): boolean {
    if (!this.isLight) return true;
    return !this.clearing && (arm & 3) === this.phases[this.phase];
  }

  /** light colour shown on an arm (for rendering) */
  lightState(arm: number): LightState {
    if (!this.isLight) return 0;
    if ((arm & 3) !== this.phases[this.phase]) return 2;
    return this.clearing ? 1 : 0;
  }

  conflicts(e1: number, x1: number, e2: number, x2: number): boolean {
    if (e1 === e2) return false;
    if (x1 === x2) return true;
    const key = (e1 * 9 + x1) * 81 + (e2 * 9 + x2);
    let c = this.conflictCache.get(key);
    if (c === undefined) {
      const g1 = moveGeom(this.node, e1, x1);
      const g2 = moveGeom(this.node, e2, x2);
      c = polyMinDist(g1.poly, g1.boxIn, g1.boxOut, g2.poly, g2.boxIn, g2.boxOut) < CAR_WID + 0.05;
      this.conflictCache.set(key, c);
      this.conflictCache.set((e2 * 9 + x2) * 81 + (e1 * 9 + x1), c);
    }
    return c;
  }

  updateLight(dt: number): void {
    if (!this.isLight) return;
    const n = this.phases.length;
    const axisOf = (c: Car) => c.mEntry & 3;
    const cur = this.phases[this.phase];
    let demandCur = false;
    let demandOther = false;
    for (const c of this.requests) {
      if (axisOf(c) === cur) demandCur = true;
      else demandOther = true;
    }
    if (!this.clearing) {
      this.phaseT += dt;
      if (demandOther && (this.phaseT > MAX_GREEN || (this.phaseT > MIN_GREEN && !demandCur))) {
        this.clearing = true;
        this.clearT = 0;
      }
    } else {
      this.clearT += dt;
      if (this.clearT >= CLEAR_MIN && (this.inside.length === 0 || this.clearT > CLEAR_MAX)) {
        for (let k = 1; k <= n; k++) {
          const p = (this.phase + k) % n;
          if (this.requests.some((c) => axisOf(c) === this.phases[p])) {
            this.phase = p;
            break;
          }
        }
        this.clearing = false;
        this.phaseT = 0;
      }
    }
  }
}

const tmpPos: PosOut = { x: 0, y: 0, a: 0 };

/**
 * Car movement, lanes and right-of-way. Every car on the road follows a
 * list of segments; cars sharing a segment key share a physical lane.
 */
export class Traffic {
  readonly net: Network;
  readonly host: TrafficHost;
  readonly cars: Car[] = [];
  private lanes = new Map<number, Car[]>();
  private usedKeys: number[] = [];
  readonly junctions = new Set<Junction>();
  private laneSweep = 0;
  private loadClock = 0;

  constructor(net: Network, host: TrafficHost) {
    this.net = net;
    this.host = host;
  }

  junctionOf(n: RNode | null): Junction | null {
    if (!n) return null;
    const j = n.traffic as Junction | null;
    return j ?? null;
  }

  // ------------------------------------------------------------------
  // Network changes
  // ------------------------------------------------------------------

  /** Must be called after the network changed (dirty nodes). */
  syncNetwork(): void {
    for (const n of this.net.dirty) {
      const j = n.traffic as Junction | null;
      if (!n.alive || !n.isJunction) {
        if (j) {
          for (const c of j.inside) c.ticket = null;
          j.inside.length = 0;
          this.junctions.delete(j);
          n.traffic = null;
        }
        continue;
      }
      if (!j) {
        const nj = new Junction(n);
        n.traffic = nj;
        this.junctions.add(nj);
      } else {
        j.refresh();
      }
    }
    this.net.dirty.clear();
    // iterate over a copy: cancel() removes cars from the list
    for (const c of this.cars.slice()) {
      if (c.state === 'driving') this.reroute(c);
      else if (c.state === 'leaving') this.replanLeaving(c);
      else if (c.state === 'unparking') this.replanUnparking(c);
    }
  }

  /** a car pulling out of a lot: refresh its way home */
  private replanUnparking(c: Car): void {
    const d = c.lot;
    if (!d) return;
    const r = this.route(d.gate, TERM, c.home.node);
    if (!r) {
      this.cancel(c, true);
      return;
    }
    c.segs = this.buildSegs(r, TERM);
    c.i = 0;
    c.s = 0;
  }

  junctionCost = (n: RNode): number => {
    const j = n.traffic as Junction | null;
    let base = 0.35;
    if (n.control === 'roundabout') base = 0.22;
    else if (n.control === 'light') base = 0.3;
    if (!j) return base;
    return base + Math.min(6, j.avgWait * BASE_SPEED * 0.55);
  };

  route(from: RNode, arm: number, to: RNode): Route | null {
    return findRoute(from, arm, to, this.junctionCost);
  }

  // ------------------------------------------------------------------
  // Segments
  // ------------------------------------------------------------------

  private boxSpeed(n: RNode, g: MoveGeom): number {
    const j = n.traffic as Junction | null;
    if (n.control === 'roundabout') return SPEED_BOX_RING;
    if (j && j.isLight) return Math.min(SPEED_BOX_LIGHT, g.speed);
    if (j && j.isMajor(g.entry) && j.isMajor(g.exit)) return Math.min(SPEED_BOX_MAJOR, g.speed);
    return Math.min(SPEED_BOX_DEFAULT, g.speed);
  }

  private pushNodeSegs(out: Seg[], n: RNode, g: MoveGeom): void {
    const entry = g.entry;
    const exit = g.exit;
    const poly = g.poly;
    const base = {
      poly, node: n, link: null, geom: g, fromEnd: false, gate: false, ring: false, motorway: false,
    };
    if (n.isTerminal) {
      if (entry === TERM) {
        out.push({ ...base, kind: SEG_START, key: nodeKey(n, 5, TERM, exit), s0: 0, len: poly.len, vmax: BASE_SPEED * SPEED_TERMINAL });
      } else {
        out.push({
          ...base, kind: SEG_END, key: nodeKey(n, 6, entry, TERM), s0: 0, len: poly.len,
          vmax: BASE_SPEED * SPEED_TERMINAL, gate: n.kind === 'gate',
        });
      }
      return;
    }
    const tIn = armSpeed(n, entry);
    const tOut = armSpeed(n, exit);
    if (n.isJunction && entry !== TERM && exit !== TERM) {
      const a = g.boxIn;
      const b = Math.max(g.boxOut, a + 0.02);
      const side = Math.min(1, g.speed + 0.3);
      out.push({ ...base, kind: SEG_APPROACH, key: nodeKey(n, 2, entry, 15), s0: 0, len: a, vmax: BASE_SPEED * side * tIn });
      out.push({
        ...base, kind: SEG_BOX, key: nodeKey(n, 3, entry, 15), s0: a, len: b - a,
        vmax: BASE_SPEED * this.boxSpeed(n, g) * Math.min(tIn, tOut), ring: g.ring,
      });
      out.push({
        ...base, kind: SEG_DEPART, key: nodeKey(n, 4, 15, exit), s0: b, len: Math.max(0.001, poly.len - b),
        vmax: BASE_SPEED * side * tOut, fromEnd: true,
      });
      return;
    }
    out.push({
      ...base, kind: SEG_MOVE, key: nodeKey(n, 1, entry, exit), s0: 0, len: poly.len,
      vmax: BASE_SPEED * g.speed * Math.min(tIn, tOut),
    });
  }

  private pushLinkSeg(out: Seg[], l: Link, from: RNode): void {
    const poly = linkPoly(l, from);
    const mw = l.kind === 'motorway';
    out.push({
      kind: SEG_LINK, key: linkKey(l, from), poly, s0: 0, len: Math.max(0.001, poly.len),
      vmax: BASE_SPEED * (mw ? SPEED_MOTORWAY : l.tier === 'avenue' ? SPEED_AVENUE : 1), node: l.other(from), link: l, geom: null,
      fromEnd: false, gate: false, ring: false, motorway: mw,
    });
  }

  /** Build segments for a route whose first node is entered through `firstEntry`. */
  buildSegs(route: Route, firstEntry: number, firstGeom: MoveGeom | null = null): Seg[] {
    const out: Seg[] = [];
    const nodes = route.nodes;
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      const entry = k === 0 ? firstEntry : opp(route.links[k - 1].dirFrom(nodes[k - 1]));
      const exit = k === nodes.length - 1 ? TERM : route.links[k].dirFrom(n);
      const g = k === 0 && firstGeom ? firstGeom : moveGeom(n, entry, exit);
      this.pushNodeSegs(out, n, g);
      if (k < nodes.length - 1 && route.links[k].span > 1) this.pushLinkSeg(out, route.links[k], n);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Car lifecycle
  // ------------------------------------------------------------------

  /** Put a car on its way (it waits at home until its lane is clear). */
  dispatch(c: Car, dest: Destination, route: Route): void {
    c.dest = dest;
    c.dispatchedAt = this.host.now();
    c.segs = this.buildSegs(route, TERM);
    c.i = 0;
    c.s = 0;
    c.v = 0;
    c.state = 'leaving';
    c.stuck = 0;
    if (!this.cars.includes(c)) this.cars.push(c);
  }

  private startLaneFree(c: Car): boolean {
    const seg = c.segs[0];
    if (!seg) return false;
    const lane = this.lanes.get(seg.key);
    if (!lane) return true;
    for (const o of lane) if (o !== c && o.coord < SPACING + 0.04) return false;
    return true;
  }

  private replanLeaving(c: Car): void {
    const target = c.dest ? c.dest.gate : c.home.node;
    const from = c.segs[0]?.node ?? c.home.node;
    const r = this.route(from, TERM, target);
    if (r) {
      c.segs = this.buildSegs(r, TERM);
      c.i = 0;
      c.s = 0;
      return;
    }
    // cannot go anymore: back to idle
    this.cancel(c, false);
  }

  /** Remove car from the road and put it back home. */
  cancel(c: Car, poof: boolean): void {
    if (c.ticket) this.releaseTicket(c);
    if (c.slot >= 0) {
      const d = c.lot ?? c.dest;
      if (d && d.slots[c.slot]?.car === c) d.slots[c.slot].car = null;
      c.slot = -1;
    }
    if (c.lot) {
      if (c.state === 'unparking') c.lot.exitBusy = 0;
      if (c.state === 'parking') c.lot.entryBusy = Math.max(0, c.lot.entryBusy - 1);
    }
    if (c.dest) this.host.onAbandon(c, c.dest);
    if (poof) this.host.onPoof(c, c.x, c.y);
    c.dest = null;
    c.lot = null;
    c.state = 'home';
    c.segs = [];
    c.i = 0;
    c.s = 0;
    c.v = 0;
    c.cooldown = 1.5;
    c.reqJ = null;
    c.anim = null;
    c.anim2 = null;
    const idx = this.cars.indexOf(c);
    if (idx >= 0) this.cars.splice(idx, 1);
  }

  private releaseTicket(c: Car): void {
    const j = c.ticket as Junction | null;
    if (j) {
      const k = j.inside.indexOf(c);
      if (k >= 0) j.inside.splice(k, 1);
    }
    c.ticket = null;
  }

  private forceTicket(c: Car, j: Junction, boxIdx: number): void {
    if (c.ticket === j) return;
    if (c.ticket) this.releaseTicket(c);
    c.ticket = j;
    this.setMovement(c, boxIdx);
    if (!j.inside.includes(c)) j.inside.push(c);
  }

  private setMovement(c: Car, boxIdx: number): void {
    const g = c.segs[boxIdx].geom as MoveGeom;
    c.boxIdx = boxIdx;
    c.mEntry = g.entry;
    c.mExit = g.exit;
  }

  /** Recompute a driving car's itinerary after the network changed. */
  private reroute(c: Car): void {
    const seg = c.seg;
    if (!seg) return this.cancel(c, true);
    const target = () => (c.dest ? c.dest.gate : c.home.node);
    const attempt = (fn: () => Seg[] | null): Seg[] | null => {
      let segs = fn();
      if (!segs && c.dest) {
        this.host.onAbandon(c, c.dest);
        c.dest = null;
        segs = fn();
      }
      return segs;
    };

    if (seg.kind === SEG_LINK) {
      const l = seg.link as Link;
      if (!l.alive || !(seg.node as RNode).alive) return this.cancel(c, true);
      const to = seg.node as RNode;
      const arm = l.a === to ? l.dir : opp(l.dir);
      const segs = attempt(() => {
        const r = this.route(to, arm, target());
        return r ? [seg, ...this.buildSegs(r, arm)] : null;
      });
      if (!segs) return this.cancel(c, true);
      this.applySegs(c, segs, 0, c.s);
      return;
    }

    const n = seg.node as RNode;
    const g = seg.geom as MoveGeom;
    if (!n.alive) return this.cancel(c, true);
    const sAbs = seg.s0 + c.s;
    if (g.exit === TERM) {
      // final approach into a house / lot: rebuild this traversal only
      const segs: Seg[] = [];
      this.pushNodeSegs(segs, n, g);
      this.placeInTraversal(c, segs, sAbs);
      return;
    }
    const l = n.links[g.exit];
    if (!l || !l.alive || !l.allows(n)) {
      const noReturn = n.isJunction ? g.boxIn : g.poly.len * 0.4;
      if (sAbs > noReturn + 1e-6) return this.cancel(c, true);
      const segs = attempt(() => {
        const r = this.route(n, g.entry, target());
        return r && r.nodes.length >= 2 ? this.buildSegs(r, g.entry) : null;
      });
      if (!segs) return this.cancel(c, true);
      this.placeInTraversal(c, segs, sAbs);
      return;
    }
    const next = l.other(n);
    const arm = opp(g.exit);
    const segs = attempt(() => {
      const r = this.route(next, arm, target());
      if (!r) return null;
      const out: Seg[] = [];
      this.pushNodeSegs(out, n, g);
      if (l.span > 1) this.pushLinkSeg(out, l, n);
      return out.concat(this.buildSegs(r, arm));
    });
    if (!segs) return this.cancel(c, true);
    this.placeInTraversal(c, segs, sAbs);
  }

  private placeInTraversal(c: Car, segs: Seg[], sAbs: number): void {
    const first = segs[0];
    let i = 0;
    while (
      i + 1 < segs.length &&
      segs[i + 1].node === first.node && segs[i + 1].geom === first.geom && segs[i + 1].kind !== SEG_LINK &&
      sAbs >= segs[i + 1].s0
    ) i++;
    this.applySegs(c, segs, i, clamp(sAbs - segs[i].s0, 0, segs[i].len));
  }

  private applySegs(c: Car, segs: Seg[], i: number, s: number): void {
    c.segs = segs;
    c.i = i;
    c.s = s;
    // ticket consistency
    if (c.ticket) {
      const j = c.ticket as Junction;
      let found = -1;
      for (let k = i; k < segs.length; k++) {
        if (segs[k].kind === SEG_BOX && segs[k].node === j.node) {
          found = k;
          break;
        }
        if (segs[k].kind === SEG_BOX) break;
      }
      if (found < 0 || !j.node.alive || this.junctionOf(j.node) !== j) this.releaseTicket(c);
      else this.setMovement(c, found);
    }
    const cur = segs[i];
    if (cur.kind === SEG_BOX) {
      const j = this.junctionOf(cur.node);
      if (j) this.forceTicket(c, j, i);
    }
    c.reqJ = null;
  }

  // ------------------------------------------------------------------
  // Simulation step
  // ------------------------------------------------------------------

  step(dt: number): void {
    this.buildLanes();
    for (const j of this.junctions) {
      j.requests.length = 0;
      j.approaching.length = 0;
    }
    // leaving houses / lots
    for (const c of this.cars) {
      if (c.state === 'leaving') this.tryEnterRoad(c);
    }
    for (const c of this.cars) if (c.state === 'driving') this.scan(c);
    for (const j of this.junctions) this.updateJunction(j, dt);
    // move (iterate over a copy: arrivals mutate the list)
    const list = this.cars.slice();
    for (const c of list) {
      if (c.state === 'driving') this.move(c, dt);
      else if (c.state === 'parking' || c.state === 'parked' || c.state === 'unparking') this.lotStep(c, dt);
      if (c.fade < 1) c.fade = Math.min(1, c.fade + dt * 5);
    }
    for (const j of this.junctions) j.avgWait *= Math.exp(-dt / 40);
    this.loadClock -= dt;
    if (this.loadClock <= 0) {
      this.loadClock = 0.25;
      this.updateLoads();
    }
    if (++this.laneSweep > 600) {
      this.laneSweep = 0;
      // drop empty lanes occasionally to bound memory
      for (const [k, v] of this.lanes) if (v.length === 0) this.lanes.delete(k);
    }
  }

  /** per-node congestion estimate: how much slower than free flow cars move there */
  private updateLoads(): void {
    const sum = new Map<RNode, number>();
    const cnt = new Map<RNode, number>();
    const free = BASE_SPEED * 0.7;
    for (const c of this.cars) {
      if (c.state !== 'driving') continue;
      const seg = c.segs[c.i];
      const n = seg.node;
      if (!n || n.isTerminal) continue;
      const slow = 1 - Math.min(1, c.v / Math.min(free, seg.vmax * 0.9));
      sum.set(n, (sum.get(n) ?? 0) + slow);
      cnt.set(n, (cnt.get(n) ?? 0) + 1);
    }
    for (const n of this.net.nodes.values()) {
      if (n.isTerminal) continue;
      const k = cnt.get(n);
      if (k) {
        // more cars queued in a tile = heavier jam
        const v = Math.min(1, ((sum.get(n) as number) / k) * (0.75 + 0.25 * Math.min(k, 3)));
        n.load += (v - n.load) * 0.35;
      } else {
        n.load *= 0.8;
      }
    }
  }

  private buildLanes(): void {
    for (const k of this.usedKeys) {
      const l = this.lanes.get(k);
      if (l) l.length = 0;
    }
    this.usedKeys.length = 0;
    for (const c of this.cars) {
      if (c.state !== 'driving') continue;
      const seg = c.segs[c.i];
      c.coord = seg.fromEnd ? c.s - seg.len : c.s;
      let lane = this.lanes.get(seg.key);
      if (!lane) {
        lane = [];
        this.lanes.set(seg.key, lane);
      }
      if (lane.length === 0) this.usedKeys.push(seg.key);
      lane.push(c);
    }
    for (const k of this.usedKeys) {
      const lane = this.lanes.get(k) as Car[];
      if (lane.length > 1) lane.sort((a, b) => a.coord - b.coord);
      for (let i = 0; i < lane.length; i++) lane[i].laneIdx = i;
    }
  }

  private tryEnterRoad(c: Car): void {
    if (c.cooldown > 0) return;
    if (!this.startLaneFree(c)) return;
    c.state = 'driving';
    c.i = 0;
    c.s = 0;
    c.v = 0.25;
    c.fade = 0;
    c.stuck = 0;
    this.updatePos(c);
    // register immediately so following cars see it this tick
    const seg = c.segs[0];
    let lane = this.lanes.get(seg.key);
    if (!lane) {
      lane = [];
      this.lanes.set(seg.key, lane);
    }
    if (lane.length === 0) this.usedKeys.push(seg.key);
    c.coord = 0;
    lane.unshift(c);
    for (let i = 0; i < lane.length; i++) lane[i].laneIdx = i;
  }

  private posFromStart(o: Car, sj: Seg): number {
    return sj.fromEnd ? sj.len + o.coord : o.coord;
  }

  /** Look ahead: leader, stop lines, speed profile, right-of-way requests. */
  private scan(c: Car): void {
    const segs = c.segs;
    const seg = segs[c.i];
    const speedMul = c.speedMul;
    let vt = seg.vmax;
    let leader: Car | null = null;
    let leaderDist = Infinity;
    const lane = this.lanes.get(seg.key) as Car[];
    if (c.laneIdx + 1 < lane.length) {
      leader = lane[c.laneIdx + 1];
      leaderDist = leader.coord - c.coord;
    }
    let ringGap = Infinity;
    if (seg.ring && seg.kind === SEG_BOX) ringGap = this.ringGap(c, seg);

    let dist = seg.len - c.s;
    let stopDist = Infinity;
    let stopJ: Junction | null = null;
    let stopBox = -1;
    let stopGate: Destination | null = null;
    for (let j = c.i + 1; j < segs.length && dist < LOOKAHEAD; j++) {
      const sj = segs[j];
      if (dist < leaderDist) vt = Math.min(vt, Math.sqrt(sj.vmax * sj.vmax + 2 * DECEL * Math.max(0, dist - 0.04)));
      if (sj.kind === SEG_BOX) {
        const J = this.junctionOf(sj.node);
        if (J && c.ticket !== J) {
          stopDist = dist;
          stopJ = J;
          stopBox = j;
          break;
        }
      } else if (sj.gate && c.slot < 0) {
        stopDist = dist;
        stopGate = this.host.destOfGate(sj.node as RNode) ?? null;
        break;
      }
      if (!leader) {
        const lj = this.lanes.get(sj.key);
        if (lj && lj.length > 0) {
          leader = lj[0];
          leaderDist = dist + this.posFromStart(leader, sj);
        }
      }
      dist += sj.len;
    }
    // ring roundabout gating for cars merging from their approach:
    // (handled by the junction grant)

    let gap = Math.min(leaderDist - SPACING, stopDist - CAR_LEN / 2 - 0.01, ringGap);
    c.limit = gap === Infinity ? 0 : leaderDist - SPACING <= gap + 1e-9 ? 1 : stopGate && stopDist - CAR_LEN / 2 - 0.01 <= gap + 1e-9 ? 3 : 2;
    const firstInLine = !leader || leaderDist > stopDist;
    let requested = false;
    if (stopJ && c.ticket === null && stopDist <= PRIORITY_WATCH) {
      this.setMovement(c, stopBox);
      stopJ.approaching.push(c);
    }
    if (stopJ && c.ticket === null) {
      const entry = (segs[stopBox].geom as MoveGeom).entry;
      const platoon = !firstInLine && leader !== null && leader.ticket === stopJ && leader.mEntry === entry;
      // on a green light cars ask early so they keep their speed (on plain
      // junctions this would starve the yielding side streets)
      const flows = stopJ.isLight && stopJ.green(entry);
      const reach = REQ_DIST + (flows ? FLOW_EXTRA : 0);
      if ((firstInLine && stopDist <= reach) || (platoon && stopDist <= REQ_DIST + PLATOON_EXTRA)) {
        if (c.reqJ !== stopJ) {
          c.reqJ = stopJ;
          c.reqTime = this.host.now();
        }
        this.setMovement(c, stopBox);
        stopJ.requests.push(c);
        requested = true;
      }
    } else if (stopGate && firstInLine && stopDist <= REQ_DIST) {
      // reserve a parking slot
      const slot = stopGate.entryBusy <= 1 ? stopGate.freeSlot() : -1;
      if (slot >= 0) {
        stopGate.slots[slot].car = c;
        c.slot = slot;
        gap = Math.min(leaderDist - SPACING, ringGap);
      }
    }
    if (!requested) c.reqJ = null;
    if (gap < 0) gap = 0;
    vt = Math.min(vt, Math.sqrt(2 * DECEL * gap)) * speedMul;
    c.gap = gap;
    c.vt = vt;
  }

  /** ring angle and remaining arc (radians) of a car in / entering a roundabout */
  private ringState(o: Car, jn: RNode): [number, number] | null {
    if (o.boxIdx < 0 || o.boxIdx >= o.segs.length) return null;
    const bs = o.segs[o.boxIdx];
    if (bs.node !== jn || !bs.geom) return null;
    const g = bs.geom;
    const arc = (g.ringOut - g.ringIn) / RING_R;
    if (o.i < o.boxIdx) return [g.thetaIn, arc];
    if (o.i > o.boxIdx) return [g.thetaIn - arc, 0];
    const sAbs = bs.s0 + o.s;
    if (sAbs <= g.ringIn) return [g.thetaIn, arc];
    if (sAbs >= g.ringOut) return [g.thetaIn - arc, 0];
    const t = (sAbs - g.ringIn) / RING_R;
    return [g.thetaIn - t, arc - t];
  }

  private ringGap(c: Car, seg: Seg): number {
    const g = seg.geom as MoveGeom;
    const sAbs = seg.s0 + c.s;
    if (sAbs > g.ringOut) return Infinity;
    const j = this.junctionOf(seg.node);
    if (!j) return Infinity;
    const myTheta = sAbs <= g.ringIn ? g.thetaIn : g.thetaIn - (sAbs - g.ringIn) / RING_R;
    const extra = sAbs < g.ringIn ? g.ringIn - sAbs : 0;
    let best = Infinity;
    for (const o of j.inside) {
      if (o === c || o.i !== o.boxIdx) continue;
      const st = this.ringState(o, j.node);
      if (!st) continue;
      const os = o.segs[o.boxIdx];
      const og = os.geom as MoveGeom;
      const oAbs = os.s0 + o.s;
      if (oAbs < og.ringIn - 0.1) continue; // still far on its approach
      if (oAbs > og.ringOut + 0.12) continue; // already leaving
      if (o.mEntry === c.mEntry && oAbs < og.ringIn && sAbs < g.ringIn) continue; // same lane, handled by lane
      const ahead = mod(myTheta - st[0], TAU);
      if (ahead > 0.02 && ahead < 1.7) {
        const d = ahead * RING_R + extra - SPACING;
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** path distance from a car to the start of one of its segments */
  private distToSeg(c: Car, idx: number): number {
    if (idx <= c.i) return 0;
    let d = c.segs[c.i].len - c.s;
    for (let k = c.i + 1; k < idx; k++) d += c.segs[k].len;
    return d;
  }

  /** time-based gap acceptance for merging onto a roundabout */
  private canEnterRing(j: Junction, c: Car): boolean {
    if (j.inside.length >= RING_CAP) return false;
    const gc = c.segs[c.boxIdx].geom as MoveGeom;
    const thIn = gc.thetaIn;
    const V = BASE_SPEED * SPEED_BOX_RING;
    const tc = (this.distToSeg(c, c.boxIdx) + Math.max(0, gc.ringIn - gc.boxIn)) / V;
    for (const o of j.inside) {
      if (o === c) continue;
      const st = this.ringState(o, j.node);
      if (!st) continue;
      const [th, remaining] = st;
      if (o.mEntry === c.mEntry && o.i < o.boxIdx) continue; // ahead of us in our own lane
      const down = mod(thIn - th, TAU);
      if (down < 0.62 && !(remaining <= 0 && down > 0.3)) return false; // right where we merge
      const up = mod(th - thIn, TAU);
      if (remaining < up - 0.05) continue; // leaves the ring before reaching us
      const os = o.segs[o.boxIdx];
      const og = os.geom as MoveGeom;
      let pre = 0;
      if (o.i < o.boxIdx) pre = this.distToSeg(o, o.boxIdx) + Math.max(0, og.ringIn - og.boxIn);
      else {
        const sAbs = os.s0 + o.s;
        if (sAbs < og.ringIn) pre = og.ringIn - sAbs;
      }
      const to = (pre + up * RING_R) / V;
      if (to > tc - 0.4 && to < tc + 0.62) return false;
    }
    return true;
  }

  /** free room (for the car's centre) right after its box at junction j */
  private exitRoom(c: Car, j: Junction): boolean {
    const segs = c.segs;
    let dist = 0;
    let room = Infinity;
    for (let k = c.boxIdx + 1; k < segs.length; k++) {
      const sk = segs[k];
      if (sk.kind === SEG_BOX && sk.node !== j.node) {
        room = dist - CAR_LEN / 2 - 0.01;
        break;
      }
      if (sk.gate) {
        // the lot entrance: we need a slot there too, count it as a stop line
        room = dist - CAR_LEN / 2 - 0.01;
        const d = this.host.destOfGate(sk.node as RNode);
        if (d && d.freeSlot() >= 0) room = Math.max(room, dist + 0.5);
        break;
      }
      const lane = this.lanes.get(sk.key);
      if (lane && lane.length > 0) {
        room = dist + this.posFromStart(lane[0], sk) - SPACING;
        break;
      }
      dist += sk.len;
      if (dist > 3) break;
    }
    let reserved = 0;
    for (const o of j.inside) if (o !== c && o.mExit === c.mExit) reserved++;
    return room - reserved * SPACING >= CAR_LEN / 2 + 0.02;
  }

  private updateJunction(j: Junction, dt: number): void {
    j.refresh();
    j.updateLight(dt);
    let q = 0;
    for (const a of j.approaching) if (a.v < 0.35) q++;
    j.queue += (q - j.queue) * Math.min(1, dt * 0.35);
    j.flow *= Math.exp(-dt / 20);
    const reqs = j.requests;
    if (reqs.length === 0) return;
    const now = this.host.now();
    const rank = (c: Car) => (j.isMinor(c.mEntry) && now - c.reqTime < MINOR_PATIENCE ? 1 : 0);
    if (reqs.length > 1) reqs.sort((a, b) => rank(a) - rank(b) || a.reqTime - b.reqTime);
    const blocked: Car[] = [];
    for (const c of reqs) {
      if (c.ticket) continue;
      if (!j.green(c.mEntry)) continue;
      // stop sign behaviour: come (almost) to a halt before entering
      if (j.mustStop(c.mEntry) && c.v > STOP_SPEED) continue;
      // a car with nowhere to go must not hold back the others (prevents gridlock)
      if (!this.exitRoom(c, j)) continue;
      if (j.isRing) {
        if (this.canEnterRing(j, c)) this.grant(j, c);
        continue;
      }
      let ok = true;
      for (const o of j.inside) {
        if (j.conflicts(c.mEntry, c.mExit, o.mEntry, o.mExit)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const minor = rank(c) === 1;
        for (const b of blocked) {
          if ((rank(b) === 0 || minor) && j.conflicts(c.mEntry, c.mExit, b.mEntry, b.mExit)) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) {
        blocked.push(c);
        continue;
      }
      // yielding cars wait for a gap in the priority stream
      if (rank(c) === 1) {
        let gapOk = true;
        for (const a of j.approaching) {
          if (a === c || a.ticket === j || j.isMinor(a.mEntry)) continue;
          if (j.conflicts(c.mEntry, c.mExit, a.mEntry, a.mExit)) {
            gapOk = false;
            break;
          }
        }
        if (!gapOk) continue;
      }
      this.grant(j, c);
    }
  }

  private grant(j: Junction, c: Car): void {
    c.ticket = j;
    j.inside.push(c);
    j.avgWait += (c.waitAt - j.avgWait) * 0.15;
    j.flow += 1 / 20;
  }

  private move(c: Car, dt: number): void {
    const target = c.vt;
    if (c.v < target) c.v = Math.min(target, c.v + ACCEL * dt);
    else c.v = Math.max(target, c.v - DECEL * 2 * dt);
    let adv = c.v * dt;
    if (adv > c.gap) adv = c.gap;
    if (adv < 0) adv = 0;
    // time spent crawling or stopped is charged to the next junction crossed
    if (c.v < 0.35) c.waitAt += dt;
    if (adv < 1e-4) {
      c.stuck += dt;
      c.brake = Math.min(1, c.brake + dt * 6);
    } else {
      c.stuck = 0;
      c.brake = Math.max(0, c.brake - dt * 4);
    }
    if (c.stuck > STUCK_TIMEOUT) {
      this.cancel(c, true);
      return;
    }
    c.s += adv;
    let seg = c.segs[c.i];
    while (c.s >= seg.len) {
      if (c.i === c.segs.length - 1) {
        this.arrive(c);
        return;
      }
      c.s -= seg.len;
      if (seg.kind === SEG_BOX) {
        this.releaseTicket(c);
        c.waitAt = 0;
      }
      c.i++;
      seg = c.segs[c.i];
      if (seg.kind === SEG_BOX) {
        const j = this.junctionOf(seg.node);
        if (j && c.ticket !== j) this.forceTicket(c, j, c.i);
        c.reqJ = null;
      } else if (seg.gate && c.slot < 0) {
        // should not happen (stop line), but keep things consistent
        const d = this.host.destOfGate(seg.node as RNode);
        const slot = d ? d.freeSlot() : -1;
        if (d && slot >= 0) {
          d.slots[slot].car = c;
          c.slot = slot;
        }
      }
    }
    this.updatePos(c);
  }

  updatePos(c: Car): void {
    const seg = c.segs[c.i];
    if (!seg) return;
    polyAt(seg.poly, seg.s0 + c.s, tmpPos);
    c.x = tmpPos.x;
    c.y = tmpPos.y;
    c.a = tmpPos.a;
  }

  private arrive(c: Car): void {
    const seg = c.segs[c.i];
    const n = seg.node as RNode;
    if (c.ticket) this.releaseTicket(c);
    if (n.kind === 'gate' && c.dest) {
      const d = c.dest;
      if (c.slot < 0) {
        const slot = d.freeSlot();
        if (slot < 0) {
          // nowhere to park: count the delivery anyway and head back
          this.startParking(c, d, -1);
          return;
        }
        d.slots[slot].car = c;
        c.slot = slot;
      }
      this.startParking(c, d, c.slot);
      return;
    }
    if (n.kind === 'house') {
      c.state = 'home';
      c.segs = [];
      c.dest = null;
      c.lot = null;
      c.cooldown = 0.8;
      const idx = this.cars.indexOf(c);
      if (idx >= 0) this.cars.splice(idx, 1);
      this.host.onArriveHome(c);
      return;
    }
    // arrived somewhere unexpected (e.g. gate after its pin was dropped)
    this.cancel(c, true);
  }

  // ------------------------------------------------------------------
  // Parking lots
  // ------------------------------------------------------------------

  private startParking(c: Car, d: Destination, slot: number): void {
    c.lot = d;
    c.state = 'parking';
    c.animT = 0;
    const sl = slot >= 0 ? d.slots[slot] : null;
    const f = d.frame();
    const ix = -f.ox;
    const iy = -f.oy; // inward
    const pts: number[] = [];
    if (sl) {
      sampleCubic(pts, c.x, c.y, c.x + ix * 0.16, c.y + iy * 0.16, sl.x - ix * 0.2, sl.y - iy * 0.2, sl.x, sl.y, 10);
    } else {
      pts.push(c.x, c.y, c.x + ix * 0.1, c.y + iy * 0.1);
    }
    c.anim = polyFromPoints(pts);
    c.animDur = 0.18 + c.anim.len / 1.2;
    d.entryBusy++;
    c.v = 0;
  }

  private lotStep(c: Car, dt: number): void {
    const d = c.lot as Destination;
    if (c.state === 'parking') {
      c.animT += dt;
      const t = Math.min(1, c.animT / c.animDur);
      const e = t * t * (3 - 2 * t);
      polyAt(c.anim as Poly, e * (c.anim as Poly).len, tmpPos);
      c.x = tmpPos.x;
      c.y = tmpPos.y;
      c.a = tmpPos.a;
      if (t >= 1) {
        d.entryBusy = Math.max(0, d.entryBusy - 1);
        c.state = 'parked';
        c.parkT = PARK_TIME;
        const dest = c.dest;
        c.dest = null;
        if (dest) this.host.onDeliver(c, dest);
      }
      return;
    }
    if (c.state === 'parked') {
      c.parkT -= dt;
      if (c.parkT > 0) return;
      if (d.exitBusy > 0) return;
      const r = this.route(d.gate, TERM, c.home.node);
      if (!r) {
        if (c.parkT < -3) this.cancel(c, true);
        return;
      }
      const segs = this.buildSegs(r, TERM);
      const lane = this.lanes.get(segs[0].key);
      if (lane) for (const o of lane) if (o.coord < SPACING + 0.08) return;
      c.segs = segs;
      c.i = 0;
      c.s = 0;
      // animation: reverse out of the slot, then drive to the lane start
      const f = d.frame();
      const p0 = polyAt(segs[0].poly, 0, { x: 0, y: 0, a: 0 });
      const bx = c.x + f.ox * 0.24;
      const by = c.y + f.oy * 0.24;
      c.anim = polyFromPoints([c.x, c.y, bx, by]);
      const pts: number[] = [];
      const hx = Math.cos(p0.a);
      const hy = Math.sin(p0.a);
      sampleCubic(pts, bx, by, bx + (p0.x - bx) * 0.35, by + (p0.y - by) * 0.35, p0.x - hx * 0.18, p0.y - hy * 0.18, p0.x, p0.y, 10);
      c.anim2 = polyFromPoints(pts);
      c.animT = 0;
      c.animDur = 0.6;
      c.state = 'unparking';
      d.exitBusy = 1;
      return;
    }
    if (c.state === 'unparking') {
      c.animT += dt;
      const t1 = 0.22;
      if (c.animT < t1) {
        const t = c.animT / t1;
        const p = c.anim as Poly;
        polyAt(p, t * t * (3 - 2 * t) * p.len, tmpPos);
        c.x = tmpPos.x;
        c.y = tmpPos.y; // keep heading (reversing)
      } else {
        const t = Math.min(1, (c.animT - t1) / (c.animDur - t1));
        const p = c.anim2 as Poly;
        polyAt(p, t * p.len, tmpPos);
        c.x = tmpPos.x;
        c.y = tmpPos.y;
        let da = tmpPos.a - c.a;
        da = mod(da + Math.PI, TAU) - Math.PI;
        c.a += da * Math.min(1, dt * 14);
        if (t >= 1) {
          if (c.slot >= 0 && d.slots[c.slot].car === c) d.slots[c.slot].car = null;
          c.slot = -1;
          d.exitBusy = 0;
          c.lot = null;
          c.state = 'driving';
          c.i = 0;
          c.s = 0;
          c.v = 0.4;
          c.stuck = 0;
          this.updatePos(c);
        }
      }
    }
  }

}
