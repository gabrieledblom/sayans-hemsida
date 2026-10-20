// Renders the milled workpiece (height map) plus vise and table.
// Mill frame (x, y, z up) -> three (x, z, -y).

import * as THREE from 'three';
import { disposeObject } from './scene.js';
import { COLORS } from './lathe-view.js';

export class MillView {
  constructor(parent, stock) {
    this.stock = stock;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.lastBuild = 0;
    this.lastVersion = -1;
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.5,
      roughness: 0.46,
      side: THREE.DoubleSide,
    });
    this.build();
  }

  build() {
    const s = this.stock;
    const { nx, ny } = s;
    this.topGeo = new THREE.BufferGeometry();
    this.tpos = new Float32Array(nx * ny * 3);
    this.tnor = new Float32Array(nx * ny * 3);
    this.tcol = new Float32Array(nx * ny * 3);
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[q++] = a; idx[q++] = b; idx[q++] = c;
        idx[q++] = b; idx[q++] = d; idx[q++] = c;
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = (j * nx + i) * 3;
        this.tpos[v] = s.x0 + i * s.sx;
        this.tpos[v + 2] = -(s.y0 + j * s.sy);
      }
    }
    this.topGeo.setAttribute('position', new THREE.BufferAttribute(this.tpos, 3).setUsage(THREE.DynamicDrawUsage));
    this.topGeo.setAttribute('normal', new THREE.BufferAttribute(this.tnor, 3).setUsage(THREE.DynamicDrawUsage));
    this.topGeo.setAttribute('color', new THREE.BufferAttribute(this.tcol, 3).setUsage(THREE.DynamicDrawUsage));
    this.topGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.top = new THREE.Mesh(this.topGeo, this.mat);
    this.top.frustumCulled = false;
    this.group.add(this.top);

    // Walls: 4 strips along the perimeter, each vertex pair = (top, bottom)
    const perim = [];
    for (let i = 0; i < nx; i++) perim.push([i, 0]);
    for (let j = 1; j < ny; j++) perim.push([nx - 1, j]);
    for (let i = nx - 2; i >= 0; i--) perim.push([i, ny - 1]);
    for (let j = ny - 2; j >= 1; j--) perim.push([0, j]);
    perim.push([0, 0]);
    this.perim = perim;
    const pc = perim.length;
    this.wpos = new Float32Array(pc * 2 * 3);
    this.wnor = new Float32Array(pc * 2 * 3);
    this.wcol = new Float32Array(pc * 2 * 3);
    const widx = [];
    for (let k = 0; k < pc - 1; k++) {
      const a = k * 2;
      widx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.wallGeo = new THREE.BufferGeometry();
    this.wallGeo.setAttribute('position', new THREE.BufferAttribute(this.wpos, 3).setUsage(THREE.DynamicDrawUsage));
    this.wallGeo.setAttribute('normal', new THREE.BufferAttribute(this.wnor, 3).setUsage(THREE.DynamicDrawUsage));
    this.wallGeo.setAttribute('color', new THREE.BufferAttribute(this.wcol, 3).setUsage(THREE.DynamicDrawUsage));
    this.wallGeo.setIndex(widx);
    this.walls = new THREE.Mesh(this.wallGeo, this.mat);
    this.walls.frustumCulled = false;
    this.group.add(this.walls);

    // Bottom
    const bw = s.x1 - s.x0, bh = s.y1 - s.y0;
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), new THREE.MeshStandardMaterial({ color: 0x59636f, metalness: 0.6, roughness: 0.6 }));
    bottom.rotation.x = Math.PI / 2;
    bottom.position.set((s.x0 + s.x1) / 2, s.z0 - 0.02, -(s.y0 + s.y1) / 2);
    this.group.add(bottom);

    this.buildFixture();
    this.update(true);
  }

  buildFixture() {
    const s = this.stock;
    const dark = new THREE.MeshStandardMaterial({ color: 0x232b36, metalness: 0.5, roughness: 0.65 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x3a4554, metalness: 0.7, roughness: 0.5 });
    const jawM = new THREE.MeshStandardMaterial({ color: 0x77828f, metalness: 0.8, roughness: 0.4 });
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
    const w = s.x1 - s.x0, d = s.y1 - s.y0;
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, z, -y);
      this.group.add(m);
      return m;
    };
    const tableTop = s.z0 - 28;
    add(new THREE.BoxGeometry(w + 360, 30, d + 360), dark, cx, cy, tableTop - 15);
    add(new THREE.BoxGeometry(w - 12, 26, d - 12), mid, cx, cy, s.z0 - 13);
    const stick = s.stick ?? Math.max(5, (s.z1 - s.z0) * 0.6);
    const jawTop = Math.max(s.z0 + 2, Math.min(s.z1, s.z1 - stick));
    const jawBottom = s.z0 - 28;
    const jh = jawTop - jawBottom;
    add(new THREE.BoxGeometry(26, jh, d + 40), jawM, s.x0 - 13.5, cy, jawBottom + jh / 2);
    add(new THREE.BoxGeometry(26, jh, d + 40), jawM, s.x1 + 13.5, cy, jawBottom + jh / 2);
    add(new THREE.BoxGeometry(60, 40, d + 40), dark, s.x0 - 56, cy, s.z0 - 8);
    add(new THREE.BoxGeometry(60, 40, d + 40), dark, s.x1 + 56, cy, s.z0 - 8);
  }

  update(force = false) {
    const st = this.stock;
    const now = performance.now();
    if (!force && st.version === this.lastVersion) return;
    if (!force && now - this.lastBuild < 28) return;
    this.lastBuild = now;
    this.lastVersion = st.version;
    const dirty = force ? { i0: 0, i1: st.nx - 1, j0: 0, j1: st.ny - 1 } : st.takeDirty();
    if (!dirty) return;
    const { nx, ny, h, sx, sy, z1 } = st;
    const i0 = Math.max(0, dirty.i0 - 1), i1 = Math.min(nx - 1, dirty.i1 + 1);
    const j0 = Math.max(0, dirty.j0 - 1), j1 = Math.min(ny - 1, dirty.j1 + 1);
    const P = this.tpos, N = this.tnor, C = this.tcol;
    const col = new THREE.Color();
    const shade = (hv, out, o) => {
      const depth = z1 - hv;
      if (depth < 0.01) col.copy(COLORS.raw);
      else {
        col.copy(COLORS.machined);
        const k = 1 - Math.min(0.38, depth / 70);
        col.multiplyScalar(k);
      }
      out[o] = col.r; out[o + 1] = col.g; out[o + 2] = col.b;
    };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const v = k * 3;
        const hv = h[k];
        P[v + 1] = hv;
        const hl = h[j * nx + Math.max(0, i - 1)], hr = h[j * nx + Math.min(nx - 1, i + 1)];
        const hd = h[Math.max(0, j - 1) * nx + i], hu = h[Math.min(ny - 1, j + 1) * nx + i];
        const hx = (hr - hl) / ((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) * sx || 1);
        const hy = (hu - hd) / ((Math.min(ny - 1, j + 1) - Math.max(0, j - 1)) * sy || 1);
        const l = Math.hypot(hx, hy, 1);
        N[v] = -hx / l; N[v + 1] = 1 / l; N[v + 2] = hy / l;
        shade(hv, C, v);
      }
    }
    // walls (cheap, always refresh)
    const W = this.wpos, WN = this.wnor, WC = this.wcol;
    const z0 = st.z0;
    this.perim.forEach(([i, j], k) => {
      const x = st.x0 + i * sx, zt = -(st.y0 + j * sy);
      const hv = h[j * nx + i];
      const a = k * 6;
      W[a] = x; W[a + 1] = hv; W[a + 2] = zt;
      W[a + 3] = x; W[a + 4] = z0; W[a + 5] = zt;
      let nxv = 0, nzv = 0;
      if (j === 0) nzv = 1;
      else if (j === ny - 1) nzv = -1;
      if (i === 0) nxv = -1;
      else if (i === nx - 1) nxv = 1;
      WN[a] = nxv; WN[a + 2] = nzv; WN[a + 3] = nxv; WN[a + 5] = nzv;
      shade(hv, WC, a);
      WC[a + 3] = COLORS.raw.r * 0.8; WC[a + 4] = COLORS.raw.g * 0.8; WC[a + 5] = COLORS.raw.b * 0.8;
    });
    this.topGeo.attributes.position.needsUpdate = true;
    this.topGeo.attributes.normal.needsUpdate = true;
    this.topGeo.attributes.color.needsUpdate = true;
    this.wallGeo.attributes.position.needsUpdate = true;
    this.wallGeo.attributes.normal.needsUpdate = true;
    this.wallGeo.attributes.color.needsUpdate = true;
  }

  setStock(stock) {
    this.stock = stock;
    this.group.clear();
    this.build();
  }

  dispose() {
    this.group.parent?.remove(this.group);
    disposeObject(this.group);
  }
}
