import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../js/interp/machine.js';
import { SimEngine } from '../js/sim/engine.js';
import { defaultTools } from '../js/sim/tools.js';
import { parseLine } from '../js/interp/lexer.js';

const cfg = (m = 'mill') => ({ machine: m, tools: defaultTools(m), offsets: { 1: { x: 0, y: 0, z: 0 } }, home: m === 'lathe' ? [60, 0, 100] : [0, 0, 100], rapid: 30000 });
const errs = (r) => r.msgs.filter((m) => m.type === 'error');
const spindle = (r) => r.steps.filter((s) => s.e === 'spindle').at(-1);

test('formulas directly after a value: S300*3 = 900', () => {
  const r = runProgram('S300*3 M3\nM30', cfg());
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  assert.equal(spindle(r).rpm, 900);
});
test('direct formulas in axis words with precedence, spaces and unary minus', () => {
  const r = runProgram('G0 X10+5*2 Y100/4 Z-2*3\nG0 X10 MOD 4\nG0 X2^3\nG0 X[10+2]/3\nM30', cfg());
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const m = r.steps.filter((s) => s.k === 'm');
  assert.deepEqual(m[0].b, [20, 25, -6]);
  assert.equal(m[1].b[0], 2);
  assert.equal(m[2].b[0], 8);
  assert.equal(m[3].b[0], 4);
});
test('plain words are unaffected by operator detection', () => {
  const b = parseLine('G1 X10 Y-5 Z-.5 F100 S1000 M3', 0);
  assert.equal(b.err, null);
  assert.deepEqual(b.words.map((w) => w.v), [1, 10, -5, -0.5, 100, 1000, 3]);
});
test('new functions and PI', () => {
  const r = runProgram('VC1=MAX[3,9,4]\nVC2=POW[2,10]\nVC3=ASIN[0.5]\nVC4=LN[EXP[2]]\nVC5=PI*2\nG0 X=VC1 Y=VC2 Z=VC3\nG0 X=VC4 Y=VC5\nM30', cfg());
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  const m = r.steps.filter((s) => s.k === 'm');
  assert.equal(m[0].b[0], 9); assert.equal(m[0].b[1], 1024); assert.ok(Math.abs(m[0].b[2] - 30) < 1e-9);
  assert.ok(Math.abs(m[1].b[0] - 2) < 1e-9); assert.ok(Math.abs(m[1].b[1] - 2 * Math.PI) < 1e-9);
});
test('WHILE/DO/END loop with counter', () => {
  const r = runProgram('VC1=0\nWHILE [VC1 LT 4] DO1\nVC1=VC1+1\nG0 X=VC1*10\nEND1\nG0 Y5\nM30', cfg());
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  assert.deepEqual(r.steps.filter((s) => s.k === 'm').map((s) => s.b[0]), [10, 20, 30, 40, 40]);
});
test('WHILE without END alarms; division by zero alarms', () => {
  assert.equal(errs(runProgram('WHILE [1 EQ 1] DO1\nG0 X1\nM30', cfg())).length, 1);
  assert.equal(errs(runProgram('VC1=0\nG0 X=5/VC1\nM30', cfg())).length, 1);
});
test('variables are tracked by the engine and reset on rewind', () => {
  const r = runProgram('VC1=0\nN1 VC1=VC1+1\nIF VC1 LT 3 N1\nM30', cfg());
  const e = new SimEngine('mill', { mill: { x0: -10, x1: 10, y0: -10, y1: 10, z0: -5, z1: 0 } });
  e.fastForward(r.steps);
  assert.equal(e.vars.get('VC1'), 3);
  e.resetState();
  assert.equal(e.vars.size, 0);
});

test('formula sample runs: 8 holes on a circle + formula depth', async () => {
  const { SAMPLES } = await import('../js/data/samples.js');
  const s = SAMPLES.find((x) => x.id === 'mill-formulas');
  const r = runProgram(s.program, cfg());
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  assert.equal(r.steps.find((x) => x.e === 'spindle' && x.dir === 3).rpm, 900);
  const eng = new SimEngine('mill', s.setup);
  const w = eng.fastForward(r.steps);
  assert.equal(w.length, 0, JSON.stringify(w));
  const st = eng.stock;
  const hAt = (x, y) => st.h[Math.round((y - st.y0) / st.sy) * st.nx + Math.round((x - st.x0) / st.sx)];
  for (let i = 0; i < 8; i++) assert.ok(hAt(25 * Math.cos((i * Math.PI) / 4), 25 * Math.sin((i * Math.PI) / 4)) < -9.5, `hole ${i}`);
  assert.ok(hAt(0, 0) < -11.5, 'center hole depth 12 from formula');
});

test('code list semantics: lathe G20/G21 return to reference, mill G20 inch, G30 mill only, G11 does not move', () => {
  const l = runProgram('G0 X30 Z5\nG21\nM30', cfg('lathe'));
  const last = l.steps.filter((s) => s.k === 'm').at(-1).b;
  assert.deepEqual([last[0], last[2]], [60, 100]);
  assert.equal(runProgram('G20\nG0 X1\nM30', cfg()).steps.find((s) => s.k === 'm').b[0], 25.4);
  assert.equal(runProgram('G30\nM30', cfg('lathe')).msgs.filter((m) => m.type === 'warn').length, 1);
  const g11 = runProgram('G11 X10\nM30', cfg());
  assert.equal(g11.steps.filter((s) => s.k === 'm').length, 0);
  assert.equal(runProgram('G11 X10\nG0 X0\nM30', cfg()).steps.find((s) => s.k === 'm').b[0], 10);
});
