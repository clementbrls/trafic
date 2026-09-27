import { describe, it } from 'vitest';
import { Game } from '../src/game/game';
import { getMap } from '../src/game/maps';
import { DX, DY } from '../src/game/constants';
import type { RNode } from '../src/game/network';
import type { Destination } from '../src/game/entities';

/**
 * Junction laboratory: a 4-arm crossing with a destination at the end of each
 * arm and houses along the arms. House colours choose the movement mix.
 * Run with `LAB=1 npx vitest run tests/lab.test.ts`.
 */
declare const process: { env: Record<string, string | undefined> };

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
  if (g.net.checkRoadLink(a, b, d) !== 'ok') throw new Error(`link ${a.x},${a.y} ${b.x},${b.y}`);
  g.net.linkRoad(a, b, d);
}

type Control = 'stop' | 'light' | 'ring' | 'avenueEW' | 'prioEW';
/** per arm: [straight, left, right] house counts */
type Mix = [number, number, number];

// colour = destination: N 0, E 1, S 2, W 3
// for each arm: target colour for [straight, left, right]
const TARGETS: Record<string, [number, number, number]> = {
  W: [1, 0, 2],
  E: [3, 2, 0],
  N: [2, 1, 3],
  S: [0, 3, 1],
};
// house slots per arm: [x, y, facing]
const SLOTS: Record<string, [number, number, number][]> = {
  E: [[18, 9, 2], [18, 11, 6], [19, 9, 2], [19, 11, 6], [20, 9, 2], [20, 11, 6]],
  W: [[12, 9, 2], [12, 11, 6], [11, 9, 2], [11, 11, 6], [10, 9, 2], [10, 11, 6]],
  N: [[14, 7, 0], [16, 7, 4], [14, 6, 0], [16, 6, 4], [14, 5, 0], [16, 5, 4]],
  S: [[14, 13, 0], [16, 13, 4], [14, 14, 0], [16, 14, 4], [14, 15, 0], [16, 15, 4]],
};

function lab(control: Control, mix: Mix, opts: { blocks?: boolean; noLeft?: boolean } = {}) {
  const g = new Game(getMap('plaine'), false, 17, { demo: true });
  g.world.bounds = { x0: 0, y0: 0, x1: g.world.w, y1: g.world.h };
  road(g, 9, 10, 21, 10);
  road(g, 15, 4, 15, 16);
  if (opts.blocks) {
    // four small blocks around the centre so a left turn can become three rights
    road(g, 17, 10, 17, 12);
    road(g, 17, 12, 15, 12);
    road(g, 13, 10, 13, 8);
    road(g, 13, 8, 15, 8);
    road(g, 15, 8, 17, 8);
    road(g, 17, 8, 17, 10);
    road(g, 15, 12, 13, 12);
    road(g, 13, 12, 13, 10);
  }
  const dN = g.placeDestination(14, 2, 0, 15, 3, 2);
  const dE = g.placeDestination(22, 9, 1, 22, 10, 4);
  const dS = g.placeDestination(15, 17, 2, 15, 17, 6);
  const dW = g.placeDestination(7, 9, 3, 8, 10, 0);
  link(g, g.net.nodeAt(15, 4)!, dN.gate);
  link(g, g.net.nodeAt(21, 10)!, dE.gate);
  link(g, g.net.nodeAt(15, 16)!, dS.gate);
  link(g, g.net.nodeAt(9, 10)!, dW.gate);
  for (const arm of ['N', 'E', 'S', 'W']) {
    const colours: number[] = [];
    for (let k = 0; k < 3; k++) for (let i = 0; i < mix[k]; i++) colours.push(TARGETS[arm][k]);
    SLOTS[arm].slice(0, colours.length).forEach(([x, y, f], i) => {
      const h = g.placeHouse(x, y, colours[i], f);
      if (!h) throw new Error('house');
      link(g, h.node, g.net.nodeAt(x + DX[f], y + DY[f])!);
    });
  }
  const c = g.net.nodeAt(15, 10)!;
  if (opts.noLeft) g.net.setRule(c, 5);
  if (control === 'light') g.net.setControl(c, 'light');
  if (control === 'ring') g.net.setControl(c, 'roundabout');
  if (control === 'prioEW') g.net.setRule(c, 1);
  if (control === 'avenueEW') {
    for (let x = 9; x < 21; x++) {
      const l = g.net.nodeAt(x, 10)!.links[0];
      if (l) g.net.setLinkStyle(l, 'avenue', 0);
    }
  }
  return { g, dests: [dN, dE, dS, dW] as Destination[] };
}

function measure(control: Control, mix: Mix, seconds = 300, demand = 40, opts: { blocks?: boolean; noLeft?: boolean } = {}) {
  const { g, dests } = lab(control, mix, opts);
  let tick = 0;
  let poofs = 0;
  let waitSum = 0;
  let waitN = 0;
  const center = g.net.nodeAt(15, 10)!;
  while (g.time < seconds) {
    if (tick % 30 === 0) for (const d of dests) d.pins = Math.max(d.pins, demand);
    g.step(1 / 60);
    for (const e of g.events) if (e.type === 'poof') poofs++;
    g.events.length = 0;
    if (tick % 60 === 0) {
      const j = center.traffic as { avgWait: number } | null;
      if (j) {
        waitSum += j.avgWait;
        waitN++;
      }
    }
    tick++;
  }
  return { control, mix: mix.join('/'), trips: g.score, perMin: +(g.score / (seconds / 60)).toFixed(1), wait: +(waitSum / Math.max(1, waitN)).toFixed(2), poofs };
}

describe.skipIf(!process.env.LAB)('junction lab', () => {
  it('capacity by control and movement mix', () => {
    const mixes: Mix[] = [[4, 1, 1], [2, 2, 2], [2, 3, 1], [1, 0, 0], [2, 1, 0]];
    for (const mix of mixes) {
      const rows = (['stop', 'prioEW', 'light', 'ring', 'avenueEW'] as Control[]).map((c) => measure(c, mix));
      console.log(rows.map((r) => `${r.mix} ${r.control.padEnd(8)} ${String(r.perMin).padStart(6)}/min wait ${r.wait} poofs ${r.poofs}`).join('\n'));
    }
  }, 600000);

  it('left-turn ban with detour blocks', () => {
    const mixes: Mix[] = [[4, 1, 1], [2, 2, 2], [3, 2, 1]];
    for (const mix of mixes) {
      const rows: string[] = [];
      for (const control of ['stop', 'light', 'ring'] as Control[]) {
        for (const noLeft of [false, true]) {
          if (control === 'ring' && noLeft) continue;
          const r = measure(control, mix, 300, 40, { blocks: true, noLeft });
          rows.push(`${r.mix} ${(control + (noLeft ? '+noLeft' : '')).padEnd(14)} ${String(r.perMin).padStart(6)}/min wait ${r.wait} poofs ${r.poofs}`);
        }
      }
      console.log(rows.join('\n'));
    }
  }, 600000);
});
