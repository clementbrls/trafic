import { MinHeap } from '../core/heap';
import { DIR_ANGLE, TERM, opp, isDiag, SPEED_MOTORWAY, SPEED_AVENUE } from './constants';
import { mod, TAU } from '../core/math';
import type { Link, RNode } from './network';

export interface Route {
  /** nodes from start to goal */
  nodes: RNode[];
  /** links between consecutive nodes */
  links: Link[];
  cost: number;
}

export type JunctionCost = (n: RNode) => number;

const UTURN_COST = 7;

export function linkCost(l: Link): number {
  const len = l.span * (isDiag(l.dir) ? Math.SQRT2 : 1);
  if (l.kind === 'motorway') return len / SPEED_MOTORWAY;
  return l.tier === 'avenue' ? len / SPEED_AVENUE : len;
}

/** left turn (right-hand traffic, screen y down) or U-turn */
export function isLeftTurn(entry: number, exit: number): boolean {
  if (entry === TERM || exit === TERM) return false;
  if (entry === exit) return true;
  const signed = mod(DIR_ANGLE[exit] - DIR_ANGLE[opp(entry)] + Math.PI, TAU) - Math.PI;
  return signed < -0.2;
}

function turnCost(entry: number, exit: number): number {
  if (entry === TERM) return 0;
  if (entry === exit) return UTURN_COST;
  const vin = DIR_ANGLE[opp(entry)];
  const vout = DIR_ANGLE[exit];
  const a = Math.abs(mod(vout - vin + Math.PI, TAU) - Math.PI);
  return a < 0.1 ? 0 : a < 0.9 ? 0.08 : a < 1.7 ? 0.22 : 0.6;
}

interface State {
  node: RNode;
  arm: number; // arm through which we arrived (TERM at start)
  g: number;
  prev: State | null;
  via: Link | null;
  closed: boolean;
}

/**
 * A* over (node, arrival arm) states so that turn costs and U-turn
 * restrictions are respected. Terminal nodes (houses, parking gates)
 * can only be the start or the goal.
 */
export function findRoute(
  start: RNode,
  startArm: number,
  goal: RNode,
  junctionCost: JunctionCost,
  maxExpand = 20000,
): Route | null {
  if (!start.alive || !goal.alive) return null;
  const states = new Map<number, State>();
  const heap = new MinHeap<State>();
  const h = (n: RNode) => Math.hypot(n.cx - goal.cx, n.cy - goal.cy) / SPEED_MOTORWAY;
  const s0: State = { node: start, arm: startArm, g: 0, prev: null, via: null, closed: false };
  states.set(start.id * 9 + startArm, s0);
  heap.push(s0, h(start));
  let expanded = 0;
  while (heap.size > 0) {
    const cur = heap.pop() as State;
    if (cur.closed) continue;
    cur.closed = true;
    const n = cur.node;
    if (n === goal) return rebuild(cur);
    if (++expanded > maxExpand) break;
    if (n !== start && n.isTerminal) continue;
    const jc = n !== start && n.isJunction ? junctionCost(n) : 0;
    // junction rule applies at every junction we traverse, including the one
    // a rerouted car is about to enter (start node with a real arrival arm)
    const rule = n.noLeft && n.degree >= 3 && n.control !== 'roundabout' && (n !== start || cur.arm !== TERM);
    for (let d = 0; d < 8; d++) {
      const l = n.links[d];
      if (!l || !l.allows(n)) continue;
      if (d === cur.arm && n.kind !== 'road') continue;
      if (rule && isLeftTurn(cur.arm, d)) continue;
      const m = l.other(n);
      if (m.isTerminal && m !== goal) continue;
      const g = cur.g + linkCost(l) + turnCost(cur.arm, d) + jc;
      const arm = opp(d);
      const key = m.id * 9 + arm;
      const ex = states.get(key);
      if (ex && (ex.closed || ex.g <= g)) continue;
      const st: State = { node: m, arm, g, prev: cur, via: l, closed: false };
      states.set(key, st);
      heap.push(st, g + h(m));
    }
  }
  return null;
}

function rebuild(end: State): Route {
  const nodes: RNode[] = [];
  const links: Link[] = [];
  let s: State | null = end;
  while (s) {
    nodes.push(s.node);
    if (s.via) links.push(s.via);
    s = s.prev;
  }
  nodes.reverse();
  links.reverse();
  return { nodes, links, cost: end.g };
}

/**
 * Plain Dijkstra from a node, not passing through terminals. With
 * `reverse`, costs are for travelling *to* the source (one-way aware).
 */
export function distancesFrom(source: RNode, junctionCost: JunctionCost, reverse = false): Map<RNode, number> {
  const dist = new Map<RNode, number>();
  const heap = new MinHeap<RNode>();
  dist.set(source, 0);
  heap.push(source, 0);
  const done = new Set<RNode>();
  while (heap.size > 0) {
    const n = heap.pop() as RNode;
    if (done.has(n)) continue;
    done.add(n);
    if (n !== source && n.isTerminal) continue;
    const base = dist.get(n) as number;
    const jc = n !== source && n.isJunction ? junctionCost(n) : 0;
    for (let d = 0; d < 8; d++) {
      const l = n.links[d];
      if (!l) continue;
      const m = l.other(n);
      if (reverse ? !l.allows(m) : !l.allows(n)) continue;
      const g = base + linkCost(l) + jc;
      const ex = dist.get(m);
      if (ex === undefined || g < ex) {
        dist.set(m, g);
        heap.push(m, g);
      }
    }
  }
  return dist;
}
