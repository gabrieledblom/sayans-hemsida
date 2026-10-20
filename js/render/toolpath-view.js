// Tool path lines: faint preview of the whole program plus a bright trace of
// what has been machined so far. Rapid moves are dashed.

import * as THREE from 'three';
import { disposeObject } from './scene.js';
import { toThree } from './tool-view.js';

export class ToolpathView {
  constructor(parent, machine) {
    this.machine = machine;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.opts = { rapid: true, feed: true, preview: true };
    this.prefF = new Int32Array(0);
    this.prefR = new Int32Array(0);
  }

  clear() {
    while (this.group.children.length) {
      const c = this.group.children.pop();
      disposeObject(c);
    }
  }

  setSteps(steps) {
    this.clear();
    const n = steps.length;
    this.prefF = new Int32Array(n + 1);
    this.prefR = new Int32Array(n + 1);
    let cf = 0, cr = 0;
    for (const s of steps) {
      if (s.k === 'm') s.rapid ? cr++ : cf++;
    }
    const feed = new Float32Array(cf * 6);
    const rapid = new Float32Array(cr * 6);
    let f = 0, r = 0;
    const v = new THREE.Vector3();
    steps.forEach((s, i) => {
      if (s.k === 'm') {
        const arr = s.rapid ? rapid : feed;
        const o = (s.rapid ? r : f) * 6;
        toThree(this.machine, s.a, v);
        arr[o] = v.x; arr[o + 1] = v.y; arr[o + 2] = v.z;
        toThree(this.machine, s.b, v);
        arr[o + 3] = v.x; arr[o + 4] = v.y; arr[o + 5] = v.z;
        s.rapid ? r++ : f++;
      }
      this.prefF[i + 1] = f;
      this.prefR[i + 1] = r;
    });
    const mk = (arr, color, opacity, dashed) => {
      const attr = new THREE.BufferAttribute(arr, 3);
      const mkGeo = () => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attr);
        return g;
      };
      const mat = () =>
        dashed
          ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 2.2, gapSize: 1.6 })
          : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      const prev = new THREE.LineSegments(mkGeo(), mat());
      const done = new THREE.LineSegments(mkGeo(), mat());
      if (dashed) {
        prev.computeLineDistances();
        done.computeLineDistances();
      }
      prev.material.opacity = opacity * 0.4;
      done.material.opacity = Math.min(1, opacity * 1.9);
      prev.frustumCulled = done.frustumCulled = false;
      done.geometry.setDrawRange(0, 0);
      done.renderOrder = 2;
      this.group.add(prev, done);
      return { prev, done };
    };
    this.feedL = mk(feed, 0x35d6a4, 0.55, false);
    this.rapidL = mk(rapid, 0xff6b6b, 0.5, true);
    this.apply();
  }

  setProgress(idx) {
    if (!this.feedL) return;
    this.feedL.done.geometry.setDrawRange(0, this.prefF[idx] * 2);
    this.rapidL.done.geometry.setDrawRange(0, this.prefR[idx] * 2);
  }

  setOptions(o) {
    Object.assign(this.opts, o);
    this.apply();
  }

  apply() {
    if (!this.feedL) return;
    const { rapid, feed, preview } = this.opts;
    this.feedL.prev.visible = feed && preview;
    this.feedL.done.visible = feed;
    this.rapidL.prev.visible = rapid && preview;
    this.rapidL.done.visible = rapid;
  }
}
