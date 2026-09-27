import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import {
  DX, DY, TERM, opp, PIN_PATIENCE, LATE_OVERFLOW, PIN_HARD_CAP, OVERFLOW_TIME, CARS_PER_HOUSE, DAY_LENGTH, WEEK_DAYS, COLOR_COUNT,
} from './constants';
import { World } from './world';
import { Network, type RNode, type Link } from './network';
import { Traffic, type TrafficHost } from './traffic';
import { House, Destination } from './entities';
import { Car } from './car';
import { distancesFrom } from './pathfind';
import { generateWorld, boundsForWeek, type MapPreset } from './maps';

export interface Inventory {
  roads: number;
  bridges: number;
  roundabouts: number;
  lights: number;
  motorways: number;
}

export type UpgradeKind = 'roads' | 'bridge' | 'roundabout' | 'lights' | 'motorway';

export interface Upgrade {
  kind: UpgradeKind;
  amount: number;
}

export type GameEvent =
  | { type: 'deliver'; dest: Destination }
  | { type: 'house'; house: House }
  | { type: 'dest'; dest: Destination; newColor: boolean }
  | { type: 'week'; week: number; choices: Upgrade[]; bonus: number }
  | { type: 'over'; dest: Destination }
  | { type: 'overflow'; dest: Destination }
  | { type: 'poof'; x: number; y: number; color: number }
  | { type: 'bounds' }
  | { type: 'unlock'; what: 'types' | 'rules' }
  | { type: 'rush'; on: boolean };

/** demand multiplier per week day (Mon..Sun): busy end of week, calm weekend */
const DAY_DEMAND = [0.9, 1.0, 1.1, 1.3, 1.45, 0.8, 0.6];
export const RUSH_THRESHOLD = 1.2;
/** week from which avenues / one-way streets and junction rules are available */
export const UNLOCK_TYPES_WEEK = 2;
export const UNLOCK_RULES_WEEK = 3;

/** free roads given at the end of week w (grows with the city) */
export function weekBonusRoads(week: number): number {
  return 8 + Math.min(10, week);
}
/** a destination stops attracting new houses once it serves this many */
const HOUSES_PER_DEST = 3;
/** houses per residential district */
const DISTRICT_CAP = 2;
/** trips per second asked by one house at the start of the game */
const HOUSE_RATE = 0.079;
/** growth of that rate (quadratic in minutes: flat early, steep late) */
const DEMAND_GROWTH = 0.0015;
/** a destination always has at least this much demand, even without houses */
const MIN_HOUSEHOLDS = 1;
/** demand of a destination counts at most this many households */
const HOUSEHOLD_CAP = 5;
/** seconds between house spawns: start, floor, and decrease per minute */
const HOUSE_EVERY_START = 28;
const HOUSE_EVERY_MIN = 5;
const HOUSE_EVERY_DROP = 2;
/** seconds before an unconnected destination starts asking (the first one leaves time to read the tutorial) */
const FIRST_GRACE = 20;
const DEST_GRACE = 8;
/** pin clock when a destination goes live: its first demand shows up right away */
const FIRST_PIN = 0.9;
const START_ROADS = 32;

/** Seconds of game time between destination spawns (cumulative schedule). */
const DEST_SCHEDULE = [0, 48, 112, 180, 255, 330, 410, 490, 575, 660, 750, 840, 930, 1020, 1110, 1200];
/** indexes (in spawn order) that introduce a new colour */
const NEW_COLOR_AT = new Set([0, 1, 3, 5, 8, 11]);

/** a residential neighbourhood: houses of one colour grow around its centre, away from the buildings */
export interface District {
  color: number;
  x: number;
  y: number;
  houses: House[];
  /** no room left around the centre */
  full: boolean;
}

export class Game implements TrafficHost {
  readonly preset: MapPreset;
  readonly world: World;
  readonly net: Network;
  readonly traffic: Traffic;
  readonly rng: Rng;
  readonly portrait: boolean;
  readonly houses: House[] = [];
  readonly dests: Destination[] = [];
  readonly districts: District[] = [];
  readonly events: GameEvent[] = [];
  readonly inv: Inventory;
  /** colour ids in introduction order */
  readonly colors: number[] = [];
  time = 0;
  score = 0;
  week = 1;
  state: 'play' | 'week' | 'over' = 'play';
  pendingChoices: Upgrade[] = [];
  lostDest: Destination | null = null;
  /** free mode: the player kept going after losing, buildings can no longer end the game */
  free = false;
  demo = false;
  private destIndex = 0;
  private destRetry = 0;
  private wasRush = false;
  private householdClock = 0;
  private houseClock = 12;
  private dispatchClock = 0;
  private distVersion = -1;
  private distMaps = new Map<Destination, Map<RNode, number>>();
  private retMaps = new Map<Destination, Map<RNode, number>>();
  private gateMap = new Map<RNode, Destination>();
  private syncedVersion = -1;
  private colorOrder: number[];
  /** statistics */
  stats = { roadsBuilt: 0, maxCars: 0, tripSum: 0, trips: 0 };
  /** trips and average trip time of every finished week */
  readonly weekStats: { trips: number; avgTrip: number }[] = [];
  private weekMark = { score: 0, trips: 0, tripSum: 0 };

  /** statistics of the week in progress (used for the game-over summary) */
  currentWeekStats(): { trips: number; avgTrip: number } {
    const n = this.stats.trips - this.weekMark.trips;
    return { trips: this.score - this.weekMark.score, avgTrip: n > 0 ? (this.stats.tripSum - this.weekMark.tripSum) / n : 0 };
  }

  constructor(preset: MapPreset, portrait: boolean, seed: number, opts: { demo?: boolean } = {}) {
    this.preset = preset;
    this.portrait = portrait;
    this.demo = !!opts.demo;
    this.rng = new Rng(seed);
    this.world = generateWorld(preset, portrait);
    this.net = new Network(this.world);
    this.traffic = new Traffic(this.net, this);
    this.inv = { roads: START_ROADS, bridges: preset.startBridges, roundabouts: 0, lights: 0, motorways: 0 };
    this.colorOrder = this.rng.shuffle([...Array(COLOR_COUNT).keys()]);
    if (!this.demo) this.spawnDestination();
  }

  // ------------------------------------------------------------------
  // TrafficHost
  // ------------------------------------------------------------------

  now(): number {
    return this.time;
  }

  destOfGate(n: RNode): Destination | undefined {
    return this.gateMap.get(n);
  }

  onDeliver(car: Car, dest: Destination): void {
    const trip = this.time - car.dispatchedAt;
    dest.tripTime = dest.delivered === 0 ? trip : dest.tripTime + (trip - dest.tripTime) * 0.2;
    this.stats.tripSum += trip;
    this.stats.trips++;
    dest.pins = Math.max(0, dest.pins - 1);
    dest.claimed = Math.max(0, dest.claimed - 1);
    dest.pulse = 1;
    dest.delivered++;
    this.score++;
    this.events.push({ type: 'deliver', dest });
  }

  onArriveHome(_car: Car): void {}

  onPoof(car: Car, x: number, y: number): void {
    this.events.push({ type: 'poof', x, y, color: car.color });
  }

  onAbandon(_car: Car, dest: Destination): void {
    dest.claimed = Math.max(0, dest.claimed - 1);
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  get day(): number {
    return Math.floor(this.time / DAY_LENGTH) % WEEK_DAYS;
  }

  /** smooth demand multiplier following the weekly rhythm */
  get rushFactor(): number {
    const d = (this.time / DAY_LENGTH) % WEEK_DAYS;
    const i = Math.floor(d);
    const f = d - i;
    const a = DAY_DEMAND[i];
    const b = DAY_DEMAND[(i + 1) % WEEK_DAYS];
    // hold the day's value, blend into the next one over the last 30% of the day
    const t = f < 0.7 ? 0 : (f - 0.7) / 0.3;
    const s = t * t * (3 - 2 * t);
    return a + (b - a) * s;
  }

  get isRush(): boolean {
    return this.rushFactor >= RUSH_THRESHOLD;
  }

  get typesUnlocked(): boolean {
    return this.week >= UNLOCK_TYPES_WEEK || this.demo;
  }

  get rulesUnlocked(): boolean {
    return this.week >= UNLOCK_RULES_WEEK || this.demo;
  }

  get weekProgress(): number {
    const wl = DAY_LENGTH * WEEK_DAYS;
    return (this.time % wl) / wl;
  }

  houseAt(x: number, y: number): House | undefined {
    const n = this.net.nodeAt(x, y);
    if (!n || n.kind !== 'house') return undefined;
    return this.houses.find((h) => h.node === n);
  }

  destAt(x: number, y: number): Destination | undefined {
    return this.dests.find((d) => d.occupies(x, y));
  }

  /** is the tile free for any building */
  private freeTile(x: number, y: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, y) || !w.isLand(x, y)) return false;
    const i = w.idx(x, y);
    if (this.net.nodes.has(i) || this.net.reserved.has(i) || this.net.mwOver.has(i)) return false;
    for (const d of this.dests) if (d.frontX === x && d.frontY === y) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // Spawning
  // ------------------------------------------------------------------

  private pickNewColor(): number {
    for (const c of this.colorOrder) if (!this.colors.includes(c)) return c;
    return this.colorOrder[0];
  }

  private spawnDestination(): Destination | null {
    const idx = this.destIndex;
    let color: number;
    const newColor = this.colors.length === 0 || (NEW_COLOR_AT.has(idx) && this.colors.length < COLOR_COUNT);
    if (newColor) color = this.pickNewColor();
    else {
      // reuse the colour with the most houses per destination (most demand to absorb)
      const weights = this.colors.map((c) => {
        const h = this.houses.filter((x) => x.color === c).length;
        const d = this.dests.filter((x) => x.color === c).length;
        return (h + 1) / (d + 0.5);
      });
      color = this.colors[Math.max(0, this.rng.weighted(weights))];
    }
    const spot = this.findDestSpot();
    if (!spot) return null;
    this.destIndex++;
    if (!this.colors.includes(color)) this.colors.push(color);
    const [x, y, gx, gy, gdir] = spot;
    const gate = this.net.addTerminal(gx, gy, 'gate', -1, gdir);
    const d = new Destination(x, y, color, gate, gdir, this.time);
    gate.ownerId = d.id;
    for (const [tx, ty] of d.tiles) {
      const i = this.world.idx(tx, ty);
      this.world.trees[i] = 0;
      if (tx !== gx || ty !== gy) this.net.reserved.set(i, d.id);
    }
    this.dests.push(d);
    this.gateMap.set(gate, d);
    this.events.push({ type: 'dest', dest: d, newColor });
    // a couple of houses to get a new colour going (one for an extra building)
    const n = newColor ? 2 : 1;
    for (let k = 0; k < n; k++) this.spawnHouse(color, d);
    return d;
  }

  private findDestSpot(): [number, number, number, number, number] | null {
    const w = this.world;
    const b = w.bounds;
    let best: [number, number, number, number, number] | null = null;
    let bestScore = -Infinity;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const first = this.dests.length === 0;
    for (let attempt = 0; attempt < 220; attempt++) {
      const x = this.rng.int(b.x0 + 1, b.x1 - 2);
      const y = this.rng.int(b.y0 + 1, b.y1 - 2);
      if (x + 1 >= b.x1 - 1 || y + 1 >= b.y1 - 1) continue;
      let ok = true;
      for (let dy = 0; dy < 2 && ok; dy++) for (let dx = 0; dx < 2 && ok; dx++) if (!this.freeTile(x + dx, y + dy)) ok = false;
      if (!ok) continue;
      // keep a one-tile ring around the footprint free of other buildings
      let crowd = 0;
      for (let dy = -1; dy <= 2; dy++) {
        for (let dx = -1; dx <= 2; dx++) {
          if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) continue;
          const tx = x + dx;
          const ty = y + dy;
          const i = w.idx(tx, ty);
          if (!w.inMap(tx, ty)) continue;
          if (this.net.reserved.has(i) || (this.net.nodes.get(i)?.isTerminal ?? false)) crowd += 2;
          else if (this.net.nodes.has(i)) crowd += 0.4;
          if (w.isWater(tx, ty)) crowd += 0.3;
        }
      }
      if (crowd > 1.5) continue;
      const mx = x + 1;
      const my = y + 1;
      let minD = Infinity;
      for (const d of this.dests) minD = Math.min(minD, Math.hypot(d.cx - mx, d.cy - my));
      if (!first && minD < 5) continue;
      // choose the gate: tile + outward dir with a free front tile, facing the centre
      const gates: [number, number, number][] = [
        [x, y, 6], [x + 1, y, 6], [x + 1, y, 0], [x + 1, y + 1, 0],
        [x + 1, y + 1, 2], [x, y + 1, 2], [x, y + 1, 4], [x, y, 4],
      ];
      let gBest: [number, number, number] | null = null;
      let gScore = -Infinity;
      for (const g of gates) {
        const fx = g[0] + DX[g[2]];
        const fy = g[1] + DY[g[2]];
        if (!this.freeTile(fx, fy)) continue;
        // and something beyond the front to connect to
        const f2x = fx + DX[g[2]];
        const f2y = fy + DY[g[2]];
        const toC = (cx - fx) * DX[g[2]] + (cy - fy) * DY[g[2]];
        const s = toC * 0.25 + (w.isLand(f2x, f2y) ? 0.8 : 0) + this.rng.next() * 0.6;
        if (s > gScore) {
          gScore = s;
          gBest = g;
        }
      }
      if (!gBest) continue;
      let score: number;
      if (first) score = -Math.hypot(mx - cx, my - cy) + this.rng.next();
      else score = -Math.abs(minD - 7.5) * 0.5 - crowd + this.rng.next() * 2 - Math.hypot(mx - cx, my - cy) * 0.12;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y, gBest[0], gBest[1], gBest[2]];
      }
    }
    return best;
  }

  /** nearest destination of a colour to a point */
  private nearestDest(color: number, x: number, y: number): Destination | null {
    let best: Destination | null = null;
    let bd = Infinity;
    for (const d of this.dests) {
      if (d.color !== color) continue;
      const dd = Math.hypot(x - d.cx, y - d.cy);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }

  /** how far districts sit from their building: grows with the map */
  private districtRange(): [number, number] {
    const b = this.world.bounds;
    const span = Math.min(b.x1 - b.x0, b.y1 - b.y0);
    return [clamp(span * 0.36, 3.5, 7), clamp(span * 0.68, 6, 12.5)];
  }

  /** Pick a spot for a new district served by `near`. */
  private newDistrict(color: number, near: Destination): District | null {
    const w = this.world;
    const b = w.bounds;
    const [rMin, rMax] = this.districtRange();
    let best: District | null = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 80; attempt++) {
      const r = this.rng.range(rMin, rMax);
      const a = this.rng.range(0, Math.PI * 2);
      const x = near.cx + Math.cos(a) * r;
      const y = near.cy + Math.sin(a) * r;
      if (x < b.x0 + 1.5 || y < b.y0 + 1.5 || x > b.x1 - 1.5 || y > b.y1 - 1.5) continue;
      // served by this building, not by another one of the colour
      if (this.nearestDest(color, x, y) !== near) continue;
      // room for a few houses
      let free = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (this.freeTile(Math.floor(x) + dx, Math.floor(y) + dy)) free++;
      if (free < 12) continue;
      let score = free * 0.12 + this.rng.next() * 1.5;
      // keep clear of the buildings and of the other districts
      for (const d of this.dests) {
        const dd = Math.hypot(d.cx - x, d.cy - y);
        if (dd < 3) score -= (3 - dd) * 2;
      }
      for (const q of this.districts) {
        const dd = Math.hypot(q.x - x, q.y - y);
        if (dd < 4) score -= (4 - dd) * (q.color === color ? 1 : 2);
      }
      // crossing water costs bridges
      const steps = Math.ceil(r * 2);
      let water = 0;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        if (w.isWater(Math.floor(near.cx + (x - near.cx) * t), Math.floor(near.cy + (y - near.cy) * t))) water++;
      }
      score -= water * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { color, x, y, houses: [], full: false };
      }
    }
    if (best) this.districts.push(best);
    return best;
  }

  private spawnHouse(color: number, near: Destination): House | null {
    // fill the building's districts first, then open a new one
    let district: District | null = null;
    for (const q of this.districts) {
      if (q.color !== color || q.full || q.houses.length >= DISTRICT_CAP) continue;
      if (this.nearestDest(color, q.x, q.y) !== near) continue;
      if (!district || q.houses.length > district.houses.length) district = q;
    }
    for (let tries = 0; tries < 2; tries++) {
      if (!district) district = this.newDistrict(color, near);
      if (!district) return null;
      const h = this.placeHouseIn(district, color, near);
      if (h) {
        district.houses.push(h);
        return h;
      }
      district.full = true;
      district = null;
    }
    return null;
  }

  private placeHouseIn(district: District, color: number, near: Destination): House | null {
    const w = this.world;
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 90; attempt++) {
      const r = this.rng.range(0, 2.6);
      const a = this.rng.range(0, Math.PI * 2);
      const x = Math.floor(district.x + Math.cos(a) * r);
      const y = Math.floor(district.y + Math.sin(a) * r);
      if (!this.freeTile(x, y)) continue;
      // needs at least one free orthogonal side (or a road) for its driveway
      let exits = 0;
      let crowd = 0;
      for (let d = 0; d < 8; d += 2) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        const n = this.net.nodeAt(nx, ny);
        if (this.freeTile(nx, ny) || (n && n.kind === 'road' && !n.links[opp(d)])) exits++;
      }
      if (exits === 0) continue;
      let adj = 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!w.inMap(nx, ny)) continue;
        const i = w.idx(nx, ny);
        if (this.net.reserved.has(i)) crowd++;
        const n = this.net.nodes.get(i);
        if (n?.kind === 'house') {
          const h = this.houses.find((q) => q.node === n);
          if (h && h.color === color) adj++;
          else crowd += 0.5;
        }
        if (n?.kind === 'gate') crowd += 2;
      }
      if (crowd >= 2) continue;
      const dd = Math.hypot(x + 0.5 - district.x, y + 0.5 - district.y);
      let score = -dd * 0.45 + Math.min(adj, 2) * 0.9 - crowd * 0.8 + this.rng.next() * 1.6 + exits * 0.15;
      // stay close to the district's houses
      if (district.houses.length > 0) {
        let md = Infinity;
        for (const h of district.houses) md = Math.min(md, Math.hypot(h.x - x, h.y - y));
        score -= Math.max(0, md - 2) * 0.4;
      }
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    if (!best) return null;
    const [x, y] = best;
    const node = this.net.addTerminal(x, y, 'house', -1);
    // choose driveway: an adjacent road if any (quietest first), otherwise towards the destination
    let facing = 2;
    let bestF = -Infinity;
    let road: RNode | null = null;
    let roadDir = -1;
    let roadScore = -Infinity;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      const n = this.net.nodeAt(nx, ny);
      if (n && n.kind === 'road' && this.net.checkRoadLink(node, n, d) === 'ok') {
        const s = -n.degree + this.rng.next() * 0.5;
        if (s > roadScore) {
          roadScore = s;
          road = n;
          roadDir = d;
        }
      }
      if (this.freeTile(nx, ny)) {
        const s = (near.cx - x - 0.5) * DX[d] + (near.cy - y - 0.5) * DY[d] + this.rng.next() * 0.5;
        if (s > bestF) {
          bestF = s;
          facing = d;
        }
      }
    }
    const h = new House(x, y, color, node, facing, this.time);
    node.ownerId = h.id;
    for (let k = 0; k < CARS_PER_HOUSE; k++) h.cars.push(new Car(h, color, this.rng.range(0.93, 1.07)));
    this.houses.push(h);
    if (road && roadDir >= 0) {
      this.net.linkRoad(node, road, roadDir);
      h.facing = roadDir;
    }
    this.events.push({ type: 'house', house: h });
    return h;
  }

  /** Add a house at an exact tile (used by the demo scene and tests). */
  placeHouse(x: number, y: number, color: number, facing: number): House | null {
    if (!this.freeTile(x, y)) return null;
    const node = this.net.addTerminal(x, y, 'house', -1);
    const h = new House(x, y, color, node, facing, this.time);
    node.ownerId = h.id;
    for (let k = 0; k < CARS_PER_HOUSE; k++) h.cars.push(new Car(h, color, this.rng.range(0.93, 1.07)));
    this.houses.push(h);
    if (!this.colors.includes(color)) this.colors.push(color);
    return h;
  }

  /** Add a destination at an exact place (used by the demo scene and tests). */
  placeDestination(x: number, y: number, color: number, gx: number, gy: number, gdir: number): Destination {
    const gate = this.net.addTerminal(gx, gy, 'gate', -1, gdir);
    const d = new Destination(x, y, color, gate, gdir, this.time);
    gate.ownerId = d.id;
    for (const [tx, ty] of d.tiles) {
      const i = this.world.idx(tx, ty);
      this.world.trees[i] = 0;
      if (tx !== gx || ty !== gy) this.net.reserved.set(i, d.id);
    }
    this.dests.push(d);
    this.gateMap.set(gate, d);
    if (!this.colors.includes(color)) this.colors.push(color);
    return d;
  }

  /** houses of the destination's colour close enough to be its natural supply */
  nearbyHouses(d: Destination): number {
    let n = 0;
    for (const h of this.houses) if (h.color === d.color && Math.hypot(h.x + 0.5 - d.cx, h.y + 0.5 - d.cy) < 7.5) n++;
    return n;
  }

  /** houses of the destination's colour for which it is the nearest building */
  servedHouses(d: Destination): number {
    let n = 0;
    for (const h of this.houses) if (h.color === d.color && this.nearestDest(h.color, h.x + 0.5, h.y + 0.5) === d) n++;
    return n;
  }

  private spawnHouseByNeed(): void {
    if (this.dests.length === 0) return;
    // every destination grows its own neighbourhood; the ones with few nearby
    // houses, long trips or waiting customers get served first
    const weights = this.dests.map((d) => {
      const served = this.servedHouses(d);
      if (served >= HOUSES_PER_DEST) return 0;
      const age = (this.time - d.born) / 60;
      return (1 / (1 + served)) * (1 + d.tripTime / 14) * (1 + 0.12 * d.pins) * (age < 1.5 ? 1.6 : 1);
    });
    const di = this.rng.weighted(weights);
    if (di < 0) return;
    const d = this.dests[di];
    this.spawnHouse(d.color, d);
  }

  // ------------------------------------------------------------------
  // Simulation
  // ------------------------------------------------------------------

  /** Populate a demo city (menu background). */
  seedDemo(dests: number, houses: number): void {
    for (let i = 0; i < dests; i++) this.spawnDestination();
    for (let i = 0; i < houses; i++) this.spawnHouseByNeed();
  }

  /** demand rate (pins/s) for one destination */
  /** trips per second requested by one house (grows as the city gets busier) */
  houseRate(): number {
    const min = (this.demo ? Math.min(this.time, 150) : this.time) / 60;
    return HOUSE_RATE * (1 + DEMAND_GROWTH * min * min);
  }

  /**
   * Demand of a destination: every house asks for trips to the nearest
   * destination of its colour, so demand and cars grow together and what
   * limits the city is how long a round trip takes.
   */
  demandRate(d: Destination): number {
    // a lot can only absorb so much: extra houses add cars, not demand
    const households = Math.min(HOUSEHOLD_CAP, Math.max(MIN_HOUSEHOLDS, d.households));
    return this.houseRate() * households * this.preset.demand * (this.demo ? 1 : this.rushFactor);
  }

  /** assign every house to the nearest destination of its colour */
  private assignHouseholds(): void {
    for (const d of this.dests) d.households = 0;
    for (const h of this.houses) {
      let best: Destination | null = null;
      let bd = Infinity;
      for (const d of this.dests) {
        if (d.color !== h.color) continue;
        const dd = Math.hypot(h.x + 0.5 - d.cx, h.y + 0.5 - d.cy);
        if (dd < bd) {
          bd = dd;
          best = d;
        }
      }
      if (best) best.households++;
    }
  }

  /** how close a destination is to overflowing (0..1, 1 = countdown running) */
  stress(d: Destination): number {
    return d.stress(this.time, PIN_PATIENCE, LATE_OVERFLOW, PIN_HARD_CAP);
  }

  /** Keep playing after a game over, without any way to lose. */
  continueFree(): void {
    if (this.state !== 'over') return;
    this.state = 'play';
    this.free = true;
    this.lostDest = null;
    for (const d of this.dests) {
      d.timer = 0;
      d.pins = Math.min(d.pins, 4);
      d.pinTimes.fill(this.time);
    }
  }

  syncNetwork(): void {
    if (this.syncedVersion === this.net.version) return;
    this.syncedVersion = this.net.version;
    this.traffic.syncNetwork();
  }

  step(dt: number): void {
    if (this.state !== 'play') return;
    this.net.now = this.time;
    this.syncNetwork();
    this.time += dt;

    // week rollover
    const wl = DAY_LENGTH * WEEK_DAYS;
    const newWeek = Math.floor(this.time / wl) + 1;
    if (newWeek > this.week && !this.demo) {
      this.week = newWeek;
      this.openWeek();
      return;
    }

    if (!this.demo) {
      const rush = this.isRush;
      if (rush !== this.wasRush) {
        this.wasRush = rush;
        this.events.push({ type: 'rush', on: rush });
      }
      // destinations on schedule
      if (this.time >= nextDestTime(this.destIndex) && this.time >= this.destRetry) {
        if (!this.spawnDestination()) this.destRetry = this.time + 4;
      }
      // houses
      this.houseClock -= dt;
      if (this.houseClock <= 0) {
        const min = this.time / 60;
        this.houseClock = Math.max(HOUSE_EVERY_MIN, HOUSE_EVERY_START - min * HOUSE_EVERY_DROP) * this.rng.range(0.8, 1.2);
        this.spawnHouseByNeed();
      }
    }

    // demand
    this.householdClock -= dt;
    if (this.householdClock <= 0) {
      this.householdClock = 1;
      this.assignHouseholds();
    }
    for (const d of this.dests) {
      d.clock = this.time;
      if (d.pulse > 0) d.pulse = Math.max(0, d.pulse - dt * 2.5);
      if (!d.live) {
        // grace period, cut short as soon as a house can reach the building
        const age = this.time - d.born;
        if (age < (this.dests[0] === d ? FIRST_GRACE : DEST_GRACE) && !(age > 1 && this.destConnected(d))) continue;
        d.live = true;
        d.pinClock = Math.max(d.pinClock, FIRST_PIN);
      }
      d.pinClock += this.demandRate(d) * dt;
      if (d.pinClock >= 1) {
        d.pinClock -= 1 + this.rng.range(-0.25, 0.25);
        // free mode: requests stop piling up once the building is full
        if (!this.free || d.pins < PIN_HARD_CAP) d.pins++;
      }
      // a building overflows when customers wait too long (or pile up)
      const late = d.lateCount(this.time, PIN_PATIENCE);
      if (late >= LATE_OVERFLOW || d.pins >= PIN_HARD_CAP) {
        if (d.timer === 0) this.events.push({ type: 'overflow', dest: d });
        d.timer = Math.min(d.timer + dt, OVERFLOW_TIME);
        if (d.timer >= OVERFLOW_TIME && !this.demo && !this.free) {
          this.state = 'over';
          this.lostDest = d;
          this.events.push({ type: 'over', dest: d });
          return;
        }
      } else if (d.timer > 0) {
        d.timer = Math.max(0, d.timer - dt * 0.5);
      }
    }

    for (const h of this.houses) for (const c of h.cars) if (c.cooldown > 0) c.cooldown -= dt;

    this.dispatchClock -= dt;
    if (this.dispatchClock <= 0) {
      this.dispatchClock = 0.2;
      this.dispatch();
    }

    this.traffic.step(dt);
    const moving = this.traffic.cars.length;
    if (moving > this.stats.maxCars) this.stats.maxCars = moving;
  }

  private checkDistVersion(): void {
    if (this.distVersion !== this.net.version) {
      this.distMaps.clear();
      this.retMaps.clear();
      this.distVersion = this.net.version;
    }
  }

  /** routing cost from every node to a destination gate (one-way aware) */
  distMap(d: Destination): Map<RNode, number> {
    this.checkDistVersion();
    let m = this.distMaps.get(d);
    if (!m) {
      m = distancesFrom(d.gate, this.traffic.junctionCost, true);
      this.distMaps.set(d, m);
    }
    return m;
  }

  /** routing cost from a destination gate back to every node */
  retMap(d: Destination): Map<RNode, number> {
    this.checkDistVersion();
    let m = this.retMaps.get(d);
    if (!m) {
      m = distancesFrom(d.gate, this.traffic.junctionCost, false);
      this.retMaps.set(d, m);
    }
    return m;
  }

  /** can this house do a round trip to destination d */
  linked(h: House, d: Destination): boolean {
    return d.color === h.color && this.distMap(d).has(h.node) && this.retMap(d).has(h.node);
  }

  /** is this house able to reach at least one destination of its colour */
  houseConnected(h: House): boolean {
    for (const d of this.dests) if (this.linked(h, d)) return true;
    return false;
  }

  destConnected(d: Destination): boolean {
    for (const h of this.houses) if (this.linked(h, d)) return true;
    return false;
  }

  private dispatch(): void {
    const order = this.dests.slice().sort((a, b) => b.pins - b.claimed - (a.pins - a.claimed));
    for (const d of order) {
      let need = d.pins - d.claimed;
      if (need <= 0) continue;
      const m = this.distMap(d);
      const back = this.retMap(d);
      const tried = new Set<House>();
      while (need > 0) {
        let best: Car | null = null;
        let bestH: House | null = null;
        let bestDist = Infinity;
        for (const h of this.houses) {
          if (h.color !== d.color || tried.has(h)) continue;
          const dist = m.get(h.node);
          if (dist === undefined || !back.has(h.node)) continue;
          const car = h.cars.find((c) => c.state === 'home' && c.cooldown <= 0);
          if (!car) continue;
          if (dist < bestDist) {
            bestDist = dist;
            best = car;
            bestH = h;
          }
        }
        if (!best || !bestH) break;
        const route = this.traffic.route(bestH.node, TERM, d.gate);
        if (!route) {
          tried.add(bestH);
          continue;
        }
        this.traffic.dispatch(best, d, route);
        d.claimed++;
        need--;
      }
    }
  }

  // ------------------------------------------------------------------
  // Weeks & upgrades
  // ------------------------------------------------------------------

  /** close the statistics of the week that just ended */
  private recordWeek(): void {
    const trips = this.score - this.weekMark.score;
    const n = this.stats.trips - this.weekMark.trips;
    const avg = n > 0 ? (this.stats.tripSum - this.weekMark.tripSum) / n : 0;
    this.weekStats.push({ trips, avgTrip: avg });
    this.weekMark = { score: this.score, trips: this.stats.trips, tripSum: this.stats.tripSum };
  }

  private openWeek(): void {
    this.state = 'week';
    this.recordWeek();
    const pool: [UpgradeKind, number, number][] = [
      ['roads', 18 + 2 * Math.min(8, this.week), 3],
      ['bridge', 2, this.world.waterInBounds() > 0 ? this.preset.bridgeWeight : 0],
      ['roundabout', 1, 2],
      ['lights', 2, 1.8],
      ['motorway', 1, this.week >= 3 ? 1.6 : 0],
    ];
    const choices: Upgrade[] = [];
    const weights = pool.map((p) => p[2]);
    for (let k = 0; k < 2; k++) {
      const i = this.rng.weighted(weights);
      if (i < 0) break;
      choices.push({ kind: pool[i][0], amount: pool[i][1] });
      weights[i] = 0;
    }
    this.pendingChoices = choices;
    this.events.push({ type: 'week', week: this.week, choices, bonus: weekBonusRoads(this.week - 1) });
  }

  chooseUpgrade(i: number): void {
    if (this.state !== 'week') return;
    const u = this.pendingChoices[i];
    this.inv.roads += weekBonusRoads(this.week - 1);
    if (u) this.applyUpgrade(u);
    this.pendingChoices = [];
    const nb = boundsForWeek(this.world, this.week, this.portrait);
    const ob = this.world.bounds;
    if (nb.x0 !== ob.x0 || nb.y0 !== ob.y0 || nb.x1 !== ob.x1 || nb.y1 !== ob.y1) {
      this.world.bounds = nb;
      this.events.push({ type: 'bounds' });
    }
    if (this.week === UNLOCK_TYPES_WEEK) this.events.push({ type: 'unlock', what: 'types' });
    if (this.week === UNLOCK_RULES_WEEK) this.events.push({ type: 'unlock', what: 'rules' });
    this.state = 'play';
  }

  applyUpgrade(u: Upgrade): void {
    switch (u.kind) {
      case 'roads': this.inv.roads += u.amount; break;
      case 'bridge': this.inv.bridges += u.amount; break;
      case 'roundabout': this.inv.roundabouts += u.amount; break;
      case 'lights': this.inv.lights += u.amount; break;
      case 'motorway': this.inv.motorways += u.amount; break;
    }
  }

  // ------------------------------------------------------------------
  // Refunds when removing things
  // ------------------------------------------------------------------

  refundLinks(links: Link[]): void {
    for (const l of links) {
      if (l.kind === 'bridge') this.inv.bridges++;
      else if (l.kind === 'motorway') this.inv.motorways++;
      this.inv.roads += l.extraCost;
    }
  }

  /** Remove a single link and refund what it cost. */
  removeLink(l: Link): void {
    if (!l.alive) return;
    this.net.unlink(l);
    this.refundLinks([l]);
  }

  /** Remove a road node and refund everything on it. */
  removeRoad(n: RNode): void {
    if (n.kind !== 'road') return;
    if (n.control === 'roundabout') this.inv.roundabouts++;
    else if (n.control === 'light') this.inv.lights++;
    const links = this.net.removeNode(n);
    this.refundLinks(links);
    this.inv.roads++;
  }

}

function nextDestTime(idx: number): number {
  if (idx < DEST_SCHEDULE.length) return DEST_SCHEDULE[idx];
  return DEST_SCHEDULE[DEST_SCHEDULE.length - 1] + (idx - DEST_SCHEDULE.length + 1) * 95;
}
