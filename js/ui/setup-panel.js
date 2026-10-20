// Stock, start position, work offsets and run options.

import { h } from './dom.js';
import { icon } from './icons.js';

function field(label, obj, key, { step = 1, min, max, unit = 'mm', onChange, hint } = {}) {
  const input = h('input', {
    class: 'in in-n',
    type: 'number',
    step,
    min,
    max,
    value: obj[key],
    id: `f-${label.replace(/\W+/g, '')}-${key}`,
    onchange: (e) => {
      let v = parseFloat(e.target.value);
      if (!isFinite(v)) v = obj[key];
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      obj[key] = v;
      e.target.value = v;
      onChange?.();
    },
  });
  return h('label', { class: 'fld', for: input.id }, h('span', { class: 'lbl' }, label), h('span', { class: 'inp' }, input, h('span', { class: 'unit' }, unit)), hint ? h('span', { class: 'hint' }, hint) : null);
}

function check(label, obj, key, onChange, hint) {
  const id = `c-${key}`;
  return h('label', { class: 'chk', for: id },
    h('input', { type: 'checkbox', id, checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; onChange?.(); } }),
    h('span', {}, label), hint ? h('small', {}, hint) : null);
}

export class SetupPanel {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
  }

  render() {
    const { state } = this.ctx;
    const m = state.machine;
    const stockChanged = () => this.ctx.changed('stock');
    const homeChanged = () => this.ctx.changed('program');
    const optChanged = () => this.ctx.changed('program');
    const sections = [];

    if (m === 'lathe') {
      const s = state.setup.lathe;
      sections.push(
        h('section', { class: 'card' },
          h('h3', {}, 'Ämne (rundmaterial)'),
          h('div', { class: 'grid2' },
            field('Ytterdiameter', s, 'od', { min: 2, step: 1, onChange: stockChanged }),
            field('Innerdiameter', s, 'id', { min: 0, step: 1, onChange: stockChanged, hint: '0 = massivt' }),
            field('Längd', s, 'length', { min: 5, step: 1, onChange: stockChanged }),
            field('Framkant Z', s, 'zFront', { step: 0.5, onChange: stockChanged, hint: 'Z0 = färdig planyta; +1 = 1 mm sticker ut' }),
          )),
        h('section', { class: 'card' },
          h('h3', {}, 'Utgångsläge / referenspunkt'),
          h('p', { class: 'hint' }, 'Verktyget startar här och G30, M52–M54 återvänder hit.'),
          h('div', { class: 'grid2' },
            field('X (diameter)', state.home.lathe, 'x', { step: 5, onChange: homeChanged }),
            field('Z', state.home.lathe, 'z', { step: 5, onChange: homeChanged }),
          )),
      );
    } else {
      const s = state.setup.mill;
      sections.push(
        h('section', { class: 'card' },
          h('h3', {}, 'Ämne (block i skruvstycke)'),
          h('p', { class: 'hint' }, 'Mått i arbetskoordinater med nollpunkt H1 (G15 H1). Z1 = ovansida, Z0 = undersida.'),
          h('div', { class: 'grid2' },
            field('X min', s, 'x0', { onChange: stockChanged }), field('X max', s, 'x1', { onChange: stockChanged }),
            field('Y min', s, 'y0', { onChange: stockChanged }), field('Y max', s, 'y1', { onChange: stockChanged }),
            field('Z undersida', s, 'z0', { onChange: stockChanged }), field('Z ovansida', s, 'z1', { onChange: stockChanged }),
          )),
        h('section', { class: 'card' },
          h('h3', {}, 'Utgångsläge / referenspunkt'),
          h('p', { class: 'hint' }, 'Verktyget startar här och G30, M52–M54 återvänder hit.'),
          h('div', { class: 'grid3' },
            field('X', state.home.mill, 'x', { onChange: homeChanged }),
            field('Y', state.home.mill, 'y', { onChange: homeChanged }),
            field('Z', state.home.mill, 'z', { onChange: homeChanged }),
          )),
      );
    }

    const o = state.opts;
    sections.push(
      h('section', { class: 'card' },
        h('h3', {}, 'Maskin & körning'),
        h('div', { class: 'grid2' },
          field('Snabbtransport', o, 'rapid', { min: 1000, step: 1000, unit: 'mm/min', onChange: optChanged }),
          field('Max varvtal', o.maxRpm, m, { min: 100, step: 100, unit: 'r/min', onChange: optChanged }),
        ),
        check('Blockskip (/) aktiv', o, 'blockSkip', optChanged, 'Block som börjar med / hoppas över'),
        check('Valfritt stopp (M01) aktivt', o, 'optionalStop', () => { this.ctx.changed('opts'); }, 'Pausar vid M01'),
      ),
    );

    // work offsets
    const offs = state.offsets[m];
    const rows = Object.keys(offs).map(Number).sort((a, b) => a - b).map((n) => {
      const o2 = offs[n];
      const cell = (k) => h('td', {}, h('input', {
        class: 'in in-n', type: 'number', step: 0.1, value: o2[k], 'aria-label': `H${n} ${k.toUpperCase()}`,
        onchange: (e) => { o2[k] = parseFloat(e.target.value) || 0; this.ctx.changed('program'); },
      }));
      return h('tr', {}, h('td', { class: 'code' }, 'H' + n), cell('x'), cell('y'), cell('z'),
        h('td', {}, n === 1 ? null : h('button', {
          class: 'icon-btn danger', title: 'Ta bort', 'aria-label': `Ta bort H${n}`, html: icon('trash', 16),
          onclick: () => { delete offs[n]; this.ctx.changed('program'); this.render(); },
        })));
    });
    sections.push(
      h('section', { class: 'card' },
        h('h3', {}, 'Nollpunkter (G15 H…)'),
        h('p', { class: 'hint' }, 'Förskjutning av programmets nollpunkt relativt ämnets nollpunkt (H1). Används av G15 H2, H3 …'),
        h('table', { class: 'tbl offs' }, h('thead', {}, h('tr', {}, h('th', {}, 'Nr'), h('th', {}, 'X'), h('th', {}, 'Y'), h('th', {}, 'Z'), h('th', {}, ''))), h('tbody', {}, rows)),
        h('button', { class: 'btn', html: `${icon('plus', 16)}<span>Ny nollpunkt</span>`, onclick: () => {
          let n = 1; while (offs[n]) n++;
          offs[n] = { x: 0, y: 0, z: 0 };
          this.ctx.changed('program');
          this.render();
        } }),
      ),
      h('section', { class: 'card' },
        h('h3', {}, 'Projekt'),
        h('p', { class: 'hint' }, 'Program, verktygslista, ämne och nollpunkter sparas i webbläsaren automatiskt. Exportera som fil för att dela eller säkerhetskopiera.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', html: `${icon('save', 16)}<span>Exportera projekt</span>`, onclick: () => this.ctx.exportProject() }),
          h('button', { class: 'btn', html: `${icon('open', 16)}<span>Importera projekt</span>`, onclick: () => this.ctx.importProject() }),
          h('button', { class: 'btn ghost', html: '<span>Nollställ allt</span>', onclick: () => this.ctx.resetAll() }),
        )),
    );
    this.root.replaceChildren(...sections);
  }
}
