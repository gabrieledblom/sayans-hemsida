// 3D tool models, the tool actor that follows the simulated position, and coolant.

import * as THREE from 'three';
import { disposeObject } from './scene.js';
import { toolPolygonLocal, latheSilhouette } from '../sim/tools.js';

const D2R = Math.PI / 180;
const STEEL = 0xaeb8c4;
const GOLD = 0xd9a93b;
const HOLDER = 0x2e3846;

export function toThree(machine, p, out = new THREE.Vector3()) {
  if (machine === 'lathe') return out.set(p[2], p[0], 0);
  return out.set(p[0], p[2], -p[1]);
}

function fluteTexture(flutes) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c4ccd6';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#7b8694';
  const n = Math.max(2, flutes);
  for (let i = 0; i < n; i++) {
    const x = (i * 128) / n;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 10, 0);
    g.lineTo(x + 10 + 40, 128);
    g.lineTo(x + 40, 128);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function millProfilePoints(tool) {
  const R = Math.max(0.2, tool.dia / 2);
  const len = Math.max(tool.len || 20, 2);
  const pts = [];
  const add = (r, y) => pts.push(new THREE.Vector2(r, y));
  const half = ((tool.tipAngle || 118) / 2) * D2R;
  switch (tool.type) {
    case 'ball': {
      const cr = Math.min(tool.cr || R, R);
      add(0, 0);
      for (let i = 1; i <= 16; i++) {
        const a = (i / 16) * (Math.PI / 2);
        add((R - cr) + cr * Math.sin(a), cr - cr * Math.cos(a));
      }
      add(R, len);
      break;
    }
    case 'bull': {
      const cr = Math.min(tool.cr || 0, R);
      add(0, 0);
      add(R - cr, 0);
      for (let i = 1; i <= 10; i++) {
        const a = (i / 10) * (Math.PI / 2);
        add(R - cr + cr * Math.sin(a), cr - cr * Math.cos(a));
      }
      add(R, len);
      break;
    }
    case 'drill':
    case 'spot':
      add(0, 0);
      add(R, R / Math.tan(half));
      add(R, len);
      break;
    case 'chamfer': {
      const tr = (tool.tipDia || 0) / 2;
      add(0, 0);
      add(tr, 0);
      add(R, (R - tr) / Math.tan(half));
      add(R, len);
      break;
    }
    default:
      add(0, 0);
      add(R, 0);
      add(R, len);
  }
  return pts;
}

function buildMill(tool) {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  const R = Math.max(0.2, tool.dia / 2);
  const len = Math.max(tool.len || 20, 2);
  const stick = Math.max(tool.stick || len + 20, len + 4);
  const tex = fluteTexture(tool.flutes || 4);
  tex.repeat.set(1, Math.max(1, len / (R * 4)));
  const cutMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, metalness: 0.9, roughness: 0.3 });
  const cut = new THREE.Mesh(new THREE.LatheGeometry(millProfilePoints(tool), 40), cutMat);
  spin.add(cut);
  if (tool.type !== 'drill' && tool.type !== 'spot') {
    const tin = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 0.85, roughness: 0.35, transparent: true, opacity: 0.35 });
    const coat = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.002, R * 1.002, len, 40, 1, true), tin);
    coat.position.y = len / 2;
    spin.add(coat);
  }
  const shankMat = new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.9, roughness: 0.28 });
  const shankR = tool.type === 'face' ? R * 0.35 : Math.min(R, 12);
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(shankR, shankR, stick - len, 32), shankMat);
  shank.position.y = len + (stick - len) / 2;
  spin.add(shank);
  const holderMat = new THREE.MeshStandardMaterial({ color: HOLDER, metalness: 0.7, roughness: 0.45 });
  const hr = Math.max(R + 7, 16);
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(hr + 8, hr, 36, 40), holderMat);
  cone.position.y = stick + 18;
  spin.add(cone);
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(hr + 14, hr + 14, 12, 40), holderMat);
  flange.position.y = stick + 42;
  spin.add(flange);
  const nose = new THREE.Mesh(
    new THREE.CylinderGeometry(hr + 18, hr + 24, 70, 40),
    new THREE.MeshStandardMaterial({ color: 0x4a5565, metalness: 0.6, roughness: 0.5 }),
  );
  nose.position.y = stick + 90;
  group.add(nose);
  const column = new THREE.Mesh(
    new THREE.BoxGeometry(hr * 3.4, 600, hr * 3.4),
    new THREE.MeshStandardMaterial({ color: 0x232b36, metalness: 0.4, roughness: 0.8 }),
  );
  column.position.y = stick + 125 + 300;
  group.add(column);
  return { group, spin, nozzle: new THREE.Vector3(R + 18, 28, R + 10), tipY: 0 };
}

function polyShape(poly) {
  const s = new THREE.Shape();
  poly.forEach(([z, x], i) => (i ? s.lineTo(z, x) : s.moveTo(z, x)));
  s.closePath();
  return s;
}

function buildLathe(tool) {
  const group = new THREE.Group();
  const holderMat = new THREE.MeshStandardMaterial({ color: HOLDER, metalness: 0.7, roughness: 0.45 });
  const insMat = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 0.85, roughness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.9, roughness: 0.3 });
  const t = tool.type;
  if (['drill', 'center', 'tap', 'ream'].includes(t)) {
    const sil = latheSilhouette(tool);
    const R = sil.R;
    const len = tool.len || 60;
    const half = ((t === 'center' ? tool.tipAngle || 60 : tool.tipAngle || 118) / 2) * D2R;
    const pts = [new THREE.Vector2(0, 0), new THREE.Vector2(R, R / Math.tan(half)), new THREE.Vector2(R, len)];
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), new THREE.MeshStandardMaterial({ color: GOLD, metalness: 0.9, roughness: 0.3 }));
    mesh.rotation.z = -Math.PI / 2; // lathe geometry axis y -> +x
    group.add(mesh);
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(R, 14), Math.min(R, 14), 70, 32), steel);
    sh.rotation.z = Math.PI / 2;
    sh.position.x = len + 35;
    group.add(sh);
    const hold = new THREE.Mesh(new THREE.BoxGeometry(60, 70, 70), holderMat);
    hold.position.x = len + 100;
    group.add(hold);
    return { group, nozzle: new THREE.Vector3(R + 15, R + 25, 20), spin: null };
  }
  const poly = toolPolygonLocal(tool);
  const ext = new THREE.ExtrudeGeometry(polyShape(poly), { depth: 3.4, bevelEnabled: false });
  ext.translate(0, 0, -1.7);
  const ins = new THREE.Mesh(ext, insMat);
  group.add(ins);
  let cx = 0, cz = 0;
  poly.forEach(([z, x]) => {
    cz += z / poly.length;
    cx += x / poly.length;
  });
  const dirZ = cz >= 0 ? 1 : -1;
  const dirX = cx >= 0 ? 1 : -1;
  if (t === 'bore' || t === 'thread_id') {
    const rad = Math.max(4, (tool.dia || 12) / 2);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 90, 28), steel);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(cz + 45, cx - dirX * rad * 0.6, 0);
    group.add(bar);
    const hold = new THREE.Mesh(new THREE.BoxGeometry(60, 50, 60), holderMat);
    hold.position.set(cz + 120, cx - dirX * 18, 0);
    group.add(hold);
  } else {
    const h = new THREE.Mesh(new THREE.BoxGeometry(22, 70, 22), holderMat);
    h.position.set(cz + dirZ * 8, cx + dirX * 36, 0);
    group.add(h);
    const base = new THREE.Mesh(new THREE.BoxGeometry(70, 30, 60), holderMat);
    base.position.set(cz + dirZ * 28, cx + dirX * 85, 0);
    group.add(base);
  }
  return { group, spin: null, nozzle: new THREE.Vector3(18, 34, 28) };
}

export class ToolActor {
  constructor(parent, machine) {
    this.machine = machine;
    this.root = new THREE.Group();
    parent.add(this.root);
    this.current = null;
    this.key = '';
    this.spinAngle = 0;
    this.nozzleLocal = new THREE.Vector3();
  }

  setTool(tool) {
    const key = tool ? JSON.stringify(tool) : '';
    if (key === this.key) return;
    this.key = key;
    if (this.current) {
      this.root.remove(this.current.group);
      disposeObject(this.current.group);
      this.current = null;
    }
    if (!tool) return;
    this.current = this.machine === 'lathe' ? buildLathe(tool) : buildMill(tool);
    this.root.add(this.current.group);
    this.nozzleLocal.copy(this.current.nozzle);
  }

  setPos(p) {
    toThree(this.machine, p, this.root.position);
  }

  spin(rpm, dir, dt) {
    if (!this.current?.spin || !rpm) return;
    const w = Math.min(rpm, 3000) / 60;
    this.spinAngle += (dir === 4 ? -1 : 1) * w * dt * 0.8 * Math.PI * 2;
    this.current.spin.rotation.y = this.spinAngle;
  }

  nozzleWorld(out = new THREE.Vector3()) {
    return out.copy(this.nozzleLocal).add(this.root.position);
  }
  tipWorld(out = new THREE.Vector3()) {
    return out.copy(this.root.position);
  }
}

export class Coolant {
  constructor(parent) {
    const N = 220;
    this.N = N;
    this.phase = new Float32Array(N);
    this.jit = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      this.phase[i] = Math.random();
      this.jit[i * 3] = (Math.random() - 0.5) * 2;
      this.jit[i * 3 + 1] = (Math.random() - 0.5) * 2;
      this.jit[i * 3 + 2] = (Math.random() - 0.5) * 2;
    }
    this.pos = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      color: 0x7fd4ff,
      size: 1.8,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    parent.add(this.points);
    this.on = false;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
  }
  setOn(v) {
    this.on = v;
    this.points.visible = v;
  }
  update(dt, nozzle, tip) {
    if (!this.on) return;
    for (let i = 0; i < this.N; i++) {
      let t = this.phase[i] + dt * 1.8;
      if (t > 1) t -= 1;
      this.phase[i] = t;
      const sag = 6 * 4 * t * (1 - t);
      const spread = t * 1.4;
      this.pos[i * 3] = nozzle.x + (tip.x - nozzle.x) * t + this.jit[i * 3] * spread;
      this.pos[i * 3 + 1] = nozzle.y + (tip.y - nozzle.y) * t - sag * 0.3 + this.jit[i * 3 + 1] * spread;
      this.pos[i * 3 + 2] = nozzle.z + (tip.z - nozzle.z) * t + this.jit[i * 3 + 2] * spread;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
