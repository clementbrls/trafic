import { Game } from '../src/game/game';
import { getMap, type MapId } from '../src/game/maps';
import { AutoBuilder } from '../src/game/autobuild';
import { Builder } from '../src/game/builder';
import type { Junction } from '../src/game/traffic';
import type { UpgradeKind } from '../src/game/game';

/** queue length at which the smart bot equips a junction */
export const QUEUE_EQUIP = 0.9;

export interface BotOptions {
  /** use roundabouts / lights on congested junctions */
  equip: boolean;
  /** which items the bot is allowed to use */
  allow: Partial<Record<'roundabout' | 'light' | 'noLeft' | 'avenue', boolean>>;
  /** upgrade preference order */
  prefer: UpgradeKind[];
  /** bot pays for its roads */
  pay: boolean;
  /** seconds between two building passes (reaction time) */
  react?: number;
  /** turn every street into an avenue (tests the value of speed) */
  allAvenues?: boolean;
  /** free roundabouts in front of every destination (tests the entrance funnel) */
  frontRings?: boolean;
}

/** a slower player: reacts every 6 s and does not equip junctions */
export const CASUAL: BotOptions = { ...{ equip: false, allow: {}, prefer: ['roads', 'bridge', 'roundabout', 'lights', 'motorway'] as UpgradeKind[], pay: true }, react: 6 };

export const NAIVE: BotOptions = {
  equip: false,
  allow: {},
  prefer: ['roads', 'bridge', 'roundabout', 'lights', 'motorway'],
  pay: true,
};

export const SMART: BotOptions = {
  equip: true,
  allow: { roundabout: true, light: true, noLeft: true, avenue: true },
  prefer: ['roundabout', 'lights', 'roads', 'bridge', 'motorway'],
  pay: true,
};

export interface WeekStat {
  week: number;
  trips: number;
  roadsLeft: number;
  roadTiles: number;
  houses: number;
  dests: number;
  cars: number;
  overflowSec: number;
}

export interface GameResult {
  map: MapId;
  seed: number;
  minutes: number;
  week: number;
  score: number;
  over: boolean;
  weeks: WeekStat[];
  noRoadsSec: number;
  equipped: number;
  avenues: number;
  lostReason: string;
  poofs: number;
}

/** Plays a full game with a simple strategy. */
export function playGame(map: MapId, seed: number, opt: BotOptions, maxMin = 30, portrait = false): GameResult {
  const g = new Game(getMap(map), portrait, seed);
  const bot = new AutoBuilder(g);
  bot.free = !opt.pay;
  const b = new Builder(g);
  let tick = 0;
  let noRoads = 0;
  let equipped = 0;
  let avenues = 0;
  let poofs = 0;
  const weeks: WeekStat[] = [];
  let lastTrips = 0;
  let overflow = 0;
  while (g.time < maxMin * 60 && g.state !== 'over') {
    if (g.state === 'week') {
      weeks.push({
        week: g.week - 1, trips: g.score - lastTrips, roadsLeft: g.inv.roads, roadTiles: g.net.roadCount(),
        houses: g.houses.length, dests: g.dests.length, cars: g.traffic.cars.length, overflowSec: +overflow.toFixed(1),
      });
      lastTrips = g.score;
      overflow = 0;
      let pick = -1;
      const order: UpgradeKind[] = g.world.waterInBounds() > 0 && g.inv.bridges < 2 ? ['bridge', ...opt.prefer] : opt.prefer;
      for (const k of order) {
        const want = k === 'roads' ? g.inv.roads < 25 || opt.prefer[0] === 'roads' : true;
        const i = g.pendingChoices.findIndex((c) => c.kind === k);
        if (i >= 0 && want) {
          pick = i;
          break;
        }
      }
      g.chooseUpgrade(pick >= 0 ? pick : 0);
    }
    if (tick % Math.round((opt.react ?? 0.5) * 60) === 0) {
      bot.connectAll();
      if (opt.frontRings) {
        for (const d of g.dests) {
          const f = g.net.nodeAt(d.frontX, d.frontY);
          if (f && f.kind === 'road' && f.degree >= 3 && f.control !== 'roundabout') g.net.setControl(f, 'roundabout');
        }
      }
      if (opt.allAvenues) {
        for (const l of g.net.links) {
          if (l.kind === 'road' && l.tier === 'street' && !l.a.isTerminal && !l.b.isTerminal) g.net.setLinkStyle(l, 'avenue', 0);
        }
      }
    }
    if (opt.equip && tick % 300 === 150) {
      // equip the most congested junction
      let worst: Junction | null = null;
      for (const j of g.traffic.junctions) {
        if (j.node.control !== 'none' || j.node.degree < 3) continue;
        // priority junctions (through road) only need help if the side road really jams
        const need = j.majorMask === 0 ? QUEUE_EQUIP : QUEUE_EQUIP * 2;
        if (j.queue < need) continue;
        if (!worst || j.queue > worst.queue) worst = j;
      }
      if (worst) {
        const n = worst.node;
        let roadArms = 0;
        for (const l of n.links) if (l && !l.other(n).isTerminal) roadArms++;
        if (opt.allow.roundabout && g.inv.roundabouts > 0 && roadArms >= 3) {
          b.tap(n.cx, n.cy, 'roundabout');
          equipped++;
        } else if (opt.allow.light && g.inv.lights > 0 && roadArms >= 4) {
          b.tap(n.cx, n.cy, 'light');
          if (opt.allow.noLeft && roadArms >= 4) b.tap(n.cx, n.cy, 'rules');
          equipped++;
        }
      }
    }
    if (opt.allow.avenue && tick % 600 === 300 && g.typesUnlocked && g.inv.roads > 30) {
      // upgrade the busiest street links to avenues
      const scored: [number, import('../src/game/network').Link][] = [];
      for (const l of g.net.links) {
        if (l.kind !== 'road' || l.tier === 'avenue' || l.a.isTerminal || l.b.isTerminal) continue;
        scored.push([l.a.load + l.b.load, l]);
      }
      scored.sort((x, y) => y[0] - x[0]);
      for (const [s, l] of scored.slice(0, 4)) {
        if (s < 0.5 || g.inv.roads <= 25) break;
        g.net.setLinkStyle(l, 'avenue', 0);
        g.inv.roads--;
        avenues++;
      }
    }
    g.step(1 / 60);
    if (g.inv.roads <= 0) noRoads += 1 / 60;
    for (const d of g.dests) if (d.timer > 0) overflow += 1 / 60 / Math.max(1, g.dests.length);
    for (const e of g.events) if (e.type === 'poof') poofs++;
    g.events.length = 0;
    tick++;
  }
  let lostReason = '';
  const lost = g.lostDest;
  if (lost) {
    const same = g.houses.filter((h) => h.color === lost.color);
    const linked = same.filter((h) => g.linked(h, lost)).length;
    lostReason = linked === 0 ? 'disconnected' : lost.claimed >= lost.pins - 1 ? 'congestion' : 'supply';
  }
  return {
    map, seed, minutes: +(g.time / 60).toFixed(1), week: g.week, score: g.score, over: g.state === 'over',
    weeks, noRoadsSec: Math.round(noRoads), equipped, avenues, lostReason, poofs,
  };
}

export function summary(rs: GameResult[]): string {
  const avg = (f: (r: GameResult) => number) => (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(1);
  const reasons = rs.map((r) => r.lostReason || 'alive').join(',');
  return `n=${rs.length} weeks=${avg((r) => r.week)} min=${avg((r) => r.minutes)} score=${avg((r) => r.score)} noRoadsSec=${avg((r) => r.noRoadsSec)} equipped=${avg((r) => r.equipped)} poofs=${avg((r) => r.poofs)} [${reasons}] weeks: ${rs.map((r) => r.week).join(' ')}`;
}
