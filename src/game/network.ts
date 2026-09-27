import { DX, DY, opp, isDiag, BOUND, MAX_BRIDGE_SPAN, MAX_MOTORWAY_SPAN, MIN_MOTORWAY_SPAN } from './constants';
import type { World } from './world';

export type NodeKind = 'road' | 'house' | 'gate';

/** junction rules */
export const RULE_AUTO = 0;
export const RULE_AXIS = 1; // 1..4: priority along axis d & 3
export const RULE_NOLEFT = 5;
export type Control = 'none' | 'light' | 'roundabout';
export type LinkKind = 'road' | 'bridge' | 'motorway';

let nextNodeId = 1;
let nextLinkId = 1;

export class RNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly tile: number;
  readonly kind: NodeKind;
  readonly links: (Link | null)[] = [null, null, null, null, null, null, null, null];
  control: Control = 'none';
  /** owning building id for house/gate nodes */
  ownerId = -1;
  /** for gates: the only allowed direction */
  fixedDir = -1;
  degree = 0;
  /**
   * junction rule set by the player: RULE_AUTO, a priority axis
   * (RULE_AXIS + d&3: the straight road along that axis has priority) or RULE_NOLEFT
   */
  rule = RULE_AUTO;
  /** smoothed congestion 0 (free flow) .. 1 (jammed), for the traffic view */
  load = 0;
  /** bumped whenever links/control change (geometry caches key on it) */
  version = 0;
  alive = true;
  /** time of creation (for pop-in animation) */
  born = 0;
  /** opaque per-node data owned by the traffic layer */
  traffic: unknown = null;
  /** opaque geometry cache owned by the geometry layer */
  geo: unknown = null;

  constructor(x: number, y: number, tile: number, kind: NodeKind) {
    this.id = nextNodeId++;
    this.x = x;
    this.y = y;
    this.tile = tile;
    this.kind = kind;
  }

  get cx(): number {
    return this.x + 0.5;
  }

  get cy(): number {
    return this.y + 0.5;
  }

  get isTerminal(): boolean {
    return this.kind !== 'road';
  }

  /** left turns and U-turns are forbidden here */
  get noLeft(): boolean {
    return this.rule === RULE_NOLEFT;
  }

  /** axis (0..3) given priority by the player, or -1 */
  get priorityAxis(): number {
    return this.rule >= RULE_AXIS && this.rule < RULE_AXIS + 4 ? this.rule - RULE_AXIS : -1;
  }

  /** junction = needs right-of-way management */
  get isJunction(): boolean {
    return this.kind === 'road' && (this.degree >= 3 || (this.control === 'roundabout' && this.degree >= 1));
  }

  armMask(): number {
    let m = 0;
    for (let d = 0; d < 8; d++) if (this.links[d]) m |= 1 << d;
    return m;
  }
}

export class Link {
  readonly id: number;
  readonly a: RNode;
  readonly b: RNode;
  /** direction from a to b */
  readonly dir: number;
  readonly kind: LinkKind;
  /** number of tile steps between a and b (1 = adjacent) */
  readonly span: number;
  /** tiles passed over (excluding endpoints) */
  readonly over: number[];
  /** corner keys crossed (for diagonal links) */
  readonly corners: number[];
  /** lane length between the two boundary points (0 for adjacent tiles) */
  readonly laneLen: number;
  alive = true;
  born = 0;
  /** road class: avenues are faster and have priority at junctions */
  tier: RoadTier = 'street';
  /** 0 = two-way, 1 = only a -> b, -1 = only b -> a */
  oneway: 0 | 1 | -1 = 0;

  constructor(a: RNode, b: RNode, dir: number, kind: LinkKind, span: number, over: number[], corners: number[]) {
    this.id = nextLinkId++;
    this.a = a;
    this.b = b;
    this.dir = dir;
    this.kind = kind;
    this.span = span;
    this.over = over;
    this.corners = corners;
    const stepLen = isDiag(dir) ? Math.SQRT2 : 1;
    this.laneLen = Math.max(0, span * stepLen - 2 * BOUND[dir]);
  }

  other(n: RNode): RNode {
    return n === this.a ? this.b : this.a;
  }

  dirFrom(n: RNode): number {
    return n === this.a ? this.dir : opp(this.dir);
  }

  /** may a car travel along this link starting from `from`? */
  allows(from: RNode): boolean {
    return this.oneway === 0 || (this.oneway === 1 ? from === this.a : from === this.b);
  }

  /** priority roads (avenues, motorways) win at junctions */
  get priority(): boolean {
    return this.tier === 'avenue' || this.kind === 'motorway';
  }

  /** extra road units paid for this link (avenues cost double) */
  get extraCost(): number {
    return this.tier === 'avenue' && this.kind !== 'motorway' ? 1 : 0;
  }
}

export type RoadTier = 'street' | 'avenue';

export type LinkFail =
  | 'ok'
  | 'occupied'
  | 'cross'
  | 'terminal'
  | 'direction'
  | 'bounds'
  | 'water'
  | 'span'
  | 'same';

export interface BridgePlan {
  from: RNode;
  dir: number;
  /** destination tile */
  bx: number;
  by: number;
  over: number[];
  corners: number[];
  span: number;
}

export interface MotorwayPlan {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  dir: number;
  span: number;
  over: number[];
  corners: number[];
}

export interface NetworkListener {
  (kind: 'node' | 'link' | 'control', item: RNode | Link, added: boolean): void;
}

/**
 * Road graph: nodes live on tiles, links join two nodes along one of the
 * 8 directions (adjacent tiles for roads, straight lines for bridges & motorways).
 */
export class Network {
  readonly world: World;
  readonly nodes = new Map<number, RNode>();
  readonly links = new Set<Link>();
  version = 0;
  /** ground-level diagonal corner usage */
  private corners = new Map<number, Link>();
  private mwCorners = new Map<number, Link>();
  /** water tile -> bridge crossing it */
  readonly bridgeOver = new Map<number, Link>();
  /** tile -> motorway flying over it */
  readonly mwOver = new Map<number, Link>();
  /** nodes whose geometry changed since the traffic layer last looked */
  readonly dirty = new Set<RNode>();
  /** tiles reserved by buildings (houses & destination footprints) */
  readonly reserved = new Map<number, number>();
  listener: NetworkListener | null = null;
  now = 0;

  constructor(world: World) {
    this.world = world;
  }

  nodeAt(x: number, y: number): RNode | undefined {
    if (!this.world.inMap(x, y)) return undefined;
    return this.nodes.get(this.world.idx(x, y));
  }

  cornerKey(x: number, y: number, d: number): number {
    // corner between tile (x,y) and (x+DX, y+DY)
    const cx = x + (DX[d] > 0 ? 1 : 0);
    const cy = y + (DY[d] > 0 ? 1 : 0);
    return cy * (this.world.w + 1) + cx;
  }

  /** Is the corner crossed by a diagonal step from (x,y) in direction d free at ground level? */
  cornerFree(x: number, y: number, d: number): boolean {
    return !this.corners.has(this.cornerKey(x, y, d));
  }

  /** Can a plain road tile be placed here? */
  canPlaceRoad(x: number, y: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, y) || !w.isLand(x, y)) return false;
    const i = w.idx(x, y);
    return !this.nodes.has(i) && !this.reserved.has(i);
  }

  addRoad(x: number, y: number): RNode | null {
    if (!this.canPlaceRoad(x, y)) return null;
    const i = this.world.idx(x, y);
    const n = new RNode(x, y, i, 'road');
    n.born = this.now;
    this.nodes.set(i, n);
    this.world.trees[i] = 0;
    this.touch(n);
    this.listener?.('node', n, true);
    return n;
  }

  addTerminal(x: number, y: number, kind: 'house' | 'gate', ownerId: number, fixedDir = -1): RNode {
    const i = this.world.idx(x, y);
    const n = new RNode(x, y, i, kind);
    n.ownerId = ownerId;
    n.fixedDir = fixedDir;
    n.born = this.now;
    this.nodes.set(i, n);
    this.world.trees[i] = 0;
    this.touch(n);
    return n;
  }

  /** Remove a node and every link attached to it. Returns the removed links. */
  removeNode(n: RNode): Link[] {
    const removed: Link[] = [];
    for (let d = 0; d < 8; d++) {
      const l = n.links[d];
      if (l) {
        this.unlink(l);
        removed.push(l);
      }
    }
    this.nodes.delete(n.tile);
    n.alive = false;
    this.version++;
    this.listener?.('node', n, false);
    return removed;
  }

  setControl(n: RNode, c: Control): void {
    if (n.control === c) return;
    n.control = c;
    this.touch(n);
    this.listener?.('control', n, c !== 'none');
  }

  setRule(n: RNode, rule: number): void {
    if (n.rule === rule) return;
    n.rule = rule;
    this.touch(n);
  }

  /** straight axes (0..3) available for a priority rule at this node */
  priorityAxes(n: RNode): number[] {
    const out: number[] = [];
    for (let a = 0; a < 4; a++) {
      const l1 = n.links[a];
      const l2 = n.links[a + 4];
      if (l1 && l2 && !l1.other(n).isTerminal && !l2.other(n).isTerminal) out.push(a);
    }
    return out;
  }

  /** Change the class / direction of an existing link. */
  setLinkStyle(l: Link, tier: RoadTier, oneway: 0 | 1 | -1): void {
    if (l.tier === tier && l.oneway === oneway) return;
    l.tier = tier;
    l.oneway = oneway;
    this.touch(l.a);
    this.touch(l.b);
  }

  private touch(n: RNode): void {
    n.version++;
    this.dirty.add(n);
    this.version++;
  }

  private recount(n: RNode): void {
    let d = 0;
    for (const l of n.links) if (l) d++;
    n.degree = d;
  }

  /** Validate a link between two adjacent nodes. */
  checkRoadLink(a: RNode, b: RNode, dir: number): LinkFail {
    if (a === b) return 'same';
    if (DX[dir] !== b.x - a.x || DY[dir] !== b.y - a.y) return 'direction';
    if (a.links[dir] && a.links[dir] === b.links[opp(dir)]) return 'same';
    if (a.isTerminal && b.isTerminal) return 'terminal';
    for (const [n, d] of [[a, dir], [b, opp(dir)]] as [RNode, number][]) {
      if (n.isTerminal) {
        if (isDiag(d)) return 'direction';
        if (n.fixedDir >= 0 && n.fixedDir !== d) return 'direction';
        if (n.degree > 0) return 'occupied';
      }
      if (n.links[d]) return 'occupied';
    }
    if (isDiag(dir)) {
      const k = this.cornerKey(a.x, a.y, dir);
      if (this.corners.has(k)) return 'cross';
    }
    return 'ok';
  }

  linkRoad(a: RNode, b: RNode, dir: number): Link | null {
    if (this.checkRoadLink(a, b, dir) !== 'ok') return null;
    const corners = isDiag(dir) ? [this.cornerKey(a.x, a.y, dir)] : [];
    return this.attach(new Link(a, b, dir, 'road', 1, [], corners));
  }

  private attach(l: Link): Link {
    l.born = this.now;
    l.a.links[l.dir] = l;
    l.b.links[opp(l.dir)] = l;
    const cornerMap = l.kind === 'motorway' ? this.mwCorners : this.corners;
    for (const c of l.corners) cornerMap.set(c, l);
    const overMap = l.kind === 'motorway' ? this.mwOver : l.kind === 'bridge' ? this.bridgeOver : null;
    if (overMap) for (const t of l.over) overMap.set(t, l);
    this.links.add(l);
    this.recount(l.a);
    this.recount(l.b);
    this.touch(l.a);
    this.touch(l.b);
    this.listener?.('link', l, true);
    return l;
  }

  unlink(l: Link): void {
    if (!l.alive) return;
    l.alive = false;
    if (l.a.links[l.dir] === l) l.a.links[l.dir] = null;
    if (l.b.links[opp(l.dir)] === l) l.b.links[opp(l.dir)] = null;
    const cornerMap = l.kind === 'motorway' ? this.mwCorners : this.corners;
    for (const c of l.corners) if (cornerMap.get(c) === l) cornerMap.delete(c);
    const overMap = l.kind === 'motorway' ? this.mwOver : l.kind === 'bridge' ? this.bridgeOver : null;
    if (overMap) for (const t of l.over) if (overMap.get(t) === l) overMap.delete(t);
    this.links.delete(l);
    this.recount(l.a);
    this.recount(l.b);
    this.touch(l.a);
    this.touch(l.b);
    this.listener?.('link', l, false);
  }

  /**
   * Plan a bridge starting at road node `from` going in `dir` over water.
   * Returns null (with reason) if impossible.
   */
  planBridge(from: RNode, dir: number): BridgePlan | LinkFail {
    const w = this.world;
    if (from.kind !== 'road') return 'terminal';
    if (from.links[dir]) return 'occupied';
    const over: number[] = [];
    const corners: number[] = [];
    let x = from.x;
    let y = from.y;
    for (let step = 1; step <= MAX_BRIDGE_SPAN + 1; step++) {
      if (isDiag(dir)) {
        const k = this.cornerKey(x, y, dir);
        if (this.corners.has(k)) return 'cross';
        corners.push(k);
      }
      x += DX[dir];
      y += DY[dir];
      if (!w.inBounds(x, y)) return 'bounds';
      const i = w.idx(x, y);
      if (w.isWater(x, y)) {
        if (this.bridgeOver.has(i)) return 'cross';
        over.push(i);
        continue;
      }
      // land reached
      if (over.length === 0) return 'water';
      if (this.reserved.has(i)) return 'occupied';
      const n = this.nodes.get(i);
      if (n) {
        if (n.kind !== 'road') return 'terminal';
        if (n.links[opp(dir)]) return 'occupied';
      }
      return { from, dir, bx: x, by: y, over, corners, span: step };
    }
    return 'span';
  }

  buildBridge(plan: BridgePlan, to: RNode): Link | null {
    if (to.links[opp(plan.dir)] || plan.from.links[plan.dir]) return null;
    return this.attach(new Link(plan.from, to, plan.dir, 'bridge', plan.span, plan.over, plan.corners));
  }

  /** Plan a motorway between two tiles (endpoints may be empty land). */
  planMotorway(ax: number, ay: number, bx: number, by: number): MotorwayPlan | LinkFail {
    const w = this.world;
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) return 'same';
    if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) return 'direction';
    const span = Math.max(Math.abs(dx), Math.abs(dy));
    if (span < MIN_MOTORWAY_SPAN || span > MAX_MOTORWAY_SPAN) return 'span';
    let dir = -1;
    for (let d = 0; d < 8; d++) if (DX[d] === Math.sign(dx) && DY[d] === Math.sign(dy)) dir = d;
    for (const [x, y, d] of [[ax, ay, dir], [bx, by, opp(dir)]] as [number, number, number][]) {
      if (!w.inBounds(x, y)) return 'bounds';
      if (!w.isLand(x, y)) return 'water';
      const i = w.idx(x, y);
      if (this.reserved.has(i)) return 'occupied';
      const n = this.nodes.get(i);
      if (n && (n.kind !== 'road' || n.links[d])) return 'occupied';
    }
    const over: number[] = [];
    const corners: number[] = [];
    let x = ax;
    let y = ay;
    for (let s = 0; s < span; s++) {
      if (isDiag(dir)) {
        const k = this.cornerKey(x, y, dir);
        if (this.mwCorners.has(k)) return 'cross';
        corners.push(k);
      }
      x += DX[dir];
      y += DY[dir];
      if (s < span - 1) {
        if (!w.inBounds(x, y)) return 'bounds';
        const i = w.idx(x, y);
        if (this.mwOver.has(i)) return 'cross';
        // cannot fly over another motorway's ramp either
        const n = this.nodes.get(i);
        if (n && n.links.some((l) => l !== null && l.kind === 'motorway')) return 'cross';
        over.push(i);
      }
    }
    // endpoints cannot sit under another motorway deck
    if (this.mwOver.has(w.idx(ax, ay)) || this.mwOver.has(w.idx(bx, by))) return 'cross';
    return { ax, ay, bx, by, dir, span, over, corners };
  }

  buildMotorway(plan: MotorwayPlan, a: RNode, b: RNode): Link | null {
    if (a.kind !== 'road' || b.kind !== 'road') return null;
    if (a.links[plan.dir] || b.links[opp(plan.dir)]) return null;
    return this.attach(new Link(a, b, plan.dir, 'motorway', plan.span, plan.over, plan.corners));
  }

  /** Number of plain road tiles (what the player pays for). */
  roadCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.kind === 'road') n++;
    return n;
  }
}
