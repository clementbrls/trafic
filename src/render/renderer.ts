import { Camera } from './camera';
import { Fx } from './fx';
import { makeTheme, type Theme } from './theme';
import { clamp, easeOutBack, lerp, TAU } from '../core/math';
import {
  DX, DY, UX, UY, BOUND, PALETTE, ROAD_W, AVE_W, DRIVE_W, CAR_LEN, CAR_WID, RING_R, LANE, OVERFLOW_TIME, PIN_PATIENCE,
  BOX_R, opp, WARN_STRESS,
} from '../game/constants';
import { SEG_LINK } from '../game/car';
import { inPoint } from '../game/geometry';
import type { Game } from '../game/game';
import type { Builder, Tool } from '../game/builder';
import type { Car } from '../game/car';
import type { Destination, House } from '../game/entities';
import { motorwayCurve, type RNode } from '../game/network';
import { polyFromPoints, polyAt, sampleCubic } from '../core/poly';
import type { Junction } from '../game/traffic';
import type { Bounds } from '../game/world';
import type { MapId } from '../game/maps';

/** amber used while a building is about to overflow */
const WARN_COLOR = '#F2A33A';

function rrect(ctx: CanvasRenderingContext2D | Path2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function rrect4(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tl: number, tr: number, br: number, bl: number): void {
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - br);
  if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + bl, y + h);
  if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + tl);
  if (tl) ctx.arcTo(x, y, x + tl, y, tl);
  else ctx.lineTo(x, y);
  ctx.closePath();
}

export interface RenderOptions {
  tool: Tool;
  hoverValid: boolean;
  showHover: boolean;
  reducedMotion: boolean;
  heat: boolean;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly cam = new Camera();
  readonly fx = new Fx();
  theme: Theme;
  dpr = 1;
  width = 1;
  height = 1;
  private shownBounds: Bounds | null = null;
  private boundsAnim = 1;
  private fromBounds: Bounds | null = null;
  private toBounds: Bounds | null = null;
  /** world -> device pixel transform of the current frame */
  private wz = 1;
  private wox = 0;
  private woy = 0;
  time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.theme = makeTheme(false, 'plaine');
  }

  setTheme(dark: boolean, map: MapId): void {
    this.theme = makeTheme(dark, map);
  }

  resize(w: number, h: number, dpr: number): void {
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
  }

  resetBounds(b: Bounds): void {
    this.shownBounds = { ...b };
    this.fromBounds = null;
    this.toBounds = null;
    this.boundsAnim = 1;
  }

  private animatedBounds(target: Bounds, dt: number): Bounds {
    if (!this.shownBounds) this.shownBounds = { ...target };
    const cur = this.toBounds ?? this.shownBounds;
    if (cur.x0 !== target.x0 || cur.y0 !== target.y0 || cur.x1 !== target.x1 || cur.y1 !== target.y1) {
      this.fromBounds = { ...this.shownBounds };
      this.toBounds = { ...target };
      this.boundsAnim = 0;
    }
    if (this.fromBounds && this.toBounds && this.boundsAnim < 1) {
      this.boundsAnim = Math.min(1, this.boundsAnim + dt / 1.3);
      const t = 1 - Math.pow(1 - this.boundsAnim, 3);
      const f = this.fromBounds;
      const to = this.toBounds;
      this.shownBounds = {
        x0: lerp(f.x0, to.x0, t), y0: lerp(f.y0, to.y0, t), x1: lerp(f.x1, to.x1, t), y1: lerp(f.y1, to.y1, t),
      };
    } else {
      this.shownBounds = { ...target };
    }
    return this.shownBounds;
  }

  // ------------------------------------------------------------------

  render(game: Game, builder: Builder | null, dt: number, opts: RenderOptions): void {
    this.time += dt;
    this.fx.update(dt);
    const ctx = this.ctx;
    const th = this.theme;
    const cam = this.cam;
    const z = cam.zoom * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.wz = z;
    this.wox = (this.width / 2 - cam.x * cam.zoom) * this.dpr;
    this.woy = (this.height / 2 - cam.y * cam.zoom) * this.dpr;
    ctx.setTransform(z, 0, 0, z, this.wox, this.woy);

    const w = game.world;
    const b = this.animatedBounds(w.bounds, dt);
    const vx0 = Math.max(0, Math.floor(cam.toWorldX(0)) - 1);
    const vy0 = Math.max(0, Math.floor(cam.toWorldY(0)) - 1);
    const vx1 = Math.min(w.w, Math.ceil(cam.toWorldX(this.width)) + 1);
    const vy1 = Math.min(w.h, Math.ceil(cam.toWorldY(this.height)) + 1);

    this.drawTerrain(game, vx0, vy0, vx1, vy1);
    this.drawLocked(game, b);
    if (builder?.active || opts.tool !== 'road') this.drawGrid(game, b, builder?.active ? 1 : 0.55);
    this.drawRoads(game, opts.heat);
    this.drawJunctionDecor(game);
    for (const d of game.dests) this.drawDestination(game, d);
    for (const h of game.houses) this.drawHouse(game, h);
    this.drawCars(game, false);
    this.drawMotorways(game);
    this.drawCars(game, true);
    for (const d of game.dests) this.drawPins(game, d);
    this.drawPreview(game, builder, opts);
    this.drawFx();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawOffscreenAlerts(game);
  }

  // ------------------------------------------------------------------
  // Terrain
  // ------------------------------------------------------------------

  private drawTerrain(game: Game, x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.ctx;
    const th = this.theme;
    const w = game.world;
    // ground with rounded map corners
    ctx.fillStyle = th.ground;
    ctx.beginPath();
    rrect(ctx, 0, 0, w.w, w.h, 0.6);
    ctx.fill();

    // water
    const R = 0.42;
    const isW = (x: number, y: number) => (w.inMap(x, y) ? w.isWater(x, y) : true);
    ctx.fillStyle = th.water;
    ctx.beginPath();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!w.isWater(x, y)) continue;
        const n = isW(x, y - 1);
        const s = isW(x, y + 1);
        const e = isW(x + 1, y);
        const wv = isW(x - 1, y);
        const tl = !n && !wv ? R : 0;
        const tr = !n && !e ? R : 0;
        const br = !s && !e ? R : 0;
        const bl = !s && !wv ? R : 0;
        if (tl || tr || br || bl) rrect4(ctx, x - 0.001, y - 0.001, 1.002, 1.002, tl, tr, br, bl);
        else ctx.rect(x - 0.001, y - 0.001, 1.002, 1.002);
      }
    }
    ctx.fill();
    // concave fillets on land corners
    ctx.beginPath();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (w.isWater(x, y)) continue;
        const r = 0.28;
        // TL
        if (isW(x - 1, y) && isW(x, y - 1) && isW(x - 1, y - 1)) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + r, y);
          ctx.arc(x + r, y + r, r, -Math.PI / 2, Math.PI, true);
          ctx.closePath();
        }
        if (isW(x + 1, y) && isW(x, y - 1) && isW(x + 1, y - 1)) {
          ctx.moveTo(x + 1, y);
          ctx.lineTo(x + 1, y + r);
          ctx.arc(x + 1 - r, y + r, r, 0, -Math.PI / 2, true);
          ctx.closePath();
        }
        if (isW(x + 1, y) && isW(x, y + 1) && isW(x + 1, y + 1)) {
          ctx.moveTo(x + 1, y + 1);
          ctx.lineTo(x + 1 - r, y + 1);
          ctx.arc(x + 1 - r, y + 1 - r, r, Math.PI / 2, 0, true);
          ctx.closePath();
        }
        if (isW(x - 1, y) && isW(x, y + 1) && isW(x - 1, y + 1)) {
          ctx.moveTo(x, y + 1);
          ctx.lineTo(x, y + 1 - r);
          ctx.arc(x + r, y + 1 - r, r, Math.PI, Math.PI / 2, true);
          ctx.closePath();
        }
      }
    }
    ctx.fill();

    // trees
    const net = game.net;
    ctx.fillStyle = th.tree;
    const dark: number[] = [];
    ctx.beginPath();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = w.idx(x, y);
        const t = w.trees[i];
        if (!t || net.nodes.has(i) || net.reserved.has(i)) continue;
        const j = w.jitter[i];
        for (let k = 0; k < t; k++) {
          const a = j * TAU + k * 2.3;
          const rr = 0.2 + 0.1 * ((j * 7 + k) % 1);
          const cx = x + 0.5 + Math.cos(a) * rr * (t > 1 ? 1 : 0.3);
          const cy = y + 0.5 + Math.sin(a) * rr * (t > 1 ? 1 : 0.3);
          const size = 0.13 + 0.06 * ((j * 13 + k * 0.37) % 1);
          ctx.moveTo(cx + size, cy);
          ctx.arc(cx, cy, size, 0, TAU);
          if (k === 0) dark.push(cx, cy, size);
        }
      }
    }
    ctx.fill();
    ctx.fillStyle = th.treeDark;
    ctx.beginPath();
    for (let k = 0; k < dark.length; k += 3) {
      const cx = dark[k];
      const cy = dark[k + 1] + dark[k + 2] * 0.25;
      const s = dark[k + 2] * 0.55;
      ctx.moveTo(cx + s, cy);
      ctx.arc(cx, cy, s, 0, TAU);
    }
    ctx.fill();
  }

  private drawLocked(game: Game, b: Bounds): void {
    const ctx = this.ctx;
    const th = this.theme;
    const w = game.world;
    ctx.fillStyle = th.locked;
    ctx.beginPath();
    rrect(ctx, 0, 0, w.w, w.h, 0.6);
    // hole for the unlocked area (even-odd)
    rrect(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0.45);
    ctx.fill('evenodd');
    ctx.strokeStyle = th.groundEdge;
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    rrect(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0.45);
    ctx.stroke();
  }

  private drawGrid(game: Game, b: Bounds, alpha: number): void {
    const ctx = this.ctx;
    const w = game.world;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.theme.grid;
    ctx.beginPath();
    for (let y = Math.ceil(b.y0); y < Math.floor(b.y1); y++) {
      for (let x = Math.ceil(b.x0); x < Math.floor(b.x1); x++) {
        const i = w.idx(x, y);
        if (w.terrain[i] !== 0 || game.net.nodes.has(i) || game.net.reserved.has(i)) continue;
        ctx.moveTo(x + 0.5 + 0.035, y + 0.5);
        ctx.arc(x + 0.5, y + 0.5, 0.035, 0, TAU);
      }
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Roads
  // ------------------------------------------------------------------

  private armEnd(n: RNode, d: number): [number, number] {
    return [n.cx + UX[d] * BOUND[d], n.cy + UY[d] * BOUND[d]];
  }

  private isAvenueArm(n: RNode, d: number): boolean {
    const l = n.links[d];
    return !!l && l.tier === 'avenue' && l.kind !== 'motorway' && !l.other(n).isTerminal;
  }

  private drawRoads(game: Game, heat: boolean): void {
    const ctx = this.ctx;
    const th = this.theme;
    const net = game.net;
    const main = new Path2D();
    const ave = new Path2D();
    const aveLine = new Path2D();
    const drive = new Path2D();
    const bridges = new Path2D();
    const bridgesAve = new Path2D();
    const discs = new Path2D();
    const now = game.time;

    for (const l of net.links) {
      if (l.kind !== 'bridge') continue;
      const [ax, ay] = this.armEnd(l.a, l.dir);
      const [bx, by] = this.armEnd(l.b, opp(l.dir));
      const p = l.tier === 'avenue' ? bridgesAve : bridges;
      p.moveTo(ax, ay);
      p.lineTo(bx, by);
    }
    // bridge shadow + rails
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (net.links.size > 0) {
      ctx.save();
      ctx.translate(0.05, 0.1);
      ctx.strokeStyle = th.shadow;
      ctx.lineWidth = ROAD_W + 0.12;
      ctx.stroke(bridges);
      ctx.lineWidth = AVE_W + 0.12;
      ctx.stroke(bridgesAve);
      ctx.restore();
      ctx.strokeStyle = th.bridgeRail;
      ctx.lineWidth = ROAD_W + 0.1;
      ctx.stroke(bridges);
      ctx.lineWidth = AVE_W + 0.1;
      ctx.stroke(bridgesAve);
    }

    for (const n of net.nodes.values()) {
      const cx = n.cx;
      const cy = n.cy;
      if (n.kind !== 'road') {
        // driveway from a house / gate
        for (let d = 0; d < 8; d++) {
          if (!n.links[d]) continue;
          const [ex, ey] = this.armEnd(n, d);
          const start = n.kind === 'house' ? 0.12 : 0.05;
          drive.moveTo(cx + UX[d] * start, cy + UY[d] * start);
          drive.lineTo(ex, ey);
        }
        continue;
      }
      const grow = clamp((now - n.born) / 0.18, 0, 1);
      const arms: number[] = [];
      let anyAve = false;
      for (let d = 0; d < 8; d++) {
        if (!n.links[d]) continue;
        arms.push(d);
        if (this.isAvenueArm(n, d)) anyAve = true;
      }
      if (arms.length === 0) {
        const r = (ROAD_W / 2) * (0.6 + 0.4 * grow);
        discs.moveTo(cx + r, cy);
        discs.arc(cx, cy, r, 0, TAU);
        continue;
      }
      if (arms.length === 2 && arms[1] - arms[0] !== 4 && !this.toTerminal(n, arms[0]) && !this.toTerminal(n, arms[1])) {
        const a0 = this.isAvenueArm(n, arms[0]);
        const a1 = this.isAvenueArm(n, arms[1]);
        if (a0 === a1) {
          const [ax, ay] = this.armEnd(n, arms[0]);
          const [bx, by] = this.armEnd(n, arms[1]);
          const p = a0 ? ave : main;
          p.moveTo(ax, ay);
          p.quadraticCurveTo(cx, cy, bx, by);
          if (a0) {
            aveLine.moveTo(ax, ay);
            aveLine.quadraticCurveTo(cx, cy, bx, by);
          }
          continue;
        }
      }
      for (const d of arms) {
        const [ex, ey] = this.armEnd(n, d);
        const isAve = this.isAvenueArm(n, d);
        const p = this.toTerminal(n, d) ? drive : isAve ? ave : main;
        p.moveTo(cx, cy);
        p.lineTo(ex, ey);
        if (isAve && arms.length <= 2) {
          aveLine.moveTo(cx, cy);
          aveLine.lineTo(ex, ey);
        } else if (isAve) {
          // stop the centre line before the junction box
          aveLine.moveTo(cx + UX[d] * 0.32, cy + UY[d] * 0.32);
          aveLine.lineTo(ex, ey);
        }
      }
      if (anyAve && arms.length > 2) {
        const r = AVE_W / 2;
        discs.moveTo(cx + r, cy);
        discs.arc(cx, cy, r, 0, TAU);
      }
      if (n.control === 'roundabout') {
        const r = RING_R + 0.12;
        discs.moveTo(cx + r, cy);
        discs.arc(cx, cy, r, 0, TAU);
      }
    }
    for (const l of net.links) {
      if (l.kind !== 'bridge') continue;
      const [ax, ay] = this.armEnd(l.a, l.dir);
      const [bx, by] = this.armEnd(l.b, opp(l.dir));
      const p = l.tier === 'avenue' ? ave : main;
      p.moveTo(ax, ay);
      p.lineTo(bx, by);
      if (l.tier === 'avenue') {
        aveLine.moveTo(ax, ay);
        aveLine.lineTo(bx, by);
      }
    }
    // subtle drop shadow
    ctx.save();
    ctx.translate(0.025, 0.05);
    ctx.strokeStyle = th.roadShadow;
    ctx.fillStyle = th.roadShadow;
    ctx.lineWidth = ROAD_W;
    ctx.stroke(main);
    ctx.lineWidth = AVE_W;
    ctx.stroke(ave);
    ctx.fill(discs);
    ctx.lineWidth = DRIVE_W;
    ctx.stroke(drive);
    ctx.restore();
    ctx.strokeStyle = th.road;
    ctx.fillStyle = th.road;
    ctx.lineWidth = DRIVE_W;
    ctx.stroke(drive);
    ctx.lineWidth = ROAD_W;
    ctx.stroke(main);
    ctx.strokeStyle = th.avenue;
    ctx.lineWidth = AVE_W;
    ctx.stroke(ave);
    ctx.fillStyle = th.road;
    ctx.fill(discs);
    // avenue centre line
    ctx.strokeStyle = th.dark ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.62)';
    ctx.lineWidth = 0.03;
    ctx.lineCap = 'butt';
    ctx.setLineDash([0.13, 0.11]);
    ctx.stroke(aveLine);
    ctx.lineCap = 'round';
    // bridge deck lines
    ctx.strokeStyle = th.bridgeDeck;
    ctx.lineWidth = 0.02;
    ctx.setLineDash([0.06, 0.12]);
    ctx.stroke(bridges);
    ctx.setLineDash([]);
    if (heat) this.drawHeat(game);
    this.drawOneWays(game);
  }

  /** traffic view: colour each road tile by its congestion */
  private drawHeat(game: Game): void {
    const ctx = this.ctx;
    const buckets: Path2D[] = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (const n of game.net.nodes.values()) {
      if (n.kind !== 'road') continue;
      const lvl = n.load < 0.18 ? 0 : n.load < 0.38 ? 1 : n.load < 0.6 ? 2 : 3;
      const p = buckets[lvl];
      let arms = 0;
      for (let d = 0; d < 8; d++) {
        const l = n.links[d];
        if (!l || l.other(n).isTerminal) continue;
        arms++;
        const [ex, ey] = this.armEnd(n, d);
        p.moveTo(n.cx, n.cy);
        p.lineTo(ex, ey);
      }
      if (arms === 0) continue;
      p.moveTo(n.cx + 0.001, n.cy);
      p.lineTo(n.cx, n.cy);
    }
    const colors = ['#3FC57F', '#C9D13B', '#F29B30', '#EE4B3E'];
    ctx.lineCap = 'round';
    ctx.lineWidth = ROAD_W * 0.42;
    ctx.globalAlpha = 0.92;
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = colors[i];
      ctx.stroke(buckets[i]);
    }
    ctx.globalAlpha = 1;
  }

  /** chevrons showing the direction of one-way streets */
  private drawOneWays(game: Game): void {
    const ctx = this.ctx;
    const path = new Path2D();
    let any = false;
    for (const l of game.net.links) {
      if (l.oneway === 0 || l.kind === 'motorway') continue;
      any = true;
      const from = l.oneway === 1 ? l.a : l.b;
      const d = l.dirFrom(from);
      const ux = UX[d];
      const uy = UY[d];
      const [sx, sy] = this.armEnd(from, d);
      const to = l.other(from);
      const [ex, ey] = this.armEnd(to, opp(d));
      const len = Math.hypot(ex - sx, ey - sy);
      const marks = len < 0.5 ? [0.5] : Array.from({ length: Math.max(1, Math.round(len)) }, (_, k) => (k + 0.5) / Math.max(1, Math.round(len)));
      const pts = len < 0.5 ? [[sx, sy]] : marks.map((f) => [sx + (ex - sx) * f, sy + (ey - sy) * f]);
      for (const [mx, my] of pts) {
        const s = 0.1;
        const px = -uy;
        const py = ux;
        path.moveTo(mx - ux * s + px * s, my - uy * s + py * s);
        path.lineTo(mx + ux * s * 0.6, my + uy * s * 0.6);
        path.lineTo(mx - ux * s - px * s, my - uy * s - py * s);
      }
    }
    if (!any) return;
    ctx.strokeStyle = this.theme.dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 0.05;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
  }

  private toTerminal(n: RNode, d: number): boolean {
    const l = n.links[d];
    return !!l && l.other(n).isTerminal;
  }

  /** small "no left turn" sign on a junction */
  private drawRuleBadge(n: RNode): void {
    const ctx = this.ctx;
    const th = this.theme;
    const x = n.cx;
    const y = n.cy;
    const r = 0.15;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = th.danger;
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // left-turn arrow
    ctx.strokeStyle = '#2A2D36';
    ctx.lineWidth = 0.028;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x + 0.035, y + 0.08);
    ctx.lineTo(x + 0.035, y - 0.01);
    ctx.quadraticCurveTo(x + 0.035, y - 0.045, x, y - 0.045);
    ctx.lineTo(x - 0.07, y - 0.045);
    ctx.moveTo(x - 0.035, y - 0.08);
    ctx.lineTo(x - 0.075, y - 0.045);
    ctx.lineTo(x - 0.035, y - 0.01);
    ctx.stroke();
    // slash
    ctx.strokeStyle = th.danger;
    ctx.lineWidth = 0.032;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, y - r * 0.7);
    ctx.lineTo(x + r * 0.7, y + r * 0.7);
    ctx.stroke();
  }

  /** white stop lines on the arms that must give way / stop */
  private drawStopLines(game: Game): void {
    const ctx = this.ctx;
    const path = new Path2D();
    for (const n of game.net.nodes.values()) {
      if (n.kind !== 'road' || n.control !== 'none' || n.degree < 3) continue;
      const j = n.traffic as Junction | null;
      if (!j) continue;
      for (let d = 0; d < 8; d++) {
        const l = n.links[d];
        if (!l || l.other(n).isTerminal || !j.mustStop(d)) continue;
        const ux = UX[d];
        const uy = UY[d];
        // incoming lane lies on the right of the travel direction (-u)
        const rx = uy;
        const ry = -ux;
        const w = l.tier === 'avenue' ? AVE_W : ROAD_W;
        const cx = n.cx + ux * (BOX_R + 0.07);
        const cy = n.cy + uy * (BOX_R + 0.07);
        path.moveTo(cx + rx * 0.02, cy + ry * 0.02);
        path.lineTo(cx + rx * (w / 2 - 0.035), cy + ry * (w / 2 - 0.035));
      }
    }
    ctx.strokeStyle = this.theme.dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 0.038;
    ctx.lineCap = 'butt';
    ctx.stroke(path);
    ctx.lineCap = 'round';
  }

  /** small yellow diamond: the player chose the priority road here */
  private drawPriorityBadge(n: RNode): void {
    const ctx = this.ctx;
    const a = n.priorityAxis;
    const ux = UX[a];
    const uy = UY[a];
    // along the priority axis, just off the centre
    const x = n.cx - uy * 0.05;
    const y = n.cy + ux * 0.05;
    const s = 0.12;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(x, y - s - 0.03);
    ctx.lineTo(x + s + 0.03, y);
    ctx.lineTo(x, y + s + 0.03);
    ctx.lineTo(x - s - 0.03, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#F2B233';
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fill();
  }

  private drawJunctionDecor(game: Game): void {
    const ctx = this.ctx;
    const th = this.theme;
    this.drawStopLines(game);
    for (const n of game.net.nodes.values()) {
      if (n.kind !== 'road') continue;
      if (n.noLeft && n.control !== 'roundabout' && n.degree >= 3) this.drawRuleBadge(n);
      else if (n.priorityAxis >= 0 && n.control === 'none' && n.degree >= 3) this.drawPriorityBadge(n);
      if (n.control === 'roundabout') {
        ctx.fillStyle = th.island;
        ctx.beginPath();
        ctx.arc(n.cx, n.cy, RING_R - 0.105, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = th.dark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 0.025;
        ctx.stroke();
      } else if (n.control === 'light') {
        const j = n.traffic as Junction | null;
        for (let d = 0; d < 8; d++) {
          if (!n.links[d] || this.toTerminal(n, d)) continue;
          const [px, py] = inPoint(n, d);
          // place the lamp on the right edge of the incoming lane
          const vx = -UX[d];
          const vy = -UY[d];
          const rx = -vy;
          const ry = vx;
          const lx = px + rx * (ROAD_W / 2 - LANE + 0.08) - vx * 0.05;
          const ly = py + ry * (ROAD_W / 2 - LANE + 0.08) - vy * 0.05;
          const st = j ? j.lightState(d) : 0;
          const deg = n.degree >= 3;
          ctx.fillStyle = th.dark ? '#111318' : '#2A2D36';
          ctx.beginPath();
          ctx.arc(lx, ly, 0.085, 0, TAU);
          ctx.fill();
          ctx.fillStyle = !deg ? '#8A8F9C' : st === 0 ? '#3DDC84' : st === 1 ? '#FFC53D' : '#FF5A4E';
          ctx.beginPath();
          ctx.arc(lx, ly, 0.055, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  private drawMotorways(game: Game): void {
    const ctx = this.ctx;
    const th = this.theme;
    const path = new Path2D();
    const shadow = new Path2D();
    let any = false;
    for (const l of game.net.links) {
      if (l.kind !== 'motorway') continue;
      any = true;
      const c = motorwayCurve(l.a.x, l.a.y, l.b.x, l.b.y, l.dir);
      path.moveTo(c[0], c[1]);
      path.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
      // the shadow leaves the ramps out
      const pts: number[] = [];
      sampleCubic(pts, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], Math.max(4, Math.ceil(l.length * 2)));
      const poly = polyFromPoints(pts);
      const s0 = Math.min(0.5, poly.len * 0.3);
      const q = { x: 0, y: 0, a: 0 };
      for (let s = s0; s <= poly.len - s0 + 1e-6; s += 0.25) {
        polyAt(poly, Math.min(s, poly.len - s0), q);
        if (s > s0) shadow.lineTo(q.x, q.y);
        else shadow.moveTo(q.x, q.y);
      }
    }
    if (!any) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.translate(0.12, 0.2);
    ctx.strokeStyle = th.motorwayShadow;
    ctx.lineWidth = ROAD_W + 0.08;
    ctx.stroke(shadow);
    ctx.restore();
    ctx.strokeStyle = th.motorwayEdge;
    ctx.lineWidth = ROAD_W + 0.12;
    ctx.stroke(path);
    ctx.strokeStyle = th.motorway;
    ctx.lineWidth = ROAD_W;
    ctx.stroke(path);
    ctx.strokeStyle = th.motorwayLine;
    ctx.lineWidth = 0.028;
    ctx.setLineDash([0.12, 0.14]);
    ctx.stroke(path);
    ctx.setLineDash([]);
  }

  // ------------------------------------------------------------------
  // Buildings
  // ------------------------------------------------------------------

  private popScale(game: Game, born: number): number {
    const t = (game.time - born) / 0.5;
    return t >= 1 ? 1 : Math.max(0.01, easeOutBack(t));
  }

  private drawHouse(game: Game, h: House): void {
    const ctx = this.ctx;
    const th = this.theme;
    const col = PALETTE[h.color];
    const s = this.popScale(game, h.born);
    const d = h.dir;
    const ox = DX[d];
    const oy = DY[d];
    const cx = h.x + 0.5 - ox * 0.1;
    const cy = h.y + 0.5 - oy * 0.1;
    const size = 0.54 * s;
    ctx.fillStyle = th.shadow;
    ctx.beginPath();
    rrect(ctx, cx - size / 2 + 0.03, cy - size / 2 + 0.06, size, size, 0.1 * s);
    ctx.fill();
    ctx.fillStyle = col.dark;
    ctx.beginPath();
    rrect(ctx, cx - size / 2, cy - size / 2, size, size, 0.1 * s);
    ctx.fill();
    ctx.fillStyle = col.base;
    ctx.beginPath();
    rrect(ctx, cx - size / 2, cy - size / 2, size, size - 0.08 * s, 0.1 * s);
    ctx.fill();
    // roof ridge
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 0.03 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.22, cy - 0.04 * s);
    ctx.lineTo(cx + size * 0.22, cy - 0.04 * s);
    ctx.stroke();
    // parked cars at home
    const home = h.cars.filter((c) => c.state === 'home' || c.state === 'leaving');
    const px = -oy;
    const py = ox;
    // a row in front of the house, filled from the middle
    const gap = home.length > 2 ? 0.15 : 0.24;
    for (let k = 0; k < home.length; k++) {
      const off = (k - (home.length - 1) / 2) * gap;
      const x = h.x + 0.5 + ox * 0.33 + px * off;
      const y = h.y + 0.5 + oy * 0.33 + py * off;
      this.drawCarShape(x, y, Math.atan2(oy, ox), h.color, s * (home.length > 2 ? 0.85 : 1), 0);
    }
  }

  private drawDestination(game: Game, d: Destination): void {
    const ctx = this.ctx;
    const th = this.theme;
    const col = PALETTE[d.color];
    const s = this.popScale(game, d.born);
    const pulse = d.pulse > 0 ? 1 + 0.035 * Math.sin(d.pulse * Math.PI) : 1;
    const cx = d.cx;
    const cy = d.cy;
    // a building about to overflow glows (amber), then burns red during the countdown
    const stress = game.stress(d);
    if (stress >= WARN_STRESS && !game.free) {
      const hot = d.timer > 0;
      const beat = 0.5 + 0.5 * Math.sin(this.time * (hot ? 7 : 4));
      const r = 1.95 + beat * 0.12;
      const g = ctx.createRadialGradient(cx, cy, 0.6, cx, cy, r);
      const rgb = hot ? '229,72,59' : '242,163,58';
      g.addColorStop(0, `rgba(${rgb},${(hot ? 0.34 : 0.22) + beat * 0.12})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s * pulse, s * pulse);
    ctx.translate(-cx, -cy);
    const inset = 0.08;
    // shadow
    ctx.fillStyle = th.shadow;
    ctx.beginPath();
    rrect(ctx, d.x + inset + 0.04, d.y + inset + 0.08, 2 - inset * 2, 2 - inset * 2, 0.24);
    ctx.fill();
    ctx.fillStyle = col.dark;
    ctx.beginPath();
    rrect(ctx, d.x + inset, d.y + inset, 2 - inset * 2, 2 - inset * 2, 0.24);
    ctx.fill();
    ctx.fillStyle = col.base;
    ctx.beginPath();
    rrect(ctx, d.x + inset, d.y + inset, 2 - inset * 2, 2 - inset * 2 - 0.1, 0.24);
    ctx.fill();

    // lot (gate side half)
    const f = d.frame();
    const ix = -f.ox;
    const iy = -f.oy;
    // lot rectangle in world: side centre + inward*[0.12..0.95], along t [-0.9, 0.9]
    const p = (u: number, v: number): [number, number] => [f.sx + f.tx * u + ix * v, f.sy + f.ty * u + iy * v];
    const corners = [p(-0.86, 0.13), p(0.86, 0.13), p(0.86, 0.96), p(-0.86, 0.96)];
    const minX = Math.min(...corners.map((q) => q[0]));
    const maxX = Math.max(...corners.map((q) => q[0]));
    const minY = Math.min(...corners.map((q) => q[1]));
    const maxY = Math.max(...corners.map((q) => q[1]));
    ctx.fillStyle = th.dark ? 'rgba(0,0,0,0.28)' : col.light;
    ctx.beginPath();
    rrect(ctx, minX, minY, maxX - minX, maxY - minY, 0.14);
    ctx.fill();
    // slot separators
    ctx.strokeStyle = th.dark ? 'rgba(255,255,255,0.22)' : col.base;
    ctx.globalAlpha = th.dark ? 1 : 0.55;
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    for (const u of [-0.5, 0, 0.5]) {
      const [x0, y0] = p(u, 0.56);
      const [x1, y1] = p(u, 0.92);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // entrance marker
    const gu = d.gateU();
    const [ex0, ey0] = p(gu, 0.0);
    const [ex1, ey1] = p(gu, 0.5);
    ctx.strokeStyle = th.road;
    ctx.lineCap = 'round';
    ctx.lineWidth = DRIVE_W * 0.9;
    ctx.beginPath();
    ctx.moveTo(ex0, ey0);
    ctx.lineTo(ex1, ey1);
    ctx.stroke();
    ctx.restore();
  }

  private drawPins(game: Game, d: Destination): void {
    const ctx = this.ctx;
    const th = this.theme;
    const s = this.popScale(game, d.born);
    const f = d.frame();
    const ix = -f.ox;
    const iy = -f.oy;
    const p = (u: number, v: number): [number, number] => [f.sx + f.tx * u + ix * v, f.sy + f.ty * u + iy * v];
    const shown = Math.min(d.pins, 8);
    const col = PALETTE[d.color];
    for (let k = 0; k < shown; k++) {
      const row = Math.floor(k / 4);
      const colI = k % 4;
      const [x, y] = p(-0.6 + colI * 0.4, 1.32 + row * 0.3);
      // customers grow impatient: white -> amber -> red
      const age = game.time - d.pinTimes[k];
      const late = age > PIN_PATIENCE;
      const warm = age > PIN_PATIENCE * 0.6;
      const r = (late ? 0.1 + 0.012 * Math.sin(this.time * 8 + k) : 0.085) * s;
      ctx.fillStyle = late ? th.danger : warm ? '#FFC46B' : th.pin;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = late ? '#FFFFFF' : col.dark;
      ctx.lineWidth = 0.025;
      ctx.stroke();
    }
    if (d.pins > 8) {
      // "+" marker for more pins
      const [x, y] = p(0.86, 1.47);
      ctx.fillStyle = th.pin;
      ctx.beginPath();
      ctx.arc(x, y, 0.05, 0, TAU);
      ctx.fill();
    }
    if (game.free) return;
    if (d.timer > 0) {
      const prog = clamp(d.timer / OVERFLOW_TIME, 0, 1);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (5 + prog * 7));
      const R = 1.5 + pulse * 0.06;
      ctx.lineCap = 'round';
      ctx.strokeStyle = th.dark ? 'rgba(255,255,255,0.16)' : 'rgba(40,30,20,0.14)';
      ctx.lineWidth = 0.2;
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, R, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = th.danger;
      ctx.lineWidth = 0.2 + pulse * 0.05;
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, R, -Math.PI / 2, -Math.PI / 2 + prog * TAU);
      ctx.stroke();
    } else if (game.stress(d) >= WARN_STRESS) {
      // about to overflow: a pulsing amber ring
      const beat = 0.5 + 0.5 * Math.sin(this.time * 4);
      ctx.strokeStyle = WARN_COLOR;
      ctx.globalAlpha = 0.45 + beat * 0.45;
      ctx.lineWidth = 0.12;
      ctx.setLineDash([0.22, 0.14]);
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, 1.5, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------
  // Cars
  // ------------------------------------------------------------------

  private drawCars(game: Game, elevated: boolean): void {
    for (const c of game.traffic.cars) {
      if (c.state === 'home' || c.state === 'leaving') continue;
      const seg = c.state === 'driving' ? c.segs[c.i] : null;
      const onMw = !!seg && seg.kind === SEG_LINK && seg.motorway;
      if (onMw !== elevated) continue;
      this.drawCar(c);
    }
  }

  private drawCar(c: Car): void {
    const s = 0.6 + 0.4 * c.fade;
    this.drawCarShape(c.x, c.y, c.a, c.color, s, c.brake);
  }

  private drawCarShape(x: number, y: number, a: number, color: number, scale: number, brake: number): void {
    const ctx = this.ctx;
    const col = PALETTE[color];
    const L = CAR_LEN * scale;
    const W = CAR_WID * scale;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const z = this.wz;
    ctx.setTransform(z * cos, z * sin, -z * sin, z * cos, this.wox + z * x, this.woy + z * y);
    ctx.fillStyle = this.theme.shadow;
    ctx.beginPath();
    rrect(ctx, -L / 2 + 0.012, -W / 2 + 0.022, L, W, 0.045);
    ctx.fill();
    ctx.fillStyle = col.base;
    ctx.beginPath();
    rrect(ctx, -L / 2, -W / 2, L, W, 0.045);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    rrect(ctx, L * 0.04, -W * 0.33, L * 0.2, W * 0.66, 0.02);
    ctx.fill();
    if (brake > 0.3 && this.cam.zoom > 24) {
      ctx.fillStyle = `rgba(255,70,60,${Math.min(1, brake)})`;
      ctx.fillRect(-L / 2 - 0.004, -W / 2 + 0.012, 0.02, 0.03);
      ctx.fillRect(-L / 2 - 0.004, W / 2 - 0.042, 0.02, 0.03);
    }
    ctx.setTransform(z, 0, 0, z, this.wox, this.woy);
  }

  // ------------------------------------------------------------------
  // Previews & fx
  // ------------------------------------------------------------------

  private drawPreview(game: Game, builder: Builder | null, opts: RenderOptions): void {
    const ctx = this.ctx;
    const th = this.theme;
    if (!builder) return;
    if (builder.mw) {
      const m = builder.mw;
      ctx.lineCap = 'round';
      ctx.strokeStyle = m.ok ? th.ok : th.danger;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = ROAD_W + 0.08;
      ctx.setLineDash([0.2, 0.16]);
      ctx.beginPath();
      if (m.bx !== m.ax || m.by !== m.ay) {
        const c = motorwayCurve(m.ax, m.ay, m.bx, m.by, m.dir);
        ctx.moveTo(m.ax + 0.5, m.ay + 0.5);
        ctx.lineTo(c[0], c[1]);
        ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
        ctx.lineTo(m.bx + 0.5, m.by + 0.5);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      for (const [x, y] of [[m.ax, m.ay], [m.bx, m.by]]) {
        ctx.strokeStyle = m.ok ? th.ok : th.danger;
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        rrect(ctx, x + 0.08, y + 0.08, 0.84, 0.84, 0.18);
        ctx.stroke();
      }
      return;
    }
    if (!opts.showHover || !builder.hover || builder.active) return;
    const { x, y } = builder.hover;
    if (!game.world.inMap(x, y)) return;
    const tool = opts.tool;
    ctx.strokeStyle = opts.hoverValid ? (tool === 'erase' ? th.danger : th.dark ? 'rgba(255,255,255,0.5)' : 'rgba(40,40,60,0.35)') : th.danger;
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    rrect(ctx, x + 0.06, y + 0.06, 0.88, 0.88, 0.2);
    ctx.stroke();
    if ((tool === 'roundabout' || tool === 'light') && opts.hoverValid) {
      ctx.globalAlpha = 0.55;
      if (tool === 'roundabout') {
        ctx.strokeStyle = th.road;
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        ctx.arc(x + 0.5, y + 0.5, RING_R, 0, TAU);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#3DDC84';
        ctx.beginPath();
        ctx.arc(x + 0.5, y + 0.5, 0.12, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawFx(): void {
    const ctx = this.ctx;
    for (const r of this.fx.rings) {
      const t = r.t / r.dur;
      const e = 1 - Math.pow(1 - t, 3);
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.5);
      ctx.beginPath();
      ctx.arc(r.x, r.y, lerp(r.r0, r.r1, e), 0, TAU);
      ctx.stroke();
    }
    for (const p of this.fx.pops) {
      const t = p.t / 0.6;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.color;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU + 0.4;
        const r = 0.08 + t * 0.35;
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 0.05 * (1 - t), 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const c of this.fx.crosses) {
      const t = c.t / 0.7;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = this.theme.danger;
      ctx.lineWidth = 0.08;
      ctx.lineCap = 'round';
      const s = 0.18 + t * 0.06;
      const x = c.x + 0.5;
      const y = c.y + 0.5;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** arrows at the screen border pointing to overflowing destinations */
  /**
   * Screen-space alerts, readable at any zoom: a badge above every building about
   * to overflow ("!" then the seconds left), or an arrow at the screen edge when it is out of view.
   */
  private drawOffscreenAlerts(game: Game): void {
    const ctx = this.ctx;
    const cam = this.cam;
    const p = cam.pad;
    if (game.free || game.state !== 'play') return;
    for (const d of game.dests) {
      const hot = d.timer > 0;
      if (!hot && game.stress(d) < WARN_STRESS) continue;
      const tone = hot ? this.theme.danger : WARN_COLOR;
      const sx = cam.toScreenX(d.cx);
      const sy = cam.toScreenY(d.cy);
      const m = 28;
      if (sx > p.left && sx < this.width - p.right && sy > p.top && sy < this.height - p.bottom) {
        const left = OVERFLOW_TIME - d.timer;
        const beat = hot && left < 10 ? 1 + 0.12 * Math.sin(this.time * 12) : 1;
        const by = Math.max(p.top + 16, cam.toScreenY(d.y) - 16);
        ctx.save();
        ctx.translate(sx, by);
        ctx.scale(beat, beat);
        ctx.fillStyle = tone;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '800 14px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(hot ? String(Math.max(1, Math.ceil(left))) : '!', 0, 1);
        ctx.restore();
        continue;
      }
      const x = clamp(sx, p.left + m, this.width - p.right - m);
      const y = clamp(sy, p.top + m, this.height - p.bottom - m);
      const a = Math.atan2(sy - y, sx - x);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = PALETTE[d.color].base;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = tone;
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (hot) ctx.arc(0, 0, 14, -Math.PI / 2, -Math.PI / 2 + (d.timer / OVERFLOW_TIME) * TAU);
      else ctx.arc(0, 0, 14, 0, TAU);
      ctx.stroke();
      ctx.rotate(a);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(1, -5);
      ctx.lineTo(1, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}
