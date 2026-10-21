// Okuma OSP block lexer / parser.
// Turns program text into blocks of address words, statements (CALL, IF, GOTO,
// RTS, variable assignment) and expression trees (Okuma "User Task" syntax).

export class ParseError extends Error {}

const STMT_WORDS = new Set(['CALL', 'RTS', 'IF', 'GOTO', 'WHILE', 'END']);
const EQ_ADDRS = new Set(['MT', 'TG', 'TL', 'SB']);
const SYS_VARS = new Set(['PX', 'PY', 'PZ', 'VACOD', 'VATOL', 'VINS', 'VTLCN', 'VZSHX', 'VZSHY', 'VZSHZ', 'VTOFD']);
const BIN_WORDS = new Set(['AND', 'OR', 'XOR', 'MOD', 'EQ', 'NE', 'GT', 'LT', 'GE', 'LE']);
const D2R = Math.PI / 180;

export const FUNCS = {
  SIN: (a) => Math.sin(a[0] * D2R),
  COS: (a) => Math.cos(a[0] * D2R),
  TAN: (a) => Math.tan(a[0] * D2R),
  ATAN: (a) => Math.atan(a[0]) / D2R,
  ATAN2: (a) => Math.atan2(a[0], a[1]) / D2R,
  ABS: (a) => Math.abs(a[0]),
  SQRT: (a) => {
    if (a[0] < 0) throw new Error('SQRT av negativt tal');
    return Math.sqrt(a[0]);
  },
  ASIN: (a) => {
    if (Math.abs(a[0]) > 1) throw new Error('ASIN utanför −1…1');
    return Math.asin(a[0]) / D2R;
  },
  ACOS: (a) => {
    if (Math.abs(a[0]) > 1) throw new Error('ACOS utanför −1…1');
    return Math.acos(a[0]) / D2R;
  },
  LN: (a) => {
    if (a[0] <= 0) throw new Error('LN av tal ≤ 0');
    return Math.log(a[0]);
  },
  LOG: (a) => {
    if (a[0] <= 0) throw new Error('LOG av tal ≤ 0');
    return Math.log10(a[0]);
  },
  EXP: (a) => Math.exp(a[0]),
  POW: (a) => Math.pow(a[0], a[1]),
  MIN: (a) => Math.min(...a),
  MAX: (a) => Math.max(...a),
  SIGN: (a) => Math.sign(a[0]),
  FIX: (a) => Math.trunc(a[0]),
  DFIX: (a) => Math.trunc(a[0]),
  FUP: (a) => Math.sign(a[0]) * Math.ceil(Math.abs(a[0])),
  DFUP: (a) => Math.sign(a[0]) * Math.ceil(Math.abs(a[0])),
  ROUND: (a) => Math.sign(a[0]) * Math.round(Math.abs(a[0])),
  DROUND: (a) => Math.sign(a[0]) * Math.round(Math.abs(a[0])),
};

class Scanner {
  constructor(s) {
    this.s = s;
    this.p = 0;
  }
  ws() {
    while (this.p < this.s.length && /\s/.test(this.s[this.p])) this.p++;
  }
  eof() {
    this.ws();
    return this.p >= this.s.length;
  }
  peek() {
    this.ws();
    return this.s[this.p];
  }
  run() {
    const m = /^[A-Z]+/.exec(this.s.slice(this.p));
    return m ? m[0] : '';
  }
  number() {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(this.s.slice(this.p));
    if (!m) return null;
    this.p += m[0].length;
    return parseFloat(m[0]);
  }

  // ---- expressions -------------------------------------------------------
  expr() {
    return this.orExpr();
  }
  binWord() {
    this.ws();
    const r = this.run();
    return BIN_WORDS.has(r) ? r : null;
  }
  orExpr() {
    let l = this.xorExpr();
    while (this.binWord() === 'OR') {
      this.p += 2;
      l = { t: 'bin', op: 'OR', l, r: this.xorExpr() };
    }
    return l;
  }
  xorExpr() {
    let l = this.andExpr();
    while (this.binWord() === 'XOR') {
      this.p += 3;
      l = { t: 'bin', op: 'XOR', l, r: this.andExpr() };
    }
    return l;
  }
  andExpr() {
    let l = this.cmpExpr();
    while (this.binWord() === 'AND') {
      this.p += 3;
      l = { t: 'bin', op: 'AND', l, r: this.cmpExpr() };
    }
    return l;
  }
  cmpExpr() {
    let l = this.addExpr();
    const w = this.binWord();
    if (w && ['EQ', 'NE', 'GT', 'LT', 'GE', 'LE'].includes(w)) {
      this.p += 2;
      l = { t: 'bin', op: w, l, r: this.addExpr() };
    }
    return l;
  }
  addExpr() {
    let l = this.mulExpr();
    for (;;) {
      const c = this.peek();
      if (c === '+' || c === '-') {
        this.p++;
        l = { t: 'bin', op: c, l, r: this.mulExpr() };
      } else return l;
    }
  }
  mulExpr() {
    let l = this.powExpr();
    for (;;) {
      const c = this.peek();
      if (c === '*' || c === '/') {
        this.p++;
        l = { t: 'bin', op: c, l, r: this.powExpr() };
      } else if (this.binWord() === 'MOD') {
        this.p += 3;
        l = { t: 'bin', op: 'MOD', l, r: this.powExpr() };
      } else return l;
    }
  }
  powExpr() {
    const l = this.unary();
    if (this.peek() === '^') {
      this.p++;
      return { t: 'bin', op: '^', l, r: this.powExpr() };
    }
    return l;
  }
  unary() {
    const c = this.peek();
    if (c === '-') {
      this.p++;
      return { t: 'un', op: '-', e: this.unary() };
    }
    if (c === '+') {
      this.p++;
      return this.unary();
    }
    if (this.run() === 'NOT') {
      this.p += 3;
      return { t: 'un', op: 'NOT', e: this.unary() };
    }
    return this.primary();
  }
  expectChar(ch) {
    if (this.peek() !== ch) throw new ParseError(`Förväntade '${ch}'`);
    this.p++;
  }
  varIndex() {
    this.ws();
    if (this.s[this.p] === '[') {
      this.p++;
      const e = this.expr();
      this.expectChar(']');
      return e;
    }
    const n = this.number();
    if (n === null) throw new ParseError('Variabelnummer saknas');
    return { t: 'num', v: n };
  }
  primary() {
    const c = this.peek();
    if (c === undefined) throw new ParseError('Uttrycket är ofullständigt');
    if (c === '[') {
      this.p++;
      const e = this.expr();
      this.expectChar(']');
      return e;
    }
    if (/[\d.]/.test(c)) {
      const n = this.number();
      if (n === null) throw new ParseError(`Ogiltigt tal vid '${c}'`);
      return { t: 'num', v: n };
    }
    const r = this.run();
    if (!r) throw new ParseError(`Oväntat tecken '${c}' i uttryck`);
    if (r === 'PI') {
      this.p += 2;
      return { t: 'num', v: Math.PI };
    }
    if (r === 'VC' || r === 'V') {
      this.p += r.length;
      return { t: 'var', kind: r, idx: this.varIndex() };
    }
    if (SYS_VARS.has(r)) {
      this.p += r.length;
      if (r === 'VTOFD') {
        this.expectChar('[');
        const e = this.expr();
        this.expectChar(']');
        return { t: 'sys', name: r, arg: e };
      }
      return { t: 'sys', name: r };
    }
    if (r === 'ATAN' && this.s[this.p + 4] === '2') {
      this.p += 5;
      this.expectChar('[');
      const args = [this.expr()];
      while (this.peek() === ',') {
        this.p++;
        args.push(this.expr());
      }
      this.expectChar(']');
      return { t: 'fn', name: 'ATAN2', args };
    }
    if (FUNCS[r]) {
      this.p += r.length;
      this.expectChar('[');
      const args = [this.expr()];
      while (this.peek() === ',') {
        this.p++;
        args.push(this.expr());
      }
      this.expectChar(']');
      return { t: 'fn', name: r, args };
    }
    throw new ParseError(`Okänd symbol '${r}'`);
  }

  operatorFollows() {
    let q = this.p;
    while (q < this.s.length && /\s/.test(this.s[q])) q++;
    const c = this.s[q];
    if (c === undefined) return false;
    if ('+-*^'.includes(c)) return true;
    if (c === '/') return q + 1 < this.s.length;
    const m = /^[A-Z]+/.exec(this.s.slice(q));
    return !!m && BIN_WORDS.has(m[0]);
  }

  // ---- words -------------------------------------------------------------
  wordValue() {
    this.ws();
    const c = this.s[this.p];
    if (c === '=') {
      this.p++;
      return this.expr();
    }
    if (c === '[') {
      const start = this.p;
      this.p++;
      const e = this.expr();
      this.expectChar(']');
      if (this.operatorFollows()) {
        this.p = start;
        return this.expr();
      }
      return e;
    }
    const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(this.s.slice(this.p));
    if (!m) throw new ParseError('Värde saknas');
    const start = this.p;
    this.p += m[0].length;
    if (this.operatorFollows()) {
      // S300*3, X10+5, Z-2*VC1 ... a formula without = or [ ]
      this.p = start;
      return this.expr();
    }
    return parseFloat(m[0]);
  }
}

export function parseExpression(text) {
  const sc = new Scanner(text);
  const e = sc.expr();
  if (!sc.eof()) throw new ParseError('Överflödig text i uttryck');
  return e;
}

export function evalExpr(n, ctx) {
  if (typeof n === 'number') return n;
  switch (n.t) {
    case 'num':
      return n.v;
    case 'var':
      return ctx.getVar(n.kind, Math.round(evalExpr(n.idx, ctx)));
    case 'sys':
      return ctx.sys(n.name, n.arg ? evalExpr(n.arg, ctx) : undefined);
    case 'un': {
      const v = evalExpr(n.e, ctx);
      return n.op === '-' ? -v : v ? 0 : 1;
    }
    case 'fn':
      return FUNCS[n.name](n.args.map((a) => evalExpr(a, ctx)));
    case 'bin': {
      const a = evalExpr(n.l, ctx);
      const b = evalExpr(n.r, ctx);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '^': {
          const v = Math.pow(a, b);
          if (!isFinite(v)) throw new Error('Ogiltig potens');
          return v;
        }
        case '/':
          if (b === 0) throw new Error('Division med noll');
          return a / b;
        case 'MOD':
          if (b === 0) throw new Error('MOD med noll');
          return a % b;
        case 'AND': return a && b ? 1 : 0;
        case 'OR': return a || b ? 1 : 0;
        case 'XOR': return !a !== !b ? 1 : 0;
        case 'EQ': return Math.abs(a - b) < 1e-9 ? 1 : 0;
        case 'NE': return Math.abs(a - b) >= 1e-9 ? 1 : 0;
        case 'GT': return a > b ? 1 : 0;
        case 'LT': return a < b ? 1 : 0;
        case 'GE': return a >= b - 1e-9 ? 1 : 0;
        case 'LE': return a <= b + 1e-9 ? 1 : 0;
      }
    }
  }
  throw new Error('Ogiltigt uttryck');
}

// Strip (comments) and ;comments. Returns { code, comment }.
function splitComments(raw) {
  let depth = 0;
  let code = '';
  let comment = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (depth === 0 && c === ';') {
      comment += raw.slice(i + 1);
      break;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')' && depth > 0) {
      depth--;
      continue;
    }
    if (depth > 0) comment += c;
    else code += c;
  }
  return { code, comment: comment.trim() };
}

export function parseLine(raw, i) {
  const block = {
    i,
    raw,
    code: '',
    comment: '',
    skip: false,
    header: null,
    seq: null,
    words: [],
    stmt: null, // call | rts | goto | if
    assigns: [],
    err: null,
  };
  const { code, comment } = splitComments(raw.toUpperCase());
  block.comment = comment;
  let text = code.trim();
  if (text.startsWith('/')) {
    block.skip = true;
    text = text.replace(/^\/\d?/, '').trim();
  }
  if (text.startsWith('%')) text = text.slice(1).trim();
  block.code = text;
  if (!text) return block;
  try {
    const hm = /^O([A-Z0-9_]+)$/.exec(text);
    if (hm) {
      block.header = hm[1];
      return block;
    }
    const sc = new Scanner(text);
    while (!sc.eof()) {
      const c = sc.peek();
      if (c === ',') {
        sc.p++;
        const letter = sc.s[sc.p++];
        if (letter !== 'C' && letter !== 'R') throw new ParseError("Efter ',' förväntas C eller R");
        block.words.push({ a: ',' + letter, v: sc.wordValue() });
        continue;
      }
      if (c === '/') {
        sc.p++;
        continue;
      }
      if (!/[A-Z]/.test(c)) throw new ParseError(`Oväntat tecken '${c}'`);
      const run = sc.run();
      if (STMT_WORDS.has(run)) {
        sc.p += run.length;
        if (run === 'RTS') block.stmt = { type: 'rts' };
        else if (run === 'CALL') {
          sc.ws();
          const nm = /^O?([A-Z0-9_]+)/.exec(sc.s.slice(sc.p));
          if (!nm) throw new ParseError('CALL saknar programnamn');
          sc.p += nm[0].length;
          block.stmt = { type: 'call', name: nm[1] };
        } else if (run === 'GOTO') {
          sc.ws();
          const lm = /^N?(\d+)/.exec(sc.s.slice(sc.p));
          if (!lm) throw new ParseError('GOTO saknar sekvensnummer');
          sc.p += lm[0].length;
          block.stmt = { type: 'goto', label: parseInt(lm[1], 10) };
        } else if (run === 'WHILE') {
          const rest = sc.s.slice(sc.p);
          const dm = /DO\s*(\d+)\s*$/.exec(rest);
          if (!dm) throw new ParseError('WHILE saknar DO<nummer> (t.ex. WHILE [VC1 LT 5] DO1)');
          block.stmt = { type: 'while', cond: parseExpression(rest.slice(0, dm.index)), n: parseInt(dm[1], 10) };
          sc.p = sc.s.length;
        } else if (run === 'END') {
          sc.ws();
          const em = /^(\d+)/.exec(sc.s.slice(sc.p));
          if (!em) throw new ParseError('END saknar nummer (t.ex. END1)');
          sc.p += em[0].length;
          block.stmt = { type: 'end', n: parseInt(em[1], 10) };
        } else {
          const rest = sc.s.slice(sc.p);
          const lm = /(?:GOTO\s*)?N\s*(\d+)\s*$/.exec(rest);
          if (!lm) throw new ParseError('IF saknar hoppmål (Nxxx)');
          const cond = rest.slice(0, lm.index);
          block.stmt = { type: 'if', cond: parseExpression(cond), label: parseInt(lm[1], 10) };
          sc.p = sc.s.length;
        }
        continue;
      }
      if ((run === 'V' || run === 'VC') && /^[\d[]/.test(sc.s.slice(sc.p + run.length).trimStart())) {
        sc.p += run.length;
        const idx = sc.varIndex();
        if (sc.peek() !== '=') throw new ParseError('Variabeltilldelning saknar =');
        sc.p++;
        block.assigns.push({ kind: run, idx, expr: sc.expr() });
        continue;
      }
      if (EQ_ADDRS.has(run) && sc.s[sc.p + run.length] === '=') {
        sc.p += run.length;
        block.words.push({ a: run, v: sc.wordValue() });
        continue;
      }
      if (run[0] === 'N' && !/\d/.test(sc.s[sc.p + 1] || '') && sc.s[sc.p + 1] !== '=') {
        // N<text> (e.g. NT1): a free-form block label, ignored by the control
        const lm = /^N[A-Z0-9_]*/.exec(sc.s.slice(sc.p));
        sc.p += lm[0].length;
        continue;
      }
      sc.p += 1;
      const v = sc.wordValue();
      block.words.push({ a: run[0], v });
      if (run[0] === 'N' && typeof v === 'number') block.seq = v;
    }
  } catch (e) {
    block.err = e.message;
  }
  return block;
}

// Split text into blocks + programs (O-numbers). The first program is "main".
export function parseProgramText(text) {
  const rawLines = text.replace(/\r/g, '').split('\n');
  const blocks = rawLines.map((l, i) => parseLine(l, i));
  const programs = new Map();
  let cur = null;
  blocks.forEach((b, i) => {
    if (b.header) {
      if (cur) cur.end = i - 1;
      cur = { name: b.header, start: i, end: blocks.length - 1 };
      if (!programs.has(b.header)) programs.set(b.header, cur);
    }
  });
  if (!programs.size) programs.set('MAIN', { name: 'MAIN', start: 0, end: blocks.length - 1 });
  else {
    const first = programs.values().next().value;
    if (first.start > 0 && blocks.slice(0, first.start).some((b) => b.code)) {
      const implicit = { name: 'MAIN', start: 0, end: first.start - 1 };
      const entries = [['MAIN', implicit], ...programs];
      programs.clear();
      entries.forEach(([k, v]) => programs.set(k, v));
    }
  }
  return { blocks, programs, main: programs.values().next().value };
}
