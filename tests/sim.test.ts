import { describe, it, expect } from 'vitest';
import { Game } from '../src/game/game';
import { getMap, type MapId } from '../src/game/maps';
import { AutoBuilder } from '../src/game/autobuild';

interface RunStats {
  score: number;
  poofs: number;
  overlaps: number;
  nan: number;
  maxCars: number;
  week: number;
  over: boolean;
  time: number;
}

function simulate(map: MapId, seed: number, seconds: number, portrait = false): RunStats {
  const g = new Game(getMap(map), portrait, seed);
  const bot = new AutoBuilder(g);
  const dt = 1 / 60;
  let poofs = 0;
  let overlaps = 0;
  let nan = 0;
  let tick = 0;
  while (g.time < seconds) {
    if (g.state === 'week') g.chooseUpgrade(0);
    if (g.state === 'over') break;
    if (tick % 30 === 0) bot.connectAll();
    g.step(dt);
    for (const e of g.events) if (e.type === 'poof') poofs++;
    g.events.length = 0;
    if (tick % 20 === 0) {
      const cars = g.traffic.cars.filter((c) => c.state === 'driving');
      for (let i = 0; i < cars.length; i++) {
        const a = cars[i];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) nan++;
        for (let j = i + 1; j < cars.length; j++) {
          const b = cars[j];
          if (Math.hypot(a.x - b.x, a.y - b.y) < 0.1) overlaps++;
        }
      }
    }
    tick++;
  }
  return {
    score: g.score, poofs, overlaps, nan, maxCars: g.stats.maxCars, week: g.week, over: g.state === 'over', time: g.time,
  };
}

describe('traffic simulation', () => {
  it('runs a plain map with an auto-built network', () => {
    const s = simulate('plaine', 1234, 420);
    console.log('plaine', s);
    expect(s.nan).toBe(0);
    expect(s.score).toBeGreaterThan(40);
  });

  it('runs the river map in portrait', () => {
    const s = simulate('riviere', 99, 300, true);
    console.log('riviere', s);
    expect(s.nan).toBe(0);
    expect(s.score).toBeGreaterThan(20);
  });
});
