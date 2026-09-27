import type { Poly } from '../core/poly';
import type { MoveGeom } from './geometry';
import type { Link, RNode } from './network';
import type { Destination, House } from './entities';

export const SEG_MOVE = 1;
export const SEG_APPROACH = 2;
export const SEG_BOX = 3;
export const SEG_DEPART = 4;
export const SEG_START = 5;
export const SEG_END = 6;
export const SEG_LINK = 7;

/** One piece of a car's itinerary; cars sharing a `key` share a lane. */
export interface Seg {
  kind: number;
  key: number;
  poly: Poly;
  /** start offset on `poly` */
  s0: number;
  len: number;
  /** absolute speed limit (tiles/s) */
  vmax: number;
  node: RNode | null;
  link: Link | null;
  geom: MoveGeom | null;
  /** lane coordinate measured from the end (merge lanes) */
  fromEnd: boolean;
  /** END segment into a parking lot: needs a free slot */
  gate: boolean;
  ring: boolean;
  motorway: boolean;
}

export type CarState = 'home' | 'leaving' | 'driving' | 'parking' | 'parked' | 'unparking';

/** Junction handle as seen from a car (implemented in traffic.ts). */
export interface JunctionRef {
  readonly node: RNode;
}

let nextCarId = 1;

export class Car {
  readonly id = nextCarId++;
  readonly color: number;
  readonly home: House;
  state: CarState = 'home';
  /** destination being served (null when returning home) */
  dest: Destination | null = null;
  /** parking lot the car currently stands in */
  lot: Destination | null = null;
  /** movement at the junction the car requests / holds (segment index + arms) */
  boxIdx = -1;
  mEntry = 0;
  mExit = 0;
  segs: Seg[] = [];
  i = 0;
  s = 0;
  v = 0;
  x = 0;
  y = 0;
  a = 0;
  /** junction whose conflict zone this car may enter */
  ticket: JunctionRef | null = null;
  reqJ: JunctionRef | null = null;
  reqTime = 0;
  slot = -1;
  // lane bookkeeping (rebuilt every tick)
  laneIdx = 0;
  coord = 0;
  gap = Infinity;
  vt = 0;
  stuck = 0;
  /** time spent waiting at the current stop line */
  waitAt = 0;
  cooldown = 0;
  /** game time when the current trip was dispatched */
  dispatchedAt = 0;
  /** what currently holds the car back (for statistics): 0 free, 1 leader, 2 stop line, 3 lot */
  limit = 0;
  // parking / lot animation
  anim: Poly | null = null;
  anim2: Poly | null = null;
  animT = 0;
  animDur = 0;
  reverse = false;
  parkT = 0;
  fade = 0;
  readonly speedMul: number;
  /** tail light intensity for rendering */
  brake = 0;

  constructor(home: House, color: number, speedMul: number) {
    this.home = home;
    this.color = color;
    this.speedMul = speedMul;
  }

  get seg(): Seg {
    return this.segs[this.i];
  }

  get onRoad(): boolean {
    return this.state === 'driving';
  }
}
