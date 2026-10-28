// Poster export. Each aspect ratio is a fresh layout: the map is re-framed and
// rendered off-screen at full resolution, then the title, legend, city labels
// and credits are drawn onto a 2D canvas sized for that ratio.
//
// Layout: title (and timeline date) across the top; legend + source lines bottom left;
// chart (timelines) and the NOMAD Data mark bottom right; the map centered between.
import { PerspectiveCamera, Vector3 } from 'three';
import { drawTimelineChart } from './chart.js';

export const RATIOS = [[1, 1], [3, 4], [4, 3], [4, 5], [5, 4], [16, 9]];

const SERIF = '"Source Serif 4", Georgia, serif';
const SANS = 'Jost, "Century Gothic", sans-serif';
const MARK_TEXT = 'NOMAD DATA';

const logo = new Image();
export const logoReady = new Promise((res) => { logo.onload = res; logo.onerror = res; });
logo.src = 'assets/nomad-data-logo.png';

export function posterSize([rw, rh], longSide) {
  return rw >= rh ? [longSide, Math.round((longSide * rh) / rw)] : [Math.round((longSide * rw) / rh), longSide];
}

/**
 * spec: {
 *   title, subtitle, legendTitle, swatches: [{ top, left, right, label }], meta: [source, note],
 *   bg, bgEdge, ink, inkSoft, halo, accent, box, labels: [{ name, x, y, cid }], nLabels, heightOf(cid),
 *   stamp (timeline date), chart (timeline series), labelPlan (shared object: keeps labels fixed across GIF frames),
 *   legendKind ('ramp' | 'cat': a categorical legend is a list, not a row of hexes)
 * }
 * adj (optional, from the framing editor): {
 *   cam: { yaw, tilt (degrees, added to the default view), zoom (x), px, py (pan, in units of the camera distance) },
 *   legend: { dx, dy }, chart: { dx, dy }   (offsets as fractions of the poster width / height)
 * }
 * The returned canvas carries `hit` = where the legend and chart were drawn, for the editor's dragging.
 */
export function renderPoster(renderer, spec, ratio, longSide, adj = null) {
  const [W, H] = posterSize(ratio, longSide);
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  const u = Math.min(W, H) / 1000;
  const pad = 64 * u;

  // paper background, glow centered on the poster
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  g.addColorStop(0.3, spec.bg); g.addColorStop(1, spec.bgEdge);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const L = layout(ctx, spec, W, H, u, pad, adj);

  // Map centered between the header and the bottom text lines, then pulled back only as far as
  // needed to keep the actual state outline off the legend and chart blocks in the corners.
  const cam = new PerspectiveCamera(renderer.camera.fov, W / H, renderer.camera.near, renderer.camera.far);
  const top = 1 - (2 * (L.headerBottom + 30 * u)) / H;
  const bottom = -1 + (2 * (H - (L.metaTop - 20 * u))) / H;
  const ry = Math.min(top, -bottom);
  const pose = renderer.framing(spec.box, { tilt: 46, region: [-0.92, 0.92, -ry, ry], camera: cam });
  const dir = pose.pos.clone().sub(pose.target).normalize();
  const place = () => {
    cam.position.copy(pose.target).addScaledVector(dir, pose.dist);
    cam.lookAt(pose.target);
    cam.updateMatrixWorld();
  };
  const v = new Vector3();
  const hits = () => (spec.outline || []).some(([x, y]) => {
    v.set(x, 0, y).project(cam);
    const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
    return L.blocks.some((b) => sx > b.x0 && sx < b.x1 && sy > b.y0 && sy < b.y1);
  });
  place();
  for (let i = 0; i < 40 && hits(); i++) { pose.dist *= 1.03; place(); }
  if (adj?.cam) applyCamAdjust(cam, pose, adj.cam);
  renderer.renderTo(cam, W, H, (canvas) => ctx.drawImage(canvas, 0, 0));

  drawLabels(ctx, spec, cam, W, H, u, L.avoid);
  drawText(ctx, spec, L, u);
  out.hit = { legend: L.legendBox, chart: L.chart && { x0: L.chart.x, y0: L.chart.y, x1: L.chart.x + L.chart.w, y1: L.chart.y + L.chart.h }, W, H };
  return out;
}

// Orbit, tilt, zoom and pan the automatic framing. The default view looks north from the south
// at 46 degrees off vertical; yaw turns it around the map's center.
function applyCamAdjust(cam, pose, a) {
  const deg = Math.PI / 180;
  const phi = Math.min(84, Math.max(4, 46 + (a.tilt || 0))) * deg, th = (a.yaw || 0) * deg;
  const base = pose.dist, dist = base / (a.zoom || 1);
  const right = new Vector3(Math.cos(th), 0, -Math.sin(th)), fwd = new Vector3(-Math.sin(th), 0, -Math.cos(th));
  const target = pose.target.clone().addScaledVector(right, (a.px || 0) * base).addScaledVector(fwd, (a.py || 0) * base);
  cam.position.copy(target).add(new Vector3(Math.sin(th) * Math.sin(phi), Math.cos(phi), Math.cos(th) * Math.sin(phi)).multiplyScalar(dist));
  cam.lookAt(target);
  cam.updateMatrixWorld();
}

function setFont(ctx, weight, size, family, spacing = 0) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.letterSpacing = `${spacing}px`;
}

function layout(ctx, spec, W, H, u, pad, adj = null) {
  const maxW = W - 2 * pad;

  // NOMAD Data mark, small, in the top-right corner
  const markH = 26 * u, markText = 12 * u;
  setFont(ctx, 600, markText, SANS, markText * 0.16);
  const markW = markH + 8 * u + ctx.measureText(MARK_TEXT).width;
  const mark = { x: W - pad - markW, y: pad * 0.55, w: markW, h: markH, text: markText };

  // header: title, subtitle, and the timeline date at the right
  const ST = 64 * u;
  setFont(ctx, 700, ST, SERIF);
  // reserve the widest date of the whole run, so the title never resizes from frame to frame
  const stamps = spec.stampAll?.length ? spec.stampAll : spec.stamp ? [spec.stamp] : [];
  const stampW = stamps.length ? Math.max(...stamps.map((t) => ctx.measureText(t).width)) + 40 * u : 0;
  let T = 84 * u;
  const S = 22 * u;
  const subtitle = spec.subtitle.toUpperCase();
  setFont(ctx, 600, S, SANS, S * 0.14);
  const subW = ctx.measureText(subtitle).width;
  setFont(ctx, 700, T, SERIF, -T * 0.015);
  let titleW = ctx.measureText(spec.title).width;
  // landscape posters with short titles set the subtitle beside the title, like the reference prints
  const inline = W / H > 1.15 && titleW + 30 * u + subW + stampW < maxW;
  const titleMax = maxW - stampW;
  if (titleW > titleMax) { T *= titleMax / titleW; titleW = titleMax; }
  const titleBase = pad + T * 0.78;
  const subBase = inline ? titleBase : titleBase + T * 0.22 + S * 1.5;
  const headerBottom = subBase + S * 0.35;

  // footer, left: legend over two meta lines (source, aggregation note)
  const metaSize = 15 * u, metaGap = 22 * u;
  const lastMeta = H - pad * 0.7;
  const metaBases = spec.meta.map((_, i) => lastMeta - (spec.meta.length - 1 - i) * metaGap);
  const sw = 52 * u, gap = 12 * u, n = spec.swatches.length;
  setFont(ctx, 500, 17 * u, SANS, 17 * u * 0.13);
  const legendTitleW = ctx.measureText(spec.legendTitle.toUpperCase()).width;
  let legendW = n * sw + (n - 1) * gap, legendH = 17 * u + 16 * u + sw * 1.08 + 10 * u + 16 * u, cat = null;
  if (spec.legendKind === 'cat') {
    // categories: a list of small hexes and names, in up to two columns of five
    setFont(ctx, 500, 16 * u, SANS);
    const rows = Math.min(5, n), colsN = Math.ceil(n / 5), rowH = 26 * u;
    const colW = 30 * u + Math.max(...spec.swatches.map((s) => ctx.measureText(s.label).width)) + 28 * u;
    cat = { rows, colsN, rowH, colW };
    legendW = colsN * colW;
    legendH = 17 * u + 16 * u + rows * rowH;
  }
  legendW = Math.max(legendW, legendTitleW);
  const legendTop = metaBases[0] - 30 * u - legendH;
  setFont(ctx, 400, metaSize, SANS);
  const metaW = Math.max(...spec.meta.map((m) => ctx.measureText(m).width));

  // footer, right: timeline chart sitting on the bottom line
  let chart = null;
  if (spec.chart) {
    const w = Math.min(W / H > 1.15 ? 500 * u : 440 * u, maxW - Math.max(legendW, metaW) - 60 * u);
    const h = W / H > 1.15 ? 190 * u : 165 * u;
    chart = { x: W - pad - w, y: lastMeta + 4 * u - h, w, h };
  }
  const metaTop = metaBases[0] - metaSize;
  // corner blocks the map outline must stay clear of (default positions: moving the legend or
  // chart in the editor does not re-zoom the map)
  const blocks = [{ x0: pad - 10 * u, y0: legendTop - 10 * u, x1: pad + Math.max(legendW, metaW) + 10 * u, y1: H }];
  if (chart) blocks.push({ x0: chart.x - 14 * u, y0: chart.y - 10 * u, x1: W, y1: H });

  // the editor may have moved the legend or the chart; keep them on the poster
  const shift = (o, x, y, w, h) => [
    Math.min(W - w - 4 * u, Math.max(4 * u, x + (o?.dx || 0) * W)) - x,
    Math.min(H - h - 4 * u, Math.max(4 * u, y + (o?.dy || 0) * H)) - y,
  ];
  const [ldx, ldy] = shift(adj?.legend, pad, legendTop, legendW, legendH);
  const legendX = pad + ldx, legendY = legendTop + ldy;
  if (chart) {
    const [cdx, cdy] = shift(adj?.chart, chart.x, chart.y, chart.w, chart.h);
    chart.x += cdx; chart.y += cdy;
  }
  const legendBox = { x0: legendX, y0: legendY, x1: legendX + legendW, y1: legendY + legendH };
  // a legend or chart moved over the map gets a soft panel behind it so it stays readable
  const plates = [];
  if (ldx || ldy) plates.push(legendBox);
  if (chart && (adj?.chart?.dx || adj?.chart?.dy)) plates.push({ x0: chart.x, y0: chart.y, x1: chart.x + chart.w, y1: chart.y + chart.h });

  const avoid = [
    { x0: pad - 8 * u, y0: pad - 8 * u, x1: pad + (inline ? titleW + 30 * u + subW : Math.max(titleW, subW)) + 8 * u, y1: headerBottom + 8 * u },
    { x0: legendBox.x0 - 8 * u, y0: legendBox.y0 - 8 * u, x1: legendBox.x1 + 8 * u, y1: legendBox.y1 + 8 * u },
    { x0: pad - 8 * u, y0: metaTop - 8 * u, x1: pad + metaW + 8 * u, y1: H },
    { x0: mark.x - 10 * u, y0: 0, x1: W, y1: mark.y + mark.h + 8 * u },
  ];
  if (chart) avoid.push({ x0: chart.x - 14 * u, y0: chart.y - 10 * u, x1: chart.x + chart.w + 8 * u, y1: chart.y + chart.h + 8 * u });
  if (spec.stamp) avoid.push({ x0: W - pad - stampW, y0: pad - 8 * u, x1: W, y1: titleBase + 16 * u });
  return {
    T, S, ST, subtitle, inline, titleW, titleBase, subBase, headerBottom, sw, gap, legendTop, legendH,
    legendX, legendY, legendBox, cat, plates,
    metaBases, metaSize, metaTop, mark, chart, blocks, pad, W, H, avoid,
  };
}

function drawText(ctx, spec, L, u) {
  const { pad, W } = L;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  ctx.fillStyle = spec.ink;
  setFont(ctx, 700, L.T, SERIF, -L.T * 0.015);
  ctx.fillText(spec.title, pad, L.titleBase);
  ctx.fillStyle = spec.inkSoft;
  setFont(ctx, 500, L.S, SANS, L.S * 0.14);
  ctx.fillText(L.subtitle, L.inline ? pad + L.titleW + 30 * u : pad, L.subBase);

  if (spec.stamp) {
    ctx.textAlign = 'right';
    ctx.fillStyle = spec.ink;
    setFont(ctx, 700, L.ST, SERIF);
    ctx.fillText(spec.stamp, W - pad, L.titleBase);
    ctx.textAlign = 'left';
  }

  for (const p of L.plates) {
    const m = 14 * u;
    ctx.save();
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = spec.bg;
    ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 18 * u;
    ctx.beginPath();
    ctx.roundRect(p.x0 - m, p.y0 - m, p.x1 - p.x0 + 2 * m, p.y1 - p.y0 + 2 * m, 12 * u);
    ctx.fill();
    ctx.restore();
  }

  // legend
  const lx = L.legendX;
  let y = L.legendY + 17 * u;
  ctx.fillStyle = spec.ink;
  setFont(ctx, 500, 17 * u, SANS, 17 * u * 0.13);
  ctx.fillText(spec.legendTitle.toUpperCase(), lx, y);
  y += 16 * u;
  setFont(ctx, 500, 16 * u, SANS);
  if (L.cat) {
    const { rows, rowH, colW } = L.cat, r = 9 * u;
    ctx.textBaseline = 'middle';
    spec.swatches.forEach((s, i) => {
      const cx = lx + Math.floor(i / rows) * colW + r + 2 * u, cy = y + (i % rows) * rowH + rowH / 2;
      drawSwatch(ctx, cx, cy - 2 * u, r, 4 * u, s, u * 0.5);
      ctx.fillStyle = spec.ink;
      ctx.fillText(s.label, cx + r + 10 * u, cy);
    });
    ctx.textBaseline = 'alphabetic';
  } else {
    const r = L.sw / 2 - 4 * u, dz = 8 * u;
    ctx.textAlign = 'center';
    spec.swatches.forEach((s, i) => {
      const cx = lx + i * (L.sw + L.gap) + L.sw / 2;
      drawSwatch(ctx, cx, y + r, r, dz, s, u);
      ctx.fillStyle = spec.ink;
      ctx.fillText(s.label, cx, y + 2 * r + dz + 26 * u);
    });
  }

  // meta lines
  ctx.textAlign = 'left';
  ctx.fillStyle = spec.inkSoft;
  spec.meta.forEach((m, i) => {
    setFont(ctx, i ? 300 : 400, L.metaSize, SANS);
    ctx.fillText(m, pad, L.metaBases[i]);
  });

  if (L.chart) {
    const c = L.chart;
    drawTimelineChart(ctx, { ...spec.chart, ink: spec.ink, inkSoft: spec.inkSoft, accent: spec.accent }, c.x, c.y, c.w, c.h, 1.2 * u);
  }

  // NOMAD Data mark
  const m = L.mark;
  if (logo.naturalWidth) ctx.drawImage(logo, m.x, m.y, m.h, m.h);
  ctx.fillStyle = spec.ink;
  ctx.textBaseline = 'middle';
  setFont(ctx, 600, m.text, SANS, m.text * 0.16);
  ctx.fillText(MARK_TEXT, m.x + m.h + 12 * u, m.y + m.h / 2 + 1 * u);
  ctx.textBaseline = 'alphabetic';
}

// small hex prism, matching the on-screen legend swatches
function drawSwatch(ctx, cx, cy, r, dz, s, u) {
  const p = (deg, dy = 0) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180) + dy];
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 5 * u; ctx.shadowOffsetX = 6 * u; ctx.shadowOffsetY = 6 * u;
  poly([p(-90), p(-30), p(30, dz), p(90, dz), p(150, dz), p(210)], s.right);
  ctx.restore();
  poly([p(150), p(90), p(90, dz), p(150, dz)], s.left);
  poly([p(90), p(30), p(30, dz), p(90, dz)], s.right);
  poly([-90, -30, 30, 90, 150, 210].map((d) => p(d)), s.top);
}

// label positions relative to the anchor: centered above, right, left, high above
function labelOptions(ax, ay, w, h, u) {
  const lead = 22 * u;
  return [
    [ax - w / 2, ay - lead - h, ax, ay - lead + 2 * u],
    [ax + 12 * u, ay - lead - h + 4 * u, ax + 12 * u, ay - lead - h / 2 + 4 * u],
    [ax - 12 * u - w, ay - lead - h + 4 * u, ax - 12 * u, ay - lead - h / 2 + 4 * u],
    [ax - w / 2, ay - lead * 2.2 - h, ax, ay - lead * 2.2 + 2 * u],
  ];
}

function drawLabels(ctx, spec, cam, W, H, u, avoid) {
  if (!spec.labels.length || spec.nLabels <= 0) return;
  const size = 18 * u, minSep = Math.max(60 * u, Math.min(W, H) * 0.06);
  setFont(ctx, 600, size, SANS, size * 0.12);
  const v = new Vector3();
  const project = (lb) => {
    v.set(lb.x, lb._h ?? spec.heightOf(lb.cid), lb.y).project(cam);
    if (v.z >= 1 || Math.abs(v.x) >= 1 || Math.abs(v.y) >= 1) return null;
    return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
  };
  const out = [];
  const plan = spec.labelPlan;
  if (plan?.items) {
    // reuse the first frame's choices so labels never swap or jump between frames
    for (const { lb, opt } of plan.items) {
      const a = project(lb);
      if (!a) continue;
      const text = lb.name.toUpperCase(), w = ctx.measureText(text).width;
      const [lx, ly, ex, ey] = labelOptions(a[0], a[1], w, size, u)[opt];
      out.push({ text, lx, ly, ax: a[0], ay: a[1], ex, ey });
    }
  } else {
    const placed = [...avoid], anchors = [], items = [];
    // each label is tested over its column's whole height range; overlaps at any height drop the smaller town
    const at = (lb, hgt) => project({ ...lb, cid: lb.cid, _h: hgt });
    for (const lb of spec.labels) {
      if (out.length >= spec.nLabels) break;
      const a = project(lb);
      if (!a) continue;
      const [lo, hi] = spec.rangeOf ? spec.rangeOf(lb.cid) : [null, null];
      const aLo = lo == null ? a : at(lb, lo), aHi = hi == null ? a : at(lb, hi);
      if (!aLo || !aHi) continue;
      if (anchors.some(([x, y]) => [aLo, aHi].some(([px, py]) => Math.hypot(x - px, y - py) < minSep))) continue;
      const [ax, ay] = a;
      const text = lb.name.toUpperCase();
      const w = ctx.measureText(text).width, h = size;
      const opts = labelOptions(ax, ay, w, h, u);
      const oLo = labelOptions(aLo[0], aLo[1], w, h, u), oHi = labelOptions(aHi[0], aHi[1], w, h, u);
      for (let k = 0; k < opts.length; k++) {
        const [lx, ly, ex, ey] = opts[k];
        const box = {
          x0: Math.min(oLo[k][0], oHi[k][0]) - 5 * u, y0: Math.min(oLo[k][1], oHi[k][1]) - 3 * u,
          x1: Math.max(oLo[k][0], oHi[k][0]) + w + 5 * u, y1: Math.max(oLo[k][1], oHi[k][1]) + h + 3 * u,
        };
        if (box.x0 < 0 || box.y0 < 0 || box.x1 > W || box.y1 > H) continue;
        if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
        placed.push(box, {
          x0: Math.min(aLo[0], aHi[0]) - 3 * u, y0: Math.min(aLo[1], aHi[1], oLo[k][3], oHi[k][3]) - 3 * u,
          x1: Math.max(aLo[0], aHi[0]) + 3 * u, y1: Math.max(aLo[1], aHi[1]) + 3 * u,
        });
        anchors.push(aLo, aHi);
        items.push({ lb, opt: k });
        out.push({ text, lx, ly, ax, ay, ex, ey });
        break;
      }
    }
    if (plan) plan.items = items;
  }
  ctx.save();
  ctx.strokeStyle = spec.ink; ctx.fillStyle = spec.ink;
  ctx.shadowColor = spec.halo; ctx.shadowBlur = 3 * u;
  ctx.lineWidth = 1.8 * u;
  for (const o of out) {
    ctx.beginPath(); ctx.moveTo(o.ax, o.ay); ctx.lineTo(o.ex, o.ey); ctx.stroke();
    ctx.beginPath(); ctx.arc(o.ax, o.ay, 3 * u, 0, Math.PI * 2); ctx.fill();
  }
  ctx.textBaseline = 'top';
  for (const o of out) {
    ctx.shadowColor = spec.halo; ctx.shadowBlur = 10 * u;
    ctx.strokeStyle = spec.halo; ctx.lineWidth = 3.5 * u; ctx.lineJoin = 'round';
    ctx.strokeText(o.text, o.lx, o.ly);
    ctx.shadowBlur = 0;
    ctx.fillText(o.text, o.lx, o.ly);
  }
  ctx.restore();
}
