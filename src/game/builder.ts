import { DX, DY, opp, isDiag, MIN_MOTORWAY_SPAN, MAX_MOTORWAY_SPAN } from './constants';
import type { Game } from './game';
import { RULE_AUTO, RULE_AXIS, RULE_NOLEFT, type Link, type MotorwayPlan, type RNode, type RoadTier } from './network';

export type Tool = 'road' | 'erase' | 'roundabout' | 'light' | 'motorway' | 'rules';

/** what the road tool draws */
export type RoadType = 'street' | 'avenue' | 'oneway';

export type Feedback =
  | 'noRoads'
  | 'noBridges'
  | 'noRoundabouts'
  | 'noLights'
  | 'noMotorways'
  | 'bridgeTooLong'
  | 'cross'
  | 'bounds'
  | 'building'
  | 'gateSide'
  | 'needRoad'
  | 'needJunction'
  | 'motorwayInvalid';

export type BuildSound = 'road' | 'link' | 'bridge' | 'erase' | 'item' | 'motorway' | 'style' | 'rule';

type Op =
  | { t: 'node'; node: RNode }
  | { t: 'link'; link: Link }
  | { t: 'unlink'; a: RNode; b: RNode; dir: number }
  | { t: 'style'; link: Link; tier: RoadTier; oneway: 0 | 1 | -1 };

const STEP = 0.12;
const HIT_R = 0.46;

/**
 * Interprets pointer strokes as building actions. Coordinates are in tiles.
 */
export class Builder {
  readonly game: Game;
  tool: Tool = 'road';
  roadType: RoadType = 'street';
  onFeedback: (f: Feedback, x: number, y: number) => void = () => {};
  onBuild: (s: BuildSound, x: number, y: number, n: number) => void = () => {};

  active = false;
  private strokeTool: Tool = 'road';
  private anchor: RNode | null = null;
  private anchorLocked = false;
  private last: [number, number] | null = null;
  private ops: Op[] = [];
  private lastFail = -1;
  private lastStartFail = -1;
  private strokeCount = 0;
  private erasedTiles = new Set<number>();
  /** motorway preview state */
  mw: { ax: number; ay: number; bx: number; by: number; plan: MotorwayPlan | null; ok: boolean } | null = null;
  /** the tile a tap tool would affect */
  hover: { x: number; y: number } | null = null;

  constructor(game: Game) {
    this.game = game;
  }

  private get net() {
    return this.game.net;
  }

  private fail(f: Feedback, key: number, x: number, y: number): void {
    if (key === this.lastFail) return;
    this.lastFail = key;
    this.onFeedback(f, x, y);
  }

  // ------------------------------------------------------------------
  // Strokes
  // ------------------------------------------------------------------

  begin(x: number, y: number, tool: Tool = this.tool): void {
    this.active = true;
    this.strokeTool = tool;
    this.ops = [];
    this.anchor = null;
    this.anchorLocked = false;
    this.lastFail = -1;
    this.lastStartFail = -1;
    this.strokeCount = 0;
    this.erasedTiles.clear();
    this.last = [x, y];
    if (tool === 'road') this.tryStart(x, y, true);
    else if (tool === 'erase') this.eraseAt(x, y);
    else if (tool === 'motorway') {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      this.mw = { ax: tx, ay: ty, bx: tx, by: ty, plan: null, ok: false };
    }
  }

  move(x: number, y: number): void {
    if (!this.active) {
      this.hover = { x: Math.floor(x), y: Math.floor(y) };
      return;
    }
    const tool = this.strokeTool;
    if (tool === 'motorway') {
      this.updateMotorway(x, y);
      return;
    }
    if (tool !== 'road' && tool !== 'erase') {
      this.hover = { x: Math.floor(x), y: Math.floor(y) };
      return;
    }
    const [lx, ly] = this.last ?? [x, y];
    const dist = Math.hypot(x - lx, y - ly);
    const n = Math.max(1, Math.ceil(dist / STEP));
    for (let k = 1; k <= n; k++) {
      const px = lx + ((x - lx) * k) / n;
      const py = ly + ((y - ly) * k) / n;
      if (tool === 'road') this.roadSample(px, py);
      else this.eraseAt(px, py);
    }
    this.last = [x, y];
  }

  end(): void {
    if (!this.active) return;
    if (this.strokeTool === 'motorway') this.commitMotorway();
    this.active = false;
    this.anchor = null;
    this.mw = null;
    this.ops = [];
  }

  /** Abort the current stroke and revert what it built (used when a pinch starts). */
  cancel(): void {
    if (!this.active) return;
    const g = this.game;
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i];
      if (op.t === 'node') {
        if (op.node.alive) {
          g.removeRoad(op.node);
          g.stats.roadsBuilt = Math.max(0, g.stats.roadsBuilt - 1);
        }
      } else if (op.t === 'link') {
        if (op.link.alive) g.removeLink(op.link);
        else {
          // the link may have been re-created by an undone unlink: remove whatever joins the ends now
          const cur = op.link.a.links[op.link.dir];
          if (cur && cur.alive && cur.other(op.link.a) === op.link.b) g.removeLink(cur);
        }
      } else if (op.t === 'unlink') {
        if (op.a.alive && op.b.alive && this.net.checkRoadLink(op.a, op.b, op.dir) === 'ok') this.net.linkRoad(op.a, op.b, op.dir);
      } else if (op.t === 'style') {
        if (op.link.alive) {
          const before = op.link.extraCost;
          this.net.setLinkStyle(op.link, op.tier, op.oneway);
          g.inv.roads += before - op.link.extraCost;
        }
      }
    }
    this.ops = [];
    this.active = false;
    this.anchor = null;
    this.mw = null;
  }

  /** Was anything built/erased during this stroke? */
  get strokeChanged(): boolean {
    return this.strokeCount > 0;
  }

  // ------------------------------------------------------------------
  // Road classes
  // ------------------------------------------------------------------

  /** style wanted for a link drawn from `from` with the current road type */
  private wanted(l: Link, from: RNode): { tier: RoadTier; oneway: 0 | 1 | -1 } | null {
    if (l.kind === 'motorway') return null;
    if (l.a.isTerminal || l.b.isTerminal) return null; // driveways stay two-way streets
    switch (this.roadType) {
      case 'avenue':
        return { tier: 'avenue', oneway: 0 };
      case 'oneway':
        return { tier: 'street', oneway: from === l.a ? 1 : -1 };
      default:
        // drawing a plain street never downgrades an avenue, it only makes one-ways two-way again
        return { tier: l.tier, oneway: 0 };
    }
  }

  /** apply the current road type to a link, paying the difference. Returns false if unaffordable. */
  private applyStyle(l: Link, from: RNode, fresh: boolean): boolean {
    const w = this.wanted(l, from);
    if (!w || (w.tier === l.tier && w.oneway === l.oneway)) return true;
    const before = l.extraCost;
    const prev = { tier: l.tier, oneway: l.oneway };
    const after = w.tier === 'avenue' ? 1 : 0;
    const delta = after - before;
    if (delta > 0 && this.game.inv.roads < delta) return false;
    this.net.setLinkStyle(l, w.tier, w.oneway);
    this.game.inv.roads -= delta;
    if (!fresh) {
      this.ops.push({ t: 'style', link: l, tier: prev.tier, oneway: prev.oneway });
      this.strokeCount++;
      this.onBuild('style', l.b.x, l.b.y, this.strokeCount);
    }
    return true;
  }

  /** extra road units the current type costs for a new link */
  private extraFor(): number {
    return this.roadType === 'avenue' ? 1 : 0;
  }

  // ------------------------------------------------------------------
  // Road tool
  // ------------------------------------------------------------------

  private tryStart(x: number, y: number, explicit: boolean): void {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const w = this.game.world;
    const key = ty * w.w + tx;
    if (!explicit && key === this.lastStartFail) return;
    const n = this.net.nodeAt(tx, ty);
    if (n) {
      this.anchor = n;
      this.anchorLocked = false;
      return;
    }
    if (this.game.destAt(tx, ty)) {
      this.lastStartFail = key;
      return;
    }
    if (!this.net.canPlaceRoad(tx, ty)) {
      if (explicit) {
        if (!w.inBounds(tx, ty)) this.fail('bounds', -2, tx, ty);
      }
      this.lastStartFail = key;
      return;
    }
    if (this.game.inv.roads <= 0) {
      this.lastStartFail = key;
      this.fail('noRoads', -3, tx, ty);
      return;
    }
    const node = this.net.addRoad(tx, ty);
    if (node) {
      this.game.inv.roads--;
      this.game.stats.roadsBuilt++;
      this.ops.push({ t: 'node', node });
      this.anchor = node;
      this.strokeCount++;
      this.onBuild('road', tx, ty, this.strokeCount);
    }
  }

  private roadSample(px: number, py: number): void {
    const tx = Math.floor(px);
    const ty = Math.floor(py);
    if (!this.anchor || !this.anchor.alive) {
      this.anchor = null;
      this.tryStart(px, py, false);
      return;
    }
    const a = this.anchor;
    if (this.anchorLocked) {
      if (tx !== a.x || ty !== a.y) {
        this.anchor = null;
        this.anchorLocked = false;
      }
      return;
    }
    // neighbour circles
    for (let d = 0; d < 8; d++) {
      const cx = a.cx + DX[d];
      const cy = a.cy + DY[d];
      if (Math.hypot(px - cx, py - cy) < HIT_R) {
        this.step(a, d);
        return;
      }
    }
    // fallback for fast strokes: step toward the pointer
    const cheb = Math.max(Math.abs(tx - a.x), Math.abs(ty - a.y));
    if (cheb >= 2 && this.game.world.isLand(tx, ty)) {
      const ang = Math.atan2(py - a.cy, px - a.cx);
      const d = (Math.round(ang / (Math.PI / 4)) + 8) % 8;
      this.step(a, d);
    }
  }

  /** create a link between p and n in direction d with the current road type */
  private newLink(p: RNode, n: RNode, d: number): Link | null {
    const link = this.net.linkRoad(p, n, d);
    if (!link) return null;
    this.ops.push({ t: 'link', link });
    this.applyStyle(link, p, true);
    return link;
  }

  private step(p: RNode, d: number): void {
    const g = this.game;
    const net = this.net;
    const w = g.world;
    const nx = p.x + DX[d];
    const ny = p.y + DY[d];
    const key = p.id * 8 + d;
    if (!w.inBounds(nx, ny)) {
      this.fail('bounds', key, nx, ny);
      return;
    }
    // water: walk (and restyle) an existing bridge or build a new one
    if (w.isWater(nx, ny)) {
      const l = p.links[d];
      if (l && l.kind === 'bridge') {
        if (!this.applyStyle(l, p, false)) this.fail('noRoads', key, nx, ny);
        this.anchor = l.other(p);
        return;
      }
      if (p.kind !== 'road') {
        this.fail('needRoad', key, nx, ny);
        return;
      }
      const plan = net.planBridge(p, d);
      if (typeof plan === 'string') {
        if (plan === 'span' || plan === 'bounds') this.fail('bridgeTooLong', key, nx, ny);
        else if (plan === 'cross') this.fail('cross', key, nx, ny);
        else this.fail('building', key, nx, ny);
        return;
      }
      if (g.inv.bridges <= 0) {
        this.fail('noBridges', key, nx, ny);
        return;
      }
      let b = net.nodeAt(plan.bx, plan.by);
      const needed = (b ? 0 : 1) + this.extraFor();
      if (g.inv.roads < needed) {
        this.fail('noRoads', key, nx, ny);
        return;
      }
      if (!b) {
        b = net.addRoad(plan.bx, plan.by) ?? undefined;
        if (!b) return;
        g.inv.roads--;
        g.stats.roadsBuilt++;
        this.ops.push({ t: 'node', node: b });
      }
      const link = net.buildBridge(plan, b);
      if (link) {
        g.inv.bridges--;
        this.ops.push({ t: 'link', link });
        this.applyStyle(link, p, true);
        this.strokeCount++;
        this.onBuild('bridge', plan.bx, plan.by, this.strokeCount);
      }
      this.anchor = b;
      return;
    }
    const n = net.nodeAt(nx, ny);
    if (n) {
      const existing = p.links[d];
      if (existing && existing.other(p) === n) {
        if (!this.applyStyle(existing, p, false)) this.fail('noRoads', key, nx, ny);
        this.moveAnchor(n);
        return;
      }
      if (n.kind === 'road') {
        // only move a driveway if the new one is actually possible
        if (p.kind === 'house' && this.canReorient(p, d, n)) this.reorientHouse(p, d);
        const r = net.checkRoadLink(p, n, d);
        if (r === 'ok') {
          if (!p.isTerminal && g.inv.roads < this.extraFor()) {
            this.fail('noRoads', key, nx, ny);
          } else if (this.newLink(p, n, d)) {
            this.strokeCount++;
            this.onBuild('link', nx, ny, this.strokeCount);
          }
        } else if (r === 'cross') {
          this.fail('cross', key, nx, ny);
        } else if (r === 'direction' && p.kind === 'gate') {
          this.fail('gateSide', key, nx, ny);
        }
        this.moveAnchor(n);
        return;
      }
      // terminal target (house / gate)
      if (p.kind !== 'road') {
        this.fail('needRoad', key, nx, ny);
        this.moveAnchor(n);
        return;
      }
      if (n.kind === 'house' && this.canReorient(n, opp(d), p)) this.reorientHouse(n, opp(d));
      const r = net.checkRoadLink(p, n, d);
      if (r === 'ok') {
        if (this.newLink(p, n, d)) {
          this.strokeCount++;
          this.onBuild('link', nx, ny, this.strokeCount);
        }
      } else if (n.kind === 'gate' && r === 'direction') {
        this.fail('gateSide', key, nx, ny);
      } else if (r === 'direction' && isDiag(d)) {
        this.fail('cross', key, nx, ny);
      }
      this.moveAnchor(n);
      return;
    }
    if (g.destAt(nx, ny)) {
      this.fail('building', key, nx, ny);
      return;
    }
    if (!net.canPlaceRoad(nx, ny)) {
      this.fail('building', key, nx, ny);
      return;
    }
    // pre-validate the link before paying for the tile
    if (p.isTerminal) {
      if (isDiag(d) || (p.fixedDir >= 0 && p.fixedDir !== d)) {
        this.fail(p.kind === 'gate' ? 'gateSide' : 'cross', key, nx, ny);
        return;
      }
    }
    if (p.links[d]) {
      this.fail('cross', key, nx, ny);
      return;
    }
    if (isDiag(d) && !this.net.cornerFree(p.x, p.y, d)) {
      this.fail('cross', key, nx, ny);
      return;
    }
    const cost = 1 + (p.isTerminal ? 0 : this.extraFor());
    if (g.inv.roads < cost) {
      this.fail('noRoads', key, nx, ny);
      return;
    }
    if (p.kind === 'house') this.reorientHouse(p, d);
    const node = net.addRoad(nx, ny);
    if (!node) return;
    g.inv.roads--;
    g.stats.roadsBuilt++;
    this.ops.push({ t: 'node', node });
    this.newLink(p, node, d);
    this.strokeCount++;
    this.onBuild('road', nx, ny, this.strokeCount);
    this.anchor = node;
  }

  private moveAnchor(n: RNode): void {
    this.anchor = n;
    this.anchorLocked = n.isTerminal;
  }

  /** would a driveway from house `h` in direction `d` to `other` be valid (ignoring its current one)? */
  private canReorient(h: RNode, d: number, other: RNode): boolean {
    if (isDiag(d) || other.isTerminal) return false;
    if (other.links[opp(d)]) return false;
    const cur = h.links[d];
    return !cur || cur.other(h) === other;
  }

  /** a house can only have one driveway: drop the old one if we connect elsewhere */
  private reorientHouse(h: RNode, newDir: number): void {
    for (let d = 0; d < 8; d++) {
      const l = h.links[d];
      if (l && d !== newDir) {
        const other = l.other(h);
        this.ops.push({ t: 'unlink', a: h, b: other, dir: d });
        this.net.unlink(l);
      }
    }
  }

  // ------------------------------------------------------------------
  // Eraser
  // ------------------------------------------------------------------

  private eraseAt(px: number, py: number): void {
    const tx = Math.floor(px);
    const ty = Math.floor(py);
    const g = this.game;
    const w = g.world;
    if (!w.inMap(tx, ty)) return;
    const i = w.idx(tx, ty);
    if (this.erasedTiles.has(i)) return;
    const n = this.net.nodeAt(tx, ty);
    if (n) {
      if (n.kind === 'road') {
        this.erasedTiles.add(i);
        g.removeRoad(n);
        this.strokeCount++;
        this.onBuild('erase', tx, ty, this.strokeCount);
      } else if (n.kind === 'house' && n.degree > 0) {
        this.erasedTiles.add(i);
        for (const l of n.links) if (l) this.net.unlink(l);
        this.strokeCount++;
        this.onBuild('erase', tx, ty, this.strokeCount);
      }
      return;
    }
    const over = this.net.bridgeOver.get(i) ?? this.net.mwOver.get(i);
    if (over) {
      this.erasedTiles.add(i);
      g.removeLink(over);
      this.strokeCount++;
      this.onBuild('erase', tx, ty, this.strokeCount);
    }
  }

  // ------------------------------------------------------------------
  // Tap tools
  // ------------------------------------------------------------------

  /** Place / remove a roundabout, traffic light or junction rule on a tile. */
  tap(x: number, y: number, tool: Tool = this.tool): void {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const g = this.game;
    const n = this.net.nodeAt(tx, ty);
    if (tool === 'erase') {
      this.eraseAt(x, y);
      return;
    }
    if (tool !== 'roundabout' && tool !== 'light' && tool !== 'rules') return;
    if (!n || n.kind !== 'road') {
      this.onFeedback('needRoad', tx, ty);
      return;
    }
    if (tool === 'rules') {
      if (n.rule === RULE_AUTO && (n.degree < 3 || n.control !== 'none')) {
        this.onFeedback('needJunction', tx, ty);
        return;
      }
      // cycle: auto -> priority along each straight axis -> no left turn -> auto
      const states = [RULE_AUTO, ...this.net.priorityAxes(n).map((a) => RULE_AXIS + a), RULE_NOLEFT];
      const i = states.indexOf(n.rule);
      const next = states[(i + 1) % states.length];
      this.net.setRule(n, next);
      this.onBuild('rule', tx, ty, next);
      return;
    }
    if (tool === 'roundabout') {
      if (n.control === 'roundabout') {
        this.net.setControl(n, 'none');
        g.inv.roundabouts++;
        this.onBuild('erase', tx, ty, 1);
        return;
      }
      if (g.inv.roundabouts <= 0) {
        this.onFeedback('noRoundabouts', tx, ty);
        return;
      }
      if (n.control === 'light') g.inv.lights++;
      g.inv.roundabouts--;
      this.net.setRule(n, RULE_AUTO); // a roundabout replaces any junction rule
      this.net.setControl(n, 'roundabout');
      this.onBuild('item', tx, ty, 1);
      return;
    }
    // lights
    if (n.control === 'light') {
      this.net.setControl(n, 'none');
      g.inv.lights++;
      this.onBuild('erase', tx, ty, 1);
      return;
    }
    if (n.degree < 3) {
      this.onFeedback('needJunction', tx, ty);
      return;
    }
    if (g.inv.lights <= 0) {
      this.onFeedback('noLights', tx, ty);
      return;
    }
    if (n.control === 'roundabout') g.inv.roundabouts++;
    g.inv.lights--;
    this.net.setControl(n, 'light');
    this.onBuild('item', tx, ty, 1);
  }

  // ------------------------------------------------------------------
  // Motorway
  // ------------------------------------------------------------------

  private updateMotorway(x: number, y: number): void {
    const mw = this.mw;
    if (!mw) return;
    const vx = x - (mw.ax + 0.5);
    const vy = y - (mw.ay + 0.5);
    const ang = Math.atan2(vy, vx);
    const d = (Math.round(ang / (Math.PI / 4)) + 8) % 8;
    const ux = DX[d];
    const uy = DY[d];
    const proj = (vx * ux + vy * uy) / (ux * ux + uy * uy);
    const k = Math.max(0, Math.min(MAX_MOTORWAY_SPAN, Math.round(proj)));
    mw.bx = mw.ax + ux * k;
    mw.by = mw.ay + uy * k;
    if (k < MIN_MOTORWAY_SPAN) {
      mw.plan = null;
      mw.ok = false;
      return;
    }
    const plan = this.net.planMotorway(mw.ax, mw.ay, mw.bx, mw.by);
    if (typeof plan === 'string') {
      mw.plan = null;
      mw.ok = false;
      return;
    }
    mw.plan = plan;
    let cost = 0;
    if (!this.net.nodeAt(mw.ax, mw.ay)) cost++;
    if (!this.net.nodeAt(mw.bx, mw.by)) cost++;
    mw.ok = this.game.inv.motorways > 0 && this.game.inv.roads >= cost;
  }

  private commitMotorway(): void {
    const mw = this.mw;
    const g = this.game;
    if (!mw) return;
    if (!mw.plan) {
      if (Math.max(Math.abs(mw.bx - mw.ax), Math.abs(mw.by - mw.ay)) >= 1) this.onFeedback('motorwayInvalid', mw.bx, mw.by);
      return;
    }
    if (g.inv.motorways <= 0) {
      this.onFeedback('noMotorways', mw.bx, mw.by);
      return;
    }
    if (!mw.ok) {
      this.onFeedback('noRoads', mw.bx, mw.by);
      return;
    }
    // the city kept living during the drag: validate again
    const fresh = this.net.planMotorway(mw.ax, mw.ay, mw.bx, mw.by);
    if (typeof fresh === 'string') {
      this.onFeedback('motorwayInvalid', mw.bx, mw.by);
      return;
    }
    const plan = fresh;
    const ends: RNode[] = [];
    for (const [x, y] of [[plan.ax, plan.ay], [plan.bx, plan.by]]) {
      let n = this.net.nodeAt(x, y);
      if (!n) {
        n = this.net.addRoad(x, y) ?? undefined;
        if (!n) return;
        g.inv.roads--;
        g.stats.roadsBuilt++;
      }
      ends.push(n);
    }
    const link = this.net.buildMotorway(plan, ends[0], ends[1]);
    if (link) {
      g.inv.motorways--;
      this.onBuild('motorway', plan.bx, plan.by, 1);
    }
  }
}
