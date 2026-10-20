// Height-map stock for milling. Vertices lie on a regular XY grid and store the
// top surface height. A tool removes material wherever its bottom profile dips
// below the stored height.

import { millProfile } from './tools.js';

export class MillStock {
  constructor({ x0, x1, y0, y1, z0, z1 }) {
    this.x0 = x0; this.x1 = x1;
    this.y0 = y0; this.y1 = y1;
    this.z0 = z0; this.z1 = z1;
    const span = Math.max(x1 - x0, y1 - y0);
    this.cell = Math.min(2, Math.max(0.25, span / 300));
    this.nx = Math.max(2, Math.round((x1 - x0) / this.cell) + 1);
    this.ny = Math.max(2, Math.round((y1 - y0) / this.cell) + 1);
    this.sx = (x1 - x0) / (this.nx - 1);
    this.sy = (y1 - y0) / (this.ny - 1);
    this.h = new Float32Array(this.nx * this.ny);
    this.profiles = new Map();
    this.version = 0;
    this.reset();
  }

  reset() {
    this.h.fill(this.z1);
    this.dirty = { i0: 0, i1: this.nx - 1, j0: 0, j1: this.ny - 1 };
    this.version++;
  }

  profileFor(tool) {
    const key = `${tool.type}:${tool.dia}:${tool.cr}:${tool.tipAngle}:${tool.tipDia}`;
    let p = this.profiles.get(key);
    if (!p) {
      p = millProfile(tool);
      this.profiles.set(key, p);
    }
    return p;
  }

  // Returns { cut, floor, shank }
  stamp(prof, len, x, y, z) {
    const R = prof.R;
    const res = { cut: 0, floor: false, shank: false };
    if (z >= this.z1) return res;
    const i0 = Math.max(0, Math.ceil((x - R - this.x0) / this.sx));
    const i1 = Math.min(this.nx - 1, Math.floor((x + R - this.x0) / this.sx));
    const j0 = Math.max(0, Math.ceil((y - R - this.y0) / this.sy));
    const j1 = Math.min(this.ny - 1, Math.floor((y + R - this.y0) / this.sy));
    if (i1 < i0 || j1 < j0) return res;
    const R2 = R * R;
    const inv = 1 / prof.step;
    let ci0 = Infinity, ci1 = -1, cj0 = Infinity, cj1 = -1;
    for (let j = j0; j <= j1; j++) {
      const dy = this.y0 + j * this.sy - y;
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const dx = this.x0 + i * this.sx - x;
        const r2 = dx * dx + dy * dy;
        if (r2 > R2) continue;
        const rho = Math.sqrt(r2);
        const zb = z + prof.lut[(rho * inv) | 0];
        const k = row + i;
        const cur = this.h[k];
        if (zb < cur) {
          let nz = zb;
          if (nz < this.z0) {
            nz = this.z0;
            res.floor = true;
          }
          if (nz < cur) {
            this.h[k] = nz;
            res.cut += cur - nz;
            if (i < ci0) ci0 = i;
            if (i > ci1) ci1 = i;
            if (j < cj0) cj0 = j;
            if (j > cj1) cj1 = j;
          }
        }
        if (this.h[k] > z + len + 0.02) res.shank = true;
      }
    }
    if (ci1 >= 0) {
      const d = this.dirty;
      if (ci0 < d.i0) d.i0 = ci0;
      if (ci1 > d.i1) d.i1 = ci1;
      if (cj0 < d.j0) d.j0 = cj0;
      if (cj1 > d.j1) d.j1 = cj1;
      this.version++;
    }
    return res;
  }

  sweep(tool, a, b, nocut = false) {
    const res = { cut: 0, floor: false, shank: false };
    if (nocut) return res;
    const prof = this.profileFor(tool);
    const len = tool.len || 30;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    const step = Math.max(0.05, Math.min(this.sx, this.sy) * 0.7);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const r = this.stamp(prof, len, a[0] + dx * t, a[1] + dy * t, a[2] + dz * t);
      res.cut += r.cut;
      res.floor ||= r.floor;
      res.shank ||= r.shank;
    }
    return res;
  }

  takeDirty() {
    const d = this.dirty;
    this.dirty = { i0: Infinity, i1: -1, j0: Infinity, j1: -1 };
    return d.i1 < d.i0 ? null : d;
  }
}
