import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../js/interp/machine.js';
import { SimEngine } from '../js/sim/engine.js';
import { defaultTools } from '../js/sim/tools.js';

const cfg = (machine, over = {}) => ({
  machine, tools: defaultTools(machine), offsets: { 1: { x: 0, y: 0, z: 0 } },
  home: machine === 'lathe' ? [60, 0, 100] : [0, 0, 100], rapid: 30000, ...over,
});

test('lathe roughing + finish leaves the programmed contour', () => {
  const prog = `T01
G97 S1200 M3
G0 X52 Z2
G71 U2 R0.5
G71 P10 Q20 U0 W0 F0.25
N10 G0 X20
G1 Z-30
G1 X40 Z-40
N20 G1 Z-60
G0 X100 Z100
M30`;
  const r = runProgram(prog, cfg('lathe'));
  assert.equal(r.msgs.filter((m) => m.type === 'error').length, 0, JSON.stringify(r.msgs));
  const eng = new SimEngine('lathe', { lathe: { od: 50, id: 0, length: 80, zFront: 2 } });
  const w = eng.fastForward(r.steps);
  const st = eng.stock;
  const rAt = (z) => st.ro[Math.round(st.index(z))];
  assert.ok(Math.abs(rAt(-15) - 10) < 0.05, `r at z-15 = ${rAt(-15)}`);
  assert.ok(Math.abs(rAt(-35) - 15) < 0.8, `taper mid ~15 got ${rAt(-35)}`);
  assert.ok(Math.abs(rAt(-50) - 20) < 0.05);
  assert.equal(w.length, 0, JSON.stringify(w));
});

test('mill: pocket by facing removes material to depth; crash warns', () => {
  const prog = `G90 G0 X-20 Y-20 Z5
T02 M06
S3000 M3
G0 X0 Y0
G1 Z-3 F300
G1 X30
G0 Z10
M30`;
  const r = runProgram(prog, cfg('mill', { initialTool: 2 }));
  const eng = new SimEngine('mill', { mill: { x0: -25, x1: 25, y0: -25, y1: 25, z0: -20, z1: 0 } });
  const w = eng.fastForward(r.steps);
  const st = eng.stock;
  const hAt = (x, y) => st.h[Math.round((y - st.y0) / st.sy) * st.nx + Math.round((x - st.x0) / st.sx)];
  assert.ok(Math.abs(hAt(10, 0) + 3) < 0.01);
  assert.ok(Math.abs(hAt(10, 20) - 0) < 0.01);
  assert.equal(w.length, 0, JSON.stringify(w));
});

test('mill: rapid plunge into stock and cutting without spindle warn', () => {
  const prog = `T02 M06
G0 X0 Y0 Z5
G0 Z-3
G1 X20 F200
M30`;
  const r = runProgram(prog, cfg('mill', { initialTool: 2 }));
  const eng = new SimEngine('mill', { mill: { x0: -25, x1: 25, y0: -25, y1: 25, z0: -20, z1: 0 } });
  const w = eng.fastForward(r.steps);
  assert.ok(w.some((x) => /Snabbtransport/.test(x.text)));
  assert.ok(w.some((x) => /utan att spindeln/.test(x.text)));
});

test('lathe thread leaves periodic grooves', () => {
  const prog = `T04
G97 S500 M3
G0 X32 Z3
G88 X28.8 Z-20 F1.5
M30`;
  const r = runProgram(prog, cfg('lathe'));
  assert.equal(r.msgs.filter((m) => m.type === 'error').length, 0, JSON.stringify(r.msgs));
  const eng = new SimEngine('lathe', { lathe: { od: 30, id: 0, length: 60, zFront: 3 } });
  eng.fastForward(r.steps);
  const st = eng.stock;
  const vals = [];
  for (let z = -2; z > -2 - 6; z -= 0.1) vals.push(st.ro[Math.round(st.index(z))]);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  assert.ok(mx - mn > 0.5, `thread depth ${mx - mn}`);
});

test('shaft sample finishes to the programmed profile', async () => {
  const { SAMPLES } = await import('../js/data/samples.js');
  const s = SAMPLES.find((x) => x.id === 'lathe-shaft');
  const r = runProgram(s.program, cfg('lathe', { home: [50, 0, 150] }));
  assert.equal(r.msgs.filter((m) => m.type === 'error').length, 0, JSON.stringify(r.msgs));
  const eng = new SimEngine('lathe', s.setup);
  const warns = eng.fastForward(r.steps);
  assert.equal(warns.length, 0, JSON.stringify(warns));
  const rAt = (z) => eng.stock.ro[Math.round(eng.stock.index(z))];
  const expect = [[-10, 10, 0.05], [-30, 15, 0.02], [-37, 12, 0.02], [-52, 18, 0.02], [-61, 22, 0.02], [-47, 15.76, 0.05]];
  for (const [z, rr, tol] of expect) assert.ok(Math.abs(rAt(z) - rr) < tol, `z=${z}: ${rAt(z)} vs ${rr}`);
});

test('mill pocket sample reaches programmed depths', async () => {
  const { SAMPLES } = await import('../js/data/samples.js');
  const s = SAMPLES.find((x) => x.id === 'mill-pocket');
  const r = runProgram(s.program, cfg('mill'));
  assert.equal(r.msgs.filter((m) => m.type === 'error').length, 0, JSON.stringify(r.msgs));
  const eng = new SimEngine('mill', s.setup);
  const warns = eng.fastForward(r.steps);
  assert.equal(warns.length, 0, JSON.stringify(warns));
  const st = eng.stock;
  const hAt = (x, y) => st.h[Math.round((y - st.y0) / st.sy) * st.nx + Math.round((x - st.x0) / st.sx)];
  assert.ok(Math.abs(hAt(-17, 0) + 8) < 0.02, `pocket floor ${hAt(-17, 0)}`); // outside ring groove
  assert.ok(Math.abs(hAt(35, 25) + 20) < 0.5, `drilled hole bottom ${hAt(35, 25)}`);
  assert.ok(Math.abs(hAt(40, 0) - -0.5) < 0.02, `skimmed top ${hAt(40, 0)}`);
});

test('hole-pattern sample drills 5x3 holes', async () => {
  const { SAMPLES } = await import('../js/data/samples.js');
  const s = SAMPLES.find((x) => x.id === 'mill-pattern');
  const r = runProgram(s.program, cfg('mill'));
  assert.equal(r.msgs.filter((m) => m.type === 'error').length, 0, JSON.stringify(r.msgs));
  const eng = new SimEngine('mill', s.setup);
  const warns = eng.fastForward(r.steps);
  assert.equal(warns.length, 0, JSON.stringify(warns));
  const st = eng.stock;
  const hAt = (x, y) => st.h[Math.round((y - st.y0) / st.sy) * st.nx + Math.round((x - st.x0) / st.sx)];
  let holes = 0;
  for (const y of [-16, -8, 0, 8, 16]) for (const x of [-30, -15, 0]) if (hAt(x, y) <= -9.7) holes++;
  assert.equal(holes, 15);
  assert.ok(hAt(30, 0) > -0.01, 'untouched stock stays');
});
