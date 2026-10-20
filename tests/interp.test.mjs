import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../js/interp/machine.js';
import { parseLine, parseExpression, evalExpr } from '../js/interp/lexer.js';
import { defaultTools } from '../js/sim/tools.js';

const mk = (machine, over = {}) => ({
  machine,
  tools: defaultTools(machine),
  offsets: { 1: { x: 0, y: 0, z: 0 } },
  home: machine === 'lathe' ? [100, 0, 150] : [0, 0, 150],
  rapid: 30000,
  ...over,
});
const moves = (r) => r.steps.filter((s) => s.k === 'm');
const errs = (r) => r.msgs.filter((m) => m.type === 'error');
const last = (r) => moves(r).at(-1);

test('lexer: words, no spaces, expressions', () => {
  const b = parseLine('N10 G01X10.5Z-3.F0.2 (kommentar)', 0);
  assert.equal(b.err, null);
  assert.deepEqual(b.words.map((w) => w.a), ['N', 'G', 'X', 'Z', 'F']);
  assert.equal(b.seq, 10);
  const e = parseLine('G1 X=VC1+5 Z[SQRT[16]*2]', 0);
  assert.equal(e.err, null);
  assert.equal(e.words.length, 3);
});

test('expressions follow User Task semantics', () => {
  const ctx = { getVar: () => 7, sys: () => 0 };
  const v = (s) => evalExpr(parseExpression(s), ctx);
  assert.equal(v('2+3*4'), 14);
  assert.equal(v('[10 MOD 4]'), 2);
  assert.equal(v('SQRT[9]+ABS[-2]'), 5);
  assert.equal(v('VC1 GT 5'), 1);
  assert.equal(v('NOT 0'), 1);
  assert.ok(Math.abs(v('SIN[30]') - 0.5) < 1e-9);
  assert.ok(Math.abs(v('ATAN2[1,1]') - 45) < 1e-9);
  assert.equal(v('DFIX[3.7]'), 3);
  assert.equal(v('FUP[3.2]'), 4);
  assert.equal(v('ROUND[2.5]'), 3);
});

test('mill: linear moves, absolute/incremental, G0 rapid', () => {
  const r = runProgram('G90 G0 X10 Y10 Z5\nG1 Z-2 F100 S500 M3\nG91 G1 X10\nM30', mk('mill'));
  assert.equal(errs(r).length, 0);
  const l = last(r);
  assert.ok(Math.abs(l.b[0] - 20) < 1e-9 && Math.abs(l.b[1] - 10) < 1e-9 && Math.abs(l.b[2] + 2) < 1e-9);
  assert.equal(moves(r)[0].rapid, true);
});

test('mill: G2 arc, centre and endpoint', () => {
  const r = runProgram('G90 G0 X10 Y0 Z0\nG17 G2 X0 Y-10 I-10 J0 F200\nM30', mk('mill'));
  assert.equal(errs(r).length, 0);
  const arc = moves(r).filter((m) => !m.rapid);
  assert.ok(arc.length > 10);
  const l = arc.at(-1);
  assert.ok(Math.abs(l.b[0]) < 1e-6 && Math.abs(l.b[1] + 10) < 1e-6);
  // clockwise from (10,0) passes through (7.07,-7.07) before (0,-10)
  const mid = arc[Math.floor(arc.length / 2)].b;
  assert.ok(mid[1] < 0 && mid[0] > 0);
});

test('mill: R arc sign selects short/long arc', () => {
  const short = runProgram('G0 X0 Y0\nG3 X10 Y0 R5 F100\nM30', mk('mill'));
  const long = runProgram('G0 X0 Y0\nG3 X10 Y0 R-5 F100\nM30', mk('mill'));
  const len = (r) => moves(r).filter((m) => !m.rapid).reduce((s, m) => s + m.len, 0);
  assert.ok(Math.abs(len(short) - Math.PI * 5) < 0.05);
  assert.ok(Math.abs(len(long) - Math.PI * 5) < 0.05);
  // G3 from (0,0) to (10,0): centre (5,0) -> goes below (y<0)
  assert.ok(moves(short).filter((m) => !m.rapid).some((m) => m.b[1] < -4));
});

test('mill: G81/G83 cycles with G98/G99 and modal repeat', () => {
  const prog = 'G90 G0 X0 Y0 Z20\nG99 G81 X10 Y10 Z-10 R2 F100\nX20\nG80\nG0 Z50\nM30';
  const r = runProgram(prog, mk('mill'));
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const feeds = moves(r).filter((m) => !m.rapid);
  assert.equal(feeds.length, 2);
  assert.ok(feeds.every((f) => Math.abs(f.b[2] + 10) < 1e-9));
  const peck = runProgram('G90 G0 Z20\nG98 G83 X5 Y5 Z-9 R2 Q3 F80\nM30', mk('mill'));
  assert.equal(errs(peck).length, 0, JSON.stringify(peck.msgs));
  assert.equal(moves(peck).filter((m) => !m.rapid).length, 4);
});

test('mill: cutter comp G41 offsets a square contour by tool radius', () => {
  const prog = [
    'G90 G0 X-20 Y-20 Z5',
    'G1 Z-3 F300 S3000 M3',
    'G41 D2 G1 X0 Y-10 F200',
    'G1 X0 Y0',
    'G1 X50 Y0',
    'G1 X50 Y50',
    'G1 X0 Y50',
    'G1 X0 Y10',
    'G40 G1 X-20 Y-10',
    'M30',
  ].join('\n');
  const r = runProgram(prog, mk('mill'));
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const pts = moves(r).map((m) => m.b);
  // tool 2 is dia 10 -> radius 5; left comp of CCW square => tool outside? contour runs CCW so left = inside
  const has = (x, y) => pts.some((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6);
  assert.ok(has(45, 5), 'inside corner (45,5)');
  assert.ok(has(45, 45), 'inside corner (45,45)');
  assert.ok(has(5, 45), 'inside corner (5,45)');
  assert.ok(Math.max(...pts.map((p) => p[0])) <= 45 + 1e-6);
});

test('lathe: G71 roughing produces cuts above the finished profile', () => {
  const prog = [
    'T01',
    'G97 S1000 M3',
    'G0 X52 Z2',
    'G71 U2 R0.5',
    'G71 P10 Q20 U0.4 W0.1 F0.2',
    'N10 G0 X20',
    'G1 Z-30',
    'G1 X40 Z-40',
    'N20 G1 Z-60',
    'G0 X100 Z100',
    'M30',
  ].join('\n');
  const r = runProgram(prog, mk('lathe'));
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const cuts = moves(r).filter((m) => !m.rapid);
  assert.ok(cuts.length > 6);
  assert.ok(cuts.every((c) => c.b[0] >= 10 - 1e-6), 'never cuts below finish radius 10');
});

test('lathe: G33 thread and G88 cycle need spindle; produce thread steps', () => {
  const ok = runProgram('T04\nG97 S600 M3\nG0 X30 Z5\nG88 X27.2 Z-20 F1.5\nM30', mk('lathe'));
  assert.equal(errs(ok).length, 0, JSON.stringify(ok.msgs));
  assert.ok(moves(ok).some((m) => m.pitch === 1.5));
  const bad = runProgram('T04\nG0 X30 Z5\nG33 Z-20 F1.5\nM30', mk('lathe'));
  assert.equal(errs(bad).length, 1);
});

test('lathe: diameter programming halves X; G18 arc direction', () => {
  const r = runProgram('T02\nG97 S800 M3\nG0 X0 Z0\nG3 X20 Z-10 R10 F0.1\nM30', mk('lathe'));
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const e = last(r);
  // tip number 3, nose 0.4: centre = tip + (r,r) so end radius ~ 10.4
  assert.ok(Math.abs(e.b[0] - 10.4) < 1e-6, `got ${e.b[0]}`);
  // hemispherical nose: the path bulges toward +Z at radius ~ R*sin
  const arc = moves(r).filter((m) => !m.rapid);
  assert.ok(arc.some((m) => m.b[0] > 4 && m.b[2] > -5));
});

test('variables, IF/GOTO loops and CALL/RTS', () => {
  const prog = [
    'VC1=0',
    'N10 VC1=VC1+1',
    'G0 X=VC1*10 Y0',
    'IF VC1 LT 3 N10',
    'CALL O100 A5',
    'M30',
    'O100',
    'G0 Z=V1',
    'RTS',
  ].join('\n');
  const r = runProgram(prog, mk('mill'));
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const m = moves(r);
  assert.deepEqual(m.slice(0, 3).map((s) => s.b[0]), [10, 20, 30]);
  assert.equal(last(r).b[2], 5);
});

test('infinite loop is stopped with an alarm', () => {
  const r = runProgram('N1 G0 X1\nGOTO N1', mk('mill'));
  assert.equal(errs(r).length, 1);
});

test('unsupported codes warn, supported list compiles', () => {
  const r = runProgram('G999\nM777\nM30', mk('mill'));
  assert.equal(r.msgs.filter((m) => m.type === 'warn').length, 2);
});

test('work offset G15 shifts world coordinates', () => {
  const cfg = mk('mill', { offsets: { 1: { x: 0, y: 0, z: 0 }, 2: { x: 100, y: 50, z: -10 } } });
  const r = runProgram('G15 H2\nG0 X1 Y2 Z3\nM30', cfg);
  const l = last(r);
  assert.deepEqual(l.b, [101, 52, -7]);
});

test('G51 scaling and G62 mirror', () => {
  const r = runProgram('G51 X0 Y0 P2\nG0 X10 Y10\nG50\nG62 X0\nG0 X10 Y10\nM30', mk('mill'));
  const m = moves(r);
  assert.deepEqual(m[0].b.slice(0, 2), [20, 20]);
  assert.deepEqual(m[1].b.slice(0, 2), [-10, 10]);
});

test('inch mode scales to mm', () => {
  const r = runProgram('G20\nG0 X1 Y1\nM30', mk('mill'));
  assert.ok(Math.abs(last(r).b[0] - 25.4) < 1e-9);
});

test('chamfer suffix trims a corner', () => {
  const r = runProgram('G0 X0 Y0\nG1 X20 F100 ,C2\nG1 Y20\nM30', mk('mill'));
  const m = moves(r).filter((s) => !s.rapid);
  assert.equal(m.length, 3);
  assert.ok(Math.abs(m[0].b[0] - 18) < 1e-9);
  assert.ok(Math.abs(m[1].b[0] - 20) < 1e-9 && Math.abs(m[1].b[1] - 2) < 1e-9);
});

test('tool change events and missing tool warning', () => {
  const r = runProgram('T02 M06\nT99 M06\nM30', mk('mill'));
  assert.equal(r.steps.filter((s) => s.e === 'tool').length, 2);
  assert.equal(r.msgs.filter((m) => m.type === 'warn').length, 1);
});

test('feed missing raises alarm', () => {
  const r = runProgram('G0 X0\nG1 X10\nM30', mk('mill'));
  assert.equal(errs(r).length, 1);
});
