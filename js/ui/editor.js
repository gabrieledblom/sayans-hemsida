// Lightweight NC program editor: line numbers, syntax colours, current-block
// highlight and diagnostic markers. A transparent textarea sits on top of a
// coloured <pre> so native editing, undo and selection keep working.

import { h } from './dom.js';

const LH = 20;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightLine(raw) {
  let out = '';
  let rest = raw;
  const re = /(\([^)]*\)|;.*$)|(\b(?:CALL|RTS|IF|GOTO|MT|TG|TL|SB)\b)|(\bVC?\d+|\bVC?\[[^\]]*\])|(\bN\d+)|(\bO[A-Z0-9_]+\b)|(\bG\d+(?:\.\d+)?)|(\bM\d+)|(\bT\d+)|([FS]=?-?[\d.]+)|([XYZUWABCIJKRHDPQEL]=?-?[\d.]*)|(\b[A-Z]{2,}\b)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(rest))) {
    out += esc(rest.slice(last, m.index));
    const t = esc(m[0]);
    const cls = m[1] ? 'c' : m[2] ? 'k' : m[3] ? 'v' : m[4] ? 'n' : m[5] ? 'o' : m[6] ? 'g' : m[7] ? 'm' : m[8] ? 't' : m[9] ? 'f' : m[10] ? 'a' : 'k';
    out += `<span class="tk-${cls}">${t}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += esc(rest.slice(last));
  return out;
}

export class Editor {
  constructor(root, { onChange } = {}) {
    this.root = root;
    this.onChange = onChange || (() => {});
    this.markers = new Map();
    this.active = -1;
    root.classList.add('ed');
    this.gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
    this.hl = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
    this.ta = h('textarea', {
      class: 'ed-ta',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      wrap: 'off',
      'aria-label': 'NC-program (Okuma OSP)',
    });
    this.activeBar = h('div', { class: 'ed-active' });
    this.code = h('div', { class: 'ed-code' }, this.activeBar, this.hl, this.ta);
    this.scroll = h('div', { class: 'ed-scroll' }, this.code);
    root.append(this.gutter, this.scroll);

    this.ta.addEventListener('input', () => {
      this.refresh();
      this.onChange(this.ta.value);
    });
    this.scroll.addEventListener('scroll', () => {
      this.gutter.scrollTop = this.scroll.scrollTop;
    });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = this.ta;
        this.ta.setRangeText('  ', s, en, 'end');
        this.ta.dispatchEvent(new Event('input'));
      }
    });
  }

  getValue() {
    return this.ta.value;
  }
  setValue(text) {
    this.ta.value = text;
    this.refresh();
  }

  refresh() {
    const lines = this.ta.value.split('\n');
    this.hl.innerHTML = lines.map(highlightLine).join('\n') + '\n';
    this.renderGutter(lines.length);
    const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
    this.ta.style.height = `${lines.length * LH + 24}px`;
    this.ta.style.width = `${Math.max(maxLen + 6, 30)}ch`;
    this.hl.style.width = this.ta.style.width;
    this.hl.style.height = this.ta.style.height;
    this.lineCount = lines.length;
  }

  renderGutter(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const mk = this.markers.get(i);
      const d = h('div', { class: `ed-ln${mk ? ' has-' + mk.type : ''}`, title: mk ? mk.text : null }, String(i + 1));
      if (i === this.active) d.classList.add('is-active');
      frag.append(d);
    }
    this.gutter.replaceChildren(frag);
    this.gutter.scrollTop = this.scroll.scrollTop;
  }

  setMarkers(map) {
    this.markers = map;
    this.renderGutter(this.ta.value.split('\n').length);
  }

  setActiveLine(i) {
    if (i === this.active) return;
    this.active = i;
    if (i < 0) {
      this.activeBar.style.display = 'none';
    } else {
      this.activeBar.style.display = 'block';
      this.activeBar.style.top = `${i * LH + 8}px`;
      this.scrollIntoView(i);
    }
    this.gutter.querySelectorAll('.ed-ln.is-active').forEach((e) => e.classList.remove('is-active'));
    const ln = this.gutter.children[i];
    if (ln) ln.classList.add('is-active');
  }

  scrollIntoView(i) {
    const top = i * LH;
    const sc = this.scroll;
    if (top < sc.scrollTop + LH * 2) sc.scrollTop = Math.max(0, top - LH * 4);
    else if (top > sc.scrollTop + sc.clientHeight - LH * 3) sc.scrollTop = top - sc.clientHeight + LH * 5;
  }

  gotoLine(i) {
    this.scrollIntoView(i);
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let k = 0; k < i; k++) pos += lines[k].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + (lines[i] || '').length);
  }
}
