// Draws one screen of the session onto a canvas. The same drawing is used on the
// floating panel in the headset and in the on-screen preview.

export const PANEL_W = 1200;
export const PANEL_H = 760;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const C = {
  bg: '#0f1216', line: '#3d4654', kicker: '#93a8bd', title: '#ffffff', body: '#e4e8ee',
  hintBg: '#1c2530', hint: '#ffd08a', quiet: '#9fb4c8', accent: '#6ea8ff', accentInk: '#0b1320',
  warn: '#d9a441', crisis: '#e0645c', cell: '#262d38',
};

function wrap(g, text, maxWidth) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const test = line ? line + ' ' + word : word;
    if (line && g.measureText(test).width > maxWidth) { out.push(line); line = word; } else line = test;
  }
  if (line) out.push(line);
  return out;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function drawScreen(g, sc, extra = {}) {
  const W = PANEL_W;
  const H = PANEL_H;
  const pad = 52;
  const edge = sc.tone === 'crisis' ? C.crisis : sc.tone === 'warn' ? C.warn : C.line;
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = edge;
  g.lineWidth = sc.tone === 'normal' ? 6 : 12;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);

  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = sc.tone === 'crisis' ? C.crisis : C.kicker;
  g.font = `600 30px ${FONT}`;
  g.fillText(sc.kicker || '', pad, 72);
  if (extra.corner) {
    g.textAlign = 'right';
    g.fillStyle = C.quiet;
    g.font = `26px ${FONT}`;
    g.fillText(extra.corner, W - pad, 72);
    g.textAlign = 'left';
  }

  g.fillStyle = C.title;
  g.font = `600 54px ${FONT}`;
  let y = 150;
  for (const line of wrap(g, sc.title || '', W - 2 * pad)) { g.fillText(line, pad, y); y += 66; }
  y += 10;
  g.fillStyle = C.body;
  g.font = `38px ${FONT}`;
  for (const para of sc.body || []) {
    for (const line of wrap(g, para, W - 2 * pad)) { g.fillText(line, pad, y); y += 50; }
    y += 10;
  }

  const footerTop = H - 96;
  if (sc.kind === 'yesno') {
    const bw = (W - 2 * pad - 40) / 2;
    const by = footerTop - 150;
    for (const x of [pad, pad + bw + 40]) {
      roundRect(g, x, by, bw, 116, 16);
      g.fillStyle = C.cell; g.fill();
      g.strokeStyle = C.quiet; g.lineWidth = 3; g.stroke();
    }
    // Both answers are drawn alike on purpose: neither one is nudged.
    g.textAlign = 'center';
    g.font = `700 46px ${FONT}`;
    g.fillStyle = C.title;
    g.fillText(sc.yesLabel || 'YES', pad + bw / 2, by + 58);
    g.fillText(sc.noLabel || 'NO', pad + bw + 40 + bw / 2, by + 58);
    g.font = `28px ${FONT}`;
    g.fillStyle = C.hint;
    g.fillText('trigger', pad + bw / 2, by + 96);
    g.fillText('grip', pad + bw + 40 + bw / 2, by + 96);
    g.textAlign = 'left';
  } else if (sc.kind === 'rating') {
    const n = 11;
    const gap = 10;
    const cw = (W - 2 * pad - gap * (n - 1)) / n;
    const cy = footerTop - 190;
    for (let i = 0; i < n; i++) {
      const x = pad + i * (cw + gap);
      const on = sc.value === i;
      roundRect(g, x, cy, cw, 96, 12);
      g.fillStyle = on ? C.accent : C.cell; g.fill();
      if (!on) { g.strokeStyle = C.line; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = on ? C.accentInk : C.body;
      g.font = `${on ? 700 : 500} 44px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(String(i), x + cw / 2, cy + 63);
    }
    g.font = `30px ${FONT}`;
    g.fillStyle = C.quiet;
    g.textAlign = 'left'; g.fillText('0 = ' + (sc.low || ''), pad, cy + 140);
    g.textAlign = 'right'; g.fillText('10 = ' + (sc.high || ''), W - pad, cy + 140);
    g.textAlign = 'left';
  } else if (sc.kind === 'choice') {
    const rows = sc.options || [];
    const rh = 78;
    let ry = Math.max(y + 6, footerTop - rows.length * (rh + 12) - 14);
    rows.forEach((label, i) => {
      const on = sc.selected === i;
      roundRect(g, pad, ry, W - 2 * pad, rh, 14);
      g.fillStyle = on ? C.accent : C.cell; g.fill();
      if (!on) { g.strokeStyle = C.line; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = on ? C.accentInk : C.body;
      g.font = `${on ? 700 : 500} 40px ${FONT}`;
      g.fillText(label, pad + 28, ry + 52);
      ry += rh + 12;
    });
  }

  if (typeof sc.progress === 'number') {
    const bw = W - 2 * pad;
    const by = footerTop - 34;
    roundRect(g, pad, by, bw, 14, 7);
    g.fillStyle = C.cell; g.fill();
    const fill = Math.max(0.02, Math.min(1, sc.progress)) * bw;
    roundRect(g, pad, by, fill, 14, 7);
    g.fillStyle = C.accent; g.fill();
  }

  g.fillStyle = C.hintBg;
  g.fillRect(6, footerTop, W - 12, 90);
  g.font = `600 30px ${FONT}`;
  g.fillStyle = C.hint;
  g.textAlign = 'left';
  g.fillText(sc.hint || '', pad, footerTop + 56);
  if (sc.showGroundingHint) {
    g.textAlign = 'right';
    g.fillStyle = C.quiet;
    g.font = `26px ${FONT}`;
    g.fillText('B or Y = stop and ground', W - pad, footerTop + 56);
    g.textAlign = 'left';
  }

  if (sc.paused) {
    g.fillStyle = 'rgba(8,10,13,0.82)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = C.title;
    g.textAlign = 'center';
    g.font = `600 60px ${FONT}`;
    g.fillText('Paused', W / 2, H / 2 - 10);
    g.font = `34px ${FONT}`;
    g.fillStyle = C.body;
    g.fillText('The session continues when you are back.', W / 2, H / 2 + 50);
    g.textAlign = 'left';
  }
}
