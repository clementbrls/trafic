import { describe, it, expect } from 'vitest';
import { Game } from '../src/game/game';
import { getMap } from '../src/game/maps';
import { Builder } from '../src/game/builder';
import { World } from '../src/game/world';
import { Network } from '../src/game/network';
import { findRoute } from '../src/game/pathfind';
import { TERM } from '../src/game/constants';

function demo() {
  const g = new Game(getMap('plaine'), false, 21, { demo: true });
  g.world.bounds = { x0: 0, y0: 0, x1: g.world.w, y1: g.world.h };
  return { g, b: new Builder(g) };
}

describe('review regressions', () => {
  it('reroutes every car when several are cancelled at once', () => {
    const { g, b } = demo();
    const dest = g.placeDestination(20, 8, 0, 20, 9, 2); // front (20,10)
    const houses = [g.placeHouse(10, 9, 0, 2)!, g.placeHouse(11, 9, 0, 2)!, g.placeHouse(12, 9, 0, 2)!];
    b.begin(10.5, 10.5);
    for (let x = 11; x <= 20; x++) b.move(x + 0.5, 10.5);
    b.move(20.5, 9.5);
    b.end();
    for (const h of houses) {
      b.begin(h.x + 0.5, h.y + 0.5);
      b.move(h.x + 0.5, h.y + 1.5);
      b.end();
    }
    dest.pins = 6;
    for (let i = 0; i < 60 * 6; i++) g.step(1 / 60);
    const driving = g.traffic.cars.filter((c) => c.state === 'driving');
    expect(driving.length).toBeGreaterThan(1);
    // erase a tile in the middle of the road
    g.removeRoad(g.net.nodeAt(15, 10)!);
    g.step(1 / 60);
    for (const c of g.traffic.cars) {
      if (c.state !== 'driving') continue;
      for (let k = c.i; k < c.segs.length; k++) expect(c.segs[k].node?.alive ?? true).toBe(true);
    }
  });

  it('keeps a house driveway when a diagonal drag cannot connect', () => {
    const { g, b } = demo();
    const h = g.placeHouse(14, 10, 0, 0)!;
    b.begin(14.5, 10.5);
    b.move(15.5, 10.5);
    b.end();
    expect(h.node.degree).toBe(1);
    // a road to the south-west, then drag from the house diagonally onto it
    b.begin(13.5, 11.5);
    b.move(12.5, 11.5);
    b.end();
    b.begin(14.5, 10.5);
    b.move(13.5, 11.5);
    b.end();
    expect(h.node.degree).toBe(1);
    expect(h.node.links[0]).not.toBeNull();
  });

  it('applies the no-left rule at the junction a rerouted car is entering', () => {
    const w = new World(12, 10);
    w.bounds = { x0: 0, y0: 0, x1: 12, y1: 10 };
    const n = new Network(w);
    const west = n.addRoad(3, 4)!;
    const c = n.addRoad(4, 4)!;
    const up = n.addRoad(4, 3)!;
    const e = n.addRoad(5, 4)!;
    n.linkRoad(west, c, 0);
    n.linkRoad(c, up, 6);
    n.linkRoad(c, e, 0);
    const g = n.addTerminal(4, 2, 'gate', 2, 2);
    n.linkRoad(up, g, 6);
    n.setRule(c, 5);
    // car entering c from the west arm (arm 4): turning north is forbidden
    const r = findRoute(c, 4, g, () => 0)!;
    expect(r).not.toBeNull();
    expect(r.nodes[1]).toBe(e);
    // a fresh start (no arrival arm) is not constrained
    expect(findRoute(c, TERM, g, () => 0)!.nodes[1]).toBe(up);
  });

  it('refuses motorways overlapping another motorway in line', () => {
    const w = new World(16, 8);
    w.bounds = { x0: 0, y0: 0, x1: 16, y1: 8 };
    const n = new Network(w);
    const p1 = n.planMotorway(5, 2, 8, 2);
    expect(typeof p1).toBe('object');
    if (typeof p1 === 'object') n.buildMotorway(p1, n.addRoad(5, 2)!, n.addRoad(8, 2)!);
    expect(n.planMotorway(2, 2, 6, 2)).toBe('cross');
    expect(n.planMotorway(6, 0, 6, 4)).toBe('cross');
  });

  it('roundabouts clear junction rules', () => {
    const { g, b } = demo();
    b.begin(13.5, 10.5);
    b.move(15.5, 10.5);
    b.end();
    b.begin(14.5, 9.5);
    b.move(14.5, 10.5);
    b.end();
    const node = g.net.nodeAt(14, 10)!;
    b.tap(14.5, 10.5, 'rules');
    b.tap(14.5, 10.5, 'rules');
    expect(node.noLeft).toBe(true);
    g.inv.roundabouts = 1;
    b.tap(14.5, 10.5, 'roundabout');
    expect(node.control).toBe('roundabout');
    expect(node.noLeft).toBe(false);
  });
});
