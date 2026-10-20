// Small 2D/3D geometry helpers shared by the interpreter.

export const D2R = Math.PI / 180;
export const EPS = 1e-7;

// Axis index triple [u, v, w] for each plane. Axis index: 0=X 1=Y 2=Z.
// G17: XY (w=Z), G18: ZX (u=Z, v=X, w=Y), G19: YZ (w=X)
export function planeAxes(plane) {
  if (plane === 18) return [2, 0, 1];
  if (plane === 19) return [1, 2, 0];
  return [0, 1, 2];
}

export function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Arc centre from radius word. cw=true for G2. Returns [cu,cv] or null if the
// chord is longer than the diameter (a tolerance is allowed).
export function centerFromRadius(u0, v0, u1, v1, R, cw) {
  const dx = u1 - u0;
  const dy = v1 - v0;
  const d = Math.hypot(dx, dy);
  if (d < EPS) return null;
  const r = Math.abs(R);
  let h2 = r * r - (d / 2) * (d / 2);
  if (h2 < -1e-4 * Math.max(1, r * r)) return null;
  if (h2 < 0) h2 = 0;
  const h = Math.sqrt(h2);
  const mx = (u0 + u1) / 2;
  const my = (v0 + v1) / 2;
  // Left normal of chord direction
  const nx = -dy / d;
  const ny = dx / d;
  const left = !cw !== R < 0; // ccw & R>0 -> left ; sign flips for negative R
  const s = left ? 1 : -1;
  return [mx + nx * h * s, my + ny * h * s];
}

// Sweep angle of an arc (signed, ccw positive). Full circle when start==end.
export function arcSweep(u0, v0, u1, v1, cu, cv, cw) {
  const a0 = Math.atan2(v0 - cv, u0 - cu);
  const a1 = Math.atan2(v1 - cv, u1 - cu);
  let sweep;
  if (cw) {
    sweep = -(((a0 - a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (Math.abs(sweep) < 1e-9) sweep = -2 * Math.PI;
  } else {
    sweep = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI;
  }
  return { a0, sweep };
}

// Linearise an arc prim into points (excluding the start, including the exact end).
// prim: { a:[x,y,z], b:[x,y,z], c:[cu,cv], cw, plane }
export function linearizeArc(prim, tol = 0.004, maxStepDeg = 3) {
  const [iu, iv, iw] = planeAxes(prim.plane);
  const u0 = prim.a[iu], v0 = prim.a[iv], w0 = prim.a[iw];
  const u1 = prim.b[iu], v1 = prim.b[iv], w1 = prim.b[iw];
  const [cu, cv] = prim.c;
  const R0 = Math.hypot(u0 - cu, v0 - cv);
  const R1 = Math.hypot(u1 - cu, v1 - cv);
  const { a0, sweep } = arcSweep(u0, v0, u1, v1, cu, cv, prim.cw);
  const Rm = Math.max(R0, R1, 1e-6);
  const step = Math.min(maxStepDeg * D2R, 2 * Math.acos(Math.max(0, 1 - tol / Rm)) || maxStepDeg * D2R);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    if (i === n) {
      pts.push(prim.b.slice());
      break;
    }
    const t = i / n;
    const ang = a0 + sweep * t;
    const r = R0 + (R1 - R0) * t;
    const p = [0, 0, 0];
    p[iu] = cu + r * Math.cos(ang);
    p[iv] = cv + r * Math.sin(ang);
    p[iw] = w0 + (w1 - w0) * t;
    pts.push(p);
  }
  return pts;
}

// Line/line intersection in the plane (u,v). Returns [u,v] or null if parallel.
export function lineLine(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

// Line (p + d*t, |d|=1 assumed not required) / circle (c, r) intersections.
export function lineCircle(p, d, c, r) {
  const fx = p[0] - c[0];
  const fy = p[1] - c[1];
  const A = d[0] * d[0] + d[1] * d[1];
  const B = 2 * (fx * d[0] + fy * d[1]);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((t) => [p[0] + d[0] * t, p[1] + d[1] * t]);
}

export function circleCircle(c1, r1, c2, r2) {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + (dx * a) / d;
  const my = c1[1] + (dy * a) / d;
  return [
    [mx + (h * dy) / d, my - (h * dx) / d],
    [mx - (h * dy) / d, my + (h * dx) / d],
  ];
}
