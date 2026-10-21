// Application bootstrap: state, wiring between editor, interpreter, simulation,
// 3D views and panels.

import * as THREE from 'three';
import { Viewport, disposeObject } from './render/scene.js';
import { LatheView } from './render/lathe-view.js';
import { MillView } from './render/mill-view.js';
import { ToolActor, Coolant, toThree } from './render/tool-view.js';
import { ToolpathView } from './render/toolpath-view.js';
import { runProgram } from './interp/machine.js';
import { SimEngine } from './sim/engine.js';
import { Player } from './sim/player.js';
import { defaultTools, tipToCenter } from './sim/tools.js';
import { SAMPLES, sampleById } from './data/samples.js';
import { Editor } from './ui/editor.js';
import { ToolsPanel } from './ui/tools-panel.js';
import { SetupPanel } from './ui/setup-panel.js';
import { CodesPanel } from './ui/codes-panel.js';
import { icon } from './ui/icons.js';
import { answer, SUGGESTIONS } from './ui/assistant.js';
import { $, $$, h, download, pickFile, debounce, fmtTime } from './ui/dom.js';

const STORE_KEY = 'osp-sim-v1';
const clone = (o) => JSON.parse(JSON.stringify(o));

// ----------------------------------------------------------------- state
function defaultHome(machine, setup) {
  if (machine === 'lathe') return { x: Math.max(100, setup.od + 50), z: setup.zFront + 150 };
  return { x: 0, y: 0, z: setup.z1 + 150 };
}
function defaultState() {
  const lathe = sampleById('lathe-shaft');
  const mill = sampleById('mill-pocket');
  return {
    v: 1,
    machine: 'lathe',
    programs: { lathe: lathe.program, mill: mill.program },
    setup: { lathe: clone(lathe.setup.lathe), mill: clone(mill.setup.mill) },
    home: { lathe: defaultHome('lathe', lathe.setup.lathe), mill: defaultHome('mill', mill.setup.mill) },
    tools: { lathe: defaultTools('lathe'), mill: defaultTools('mill') },
    offsets: { lathe: { 1: { x: 0, y: 0, z: 0 } }, mill: { 1: { x: 0, y: 0, z: 0 } } },
    opts: {
      rapid: 30000,
      maxRpm: { lathe: 4000, mill: 12000 },
      blockSkip: false,
      optionalStop: false,
      section: 'quarter',
      showPath: true,
      showRapid: true,
      showTool: true,
    },
    ui: { speed: 60, feed: 100, rapid: 100, tab: 'tools' },
    welcomed: false,
  };
}
function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    return mergeState(base, JSON.parse(raw));
  } catch {
    return base;
  }
}
function mergeState(base, saved) {
  const s = { ...base, ...saved };
  s.opts = { ...base.opts, ...(saved.opts || {}), maxRpm: { ...base.opts.maxRpm, ...(saved.opts?.maxRpm || {}) } };
  s.ui = { ...base.ui, ...(saved.ui || {}) };
  for (const k of ['programs', 'setup', 'home', 'tools', 'offsets']) s[k] = { ...base[k], ...(saved[k] || {}) };
  return s;
}
let state = loadState();
const save = debounce(() => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* storage blocked */ }
}, 400);

// ------------------------------------------------------------ globals
const vp = new Viewport($('#viewport'));
let world = null; // { machine, engine, view, actor, coolant, toolpath }
let player = null;
let result = null;
let runtimeMsgs = [];
let lastIdx = -1;
let lastDro = 0;
let dragging = false;

const editor = new Editor($('#editor'), {
  onChange: (text) => {
    state.programs[state.machine] = text;
    save();
    recomputeSoon();
  },
});

// ----------------------------------------------------------------- icons in static markup
const setIcon = (sel, name, size = 18, text = '') => {
  const el = $(sel);
  el.innerHTML = icon(name, size) + (text ? `<span>${text}</span>` : '');
};
setIcon('#btn-new', 'doc', 17);
setIcon('#btn-open', 'open', 17);
setIcon('#btn-save', 'save', 17);
setIcon('#btn-samples', 'list', 16, 'Exempel');
setIcon('#btn-help', 'help', 16, 'Hjälp');
setIcon('#t-reset', 'reset', 18);
setIcon('#t-back', 'back', 18);
setIcon('#t-step', 'step', 18);
setIcon('#t-play', 'play', 22);
setIcon('#t-end', 'end', 18);
$$('.wi').forEach((el) => (el.innerHTML = icon(el.dataset.i, 18)));

// ------------------------------------------------------------- config
function buildCfg() {
  const m = state.machine;
  const hm = state.home[m];
  return {
    machine: m,
    tools: state.tools[m],
    offsets: state.offsets[m],
    home: m === 'lathe' ? [hm.x / 2, 0, hm.z] : [hm.x, hm.y, hm.z],
    rapid: state.opts.rapid,
    maxRpm: state.opts.maxRpm[m],
    blockSkip: state.opts.blockSkip,
  };
}

// ----------------------------------------------------------- world build
function rebuildWorld() {
  if (world) {
    vp.world.remove(world.group);
    disposeObject(world.group);
  }
  const m = state.machine;
  const setup = { lathe: state.setup.lathe, mill: state.setup.mill };
  const engine = new SimEngine(m, setup);
  const group = new THREE.Group();
  vp.world.add(group);
  const view = m === 'lathe' ? new LatheView(group, engine.stock) : new MillView(group, engine.stock);
  if (m === 'lathe') view.setSection(state.opts.section);
  const toolpath = new ToolpathView(group, m);
  toolpath.setOptions({ rapid: state.opts.showRapid, preview: state.opts.showPath, feed: true });
  const actor = new ToolActor(group, m);
  const coolant = new Coolant(group);
  world = { machine: m, engine, view, actor, coolant, toolpath, group };
  player = new Player(engine);
  attachPlayer();
  lastIdx = -1;
  frameCamera();
}

function frameCamera() {
  const m = state.machine;
  if (m === 'lathe') {
    const s = state.setup.lathe;
    vp.setView('lathe', new THREE.Vector3(s.zFront - s.length / 2, 0, 0), Math.max(s.length * 1.35, s.od * 2.4));
  } else {
    const s = state.setup.mill;
    vp.setView('iso', new THREE.Vector3((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2, -(s.y0 + s.y1) / 2), Math.max(s.x1 - s.x0, s.y1 - s.y0, 80));
  }
}

function viewTarget() {
  if (state.machine === 'lathe') {
    const s = state.setup.lathe;
    return [new THREE.Vector3(s.zFront - s.length / 2, 0, 0), Math.max(s.length * 1.35, s.od * 2.4)];
  }
  const s = state.setup.mill;
  return [new THREE.Vector3((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2, -(s.y0 + s.y1) / 2), Math.max(s.x1 - s.x0, s.y1 - s.y0, 80)];
}

// ----------------------------------------------------------- compute
const recomputeSoon = debounce(() => recompute(), 320);

function recompute() {
  if (!world) return;
  const m = state.machine;
  const cfg = buildCfg();
  const t0 = performance.now();
  result = runProgram(state.programs[m], cfg);
  result.ms = performance.now() - t0;
  runtimeMsgs = [];
  player.load(result.steps, result.start);
  world.toolpath.setSteps(result.steps);
  lastIdx = -1;
  const hdr = result.blocks.find((b) => b.header);
  $('#prog-name').textContent = hdr ? 'O' + hdr.header : 'ONAMNLÖS';
  const markers = new Map();
  for (const msg of result.msgs) {
    if (msg.type === 'info') continue;
    const prev = markers.get(msg.ln);
    if (!prev || (msg.type === 'error' && prev.type !== 'error')) markers.set(msg.ln, msg);
  }
  editor.setMarkers(markers);
  updateFoot();
  renderMessages();
  syncTransport();
  if (result.error) toast('error', `Larm på rad ${result.error.ln + 1}: ${result.error.text}`);
}

function updateFoot() {
  const foot = $('#ed-foot');
  foot.className = 'editor-foot';
  if (result.error) {
    foot.classList.add('err');
    foot.innerHTML = `${icon('alert', 16)}<span>Larm rad ${result.error.ln + 1}: ${escapeHtml(result.error.text)}</span>`;
  } else {
    const warns = result.msgs.filter((x) => x.type === 'warn').length;
    foot.innerHTML = `<span>${result.stats.blocks} block · ${fmtTime(result.duration)} maskintid</span>${warns ? `<span style="color:var(--amber)">· ${warns} varning${warns > 1 ? 'ar' : ''}</span>` : ''}`;
  }
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ------------------------------------------------------------ player hooks
function attachPlayer() {
  player.speed = +state.ui.speed;
  player.feedPct = +state.ui.feed;
  player.rapidPct = +state.ui.rapid;
  player.optionalStop = state.opts.optionalStop;
  player.on('line', (ln) => {
    editor.setActiveLine(ln);
    const b = result?.blocks[ln];
    $('#hud-block').textContent = b ? `${ln + 1}: ${b.raw.trim()}` : '';
  });
  player.on('state', syncTransport);
  player.on('warn', (w) => {
    runtimeMsgs.push(w);
    toast('warn', w.text);
    renderMessages();
    editor.setMarkers(markerMap());
  });
  player.on('event', (s) => {
    if (s.e === 'msg') toast('info', s.text);
  });
  player.on('stop', (s) => toast('info', s.m === 0 ? 'M00 – programstopp. Tryck Kör för att fortsätta.' : 'M01 – valfritt stopp. Tryck Kör för att fortsätta.'));
  player.on('end', () => {
    if (result?.error) toast('error', `Programmet stoppades med larm på rad ${result.error.ln + 1}`);
    syncTransport();
  });
}

function markerMap() {
  const markers = new Map();
  for (const msg of [...(result?.msgs || []), ...runtimeMsgs]) {
    if (msg.type === 'info') continue;
    const prev = markers.get(msg.ln);
    if (!prev || (msg.type === 'error' && prev.type !== 'error')) markers.set(msg.ln, msg);
  }
  return markers;
}

// ----------------------------------------------------------- transport UI
function syncTransport() {
  if (!player) return;
  const playing = player.playing;
  const btn = $('#t-play');
  btn.innerHTML = icon(playing ? 'pause' : 'play', 22);
  btn.setAttribute('aria-label', playing ? 'Paus' : 'Kör');
  btn.classList.toggle('running', playing);
  const pill = $('#status-pill');
  let txt = 'STOPPAD', cls = 'pill';
  if (playing) { txt = player.stopAtBlk ? 'ETT BLOCK' : 'KÖR'; cls += ' run'; }
  else if (player.finished) { txt = result?.error ? 'LARM' : 'PROGRAMSLUT'; cls += result?.error ? ' alarm' : ''; }
  else if (player.idx > 0) { txt = 'PAUS'; cls += ' hold'; }
  pill.className = cls;
  pill.textContent = txt;
  $('#lamp-sb').classList.toggle('on', !!player.stopAtBlk);
  $('#lamp-opt').classList.toggle('on', state.opts.optionalStop);
  $('#lamp-bs').classList.toggle('on', state.opts.blockSkip);
  $('#t-dur').textContent = fmtTime(player.duration);
}

$('#t-play').addEventListener('click', () => (player.playing ? player.pause() : player.play()));
$('#t-reset').addEventListener('click', () => {
  runtimeMsgs = [];
  player.reset();
  renderMessages();
  editor.setMarkers(markerMap());
  world.toolpath.setProgress(0);
});
$('#t-step').addEventListener('click', () => player.stepBlock());
$('#t-back').addEventListener('click', () => {
  runtimeMsgs = [];
  player.stepBack();
  renderMessages();
  editor.setMarkers(markerMap());
});
$('#t-end').addEventListener('click', () => {
  runtimeMsgs = [];
  player.runToEnd();
  renderMessages();
  editor.setMarkers(markerMap());
});
const slider = $('#t-slider');
const doSeek = (() => {
  let pending = null;
  return (frac) => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = null;
      runtimeMsgs = [];
      player.seekTime(frac * player.duration);
      renderMessages();
      editor.setMarkers(markerMap());
    });
  };
})();
slider.addEventListener('input', () => {
  dragging = true;
  slider.style.setProperty('--fill', `${slider.value / 10}%`);
  doSeek(slider.value / 1000);
});
slider.addEventListener('change', () => (dragging = false));
$('#t-speed').value = String(state.ui.speed);
$('#t-speed').addEventListener('change', (e) => {
  state.ui.speed = +e.target.value;
  player.speed = state.ui.speed;
  save();
});
$('#t-feed').value = String(state.ui.feed);
$('#t-feed-v').textContent = `${state.ui.feed}%`;
$('#t-feed').addEventListener('input', (e) => {
  state.ui.feed = +e.target.value;
  player.feedPct = state.ui.feed;
  $('#t-feed-v').textContent = `${state.ui.feed}%`;
  save();
});
$('#t-rapid').value = String(state.ui.rapid);
$('#t-rapid').addEventListener('change', (e) => {
  state.ui.rapid = +e.target.value;
  player.rapidPct = state.ui.rapid;
  save();
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); $('#t-play').click(); }
  else if (k === 's' || k === 'arrowright') { e.preventDefault(); $('#t-step').click(); }
  else if (k === 'arrowleft') { e.preventDefault(); $('#t-back').click(); }
  else if (k === 'r') $('#t-reset').click();
  else if (k === 'e') $('#t-end').click();
});

// ----------------------------------------------------------- toolbar
function buildToolbar() {
  const views = $('#views');
  const mk = (name, ic, label, fn) => h('button', { class: 'vbtn', title: label, 'aria-label': label, html: icon(ic, 16) + `<span>${name}</span>`, onclick: fn });
  const setV = (preset) => {
    const [t, size] = viewTarget();
    vp.setView(preset, t, size);
  };
  views.replaceChildren(
    mk('ISO', 'iso', 'Isometrisk vy', () => setV(state.machine === 'lathe' ? 'lathe' : 'iso')),
    mk('Fram', 'front', 'Framifrån', () => setV('front')),
    mk('Topp', 'top', 'Ovanifrån', () => setV('top')),
    mk('Sida', 'side', 'Från sidan', () => setV('side')),
    mk('Anpassa', 'fit', 'Anpassa vy', () => frameCamera()),
  );
  const tg = $('#vp-toggles');
  const toggle = (key, ic, label, apply) =>
    h('button', {
      class: 'vbtn',
      'aria-pressed': String(state.opts[key]),
      html: icon(ic, 16) + `<span>${label}</span>`,
      onclick: (e) => {
        state.opts[key] = !state.opts[key];
        e.currentTarget.setAttribute('aria-pressed', String(state.opts[key]));
        apply();
        save();
      },
    });
  const parts = [
    toggle('showPath', 'path', 'Bana', () => world.toolpath.setOptions({ preview: state.opts.showPath })),
    toggle('showRapid', 'rapid', 'Rapid', () => world.toolpath.setOptions({ rapid: state.opts.showRapid })),
    toggle('showTool', 'tool', 'Verktyg', () => {}),
  ];
  if (state.machine === 'lathe') {
    const sec = h('div', { class: 'grp', role: 'group', 'aria-label': 'Snittvy' });
    for (const [k, label] of [['full', 'Hel'], ['half', 'Halv'], ['quarter', 'Kvart']]) {
      sec.append(h('button', {
        class: 'vbtn', 'aria-pressed': String(state.opts.section === k), html: (k === 'quarter' ? icon('section', 16) : '') + `<span>${label}</span>`,
        onclick: () => {
          state.opts.section = k;
          world.view.setSection(k);
          $$('button', sec).forEach((b) => b.setAttribute('aria-pressed', String(b === sec.querySelector(`button:nth-child(${['full', 'half', 'quarter'].indexOf(k) + 1})`))));
          save();
        },
      }));
    }
    tg.replaceChildren(...parts, sec);
    tg.classList.remove('grp');
    tg.style.display = 'contents';
  } else {
    tg.style.display = '';
    tg.classList.add('grp');
    tg.replaceChildren(...parts);
  }
}

// ----------------------------------------------------------- toasts
function toast(type, text) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const t = h('div', { class: `toast ${type}`, role: 'status' }, h('span', { html: icon(type === 'info' ? 'info' : 'alert', 18) }), h('span', {}, text));
  box.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, type === 'error' ? 9000 : 6500);
}

// ----------------------------------------------------------- messages pane
function renderMessages() {
  const pane = $('#pane-msgs');
  const all = [...(result?.msgs || []), ...runtimeMsgs];
  const important = all.filter((m) => m.type !== 'info');
  const badge = $('#msg-badge');
  badge.hidden = !important.length;
  badge.textContent = important.length;
  badge.classList.toggle('err', all.some((m) => m.type === 'error'));
  if ($('#tab-msgs').getAttribute('aria-selected') !== 'true' && pane.dataset.rendered === String(all.length) + (result?.ms | 0)) return;
  pane.dataset.rendered = String(all.length) + (result?.ms | 0);
  const stats = result?.stats;
  const tools = (stats?.tools || []).map((t) => {
    const rec = state.tools[state.machine][t.n];
    return `T${t.n}${rec ? ' ' + rec.name : ' (saknas)'}`;
  });
  const statCards = stats
    ? h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('label', {}, 'Maskintid'), h('div', {}, fmtTime(result.duration))),
        h('div', { class: 'stat' }, h('label', {}, 'Block'), h('div', {}, String(stats.blocks))),
        h('div', { class: 'stat' }, h('label', {}, 'Skärväg'), h('div', {}, `${(stats.feedLen / 1000).toFixed(2)} m`)),
        h('div', { class: 'stat' }, h('label', {}, 'Snabbväg'), h('div', {}, `${(stats.rapidLen / 1000).toFixed(2)} m`)),
        h('div', { class: 'stat', style: 'grid-column:1/-1' }, h('label', {}, 'Använda verktyg'), h('div', { style: 'font-size:12px;font-weight:500;font-family:var(--sans)' }, tools.join(' · ') || '–')),
      )
    : null;
  const item = (m) =>
    h('li', {},
      h('button', {
        class: `msg ${m.type}`,
        onclick: () => editor.gotoLine(m.ln),
        html: icon(m.type === 'info' ? 'info' : 'alert', 18),
      },
      h('span', {},
        h('span', { class: 'ln' }, `${m.runtime ? 'Under körning · ' : ''}rad ${m.ln + 1}`),
        m.text)));
  const list = all.length
    ? h('ul', { class: 'msgs' }, all.map(item))
    : h('div', { class: 'empty' }, 'Inga meddelanden. Koden ser bra ut så här långt.');
  pane.replaceChildren(statCards, list);
}

// ----------------------------------------------------------- tabs
const PANES = ['tools', 'setup', 'msgs', 'vars', 'codes', 'ask'];
function selectTab(name) {
  state.ui.tab = name;
  PANES.forEach((p) => {
    const sel = p === name;
    $(`#tab-${p}`).setAttribute('aria-selected', String(sel));
    $(`#pane-${p}`).hidden = !sel;
  });
  if (name === 'tools') toolsPanel.render();
  if (name === 'setup') setupPanel.render();
  if (name === 'codes') codesPanel.render();
  if (name === 'vars') renderVars(true);
  if (name === 'ask') renderAsk();
  if (name === 'msgs') { $('#pane-msgs').dataset.rendered = ''; renderMessages(); }
  save();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.id.replace('tab-', ''))));
$('#tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = PANES.indexOf(state.ui.tab) + (e.key === 'ArrowRight' ? 1 : -1);
  const n = PANES[(i + PANES.length) % PANES.length];
  selectTab(n);
  $(`#tab-${n}`).focus();
});

const toolsPanel = new ToolsPanel($('#pane-tools'), {
  machine: () => state.machine,
  tools: () => state.tools[state.machine],
  onChange: () => { save(); recomputeSoon(); },
  onReset: () => {
    state.tools[state.machine] = defaultTools(state.machine);
    save();
    recompute();
    toolsPanel.render();
  },
});
const setupPanel = new SetupPanel($('#pane-setup'), {
  get state() { return state; },
  changed: (what) => {
    save();
    if (what === 'stock') {
      state.home[state.machine] = defaultHome(state.machine, state.setup[state.machine]);
      rebuildWorld();
      buildToolbar();
      recompute();
      setupPanel.render();
    } else if (what === 'opts') {
      if (player) player.optionalStop = state.opts.optionalStop;
      syncTransport();
    } else {
      if (player) player.optionalStop = state.opts.optionalStop;
      recompute();
    }
  },
  exportProject: () => download('osp-projekt.json', JSON.stringify({ app: 'osp-sim', version: 1, state }, null, 2), 'application/json'),
  importProject: async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = JSON.parse(f.text);
      if (data.app !== 'osp-sim') throw new Error('Filen är inte ett OSP-simulatorprojekt');
      state = mergeState(defaultState(), data.state);
      state.welcomed = true;
      applyMachine();
      toast('info', 'Projektet importerades.');
    } catch (e) {
      toast('error', `Kunde inte importera: ${e.message}`);
    }
  },
  resetAll: () => {
    if (!confirm('Nollställa allt (program, verktyg, ämne) till standardvärden?')) return;
    state = defaultState();
    state.welcomed = true;
    applyMachine();
  },
});
const codesPanel = new CodesPanel($('#pane-codes'), { machine: () => state.machine });

// ----------------------------------------------------------- variables pane
let varsSig = '';
function renderVars(force = false) {
  if (!player || state.ui.tab !== 'vars') return;
  const vars = [...player.engine.vars.entries()];
  const sig = vars.map(([k, v]) => `${k}=${v}`).join('|');
  if (!force && sig === varsSig) return;
  varsSig = sig;
  const nameKey = (k) => [k.startsWith('VC') ? 0 : 1, parseInt(k.replace(/\D/g, ''), 10)];
  vars.sort((a, b) => { const x = nameKey(a[0]), y = nameKey(b[0]); return x[0] - y[0] || x[1] - y[1]; });
  const pane = $('#pane-vars');
  pane.replaceChildren(
    h('p', { class: 'lead' }, 'Värden på variablerna vid den punkt i programmet där simuleringen står just nu. Stega med pilknapparna för att se hur räknare och loopar förändras. VC = gemensamma, V = lokala.'),
    vars.length
      ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Variabel'), h('th', {}, 'Värde'))),
          h('tbody', {}, vars.map(([k, v]) => h('tr', {}, h('td', { class: 'code' }, k), h('td', { class: 'mono' }, String(+v.toFixed(6)))))))
      : h('div', { class: 'empty' }, 'Inga variabler har tilldelats ännu (t.ex. VC1=0).'),
  );
}

// ----------------------------------------------------------- assistant
const chat = [];
function renderAsk(ask) {
  const pane = $('#pane-ask');
  if (ask) {
    chat.push({ who: 'me', text: ask });
    chat.push({ who: 'bot', text: answer(ask, { blocks: result?.blocks || [], msgs: [...(result?.msgs || []), ...runtimeMsgs], tools: state.tools[state.machine], stats: result?.stats, duration: result?.duration }) });
  }
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' },
    chat.length ? chat.map((m) => h('div', { class: `bub ${m.who}` }, m.text)) : h('div', { class: 'bub bot' }, 'Hej! Jag är en enkel regelbaserad hjälpare (ingen AI-modell). Fråga om en kod, en rad eller varför något larmar.'));
  const input = h('input', { class: 'in', type: 'text', placeholder: 'Fråga om koden, t.ex. "varför larmar det?"', 'aria-label': 'Din fråga', id: 'ask-in' });
  const form = h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) renderAsk(v); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Fråga'));
  const chips = h('div', { class: 'chips wrap' }, SUGGESTIONS.map((q) => h('button', { class: 'chip', onclick: () => renderAsk(q) }, q)));
  pane.replaceChildren(log, chips, form);
  log.scrollTop = log.scrollHeight;
  if (ask) $('#ask-in').focus();
}

// ----------------------------------------------------------- machine switch / samples
function applyMachine() {
  $$('#machine-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.machine === state.machine)));
  editor.setValue(state.programs[state.machine]);
  editor.setActiveLine(-1);
  rebuildWorld();
  buildToolbar();
  recompute();
  selectTab(state.ui.tab);
  buildSampleMenu();
  save();
}
$$('#machine-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.machine === state.machine) return;
    state.machine = b.dataset.machine;
    applyMachine();
  }),
);

function loadSample(id) {
  const s = sampleById(id);
  state.machine = s.machine;
  state.programs[s.machine] = s.program;
  state.setup[s.machine] = clone(s.setup[s.machine]);
  state.home[s.machine] = defaultHome(s.machine, state.setup[s.machine]);
  state.tools[s.machine] = defaultTools(s.machine);
  state.offsets[s.machine] = { 1: { x: 0, y: 0, z: 0 } };
  applyMachine();
}

function buildSampleMenu() {
  const pop = $('#sample-pop');
  const items = [];
  for (const m of ['lathe', 'mill']) {
    items.push(h('div', { class: 'sep' }, m === 'lathe' ? 'Svarv' : 'Fräs'));
    for (const s of SAMPLES.filter((x) => x.machine === m)) {
      items.push(h('button', { role: 'menuitem', onclick: () => { closeMenu(); loadSample(s.id); } }, s.name.split(' – ')[1] ? s.name.split(' – ')[0] + ' – ' + s.name.split(' – ')[1].split(' (')[0] : s.name, h('small', {}, (s.name.match(/\(([^)]+)\)/) || [])[1] || '')));
    }
  }
  pop.replaceChildren(...items);
}
const menuBtn = $('#btn-samples');
const closeMenu = () => {
  $('#sample-pop').hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
};
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#sample-pop');
  pop.hidden = !pop.hidden;
  menuBtn.setAttribute('aria-expanded', String(!pop.hidden));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#sample-menu')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ----------------------------------------------------------- files
$('#btn-new').addEventListener('click', () => {
  if (editor.getValue().trim() && !confirm('Ersätta programmet med ett tomt?')) return;
  const blank = `O0001 (NYTT PROGRAM)\nN1 G90 G${state.machine === 'lathe' ? '18' : '17'} G21\n\nM30\n`;
  state.programs[state.machine] = blank;
  editor.setValue(blank);
  recompute();
  save();
});
$('#btn-open').addEventListener('click', async () => {
  const f = await pickFile('.txt,.nc,.min,.mpf,.tap,.cnc,.gcode,.ngc,text/plain');
  if (!f) return;
  state.programs[state.machine] = f.text.replace(/\r\n/g, '\n');
  editor.setValue(state.programs[state.machine]);
  recompute();
  save();
});
$('#btn-save').addEventListener('click', () => {
  const name = ($('#prog-name').textContent || 'PROGRAM').replace(/\W+/g, '') || 'PROGRAM';
  download(`${name}.MIN`, editor.getValue());
});

// ----------------------------------------------------------- welcome
const dlg = $('#welcome');
$('#btn-help').addEventListener('click', () => dlg.showModal());
$$('#welcome [data-start]').forEach((b) =>
  b.addEventListener('click', () => {
    const k = b.dataset.start;
    state.welcomed = true;
    if (k === 'lathe') loadSample('lathe-shaft');
    else if (k === 'mill') loadSample('mill-pocket');
    else {
      state.programs[state.machine] = `O0001 (NYTT PROGRAM)\nN1 G90 G${state.machine === 'lathe' ? '18' : '17'} G21\n\nM30\n`;
      applyMachine();
    }
    dlg.close();
    save();
  }),
);
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('close', () => { state.welcomed = true; save(); });

// ----------------------------------------------------------- DRO
const fmt = (v) => {
  const s = Math.abs(v) < 0.0005 ? 0 : v;
  return (s < 0 ? '-' : '+') + Math.abs(s).toFixed(3).padStart(8, '0');
};
let droKey = '';
let droEls = {};
function buildDroAxes(labels) {
  const key = labels.join();
  if (key === droKey) return;
  droKey = key;
  droEls = {};
  $('#dro-axes').replaceChildren(
    ...labels.map((l) => {
      const n = h('span', { class: 'n' }, '+0000.000');
      const m = h('span', { class: 'm' }, '');
      droEls[l] = { n, m };
      return h('div', { class: `ax${'ABC'.includes(l) ? ' rot' : ''}` }, h('b', {}, l), n, m);
    }),
  );
}

function updateDro(force = false) {
  const now = performance.now();
  if (!force && now - lastDro < 60) return;
  lastDro = now;
  if (!player || !world) return;
  const eng = player.engine;
  const modal = eng.modal;
  const off = modal?.off || [0, 0, 0];
  const pos = player.pos;
  const lathe = state.machine === 'lathe';
  const rot = modal?.rot || [0, 0, 0];
  const rotLabels = ['A', 'B', 'C'].filter((_, i) => Math.abs(rot[i]) > 1e-6);
  buildDroAxes(lathe ? ['X', 'Z', ...rotLabels] : ['X', 'Y', 'Z', ...rotLabels]);
  if (lathe) {
    const [vz, vx] = eng.tool ? tipToCenter(eng.tool) : [0, 0];
    const tipR = pos[0] - vx;
    const tipZ = pos[2] - vz;
    droEls.X.n.textContent = fmt(2 * tipR - off[0]);
    droEls.X.m.textContent = `Ø ${(2 * pos[0]).toFixed(2)}`;
    droEls.Z.n.textContent = fmt(tipZ - off[2]);
    droEls.Z.m.textContent = `M ${pos[2].toFixed(2)}`;
  } else {
    ['X', 'Y', 'Z'].forEach((l, i) => {
      droEls[l].n.textContent = fmt(pos[i] - off[i]);
      droEls[l].m.textContent = `M ${pos[i].toFixed(2)}`;
    });
  }
  rotLabels.forEach((l) => {
    droEls[l].n.textContent = fmt(rot['ABC'.indexOf(l)]);
    droEls[l].m.textContent = '°';
  });
  $('#dro-offset').textContent = modal ? modal.g.find((g) => g.startsWith('G15')) || '' : '';
  // spindle
  const dir = eng.spindleDir;
  const rpm = dir ? Math.round(eng.rpmNow ?? eng.rpm) : 0;
  $('#dro-spindle').textContent = dir ? `${dir === 3 ? 'M03' : 'M04'} ${rpm} r/min` : 'M05 STOPP';
  const f = player.feedNow;
  $('#dro-feed').textContent = !player.playing && !f ? '–' : f === -1 ? 'RAPID' : `${Math.round(f)} mm/min`;
  $('#dro-tool').textContent = eng.tool ? `T${String(eng.toolNo).padStart(2, '0')} ${eng.tool.name}` : 'Inget verktyg valt';
  $('#dro-time').textContent = `${fmtTime(player.simTime)} / ${fmtTime(player.duration)}`;
  $('#dro-cool').textContent = eng.coolant ? 'PÅ' : 'AV';
  $('#hud-tool').textContent = eng.tool ? `T${eng.toolNo} · ${eng.tool.name}` : '';
  const modalBox = $('#dro-modal');
  const sig = modal ? modal.g.join() + modal.m.join() : '';
  if (modalBox.dataset.sig !== sig) {
    modalBox.dataset.sig = sig;
    modalBox.replaceChildren(...(modal ? [...modal.g.map((g) => h('span', {}, g)), ...modal.m.map((m) => h('span', { class: 'm' }, m))] : []));
  }
  toolsPanel.setActive(eng.toolNo);
  renderVars();
  if (!dragging && player.duration > 0) {
    const v = Math.round((player.simTime / player.duration) * 1000);
    slider.value = String(v);
    slider.style.setProperty('--fill', `${v / 10}%`);
  }
  $('#t-cur').textContent = fmtTime(player.simTime);
}

// ----------------------------------------------------------- frame loop
vp.onFrame((dt) => {
  if (!world || !player) return;
  player.tick(dt);
  const eng = player.engine;
  const { actor, coolant, view, toolpath } = world;
  actor.setTool(eng.tool);
  actor.setPos(player.pos);
  actor.root.visible = state.opts.showTool && !!eng.tool;
  const rpm = eng.spindleDir ? eng.rpmNow ?? eng.rpm : 0;
  actor.spin(rpm, eng.spindleDir, dt);
  if (state.machine === 'lathe') view.setSpin(eng.spindleDir === 4 ? -rpm : rpm, dt);
  coolant.setOn(eng.coolant);
  if (eng.coolant) coolant.update(dt, actor.nozzleWorld(), actor.tipWorld());
  view.update();
  if (lastIdx !== player.idx) {
    lastIdx = player.idx;
    toolpath.setProgress(player.idx);
  }
  updateDro();
});

// ----------------------------------------------------------- boot
window.addEventListener('beforeunload', () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
});
applyMachine();
updateDro(true);
if (!state.welcomed) dlg.showModal();

// Expose for debugging / automated tests
window.__osp = { get state() { return state; }, get player() { return player; }, get world() { return world; }, get result() { return result; }, vp, editor, loadSample };
