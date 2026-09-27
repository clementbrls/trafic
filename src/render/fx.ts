/** Short-lived visual effects drawn in world space. */
export interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  t: number;
  dur: number;
  color: string;
  width: number;
}

export interface Cross {
  x: number;
  y: number;
  t: number;
}

export interface Pop {
  x: number;
  y: number;
  t: number;
  color: string;
}

export class Fx {
  rings: Ring[] = [];
  crosses: Cross[] = [];
  pops: Pop[] = [];

  ring(x: number, y: number, color: string, r0 = 0.2, r1 = 1.4, dur = 0.8, width = 0.08): void {
    this.rings.push({ x, y, r0, r1, t: 0, dur, color, width });
  }

  cross(x: number, y: number): void {
    this.crosses.push({ x, y, t: 0 });
  }

  pop(x: number, y: number, color: string): void {
    this.pops.push({ x, y, t: 0, color });
  }

  update(dt: number): void {
    for (const r of this.rings) r.t += dt;
    for (const c of this.crosses) c.t += dt;
    for (const p of this.pops) p.t += dt;
    this.rings = this.rings.filter((r) => r.t < r.dur);
    this.crosses = this.crosses.filter((c) => c.t < 0.7);
    this.pops = this.pops.filter((p) => p.t < 0.6);
  }

  clear(): void {
    this.rings.length = 0;
    this.crosses.length = 0;
    this.pops.length = 0;
  }
}
