// three.js viewport: renderer, camera, controls, lights, floor.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Viewport {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '3D-vy av maskinen');

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.98;

    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x1a2230, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(200, 400, 260);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fc8ff, 0.7);
    rim.position.set(-300, 120, -240);
    this.scene.add(rim);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.grid = new THREE.GridHelper(1200, 48, 0x2b3a4d, 0x1c2735);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.7;
    this.scene.add(this.grid);

    this.frameCbs = [];
    this.clock = new THREE.Clock();
    this.needsRender = true;
    this.running = true;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    this.controls.addEventListener('change', () => (this.needsRender = true));
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  onFrame(cb) {
    this.frameCbs.push(cb);
  }

  loop() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    for (const cb of this.frameCbs) cb(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.loop);
  }

  // target: THREE.Vector3, preset names: iso | front | top | side
  setView(name, target, size) {
    const half = Math.tan((this.camera.fov * Math.PI) / 360);
    const fitH = (Math.max(size, 60) * 0.62) / half;
    const fitW = (Math.max(size, 60) * 0.62) / (half * Math.max(this.camera.aspect, 0.2));
    const d = Math.max(fitH, fitW) * 1.45;
    const t = target.clone();
    const p = {
      iso: [0.9, 0.75, 1.1],
      front: [0, 0.12, 1],
      top: [0, 1, 0.001],
      side: [1, 0.12, 0],
      lathe: [0.35, 0.8, 1.15],
    }[name] || [0.9, 0.75, 1.1];
    const v = new THREE.Vector3(...p).normalize().multiplyScalar(d);
    this.camera.position.copy(t).add(v);
    this.controls.target.copy(t);
    this.controls.update();
    this.needsRender = true;
  }

  dispose() {
    this.ro.disconnect();
    this.renderer.dispose();
  }
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const m = Array.isArray(o.material) ? o.material : [o.material];
      m.forEach((x) => x.dispose());
    }
  });
}
