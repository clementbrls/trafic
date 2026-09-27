import { clamp, damp } from '../core/math';
import type { Bounds } from '../game/world';

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 2D camera: world (tiles) <-> screen (CSS pixels). */
export class Camera {
  x = 0;
  y = 0;
  zoom = 40;
  /** target for smooth moves */
  tx = 0;
  ty = 0;
  tzoom = 40;
  width = 1;
  height = 1;
  pad: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
  /** true while the user controls the camera manually */
  manual = false;
  minZoom = 8;
  maxZoom = 110;
  private fitZoom = 40;

  setViewport(w: number, h: number, pad: Padding): void {
    this.width = w;
    this.height = h;
    this.pad = pad;
  }

  toScreenX(wx: number): number {
    return (wx - this.x) * this.zoom + this.width / 2;
  }

  toScreenY(wy: number): number {
    return (wy - this.y) * this.zoom + this.height / 2;
  }

  toWorldX(sx: number): number {
    return (sx - this.width / 2) / this.zoom + this.x;
  }

  toWorldY(sy: number): number {
    return (sy - this.height / 2) / this.zoom + this.y;
  }

  /** Compute the camera that frames `b` inside the padded viewport. */
  fitTarget(b: Bounds, margin = 0.6): { x: number; y: number; zoom: number } {
    const p = this.pad;
    const aw = Math.max(50, this.width - p.left - p.right);
    const ah = Math.max(50, this.height - p.top - p.bottom);
    const bw = b.x1 - b.x0 + margin * 2;
    const bh = b.y1 - b.y0 + margin * 2;
    const zoom = clamp(Math.min(aw / bw, ah / bh), 4, this.maxZoom);
    // centre of the padded area in screen space, converted to world offset
    const cxScreen = p.left + aw / 2;
    const cyScreen = p.top + ah / 2;
    const wx = (b.x0 + b.x1) / 2 - (cxScreen - this.width / 2) / zoom;
    const wy = (b.y0 + b.y1) / 2 - (cyScreen - this.height / 2) / zoom;
    return { x: wx, y: wy, zoom };
  }

  fit(b: Bounds, instant = false): void {
    const t = this.fitTarget(b);
    this.fitZoom = t.zoom;
    this.minZoom = Math.min(t.zoom * 0.85, 30);
    this.tx = t.x;
    this.ty = t.y;
    this.tzoom = t.zoom;
    this.manual = false;
    if (instant) {
      this.x = t.x;
      this.y = t.y;
      this.zoom = t.zoom;
    }
  }

  get isZoomedIn(): boolean {
    return this.zoom > this.fitZoom * 1.08;
  }

  update(dt: number): void {
    if (this.manual) return;
    this.x = damp(this.x, this.tx, 7, dt);
    this.y = damp(this.y, this.ty, 7, dt);
    this.zoom = damp(this.zoom, this.tzoom, 7, dt);
  }

  /** Zoom around a screen point. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    this.x = wx - (sx - this.width / 2) / this.zoom;
    this.y = wy - (sy - this.height / 2) / this.zoom;
    this.manual = true;
  }

  pan(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.manual = true;
  }

  /** keep the view centre from drifting too far away from the map */
  clampTo(b: Bounds): void {
    this.x = clamp(this.x, b.x0 - 1, b.x1 + 1);
    this.y = clamp(this.y, b.y0 - 1, b.y1 + 1);
  }

  focus(wx: number, wy: number, zoom: number): void {
    this.tx = wx;
    this.ty = wy;
    this.tzoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.manual = false;
  }
}
