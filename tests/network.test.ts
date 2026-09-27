import { describe, it, expect } from 'vitest';
import { World, WATER } from '../src/game/world';
import { Network } from '../src/game/network';
import { findRoute } from '../src/game/pathfind';
import { TERM } from '../src/game/constants';
import { moveGeom } from '../src/game/geometry';
import { Game } from '../src/game/game';
import { getMap } from '../src/game/maps';
import { Builder } from '../src/game/builder';

function world(w = 12, h = 8): World {
  const wd = new World(w, h);
  wd.bounds = { x0: 0, y0: 0, x1: w, y1: h };
  return wd;
}

describe('network rules', () => {
  it('links adjacent roads and counts degrees', () => {
    const n = new Network(world());
    const a = n.addRoad(1, 1)!;
    const b = n.addRoad(2, 1)!;
    const c = n.addRoad(2, 2)!;
    expect(n.linkRoad(a, b, 0)).not.toBeNull();
    expect(n.linkRoad(b, c, 2)).not.toBeNull();
    expect(a.degree).toBe(1);
    expect(b.degree).toBe(2);
    expect(n.checkRoadLink(a, b, 0)).toBe('same');
  });

  it('refuses crossing diagonals', () => {
    const n = new Network(world());
    const a = n.addRoad(1, 1)!;
    const b = n.addRoad(2, 2)!;
    const c = n.addRoad(2, 1)!;
    const d = n.addRoad(1, 2)!;
    expect(n.linkRoad(a, b, 1)).not.toBeNull(); // SE
    expect(n.checkRoadLink(c, d, 3)).toBe('cross'); // SW crossing
    expect(n.cornerFree(2, 1, 3)).toBe(false);
  });

  it('houses accept a single orthogonal driveway', () => {
    const n = new Network(world());
    const h = n.addTerminal(3, 3, 'house', 1);
    const r1 = n.addRoad(4, 3)!;
    const r2 = n.addRoad(3, 4)!;
    const r3 = n.addRoad(4, 4)!;
    expect(n.checkRoadLink(h, r3, 1)).toBe('direction');
    expect(n.linkRoad(h, r1, 0)).not.toBeNull();
    expect(n.checkRoadLink(h, r2, 2)).toBe('occupied');
  });

  it('gates only open on their side', () => {
    const n = new Network(world());
    const g = n.addTerminal(5, 5, 'gate', 1, 2);
    const s = n.addRoad(5, 6)!;
    const e = n.addRoad(6, 5)!;
    expect(n.checkRoadLink(g, e, 0)).toBe('direction');
    expect(n.linkRoad(s, g, 6)).not.toBeNull();
  });

  it('plans bridges over water only up to land', () => {
    const w = world(12, 8);
    for (let y = 0; y < 8; y++) {
      w.terrain[w.idx(5, y)] = WATER;
      w.terrain[w.idx(6, y)] = WATER;
    }
    const n = new Network(w);
    const a = n.addRoad(4, 3)!;
    const plan = n.planBridge(a, 0);
    expect(typeof plan).toBe('object');
    if (typeof plan === 'object') {
      expect(plan.bx).toBe(7);
      expect(plan.over.length).toBe(2);
      const b = n.addRoad(plan.bx, plan.by)!;
      const l = n.buildBridge(plan, b)!;
      expect(l.kind).toBe('bridge');
      expect(n.bridgeOver.size).toBe(2);
      n.unlink(l);
      expect(n.bridgeOver.size).toBe(0);
    }
    // too wide
    for (let x = 5; x < 12; x++) w.terrain[w.idx(x, 6)] = WATER;
    const c = n.addRoad(4, 6)!;
    expect(n.planBridge(c, 0)).toBe('span');
  });

  it('plans motorways in straight lines', () => {
    const n = new Network(world(16, 8));
    expect(typeof n.planMotorway(1, 1, 5, 1)).toBe('object');
    expect(typeof n.planMotorway(1, 1, 4, 4)).toBe('object');
    expect(n.planMotorway(1, 1, 4, 2)).toBe('direction');
    expect(n.planMotorway(1, 1, 2, 1)).toBe('span');
  });
});

describe('routing', () => {
  it('does not route through houses and avoids U-turns', () => {
    const n = new Network(world(12, 8));
    const roads = [];
    for (let x = 1; x <= 6; x++) roads.push(n.addRoad(x, 2)!);
    for (let k = 0; k + 1 < roads.length; k++) n.linkRoad(roads[k], roads[k + 1], 0);
    const h1 = n.addTerminal(1, 1, 'house', 1);
    const h2 = n.addTerminal(3, 1, 'house', 2);
    const g = n.addTerminal(6, 3, 'gate', 3, 6);
    n.linkRoad(h1, roads[0], 2);
    n.linkRoad(h2, roads[2], 2);
    n.linkRoad(roads[5], g, 2);
    const r = findRoute(h1, TERM, g, () => 0.3);
    expect(r).not.toBeNull();
    expect(r!.nodes.includes(h2)).toBe(false);
    expect(r!.nodes[r!.nodes.length - 1]).toBe(g);
  });
});

describe('geometry', () => {
  it('builds continuous lanes through a node', () => {
    const n = new Network(world());
    const a = n.addRoad(2, 2)!;
    const b = n.addRoad(3, 2)!;
    const c = n.addRoad(3, 3)!;
    n.linkRoad(a, b, 0);
    n.linkRoad(b, c, 2);
    const g1 = moveGeom(a, TERM === 8 ? 4 : 4, 0); // straight through a (from west)
    const g2 = moveGeom(b, 4, 2); // turn right into c
    const endA = [g1.poly.xs[g1.poly.xs.length - 1], g1.poly.ys[g1.poly.ys.length - 1]];
    const startB = [g2.poly.xs[0], g2.poly.ys[0]];
    expect(Math.hypot(endA[0] - startB[0], endA[1] - startB[1])).toBeLessThan(1e-4);
    expect(g2.poly.len).toBeGreaterThan(0.5);
    expect(g2.boxOut).toBeGreaterThan(g2.boxIn);
  });
});

describe('builder', () => {
  it('draws, re-orients houses and refunds on erase', () => {
    const game = new Game(getMap('plaine'), false, 3, { demo: true });
    game.world.bounds = { x0: 0, y0: 0, x1: game.world.w, y1: game.world.h };
    const h = game.placeHouse(10, 10, 0, 0)!;
    const b = new Builder(game);
    const before = game.inv.roads;
    b.begin(10.5, 10.5, 'road');
    b.move(11.5, 10.5);
    b.move(12.5, 10.5);
    b.end();
    expect(game.inv.roads).toBe(before - 2);
    expect(h.node.degree).toBe(1);
    // connect the house to another road: the old driveway must go
    b.begin(10.5, 10.5, 'road');
    b.move(10.5, 11.5);
    b.end();
    expect(h.node.degree).toBe(1);
    expect(h.node.links[2]).not.toBeNull();
    // erase refunds
    b.begin(11.5, 10.5, 'erase');
    b.move(12.5, 10.5);
    b.end();
    expect(game.net.nodeAt(11, 10)).toBeUndefined();
    expect(game.inv.roads).toBe(before - 1);
  });

  it('cancel() reverts a stroke (pinch start)', () => {
    const game = new Game(getMap('plaine'), false, 4, { demo: true });
    game.world.bounds = { x0: 0, y0: 0, x1: game.world.w, y1: game.world.h };
    const b = new Builder(game);
    const before = game.inv.roads;
    b.begin(5.5, 5.5, 'road');
    b.move(8.5, 5.5);
    b.cancel();
    expect(game.inv.roads).toBe(before);
    expect(game.net.nodes.size).toBe(0);
  });
});
