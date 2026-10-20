import { h } from './dom.js';
import { CODES, STATUS_LABEL } from '../data/codes.js';

export class CodesPanel {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.query = '';
    this.kind = 'all';
  }

  render() {
    const machine = this.ctx.machine();
    const search = h('input', {
      class: 'in search',
      type: 'search',
      placeholder: 'Sök kod, t.ex. G83 eller gänga',
      'aria-label': 'Sök kod',
      value: this.query,
      oninput: (e) => {
        this.query = e.target.value;
        this.body();
      },
    });
    const chips = h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Filter' },
      [['all', 'Alla'], ['G', 'G-koder'], ['M', 'M-koder'], ['F', 'Funktioner']].map(([k, label]) =>
        h('button', {
          class: `chip${this.kind === k ? ' on' : ''}`,
          'aria-pressed': this.kind === k,
          onclick: () => {
            this.kind = k;
            this.render();
          },
        }, label),
      ),
    );
    this.tbody = h('tbody');
    this.count = h('span', { class: 'dim' });
    this.root.replaceChildren(
      h('p', { class: 'lead' }, 'Alla koder ur Okuma-listan är med. Status visar hur långt simuleringen går: ',
        h('b', {}, 'Fullt stöd'), ' = simuleras som på maskinen, ', h('b', {}, 'Förenklad'), ' = förenklad modell eller antagen parametersyntax (kolla maskinens handbok), ',
        h('b', {}, 'Tolkas'), ' = godkänns och spåras men ger ingen geometri.'),
      h('div', { class: 'codes-bar' }, search, chips, this.count),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl codes-tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Kod'), h('th', {}, 'Beskrivning'), h('th', {}, 'Status'))),
        this.tbody)),
    );
    this.body();
    this.machine = machine;
  }

  body() {
    const q = this.query.trim().toLowerCase();
    const machine = this.ctx.machine();
    const rows = CODES.filter((c) => (this.kind === 'all' || c.kind === this.kind) &&
      (!q || c.code.toLowerCase().includes(q) || c.sv.toLowerCase().includes(q) || (c.note || '').toLowerCase().includes(q)));
    this.count.textContent = `${rows.length} st`;
    this.tbody.replaceChildren(
      ...rows.map((c) => {
        const fits = c.mode === 'both' || c.mode === machine;
        return h('tr', { class: fits ? '' : 'muted' },
          h('td', { class: 'code' }, c.code),
          h('td', {}, h('div', {}, c.sv), c.note ? h('div', { class: 'note' }, c.note) : null,
            c.mode !== 'both' ? h('div', { class: 'note tag' }, c.mode === 'lathe' ? 'Endast svarv' : 'Endast fräs') : null),
          h('td', {}, h('span', { class: `st st-${c.status}` }, STATUS_LABEL[c.status])),
        );
      }),
    );
  }
}
