// Axisymmetric stock for the lathe: outer radius ro[i] and inner radius ri[i]
// sampled along Z. Cutting tools carve the profile by their silhouette.

import { latheSilhouette } from './tools.js';

export class LatheStock {
  constructor({ od = 50, id = 0, zFront = 1, length = 80, stickOut }) {
    this.stickOut = stickOut ?? Math.max(20, length * 0.8);
    this.od = od;
    this.id = id;
    this.zFront = zFront;
    this.zBack = zFront - length;
    this.length = length;
    this.dz = Math.max(0.04, length / 5000);
    this.n = Math.ceil(length / this.dz) + 1;
    this.ro = new Float32Array(this.n);
    this.ri = new Float32Array(this.n);
    this.thr = new Float32Array(this.n); // thread pitch per column (0 = not threaded)
    this.version = 0;
    this.dirtyLo = 0;
    this.dirtyHi = this.n - 1;
    this.sils = new Map();
    this.reset();
  }

  reset() {
    this.ro.fill(this.od / 2);
    this.ri.fill(this.id / 2);
    this.thr.fill(0);
    this.dirtyLo = 0;
    this.dirtyHi = this.n - 1;
    this.version++;
  }

  z(i) {
    return this.zBack + i * this.dz;
  }
  index(z) {
    return (z - this.zBack) / this.dz;
  }

  silFor(tool) {
    const key = `${tool.n}:${tool.type}:${tool.dia}:${tool.nose}:${tool.tip}:${tool.insert}:${tool.width}:${tool.ref}:${tool.len}:${tool.tipAngle}`;
    let s = this.sils.get(key);
    if (!s) {
      s = latheSilhouette(tool);
      this.sils.set(key, s);
    }
    return s;
  }

  // Carve with the tool reference at (zc, xc). Returns amount of radial material removed.
  stamp(sil, zc, xc) {
    const i0 = Math.max(0, Math.floor(this.index(zc + sil.zmin)));
    const i1 = Math.min(this.n - 1, Math.ceil(this.index(zc + sil.zmax)));
    let removed = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const od = sil.kind === 'od';
    for (let i = i0; i <= i1; i++) {
      const b = sil.at(this.z(i) - zc);
      if (b !== b) continue;
      const cap = xc + b;
      if (od) {
        if (cap < this.ro[i]) {
          const nv = Math.max(cap, this.ri[i]);
          removed += this.ro[i] - nv;
          this.ro[i] = nv;
          if (i < lo) lo = i;
          hi = i;
        }
      } else if (cap > this.ri[i]) {
        const nv = Math.min(cap, this.ro[i]);
        removed += nv - this.ri[i];
        this.ri[i] = nv;
        if (i < lo) lo = i;
        hi = i;
      }
    }
    if (hi >= 0) this.markDirty(lo, hi);
    return removed;
  }

  markDirty(lo, hi) {
    if (lo < this.dirtyLo) this.dirtyLo = lo;
    if (hi > this.dirtyHi) this.dirtyHi = hi;
    this.version++;
  }

  // Sweep the tool between two reference positions given as [x(radius), 0, z].
  sweep(tool, a, b) {
    const sil = this.silFor(tool);
    const dzm = Math.abs(b[2] - a[2]);
    const drm = Math.abs(b[0] - a[0]);
    const n = Math.max(1, Math.ceil(Math.max(dzm / this.dz, drm / 0.4)));
    let removed = 0;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      removed += this.stamp(sil, a[2] + (b[2] - a[2]) * t, a[0] + (b[0] - a[0]) * t);
    }
    return removed;
  }

  // Thread: repeated V-grooves every `pitch` along the pass, between fractions t0..t1.
  sweepThread(tool, a, b, pitch, t0, t1) {
    const sil = this.silFor(tool);
    const dz = b[2] - a[2];
    if (Math.abs(dz) < 1e-9) return this.sweep(tool, a, b);
    const total = Math.abs(dz);
    const s0 = t0 * total;
    const s1 = t1 * total;
    let removed = 0;
    const kStart = Math.ceil(s0 / pitch - 1e-9);
    const kEnd = Math.floor(s1 / pitch + 1e-9);
    for (let k = kStart; k <= kEnd; k++) {
      const s = k * pitch;
      const t = s / total;
      const z = a[2] + Math.sign(dz) * s;
      const x = a[0] + (b[0] - a[0]) * t;
      const got = this.stamp(sil, z, x);
      if (got > 1e-6) {
        const a = Math.max(0, Math.floor(this.index(z - pitch)));
        const b = Math.min(this.n - 1, Math.ceil(this.index(z + pitch)));
        for (let i = a; i <= b; i++) this.thr[i] = pitch;
      }
      removed += got;
    }
    return removed;
  }

  // Cylinder of material as profile for rendering
  maxRadius() {
    return this.od / 2;
  }
}
