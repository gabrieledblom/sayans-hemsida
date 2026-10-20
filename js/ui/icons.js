// Hand-drawn icon set (20x20, stroke based) used across the interface.

const P = {
  play: '<path d="M6.2 4.2v11.6L15.6 10z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M5.5 4.5h3.2v11H5.5zM11.3 4.5h3.2v11h-3.2z" fill="currentColor" stroke="none"/>',
  step: '<path d="M4.5 4.5v11M7.5 4.8l7.6 5.2-7.6 5.2z"/>',
  back: '<path d="M15.5 4.5v11M12.5 4.8 4.9 10l7.6 5.2z"/>',
  reset: '<path d="M5 4.5v11M15.5 4.8 8 10l7.5 5.2z"/>',
  end: '<path d="M4.5 4.8 12 10l-7.5 5.2zM15 4.5v11"/>',
  iso: '<path d="M10 2.6l6.4 3.7v7.4L10 17.4l-6.4-3.7V6.3zM10 10l6.4-3.7M10 10v7.4M10 10 3.6 6.3"/>',
  front: '<path d="M3.8 5.5h12.4v9H3.8zM3.8 15.6h12.4"/>',
  top: '<path d="M4 4h12v12H4zM10 7v6M7 10h6"/>',
  side: '<path d="M4 6h7.5l4.5 4-4.5 4H4z"/>',
  fit: '<path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4"/>',
  section: '<path d="M10 3.2a6.8 6.8 0 1 0 6.8 6.8H10z"/>',
  path: '<path d="M3 15.5l4-8 4 5 3-7 3 4"/>',
  rapid: '<path d="M3 10h3M8.5 10h3M14 10h3"/>',
  tool: '<path d="M7.8 2.8h4.4v8.2L10 17.2 7.8 11z"/>',
  open: '<path d="M2.8 6.2h5l1.6 1.7h7.8v7.9H2.8z"/>',
  save: '<path d="M4 3.5h9l3 3v10H4zM7 3.5v4.5h5V3.5M7 16.5v-5h6v5"/>',
  doc: '<path d="M5 2.8h6.8l3.2 3.2v11.2H5zM11.5 2.8V6.3H15"/>',
  list: '<path d="M6.5 5h10M6.5 10h10M6.5 15h10M3.5 5h.1M3.5 10h.1M3.5 15h.1"/>',
  help: '<circle cx="10" cy="10" r="7.2"/><path d="M7.9 7.9a2.2 2.2 0 1 1 3.1 2c-.7.4-1 .8-1 1.6M10 14.2h.01"/>',
  alert: '<path d="M10 3.2 17.4 16H2.6zM10 8v3.8M10 13.7h.01"/>',
  info: '<circle cx="10" cy="10" r="7.2"/><path d="M10 9v5M10 6.3h.01"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  trash: '<path d="M4.5 6h11M8 6V4h4v2M6 6l.7 10h6.6L14 6"/>',
  copy: '<path d="M7 7h8v9H7zM5 13V4h8"/>',
  bolt: '<path d="M11 2.8 5 11h4l-1 6.2L15 8.6h-4z"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2.2M10 15v2.2M2.8 10h2.2M15 10h2.2M4.9 4.9l1.6 1.6M13.5 13.5l1.6 1.6M15.1 4.9l-1.6 1.6M6.5 13.5l-1.6 1.6"/>',
  close: '<path d="M5 5l10 10M15 5 5 15"/>',
  chevron: '<path d="m6 8 4 4 4-4"/>',
  eye: '<path d="M2.5 10S5.5 4.8 10 4.8 17.5 10 17.5 10 14.5 15.2 10 15.2 2.5 10 2.5 10z"/><circle cx="10" cy="10" r="2.3"/>',
};

export function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}

// Side-view pictograms of tool types.
export function toolGlyph(type) {
  const w = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"';
  const shapes = {
    flat: '<path d="M10 3v10M18 3v10M10 13h8"/><path d="M12 3v10"/>',
    bull: '<path d="M10 3v8.5q0 1.5 1.5 1.5h5q1.5 0 1.5-1.5V3"/>',
    ball: '<path d="M10 3v6a4 4 0 0 0 8 0V3"/>',
    face: '<path d="M6 4h16v5H6zM8 9v3M20 9v3M8 12h12"/>',
    drill: '<path d="M10 3v8l4 4 4-4V3"/><path d="M11 6l6 3"/>',
    spot: '<path d="M9 3v6l5 6 5-6V3"/>',
    chamfer: '<path d="M10 3v5l-3 5h14l-3-5V3"/>',
    tap: '<path d="M11 3v10h6V3M11 6l6 1.5M11 9l6 1.5M11 12l6 1.5"/>',
    ream: '<path d="M10 3v10h8V3M12 3v10M14 3v10M16 3v10"/>',
    bore: '<path d="M5 8h14v4H5zM19 9l3-1v5l-3-1"/>',
    turn: '<path d="M6 5h6l8 6-3 3H6zM17 14l-3-3"/>',
    groove: '<path d="M8 3h7v10H8zM10 13v3h3v-3"/>',
    thread: '<path d="M14 3l5 11H9z"/><path d="M11 9h6"/>',
    thread_id: '<path d="M14 14 9 3h10z"/>',
    center: '<path d="M10 3v6l4 5 4-5V3"/>',
  };
  return `<svg class="glyph" width="28" height="18" viewBox="0 0 28 18" ${w} aria-hidden="true">${shapes[type] || shapes.flat}</svg>`;
}
