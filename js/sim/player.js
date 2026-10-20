// Time-based playback of interpreter steps with feed/rapid override, single
// block, optional stop and instant seek.

export class Player {
  constructor(engine) {
    this.engine = engine;
    this.steps = [];
    this.handlers = {};
    this.speed = 1;
    this.feedPct = 100;
    this.rapidPct = 100;
    this.optionalStop = false;
    this.playing = false;
    this.finished = false;
    this.stopAtBlk = false;
    this.seenBlk = false;
    this.idx = 0;
    this.frac = 0;
    this.pos = [0, 0, 0];
    this.curLn = -1;
    this.simTime = 0;
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }
  emit(name, ...a) {
    this.handlers[name]?.(...a);
  }

  load(steps, startPos) {
    this.steps = steps;
    this.startPos = startPos.slice();
    this.reset();
  }

  reset() {
    this.engine.resetState();
    this.idx = 0;
    this.frac = 0;
    this.pos = this.startPos.slice();
    this.playing = false;
    this.finished = false;
    this.stopAtBlk = false;
    this.seenBlk = false;
    this.curLn = -1;
    this.simTime = 0;
    this.feedNow = 0;
    this.emit('state');
    this.emit('line', -1);
  }

  play() {
    if (this.finished) this.reset();
    this.playing = true;
    this.stopAtBlk = false;
    this.emit('state');
  }
  pause() {
    this.playing = false;
    this.emit('state');
  }
  stepBlock() {
    if (this.finished) this.reset();
    this.stopAtBlk = true;
    this.seenBlk = false;
    this.playing = true;
    this.emit('state');
  }

  get duration() {
    const l = this.steps[this.steps.length - 1];
    return l ? l.t0 + (l.dur || 0) : 0;
  }

  // Jump instantly to step index (material state rebuilt).
  seek(index) {
    this.engine.resetState();
    index = Math.max(0, Math.min(this.steps.length, index));
    const w = this.engine.fastForward(this.steps, index);
    this.idx = index;
    this.frac = 0;
    this.finished = false;
    this.playing = false;
    this.lastLn(index);
    const prev = this.lastMotion(index);
    this.pos = prev ? prev.b.slice() : this.startPos.slice();
    this.simTime = this.steps[index - 1] ? this.steps[index - 1].t0 + (this.steps[index - 1].dur || 0) : 0;
    w.forEach((x) => this.emit('warn', x));
    this.emit('state');
  }

  seekTime(t) {
    let lo = 0, hi = this.steps.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.steps[m].t0 + (this.steps[m].dur || 0) < t) lo = m + 1;
      else hi = m;
    }
    this.seek(lo);
  }

  runToEnd() {
    this.seek(this.steps.length);
    this.finished = true;
    this.emit('end');
  }

  lastMotion(index) {
    for (let i = index - 1; i >= 0; i--) if (this.steps[i].k === 'm') return this.steps[i];
    return null;
  }
  lastLn(index) {
    for (let i = index - 1; i >= 0; i--) {
      const s = this.steps[i];
      if (s.k === 'e' && s.e === 'blk') {
        this.curLn = s.ln;
        this.emit('line', s.ln);
        if (s.m) this.engine.modal = s.m;
        return;
      }
    }
    this.curLn = -1;
    this.emit('line', -1);
  }

  tick(dtReal, deadlineMs = 11) {
    if (!this.playing) return;
    const t0 = performance.now();
    let budget = dtReal; // real seconds
    const steps = this.steps;
    while (budget > 1e-9 && this.idx < steps.length) {
      if (performance.now() - t0 > deadlineMs) break;
      const s = steps[this.idx];
      if (s.k === 'e') {
        if (s.e === 'blk') {
          if (this.stopAtBlk) {
            if (this.seenBlk) {
              this.playing = false;
              this.stopAtBlk = false;
              this.emit('state');
              return;
            }
            this.seenBlk = true;
          }
          this.curLn = s.ln;
          this.emit('line', s.ln);
        }
        this.engine.handleEvent(s);
        this.idx++;
        this.emit('event', s);
        if (s.e === 'stop' && (!s.optional || this.optionalStop)) {
          this.playing = false;
          this.emit('state');
          this.emit('stop', s);
          return;
        }
        if (s.e === 'end') {
          this.finish();
          return;
        }
        continue;
      }
      const factor = this.speed * (s.k === 'm' && s.rapid ? this.rapidPct : this.feedPct) / 100;
      if (factor <= 0) break;
      const simRemaining = (1 - this.frac) * (s.dur || 0);
      const simAvail = budget * factor;
      const use = Math.min(simAvail, simRemaining);
      const nf = s.dur > 0 ? this.frac + use / s.dur : 1;
      if (s.k === 'm') {
        const warns = this.engine.applyMotion(s, this.frac, Math.min(1, nf));
        warns.forEach((w) => this.emit('warn', w));
        const t = Math.min(1, nf);
        this.pos = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t, s.a[2] + (s.b[2] - s.a[2]) * t];
        this.feedNow = s.rapid ? -1 : s.f;
        if (s.rpm !== undefined) this.engine.rpmNow = s.rpm;
      }
      budget -= use / factor;
      this.frac = nf;
      this.simTime = s.t0 + Math.min(1, nf) * (s.dur || 0);
      if (nf >= 1 - 1e-9) {
        if (s.k === 'm') this.pos = s.b.slice();
        this.idx++;
        this.frac = 0;
      }
    }
    if (this.idx >= steps.length) this.finish();
  }

  finish() {
    this.playing = false;
    this.finished = true;
    this.feedNow = 0;
    this.emit('state');
    this.emit('end');
  }
}
