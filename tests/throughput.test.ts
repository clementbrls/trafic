import { describe, it, expect } from 'vitest';
import { Game } from '../src/game/game';
import { getMap } from '../src/game/maps';
import { DX, DY } from '../src/game/constants';
import type { RNode } from '../src/game/network';
import type { Destination } from '../src/game/entities';

function dirOf(ax: number, ay: number, bx: number, by: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === Math.sign(bx - ax) && DY[d] === Math.sign(by - ay)) return d;
  return -1;
}

function road(g: Game, x0: number, y0: number, x1: number, y1: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  let prev: RNode | null = null;
  for (let k = 0; k <= n; k++) {
    const x = x0 + Math.sign(x1 - x0) * k;
    const y = y0 + Math.sign(y1 - y0) * k;
    const node = g.net.nodeAt(x, y) ?? g.net.addRoad(x, y);
    if (!node) throw new Error(`road ${x},${y}`);
    if (prev) {
      const d = dirOf(prev.x, prev.y, x, y);
      if (!prev.links[d]) g.net.linkRoad(prev, node, d);
    }
    prev = node;
  }
}

function link(g: Game, a: RNode, b: RNode) {
  const d = dirOf(a.x, a.y, b.x, b.y);
  if (g.net.checkRoadLink(a, b, d) !== 'ok') throw new Error('link');
  g.net.linkRoad(a, b, d);
}

/**
 * Two crossing flows: houses in the south feed a destination in the north,
 * houses in the west feed a destination in the east. Everything crosses at (15,10).
 */
function scene(control: 'none' | 'light' | 'roundabout', seed = 11) {
  const g = new Game(getMap('plaine'), false, seed, { demo: true });
  g.world.bounds = { x0: 0, y0: 0, x1: g.world.w, y1: g.world.h };
  const north = g.placeDestination(14, 1, 0, 15, 2, 2); // front (15,3)
  const east = g.placeDestination(27, 9, 1, 27, 10, 4); // front (26,10)
  road(g, 15, 3, 15, 18);
  road(g, 2, 10, 26, 10);
  link(g, g.net.nodeAt(15, 3)!, north.gate);
  link(g, g.net.nodeAt(26, 10)!, east.gate);
  // south houses along the vertical road (x=14 and x=16), west houses along the horizontal road (y=9 / y=11)
  for (let y = 12; y <= 18; y++) {
    for (const [x, f] of [[14, 0], [16, 4]] as [number, number][]) {
      const h = g.placeHouse(x, y, 0, f);
      if (h) link(g, h.node, g.net.nodeAt(x + DX[f], y + DY[f])!);
    }
  }
  for (let x = 2; x <= 9; x++) {
    for (const [y, f] of [[9, 2], [11, 6]] as [number, number][]) {
      const h = g.placeHouse(x, y, 1, f);
      if (h) link(g, h.node, g.net.nodeAt(x + DX[f], y + DY[f])!);
    }
  }
  if (control !== 'none') g.net.setControl(g.net.nodeAt(15, 10)!, control);
  // the scene measures the junction, not the lots: keep the car count it was calibrated with
  for (const h of g.houses) h.cars.length = 2;
  return { g, dests: [north, east] as Destination[] };
}

function run(control: 'none' | 'light' | 'roundabout' | 'avenue' | 'noleft', seconds: number, seed = 11) {
  const { g, dests } = scene(control === 'avenue' || control === 'noleft' ? 'none' : control, seed);
  if (control === 'avenue') {
    for (let x = 2; x < 26; x++) {
      const l = g.net.nodeAt(x, 10)!.links[0];
      if (l) g.net.setLinkStyle(l, 'avenue', 0);
    }
  }
  if (control === 'noleft') g.net.setRule(g.net.nodeAt(15, 10)!, 5);
  let poofs = 0;
  let tick = 0;
  while (g.time < seconds) {
    if (tick % 30 === 0) for (const d of dests) d.pins = Math.max(d.pins, 40);
    g.step(1 / 60);
    for (const e of g.events) if (e.type === 'poof') poofs++;
    g.events.length = 0;
    tick++;
  }
  return { control, score: g.score, poofs, cars: g.traffic.cars.length };
}

describe.skip('stuck diagnostics', () => {
  it('reports where cars get stuck at a plain junction', () => {
    const { g, dests } = scene('none');
    let tick = 0;
    const seen = new Set<number>();
    while (g.time < 240) {
      if (tick % 30 === 0) for (const d of dests) d.pins = Math.max(d.pins, 40);
      g.step(1 / 60);
      g.events.length = 0;
      for (const c of g.traffic.cars) {
        if (c.stuck > 20 && !seen.has(c.id)) {
          seen.add(c.id);
          const s = c.segs[c.i];
          const nextBox = c.segs.slice(c.i).find((x) => x.kind === 3);
          console.log('STUCK', {
            t: +g.time.toFixed(1), car: c.id, color: c.color, at: [+c.x.toFixed(2), +c.y.toFixed(2)],
            seg: s.kind, node: s.node ? [s.node.x, s.node.y, s.node.degree] : null,
            ticket: c.ticket ? [c.ticket.node.x, c.ticket.node.y] : null,
            req: c.reqJ ? [c.reqJ.node.x, c.reqJ.node.y] : null,
            move: [c.mEntry, c.mExit], gap: +c.gap.toFixed(3),
            nextBox: nextBox?.node ? [nextBox.node.x, nextBox.node.y] : null,
          });
        }
      }
      tick++;
    }
    // dump the junction state at (15,10)
    const j = g.net.nodeAt(15, 10)!.traffic as { inside: { id: number; mEntry: number; mExit: number }[]; requests: unknown[] } | null;
    console.log('J', j?.inside.map((c) => [c.id, c.mEntry, c.mExit]));
  });
});

describe('junction throughput', () => {
  it('lights and roundabouts beat a plain junction under heavy crossing flows', () => {
    // a saturated stop junction is chaotic: judge each setup over a few seeds
    const total = (control: Parameters<typeof run>[0]) => {
      const rs = [11, 12, 13].map((seed) => run(control, 240, seed));
      return { control, score: rs.reduce((t, r) => t + r.score, 0), poofs: rs.reduce((t, r) => t + r.poofs, 0) };
    };
    const none = total('none');
    const light = total('light');
    const ring = total('roundabout');
    const ave = total('avenue');
    const noleft = total('noleft');
    console.log(none, light, ring, ave, noleft);
    // the plain 4-way stop saturates in this scenario; equipment must clearly help
    expect(light.poofs + ring.poofs).toBe(0);
    expect(light.score).toBeGreaterThan(none.score * 1.15);
    expect(ring.score).toBeGreaterThan(none.score * 1.08);
    expect(ave.score).toBeGreaterThan(none.score * 1.04);
  });
});
