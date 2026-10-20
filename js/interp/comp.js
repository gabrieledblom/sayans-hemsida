// Path post-processing stages: corner chamfer/round and cutter / nose-radius compensation.
// Prims are { type:'line'|'arc', a:[x,y,z], b:[x,y,z], c?:[cu,cv], cw?, plane, rapid, f, ln }.

import { planeAxes, arcSweep, lineLine, lineCircle, circleCircle, EPS } from './geom.js';

const uvLen = (p, q, ax) => Math.hypot(p[ax[0]] - q[ax[0]], p[ax[1]] - q[ax[1]]);

function tangent(prim, atEnd) {
  const ax = planeAxes(prim.plane);
  const [iu, iv] = ax;
  if (prim.type === 'line') {
    const dx = prim.b[iu] - prim.a[iu];
    const dy = prim.b[iv] - prim.a[iv];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }
  const p = atEnd ? prim.b : prim.a;
  const dx = p[iu] - prim.c[0];
  const dy = p[iv] - prim.c[1];
  const l = Math.hypot(dx, dy) || 1;
  return prim.cw ? [dy / l, -dx / l] : [-dy / l, dx / l];
}

// ---------------------------------------------------------------------------
// Corner chamfer / rounding between consecutive feed lines
// ---------------------------------------------------------------------------
export class CornerStage {
  constructor(out, warn) {
    this.out = out;
    this.warn = warn;
    this.held = null;
  }
  eligible(p) {
    return p.type === 'line' && !p.rapid && p.plane !== 19;
  }
  push(prim) {
    if (!this.eligible(prim)) {
      this.flush();
      this.out(prim);
      return;
    }
    if (this.held) {
      const h = this.held;
      const ax = planeAxes(prim.plane);
      const continuous = uvLen(h.b, prim.a, ax) < 1e-4 && Math.abs(h.b[ax[2]] - prim.a[ax[2]]) < 1e-4;
      if (h.corner && continuous && this.apply(h, prim, ax)) return;
      this.flush();
    }
    if (prim.corner) this.held = prim;
    else this.out(prim);
  }
  apply(h, next, ax) {
    const [iu, iv] = ax;
    const l1 = uvLen(h.a, h.b, ax);
    const l2 = uvLen(next.a, next.b, ax);
    if (l1 < EPS || l2 < EPS) return false;
    const d1 = [(h.b[iu] - h.a[iu]) / l1, (h.b[iv] - h.a[iv]) / l1];
    const d2 = [(next.b[iu] - next.a[iu]) / l2, (next.b[iv] - next.a[iv]) / l2];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const dot = d1[0] * d2[0] + d1[1] * d2[1];
    if (Math.abs(cross) < 1e-6) return false;
    const theta = Math.acos(Math.max(-1, Math.min(1, -dot))); // interior angle
    const size = h.corner.size;
    const t = h.corner.type === 'C' ? size : size / Math.tan(theta / 2);
    if (t > l1 * 0.999 || t > l2 * 0.999) {
      this.warn(`${h.corner.type === 'C' ? 'Fasen' : 'Rundningen'} ${size} är för stor för intilliggande kontur`, h.ln);
      return false;
    }
    const P = h.b;
    const mk = (u, v, src) => {
      const q = src.slice();
      q[iu] = u;
      q[iv] = v;
      return q;
    };
    const P1 = mk(P[iu] - d1[0] * t, P[iv] - d1[1] * t, P);
    const P2 = mk(P[iu] + d2[0] * t, P[iv] + d2[1] * t, P);
    this.held = null;
    this.out({ ...h, b: P1, corner: null });
    if (h.corner.type === 'C') {
      this.out({ ...h, type: 'line', a: P1, b: P2, corner: null });
    } else {
      const n = cross > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
      const c = [P1[iu] + n[0] * size, P1[iv] + n[1] * size];
      this.out({ ...h, type: 'arc', a: P1, b: P2, c, cw: cross < 0, corner: null });
    }
    const rest = { ...next, a: P2 };
    if (rest.corner) this.held = rest;
    else this.out(rest);
    return true;
  }
  flush() {
    if (this.held) {
      const h = this.held;
      this.held = null;
      this.out(h);
    }
  }
}

// ---------------------------------------------------------------------------
// Cutter / nose radius compensation (G41 left, G42 right)
// ---------------------------------------------------------------------------
export class CompStage {
  constructor(out, warn, getToolPos) {
    this.out = out;
    this.warn = warn;
    this.getToolPos = getToolPos;
    this.state = 'off'; // off | wait1 | wait2 | on | gap | canceling
    this.side = 1;
    this.r = 0;
    this.plane = 17;
    this.start0 = null;
    this.prev = null;
    this.pushedThisBlock = false;
  }
  get active() {
    return this.state !== 'off';
  }
  activate(side, r, plane) {
    if (this.state !== 'off' && this.state !== 'canceling') {
      this.side = side;
      this.r = r;
      return;
    }
    if (this.state === 'canceling') this.finishCancel();
    this.side = side;
    this.r = r;
    this.plane = plane;
    this.state = 'wait1';
  }
  deactivate() {
    if (this.state === 'off') return;
    if (this.state === 'wait1') {
      this.state = 'off';
      return;
    }
    if (this.state === 'wait2') {
      const p = this.start0;
      this.start0 = null;
      this.state = 'off';
      this.out({ ...p, raw: true });
      return;
    }
    this.state = 'canceling';
  }
  beginBlock() {
    this.pushedThisBlock = false;
  }
  endBlock() {
    if (this.state === 'canceling' && !this.pushedThisBlock) this.finishCancel();
  }
  finishCancel() {
    this.emitPrev();
    this.state = 'off';
  }
  isPlanar(prim) {
    const ax = planeAxes(prim.plane);
    return prim.type === 'arc' || uvLen(prim.a, prim.b, ax) > 1e-6;
  }

  offset(prim) {
    const ax = planeAxes(prim.plane);
    const [iu, iv] = ax;
    const r = this.r;
    const s = this.side;
    const o = { ...prim, a: prim.a.slice(), b: prim.b.slice(), src: prim };
    if (prim.type === 'line') {
      const l = uvLen(prim.a, prim.b, ax);
      const nx = (-(prim.b[iv] - prim.a[iv]) / l) * s * r;
      const ny = ((prim.b[iu] - prim.a[iu]) / l) * s * r;
      o.a[iu] += nx; o.a[iv] += ny;
      o.b[iu] += nx; o.b[iv] += ny;
      return o;
    }
    const R0 = Math.hypot(prim.a[iu] - prim.c[0], prim.a[iv] - prim.c[1]);
    const leftOut = prim.cw ? 1 : -1;
    let Rn = R0 + s * leftOut * r;
    if (Rn < 1e-3) {
      this.warn(`Kompensationsradien ${r} är för stor för bågen (R${R0.toFixed(3)})`, prim.ln);
      Rn = 1e-3;
    }
    const k = Rn / R0;
    for (const key of ['a', 'b']) {
      const p = o[key];
      p[iu] = prim.c[0] + (prim[key][iu] - prim.c[0]) * k;
      p[iv] = prim.c[1] + (prim[key][iv] - prim.c[1]) * k;
    }
    o.R = Rn;
    return o;
  }

  // Parametric position of point q along a prim's own path, or -1 if outside.
  onPrim(o, q) {
    const ax = planeAxes(o.plane);
    const [iu, iv] = ax;
    if (o.type === 'line') {
      const dx = o.b[iu] - o.a[iu];
      const dy = o.b[iv] - o.a[iv];
      const l2 = dx * dx + dy * dy;
      const t = ((q[0] - o.a[iu]) * dx + (q[1] - o.a[iv]) * dy) / l2;
      return t >= -1e-6 && t <= 1 + 1e-6 ? t : -1;
    }
    const { a0, sweep } = arcSweep(o.a[iu], o.a[iv], o.b[iu], o.b[iv], o.c[0], o.c[1], o.cw);
    const ang = Math.atan2(q[1] - o.c[1], q[0] - o.c[0]);
    let d = o.cw ? a0 - ang : ang - a0;
    d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const total = Math.abs(sweep);
    if (d <= total + 1e-6) return d / total;
    if (d >= 2 * Math.PI - 1e-6) return 0;
    return -1;
  }

  intersect(o1, o2, near) {
    const [iu, iv] = planeAxes(o1.plane);
    const cands = [];
    const seg = (o) => ({
      p: [o.a[iu], o.a[iv]],
      d: [o.b[iu] - o.a[iu], o.b[iv] - o.a[iv]],
    });
    if (o1.type === 'line' && o2.type === 'line') {
      const s1 = seg(o1), s2 = seg(o2);
      const p = lineLine(s1.p, s1.d, s2.p, s2.d);
      if (p) cands.push(p);
    } else if (o1.type === 'line') {
      const s1 = seg(o1);
      cands.push(...lineCircle(s1.p, s1.d, o2.c, o2.R ?? Math.hypot(o2.a[iu] - o2.c[0], o2.a[iv] - o2.c[1])));
    } else if (o2.type === 'line') {
      const s2 = seg(o2);
      cands.push(...lineCircle(s2.p, s2.d, o1.c, o1.R ?? Math.hypot(o1.a[iu] - o1.c[0], o1.a[iv] - o1.c[1])));
    } else {
      cands.push(
        ...circleCircle(
          o1.c, o1.R ?? Math.hypot(o1.a[iu] - o1.c[0], o1.a[iv] - o1.c[1]),
          o2.c, o2.R ?? Math.hypot(o2.a[iu] - o2.c[0], o2.a[iv] - o2.c[1]),
        ),
      );
    }
    let best = null;
    let bd = Infinity;
    for (const q of cands) {
      if (this.onPrim(o1, q) < 0 || this.onPrim(o2, q) < 0) continue;
      const d = Math.hypot(q[0] - near[iu], q[1] - near[iv]);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  setEnd(o, which, q) {
    const [iu, iv, iw] = planeAxes(o.plane);
    const p = o[which];
    if (o.type === 'line') {
      const dx = o.b[iu] - o.a[iu], dy = o.b[iv] - o.a[iv];
      const l2 = dx * dx + dy * dy || 1;
      const t = ((q[0] - o.a[iu]) * dx + (q[1] - o.a[iv]) * dy) / l2;
      const w0 = o.a[iw], w1 = o.b[iw];
      p[iw] = w0 + (w1 - w0) * Math.max(0, Math.min(1, t));
    }
    p[iu] = q[0];
    p[iv] = q[1];
  }

  join(o1, o2) {
    const [iu, iv] = planeAxes(o1.plane);
    const t1 = tangent(o1.src, true);
    const t2 = tangent(o2.src, false);
    const cross = t1[0] * t2[1] - t1[1] * t2[0];
    const dot = t1[0] * t2[0] + t1[1] * t2[1];
    if (Math.abs(cross) < 1e-6 && dot > 0) return null;
    const inside = this.side > 0 ? cross > 0 : cross < 0;
    const corner = o1.src.b;
    if (inside && dot > -0.9999) {
      const q = this.intersect(o1, o2, o1.b);
      if (q) {
        this.setEnd(o1, 'b', q);
        this.setEnd(o2, 'a', q);
      }
      return null;
    }
    // Outside corner (or reversal): go around the corner point at radius r.
    const wmid = o1.b.slice();
    return {
      type: 'arc',
      plane: o1.plane,
      a: wmid,
      b: o2.a.slice(),
      c: [corner[iu], corner[iv]],
      cw: this.side > 0,
      rapid: o2.rapid,
      f: o2.f,
      ln: o2.ln,
    };
  }

  emitO(o) {
    const { src, ...rest } = o;
    this.out(rest);
  }
  emitPrev() {
    if (this.prev) {
      const p = this.prev;
      this.prev = null;
      this.emitO(p);
    }
  }

  push(prim) {
    this.pushedThisBlock = true;
    const ax = planeAxes(prim.plane);
    const planar = this.isPlanar(prim);
    switch (this.state) {
      case 'off':
        this.out({ ...prim, raw: true });
        return;
      case 'wait1':
        if (!planar) return this.out({ ...prim, raw: true });
        this.start0 = prim;
        this.state = 'wait2';
        return;
      case 'wait2': {
        if (!planar) return this.out({ ...prim, raw: true });
        const m0 = this.start0;
        const o2 = this.offset(prim);
        const b = m0.b.slice();
        b[ax[0]] = o2.a[ax[0]];
        b[ax[1]] = o2.a[ax[1]];
        const tp = this.getToolPos();
        this.out({ ...m0, type: 'line', a: tp, b, c: undefined });
        this.start0 = null;
        this.prev = o2;
        this.state = 'on';
        return;
      }
      case 'on': {
        if (!planar) {
          this.emitPrev();
          this.state = 'gap';
          const tp = this.getToolPos();
          const b = tp.slice();
          b[ax[2]] = prim.b[ax[2]];
          this.out({ ...prim, a: tp, b });
          return;
        }
        const o2 = this.offset(prim);
        const conn = this.join(this.prev, o2);
        this.emitPrev();
        if (conn) this.out(conn);
        this.prev = o2;
        return;
      }
      case 'gap': {
        if (!planar) {
          const tp = this.getToolPos();
          const b = tp.slice();
          b[ax[2]] = prim.b[ax[2]];
          this.out({ ...prim, a: tp, b });
          return;
        }
        this.prev = this.offset(prim);
        this.state = 'on';
        return;
      }
      case 'canceling': {
        this.emitPrev();
        this.state = 'off';
        if (prim.type === 'arc') this.out({ ...prim, type: 'line', c: undefined, raw: true });
        else this.out({ ...prim, raw: true });
        return;
      }
    }
  }

  // Emit anything still held (end of program or mode change)
  flush() {
    if (this.state === 'wait2' && this.start0) {
      const p = this.start0;
      this.start0 = null;
      this.out({ ...p, raw: true });
    }
    this.emitPrev();
    this.state = 'off';
  }
}
