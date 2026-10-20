// Tool definitions and cutting geometry.
// The tool table drives both the interpreter (compensation radius, tip
// direction) and the material-removal models.

export const MILL_TYPES = {
  flat: 'Pinnfräs (slät)',
  bull: 'Hörnradiefräs',
  ball: 'Kulfräs',
  face: 'Planfräs',
  drill: 'Spiralborr',
  spot: 'Centrumborr',
  chamfer: 'Fasfräs',
  tap: 'Gängtapp',
  ream: 'Brotsch',
  bore: 'Finborrstång',
};

export const LATHE_TYPES = {
  turn: 'Utvändig skär (OD)',
  bore: 'Invändig skär / borrstång (ID)',
  groove: 'Instickskär / avstickare',
  thread: 'Gängskär utvändig',
  thread_id: 'Gängskär invändig',
  drill: 'Spiralborr',
  center: 'Centrumborr',
  tap: 'Gängtapp',
  ream: 'Brotsch',
};

export function typesFor(machine) {
  return machine === 'lathe' ? LATHE_TYPES : MILL_TYPES;
}

export function makeTool(machine, n, type = null) {
  if (machine === 'lathe') {
    const t = type || 'turn';
    const base = {
      n,
      type: t,
      name: LATHE_TYPES[t],
      dia: 0,
      len: 60,
      nose: 0.4,
      tip: t === 'bore' || t === 'thread_id' ? 2 : 3,
      insert: 80,
      width: 3,
      ref: 'left',
      pitch: 1.5,
      tipAngle: 118,
    };
    if (t === 'drill') Object.assign(base, { dia: 10, len: 90, name: 'Spiralborr Ø10', tip: 9, nose: 0 });
    if (t === 'center') Object.assign(base, { dia: 5, len: 40, name: 'Centrumborr Ø5', tipAngle: 60, tip: 9, nose: 0 });
    if (t === 'tap' || t === 'ream') Object.assign(base, { dia: 10, len: 70, tip: 9, nose: 0 });
    if (t === 'groove') Object.assign(base, { nose: 0.2, tip: 3, width: 3, insert: 90 });
    if (t === 'thread' || t === 'thread_id') Object.assign(base, { nose: 0.05, insert: 60 });
    if (t === 'turn') base.name = 'Skär CNMG 80° R0.4';
    if (t === 'bore') Object.assign(base, { name: 'Borrstång 80° R0.4', dia: 12 });
    return base;
  }
  const t = type || 'flat';
  const base = {
    n,
    type: t,
    name: MILL_TYPES[t],
    dia: 10,
    len: 40,
    cr: 0,
    flutes: 4,
    tipAngle: 118,
    tipDia: 0,
    stick: 70,
  };
  if (t === 'bull') Object.assign(base, { cr: 1 });
  if (t === 'ball') Object.assign(base, { cr: 5 });
  if (t === 'face') Object.assign(base, { dia: 50, len: 20, flutes: 6, stick: 60 });
  if (t === 'drill') Object.assign(base, { flutes: 2 });
  if (t === 'spot') Object.assign(base, { tipAngle: 90, flutes: 2 });
  if (t === 'chamfer') Object.assign(base, { tipAngle: 90, tipDia: 1, flutes: 3 });
  if (t === 'tap') Object.assign(base, { dia: 8, flutes: 3 });
  base.name = `${MILL_TYPES[t]} Ø${base.dia}`;
  return base;
}

export function defaultTools(machine) {
  const tools = {};
  const add = (t) => (tools[t.n] = t);
  if (machine === 'lathe') {
    add({ ...makeTool('lathe', 1, 'turn'), name: 'Skrubb CNMG 80° R0.8', nose: 0.8, tip: 3 });
    add({ ...makeTool('lathe', 2, 'turn'), name: 'Slut DNMG 55° R0.4', nose: 0.4, insert: 55, tip: 3 });
    add({ ...makeTool('lathe', 3, 'groove'), name: 'Instick 3 mm', width: 3 });
    add({ ...makeTool('lathe', 4, 'thread'), name: 'Gängskär 60° (P1.5)', pitch: 1.5 });
    add({ ...makeTool('lathe', 5, 'drill'), name: 'Spiralborr Ø12', dia: 12 });
    add({ ...makeTool('lathe', 6, 'bore'), name: 'Borrstång Ø16 R0.4', dia: 16 });
  } else {
    add({ ...makeTool('mill', 1, 'face'), name: 'Planfräs Ø50', dia: 50 });
    add({ ...makeTool('mill', 2, 'flat'), name: 'Pinnfräs Ø10 Z4', dia: 10 });
    add({ ...makeTool('mill', 3, 'spot'), name: 'Centrumborr Ø8 90°', dia: 8 });
    add({ ...makeTool('mill', 4, 'drill'), name: 'Spiralborr Ø8.5', dia: 8.5, len: 60 });
    add({ ...makeTool('mill', 5, 'ball'), name: 'Kulfräs Ø8', dia: 8, cr: 4 });
    add({ ...makeTool('mill', 6, 'chamfer'), name: 'Fasfräs Ø12 90°', dia: 12 });
    add({ ...makeTool('mill', 7, 'bull'), name: 'Hörnradiefräs Ø16 R2', dia: 16, cr: 2 });
  }
  return tools;
}

// Compensation radius used by G41/G42.
export function compRadius(tool, machine) {
  if (!tool) return 0;
  if (machine === 'lathe') return tool.nose || 0;
  return (tool.dia || 0) / 2;
}

// ---------------------------------------------------------------------------
// Mill tool bottom profile: height above the tool tip as a function of radial
// distance rho from the tool axis. Sampled into a lookup table.
// ---------------------------------------------------------------------------
export const PROFILE_STEP = 0.01;

export function millProfile(tool) {
  const R = Math.max(0.05, tool.dia / 2);
  const n = Math.ceil(R / PROFILE_STEP) + 2;
  const lut = new Float32Array(n);
  const half = ((tool.tipAngle || 118) / 2) * (Math.PI / 180);
  for (let i = 0; i < n; i++) {
    const rho = Math.min(R, i * PROFILE_STEP);
    let z = 0;
    switch (tool.type) {
      case 'ball': {
        const cr = Math.min(tool.cr || R, R);
        const flatEnd = R - cr;
        z = rho <= flatEnd ? 0 : cr - Math.sqrt(Math.max(0, cr * cr - (rho - flatEnd) ** 2));
        break;
      }
      case 'bull': {
        const cr = Math.min(tool.cr || 0, R);
        const flatEnd = R - cr;
        z = rho <= flatEnd || cr <= 0 ? 0 : cr - Math.sqrt(Math.max(0, cr * cr - (rho - flatEnd) ** 2));
        break;
      }
      case 'drill':
      case 'spot':
        z = rho / Math.tan(half);
        break;
      case 'chamfer': {
        const tr = (tool.tipDia || 0) / 2;
        z = rho <= tr ? 0 : (rho - tr) / Math.tan(half);
        break;
      }
      default:
        z = 0;
    }
    lut[i] = z;
  }
  return { R, lut, step: PROFILE_STEP };
}

// ---------------------------------------------------------------------------
// Lathe tool silhouettes.
// Local frame: (z, x) relative to the reference point, +z away from chuck,
// +x away from the spindle axis.
// kind 'od': tool sits above the material and removes r > bottom(z)
// kind 'id': tool sits inside and removes r < top(z)
// ---------------------------------------------------------------------------
const D2R = Math.PI / 180;

function sampleBoundary(poly, step = 0.02) {
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(l / step));
    for (let j = 0; j < k; j++) pts.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return pts;
}

function arcPoints(cx, cz, r, a0, a1, n = 24) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
}

// Polygon of an insert-type tool for tip numbers 1..4/9 (nose centre at origin).
export function insertPolygon(tool) {
  const r = Math.max(0.02, tool.nose || 0.4);
  const alpha = (tool.insert || 80) * D2R;
  const e1 = 5 * D2R;
  const L = tool.insert && tool.insert <= 40 ? 11 : 9;
  const n1 = [Math.sin(e1), -Math.cos(e1)];
  const d1 = [Math.cos(e1), Math.sin(e1)];
  const d2 = [Math.cos(e1 + alpha), Math.sin(e1 + alpha)];
  const n2 = [-Math.sin(e1 + alpha), Math.cos(e1 + alpha)];
  const a2 = Math.atan2(n2[1], n2[0]);
  let a1 = Math.atan2(n1[1], n1[0]);
  if (a1 < a2) a1 += 2 * Math.PI;
  const T1 = [r * n1[0], r * n1[1]];
  const T2 = [r * n2[0], r * n2[1]];
  const poly = [
    [T1[0] + d1[0] * L, T1[1] + d1[1] * L],
    [T2[0] + d2[0] * L, T2[1] + d2[1] * L],
    ...arcPoints(0, 0, r, a2, a1),
  ];
  // Orientation is (z, x). Mirror per tip number.
  const tip = tool.tip || 3;
  const mz = tip === 4 || tip === 1;
  const mx = tip === 1 || tip === 2;
  return poly.map(([z, x]) => [mz ? -z : z, mx ? -x : x]);
}

export function toolPolygonLocal(tool) {
  switch (tool.type) {
    case 'groove': {
      const w = tool.width || 3;
      const z0 = tool.ref === 'center' ? -w / 2 : tool.ref === 'right' ? -w : 0;
      const h = 12;
      const od = tool.tip !== 2 && tool.tip !== 1;
      const s = od ? 1 : -1;
      return [
        [z0, 0],
        [z0 + w, 0],
        [z0 + w, s * h],
        [z0, s * h],
      ];
    }
    case 'thread':
    case 'thread_id': {
      const s = tool.type === 'thread' ? 1 : -1;
      const half = 30 * D2R;
      const h = 6;
      const tr = Math.max(0.03, tool.nose || 0.05);
      return [
        [-tr, 0],
        [tr, 0],
        [tr + h * Math.tan(half), s * h],
        [-tr - h * Math.tan(half), s * h],
      ];
    }
    case 'turn':
    case 'bore':
      return insertPolygon(tool);
    default:
      return null;
  }
}

// Returns { kind, zmin, zmax, at(dz) } where at() gives the boundary x
// (bottom for 'od', top for 'id') at the relative axial offset, or NaN.
export function latheSilhouette(tool) {
  const t = tool.type;
  if (t === 'drill' || t === 'center' || t === 'tap' || t === 'ream') {
    const R = Math.max(0.1, (tool.dia || 10) / 2);
    const half = ((t === 'center' ? tool.tipAngle || 60 : tool.tipAngle || 118) / 2) * D2R;
    const len = tool.len || 60;
    const dTip = R / Math.tan(half);
    return {
      kind: 'id',
      zmin: 0,
      zmax: len,
      tipOnAxis: true,
      at: (dz) => (dz < 0 || dz > len ? NaN : dz < dTip ? dz * Math.tan(half) : R),
      R,
    };
  }
  const poly = toolPolygonLocal(tool) || insertPolygon(tool);
  const pts = sampleBoundary(poly, 0.02);
  let zmin = Infinity, zmax = -Infinity;
  for (const p of pts) {
    zmin = Math.min(zmin, p[0]);
    zmax = Math.max(zmax, p[0]);
  }
  const kind = ['bore', 'thread_id'].includes(t) || (t === 'groove' && (tool.tip === 2 || tool.tip === 1)) ? 'id' : 'od';
  const step = 0.02;
  const nb = Math.ceil((zmax - zmin) / step) + 1;
  const bound = new Float32Array(nb).fill(kind === 'od' ? Infinity : -Infinity);
  for (const [z, x] of pts) {
    const i = Math.min(nb - 1, Math.max(0, Math.round((z - zmin) / step)));
    bound[i] = kind === 'od' ? Math.min(bound[i], x) : Math.max(bound[i], x);
  }
  // fill gaps by interpolating neighbours
  for (let i = 0; i < nb; i++) {
    if (!Number.isFinite(bound[i])) {
      let l = i - 1, r = i + 1;
      while (l >= 0 && !Number.isFinite(bound[l])) l--;
      while (r < nb && !Number.isFinite(bound[r])) r++;
      if (l >= 0 && r < nb) bound[i] = bound[l] + ((bound[r] - bound[l]) * (i - l)) / (r - l);
    }
  }
  return {
    kind,
    zmin,
    zmax,
    poly,
    at: (dz) => {
      const f = (dz - zmin) / step;
      if (f < 0 || f > nb - 1) return NaN;
      const i = Math.floor(f);
      const j = Math.min(nb - 1, i + 1);
      const a = bound[i], b = bound[j];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
      return a + (b - a) * (f - i);
    },
  };
}

// Vector from the programmed virtual tip to the nose centre, for tip numbers.
export function tipToCenter(tool) {
  // Only insert-type turning/boring tools are referenced at the virtual tip.
  // Grooving, threading and rotating tools are programmed at their own reference point.
  if (tool.type !== 'turn' && tool.type !== 'bore') return [0, 0];
  const r = tool.nose || 0;
  switch (tool.tip) {
    case 1: return [-r, -r]; // (z, x)
    case 2: return [r, -r];
    case 3: return [r, r];
    case 4: return [-r, r];
    default: return [0, 0];
  }
}
