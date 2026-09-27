import { DX, DY, UX, UY, PARK_SLOTS } from './constants';
import type { RNode } from './network';
import type { Car } from './car';

let nextBuildingId = 1;

export class House {
  readonly id = nextBuildingId++;
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly node: RNode;
  readonly cars: Car[] = [];
  born: number;
  /** direction the building faces (driveway side) */
  facing: number;

  constructor(x: number, y: number, color: number, node: RNode, facing: number, born: number) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.node = node;
    this.facing = facing;
    this.born = born;
  }

  /** driveway direction, the linked arm if any */
  get dir(): number {
    for (let d = 0; d < 8; d++) if (this.node.links[d]) return d;
    return this.facing;
  }
}

export interface Slot {
  car: Car | null;
  /** world position of the parked car and its heading */
  x: number;
  y: number;
  a: number;
}

export class Destination {
  readonly id = nextBuildingId++;
  /** top-left tile of the 2x2 footprint */
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly gate: RNode;
  /** outward direction of the gate (orthogonal) */
  readonly gateDir: number;
  readonly slots: Slot[] = [];
  /** creation time of every outstanding demand, oldest first */
  readonly pinTimes: number[] = [];
  /** game clock, kept up to date by the game (used when demands are added) */
  clock = 0;
  /** demands already assigned to a car */
  claimed = 0;
  /** overflow timer (seconds) */
  timer = 0;
  pinClock = 0;
  born: number;
  /** tiles of the footprint */
  readonly tiles: [number, number][];
  /** lot entry lock (a car is manoeuvring in the lot entrance) */
  entryBusy = 0;
  exitBusy = 0;
  /** visual pulse when a pin is delivered */
  pulse = 0;
  delivered = 0;
  /** smoothed dispatch-to-delivery time (seconds) */
  tripTime = 0;
  /** houses of this colour for which this is the nearest destination */
  households = 0;

  constructor(x: number, y: number, color: number, gate: RNode, gateDir: number, born: number) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.gate = gate;
    this.gateDir = gateDir;
    this.born = born;
    this.tiles = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
    this.layoutSlots();
  }

  /** outstanding demands (including the ones a car is already driving to) */
  get pins(): number {
    return this.pinTimes.length;
  }

  /** setting the count adds fresh demands or serves the oldest ones */
  set pins(n: number) {
    n = Math.max(0, Math.floor(n));
    while (this.pinTimes.length < n) this.pinTimes.push(this.clock);
    if (this.pinTimes.length > n) this.pinTimes.splice(0, this.pinTimes.length - n);
  }

  /** demands that have been waiting longer than `patience` seconds */
  lateCount(now: number, patience: number): number {
    let k = 0;
    for (const t of this.pinTimes) {
      if (now - t > patience) k++;
      else break;
    }
    return k;
  }

  /** age of the oldest demand */
  oldestAge(now: number): number {
    return this.pinTimes.length ? now - this.pinTimes[0] : 0;
  }

  get cx(): number {
    return this.x + 1;
  }

  get cy(): number {
    return this.y + 1;
  }

  /** local frame: o = outward unit, t = along the gate side */
  frame(): { ox: number; oy: number; tx: number; ty: number; sx: number; sy: number } {
    const ox = UX[this.gateDir];
    const oy = UY[this.gateDir];
    // side centre
    const sx = this.cx + ox;
    const sy = this.cy + oy;
    return { ox, oy, tx: -oy, ty: ox, sx, sy };
  }

  /** gate position along the side: -0.5 or +0.5 (in t units) */
  gateU(): number {
    const f = this.frame();
    const u = (this.gate.cx - f.sx) * f.tx + (this.gate.cy - f.sy) * f.ty;
    return u < 0 ? -0.5 : 0.5;
  }

  private layoutSlots(): void {
    const f = this.frame();
    // parked cars stand in the half of the footprint along the gate side,
    // perpendicular to it, facing the building.
    const depth = 0.74; // distance from the side edge inward
    const us = [-0.75, -0.25, 0.25, 0.75];
    for (let i = 0; i < PARK_SLOTS; i++) {
      const u = us[i];
      const x = f.sx + f.tx * u - f.ox * depth;
      const y = f.sy + f.ty * u - f.oy * depth;
      this.slots.push({ car: null, x, y, a: Math.atan2(-f.oy, -f.ox) });
    }
  }

  freeSlot(): number {
    // prefer the slots farthest from the gate so the entrance stays clear
    const gu = this.gateU();
    let best = -1;
    let bestScore = -Infinity;
    const us = [-0.75, -0.25, 0.25, 0.75];
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].car) continue;
      const score = Math.abs(us[i] - gu);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  occupies(x: number, y: number): boolean {
    return x >= this.x && x < this.x + 2 && y >= this.y && y < this.y + 2;
  }

  /** the tile just outside the gate */
  get frontX(): number {
    return this.gate.x + DX[this.gateDir];
  }

  get frontY(): number {
    return this.gate.y + DY[this.gateDir];
  }
}
