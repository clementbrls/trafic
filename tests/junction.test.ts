import { describe, it, expect } from 'vitest';
import { Game } from '../src/game/game';
import { getMap } from '../src/game/maps';
import { DX, DY } from '../src/game/constants';
import type { RNode } from '../src/game/network';

function dirOf(ax: number, ay: number, bx: number, by: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === Math.sign(bx - ax) && DY[d] === Math.sign(by - ay)) return d;
  return -1;
}

/** Build a straight road (inclusive) and link it. */
function road(g: Game, x0: number, y0: number, x1: number, y1: number): RNode[] {
  const nodes: RNode[] = [];
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  for (let k = 0; k <= n; k++) {
    const x = x0 + sx * k;
    const y = y0 + sy * k;
    let node = g.net.nodeAt(x, y);
    if (!node) node = g.net.addRoad(x, y) ?? undefined;
    if (!node) throw new Error(`cannot place road at ${x},${y}`);
    nodes.push(node);
  }
  for (let k = 0; k + 1 < nodes.length; k++) {
    const a = nodes[k];
    const b = nodes[k + 1];
    const d = dirOf(a.x, a.y, b.x, b.y);
    if (!a.links[d]) g.net.linkRoad(a, b, d);
  }
  return nodes;
}

function link(g: Game, a: RNode, b: RNode): void {
  const d = dirOf(a.x, a.y, b.x, b.y);
  const r = g.net.checkRoadLink(a, b, d);
  if (r !== 'ok') throw new Error(`link failed ${r} (${a.x},${a.y})->(${b.x},${b.y})`);
  g.net.linkRoad(a, b, d);
}

/**
 * A cross: destination to the north, houses at the three other arm ends.
 * Every trip crosses the junction at (15,10).
 */
function crossScene(control: 'none' | 'light' | 'roundabout') {
  const g = new Game(getMap('plaine'), false, 5, { demo: true });
  g.world.bounds = { x0: 0, y0: 0, x1: g.world.w, y1: g.world.h };
  const color = 0;
  // destination north, gate facing south at (15,4) -> front (15,5)
  const dest = g.placeDestination(14, 3, color, 15, 4, 2);
  road(g, 15, 5, 15, 16);
  road(g, 7, 10, 23, 10);
  link(g, g.net.nodeAt(15, 5) as RNode, dest.gate);
  const houses = [
    [6, 10, 0], [24, 10, 4], [15, 17, 6], // arm ends
    [8, 11, 6], [10, 9, 2], [20, 11, 6], [22, 9, 2], [16, 14, 4], [14, 13, 0],
  ];
  for (const [x, y, f] of houses) {
    const h = g.placeHouse(x, y, color, f);
    if (!h) throw new Error('house');
    const n = g.net.nodeAt(x + DX[f], y + DY[f]) as RNode;
    link(g, h.node, n);
  }
  const j = g.net.nodeAt(15, 10) as RNode;
  if (control !== 'none') g.net.setControl(j, control);
  return { g, dest };
}

function runScene(g: Game, dest: { pins: number }, seconds: number) {
  let poofs = 0;
  let overlaps = 0;
  let tick = 0;
  while (g.time < seconds) {
    if (tick % 30 === 0) dest.pins = Math.max(dest.pins, 25);
    g.step(1 / 60);
    for (const e of g.events) if (e.type === 'poof') poofs++;
    g.events.length = 0;
    if (tick % 10 === 0) {
      const cars = g.traffic.cars.filter((c) => c.state === 'driving');
      for (let i = 0; i < cars.length; i++)
        for (let k = i + 1; k < cars.length; k++)
          if (Math.hypot(cars[i].x - cars[k].x, cars[i].y - cars[k].y) < 0.1) overlaps++;
    }
    tick++;
  }
  return { score: g.score, poofs, overlaps };
}

describe('long links', () => {
  it('drives across a bridge and a motorway built with the builder', async () => {
    const { Builder } = await import('../src/game/builder');
    const { WATER } = await import('../src/game/world');
    const g = new Game(getMap('plaine'), false, 8, { demo: true });
    const w = g.world;
    w.bounds = { x0: 0, y0: 0, x1: w.w, y1: w.h };
    // a river column at x = 12..13
    for (let y = 0; y < w.h; y++) {
      w.terrain[w.idx(12, y)] = WATER;
      w.terrain[w.idx(13, y)] = WATER;
    }
    const dest = g.placeDestination(20, 4, 1, 20, 5, 2); // gate (20,5) facing S -> front (20,6)
    const b = new Builder(g);
    g.inv.bridges = 1;
    g.inv.motorways = 1;
    g.inv.roads = 100;
    // west bank houses
    const houses = [[4, 7, 0], [4, 9, 0], [6, 10, 6]];
    for (const [x, y, f] of houses) g.placeHouse(x, y, 1, f);
    // road from (5,8) east to the river, across it (bridge), then to the gate front
    b.begin(4.5, 7.5, 'road');
    for (let x = 5; x <= 11; x++) b.move(x + 0.5, 7.5);
    b.move(12.5, 7.5); // enters water -> bridge to (14,7)
    b.move(14.5, 7.5);
    for (let x = 15; x <= 20; x++) b.move(x + 0.5, 7.5);
    b.move(20.5, 6.5);
    b.move(20.5, 5.5); // into the gate
    b.end();
    // connect the other houses to the west road
    b.begin(4.5, 9.5, 'road');
    b.move(5.5, 9.5);
    b.move(5.5, 8.5);
    b.move(5.5, 7.5);
    b.end();
    b.begin(6.5, 10.5, 'road');
    b.move(6.5, 9.5);
    b.move(5.5, 9.5);
    b.end();
    expect(g.inv.bridges).toBe(0);
    const bridge = [...g.net.links].find((l) => l.kind === 'bridge');
    expect(bridge).toBeDefined();
    // motorway shortcut from (7,7)... build a parallel fast lane on row 3
    b.begin(8.5, 7.5, 'motorway');
    b.move(8.5, 3.5);
    b.end();
    const mw = [...g.net.links].find((l) => l.kind === 'motorway');
    expect(mw).toBeDefined();
    for (const h of g.houses) expect(g.houseConnected(h)).toBe(true);
    const r = runScene(g, dest, 120);
    console.log('bridge', r);
    expect(r.score).toBeGreaterThan(15);
    expect(r.poofs).toBe(0);
  });
});

describe('junction control', () => {
  for (const control of ['none', 'light', 'roundabout'] as const) {
    it(`keeps traffic flowing through a cross (${control})`, () => {
      const { g, dest } = crossScene(control);
      const r = runScene(g, dest, 180);
      console.log(control, r);
      expect(r.poofs).toBe(0);
      expect(r.score).toBeGreaterThan(40);
      expect(r.overlaps).toBeLessThan(5);
    });
  }

  it('survives erasing and rebuilding roads while cars drive', () => {
    const { g, dest } = crossScene('none');
    let tick = 0;
    let removed: RNode | null = null;
    while (g.time < 120) {
      dest.pins = Math.max(dest.pins, 20);
      tick++;
      if (tick % 1200 === 600) {
        const n = g.net.nodeAt(15, 10);
        if (n) {
          g.removeRoad(n);
          removed = n;
        }
      }
      if (tick % 1200 === 780 && removed) {
        const n = g.net.addRoad(15, 10);
        if (n) {
          for (const [x, y] of [[14, 10], [16, 10], [15, 9], [15, 11]]) link(g, g.net.nodeAt(x, y) as RNode, n);
        }
        removed = null;
      }
      g.step(1 / 60);
      g.events.length = 0;
      for (const c of g.traffic.cars) {
        expect(Number.isFinite(c.x)).toBe(true);
        expect(Number.isFinite(c.y)).toBe(true);
        if (c.state === 'driving') {
          for (let k = c.i; k < c.segs.length; k++) {
            const node = c.segs[k].node;
            if (node && !node.alive) {
              console.log('DEAD', JSON.stringify({ t: g.time.toFixed(2), i: c.i, k, kind: c.segs[k].kind, cur: c.segs[c.i].kind, curNode: [c.segs[c.i].node?.x, c.segs[c.i].node?.y], dead: [node.x, node.y], n: c.segs.length }));
            }
            expect(node?.alive ?? true).toBe(true);
          }
        }
      }
    }
    console.log('edits', { score: g.score, cars: g.traffic.cars.length });
    expect(g.score).toBeGreaterThan(10);
  });
});
