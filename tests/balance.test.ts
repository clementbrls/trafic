import { describe, it } from 'vitest';
import { playGame, summary, NAIVE, SMART, CASUAL, type BotOptions } from './bots';
import type { MapId } from '../src/game/maps';

/**
 * Balance probes (bots playing whole games). Not assertions:
 * `BALANCE=1 npx vitest run tests/balance.test.ts`
 */
declare const process: { env: Record<string, string | undefined> };
const enabled = !!process.env.BALANCE;
const SEEDS = [1, 2, 3, 4, 5, 6];

function batch(map: MapId, opt: BotOptions, seeds = SEEDS, portrait = false) {
  return seeds.map((s) => playGame(map, s, opt, 30, portrait));
}

describe.skipIf(!enabled)('balance probes', () => {
  it('naive vs smart bot', () => {
    for (const map of ['plaine', 'riviere', 'archipel'] as MapId[]) {
      console.log(`${map} CASUAL ${summary(batch(map, CASUAL))}`);
      console.log(`${map} NAIVE  ${summary(batch(map, NAIVE))}`);
      console.log(`${map} SMART  ${summary(batch(map, SMART))}`);
    }
  }, 900000);

  it('early game: houses vs demand', async () => {
    const { Game } = await import('../src/game/game');
    const { getMap } = await import('../src/game/maps');
    const { AutoBuilder } = await import('../src/game/autobuild');
    for (const seed of [1, 2, 3]) {
      const g = new Game(getMap('plaine'), false, seed);
      const bot = new AutoBuilder(g);
      bot.free = false;
      const firstPin = new Map<number, number>();
      let tick = 0;
      let pins = 0;
      let busy = 0;
      let samples = 0;
      const lines: string[] = [];
      while (g.time < 8 * 60 && g.state !== 'over') {
        if (g.state === 'week') g.chooseUpgrade(0);
        if (tick % 30 === 0) bot.connectAll();
        const before = g.dests.reduce((s, d) => s + d.pins + d.delivered, 0);
        g.step(1 / 60);
        g.events.length = 0;
        pins += g.dests.reduce((s, d) => s + d.pins + d.delivered, 0) - before;
        for (const d of g.dests) if (!firstPin.has(d.id) && (d.pins > 0 || d.delivered > 0)) firstPin.set(d.id, g.time - d.born);
        if (tick % 10 === 0) {
          const cars = g.houses.length * 2;
          busy += cars ? g.houses.reduce((s, h) => s + h.cars.filter((c) => c.state !== 'home').length, 0) / cars : 0;
          samples++;
        }
        if (tick % 3600 === 3599) {
          lines.push(`${Math.round(g.time / 60)}m: ${g.dests.length}B ${g.houses.length}H demand ${pins}/min cars busy ${Math.round((100 * busy) / samples)}% per house ${(pins / Math.max(1, g.houses.length)).toFixed(2)}/min`);
          pins = 0;
          busy = 0;
          samples = 0;
        }
        tick++;
      }
      console.log(`seed ${seed}\n  ${lines.join('\n  ')}\n  first pin after spawn: ${g.dests.map((d) => (firstPin.get(d.id) ?? -1).toFixed(0) + 's').join(' ')}`);
    }
  }, 300000);

  it('trip lengths', async () => {
    const { Game } = await import('../src/game/game');
    const { getMap } = await import('../src/game/maps');
    const { AutoBuilder } = await import('../src/game/autobuild');
    for (const seed of [1, 2]) {
      const g = new Game(getMap('plaine'), false, seed);
      const bot = new AutoBuilder(g);
      bot.free = false;
      let tick = 0;
      const lines: string[] = [];
      while (g.time < 15 * 60 && g.state !== 'over') {
        if (g.state === 'week') g.chooseUpgrade(0);
        if (tick % 30 === 0) bot.connectAll();
        g.step(1 / 60);
        g.events.length = 0;
        if (tick % (3 * 3600) === 3 * 3600 - 1) {
          const dist: number[] = [];
          for (const h of g.houses) {
            let bd = Infinity;
            for (const d of g.dests) if (d.color === h.color) bd = Math.min(bd, Math.hypot(h.x + 0.5 - d.cx, h.y + 0.5 - d.cy));
            if (bd < Infinity) dist.push(bd);
          }
          dist.sort((a, b) => a - b);
          const avg = dist.reduce((s, x) => s + x, 0) / dist.length;
          const trip = g.dests.reduce((s, d) => s + d.tripTime, 0) / g.dests.length;
          lines.push(`${Math.round(g.time / 60)}m map ${g.world.bounds.x1 - g.world.bounds.x0}x${g.world.bounds.y1 - g.world.bounds.y0}: house→building avg ${avg.toFixed(1)} tiles (median ${dist[dist.length >> 1].toFixed(1)}, max ${dist[dist.length - 1].toFixed(1)}), trip ${trip.toFixed(1)}s`);
        }
        tick++;
      }
      console.log(`seed ${seed}\n  ${lines.join('\n  ')}`);
    }
  }, 300000);

  it('early game pressure', async () => {
    const { Game } = await import('../src/game/game');
    const { getMap } = await import('../src/game/maps');
    // idle player: how long until game over?
    for (const seed of [1, 2, 3]) {
      const g = new Game(getMap('plaine'), false, seed);
      let firstLate = -1;
      while (g.time < 600 && g.state !== 'over') {
        if (g.state === 'week') g.chooseUpgrade(0);
        g.step(1 / 60);
        g.events.length = 0;
        if (firstLate < 0 && g.dests.some((d) => d.timer > 0)) firstLate = g.time;
      }
      console.log(`idle seed ${seed}: first overflow ${firstLate.toFixed(0)}s, game over ${g.time.toFixed(0)}s, houses ${g.houses.length}`);
    }
    // first overflow time for the bots
    for (const [name, opt] of [['casual', CASUAL], ['naive', NAIVE]] as [string, BotOptions][]) {
      const r = batch('plaine', opt, [1, 2, 3, 4]);
      console.log(name, r.map((x) => `w${x.week}`).join(' '), 'overflow per week:', r.map((x) => x.weeks.filter((w) => w.overflowSec > 0).map((w) => w.week).join('/') || '-').join(' '));
    }
  }, 900000);

  it('value of network speed (free roads)', () => {
    const base: BotOptions = { ...NAIVE, pay: false };
    console.log(`plaine streets  ${summary(batch('plaine', base))}`);
    console.log(`plaine avenues  ${summary(batch('plaine', { ...base, allAvenues: true }))}`);
    console.log(`plaine frontRng ${summary(batch('plaine', { ...base, frontRings: true }))}`);
  }, 900000);

  it('smart bot without each tool', () => {
    const variants: [string, BotOptions][] = [
      ['no roundabout', { ...SMART, allow: { ...SMART.allow, roundabout: false }, prefer: ['lights', 'roads', 'bridge', 'motorway'] }],
      ['no lights', { ...SMART, allow: { ...SMART.allow, light: false, noLeft: false }, prefer: ['roundabout', 'roads', 'bridge', 'motorway'] }],
      ['no avenue', { ...SMART, allow: { ...SMART.allow, avenue: false } }],
      ['no noLeft', { ...SMART, allow: { ...SMART.allow, noLeft: false } }],
    ];
    for (const [name, opt] of variants) console.log(`plaine ${name.padEnd(14)} ${summary(batch('plaine', opt))}`);
  }, 900000);

  it('where does it jam (smart, plaine)', async () => {
    const { Game } = await import('../src/game/game');
    const { getMap } = await import('../src/game/maps');
    const { AutoBuilder } = await import('../src/game/autobuild');
    const g = new Game(getMap('plaine'), false, 2);
    const bot = new AutoBuilder(g);
    bot.free = false;
    let tick = 0;
    while (g.time < 9 * 60 && g.state !== 'over') {
      if (g.state === 'week') g.chooseUpgrade(0);
      if (tick % 30 === 0) bot.connectAll();
      g.step(1 / 60);
      g.events.length = 0;
      tick++;
    }
    for (const d of g.dests) {
      const queued = g.traffic.cars.filter((c) => c.dest === d && c.state === 'driving').length;
      const lot = d.slots.filter((s) => s.car).length;
      const parkedStates = d.slots.map((s) => (s.car ? s.car.state[0] : '-')).join('');
      console.log('D', d.x, d.y, 'pins', d.pins, 'claimed', d.claimed, 'enRoute', queued, 'lot', lot, parkedStates, 'timer', d.timer.toFixed(1), 'rate', g.demandRate(d).toFixed(2), 'entryBusy', d.entryBusy, 'exitBusy', d.exitBusy);
    }
    const js = [...g.traffic.junctions].sort((a, b) => b.avgWait - a.avgWait).slice(0, 10);
    for (const j of js) {
      const n = j.node;
      const arms = n.links.map((l) => (l ? (l.other(n).isTerminal ? 'H' : 'R') : '.')).join('');
      console.log('J', n.x, n.y, 'wait', j.avgWait.toFixed(2), 'load', n.load.toFixed(2), 'arms', arms, 'major', j.majorMask.toString(2), 'req', j.requests.length, 'in', j.inside.length);
    }
    const loads = [...g.net.nodes.values()].filter((n) => n.kind === 'road').sort((a, b) => b.load - a.load).slice(0, 8);
    console.log('top loads', loads.map((n) => `${n.x},${n.y}:${n.load.toFixed(2)}(deg${n.degree})`).join(' '));
    console.log('inv', JSON.stringify(g.inv), 'cars', g.traffic.cars.length, 'houses', g.houses.length);
  }, 300000);

  it('what kills a city (naive, plaine)', async () => {
    const { Game } = await import('../src/game/game');
    const { getMap } = await import('../src/game/maps');
    const { AutoBuilder } = await import('../src/game/autobuild');
    for (const seed of [1, 2, 4]) {
      const g = new Game(getMap('plaine'), false, seed);
      const bot = new AutoBuilder(g);
      bot.free = false;
      let tick = 0;
      const hist = new Map<number, string[]>();
      while (g.time < 30 * 60 && g.state !== 'over') {
        if (g.state === 'week') g.chooseUpgrade(0);
        if (tick % 30 === 0) bot.connectAll();
        g.step(1 / 60);
        g.events.length = 0;
        if (tick % 600 === 0) {
          for (const d of g.dests) {
            const h = hist.get(d.id) ?? [];
            const enRoute = g.traffic.cars.filter((c) => c.dest === d).length;
            const idle = g.houses.filter((x) => x.color === d.color && g.linked(x, d)).reduce((s, x) => s + x.cars.filter((c) => c.state === 'home').length, 0);
            h.push(`t${Math.round(g.time)} pins${d.pins} cl${d.claimed} road${enRoute} idle${idle} trip${d.tripTime.toFixed(1)} rate${g.demandRate(d).toFixed(2)} lot${d.slots.filter((s) => s.car).length}`);
            hist.set(d.id, h.slice(-8));
          }
        }
        tick++;
      }
      const d = g.lostDest;
      console.log(`seed ${seed} lost at ${(g.time / 60).toFixed(1)} min, avg trip ${(g.stats.tripSum / Math.max(1, g.stats.trips)).toFixed(1)}s`);
      if (d) {
        for (const line of hist.get(d.id) ?? []) console.log('   ', line);
        const same = g.houses.filter((h) => h.color === d.color);
        const sameDests = g.dests.filter((x) => x.color === d.color);
        const states: Record<string, number> = {};
        for (const h of same) for (const c of h.cars) {
          const k = c.state + (c.dest ? (c.dest === d ? '→lost' : '→other') : '');
          states[k] = (states[k] ?? 0) + 1;
        }
        console.log('    colour houses', same.length, 'linked to lost', same.filter((h) => g.linked(h, d)).length,
          'near lost', g.nearbyHouses(d), 'dests of colour', sameDests.length,
          'pins per dest', sameDests.map((x) => x.pins).join(','), 'rates', sameDests.map((x) => g.demandRate(x).toFixed(2)).join(','),
          'trip', sameDests.map((x) => x.tripTime.toFixed(0)).join(','));
        console.log('    car states', JSON.stringify(states));
      }
    }
  }, 300000);

  it('where does trip time go (naive)', async () => {
    const { Game } = await import('../src/game/game');
    const { getMap } = await import('../src/game/maps');
    const { AutoBuilder } = await import('../src/game/autobuild');
    for (const seed of [1, 4]) {
      const g = new Game(getMap('plaine'), false, seed);
      const bot = new AutoBuilder(g);
      bot.free = false;
      let tick = 0;
      const acc: Record<string, number> = {};
      const add = (k: string, v: number) => (acc[k] = (acc[k] ?? 0) + v);
      const grants = new Map<unknown, number>();
      while (g.time < 30 * 60 && g.state !== 'over') {
        if (g.state === 'week') g.chooseUpgrade(0);
        if (tick % 30 === 0) bot.connectAll();
        g.step(1 / 60);
        g.events.length = 0;
        if (g.time > 8 * 60) {
          for (const c of g.traffic.cars) {
            if (c.state === 'leaving') add('leaving', 1);
            else if (c.state === 'driving') {
              if (c.v < 0.15) add(['stopped:free?', 'stopped:behind car', 'stopped:junction', 'stopped:lot gate'][c.limit], 1);
              else if (c.v < 0.6) add('slow', 1);
              else add('moving', 1);
            } else add(c.state, 1);
          }
          for (const j of g.traffic.junctions) for (const c of j.inside) if (c.i < c.boxIdx) grants.set(c, 1);
        }
        tick++;
      }
      const total = Object.values(acc).reduce((s, v) => s + v, 0);
      console.log(`seed ${seed} lost ${(g.time / 60).toFixed(1)}min carsOnRoadAvg ${(total / Math.max(1, (g.time - 480) * 60)).toFixed(1)}`);
      console.log('   ' + Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((v / total) * 100).toFixed(1)}%`).join(' | '));
    }
  }, 300000);

  it('week by week (smart, plaine)', () => {
    const r = playGame('plaine', 2, SMART);
    for (const w of r.weeks) console.log(JSON.stringify(w));
    console.log(summary([r]));
  }, 300000);
});
