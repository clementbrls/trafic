import { MinHeap } from '../core/heap';
import { DX, DY, opp } from './constants';
import type { Game } from './game';
import type { House, Destination } from './entities';
import type { RNode } from './network';

/**
 * Tiny road-building bot: connects houses and destinations of the same
 * colour with orthogonal roads, reusing existing roads when possible.
 * Used by the menu demo and the automated tests.
 */
export class AutoBuilder {
  readonly game: Game;
  /** when true the bot does not pay for roads */
  free = true;

  constructor(game: Game) {
    this.game = game;
  }

  connectAll(): number {
    let built = 0;
    for (const d of this.game.dests) built += this.connectDest(d);
    for (const h of this.game.houses) if (!this.game.houseConnected(h)) built += this.connectHouse(h);
    return built;
  }

  private pay(): boolean {
    if (this.free) return true;
    if (this.game.inv.roads <= 0) return false;
    this.game.inv.roads--;
    return true;
  }

  /** make sure the gate is linked, and that the destination joins its colour's network */
  connectDest(d: Destination): number {
    const g = this.game;
    const net = g.net;
    let built = 0;
    if (d.gate.degree === 0) {
      const fx = d.frontX;
      const fy = d.frontY;
      let n = net.nodeAt(fx, fy);
      if (!n) {
        if (!net.canPlaceRoad(fx, fy) || !this.pay()) return 0;
        n = net.addRoad(fx, fy) ?? undefined;
        if (!n) return 0;
        built++;
      }
      if (n.kind !== 'road') return built;
      net.linkRoad(n, d.gate, opp(d.gateDir));
    }
    if (g.destConnected(d)) return built;
    // join the network used by other destinations / houses of this colour
    const reach = g.distMap(d);
    const targets = new Set<number>();
    for (const o of g.dests) {
      if (o === d || o.color !== d.color) continue;
      for (const node of g.distMap(o).keys()) if (node.kind === 'road' && !reach.has(node)) targets.add(node.tile);
    }
    if (targets.size === 0) return built;
    const starts: RNode[] = [];
    for (const node of reach.keys()) if (node.kind === 'road') starts.push(node);
    return built + this.buildPath(starts.map((n) => [n.x, n.y] as [number, number]), targets, null);
  }

  connectHouse(h: House): number {
    const g = this.game;
    const net = g.net;
    const w = g.world;
    const targets = new Set<number>();
    for (const d of g.dests) {
      if (d.color !== h.color) continue;
      if (d.gate.degree > 0) {
        for (const node of g.distMap(d).keys()) if (node.kind === 'road') targets.add(node.tile);
      } else {
        targets.add(w.idx(d.frontX, d.frontY));
      }
    }
    if (targets.size === 0) return 0;
    const starts: [number, number][] = [];
    for (let d = 0; d < 8; d += 2) {
      const nx = h.x + DX[d];
      const ny = h.y + DY[d];
      if (!w.inBounds(nx, ny)) continue;
      const n = net.nodeAt(nx, ny);
      if ((n && n.kind === 'road' && !n.links[opp(d)]) || (!n && net.canPlaceRoad(nx, ny))) starts.push([nx, ny]);
    }
    return this.buildPath(starts, targets, h);
  }

  /**
   * Dijkstra over tiles from `starts` to any tile in `targets`, then build it.
   * If `house` is given, the house is linked to the first tile of the path.
   */
  private buildPath(starts: [number, number][], targets: Set<number>, house: House | null): number {
    const g = this.game;
    const net = g.net;
    const w = g.world;
    const dist = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap = new MinHeap<number>();
    for (const [x, y] of starts) {
      const i = w.idx(x, y);
      const c = net.nodeAt(x, y) ? 0.2 : 1;
      dist.set(i, c);
      heap.push(i, c);
    }
    let found = -1;
    while (heap.size > 0) {
      const i = heap.pop() as number;
      const base = dist.get(i) as number;
      if (targets.has(i)) {
        found = i;
        break;
      }
      const x = i % w.w;
      const y = (i - x) / w.w;
      for (let d = 0; d < 8; d += 2) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!w.inBounds(nx, ny)) continue;
        const j = w.idx(nx, ny);
        const n = net.nodeAt(nx, ny);
        let c: number;
        if (n) {
          if (n.kind !== 'road') continue;
          // an existing road can only be entered if the arm is free or already linked
          c = 0.2;
        } else if (net.canPlaceRoad(nx, ny)) c = 1;
        else continue;
        const nd = base + c;
        const ex = dist.get(j);
        if (ex === undefined || nd < ex) {
          dist.set(j, nd);
          prev.set(j, i);
          heap.push(j, nd);
        }
      }
    }
    if (found < 0) return 0;
    const path: number[] = [];
    let cur: number | undefined = found;
    while (cur !== undefined) {
      path.push(cur);
      cur = prev.get(cur);
    }
    path.reverse();
    let built = 0;
    const nodes: RNode[] = [];
    for (const i of path) {
      const x = i % w.w;
      const y = (i - x) / w.w;
      let n = net.nodeAt(x, y);
      if (!n) {
        if (!this.pay()) break;
        n = net.addRoad(x, y) ?? undefined;
        if (!n) break;
        built++;
      }
      nodes.push(n);
    }
    for (let k = 0; k + 1 < nodes.length; k++) {
      const a = nodes[k];
      const b = nodes[k + 1];
      const d = dirOf(a, b);
      if (d >= 0 && !a.links[d] && net.checkRoadLink(a, b, d) === 'ok') net.linkRoad(a, b, d);
    }
    if (house && nodes.length > 0) {
      const first = nodes[0];
      const hd = dirOf(house.node, first);
      if (hd >= 0) {
        for (const l of house.node.links) if (l) net.unlink(l);
        if (net.checkRoadLink(house.node, first, hd) === 'ok') net.linkRoad(house.node, first, hd);
      }
    }
    // if the path ended on a gate front, link it
    const last = nodes[nodes.length - 1];
    if (last) {
      for (const d of g.dests) {
        if (d.frontX === last.x && d.frontY === last.y && d.gate.degree === 0) net.linkRoad(last, d.gate, opp(d.gateDir));
      }
    }
    return built;
  }
}

function dirOf(a: RNode, b: RNode): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}
