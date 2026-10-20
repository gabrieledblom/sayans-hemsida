import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../js/interp/machine.js';
import { SimEngine } from '../js/sim/engine.js';
import { Player } from '../js/sim/player.js';
import { defaultTools } from '../js/sim/tools.js';
import { answer, explainMessage } from '../js/ui/assistant.js';

const cfg = (machine) => ({ machine, tools: defaultTools(machine), offsets: { 1: { x: 0, y: 0, z: 0 } }, home: machine === 'lathe' ? [60, 0, 100] : [0, 0, 100], rapid: 30000 });
const errs = (r) => r.msgs.filter((m) => m.type === 'error');

test('N-words with text (NT1) are inert labels', () => {
  const r = runProgram('NT1 G0 X5\nN10 NABC\nN20 X10 NSTART G1 X20 F100\nM30', cfg('mill'));
  assert.equal(errs(r).length, 0, JSON.stringify(r.msgs));
  assert.equal(r.msgs.filter((m) => m.type === 'warn').length, 0);
  assert.equal(r.steps.filter((s) => s.k === 'm').length, 2);
});

test('tool below stock bottom gives no warning', () => {
  const r = runProgram('T02 M06\nS1000 M03\nG0 X0 Y0 Z5\nG1 Z-40 F300\nG0 Z10\nM30', cfg('mill'));
  const eng = new SimEngine('mill', { mill: { x0: -20, x1: 20, y0: -20, y1: 20, z0: -10, z1: 0 } });
  const w = eng.fastForward(r.steps);
  assert.equal(w.filter((x) => /underkant/.test(x.text)).length, 0);
});

test('thread marks columns and step back restores state', () => {
  const r = runProgram('T04\nG97 S500 M03\nG0 X32 Z3\nG88 X28.8 Z-20 F1.5\nM30', cfg('lathe'));
  const eng = new SimEngine('lathe', { lathe: { od: 30, id: 0, length: 60, zFront: 3 } });
  const p = new Player(eng);
  p.load(r.steps, r.start);
  p.runToEnd();
  const st = eng.stock;
  assert.ok(st.thr[Math.round(st.index(-10))] > 0, 'threaded column flagged');
  assert.equal(st.thr[Math.round(st.index(-40))], 0);
  p.stepBack();
  assert.ok(p.idx < r.steps.length);
  p.seek(0);
  assert.equal(st.thr[Math.round(st.index(-10))], 0, 'reset clears threads');
});

test('stepBack moves one block at a time', () => {
  const r = runProgram('G0 X10\nG0 X20\nG0 X30\nM30', cfg('mill'));
  const p = new Player(new SimEngine('mill', { mill: { x0: -50, x1: 50, y0: -50, y1: 50, z0: -10, z1: 0 } }));
  p.load(r.steps, r.start);
  p.runToEnd();
  p.stepBack();
  assert.equal(p.pos[0], 30);
  p.stepBack();
  assert.equal(p.pos[0], 20);
  p.stepBack();
  assert.equal(p.pos[0], 10);
});

test('assistant explains codes, lines and diagnostics', () => {
  const r = runProgram('T99 M06\nG0 X1\nM30', cfg('mill'));
  const ctx = { blocks: r.blocks, msgs: r.msgs, tools: defaultTools('mill'), stats: r.stats, duration: r.duration };
  assert.match(answer('Vad gör G83?', ctx), /Pickborr/);
  assert.match(answer('varför larmar det?', ctx), /T99/);
  assert.match(answer('förklara rad 2', ctx), /X1/);
  assert.match(explainMessage('Snabbtransport (G00) i material med T2 – kollisionsrisk'), /G00/);
  assert.match(answer('hur gängar jag', ctx), /G88/);
});
