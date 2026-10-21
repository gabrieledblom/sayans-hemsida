// Applies interpreter steps to the stock models and tracks machine state and
// run-time warnings (crashes, cutting with the spindle off, ...).

import { LatheStock } from './lathe-stock.js';
import { MillStock } from './mill-stock.js';

export function createStock(machine, setup) {
  return machine === 'lathe' ? new LatheStock(setup.lathe) : new MillStock(setup.mill);
}

export class SimEngine {
  constructor(machine, setup) {
    this.machine = machine;
    this.setup = setup;
    this.stock = createStock(machine, setup);
    this.warnKeys = new Set();
    this.warnings = [];
    this.resetState();
  }

  resetState() {
    this.stock.reset();
    this.tool = null;
    this.toolNo = 0;
    this.spindleDir = 0;
    this.rpm = 0;
    this.coolant = false;
    this.airblast = false;
    this.modal = null;
    this.vars = new Map();
    this.warnKeys.clear();
    this.warnings = [];
  }

  warn(text, ln) {
    const key = `${ln}:${text}`;
    if (this.warnKeys.has(key)) return null;
    this.warnKeys.add(key);
    const w = { type: 'warn', ln, text, runtime: true };
    this.warnings.push(w);
    return w;
  }

  // Handles non-motion steps. Returns a list of new warnings (usually empty).
  handleEvent(s) {
    switch (s.e) {
      case 'blk':
        if (s.m) this.modal = s.m;
        if (s.vars) for (const v of s.vars) this.vars.set(`${v.k}${v.i}`, v.v);
        break;
      case 'tool':
        this.tool = s.rec;
        this.toolNo = s.n;
        break;
      case 'spindle':
        this.spindleDir = s.dir;
        this.rpm = s.rpm;
        break;
      case 'coolant':
        this.coolant = s.on;
        break;
      case 'air':
        this.airblast = true;
        break;
    }
  }

  // Apply the part of motion step `s` between fractions t0..t1. Returns array of new warnings.
  applyMotion(s, t0 = 0, t1 = 1) {
    const out = [];
    if (!this.tool || t1 <= t0) return out;
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      a[i] = s.a[i] + (s.b[i] - s.a[i]) * t0;
      b[i] = s.a[i] + (s.b[i] - s.a[i]) * t1;
    }
    const push = (w) => w && out.push(w);
    if (this.machine === 'lathe') {
      if (s.nocut) return out;
      const removed = s.pitch ? this.stock.sweepThread(this.tool, s.a, s.b, s.pitch, t0, t1) : this.stock.sweep(this.tool, a, b);
      if (removed > 0.0005) this.checkCut(s, push);
    } else {
      const r = this.stock.sweep(this.tool, a, b, s.nocut);
      if (r.cut > 0.0005) this.checkCut(s, push);
      if (r.shank) push(this.warn(`T${this.toolNo}: skärlängden ${this.tool.len || 30} mm räcker inte – skaft/hållare går i material`, s.ln));
    }
    return out;
  }

  checkCut(s, push) {
    if (s.rapid) push(this.warn(`Snabbtransport (G00) i material med T${this.toolNo} – kollisionsrisk`, s.ln));
    else if (!this.spindleDir) push(this.warn(`Skär i material utan att spindeln går (M03/M04) med T${this.toolNo}`, s.ln));
  }

  // Run every step instantly up to (excluding) index `end`.
  fastForward(steps, end = steps.length) {
    const all = [];
    for (let i = 0; i < end; i++) {
      const s = steps[i];
      if (s.k === 'e') this.handleEvent(s);
      else if (s.k === 'm') all.push(...this.applyMotion(s, 0, 1));
    }
    return all;
  }
}
