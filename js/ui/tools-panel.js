// Tool table: this is how the simulation learns what each T-number is.

import { h } from './dom.js';
import { icon, toolGlyph } from './icons.js';
import { typesFor, makeTool } from '../sim/tools.js';

const MILL_COLS = [
  { key: 'dia', label: 'Ø', step: 0.1, min: 0.1, rel: () => true },
  { key: 'len', label: 'Skärlängd', step: 1, min: 1, rel: () => true },
  { key: 'cr', label: 'Hörnradie', step: 0.1, min: 0, rel: (t) => t === 'bull' || t === 'ball' },
  { key: 'tipAngle', label: 'Spetsvinkel°', step: 1, min: 10, max: 180, rel: (t) => ['drill', 'spot', 'chamfer'].includes(t) },
  { key: 'tipDia', label: 'Spets-Ø', step: 0.1, min: 0, rel: (t) => t === 'chamfer' },
  { key: 'flutes', label: 'Skär', step: 1, min: 1, max: 12, rel: (t) => ['flat', 'bull', 'ball', 'face', 'chamfer', 'tap'].includes(t) },
];
const LATHE_COLS = [
  { key: 'tip', label: 'Spetsläge', select: [1, 2, 3, 4, 9], rel: (t) => ['turn', 'bore', 'groove', 'thread', 'thread_id'].includes(t) },
  { key: 'nose', label: 'Nosradie', step: 0.05, min: 0, rel: (t) => ['turn', 'bore', 'groove', 'thread', 'thread_id'].includes(t) },
  { key: 'insert', label: 'Insats°', step: 5, min: 20, max: 90, rel: (t) => t === 'turn' || t === 'bore' },
  { key: 'width', label: 'Bredd', step: 0.1, min: 0.5, rel: (t) => t === 'groove' },
  { key: 'ref', label: 'Referens', select: ['left', 'center', 'right'], labels: { left: 'vänster', center: 'mitt', right: 'höger' }, rel: (t) => t === 'groove' },
  { key: 'dia', label: 'Ø', step: 0.1, min: 0.1, rel: (t) => ['drill', 'center', 'tap', 'ream', 'bore'].includes(t) },
  { key: 'len', label: 'Längd', step: 1, min: 5, rel: (t) => ['drill', 'center', 'tap', 'ream'].includes(t) },
  { key: 'tipAngle', label: 'Spetsvinkel°', step: 1, min: 10, max: 180, rel: (t) => t === 'drill' || t === 'center' },
];

export class ToolsPanel {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx; // { machine(), tools(), onChange(), onReset() }
    this.activeTool = 0;
  }

  setActive(n) {
    if (n === this.activeTool) return;
    this.activeTool = n;
    this.root.querySelectorAll('[data-t]').forEach((el) => el.classList.toggle('is-active', +el.dataset.t === n));
  }

  render() {
    const machine = this.ctx.machine();
    const tools = this.ctx.tools();
    const cols = machine === 'lathe' ? LATHE_COLS : MILL_COLS;
    const types = typesFor(machine);

    const cards = Object.values(tools)
      .sort((a, b) => a.n - b.n)
      .map((tool) => {
        const numInput = h('input', {
          class: 'in in-t',
          type: 'number',
          min: 1,
          max: 999,
          value: tool.n,
          'aria-label': 'Verktygsnummer',
          onchange: (e) => {
            const nn = Math.round(+e.target.value);
            if (!nn || nn < 1 || (tools[nn] && tools[nn] !== tool)) {
              e.target.value = tool.n;
              return;
            }
            delete tools[tool.n];
            tool.n = nn;
            tools[nn] = tool;
            this.ctx.onChange();
            this.render();
          },
        });
        const typeSel = h(
          'select',
          {
            class: 'in',
            'aria-label': 'Verktygstyp',
            onchange: (e) => {
              const base = makeTool(machine, tool.n, e.target.value);
              tools[tool.n] = { ...base, name: tool.name === types[tool.type] || /Ø/.test(tool.name) ? base.name : tool.name };
              this.ctx.onChange();
              this.render();
            },
          },
          Object.entries(types).map(([k, v]) => h('option', { value: k, selected: k === tool.type }, v)),
        );
        const name = h('input', {
          class: 'in',
          type: 'text',
          value: tool.name,
          'aria-label': 'Namn',
          onchange: (e) => {
            tool.name = e.target.value;
            this.ctx.onChange();
          },
        });
        const fields = cols
          .filter((c) => c.rel(tool.type))
          .map((c) => {
            let input;
            if (c.select) {
              input = h(
                'select',
                {
                  class: 'in',
                  onchange: (e) => {
                    tool[c.key] = isNaN(+e.target.value) ? e.target.value : +e.target.value;
                    this.ctx.onChange();
                  },
                },
                c.select.map((v) => h('option', { value: v, selected: v === tool[c.key] }, c.labels ? c.labels[v] : v === 9 ? '9 (centrum)' : 'T' + v)),
              );
            } else {
              input = h('input', {
                class: 'in in-n',
                type: 'number',
                step: c.step,
                min: c.min,
                max: c.max,
                value: tool[c.key] ?? '',
                onchange: (e) => {
                  let v = parseFloat(e.target.value);
                  if (!isFinite(v)) v = c.min ?? 0;
                  if (c.min !== undefined) v = Math.max(c.min, v);
                  if (c.max !== undefined) v = Math.min(c.max, v);
                  tool[c.key] = v;
                  e.target.value = v;
                  this.ctx.onChange();
                },
              });
            }
            return h('label', { class: 'tf' }, h('span', {}, c.label), input);
          });
        return h(
          'article',
          { class: `tool-card${tool.n === this.activeTool ? ' is-active' : ''}`, 'data-t': tool.n },
          h(
            'div',
            { class: 'tool-top' },
            h('label', { class: 'tnum' }, h('span', {}, 'T'), numInput),
            h('span', { class: 'glyph-wrap', html: toolGlyph(tool.type) }),
            typeSel,
            h('button', {
              class: 'icon-btn',
              title: 'Duplicera verktyg',
              'aria-label': 'Duplicera verktyg',
              html: icon('copy', 16),
              onclick: () => {
                const nn = this.nextFree(tools);
                tools[nn] = { ...tool, n: nn };
                this.ctx.onChange();
                this.render();
              },
            }),
            h('button', {
              class: 'icon-btn danger',
              title: 'Ta bort verktyg',
              'aria-label': 'Ta bort verktyg',
              html: icon('trash', 16),
              onclick: () => {
                delete tools[tool.n];
                this.ctx.onChange();
                this.render();
              },
            }),
          ),
          name,
          h('div', { class: 'tool-fields' }, fields),
        );
      });

    const typeSelect = h(
      'select',
      { class: 'in', id: 'new-tool-type', 'aria-label': 'Typ av nytt verktyg' },
      Object.entries(types).map(([k, v]) => h('option', { value: k }, v)),
    );
    const add = h(
      'div',
      { class: 'tools-add' },
      typeSelect,
      h('button', {
        class: 'btn',
        html: `${icon('plus', 16)}<span>Lägg till</span>`,
        onclick: () => {
          const nn = this.nextFree(tools);
          tools[nn] = makeTool(machine, nn, typeSelect.value);
          this.ctx.onChange();
          this.render();
        },
      }),
      h('button', { class: 'btn ghost', onclick: () => this.ctx.onReset(), html: '<span>Standardlista</span>' }),
    );

    this.root.replaceChildren(
      h(
        'p',
        { class: 'lead' },
        machine === 'lathe'
          ? 'Beskriv varje T-nummer i programmet. Typ, spetsläge (T1–T4, T9) och nosradie styr både kompenseringen (G41/G42) och hur skäret tar bort material.'
          : 'Beskriv varje T-nummer i programmet. Typ och diameter styr både kompenseringen (G41/G42) och hur verktyget tar bort material.',
      ),
      add,
      h('div', { class: 'tool-list' }, cards),
    );
  }

  nextFree(tools) {
    let n = 1;
    while (tools[n]) n++;
    return n;
  }
}
