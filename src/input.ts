import type { Camera } from './render/camera';
import type { Builder, Tool } from './game/builder';
import type { Bounds } from './game/world';

export interface InputHost {
  cam: Camera;
  builder(): Builder | null;
  tool(): Tool;
  /** false while menus / modals are open */
  canBuild(): boolean;
  canView(): boolean;
  bounds(): Bounds;
  onInteract(): void;
  onHover(active: boolean): void;
}

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
  type: string;
  button: number;
}

type Mode = 'none' | 'stroke' | 'pending' | 'pan' | 'pinch' | 'tap' | 'wait';

const TAP_SLOP = 10;
const PINCH_CANCEL_MS = 280;

/** Pointer / touch / keyboard handling for the map canvas. */
export class Input {
  private canvas: HTMLCanvasElement;
  private host: InputHost;
  private ptrs = new Map<number, Ptr>();
  private mode: Mode = 'none';
  private strokeStart = 0;
  private pinch: { mx: number; my: number; d: number } | null = null;
  private space = false;
  private moved = false;
  /** builder that owns the current stroke (kept even if a modal opens meanwhile) */
  private stroke: Builder | null = null;
  private strokeTool: Tool = 'road';
  /** touch strokes that cannot be undone (eraser, motorway) wait until they are clearly not a pinch */
  private pending: { wx: number; wy: number; tool: Tool; t: number } | null = null;

  constructor(canvas: HTMLCanvasElement, host: InputHost) {
    this.canvas = canvas;
    this.host = host;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.space = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.space = false;
    });
    window.addEventListener('blur', () => {
      this.space = false;
      this.endAll();
    });
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private world(sx: number, sy: number): [number, number] {
    const c = this.host.cam;
    return [c.toWorldX(sx), c.toWorldY(sy)];
  }

  private beginStroke(b: Builder, wx: number, wy: number, tool: Tool): void {
    b.begin(wx, wy, tool);
    this.stroke = b;
    this.strokeTool = tool;
    this.mode = 'stroke';
    this.strokeStart = performance.now();
  }

  private finishStroke(): void {
    this.stroke?.end();
    this.stroke = null;
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.host.canView()) return;
    this.host.onInteract();
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const [sx, sy] = this.local(e);
    this.ptrs.set(e.pointerId, { x: sx, y: sy, sx, sy, t: performance.now(), type: e.pointerType, button: e.button });
    if (this.ptrs.size >= 2) {
      // second finger: switch to pinch, revert a fresh stroke
      if (this.mode === 'stroke' && this.stroke) {
        const fresh = performance.now() - this.strokeStart < PINCH_CANCEL_MS;
        if (fresh || this.strokeTool === 'motorway') this.stroke.cancel();
        else this.stroke.end();
        this.stroke = null;
      }
      this.pending = null;
      this.startPinch();
      return;
    }
    this.moved = false;
    const b = this.host.builder();
    const canBuild = this.host.canBuild() && !!b;
    if (e.pointerType === 'mouse' && (e.button === 1 || this.space)) {
      this.mode = 'pan';
      this.canvas.classList.add('pan');
      return;
    }
    if (!canBuild || !b) {
      this.mode = 'pan';
      return;
    }
    const [wx, wy] = this.world(sx, sy);
    if (e.pointerType === 'mouse' && e.button === 2) {
      this.beginStroke(b, wx, wy, 'erase');
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const tool = this.host.tool();
    if (tool === 'roundabout' || tool === 'light' || tool === 'rules') {
      this.mode = 'tap';
      return;
    }
    if (e.pointerType !== 'mouse' && (tool === 'erase' || tool === 'motorway')) {
      this.pending = { wx, wy, tool, t: performance.now() };
      this.stroke = b;
      this.mode = 'pending';
      return;
    }
    this.beginStroke(b, wx, wy, tool);
  };

  private startPinch(): void {
    const pts = Array.from(this.ptrs.values()).slice(0, 2);
    const mx = (pts[0].x + pts[1].x) / 2;
    const my = (pts[0].y + pts[1].y) / 2;
    const d = Math.max(20, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
    this.pinch = { mx, my, d };
    this.mode = 'pinch';
  }

  private onMove = (e: PointerEvent): void => {
    const [sx, sy] = this.local(e);
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      // hover
      const b = this.host.builder();
      if (e.pointerType === 'mouse' && b && this.host.canBuild()) {
        if (b.active) b.end(); // a stroke lost its pointer (tab switch…): close it
        const [wx, wy] = this.world(sx, sy);
        b.move(wx, wy);
        this.host.onHover(true);
      }
      return;
    }
    const dx = sx - p.x;
    const dy = sy - p.y;
    p.x = sx;
    p.y = sy;
    if (Math.hypot(sx - p.sx, sy - p.sy) > TAP_SLOP) this.moved = true;
    const cam = this.host.cam;
    switch (this.mode) {
      case 'pending': {
        const pd = this.pending;
        const b = this.stroke;
        if (!pd || !b) break;
        if (this.moved || performance.now() - pd.t > PINCH_CANCEL_MS) {
          this.pending = null;
          this.beginStroke(b, pd.wx, pd.wy, pd.tool);
          const [wx, wy] = this.world(sx, sy);
          b.move(wx, wy);
        }
        break;
      }
      case 'stroke': {
        const [wx, wy] = this.world(sx, sy);
        this.stroke?.move(wx, wy);
        break;
      }
      case 'pan':
        cam.pan(dx, dy);
        cam.clampTo(this.host.bounds());
        break;
      case 'tap': {
        const b = this.host.builder();
        if (this.moved && p.type !== 'mouse') {
          this.mode = 'pan';
          cam.pan(sx - p.sx, sy - p.sy);
        } else if (p.type === 'mouse' && b) {
          const [wx, wy] = this.world(sx, sy);
          b.move(wx, wy);
        }
        break;
      }
      case 'pinch': {
        if (this.ptrs.size < 2 || !this.pinch) break;
        const pts = Array.from(this.ptrs.values()).slice(0, 2);
        const mx = (pts[0].x + pts[1].x) / 2;
        const my = (pts[0].y + pts[1].y) / 2;
        const d = Math.max(20, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        cam.pan(mx - this.pinch.mx, my - this.pinch.my);
        cam.zoomAt(mx, my, d / this.pinch.d);
        cam.clampTo(this.host.bounds());
        this.pinch = { mx, my, d };
        break;
      }
      default:
        break;
    }
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const [sx, sy] = this.local(e);
    if (this.mode === 'stroke' && this.ptrs.size === 1) this.finishStroke();
    else if (this.mode === 'pending' && this.ptrs.size === 1) {
      // a quick tap with the eraser erases the tile under the finger
      const pd = this.pending;
      const b = this.stroke;
      if (pd && b && pd.tool === 'erase' && this.host.canBuild()) {
        b.begin(pd.wx, pd.wy, 'erase');
        b.end();
      }
      this.pending = null;
      this.stroke = null;
    } else if (this.mode === 'tap' && !this.moved && this.host.canBuild()) {
      const b = this.host.builder();
      if (b) {
        const [wx, wy] = this.world(sx, sy);
        b.tap(wx, wy, this.host.tool());
      }
    }
    this.ptrs.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (this.ptrs.size === 0) {
      this.mode = 'none';
      this.pinch = null;
      this.canvas.classList.remove('pan');
    } else if (this.mode === 'pinch') {
      // keep panning with the remaining finger only after all are lifted
      this.mode = 'wait';
      this.pinch = null;
    }
  };

  private onCancel = (e: PointerEvent): void => {
    if (this.mode === 'stroke') this.finishStroke();
    this.pending = null;
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size === 0) {
      this.mode = 'none';
      this.pinch = null;
      this.stroke = null;
    }
  };

  private onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && !this.ptrs.has(e.pointerId)) {
      const b = this.host.builder();
      if (b) b.hover = null;
      this.host.onHover(false);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.host.canView()) return;
    e.preventDefault();
    const [sx, sy] = this.local(e);
    const k = e.deltaMode === 1 ? 0.05 : 0.0016;
    const f = Math.exp(-e.deltaY * k);
    this.host.cam.zoomAt(sx, sy, f);
    this.host.cam.clampTo(this.host.bounds());
  };

  /** Close any stroke in progress (modal opening, tab hidden, blur…). */
  endAll(): void {
    if (this.mode === 'stroke') this.finishStroke();
    this.stroke = null;
    this.pending = null;
    this.ptrs.clear();
    this.mode = 'none';
    this.pinch = null;
  }

  get busy(): boolean {
    return this.mode !== 'none';
  }
}
