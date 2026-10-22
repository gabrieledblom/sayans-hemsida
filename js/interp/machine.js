// Okuma OSP-P300 style interpreter.
// Executes a program completely and returns a timestamped list of steps
// (linear moves, dwells, machine events) that the simulator plays back.

import { parseProgramText, evalExpr } from './lexer.js';
import { planeAxes, centerFromRadius, arcSweep, linearizeArc, dist3, EPS } from './geom.js';
import { CornerStage, CompStage } from './comp.js';
import { compRadius, tipToCenter, makeTool } from '../sim/tools.js';

class MachineAlarm extends Error {}

const KNOWN_ADDR = new Set('NGMXYZUWABCIJKRFSTHDPQLEOV'.split(''));
const MAX_BLOCKS = 600000;
const MAX_STEPS = 2500000;

export const SUPPORTED_G = new Set([
  0, 1, 2, 3, 4, 9, 10, 11, 15, 17, 18, 19, 20, 21, 30, 31, 32, 33, 40, 41, 42, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  61, 62, 71, 72, 73, 74, 75, 76, 77, 78, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 94, 95, 96, 97, 98, 99,
  110, 111, 116, 178, 179, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190,
]);
export const SUPPORTED_M = new Set([
  0, 1, 2, 3, 4, 5, 6, 8, 9, 12, 15, 16, 30, 40, 52, 53, 54, 59, 60, 88, 115, 116, 120, 288, 289, 321, 339, 403, 404,
]);

const AIR_M = new Set([12, 59, 88, 288, 289]);
const COOLANT_ON = new Set([8, 120, 339]);

export function runProgram(text, cfg) {
  return new Machine(text, cfg).run();
}

class Machine {
  constructor(text, cfg) {
    this.cfg = cfg;
    this.lathe = cfg.machine === 'lathe';
    const parsed = parseProgramText(text);
    this.blocks = parsed.blocks;
    this.programs = parsed.programs;
    this.main = parsed.main;
    this.steps = [];
    this.queue = [];
    this.msgs = [];
    this.msgKeys = new Set();
    this.time = 0;
    this.seq = 0;
    this.maxEmitted = 0;
    this.curLn = 0;
    this.stats = { tools: new Map(), rapidLen: 0, feedLen: 0, blocks: 0, bbox: null };
    this.common = new Map();
    this.frames = [];
    this.capturing = null;

    // ---- modal state ----
    this.abs = true;
    this.unitScale = 1;
    this.plane = this.lathe ? 18 : 17;
    this.modalMotion = 0;
    this.cycle = null;
    this.retract = 98;
    this.feedMode = this.lathe ? 95 : 94;
    this.F = 0;
    this.S = 0;
    this.css = false;
    this.cssV = 0;
    this.maxRpm = cfg.maxRpm || (this.lathe ? 4000 : 12000);
    this.spindle = 0;
    this.coolant = false;
    this.tool = 0;
    this.toolRec = null;
    this.preTool = null;
    this.lenComp = null;
    this.compG = 40;
    this.workH = 1;
    this.local = [0, 0, 0];
    this.shift = [0, 0, 0];
    this.scale = { on: false, c: [0, 0, 0], k: 1 };
    this.mirror = [null, null, null];
    this.exact = false;
    this.rotComp = false;
    this.cornerMode = null; // { type:'C'|'R', size }
    this.rot = { a: 0, b: 0, c: 0 };
    this.rotDir = {};
    this.g71 = { depth: 1, retract: 0.5 };
    this.warnedTools = new Set();

    const home = cfg.home || (this.lathe ? [100, 0, 150] : [0, 0, 150]);
    this.home = home;
    this.p = this.progFromWorld(home);
    this.toolPos = home.slice();
    this.startPos = home.slice();

    this.corner = new CornerStage((prim) => this.afterCorner(prim), (m, ln) => this.warn(m, ln));
    this.comp = new CompStage(
      (prim) => this.emitPrimFinal(prim),
      (m, ln) => this.warn(m, ln),
      () => this.toolPos.slice(),
    );
  }

  // ------------------------------------------------------------------ utils
  warn(text, ln = this.curLn) {
    const key = `${ln}:${text}`;
    if (this.msgKeys.has(key)) return;
    this.msgKeys.add(key);
    this.msgs.push({ type: 'warn', ln, text });
  }
  info(text, ln = this.curLn) {
    this.msgs.push({ type: 'info', ln, text });
  }
  alarm(text, ln = this.curLn) {
    throw new MachineAlarm(JSON.stringify({ text, ln }));
  }

  get offsets() {
    return this.cfg.offsets?.[this.workH] || { x: 0, y: 0, z: 0 };
  }
  totalOffset() {
    const o = this.offsets;
    return [o.x + this.local[0] + this.shift[0], o.y + this.local[1] + this.shift[1], o.z + this.local[2] + this.shift[2]];
  }

  worldOf(px, py, pz) {
    const v = [px, py, pz];
    if (this.scale.on) for (let i = 0; i < 3; i++) v[i] = this.scale.c[i] + (v[i] - this.scale.c[i]) * this.scale.k;
    for (let i = 0; i < 3; i++) if (this.mirror[i] !== null) v[i] = 2 * this.mirror[i] - v[i];
    const off = this.totalOffset();
    for (let i = 0; i < 3; i++) v[i] += off[i];
    if (this.lathe) return [v[0] / 2, 0, v[2]];
    return v;
  }
  progFromWorld(w) {
    const off = this.totalOffset();
    if (this.lathe) return { x: w[0] * 2 - off[0], y: 0, z: w[2] - off[2] };
    return { x: w[0] - off[0], y: w[1] - off[1], z: w[2] - off[2] };
  }
  axisFactor(i, radiusValue = false) {
    let f = this.scale.on ? this.scale.k : 1;
    if (this.mirror[i] !== null) f = -f;
    if (this.lathe && i === 0 && !radiusValue) f *= 0.5;
    return f;
  }

  // ------------------------------------------------------------- variables
  get locals() {
    return this.frames[this.frames.length - 1].locals;
  }
  getVar(kind, idx) {
    return (kind === 'VC' ? this.common : this.locals).get(idx) || 0;
  }
  setVar(kind, idx, val) {
    (kind === 'VC' ? this.common : this.locals).set(idx, val);
  }
  sys(name, arg) {
    const u = this.unitScale;
    switch (name) {
      case 'PX': return this.p.x / u;
      case 'PY': return this.p.y / u;
      case 'PZ': return this.p.z / u;
      case 'VACOD': return this.workH;
      case 'VATOL':
      case 'VTLCN': return this.tool;
      case 'VINS': return this.unitScale === 1 ? 0 : 1;
      case 'VZSHX': return this.offsets.x;
      case 'VZSHY': return this.offsets.y;
      case 'VZSHZ': return this.offsets.z;
      case 'VTOFD': {
        const t = this.cfg.tools[Math.round(arg)];
        return t ? compRadius(t, this.cfg.machine) : 0;
      }
    }
    return 0;
  }
  ev(v) {
    try {
      return evalExpr(v, this);
    } catch (e) {
      this.alarm(e.message);
    }
  }

  // ------------------------------------------------------------- stepping
  newSeq() {
    return ++this.seq;
  }
  pushStep(step) {
    if (this.seq > this.maxEmitted && !this.capturing) this.queue.push({ after: this.seq, step });
    else this.commit(step);
  }
  commit(step) {
    if (this.capturing) return;
    step.t0 = this.time;
    this.time += step.dur || 0;
    this.steps.push(step);
    if (this.steps.length > MAX_STEPS) this.alarm('Programmet genererar för många rörelser (möjlig oändlig loop?)');
  }
  drain() {
    while (this.queue.length && this.queue[0].after <= this.maxEmitted) this.commit(this.queue.shift().step);
  }
  event(e, data = {}) {
    this.pushStep({ k: 'e', e, ln: this.curLn, ...data });
  }

  // -------------------------------------------------------------- run loop
  run() {
    let err = null;
    try {
      this.init();
      this.execute();
    } catch (e) {
      if (e instanceof MachineAlarm) {
        const d = JSON.parse(e.message);
        err = d;
        this.msgs.push({ type: 'error', ln: d.ln, text: d.text });
      } else {
        err = { text: e.message, ln: this.curLn };
        this.msgs.push({ type: 'error', ln: this.curLn, text: `Internt fel: ${e.message}` });
        console.error(e);
      }
    }
    try {
      this.corner.flush();
      this.comp.flush();
    } catch (e) {
      /* ignore secondary errors */
    }
    this.maxEmitted = Infinity;
    this.drain();
    this.curLn = this.curLn || 0;
    this.event('end', { ok: !err });
    return {
      steps: this.steps,
      msgs: this.msgs,
      blocks: this.blocks,
      error: err,
      duration: this.time,
      stats: {
        tools: [...this.stats.tools.entries()].map(([n, ln]) => ({ n, ln })),
        rapidLen: this.stats.rapidLen,
        feedLen: this.stats.feedLen,
        blocks: this.stats.blocks,
        bbox: this.stats.bbox,
      },
      start: this.startPos,
    };
  }

  init() {
    if (this.cfg.tools && this.cfg.initialTool) this.loadTool(this.cfg.initialTool, true);
    this.event('spindle', { dir: 0, rpm: 0 });
  }

  findLabel(prog, n) {
    for (let i = prog.start; i <= prog.end; i++) if (this.blocks[i].seq === n) return i;
    return -1;
  }

  execute() {
    const main = this.main;
    this.frames = [{ prog: main, locals: new Map(), ret: null, repeat: 1, startPc: main.start }];
    let pc = main.start;
    let count = 0;
    for (;;) {
      const frame = this.frames[this.frames.length - 1];
      if (pc > frame.prog.end) {
        if (this.frames.length === 1) return;
        pc = this.returnFrom(frame);
        continue;
      }
      if (++count > MAX_BLOCKS) this.alarm('Programmet verkar loopa (för många block)', pc);
      const b = this.blocks[pc];
      this.curLn = b.i;
      const r = this.execBlock(b, pc, frame);
      if (r === 'END') return;
      pc = r;
    }
  }

  returnFrom(frame) {
    if (--frame.repeat > 0) return frame.startPc;
    this.frames.pop();
    return frame.ret;
  }

  // ------------------------------------------------------------ block exec
  execBlock(b, pc, frame) {
    if (b.err) this.alarm(b.err, b.i);
    if (b.header) return pc + 1;
    if (b.skip && this.cfg.blockSkip) return pc + 1;
    if (!b.code && !b.assigns.length) {
      if (b.comment && /^MSG\b/.test(b.comment)) this.event('msg', { text: b.comment.replace(/^MSG[\s,:]*/, '') });
      return pc + 1;
    }
    this.stats.blocks++;
    this.comp.beginBlock();
    const blk = { k: 'e', e: 'blk', ln: b.i, m: null };
    this.pushStep(blk);

    if (b.assigns.length) blk.vars = [];
    for (const asg of b.assigns) {
      const idx = Math.round(this.ev(asg.idx));
      const val = this.ev(asg.expr);
      this.setVar(asg.kind, idx, val);
      blk.vars.push({ k: asg.kind, i: idx, v: val });
    }
    blk.m = this.snapshot();

    const s = b.stmt;
    if (s) {
      switch (s.type) {
        case 'rts':
          if (this.frames.length === 1) this.alarm('RTS utan CALL');
          return this.returnFrom(frame);
        case 'goto': {
          const t = this.findLabel(frame.prog, s.label);
          if (t < 0) this.alarm(`Sekvensnummer N${s.label} hittades inte`);
          return t;
        }
        case 'while': {
          let endAt = -1;
          for (let i = pc + 1; i <= frame.prog.end; i++) {
            const st = this.blocks[i].stmt;
            if (st && st.type === 'end' && st.n === s.n) {
              endAt = i;
              break;
            }
          }
          if (endAt < 0) this.alarm(`WHILE ... DO${s.n} saknar matchande END${s.n}`);
          return this.ev(s.cond) ? pc + 1 : endAt + 1;
        }
        case 'end': {
          for (let i = pc - 1; i >= frame.prog.start; i--) {
            const st = this.blocks[i].stmt;
            if (st && st.type === 'while' && st.n === s.n) return i;
          }
          this.alarm(`END${s.n} saknar matchande WHILE ... DO${s.n}`);
          return pc + 1;
        }
        case 'if': {
          if (this.ev(s.cond)) {
            const t = this.findLabel(frame.prog, s.label);
            if (t < 0) this.alarm(`Sekvensnummer N${s.label} hittades inte`);
            return t;
          }
          return pc + 1;
        }
        case 'call': {
          const sub = this.programs.get(s.name);
          if (!sub) this.alarm(`Underprogram O${s.name} finns inte`);
          if (this.frames.length > 20) this.alarm('För djup CALL-nästling (max 20)');
          const w = this.collectWords(b);
          const locals = new Map();
          for (const [k, v] of Object.entries(w.a)) {
            if (k === 'Q' || k === 'N') continue;
            locals.set(k.charCodeAt(0) - 64, v);
            blk.vars = blk.vars || [];
            blk.vars.push({ k: 'V', i: k.charCodeAt(0) - 64, v });
          }
          this.frames.push({
            prog: sub,
            locals,
            ret: pc + 1,
            repeat: Math.max(1, Math.round(w.a.Q ?? 1)),
            startPc: sub.start + 1,
          });
          return sub.start + 1;
        }
      }
    }

    const w = this.collectWords(b);
    const end = this.executeWords(w, b);
    this.comp.endBlock();
    blk.m = this.snapshot();
    return end ? 'END' : pc + 1;
  }

  collectWords(b) {
    const w = { g: [], m: [], a: {}, corner: null, raw: b };
    for (const word of b.words) {
      const v = this.ev(word.v);
      if (word.a === 'G') w.g.push(v);
      else if (word.a === 'M') w.m.push(v);
      else if (word.a.startsWith(',')) w.corner = { type: word.a[1], size: v * this.unitScale };
      else {
        if (!KNOWN_ADDR.has(word.a) && !['MT', 'TG', 'TL', 'SB'].includes(word.a)) {
          this.warn(`Okänd adress ${word.a}`);
        }
        w.a[word.a] = v;
      }
    }
    return w;
  }

  snapshot() {
    const g = [];
    g.push(`G${String(this.modalMotion).padStart(2, '0')}`);
    g.push(`G${this.plane}`);
    g.push(this.abs ? 'G90' : 'G91');
    g.push(`G${this.feedMode}`);
    g.push(`G${this.compG}`);
    g.push(this.lenComp ? `G${this.lenComp.g}` : 'G53');
    g.push(this.cycle ? `G${this.cycle.g}` : 'G80');
    g.push(`G${this.retract}`);
    g.push(this.unitScale === 1 ? 'G21' : 'G20');
    if (this.lathe) g.push(this.css ? 'G96' : 'G97');
    g.push(`G15 H${this.workH}`);
    if (this.scale.on) g.push('G51');
    if (this.mirror.some((m) => m !== null)) g.push('G62');
    const m = [];
    m.push(this.spindle === 3 ? 'M03' : this.spindle === 4 ? 'M04' : 'M05');
    m.push(this.coolant ? 'M08' : 'M09');
    return {
      g,
      m,
      f: this.F,
      s: this.css ? this.cssV : this.S,
      css: this.css,
      tool: this.tool,
      off: this.totalOffset(),
      rot: [this.rot.a, this.rot.b, this.rot.c],
      lathe: this.lathe,
      maxRpm: this.maxRpm,
    };
  }

  // Returns true when the program ended (M2/M30)
  executeWords(w, b) {
    const a = w.a;
    const isDwell = w.g.includes(4);
    const actions = [];

    // ---- 1. modal / preparatory G codes
    for (const g of w.g) this.doG(g, w, actions);

    // ---- 2. S and F
    if (a.S !== undefined) this.setSpeed(a.S);
    if (a.F !== undefined && !isDwell) {
      this.F = a.F * this.unitScale;
    }
    if (a.SB !== undefined) this.setSpeed(a.SB);

    // ---- 3. tool selection
    if (a.MT !== undefined) this.preTool = this.toolNo(a.MT);
    if (a.TG !== undefined) this.loadTool(this.toolNo(a.TG));
    if (a.TL !== undefined) this.lenOffsetNo = a.TL;
    if (a.T !== undefined) {
      const n = this.toolNo(a.T);
      if (this.lathe) this.loadTool(n);
      else this.preTool = n;
    }
    // ---- 4. M codes before motion
    const post = [];
    for (const m of w.m) this.doM(m, w, post);

    // ---- 5. motion / actions
    if (actions.includes(4)) this.dwell(a);
    else if (actions.includes(30)) this.returnRef(a, 'G30');
    this.motionPhase(w, actions);

    // ---- 6. M codes after motion
    let ended = false;
    for (const m of post) if (this.doPostM(m)) ended = true;
    return ended;
  }

  toolNo(v) {
    v = Math.round(v);
    if (!this.lathe) return v;
    if (v >= 10000) return Math.floor(v / 10000);
    if (v >= 100) return Math.floor(v / 100);
    return v;
  }

  setSpeed(S) {
    if (this.css) this.cssV = S * this.unitScale;
    else this.S = S;
    if (this.spindle) this.spindleEvent();
  }
  curRpm(dia = 0) {
    if (!this.spindle) return 0;
    if (this.css) {
      const d = Math.max(dia, 1);
      return Math.min(this.maxRpm, (1000 * this.cssV) / (Math.PI * d));
    }
    return this.S;
  }
  spindleEvent(dia) {
    this.event('spindle', { dir: this.spindle, rpm: this.curRpm(dia ?? this.lastDia ?? 50), css: this.css });
  }

  loadTool(n, silent = false) {
    if (!n) return;
    let rec = this.cfg.tools[n];
    if (!rec) {
      if (!this.warnedTools.has(n)) {
        this.warnedTools.add(n);
        this.warn(`Verktyg T${n} finns inte i verktygslistan – ett standardverktyg används`);
      }
      rec = { ...makeTool(this.cfg.machine, n), name: `T${n} (standard)` };
    }
    this.tool = n;
    this.toolRec = rec;
    this.preTool = null;
    if (!this.stats.tools.has(n)) this.stats.tools.set(n, this.curLn);
    this.event('tool', { n, rec });
  }

  // ---------------------------------------------------------------- G codes
  doG(g, w, actions) {
    const a = w.a;
    const L = this.lathe;
    const isLatheOnly = () => {
      if (!L) this.warn(`G${g} är en svarvkod och ignoreras i fräsläge`);
      return !L;
    };
    switch (g) {
      case 0:
      case 1:
      case 2:
      case 3:
        this.modalMotion = g;
        this.cycle = null;
        break;
      case 4:
        actions.push(4);
        break;
      case 9:
        break;
      case 61:
        this.exact = true;
        break;
      case 10:
        this.local = [0, 0, 0];
        break;
      case 11: {
        const o = this.offsets;
        this.local = [
          a.X !== undefined ? a.X * this.unitScale : 0,
          a.Y !== undefined ? a.Y * this.unitScale : 0,
          a.Z !== undefined ? a.Z * this.unitScale : 0,
        ];
        void o;
        delete a.X; delete a.Y; delete a.Z;
        break;
      }
      case 15: {
        const h = Math.round(a.H ?? 1);
        if (!this.cfg.offsets?.[h] && h !== 1) this.warn(`Nollpunkt H${h} är inte definierad (använder 0,0,0)`);
        this.workH = h;
        break;
      }
      case 17:
      case 18:
      case 19:
        this.plane = g;
        break;
      case 20:
      case 21:
        // Okuma list: lathe G20/G21 = return to reference point; mill G20 = inch, G21 = mm
        if (L) actions.push(30);
        else this.unitScale = g === 20 ? 25.4 : 1;
        break;
      case 30:
        if (L) this.warn('G30 är en fräskod. På svarv används G20/G21 för återgång till referenspunkt');
        else actions.push(30);
        break;
      case 40:
        this.compG = 40;
        this.corner.flush();
        this.comp.deactivate();
        break;
      case 41:
      case 42: {
        if (this.plane === 19) {
          this.warn('Radiekompensering stöds inte i G19-planet');
          break;
        }
        const dn = Math.round(a.D ?? 0);
        const rec = dn && this.cfg.tools[dn] ? this.cfg.tools[dn] : this.toolRec;
        if (!rec) this.alarm('G41/G42 utan valt verktyg');
        const r = compRadius(rec, this.cfg.machine);
        if (r <= 0) this.warn(`Verktyg T${rec.n} har radie 0 – kompensering har ingen effekt`);
        this.compG = g;
        this.corner.flush();
        this.comp.activate(g === 41 ? 1 : -1, r, this.plane);
        break;
      }
      case 50:
        if (a.S !== undefined) {
          this.maxRpm = a.S;
          delete a.S;
        } else {
          this.scale = { on: false, c: [0, 0, 0], k: 1 };
          this.mirror = [null, null, null];
        }
        break;
      case 51: {
        const k = a.P ?? a.I ?? null;
        if (k === null || k === 0) {
          this.alarm('G51 kräver skalfaktor (P)');
        }
        this.scale = {
          on: true,
          k,
          c: [(a.X ?? this.p.x) * this.unitScale, (a.Y ?? this.p.y) * this.unitScale, (a.Z ?? this.p.z) * this.unitScale],
        };
        delete a.X; delete a.Y; delete a.Z;
        break;
      }
      case 52:
        this.rotComp = true;
        break;
      case 53:
        this.lenComp = null;
        break;
      case 54:
      case 55:
      case 56:
      case 57:
      case 58: {
        const h = Math.round(a.H ?? this.lenOffsetNo ?? this.tool);
        if (!this.cfg.tools[h]) this.warn(`G${g} H${h}: ingen verktygsdata för H${h}`);
        else if (this.tool && h !== this.tool) this.warn(`G${g} H${h} används med verktyg T${this.tool} – kontrollera korrektionsnumret`);
        this.lenComp = { g, h };
        delete a.H;
        break;
      }
      case 62: {
        let any = false;
        ['X', 'Y', 'Z'].forEach((ax, i) => {
          if (a[ax] !== undefined) {
            this.mirror[i] = a[ax] * this.unitScale;
            any = true;
            delete a[ax];
          }
        });
        if (!any) this.warn('G62 utan axelvärde (t.ex. G62 X0) – spegling ej aktiverad');
        break;
      }
      case 90:
        this.abs = true;
        break;
      case 91:
        this.abs = false;
        break;
      case 92: {
        const cur = this.worldOf(this.p.x, this.p.y, this.p.z);
        const off = this.totalOffset();
        const want = {
          x: a.X !== undefined ? a.X * this.unitScale : this.p.x,
          y: a.Y !== undefined ? a.Y * this.unitScale : this.p.y,
          z: a.Z !== undefined ? a.Z * this.unitScale : this.p.z,
        };
        const curProg = this.lathe ? [cur[0] * 2, 0, cur[2]] : cur;
        this.shift[0] += curProg[0] - off[0] - want.x;
        this.shift[1] += curProg[1] - off[1] - want.y;
        this.shift[2] += curProg[2] - off[2] - want.z;
        this.p = want;
        delete a.X; delete a.Y; delete a.Z;
        break;
      }
      case 94:
        this.feedMode = 94;
        break;
      case 95:
        this.feedMode = 95;
        break;
      case 96:
      case 110:
      case 111:
        if (isLatheOnly()) break;
        this.css = true;
        break;
      case 97:
        if (isLatheOnly()) break;
        this.css = false;
        if (this.spindle) this.spindleEvent();
        break;
      case 98:
      case 99:
        this.retract = g;
        break;
      case 116:
        if (a.T === undefined && a.TG === undefined) this.alarm('G116 kräver verktygsnummer (T)');
        if (a.T !== undefined) {
          this.loadTool(this.toolNo(a.T));
          delete a.T;
        }
        break;
      case 75:
        if (!L) {
          this.warn('G75 (fas) är en svarvkod och ignoreras i fräsläge');
          break;
        }
        this.cornerMode = (a.C ?? 0) > 0 ? { type: 'C', size: a.C * this.unitScale } : null;
        delete a.C;
        break;
      case 76:
        if (L) {
          this.cornerMode = (a.R ?? 0) > 0 ? { type: 'R', size: a.R * this.unitScale } : null;
          delete a.R;
        } else actions.push(76);
        break;
      case 80:
        this.cycle = null;
        break;
      // ---- motion-like codes handled in motionPhase
      case 31:
      case 32:
      case 33:
      case 71:
      case 72:
      case 73:
      case 74:
      case 77:
      case 78:
      case 88:
      case 178:
      case 179:
      case 181: case 182: case 183: case 184: case 185: case 186: case 187: case 188: case 189:
      case 190:
      case 81: case 82: case 83: case 84: case 85: case 86: case 87: case 89:
        actions.push(g);
        break;
      default:
        this.warn(`G${g} stöds inte av simulatorn`);
    }
  }

  // ---------------------------------------------------------------- M codes
  doM(m, w, post) {
    switch (m) {
      case 3:
      case 4:
        if (!this.S && !this.css) this.warn(`M0${m} utan varvtal (S0)`);
        this.spindle = m;
        this.spindleEvent();
        break;
      case 5:
        post.push(5);
        break;
      case 6:
      case 321:
        if (this.lathe) {
          if (w.a.T === undefined && !this.tool) this.warn('M06 utan verktyg');
        } else {
          const n = w.a.T !== undefined ? this.toolNo(w.a.T) : this.preTool;
          if (!n) this.alarm('M06 utan förvalt verktyg (T eller MT=)');
          this.loadTool(n);
        }
        break;
      case 0:
      case 1:
      case 2:
      case 30:
      case 9:
        post.push(m);
        break;
      case 8:
      case 120:
      case 339:
        this.coolant = true;
        this.event('coolant', { on: true, m });
        break;
      case 15:
      case 16:
      case 115:
      case 116:
      case 403:
      case 404:
        this.rotDir[m] = true;
        this.event('info', { text: `M${m}: rotationsaxel (ej materialsimulering)` });
        break;
      case 40:
        this.event('info', { text: 'M40: spindelområde' });
        break;
      case 52:
      case 53:
      case 54:
        post.push(m);
        break;
      case 60:
        this.event('pallet');
        break;
      default:
        if (AIR_M.has(m)) {
          this.event('air', { m });
          break;
        }
        this.warn(`M${m} stöds inte av simulatorn`);
    }
  }
  doPostM(m) {
    switch (m) {
      case 5:
        this.spindle = 0;
        this.spindleEvent();
        return false;
      case 9:
        this.coolant = false;
        this.event('coolant', { on: false, m: 9 });
        return false;
      case 0:
        this.event('stop', { optional: false, m: 0 });
        return false;
      case 1:
        this.event('stop', { optional: true, m: 1 });
        return false;
      case 2:
      case 30:
        this.flushAll();
        return true;
      case 52:
      case 53:
      case 54:
        this.returnRef({}, `M${m}`, true);
        return false;
    }
    return false;
  }

  flushAll() {
    this.corner.flush();
    if (this.comp.active) {
      this.comp.flush();
      this.compG = 40;
    }
  }

  // ---------------------------------------------------------------- dwell
  dwell(a) {
    let sec = 0;
    if (a.F !== undefined) sec = a.F;
    else if (a.X !== undefined) sec = a.X;
    else if (a.U !== undefined) sec = a.U;
    else if (a.P !== undefined) sec = a.P / 1000;
    this.dwellStep(sec);
  }
  dwellStep(sec) {
    if (sec > 0) this.pushStep({ k: 'd', dur: sec, ln: this.curLn });
  }

  returnRef(a, label, force = false) {
    this.flushAll();
    const via = ['X', 'Y', 'Z', 'U', 'W'].some((k) => a[k] !== undefined);
    if (via && !force) this.motionLine({ a, g: [], corner: null }, true);
    const h = this.home;
    const hp = this.progFromWorld(h);
    if (this.lathe) {
      this.goto(hp.x, 0, this.p.z, true);
      this.goto(hp.x, 0, hp.z, true);
    } else {
      this.goto(this.p.x, this.p.y, hp.z, true);
      this.goto(hp.x, hp.y, hp.z, true);
    }
    void label;
  }

  // ----------------------------------------------------------- motion phase
  hasAxisWords(a) {
    return ['X', 'Y', 'Z', 'U', 'W'].some((k) => a[k] !== undefined);
  }

  motionPhase(w, actions) {
    const a = w.a;
    // rotary axes: tracked only
    for (const r of ['A', 'B', 'C']) {
      if (a[r] !== undefined) this.rot[r.toLowerCase()] = this.abs ? a[r] : this.rot[r.toLowerCase()] + a[r];
    }
    const spec = actions.find((g) => g >= 31 && g !== 116 && g !== 30 && g !== 4);
    if (spec !== undefined) {
      this.flushAll();
      this.runSpecial(spec, w);
      return;
    }
    if (actions.includes(4) || actions.includes(30)) return;
    if (this.cycle && this.hasAxisWords(a)) {
      this.flushAll();
      this.runSpecial(this.cycle.g, w, true);
      return;
    }
    if (!this.hasAxisWords(a)) return;
    if (this.modalMotion === 2 || this.modalMotion === 3) this.motionArc(w, this.modalMotion === 2);
    else this.motionLine(w, this.modalMotion === 0);
  }

  targetFrom(a) {
    const u = this.unitScale;
    const cur = this.p;
    const t = { x: cur.x, y: cur.y, z: cur.z };
    const val = (c, v) => (this.abs ? v * u : c + v * u);
    if (a.X !== undefined) t.x = val(cur.x, a.X);
    if (a.Y !== undefined) t.y = val(cur.y, a.Y);
    if (a.Z !== undefined) t.z = val(cur.z, a.Z);
    if (a.U !== undefined) t.x = cur.x + a.U * u;
    if (a.W !== undefined) t.z = cur.z + a.W * u;
    return t;
  }

  mkPrim(extra) {
    return { seq: this.newSeq(), plane: this.plane, ln: this.curLn, rapid: false, ...extra };
  }

  motionLine(w, rapid) {
    const t = this.targetFrom(w.a);
    const a = this.worldOf(this.p.x, this.p.y, this.p.z);
    const b = this.worldOf(t.x, t.y, t.z);
    const prim = this.mkPrim({ type: 'line', a, b, rapid });
    if (!rapid && this.cornerMode) prim.corner = this.cornerMode;
    if (w.corner && !rapid) prim.corner = w.corner;
    this.p = t;
    this.corner.push(prim);
  }

  motionArc(w, cw) {
    const a = w.a;
    const t = this.targetFrom(a);
    const s0 = this.worldOf(this.p.x, this.p.y, this.p.z);
    const s1 = this.worldOf(t.x, t.y, t.z);
    const ax = planeAxes(this.plane);
    const [iu, iv] = ax;
    const mirrored = (this.mirror[iu] !== null) !== (this.mirror[iv] !== null);
    const cwEff = mirrored ? !cw : cw;
    let c;
    if (a.R !== undefined) {
      const R = a.R * this.unitScale * (this.scale.on ? this.scale.k : 1);
      c = centerFromRadius(s0[iu], s0[iv], s1[iu], s1[iv], R, cwEff);
      if (!c) this.alarm(`Båg: radien R${a.R} är för liten för start–slut-avståndet`);
    } else {
      const off = [0, 0, 0];
      if (a.I !== undefined) off[0] = a.I * this.unitScale * this.axisFactor(0, true);
      if (a.J !== undefined) off[1] = a.J * this.unitScale * this.axisFactor(1, true);
      if (a.K !== undefined) off[2] = a.K * this.unitScale * this.axisFactor(2, true);
      if (a.I === undefined && a.J === undefined && a.K === undefined) this.alarm('Båg saknar centrum (I/J/K) eller radie (R)');
      c = [s0[iu] + off[iu], s0[iv] + off[iv]];
    }
    const R0 = Math.hypot(s0[iu] - c[0], s0[iv] - c[1]);
    const R1 = Math.hypot(s1[iu] - c[0], s1[iv] - c[1]);
    if (Math.abs(R0 - R1) > Math.max(0.02, R0 * 0.001)) this.warn(`Bågens start- och slutradie skiljer ${Math.abs(R0 - R1).toFixed(3)} mm`);
    if (R0 < EPS) this.alarm('Båge med radie 0');
    const prim = this.mkPrim({ type: 'arc', a: s0, b: s1, c, cw: cwEff });
    this.p = t;
    this.corner.push(prim);
  }

  // Pipeline: corner stage -> compensation stage -> emitter
  afterCorner(prim) {
    if (this.capturing) {
      this.emitPrimFinal({ ...prim, raw: true });
      return;
    }
    if (this.comp.state === 'off') this.emitPrimFinal({ ...prim, raw: true });
    else this.comp.push(prim);
  }

  // Direct (cycle) move in programmer coordinates, bypassing compensation
  goto(px, py, pz, rapid, extra = {}) {
    const b = this.worldOf(px, py, pz);
    const prim = this.mkPrim({ type: 'line', a: null, b, rapid, raw: true, ...extra });
    this.p = { x: px, y: py, z: pz };
    this.emitPrimFinal(prim);
  }

  emitPrimFinal(prim) {
    if (prim.raw && this.lathe && this.toolRec) {
      const [vz, vx] = tipToCenter(this.toolRec);
      if (vz || vx) {
        prim = { ...prim, a: prim.a && prim.a.slice(), b: prim.b.slice(), c: prim.c && prim.c.slice() };
        if (prim.a) { prim.a[0] += vx; prim.a[2] += vz; }
        prim.b[0] += vx;
        prim.b[2] += vz;
        if (prim.c) { prim.c[0] += vz; prim.c[1] += vx; }
      }
    }
    if (prim.type === 'line') {
      this.addLinear(this.toolPos.slice(), prim.b, prim);
    } else {
      const ax = planeAxes(prim.plane);
      const gap = Math.hypot(this.toolPos[ax[0]] - prim.a[ax[0]], this.toolPos[ax[1]] - prim.a[ax[1]]);
      if (gap > 1e-4) this.addLinear(this.toolPos.slice(), prim.a, prim);
      let cur = prim.a.slice();
      for (const p of linearizeArc(prim)) {
        this.addLinear(cur, p, prim);
        cur = p;
      }
    }
    if (prim.seq !== undefined) this.maxEmitted = Math.max(this.maxEmitted, prim.seq);
    this.drain();
  }

  addLinear(a, b, prim) {
    const len = dist3(a, b);
    this.toolPos = b.slice();
    if (len < 1e-9) return;
    let f;
    let rapid = !!prim.rapid;
    const dia = this.lathe ? a[0] + b[0] - (this.toolRec ? 2 * tipToCenter(this.toolRec)[1] : 0) : 0;
    const rpm = this.curRpm(dia);
    this.lastDia = dia || this.lastDia;
    if (rapid) f = this.cfg.rapid || 30000;
    else if (prim.pitch) {
      if (!rpm) this.alarm('Gängskärning utan spindel (M03/M04 och S)', prim.ln);
      f = prim.pitch * rpm;
    } else if (this.feedMode === 95) {
      if (!rpm) this.alarm('Matning per varv (G95) kräver att spindeln går (M03/M04, S)', prim.ln);
      f = this.F * rpm;
    } else f = this.F;
    if (!rapid && !(f > 0)) this.alarm('Ingen matning programmerad (F saknas eller F0)', prim.ln);
    const step = {
      k: 'm',
      rapid,
      a: a.slice(),
      b,
      len,
      f,
      dur: (len / f) * 60,
      ln: prim.ln,
      rpm,
    };
    if (prim.pitch) step.pitch = prim.pitch;
    if (prim.nocut) step.nocut = true;
    if (rapid) this.stats.rapidLen += len;
    else this.stats.feedLen += len;
    this.updateBBox(b);
    this.commit(step);
  }

  updateBBox(p) {
    const bb = this.stats.bbox;
    if (!bb) this.stats.bbox = { min: p.slice(), max: p.slice() };
    else
      for (let i = 0; i < 3; i++) {
        if (p[i] < bb.min[i]) bb.min[i] = p[i];
        if (p[i] > bb.max[i]) bb.max[i] = p[i];
      }
  }

  // ---------------------------------------------------- canned / special G
  param(key, w, remember = false) {
    const v = w.a[key];
    if (this.cycle && remember) {
      if (v !== undefined) this.cycle[key] = v * (['P', 'Q'].includes(key) ? 1 : this.unitScale);
      return this.cycle[key];
    }
    return v === undefined ? undefined : v * this.unitScale;
  }

  runSpecial(g, w, modalRepeat = false) {
    const L = this.lathe;
    const bad = (needLathe) => {
      this.warn(`G${g} är en ${needLathe ? 'svarv' : 'fräs'}kod och ignoreras i ${L ? 'svarv' : 'fräs'}läge`);
    };
    switch (g) {
      case 31:
      case 32:
      case 33:
        return L ? this.threadSingle(w) : bad(true);
      case 71:
        return L ? this.roughCycle(w, 'z') : bad(true);
      case 72:
        return L ? this.roughCycle(w, 'x') : bad(true);
      case 77:
      case 178:
      case 190:
        return L ? this.turnCycle(g, w, modalRepeat, 'z') : bad(true);
      case 78:
      case 179:
        return L ? this.turnCycle(g, w, modalRepeat, 'x') : bad(true);
      case 88:
      case 185:
      case 186:
      case 187:
      case 188:
        return L ? this.threadCycle(w) : bad(true);
      case 73:
        return L ? this.grooveCycle(w, 'radial') : this.holeCycle(73, w, modalRepeat);
      case 74:
        return L ? this.grooveCycle(w, 'axial') : this.holeCycle(74, w, modalRepeat);
      case 181:
      case 182:
      case 183:
      case 184:
      case 189:
        return L ? this.holeCycle(g - 100, w, modalRepeat) : bad(true);
      case 76:
        return L ? undefined : this.holeCycle(76, w, modalRepeat);
      case 81: case 82: case 83: case 84: case 85: case 86: case 87: case 89:
        return L ? this.holeCycle(g, w, modalRepeat) : this.holeCycle(g, w, modalRepeat);
    }
  }

  dwellFromWord(w) {
    if (w.a.P !== undefined) return w.a.P / 1000;
    if (w.a.D !== undefined) return w.a.D;
    return this.cycle?.dwell ?? 0;
  }

  // ---- hole cycles (mill and lathe, axis Z) ---------------------------------
  holeCycle(g, w, repeat) {
    const a = w.a;
    const u = this.unitScale;
    const prev = this.cycle;
    if (!prev || prev.g !== g) {
      // Changing cycle code keeps the stored Z/R/Q/P data (cleared only by G80 or G00-G03)
      this.cycle = { g, z: prev?.z, r: prev?.r, q: prev?.q, dwell: prev?.dwell ?? 0 };
    }
    const c = this.cycle;
    if (a.Z !== undefined) c.z = a.Z * u;
    if (a.R !== undefined) c.r = a.R * u;
    if (a.Q !== undefined) c.q = a.Q * u;
    else if (a.K !== undefined && (g === 83 || g === 73)) c.q = a.K * u;
    if (a.P !== undefined || a.D !== undefined) c.dwell = this.dwellFromWord(w);
    if (a.F !== undefined) this.F = a.F * u;
    if (c.z === undefined) this.alarm(`G${g}: Z (håldjup) saknas`);
    if (c.r === undefined) this.alarm(`G${g}: R (retardationsplan) saknas`);

    const inc = !this.abs;
    const zi = this.p.z;
    const t = this.targetFrom({ X: a.X, Y: a.Y, U: a.U });
    const zr = inc ? zi + c.r : c.r;
    const zb = inc ? zr + c.z : c.z;
    if (g !== 87 && zb >= zr - EPS) this.alarm(`G${g}: håldjupet Z måste ligga under R-planet`);
    this.goto(t.x, this.lathe ? 0 : t.y, zi, true);
    if (Math.abs(zr - zi) > EPS) this.goto(t.x, this.lathe ? 0 : t.y, zr, true);
    const X = t.x, Y = this.lathe ? 0 : t.y;
    const clr = 0.5;
    switch (g) {
      case 81:
        this.goto(X, Y, zb, false);
        break;
      case 82:
        this.goto(X, Y, zb, false);
        this.dwellStep(c.dwell);
        break;
      case 83:
      case 73: {
        const q = c.q;
        if (!q || q <= 0) this.alarm(`G${g}: stickdjup Q saknas`);
        let z = zr;
        for (let guard = 0; guard < 2000; guard++) {
          const next = Math.max(zb, z - q);
          this.goto(X, Y, next, false);
          if (next <= zb + EPS) break;
          if (g === 83) {
            this.goto(X, Y, zr, true);
            this.goto(X, Y, next + clr, true);
          } else this.goto(X, Y, next + 1, true);
          z = next;
        }
        break;
      }
      case 84:
      case 74:
        this.goto(X, Y, zb, false);
        this.dwellStep(c.dwell);
        this.event('spindle', { dir: this.spindle === 3 ? 4 : 3, rpm: this.curRpm(), css: false });
        this.goto(X, Y, zr, false);
        this.event('spindle', { dir: this.spindle, rpm: this.curRpm() });
        break;
      case 85:
        this.goto(X, Y, zb, false);
        this.goto(X, Y, zr, false);
        break;
      case 86:
        this.goto(X, Y, zb, false);
        this.event('spindle', { dir: 0, rpm: 0 });
        this.goto(X, Y, zr, true);
        this.event('spindle', { dir: this.spindle, rpm: this.curRpm() });
        break;
      case 89:
        this.goto(X, Y, zb, false);
        this.dwellStep(c.dwell);
        this.goto(X, Y, zr, false);
        break;
      case 76: {
        this.goto(X, Y, zb, false);
        this.dwellStep(c.dwell);
        const q = c.q || 0.3;
        this.goto(X + (this.lathe ? 2 * q : q), Y, zb, true, { nocut: true });
        break;
      }
      case 87: {
        // Back boring: rapid to the far side, feed back up (no material model for upward cuts)
        const q = c.q || 0.5;
        this.goto(X + (this.lathe ? 2 * q : q), Y, zr, true);
        this.goto(X + (this.lathe ? 2 * q : q), Y, zb, true, { nocut: true });
        this.goto(X, Y, zb, true, { nocut: true });
        this.goto(X, Y, zr, false, { nocut: true });
        this.warn('G87 (bakåtborrning) simuleras bara som rörelse – uppåtgående skär tas inte bort i materialmodellen');
        break;
      }
    }
    const back = this.retract === 98 ? Math.max(zi, zr) : zr;
    this.goto(X, Y, back, true);
    if (this.lathe) this.p.x = X;
  }

  // ---- lathe: G77/G78 fixed turning / facing cycle ---------------------------
  turnCycle(g, w, repeat, kind) {
    const a = w.a;
    const u = this.unitScale;
    if (!repeat || !this.cycle || this.cycle.g !== g) this.cycle = { g, z: undefined, taper: 0, r: 0 };
    const c = this.cycle;
    if (a.Z !== undefined || a.W !== undefined) c.zAbs = a.Z !== undefined ? a.Z * u : this.p.z + a.W * u;
    if (a.R !== undefined) c.taper = a.R * u;
    if (a.F !== undefined) this.F = a.F * u;
    const t = this.targetFrom({ X: a.X, U: a.U });
    const xs = this.p.x;
    const zs = this.p.z;
    const zt = c.zAbs ?? zs;
    const xt = t.x;
    if (kind === 'z') {
      // A->B rapid X, B->C feed (taper), C->D feed X back, D->A rapid Z
      this.goto(xt, 0, zs, true);
      this.goto(xt + 2 * c.taper, 0, zt, false);
      this.goto(xs, 0, zt, false);
      this.goto(xs, 0, zs, true);
    } else {
      this.goto(xs, 0, zt, true);
      this.goto(xt, 0, zt + (c.taper || 0), false);
      this.goto(xt, 0, zs, false);
      this.goto(xs, 0, zs, true);
    }
  }

  // ---- lathe: capture profile blocks (P..Q) -----------------------------------
  captureProfile(pSeq, qSeq) {
    const frame = this.frames[this.frames.length - 1];
    const i0 = this.findLabel(frame.prog, pSeq);
    const i1 = this.findLabel(frame.prog, qSeq);
    if (i0 < 0) this.alarm(`Profilstart N${pSeq} hittades inte`);
    if (i1 < 0 || i1 < i0) this.alarm(`Profilslut N${qSeq} hittades inte`);
    const save = {
      p: { ...this.p }, abs: this.abs, unit: this.unitScale, plane: this.plane, motion: this.modalMotion,
      cycle: this.cycle, F: this.F, feed: this.feedMode, tp: this.toolPos.slice(), curLn: this.curLn,
      comp: this.compG, corner: this.cornerMode,
    };
    const pts = [];
    this.capturing = pts;
    const origEmit = this.emitPrimFinal;
    this.emitPrimFinal = (prim) => {
      if (prim.type === 'line') pts.push([prim.b[2], prim.b[0]]);
      else for (const q of linearizeArc(prim)) pts.push([q[2], q[0]]);
      this.toolPos = prim.b.slice();
    };
    try {
      this.cycle = null;
      for (let i = i0; i <= i1; i++) {
        const b = this.blocks[i];
        if (b.stmt || b.header) continue;
        this.curLn = b.i;
        if (b.err) this.alarm(b.err, b.i);
        const words = this.collectWords(b);
        words.g = words.g.filter((g) => !(g >= 40 && g <= 42) && g !== 4);
        this.executeWordsCapture(words);
      }
      this.corner.flush();
    } finally {
      this.emitPrimFinal = origEmit;
      this.capturing = null;
      this.p = save.p; this.abs = save.abs; this.unitScale = save.unit; this.plane = save.plane;
      this.modalMotion = save.motion; this.cycle = save.cycle; this.F = save.F; this.feedMode = save.feed;
      this.toolPos = save.tp; this.curLn = save.curLn; this.compG = save.comp; this.cornerMode = save.corner;
    }
    return pts;
  }
  executeWordsCapture(w) {
    const actions = [];
    for (const g of w.g) {
      if ([0, 1, 2, 3, 17, 18, 19, 20, 21, 90, 91, 94, 95].includes(g)) this.doG(g, w, actions);
    }
    if (w.a.F !== undefined) this.F = w.a.F * this.unitScale;
    if (this.hasAxisWords(w.a)) {
      if (this.modalMotion === 2 || this.modalMotion === 3) this.motionArc(w, this.modalMotion === 2);
      else this.motionLine(w, this.modalMotion === 0);
    }
  }

  // ---- lathe: G71 / G72 roughing cycles (type I: monotonic profile) --------------
  roughCycle(w, dir) {
    const a = w.a;
    const u = this.unitScale;
    if (a.P === undefined || a.Q === undefined) {
      // First block of the two-block form: G71 U<depth> R<retract>
      if (a.U === undefined && a.D === undefined) this.alarm(`G${dir === 'z' ? 71 : 72}: P/Q (profilblock) eller U (skärdjup) saknas`);
      if (a.U !== undefined) this.g71.depth = a.U * u;
      if (a.D !== undefined) this.g71.depth = a.D * u;
      if (a.R !== undefined) this.g71.retract = a.R * u;
      return;
    }
    if (a.D !== undefined) this.g71.depth = a.D * u;
    if (a.F !== undefined) this.F = a.F * u;
    const finU = (a.U ?? 0) * u; // finish allowance on diameter
    const finW = (a.W ?? 0) * u; // finish allowance along Z
    const depth = Math.max(0.05, this.g71.depth);
    const e = this.g71.retract ?? 0.5;

    const prof = this.captureProfile(a.P, a.Q); // [[z, r], ...] in programmed-tip coordinates
    if (prof.length < 2) this.alarm('Profilen mellan P och Q innehåller inga rörelser');
    const startProg = { ...this.p };
    const start = this.worldOf(startProg.x, 0, startProg.z);
    const rs = start[0];
    const zs = start[2];

    const od = prof[0][1] <= rs + 1e-6; // cutting inwards from the start radius
    const sgn = od ? -1 : 1; // radial cutting direction
    const sz = Math.sign(prof[prof.length - 1][0] - zs) || -1; // axial cutting direction
    // Profile offset by the finish allowance (material is left outside/inside the contour)
    const prof2 = prof.map(([z, r]) => [z - sz * finW, r - sgn * (finU / 2)]);
    const rExtreme = od ? Math.min(...prof2.map((p) => p[1])) : Math.max(...prof2.map((p) => p[1]));
    const to = (r, z, rapid, extra) => this.goto(r * 2, 0, z, rapid, extra);

    if (dir === 'z') {
      const levels = [];
      for (let r = rs + sgn * depth; sgn * (rExtreme - r) > 1e-6; r += sgn * depth) levels.push(r);
      if (sgn * (rExtreme - rs) > 1e-6) levels.push(rExtreme);
      // z where the offset profile first reaches radius `level`
      const hitZ = (level) => {
        if (sgn * (prof2[0][1] - level) <= 0) return prof2[0][0];
        for (let i = 1; i < prof2.length; i++) {
          const [z0, r0] = prof2[i - 1];
          const [z1, r1] = prof2[i];
          if (sgn * (r0 - level) > 0 && sgn * (r1 - level) <= 0) {
            const t = (level - r0) / (r1 - r0 || 1);
            return z0 + (z1 - z0) * t;
          }
        }
        return prof2[prof2.length - 1][0];
      };
      for (const r of levels) {
        const zh = hitZ(r);
        if (sz * (zh - zs) <= 1e-6) continue;
        to(r, zs, true);
        to(r, zh, false);
        to(r - sgn * e, zh - sz * e, true);
        to(r - sgn * e, zs, true);
      }
    } else {
      const zEnd = prof2[prof2.length - 1][0];
      const levels = [];
      for (let z = zs + sz * depth; sz * (zEnd - z) > 1e-6; z += sz * depth) levels.push(z);
      levels.push(zEnd);
      const hitR = (z) => {
        for (let i = 1; i < prof2.length; i++) {
          const [z0, r0] = prof2[i - 1];
          const [z1, r1] = prof2[i];
          if (sz * (z0 - z) <= 0 && sz * (z1 - z) >= 0 && z1 !== z0) return r0 + (r1 - r0) * ((z - z0) / (z1 - z0));
        }
        return prof2[prof2.length - 1][1];
      };
      for (const z of levels) {
        const rh = hitR(z);
        if (sgn * (rs - rh) >= 0) continue;
        to(rs, z, true);
        to(rh, z, false);
        to(rh - sgn * e, z - sz * e, true);
        to(rs, z - sz * e, true);
      }
    }
    // semi-finish pass along the offset profile, then back to the start point
    to(prof2[0][1], zs, true);
    for (const [z, r] of prof2) to(r, z, false);
    to(rs, prof2[prof2.length - 1][0], true);
    to(rs, zs, true);
    this.p = { x: startProg.x, y: 0, z: startProg.z };
  }

  // ---- lathe: grooving cycles ---------------------------------------------
  grooveCycle(w, kind) {
    const a = w.a;
    const u = this.unitScale;
    if (a.F !== undefined) this.F = a.F * u;
    const tool = this.toolRec || {};
    const width = tool.width || 3;
    const xs = this.p.x;
    const zs = this.p.z;
    const retr = (a.D ?? 0.5) * u;
    if (kind === 'radial') {
      const t = this.targetFrom({ X: a.X, Z: a.Z, U: a.U, W: a.W });
      const z1 = t.z;
      const z2 = a.Q !== undefined ? a.Q * u : z1;
      const peck = a.I !== undefined ? a.I * u : null;
      const step = a.K !== undefined ? a.K * u : width * 0.8;
      const n = Math.max(1, Math.ceil(Math.abs(z2 - z1) / step));
      const rb = t.x / 2;
      for (let j = 0; j <= n; j++) {
        const z = n === 0 ? z1 : z1 + ((z2 - z1) * j) / n;
        this.goto(xs, 0, z, true);
        let r = xs / 2;
        for (let guard = 0; guard < 1000; guard++) {
          const next = peck ? Math.max(rb, r - peck) : rb;
          this.goto(next * 2, 0, z, false);
          if (next <= rb + EPS) break;
          this.goto((next + retr) * 2, 0, z, true);
          this.goto(next * 2, 0, z, true);
          r = next;
        }
        if (a.P !== undefined) this.dwellStep(a.P / 1000);
        this.goto(xs, 0, z, true);
      }
      this.goto(xs, 0, zs, true);
    } else {
      const t = this.targetFrom({ X: a.X, Z: a.Z, U: a.U, W: a.W });
      const peck = (a.K ?? a.Q ?? 0) * u || 0;
      const xEnd = a.X !== undefined ? t.x : xs;
      const step = a.I !== undefined ? a.I * u : tool.width || 3;
      const nx = xEnd === xs ? 0 : Math.max(1, Math.ceil(Math.abs(xEnd - xs) / 2 / step));
      for (let j = 0; j <= nx; j++) {
        const x = nx ? xs + ((xEnd - xs) * j) / nx : xs;
        this.goto(x, 0, zs, true);
        let z = zs;
        for (let guard = 0; guard < 2000; guard++) {
          const next = peck ? Math.max(t.z, z - peck) : t.z;
          this.goto(x, 0, next, false);
          if (next <= t.z + EPS) break;
          this.goto(x, 0, next + retr, true);
          this.goto(x, 0, next, true);
          z = next;
        }
        this.goto(x, 0, zs, true);
      }
      this.goto(xs, 0, zs, true);
    }
  }

  // ---- lathe: threading -----------------------------------------------------
  threadSingle(w) {
    const a = w.a;
    const u = this.unitScale;
    const pitch = (a.F ?? a.E ?? 0) * u;
    if (!(pitch > 0)) this.alarm('Gängstigning (F/E) saknas för gängskärning');
    const t = this.targetFrom(a);
    this.goto(t.x, 0, t.z, false, { pitch });
  }

  threadCycle(w) {
    const a = w.a;
    const u = this.unitScale;
    const pitch = (a.F ?? a.E ?? 0) * u;
    if (!(pitch > 0)) this.alarm('Gängstigning (F/E) saknas för gängcykeln');
    const xs = this.p.x;
    const zs = this.p.z;
    const t = this.targetFrom({ X: a.X, Z: a.Z, U: a.U, W: a.W });
    const od = t.x < xs;
    const depthR = a.D !== undefined ? Math.abs(a.D * u) : Math.abs(xs - t.x) / 2;
    const taper = (a.R ?? 0) * u;
    const passes = a.Q !== undefined ? Math.max(1, Math.round(a.Q)) : Math.max(4, Math.min(14, Math.ceil(depthR / 0.2)));
    const clear = 1.5;
    for (let i = 1; i <= passes; i++) {
      const d = depthR * Math.sqrt(i / passes);
      const x = od ? xs - 2 * d : xs + 2 * d;
      const xEnd = x + 2 * taper;
      this.goto(x, 0, zs, true);
      this.goto(xEnd, 0, t.z, false, { pitch });
      this.goto((od ? xs + 2 * clear : xs - 2 * clear) + 2 * taper, 0, t.z, true, { nocut: true });
      this.goto((od ? xs + 2 * clear : xs - 2 * clear), 0, zs, true);
    }
    this.goto(xs, 0, zs, true);
  }
}
