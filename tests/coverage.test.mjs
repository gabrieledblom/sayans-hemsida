import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../js/interp/machine.js';
import { SimEngine } from '../js/sim/engine.js';
import { defaultTools } from '../js/sim/tools.js';
import { CODES } from '../js/data/codes.js';

const cfg = (machine, over = {}) => ({
  machine, tools: defaultTools(machine), offsets: { 1: { x: 0, y: 0, z: 0 }, 2: { x: 10, y: 10, z: 0 } },
  home: machine === 'lathe' ? [60, 0, 100] : [0, 0, 100], rapid: 30000, ...over,
});
const internal = (r) => r.msgs.filter((m) => /Internt fel/.test(m.text));
const errors = (r) => r.msgs.filter((m) => m.type === 'error');
const moves = (r) => r.steps.filter((s) => s.k === 'm');

const MILL_CASES = {
  'G84 tap': 'T04 M06\nS500 M03\nG90 G00 X10 Y10 Z20\nG99 G84 Z-8 R3 F250\nG80\nM30',
  'G85/G86/G89': 'T04 M06\nS500 M03\nG90 G00 X0 Y0 Z20\nG99 G85 X5 Z-6 R3 F100\nG86 X10\nG89 X15 P500\nG80\nM30',
  'G76/G87': 'T04 M06\nS500 M03\nG90 G00 X0 Y0 Z20\nG99 G76 Z-6 R3 Q0.3 P500 F100\nG87 X10 Z-1 R-8 Q1 F100\nG80\nM30',
  'G73/G74': 'T04 M06\nS500 M03\nG90 G00 X0 Y0 Z20\nG99 G73 Z-9 R3 Q3 F100\nG74 X10 Z-6 R3 F100\nG80\nM30',
  'G92/G10/G11': 'G90 G00 X10 Y10\nG92 X0 Y0\nG00 X5\nG11 X20 Y20\nG00 X0 Y0\nG10\nM30',
  'G4 dwell/G30/M52': 'G4 F2\nG4 P1500\nG30 Z0\nM52\nG30\nM30',
  'blockskip/MSG': '/ G00 X500\n(MSG HEJ)\nG00 X1\nM30',
  'MT TG TL': 'MT=2\nTG=3\nTL=3\nG56 H3 Z5\nM30',
  'helical': 'G90 G17 G0 X10 Y0 Z0\nG3 X10 Y0 Z-5 I-10 J0 F200\nM30',
  'G18 G19 arcs': 'G90 G0 X0 Y0 Z0\nG18 G2 X10 Z-10 I0 K-10 F100\nG19 G3 Y10 Z0 J0 K10\nM30',
  'G91 arcs': 'G90 G0 X0 Y0\nG91 G2 X10 Y-10 I10 J0 F100\nM30',
  'mirror arc': 'G62 X0\nG0 X10 Y0\nG3 X0 Y10 I-10 J0 F100\nM30',
  'scale arc': 'G51 X0 Y0 P2\nG0 X5 Y0\nG3 X0 Y5 I-5 J0 F100\nG50\nM30',
  'comp arcs': 'T02 M06\nS1000 M03\nG0 X-20 Y-20 Z2\nG1 Z-2 F200\nG41 D2 G1 X0 Y-10\nG3 X10 Y0 R10\nG2 X20 Y10 R10\nG1 X30 Y10\nG40 G1 X30 Y30\nM30',
  'comp G42 start/stop': 'T02 M06\nS1000 M03\nG0 X-20 Y-20 Z2\nG42 D2 G1 X0 Y-10 F200\nG1 X0 Y20\nG1 X20 Y20\nG40 G0 X30 Y30\nM30',
  'inch': 'G20\nG90 G0 X1 Y1\nG1 X2 F10\nM30',
  'M-codes': 'M3 S100\nM4\nM5\nM8\nM9\nM12\nM59\nM88\nM288\nM289\nM120\nM339\nM15\nM16\nM115\nM116\nM403\nM404\nM40\nM60\nM0\nM1\nM30',
  'G17/G18/G19 + G61/G9/G52/G15': 'G17\nG18\nG19\nG61\nG9\nG52\nG15 H2\nG0 X0\nM30',
  'G54-58': 'T02 M06\nG54 H2\nG55 H2\nG56 H2\nG57 H2\nG58 H2\nG53\nM30',
  'G116': 'G116 T3\nM30',
  'rotary words': 'G0 A90 B45 C10\nM30',
};
const LATHE_CASES = {
  'G72 facing rough': 'T01\nG97 S800 M03\nG0 X54 Z2\nG72 U1.5 R0.5\nG72 P10 Q20 U0.2 W0.1 F0.2\nN10 G0 Z-10\nG1 X30\nG1 Z-20\nN20 G1 X10\nG0 X100 Z100\nM30',
  'G77/G78/G178/G179/G190': 'T01\nG97 S800 M03\nG0 X54 Z2\nG77 X40 Z-20 F0.2\nX36\nG78 X0 Z-1 F0.2\nG178 X30 Z-10 F0.2\nG179 X0 Z-2 F0.2\nG190 X20 Z-5 F0.2\nM30',
  'G73/G74 groove': 'T03\nG97 S600 M03\nG0 X40 Z-20\nG73 X30 Z-20 Q-26 I2 K2 F0.1\nG0 X40 Z2\nG74 Z-10 X20 K3 I3 F0.1\nM30',
  'G181-G189': 'T05\nG97 S600 M03\nG0 X0 Z3\nG181 Z-10 R2 F0.1\nG182 Z-10 R2 P500 F0.1\nG183 Z-10 R2 Q3 F0.1\nG184 Z-10 R2 F0.1\nG189 Z-10 R2 P300 F0.1\nG80\nM30',
  'G185-G188 threads': 'T04\nG97 S600 M03\nG0 X32 Z3\nG185 X28.8 Z-15 F1.5\nG186 X28.8 Z-15 R-1 F1.5\nG187 X28.8 Z-15 F1.5\nG188 X28.8 Z-15 R1 F1.5\nM30',
  'G31 G32': 'T04\nG97 S600 M03\nG0 X30 Z3\nG31 Z-10 F1.5\nG0 X30 Z3\nG32 Z-10 F1.5\nM30',
  'G96/G97/G50/G110/G111': 'T01\nG50 S2500\nG96 S180 M03\nG0 X50 Z2\nG1 X20 F0.2\nG110 S150\nG1 X10\nG111 S150\nG97 S500\nM30',
  'G94 G95': 'T01\nG97 S800 M03\nG0 X50 Z2\nG94\nG1 Z-5 F100\nG95\nG1 X20 F0.1\nM30',
  'lathe comp arc': 'T02\nG97 S1000 M03\nG0 X52 Z2\nG42\nG0 X0 Z0\nG1 X20 F0.1\nG3 X30 Z-5 R5\nG1 Z-20\nG40 G0 X60 Z5\nM30',
  'U/W incremental': 'T01\nG97 S800 M03\nG0 X50 Z2\nG1 U-10 W-5 F0.2\nM30',
  'G30 lathe': 'T01\nG0 X30 Z5\nG30\nM30',
  'MT TG lathe': 'MT=2\nTG=3\nM30',
  'T0101 form': 'T0101\nT0202\nT010101\nM30',
  'G20 lathe': 'G20\nG0 X2 Z1\nM30',
  'CSS missing S': 'T01\nG96 M03\nG0 X50 Z2\nM30',
};

for (const [name, prog] of Object.entries(MILL_CASES)) {
  test(`mill smoke: ${name}`, () => {
    const r = runProgram(prog, cfg('mill'));
    assert.equal(internal(r).length, 0, JSON.stringify(r.msgs));
    assert.equal(errors(r).length, 0, JSON.stringify(r.msgs));
    new SimEngine('mill', { mill: { x0: -50, x1: 50, y0: -50, y1: 50, z0: -20, z1: 0 } }).fastForward(r.steps);
  });
}
for (const [name, prog] of Object.entries(LATHE_CASES)) {
  test(`lathe smoke: ${name}`, () => {
    const r = runProgram(prog, cfg('lathe'));
    assert.equal(internal(r).length, 0, JSON.stringify(r.msgs));
    if (name !== 'CSS missing S') assert.equal(errors(r).length, 0, JSON.stringify(r.msgs));
    new SimEngine('lathe', { lathe: { od: 50, id: 0, length: 60, zFront: 2 } }).fastForward(r.steps);
  });
}

test('every G and M code in the reference list is accepted without an "unsupported" warning', () => {
  for (const c of CODES.filter((x) => x.kind === 'G' || x.kind === 'M')) {
    for (const machine of ['mill', 'lathe']) {
      if (c.mode !== 'both' && c.mode !== machine) continue;
      const num = c.code.slice(1);
      const extra = c.kind === 'G' && num === '116' ? ' T1' : c.kind === 'M' && num === '6' ? ' T1' : '';
      const r = runProgram(`${c.code}${extra}\nM30`.replace(/^([GM])0*(\d)/, '$1$2'), cfg(machine));
      const unsup = r.msgs.filter((m) => /stöds inte av simulatorn/.test(m.text));
      assert.equal(unsup.length, 0, `${c.code} (${machine}): ${JSON.stringify(r.msgs)}`);
      assert.equal(internal(r).length, 0, `${c.code}`);
    }
  }
});

test('thread-extension and tap feed use pitch×rpm', () => {
  const r = runProgram('T04\nG97 S600 M03\nG0 X30 Z3\nG33 Z-10 F1.5\nM30', cfg('lathe'));
  const t = moves(r).find((m) => m.pitch);
  assert.ok(Math.abs(t.f - 900) < 1e-6);
});

test('G96 constant surface speed varies rpm with diameter', () => {
  const r = runProgram('T01\nG50 S3000\nG96 S100 M03\nG0 X50 Z2\nG1 Z-5 F0.2\nG0 X20\nG1 Z-10 F0.2\nM30', cfg('lathe'));
  const m = moves(r).filter((s) => !s.rapid);
  assert.ok(m[0].rpm > 600 && m[0].rpm < 700, `rpm at dia~50: ${m[0].rpm}`);
  assert.ok(m[1].rpm > 1500 && m[1].rpm < 1700, `rpm at dia~20: ${m[1].rpm}`);
});
