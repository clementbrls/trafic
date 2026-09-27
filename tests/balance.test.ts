import { describe, it } from 'vitest';
import { Game } from '../src/game/game';
import { getMap, type MapId } from '../src/game/maps';
import { AutoBuilder } from '../src/game/autobuild';

/**
 * Balance probes. Not assertions: run with `BALANCE=1 npx vitest run tests/balance.test.ts`
 * to print how long naive strategies survive.
 */
declare const process: { env: Record<string, string | undefined> };
const enabled = !!process.env.BALANCE;

function run(map: MapId, seed: number, mode: 'idle' | 'pay' | 'free', maxMin = 30) {
  const g = new Game(getMap(map), false, seed);
  const bot = new AutoBuilder(g);
  bot.free = mode === 'free';
  let tick = 0;
  let poofs = 0;
  let peakPins = 0;
  while (g.time < maxMin * 60 && g.state !== 'over') {
    if (g.state === 'week') {
      const i = g.pendingChoices.findIndex((c) => c.kind === 'roads');
      g.chooseUpgrade(i >= 0 ? i : 0);
    }
    if (mode !== 'idle' && tick % 30 === 0) bot.connectAll();
    g.step(1 / 60);
    for (const e of g.events) if (e.type === 'poof') poofs++;
    g.events.length = 0;
    for (const d of g.dests) peakPins = Math.max(peakPins, d.pins);
    tick++;
  }
  const lost = g.lostDest;
  if (lost) {
    const m = g.distMap(lost);
    const same = g.houses.filter((h) => h.color === lost.color);
    console.log('LOST', {
      pins: lost.pins, claimed: lost.claimed, gateDeg: lost.gate.degree,
      born: +(lost.born / 60).toFixed(1),
      housesSameColor: same.length,
      reachable: same.filter((h) => m.has(h.node)).length,
      carsOut: same.reduce((s, h) => s + h.cars.filter((c) => c.state !== 'home').length, 0),
      carsStates: same.flatMap((h) => h.cars.map((c) => c.state)).join(','),
      destsSameColor: g.dests.filter((d) => d.color === lost.color).length,
      rate: +g.demandRate(lost).toFixed(3),
    });
  }
  return {
    map, seed, mode,
    minutes: +(g.time / 60).toFixed(1),
    week: g.week,
    score: g.score,
    over: g.state === 'over',
    houses: g.houses.length,
    dests: g.dests.length,
    roadsLeft: g.inv.roads,
    roadTiles: g.net.roadCount(),
    maxCars: g.stats.maxCars,
    poofs,
    peakPins,
  };
}

describe.skipIf(!enabled)('balance probes', () => {
  it('idle', () => {
    for (const m of ['plaine', 'riviere'] as MapId[]) console.log(run(m, 1, 'idle'));
  });
  it('bot paying for roads', () => {
    for (const seed of [1, 2, 3]) console.log(run('plaine', seed, 'pay'));
    console.log(run('riviere', 1, 'pay'));
    console.log(run('archipel', 1, 'pay'));
  }, 600000);
  it('bot with free roads', () => {
    for (const seed of [1, 2]) console.log(run('plaine', seed, 'free', 25));
  }, 600000);
});
