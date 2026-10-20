// Renders the turned workpiece (revolved profile with optional cut-away),
// chuck and spindle housing. Lathe frame -> three: (z, r, 0) => (x, y, z).

import * as THREE from 'three';
import { disposeObject } from './scene.js';

const MAX_COLS = 900;
const K_FULL = 96;

export const COLORS = {
  raw: new THREE.Color(0x7d8794),
  machined: new THREE.Color(0xdfe6ee),
  inner: new THREE.Color(0xc9d3de),
  section: new THREE.Color(0x3fb6c4),
};

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 4);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(rnd() * 256);
    const w = 1 + Math.floor(rnd() * 3);
    g.fillStyle = `rgba(150,160,175,${0.25 + rnd() * 0.3})`;
    g.fillRect(x, 0, w, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class LatheView {
  constructor(parent, stock) {
    this.stock = stock;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.section = 'quarter';
    this.lastVersion = -1;
    this.lastBuild = 0;
    this.spin = 0;
    this.tex = stripeTexture();
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.tex,
      metalness: 0.5,
      roughness: 0.46,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.buildMachine();
    this.configure();
  }

  buildMachine() {
    const s = this.stock;
    const R = s.od / 2;
    this.fixed = new THREE.Group();
    this.group.add(this.fixed);
    this.chuck = new THREE.Group();
    this.group.add(this.chuck);
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a5565, metalness: 0.7, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x252d38, metalness: 0.5, roughness: 0.7 });
    const jawMat = new THREE.MeshStandardMaterial({ color: 0x8a95a3, metalness: 0.8, roughness: 0.35 });

    const chuckR = Math.max(R + 28, 55);
    const chuckLen = 42;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(chuckR, chuckR, chuckLen, 64), steel);
    body.rotation.z = Math.PI / 2;
    body.position.x = s.zBack - chuckLen / 2 - 2;
    this.chuck.add(body);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(chuckR, 2.2, 10, 64), dark);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = s.zBack - 2;
    this.chuck.add(ring);
    for (let i = 0; i < 3; i++) {
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(26, 14, 20), jawMat);
      const a = (i * 2 * Math.PI) / 3 + Math.PI / 2;
      const rad = R + 7 - 1;
      jaw.position.set(s.zBack + 12, Math.cos(a) * rad, Math.sin(a) * rad);
      jaw.rotation.x = a;
      this.chuck.add(jaw);
    }
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(chuckR * 0.82, chuckR * 0.9, 90, 48), dark);
    nose.rotation.z = Math.PI / 2;
    nose.position.x = s.zBack - chuckLen - 2 - 45;
    this.fixed.add(nose);
    const head = new THREE.Mesh(new THREE.BoxGeometry(140, chuckR * 2.6, chuckR * 2.6), dark);
    head.position.x = s.zBack - chuckLen - 2 - 90 - 70;
    this.fixed.add(head);
    const bedY = -(chuckR + 40);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(900, 24, chuckR * 3.2), dark);
    bed.position.set(s.zBack + 250, bedY, 0);
    this.fixed.add(bed);
  }

  setSection(mode) {
    this.section = mode;
    this.configure();
  }

  spanTheta() {
    switch (this.section) {
      case 'full': return [0, Math.PI * 2];
      case 'half': return [Math.PI, Math.PI * 2];
      default: return [(135 * Math.PI) / 180, (270 * Math.PI) / 180];
    }
  }

  configure() {
    const [th0, span] = this.spanTheta();
    this.th0 = th0;
    this.span = span;
    this.K = Math.max(8, Math.round((K_FULL * span) / (2 * Math.PI)));
    const n = this.stock.n;
    this.M = Math.min(MAX_COLS, n);
    const M = this.M;
    const K = this.K;
    const ringV = K + 1;
    this.off = {
      outer: 0,
      inner: M * ringV,
      cutA: 2 * M * ringV,
      cutB: 2 * M * ringV + 2 * M,
      back: 2 * M * ringV + 4 * M,
      front: 2 * M * ringV + 4 * M + 2 * ringV,
    };
    const V = 2 * M * ringV + 4 * M + 4 * ringV;
    this.pos = new Float32Array(V * 3);
    this.nor = new Float32Array(V * 3);
    this.col = new Float32Array(V * 3);
    this.uv = new Float32Array(V * 2);
    const idx = [];
    const o = this.off;
    for (let j = 0; j < M - 1; j++) {
      for (let k = 0; k < K; k++) {
        const a = o.outer + j * ringV + k;
        const c = a + ringV;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
        const ia = o.inner + j * ringV + k;
        const ic = ia + ringV;
        idx.push(ia, ia + 1, ic, ia + 1, ic + 1, ic);
      }
    }
    const quadStrip = (base) => {
      for (let j = 0; j < M - 1; j++) {
        const a = base + j * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };
    quadStrip(o.cutA);
    quadStrip(o.cutB);
    for (const base of [o.back, o.front]) {
      for (let k = 0; k < K; k++) {
        const i0 = base + k;
        const o0 = base + ringV + k;
        idx.push(i0, o0, i0 + 1, i0 + 1, o0, o0 + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.lastVersion = -1;
    this.update(true);
  }

  setStock(stock) {
    this.stock = stock;
    this.group.remove(this.fixed);
    this.group.remove(this.chuck);
    disposeObject(this.fixed);
    disposeObject(this.chuck);
    this.buildMachine();
    this.configure();
  }

  setSpin(rpm, dt) {
    const w = Math.min(Math.abs(rpm), 1800) / 60;
    const dir = rpm < 0 ? -1 : 1;
    this.spin += dir * w * dt * 0.6;
    this.chuck.rotation.x = this.spin * Math.PI * 2;
    this.tex.offset.x = -this.spin;
  }

  update(force = false) {
    const st = this.stock;
    const now = performance.now();
    if (!force && st.version === this.lastVersion) return;
    if (!force && now - this.lastBuild < 28) return;
    this.lastBuild = now;
    this.lastVersion = st.version;

    const M = this.M, K = this.K, ringV = K + 1;
    const n = st.n;
    const win = Math.max(1, Math.floor(n / M));
    const zs = new Float32Array(M);
    const ro = new Float32Array(M);
    const ri = new Float32Array(M);
    const od2 = st.od / 2;
    for (let j = 0; j < M; j++) {
      const c = M === 1 ? 0 : Math.round((j * (n - 1)) / (M - 1));
      const a = Math.max(0, c - (win >> 1));
      const b = Math.min(n - 1, c + (win >> 1));
      let mn = Infinity, mx = -Infinity;
      for (let i = a; i <= b; i++) {
        if (st.ro[i] < mn) mn = st.ro[i];
        if (st.ri[i] > mx) mx = st.ri[i];
      }
      zs[j] = st.z(c);
      ro[j] = mn;
      ri[j] = Math.min(mx, mn);
    }
    const hasInner = ri.some((v) => v > 0.005);
    const P = this.pos, N = this.nor, C = this.col, U = this.uv;
    const o = this.off;
    const cosT = new Float32Array(ringV), sinT = new Float32Array(ringV);
    for (let k = 0; k < ringV; k++) {
      const t = this.th0 + (this.span * k) / K;
      cosT[k] = Math.cos(t);
      sinT[k] = Math.sin(t);
    }
    const set3 = (arr, i, x, y, z) => {
      arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
    };
    const tmp = new THREE.Color();
    for (let j = 0; j < M; j++) {
      const jm = Math.max(0, j - 1), jp = Math.min(M - 1, j + 1);
      const dz = zs[jp] - zs[jm] || 1;
      const so = (ro[jp] - ro[jm]) / dz;
      const si = (ri[jp] - ri[jm]) / dz;
      const lo = Math.hypot(so, 1), li = Math.hypot(si, 1);
      const raw = ro[j] >= od2 - 0.004;
      tmp.copy(raw ? COLORS.raw : COLORS.machined);
      for (let k = 0; k < ringV; k++) {
        const v = o.outer + j * ringV + k;
        set3(P, v, zs[j], ro[j] * cosT[k], ro[j] * sinT[k]);
        set3(N, v, -so / lo, cosT[k] / lo, sinT[k] / lo);
        set3(C, v, tmp.r, tmp.g, tmp.b);
        U[v * 2] = (this.th0 + (this.span * k) / K) / (Math.PI * 2);
        U[v * 2 + 1] = 0.5;
        const vi = o.inner + j * ringV + k;
        set3(P, vi, zs[j], ri[j] * cosT[k], ri[j] * sinT[k]);
        set3(N, vi, si / li, -cosT[k] / li, -sinT[k] / li);
        set3(C, vi, COLORS.inner.r, COLORS.inner.g, COLORS.inner.b);
        U[vi * 2] = U[v * 2];
        U[vi * 2 + 1] = 0.5;
      }
    }
    const full = this.section === 'full';
    for (const [base, t, sgn] of [[o.cutA, this.th0, -1], [o.cutB, this.th0 + this.span, 1]]) {
      const c = Math.cos(t), s = Math.sin(t);
      for (let j = 0; j < M; j++) {
        for (let q = 0; q < 2; q++) {
          const v = base + j * 2 + q;
          const r = full ? 0 : q === 0 ? ri[j] : ro[j];
          set3(P, v, full ? zs[0] : zs[j], r * c, r * s);
          set3(N, v, 0, -sgn * s, sgn * c);
          set3(C, v, COLORS.section.r, COLORS.section.g, COLORS.section.b);
          U[v * 2] = 0; U[v * 2 + 1] = 0.5;
        }
      }
    }
    for (const [base, j, nx] of [[o.back, 0, -1], [o.front, M - 1, 1]]) {
      for (let k = 0; k < ringV; k++) {
        for (let q = 0; q < 2; q++) {
          const v = base + q * ringV + k;
          const r = q === 0 ? ri[j] : ro[j];
          set3(P, v, zs[j], r * cosT[k], r * sinT[k]);
          set3(N, v, nx, 0, 0);
          const col = j === 0 ? COLORS.raw : ro[j] >= od2 - 0.004 && ri[j] < 0.005 ? COLORS.raw : COLORS.machined;
          set3(C, v, col.r, col.g, col.b);
          U[v * 2] = (this.th0 + (this.span * k) / K) / (Math.PI * 2);
          U[v * 2 + 1] = 0.5;
        }
      }
    }
    void hasInner;
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    disposeObject(this.group);
    this.tex.dispose();
  }
}
