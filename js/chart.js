// Small dual-axis time chart for county timelines: running total (line, left axis) and
// trailing 3-week count (area, right axis), with a playhead at the current frame.
// Drawn on a 2D canvas so the same code serves the screen and poster/GIF exports.

const SANS = 'Jost, "Century Gothic", sans-serif';

export function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return +(v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return +(v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * c: { dates: ISO strings, total: number[], trailing: number[], frame (fractional), noun ('Cases'|'Deaths'),
 *      ink, inkSoft, accent }
 * Draws into the rect (x, y, w, h) in canvas pixels; u scales type and strokes.
 */
export function drawTimelineChart(ctx, c, x, y, w, h, u = 1) {
  const n = c.dates.length;
  const fs = 12 * u;
  const legendH = fs * 1.9, axisB = fs * 1.7;
  ctx.save();
  ctx.font = `500 ${fs}px ${SANS}`;
  ctx.letterSpacing = '0px';
  const totMax = niceMax(Math.max(...c.total));
  const trMax = niceMax(Math.max(...c.trailing));
  // gutters fit the widest tick label on each side
  const widest = (max) => Math.max(...[0, 0.5, 1].map((k) => ctx.measureText(compact(max * k)).width));
  const lw = widest(totMax) + 8 * u, rw = widest(trMax) + 8 * u;
  // plot on top, year ticks under it, key centered at the bottom
  const px0 = x + lw, px1 = x + w - rw, py0 = y + fs * 0.6, py1 = y + h - axisB - legendH;
  const X = (i) => px0 + ((px1 - px0) * i) / (n - 1);
  const Yt = (v) => py1 - ((py1 - py0) * v) / totMax;
  const Yr = (v) => py1 - ((py1 - py0) * v) / trMax;
  const f = Math.max(0, Math.min(n - 1, c.frame));
  const at = (arr) => { const i = Math.floor(f), t = f - i; return arr[i] + ((arr[Math.min(n - 1, i + 1)] - arr[i]) * t); };

  // key, centered under the chart
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const keys = [[c.ink, `${c.noun} to date`, false], [c.accent, 'Past 3 weeks', true]];
  const keyW = keys.reduce((s, [, label]) => s + fs * 1.5 + ctx.measureText(label).width, 0) + fs * 1.3;
  let lx = (px0 + px1) / 2 - keyW / 2;
  const ky = y + h - legendH / 2;
  for (const [color, label, area] of keys) {
    ctx.fillStyle = color;
    if (area) { ctx.globalAlpha = 0.55; ctx.fillRect(lx, ky - fs * 0.4, fs * 1.1, fs * 0.8); ctx.globalAlpha = 1; }
    else ctx.fillRect(lx, ky - 1.1 * u, fs * 1.1, 2.2 * u);
    ctx.fillStyle = c.ink;
    ctx.fillText(label, lx + fs * 1.5, ky);
    lx += fs * 1.5 + ctx.measureText(label).width + fs * 1.3;
  }

  // gridlines + axis labels (left: total, right: 3-week)
  ctx.strokeStyle = c.inkSoft;
  ctx.lineWidth = 1 * u;
  for (let k = 0; k <= 2; k++) {
    const yy = py1 - ((py1 - py0) * k) / 2;
    ctx.globalAlpha = 0.18;
    ctx.beginPath(); ctx.moveTo(px0, yy); ctx.lineTo(px1, yy); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.ink;
    ctx.textAlign = 'right';
    ctx.fillText(compact((totMax * k) / 2), px0 - 6 * u, yy);
    ctx.fillStyle = c.accent;
    ctx.textAlign = 'left';
    ctx.fillText(compact((trMax * k) / 2), px1 + 6 * u, yy);
  }
  // year ticks
  ctx.fillStyle = c.inkSoft;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastYear = '';
  c.dates.forEach((d, i) => {
    const yr = d.slice(0, 4);
    if (yr !== lastYear) {
      lastYear = yr;
      ctx.fillText(yr, Math.max(px0 + fs, X(i)), py1 + 5 * u);
    }
  });

  // series: everything after the playhead is faded
  const clipTo = (fromX, toX, draw) => {
    ctx.save(); ctx.beginPath(); ctx.rect(fromX, py0 - 4 * u, toX - fromX, py1 - py0 + 8 * u); ctx.clip(); draw(); ctx.restore();
  };
  const area = () => {
    ctx.beginPath(); ctx.moveTo(X(0), py1);
    c.trailing.forEach((v, i) => ctx.lineTo(X(i), Yr(v)));
    ctx.lineTo(X(n - 1), py1); ctx.closePath();
    ctx.fillStyle = c.accent; ctx.fill();
  };
  const line = () => {
    ctx.beginPath();
    c.total.forEach((v, i) => (i ? ctx.lineTo(X(i), Yt(v)) : ctx.moveTo(X(i), Yt(v))));
    ctx.strokeStyle = c.ink; ctx.lineWidth = 2.2 * u; ctx.lineJoin = 'round'; ctx.stroke();
  };
  const hx = X(f);
  clipTo(px0, hx, () => { ctx.globalAlpha = 0.55; area(); ctx.globalAlpha = 1; line(); });
  clipTo(hx, px1 + 1, () => { ctx.globalAlpha = 0.12; area(); ctx.globalAlpha = 0.22; line(); ctx.globalAlpha = 1; });

  // playhead
  ctx.strokeStyle = c.ink; ctx.lineWidth = 1 * u; ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.moveTo(hx, py0); ctx.lineTo(hx, py1); ctx.stroke();
  ctx.globalAlpha = 1;
  for (const [yy, col] of [[Yt(at(c.total)), c.ink], [Yr(at(c.trailing)), c.accent]]) {
    ctx.beginPath(); ctx.arc(hx, yy, 3.2 * u, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();
}
