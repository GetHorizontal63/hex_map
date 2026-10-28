import { Raycaster, Vector2, Color } from 'three';
import { loadAll, pointInRegion, pointSet, STATE_GROUPS, STATE_ABBR, AK_SCALE } from './data.js';
import { Lattice, buildHexes, cellKey } from './hex.js';
import { hexElevation, elevationAvailable } from './elevation.js';
import { HexRenderer } from './render.js';
import { Labels } from './labels.js';
import { METRIC, SHOWN_METRICS, PALETTES, INK, rampColor, computeDomain, normalize, heightNorm, legendLabels, rampStops, buildLut, sampleLut, hexToLin, mixHex, luminance } from './scales.js';
import { RATIOS, renderPoster, posterSize, logoReady } from './export.js';
import { TIMELINES, TIMELINE, loadTimeline, timelineAvailable, cellCounties, cellMapping, frameValues, cellFrameValue } from './timeline.js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { drawTimelineChart } from './chart.js';
import { parseCsv, guessColumns, buildDataset, aggregate as aggregateCustom, customMetric, CAT_COLORS } from './custom.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const DEFAULTS = {
  metric: 'density', height: 'same', domain: 'focus',
  mode: 'nation', states: [], counties: [], hide: true,
  size: 15, auto: true, exag: 1, gap: 0.08, dur: 1800,
  pal: 'ember', colors: null, bg: null, ink: null, inv: false, theme: '',
  sunAz: 300, sunEl: 30, diff: 0.1, labels: true, nLabels: 8, title: '', tl: '',
  el: '', elh: 'votes', // election shown ("pres-2020"), and its column height
};
const state = { ...DEFAULTS, ...readHash() };
// only the measures the panel offers (older links may name others, or custom data)
if (!SHOWN_METRICS.includes(METRIC[state.metric])) state.metric = DEFAULTS.metric;
if (!['same', 'flat'].includes(state.height) && !SHOWN_METRICS.includes(METRIC[state.height])) state.height = 'same';

function readHash() {
  const out = {};
  const p = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of p) {
    if (!(k in DEFAULTS)) continue;
    const d = DEFAULTS[k];
    if (k === 'states' || k === 'counties') out[k] = v ? v.split(',') : [];
    else if (k === 'colors') out[k] = v.split(',').map((c) => '#' + c);
    else if (k === 'bg' || k === 'ink') out[k] = '#' + v;
    else if (typeof d === 'number') out[k] = +v;
    else if (typeof d === 'boolean') out[k] = v === '1';
    else out[k] = v;
  }
  return out;
}
function writeHash() {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) {
    const v = state[k], d = DEFAULTS[k];
    if (JSON.stringify(v) === JSON.stringify(d)) continue;
    if (k === 'metric' && v === 'custom') continue; // uploaded data stays in this browser
    if (k === 'auto' || k === 'size') continue;
    if (Array.isArray(v)) p.set(k, k === 'colors' ? v.map((c) => c.slice(1)).join(',') : v.join(','));
    else if (k === 'bg' || k === 'ink') p.set(k, v.slice(1));
    else if (typeof v === 'boolean') p.set(k, v ? '1' : '0');
    else p.set(k, v);
  }
  if (!state.auto) { p.set('auto', '0'); p.set('size', state.size); }
  history.replaceState(null, '', '#' + p.toString().replace(/%2C/g, ','));
}

const palette = () => PALETTES.find((p) => p.id === state.pal) || PALETTES[0];
// app theme: chosen with the sun/moon button, else the system setting
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const themeMode = () => state.theme || (systemDark.matches ? 'dark' : 'light');
const baseColors = () => state.colors || palette().colors;
// inverting flips the ramp end for end; the no-data grey stays first
const colors = () => (state.inv ? [baseColors()[0], ...baseColors().slice(1).reverse()] : baseColors());
const bgColor = () => state.bg || palette()[themeMode()];
const inkColor = () => state.ink || INK[themeMode()];

// ---------------------------------------------------------------- app
let data, renderer, labels;
let build = null;      // current hex build
let tractMap = null;   // tract -> cell assignment for the build
let view = null;       // focus info for the build
const valueCache = new Map();
const nationalCache = new Map();
let domains = null;

const setLoading = (text, busy = false) => {
  const el = $('loading');
  $('loadingText').textContent = text;
  el.classList.toggle('busy', busy);
  el.classList.remove('done');
};
const doneLoading = () => $('loading').classList.add('done');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function init() {
  applyTheme();
  try {
    data = await loadAll((t) => setLoading(t));
  } catch (e) {
    setLoading('Could not load data — ' + e.message);
    throw e;
  }
  renderer = new HexRenderer($('map'));
  labels = new Labels($('labels'));
  window.hexAtlas = { renderer }; // handy for debugging from the console
  onResize();
  window.addEventListener('resize', onResize);
  initUI();
  applyTheme();
  await document.fonts.ready;
  renderer.flyTo(renderer.framing([-300, -300, 1275, 900, 0], { tilt: 15 }), 0);
  await rebuild();
  doneLoading();
  requestAnimationFrame(frame);
}

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateViewShift();
  labels.measured = false;
  if (typeof timeline !== 'undefined') drawChart();
}

function updateViewShift() {
  const open = !document.body.classList.contains('panel-hidden') && window.innerWidth > 720;
  renderer.setViewShift(open ? ($('panel').offsetWidth + 14) / 2 : 0);
}

// ---------------------------------------------------------------- focus sets
function bboxOf(regions) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of regions) {
    b[0] = Math.min(b[0], r.bbox[0]); b[1] = Math.min(b[1], r.bbox[1]);
    b[2] = Math.max(b[2], r.bbox[2]); b[3] = Math.max(b[3], r.bbox[3]);
  }
  return b;
}
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const expand = (b, f) => {
  const dx = (b[2] - b[0]) * f, dy = (b[3] - b[1]) * f, m = Math.max(dx, dy);
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
};

function computeView() {
  const selStates = state.states.map((id) => data.stateById.get(id)).filter(Boolean);
  const selCounties = state.counties.map((id) => data.countyById.get(id)).filter(Boolean);
  let focus, context = [], kind = 'nation';
  if (state.mode === 'counties' && selCounties.length) {
    focus = selCounties; kind = 'counties';
    if (!state.hide) {
      const box = expand(bboxOf(focus), 0.45);
      context = data.counties.filter((c) => !focus.includes(c) && intersects(c.bbox, box));
    }
  } else if (state.mode !== 'nation' && selStates.length) {
    focus = selStates; kind = 'states';
    if (!state.hide) {
      const box = expand(bboxOf(focus), 0.45);
      context = data.states.filter((s) => !focus.includes(s) && intersects(s.bbox, box));
    }
  } else {
    focus = [data.nation];
  }
  const area = focus.reduce((s, r) => s + r.area, 0) + 0.35 * context.reduce((s, r) => s + r.area, 0);
  return { focus, context, kind, box: bboxOf(focus), area, selStates, selCounties };
}

// states whose block groups replace tracts for this view (none at national scale)
function blockGroupStates(v) {
  if (v.kind === 'states') return v.selStates.map((s) => s.id);
  if (v.kind === 'counties') return [...v.selCounties, ...v.context].map((c) => c.stateId);
  return [];
}

function autoSizeMiles(v) {
  const target = v.kind === 'nation' ? 16000 : v.kind === 'states' ? 4200 : 2600;
  const areaMi = v.focus.reduce((s, r) => s + r.area, 0) * data.miPerUnit ** 2;
  const w = Math.sqrt(areaMi / target / (Math.sqrt(3) / 2));
  return Math.min(80, Math.max(0.5, w < 2 ? Math.round(w * 4) / 4 : w < 10 ? Math.round(w * 2) / 2 : Math.round(w)));
}

function estimateHexes(v, miles) {
  const w = miles / data.miPerUnit;
  return Math.round(v.area / ((Math.sqrt(3) / 2) * w * w));
}

// ---------------------------------------------------------------- build
let buildToken = 0;
async function rebuild({ fly = true } = {}) {
  const token = ++buildToken;
  const v = computeView();
  if (state.auto) state.size = autoSizeMiles(v);
  syncSizeUI(v);
  const est = estimateHexes(v, state.size);
  setLoading(est > 60000 ? `Cutting ~${est.toLocaleString()} hexagons…` : 'Building…', true);
  await nextFrame();
  const points = await data.pointsFor(blockGroupStates(v));
  if (token !== buildToken) return;

  const R = state.size / data.miPerUnit / Math.sqrt(3);
  const lattice = new Lattice(R);
  const regions = [...v.focus.map((r) => ({ polys: r.polys, focus: true })), ...v.context.map((r) => ({ polys: r.polys, focus: false }))];
  const t0 = performance.now();
  build = buildHexes(regions, lattice, 1 - state.gap);
  view = v;
  console.info(`hex build: ${build.cellCount} cells, ${build.full.count} full, ${build.pieceCount} clipped pieces, ${(performance.now() - t0).toFixed(0)} ms`);
  renderer.setBuild(build);
  assignTracts(points);
  valueCache.clear();

  const [x0, y0, x1, y1] = v.box;
  view.extent = Math.max(x1 - x0, y1 - y0);
  if (timeline.active) prepareTimeline();
  recolor({ fromZero: true });

  const all = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < build.cellCount; i++) {
    all[0] = Math.min(all[0], build.cellX[i]); all[1] = Math.min(all[1], build.cellY[i]);
    all[2] = Math.max(all[2], build.cellX[i]); all[3] = Math.max(all[3], build.cellY[i]);
  }
  view.buildBox = all;
  fitLight();
  if (fly) fitView();
  updateLabelCandidates();
  updateText();
  $('hexCount').textContent = `${build.cellCount.toLocaleString()} hexagons · ${fmtMiles(state.size)} across`;
  writeHash();
  doneLoading();
}

function fitView(duration) {
  // keep the map clear of the title block (top) and the legend (bottom)
  const top = 1 - (2 * ($('titleBlock').getBoundingClientRect().bottom + 24)) / window.innerHeight;
  const bottom = -1 + (2 * (window.innerHeight - $('legend').getBoundingClientRect().top)) / window.innerHeight * 0.55;
  const W = window.innerWidth;
  const panelOpen = !document.body.classList.contains('panel-hidden') && W > 720;
  const right = panelOpen ? 1 - (2 * (W - $('panel').getBoundingClientRect().left + 16)) / W : 0.92;
  const box = [...view.box, view.maxH * 0.6];
  let pose = renderer.framing(box, { tilt: 46, region: [-0.92, right, bottom, top] });
  if (document.body.classList.contains('has-chart')) {
    // timeline chart + date in the bottom-right: fit the map above that block or beside it, whichever is larger
    const H = window.innerHeight, chart = $('tlChart').getBoundingClientRect();
    const blockTop = Math.min($('stamp').getBoundingClientRect().top, chart.top) - 12;
    const yTop = 1 - (2 * blockTop) / H, xLeft = -1 + (2 * (chart.left - 16)) / W;
    const above = renderer.framing(box, { tilt: 46, region: [-0.92, right, yTop, top] });
    const beside = renderer.framing(box, { tilt: 46, region: [-0.92, Math.min(right, xLeft), bottom, top] });
    pose = above.dist <= beside.dist ? above : beside;
  }
  renderer.flyTo(pose, duration);
}

function fitLight() {
  const b = view.buildBox;
  renderer.sunAzimuth = state.sunAz;
  renderer.sunElevation = state.sunEl;
  renderer.setDiffusion(state.diff);
  renderer.fitLight([b[0] - 5, b[1] - 5, b[2] + 5, b[3] + 5, view.maxH + view.base]);
}

function assignTracts(points) {
  tractMap = makeAggregation(points, build.lattice, build.keyToCell, build.cellCount, build.cellX, build.cellY);
}

// Map tracts to hex cells. Each cell gets the tracts whose centroid falls in it;
// any hex area those tracts don't cover is filled by a "background" tract (the
// size-weighted nearest tract outside the hex), which keeps small towns from
// painting a whole rural hex with their density.
function makeAggregation(T, lattice, keyToCell, cellCount, cellX, cellY) {
  const cellOf = new Int32Array(T.count);
  const start = new Uint32Array(cellCount + 1);
  for (let i = 0; i < T.count; i++) {
    const [q, r] = lattice.locate(T.x[i], T.y[i]);
    const c = keyToCell.get(cellKey(q, r));
    cellOf[i] = c === undefined ? -1 : c;
    if (c !== undefined) start[c + 1]++;
  }
  for (let c = 0; c < cellCount; c++) start[c + 1] += start[c];
  const fill = start.slice(0, -1), items = new Uint32Array(start[cellCount]);
  for (let i = 0; i < T.count; i++) if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i;

  const ak = data.stateById.get('02');
  const baseArea = lattice.area * data.miPerUnit ** 2;
  const areaMi = new Float32Array(cellCount), remainder = new Float32Array(cellCount);
  const bg = new Int32Array(cellCount).fill(-1);
  for (let c = 0; c < cellCount; c++) {
    const isAK = ak && pointInRegion(ak, cellX[c], cellY[c]);
    const A = isAK ? baseArea / AK_SCALE ** 2 : baseArea;
    let covered = 0;
    for (let j = start[c]; j < start[c + 1]; j++) covered += Math.min(T.area[items[j]], A);
    areaMi[c] = A;
    remainder[c] = Math.max(0, A - covered);
    if (remainder[c] > A * 0.02 || start[c] === start[c + 1]) {
      bg[c] = T.index.owner(cellX[c], cellY[c], (i) => cellOf[i] === c);
    }
  }
  return { points: T, count: cellCount, start, items, areaMi, remainder, bg };
}

// Density: area-weighted mean (tract areas capped at the hex area).
// Population (and votes cast): a total, each unit counted for the share of it the hex can hold.
// Everything else: population-weighted mean.
function aggregate(agg, id) {
  const T = agg.points, mv = T.metrics[id], isD = id === 'density';
  const { start, items, areaMi, remainder, bg } = agg;
  const out = new Float32Array(agg.count);
  if (id === 'population' || id === 'votes') {
    for (let c = 0; c < agg.count; c++) {
      let sum = 0;
      for (let j = start[c]; j < start[c + 1]; j++) {
        const i = items[j];
        sum += T.pop[i] * Math.min(1, areaMi[c] / Math.max(T.area[i], 1e-3));
      }
      const k = bg[c];
      if (k >= 0) sum += (T.pop[k] * (start[c] === start[c + 1] ? areaMi[c] : remainder[c])) / Math.max(T.area[k], 1e-3);
      out[c] = sum;
    }
    return out;
  }
  for (let c = 0; c < agg.count; c++) {
    let num = 0, den = 0;
    for (let j = start[c]; j < start[c + 1]; j++) {
      const i = items[j], v = mv[i];
      if (!Number.isFinite(v)) continue;
      const w = isD ? Math.max(1e-3, Math.min(T.area[i], areaMi[c])) : T.pop[i];
      num += v * w; den += w;
    }
    const k = bg[c];
    if (k >= 0 && Number.isFinite(mv[k])) {
      const rem = start[c] === start[c + 1] ? areaMi[c] : remainder[c];
      const w = isD ? rem : (T.pop[k] * rem) / Math.max(T.area[k], 1e-3);
      num += mv[k] * w; den += w;
      if (den === 0) { num = mv[k]; den = 1; }
    }
    out[c] = den > 0 ? num / den : NaN;
  }
  return out;
}

function cellValues(id) {
  if (id === 'elevation') return elevationValues();
  if (!valueCache.has(id)) valueCache.set(id, aggregate(tractMap, id));
  return valueCache.get(id);
}

// Elevation comes from its own grids: the national one, plus fine tiles once hexes are small. Until
// they arrive this returns what it has (or nothing) and recolors when they land.
function elevationValues() {
  if (valueCache.has('elevation')) return valueCache.get('elevation');
  const res = hexElevation(build, state.size < 6, () => {
    valueCache.delete('elevation');
    if (!timeline.active && !customActive() && !electionActive() && (state.metric === 'elevation' || state.height === 'elevation')) recolor({ duration: 600 });
  });
  if (!res) return new Float32Array(build.cellCount).fill(NaN);
  if (res.complete) valueCache.set('elevation', res.values);
  return res.values;
}

// National scale: the same aggregation over every hex holding a tract centroid, nation-wide.
let nationalAgg = null;
function nationalDomain(metric) {
  const key = metric.id + '@' + build.lattice.R;
  if (nationalCache.has(key)) return nationalCache.get(key);
  if (!nationalAgg || nationalAgg.R !== build.lattice.R) {
    const T = data.tracts, L = build.lattice, keyToCell = new Map(), xs = [], ys = [];
    for (let i = 0; i < T.count; i++) {
      const [q, r] = L.locate(T.x[i], T.y[i]);
      const k = cellKey(q, r);
      if (!keyToCell.has(k)) {
        keyToCell.set(k, xs.length);
        const [x, y] = L.center(q, r);
        xs.push(x); ys.push(y);
      }
    }
    nationalAgg = makeAggregation(T, L, keyToCell, xs.length, xs, ys);
    nationalAgg.R = L.R;
  }
  const dom = computeDomain(metric, aggregate(nationalAgg, metric.id));
  nationalCache.set(key, dom);
  return dom;
}

function domainFor(metric, values) {
  if (metric.fixedDomain) return metric.fixedDomain;
  if (state.domain === 'national') return nationalDomain(metric);
  const flags = build.cellFlags;
  function* focusVals() { for (let c = 0; c < values.length; c++) if (flags[c] & 1) yield values[c]; }
  return computeDomain(metric, focusVals());
}

// Heights for a metric with a fixed color scale (elevation): up from zero, to the top of the area in
// view (or a fixed 0-4,400 m nationally), so relief shows in flat states too.
function heightDomain(metric, values) {
  if (!metric.fixedDomain) return domainFor(metric, values);
  if (state.domain === 'national') return { kind: 'linear', lo: 0, hi: 4400, breaks: [NaN, 0, 1500, 3000, 4400], max: 4400 };
  const flags = build.cellFlags;
  function* focusVals() { for (let c = 0; c < values.length; c++) if (flags[c] & 1) yield values[c]; }
  return computeDomain({ scale: 'linear' }, focusVals(), { zero: true });
}

function recolor({ fromZero = false, duration = state.dur } = {}) {
  if (!build) return;
  const tl = timeline.active && timeline.mapping;
  let cm, hm, cv, cd, hv, hd, catColor = null;
  if (!tl && electionActive()) {
    ({ cm, hm, cv, cd, hv, hd } = electionLayers());
  } else if (!tl && customActive()) {
    ({ cm, hm, cv, cd, hv, hd, catColor } = customLayers());
  } else {
    cm = tl ? timeline.def : METRIC[state.metric];
    hm = tl ? cm : state.height === 'same' ? cm : state.height === 'flat' ? null : METRIC[state.height];
    cv = tl ? frameValues(timeline.def, timeline.data, timeline.mapping, build.cellCount, timeline.frame) : cellValues(cm.id);
    cd = tl ? timeline.domain : domainFor(cm, cv);
    hv = hm ? (hm === cm ? cv : cellValues(hm.id)) : null;
    hd = hm ? (hm === cm && !cm.fixedDomain ? cd : heightDomain(hm, hv)) : null;
    // COVID totals: like the timelines, height is the county rate spread over each hex's population
    // density (events per sq mi), so cities rise as peaks inside their county instead of a flat plateau
    if (hm?.peaks) {
      hv = perAreaValues(hm === cm ? cv : hv);
      const vals = [];
      for (let c = 0; c < hv.length; c++) if (build.cellFlags[c] & 1) vals.push(hv[c]);
      hd = computeDomain({ scale: 'log' }, vals);
    }
  }
  // county timelines: height is cases per sq mi, so cities rise as peaks inside their county
  if (tl && timeline.heightDomain) { hv = perAreaValues(cv); hd = timeline.heightDomain; }
  domains = { cm, cd, hm, hd };
  if (tl) timeline.values = cv;
  // timeline frames move in lockstep; data changes sweep across the map
  renderer.uniforms.uStagger.value = tl ? 0 : 1;

  const pal = colors();
  const lut = cd ? buildLut(cm.ramp ? cm.ramp.map(([v, c]) => [normalize(cd, v), c]) : rampStops(cd, pal)) : null;
  const zero = hexToLin(pal[0]);
  view.maxH = view.extent * (view.kind === 'nation' ? 0.1 : 0.2) * state.exag;
  view.base = view.extent * 0.0022;
  renderer.uniforms.uBase.value = view.base;
  // log-colored metrics use a square-root height scale so sparse areas stay low and cities spike

  const n = build.cellCount, target = new Float32Array(renderer.toData.length);
  for (let c = 0; c < n; c++) {
    const o = c * 4;
    const t = catColor ? NaN : normalize(cd, cv[c]), cc = catColor ? catColor(c) : null;
    if (cc) target.set(cc, o);
    else if (Number.isFinite(t)) sampleLut(lut, t, target, o);
    else { target[o] = zero[0]; target[o + 1] = zero[1]; target[o + 2] = zero[2]; }
    if (hm) {
      const th = heightNorm(hd, hv[c]);
      target[o + 3] = Number.isFinite(th) ? view.maxH * th : 0;
    } else target[o + 3] = view.extent * 0.004 * state.exag;
  }
  if (fromZero) renderer.toData.fill(0);
  renderer.transition(target, duration, [view.box[0], view.box[2]]);
  if (view.buildBox) fitLight();
  renderLegend();
  updateText();
  lastHover = '';
}

// ---------------------------------------------------------------- text, legend, theme
// the county preset (Appalachia) these county ids make up exactly, if any
function countyGroupOf(ids) {
  const key = [...ids].sort().join(',');
  return STATE_GROUPS.find((g) => g.counties && [...g.counties].sort().join(',') === key);
}

function stateNameList(list) {
  const ids = list.map((s) => s.id).sort().join(',');
  const g = STATE_GROUPS.find((g) => g.ids && [...g.ids].sort().join(',') === ids);
  if (g) return g.name;
  if (list.length === 1) return list[0].name;
  if (list.length === 2) return `${list[0].name} & ${list[1].name}`;
  if (list.length === 3) {
    const names = `${list[0].name}, ${list[1].name} & ${list[2].name}`;
    if (names.length <= 34) return names;
  }
  return `${list.length} States`;
}

function updateText() {
  if (!view) return;
  let title = 'United States', kicker = '';
  if (view.kind === 'states') title = stateNameList(view.selStates);
  if (view.kind === 'counties') {
    const cs = view.selCounties;
    const sts = [...new Set(cs.map((c) => c.stateName))];
    const g = countyGroupOf(cs.map((c) => c.id));
    title = g ? g.name : cs.length === 1 ? cs[0].name : `${cs.length} Counties`;
    kicker = sts.length === 1 ? sts[0] : `${sts.length} states`;
  }
  if (state.title) title = state.title;
  const cm = domains?.cm || METRIC[state.metric];
  let sub = cm.label;
  if (!timeline.active && (customActive() || electionActive())) {
    if (domains?.hm && domains.hm !== cm) sub += ` · height: ${domains.hm.label}`;
  } else if (!timeline.active && state.height !== 'same' && state.height !== 'flat') {
    const hm = METRIC[state.height];
    sub += ` · height: ${hm.peaks || hm.label}`;
  } else if (!timeline.active && state.height === 'same' && cm.peaks) sub += ` · height: ${cm.peaks}`;
  if (timeline.active && timeline.def.heightLabel) sub += ` · height: ${timeline.def.heightLabel}`;
  $('stamp').textContent = timeline.active ? timeline.data.stamps[Math.round(timeline.frame)] : '';
  drawChart();
  if (kicker) sub = `${kicker} · ${sub}`;
  $('title').textContent = title;
  $('subtitle').textContent = sub;
  $('titleBlock').classList.toggle('inline', title.length < 13 && window.innerWidth > 900 && !kicker);
  document.title = `${title} — ${cm.label}`;
  $('sourceText').textContent = `Source: ${sourceText()}`;
  const unit = !timeline.active && customActive() ? `${custom.agg?.mapped.toLocaleString('en-US') ?? 0} points`
    : electionActive() ? 'Precincts'
    : !timeline.active && state.metric === 'elevation' ? 'USGS 3DEP elevation (~30 m pixels)'
    : tractMap?.points.blockGroups ? 'Block groups' : 'Census tracts';
  $('sourceNote').textContent = `${unit} aggregated to ${fmtMiles(state.size)} hexagons`;
}

function sourceText() {
  const acs = `U.S. Census Bureau, ACS ${data.year - 4}–${data.year} 5-year estimates`;
  if (timeline.active) return timeline.def.source;
  if (electionActive()) return election.index.source;
  if (customActive()) return `${custom.ds.name} (custom data, ${custom.ds.n.toLocaleString('en-US')} points)`;
  const used = [METRIC[state.metric], state.height !== 'same' && state.height !== 'flat' ? METRIC[state.height] : null].filter(Boolean);
  const sources = [...new Set(used.map((m) => m.source || acs))];
  return sources.join('; ');
}

function fmtMiles(m) { return `${m < 2 ? m.toFixed(2).replace(/0$/, '') : m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)} mi`; }

function shade(hex, f) { return f < 0 ? mixHex(hex, '#000000', -f) : mixHex(hex, '#ffffff', f); }

function swatchSvg(color) {
  const r = 22, cx = 26, cy = 23, dz = 8;
  const v = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const top = [-90, -30, 30, 90, 150, 210].map(v);
  const [, , p30, p90, p150] = top;
  const pt = (p, dy = 0) => `${p[0].toFixed(2)},${(p[1] + dy).toFixed(2)}`;
  return `<svg viewBox="0 0 52 56">
    <polygon points="${pt(p150)} ${pt(p90)} ${pt(p90, dz)} ${pt(p150, dz)}" fill="${shade(color, -0.18)}"/>
    <polygon points="${pt(p90)} ${pt(p30)} ${pt(p30, dz)} ${pt(p90, dz)}" fill="${shade(color, -0.32)}"/>
    <polygon points="${top.map((p) => pt(p)).join(' ')}" fill="${color}"/>
  </svg>`;
}

// what the legend shows: a ramp of five hexes, or (categorical custom data) one hex per category
function legendInfo() {
  const { cm, cd } = domains;
  if (cm.kind === 'cat') return { title: cm.legend, kind: 'cat', items: cm.cats.map((k, i) => ({ color: CAT_COLORS[i], label: k })) };
  if (cm.ramp) {
    const last = cm.legendStops.length - 1;
    return { title: cm.legend, kind: 'ramp', items: cm.legendStops.map((v, i) => ({
      color: rampColor(cm.ramp, v), label: `${v.toLocaleString('en-US')}${i === last ? '+' : ''}`,
    })) };
  }
  const labelsTxt = legendLabels(cm, cd);
  return { title: cm.legend, kind: 'ramp', items: colors().map((c, i) => ({ color: c, label: labelsTxt[i] })) };
}

function renderLegend() {
  const L = legendInfo();
  $('legendTitle').textContent = L.title;
  $('legendSwatches').classList.toggle('cat', L.kind === 'cat');
  $('legendSwatches').innerHTML = L.items.map((it) => `<div class="swatch">${swatchSvg(it.color)}<span>${escapeHtml(it.label)}</span></div>`).join('');
}

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function applyTheme() {
  const bg = bgColor(), ink = inkColor(), pal = colors();
  const dark = luminance(bg) < 0.2;
  const s = document.documentElement.style;
  s.setProperty('--bg', bg);
  s.setProperty('--bg-edge', shade(bg, dark ? -0.35 : -0.07));
  s.setProperty('--ink', ink);
  s.setProperty('--ink-soft', ink + 'bb');
  s.setProperty('--halo', dark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)');
  s.setProperty('--panel', dark ? 'rgba(26,24,22,0.84)' : 'rgba(250,248,245,0.86)');
  s.setProperty('--panel-ink', dark ? '#f2eee8' : '#1c1916');
  s.setProperty('--panel-line', dark ? 'rgba(255,255,255,0.14)' : 'rgba(28,25,22,0.13)');
  s.setProperty('--panel-raised', dark ? '#3b3733' : '#ffffff');
  s.setProperty('--accent', baseColors()[palette().kind === 'div' && !state.colors ? 4 : 3]);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (renderer) {
    renderer.setTheme({ bg, shadowOpacity: dark ? 0.85 : 0.55, contextColor: mixHex(bg, ink, dark ? 0.22 : 0.16) });
  }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg);
}

// ---------------------------------------------------------------- labels
function updateLabelCandidates() {
  const cands = [];
  const isFocusRegion = (p) => view.kind === 'nation' || view.focus.some((r) => pointInRegion(r, p.x, p.y));
  for (const p of data.places) {
    const [q, r] = build.lattice.locate(p.x, p.y);
    const cid = build.keyToCell.get(cellKey(q, r));
    if (cid === undefined || !(build.cellFlags[cid] & 1)) continue;
    if (!isFocusRegion(p)) continue;
    // the pin sits on the center of the hex the city falls in
    cands.push({ name: p.name, pop: p.pop, x: build.cellX[cid], y: build.cellY[cid], cid });
    if (cands.length >= 80) break;
  }
  labels.setCandidates(cands);
}

function avoidRects() {
  const ids = ['titleBlock', 'legend', 'credit', 'source', 'stamp'];
  if (document.body.classList.contains('has-chart')) ids.push('tlChart');
  if (timeline.active) ids.push('timebar');
  ids.push('panelToggle', 'themeToggle');
  if (!document.body.classList.contains('panel-hidden')) ids.push('panel');
  return ids.map((id) => {
    const r = $(id).getBoundingClientRect();
    return { x0: r.left - 6, y0: r.top - 6, x1: r.right + 6, y1: r.bottom + 6 };
  });
}

// ---------------------------------------------------------------- picking
const raycaster = new Raycaster();
function pick(clientX, clientY) {
  if (!build) return null;
  const ndc = new Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, renderer.camera);
  const { origin: o, direction: d } = raycaster.ray;
  if (d.y >= -1e-4) return null;
  const top = view.maxH + view.base;
  const tGround = -o.y / d.y;
  let t = Math.max(0, (top - o.y) / d.y);
  const horiz = Math.hypot(d.x, d.z);
  const step = horiz > 1e-4 ? (build.lattice.R * 0.3) / horiz : (tGround - t) / 50;
  const L = build.lattice;
  for (; t <= tGround + step; t += step) {
    const tt = Math.min(t, tGround);
    const x = o.x + d.x * tt, y = o.y + d.y * tt, z = o.z + d.z * tt;
    const [q, r] = L.locate(x, z);
    const cid = build.keyToCell.get(cellKey(q, r));
    if (cid === undefined) continue;
    if (y <= renderer.cellHeight(cid, !!(build.cellFlags[cid] & 1)) || tt >= tGround) {
      // only count it if the point is actually within a built region
      const region = regionAt(x, z);
      if (region) return { cid, x, y: z, ...region };
    }
  }
  return null;
}

function regionAt(x, y) {
  const st = data.states.find((s) => pointInRegion(s, x, y));
  if (!st) return null;
  const county = data.counties.find((c) => c.stateId === st.id && pointInRegion(c, x, y));
  const focus = view.kind === 'nation' || view.focus.some((r) => (r.kind === 'state' ? r.id === st.id : county && r.id === county.id));
  const context = !focus && view.context.some((r) => (r.kind === 'state' ? r.id === st.id : county && r.id === county.id));
  if (!focus && !context) return null;
  return { state: st, county, focus };
}

function showTooltip(hit, cx, cy) {
  const tt = $('tooltip');
  if (!hit) { tt.hidden = true; return; }
  const { cm, hm } = domains;
  if (!timeline.active && electionActive()) return showElectionTooltip(hit, cx, cy);
  if (!timeline.active && customActive()) return showCustomTooltip(hit, cx, cy);
  const v = timeline.active ? timeline.values[hit.cid] : cellValues(cm.id)[hit.cid];
  let html = `<div class="tt-place">${hit.county ? hit.county.fullName : hit.state.name}</div>`;
  html += `<div class="tt-value">${Number.isFinite(v) ? cm.fmt(v) : 'No data'}</div><div class="tt-sub">${cm.label}</div>`;
  if (timeline.active) {
    if (timeline.heightDomain) {
      const pa = perAreaValues(timeline.values)[hit.cid];
      if (Number.isFinite(pa)) html += `<div class="tt-sub">≈ ${cm.fmt(pa)} ${timeline.def.heightLabel}</div>`;
    }
    html += `<div class="tt-sub">${timeline.data.labels[Math.round(timeline.frame)]}</div>`;
  }
  else if (hm && hm !== cm) {
    const hv = cellValues(hm.id)[hit.cid];
    html += `<div class="tt-sub">${hm.label}: ${Number.isFinite(hv) ? hm.fmt(hv) : 'No data'}</div>`;
  }
  if (!timeline.active && cm.peaks) {
    const pa = perAreaValues(cellValues(cm.id))[hit.cid];
    if (Number.isFinite(pa)) html += `<div class="tt-sub">≈ ${cm.fmt(pa)} ${cm.peaks}</div>`;
  }
  if (!timeline.active && cm.id !== 'density') {
    const dv = cellValues('density')[hit.cid];
    if (Number.isFinite(dv)) html += `<div class="tt-sub">${METRIC.density.fmt(dv)} people / sq mi</div>`;
  }
  tt.innerHTML = html;
  tt.hidden = false;
  const w = tt.offsetWidth, h = tt.offsetHeight;
  tt.style.left = Math.min(window.innerWidth - w - 10, cx + 16) + 'px';
  tt.style.top = Math.min(window.innerHeight - h - 10, cy + 16) + 'px';
}

function onMapClick(hit, ev) {
  if (!hit) return;
  const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
  const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  if (state.mode === 'counties') {
    if (!hit.county) return;
    state.counties = additive ? toggle(state.counties, hit.county.id) : [hit.county.id];
    if (!state.counties.length) return refreshFocus();
    if (!state.states.includes(hit.county.stateId) && !additive) state.states = [hit.county.stateId];
  } else {
    if (state.mode === 'nation') state.mode = 'states';
    state.states = additive ? toggle(state.states, hit.state.id) : [hit.state.id];
  }
  refreshFocus();
}

// ---------------------------------------------------------------- frame loop
let hover = null, lastHover = '';
function frame(now) {
  renderer.update(now);
  if (hover) {
    const key = `${hover.x},${hover.y},${renderer.camera.position.toArray().join()}`;
    if (key !== lastHover) {
      lastHover = key;
      const hit = pick(hover.x, hover.y);
      showTooltip(hit, hover.x, hover.y);
      $('map').style.cursor = hit ? 'pointer' : '';
    }
  }
  if (timeline.playing && now >= timeline.nextTick) tickTimeline(now);
  if (renderer.batch) { requestAnimationFrame(frame); return; }
  renderer.render();
  labels.update(renderer.camera, window.innerWidth, window.innerHeight,
    labelHeight, state.labels ? state.nLabels : 0, avoidRects(), !renderer.camTween, labelRange);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- UI
function sliderToMiles(s) { return 0.5 * Math.pow(160, s / 100); }
function milesToSlider(m) { return (100 * Math.log(m / 0.5)) / Math.log(160); }
function syncSizeUI(v = computeView()) {
  $('tileSize').value = milesToSlider(state.size);
  $('sizeOut').textContent = fmtMiles(state.size);
  $('autoSize').checked = state.auto;
  const est = estimateHexes(v, state.size);
  $('hexCount').textContent = `≈ ${est.toLocaleString()} hexagons` + (est > 250000 ? ' — this may be slow' : '');
}

function refreshFocus() {
  syncFocusUI();
  rebuild();
}

function syncFocusUI() {
  document.querySelectorAll('#focusMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.mode));
  $('search').placeholder = state.mode === 'counties' ? 'Search counties…' : state.mode === 'states' ? 'Search states…' : 'Search states or counties…';
  const chips = [];
  if (state.mode === 'states') state.states.forEach((id) => chips.push(['s', id, data.stateById.get(id)?.name]));
  // a county preset (Appalachia) is one chip, not hundreds
  const g = state.mode === 'counties' && countyGroupOf(state.counties);
  if (g) chips.push(['g', '', `${g.name} · ${state.counties.length} counties`]);
  else if (state.mode === 'counties') state.counties.forEach((id) => chips.push(['c', id, data.countyById.get(id)?.fullName]));
  $('chips').innerHTML = chips.filter((c) => c[2]).map(([k, id, name]) => `<span class="chip">${name}<button data-k="${k}" data-id="${id}" title="Remove">×</button></span>`).join('');
  $('focusHint').textContent = state.mode === 'counties'
    ? 'Click a county to focus it · Shift-click to add or remove.'
    : 'Click a state to focus it · Shift-click to add or remove.';
}

function initUI() {
  // metric selects
  const opts = SHOWN_METRICS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  $('metric').innerHTML = opts;
  // elevation needs its own build (scripts/elevation/); grey it out until then
  elevationAvailable().then((ok) => {
    const o = $('metric').querySelector('option[value="elevation"]');
    if (!ok && o) { o.disabled = true; o.textContent += ' (data not built)'; }
  });
  $('heightMetric').innerHTML = `<option value="same">Same as color</option><option value="flat">Flat</option>` + opts;
  $('metric').value = state.metric;
  $('heightMetric').value = state.height;
  $('metric').onchange = (e) => {
    state.metric = e.target.value;
    if (state.metric !== 'custom') custom.prevMetric = state.metric;
    syncMetricOptions(); recolor(); updateLabelsSoon(); writeHash();
  };
  $('heightMetric').onchange = (e) => { state.height = e.target.value; recolor(); writeHash(); };

  const seg = (id, key, after) => {
    document.querySelectorAll(`#${id} button`).forEach((b) => {
      b.classList.toggle('on', b.dataset.v === state[key]);
      b.onclick = () => {
        state[key] = b.dataset.v;
        document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b));
        after();
      };
    });
  };
  seg('domainMode', 'domain', () => { recolor(); writeHash(); });
  seg('focusMode', 'mode', () => {
    if (state.mode === 'nation') { state.states = []; state.counties = []; }
    refreshFocus();
  });

  // groups
  // one <optgroup> per section; option values stay indexes into STATE_GROUPS
  const sections = [...new Set(STATE_GROUPS.map((g) => g.section))];
  $('stateGroup').innerHTML += sections.map((s) => `<optgroup label="${s}">${STATE_GROUPS
    .map((g, i) => (g.section === s ? `<option value="${i}">${g.name}</option>` : '')).join('')}</optgroup>`).join('');
  $('stateGroup').onchange = (e) => {
    if (e.target.value === '') return;
    const g = STATE_GROUPS[+e.target.value];
    if (g.counties) {
      state.mode = 'counties';
      state.counties = g.counties.filter((id) => data.countyById.has(id));
      state.states = [...new Set(state.counties.map((id) => data.countyById.get(id).stateId))];
    } else {
      state.mode = 'states';
      state.counties = [];
      state.states = g.ids.filter((id) => data.stateById.has(id));
    }
    e.target.value = '';
    refreshFocus();
  };

  // search
  const search = $('search'), list = $('suggest');
  let results = [], active = 0;
  const choose = (item) => {
    if (item.kind === 'state') {
      if (state.mode === 'nation') { state.mode = 'states'; state.states = []; }
      if (state.mode === 'counties') { state.states = [item.id]; state.counties = []; }
      else state.states = state.states.includes(item.id) ? state.states : [...state.states, item.id];
    } else {
      if (state.mode !== 'counties') { state.mode = 'counties'; state.counties = []; }
      if (!state.counties.includes(item.id)) state.counties = [...state.counties, item.id];
      if (!state.states.includes(item.stateId)) state.states = [...state.states, item.stateId];
    }
    search.value = '';
    list.hidden = true;
    refreshFocus();
  };
  const renderList = () => {
    list.innerHTML = results.map((r, i) => {
      const sel = r.kind === 'state' ? state.states.includes(r.id) && state.mode === 'states' : state.counties.includes(r.id);
      return `<li data-i="${i}" class="${i === active ? 'active' : ''} ${sel ? 'sel' : ''}">${r.kind === 'state' ? r.name : r.fullName}</li>`;
    }).join('');
    list.hidden = !results.length;
  };
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    active = 0;
    if (!q) { results = []; return renderList(); }
    const st = state.mode === 'counties' ? [] : data.states.filter((s) => s.name.toLowerCase().includes(q) || STATE_ABBR[s.id]?.toLowerCase() === q);
    const ct = state.mode === 'states' ? [] : data.counties.filter((c) => c.fullName.toLowerCase().includes(q));
    const rank = (n) => (n.toLowerCase().startsWith(q) ? 0 : 1);
    st.sort((a, b) => rank(a.name) - rank(b.name));
    ct.sort((a, b) => rank(a.fullName) - rank(b.fullName));
    results = [...st.slice(0, 6), ...ct.slice(0, 14 - Math.min(6, st.length))];
    renderList();
  };
  search.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderList(); e.preventDefault(); }
    else if (e.key === 'Enter' && results[active]) choose(results[active]);
    else if (e.key === 'Escape') { list.hidden = true; search.blur(); }
  };
  list.onmousedown = (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(results[+li.dataset.i]); } };
  search.onblur = () => setTimeout(() => (list.hidden = true), 150);
  search.onfocus = () => search.value && search.oninput();

  $('chips').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.k === 'g') { state.counties = []; state.states = []; }
    else if (b.dataset.k === 's') state.states = state.states.filter((x) => x !== b.dataset.id);
    else state.counties = state.counties.filter((x) => x !== b.dataset.id);
    refreshFocus();
  };
  $('hideOthers').checked = state.hide;
  $('hideOthers').onchange = (e) => { state.hide = e.target.checked; rebuild({ fly: false }); };
  $('fitView').onclick = () => fitView();
  $('clearFocus').onclick = () => { state.mode = 'nation'; state.states = []; state.counties = []; refreshFocus(); };

  // A slider's value readout can be clicked and typed into. `shown()` is the value in the units the
  // readout uses (miles, %, s, °); `apply(n)` takes a typed number in those units. Enter or leaving
  // the box applies it, Escape puts the readout back.
  const typeable = (out, shown, apply) => {
    const b = $(out);
    b.title = 'Click to type a value';
    b.onclick = (e) => {
      e.preventDefault(); // inside a <label>: don't pass the click on to the slider
      if (b.querySelector('input')) return;
      const text = b.textContent;
      const box = document.createElement('input');
      box.type = 'text'; box.inputMode = 'decimal'; box.className = 'num-edit';
      box.value = +shown().toFixed(2);
      b.textContent = '';
      b.append(box);
      box.focus(); box.select();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        const n = parseFloat(box.value.replace(/[^\d.\-]/g, ''));
        box.remove();
        b.textContent = text;
        if (ok && Number.isFinite(n)) apply(n);
      };
      box.onkeydown = (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') { finish(false); e.stopPropagation(); }
      };
      box.onblur = () => finish(true);
      box.onclick = (e) => e.preventDefault();
    };
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // hex controls
  $('tileSize').oninput = (e) => { state.size = +sliderToMiles(+e.target.value).toFixed(2); state.auto = false; syncSizeUI(); };
  $('tileSize').onchange = () => rebuild({ fly: false });
  typeable('sizeOut', () => state.size, (n) => {
    state.size = +clamp(n, sliderToMiles(0), sliderToMiles(100)).toFixed(2);
    state.auto = false;
    syncSizeUI();
    rebuild({ fly: false });
  });
  $('autoSize').onchange = (e) => { state.auto = e.target.checked; rebuild({ fly: false }); };
  // `unit` converts state to the readout's units (1 when they're the same); typed values are
  // kept to the slider's range but not snapped to its step
  const slider = (id, key, out, fmt, onChange, live, unit = 1) => {
    const el = $(id);
    el.value = state[key];
    $(out).textContent = fmt(state[key]);
    el.oninput = () => { state[key] = +el.value; $(out).textContent = fmt(state[key]); live?.(); };
    el.onchange = () => { onChange?.(); writeHash(); };
    typeable(out, () => state[key] * unit, (n) => {
      let v = n / unit;
      if (id === 'sunAz') v = ((v % 360) + 360) % 360;
      if (+el.step >= 1) v = Math.round(v);
      state[key] = clamp(v, +el.min, +el.max);
      el.value = state[key];
      $(out).textContent = fmt(state[key]);
      live?.();
      onChange?.();
      writeHash();
    });
  };
  slider('exag', 'exag', 'exagOut', (v) => v.toFixed(2) + '×', () => recolor({ duration: 600 }));
  slider('gap', 'gap', 'gapOut', (v) => Math.round(v * 100) + '%', () => rebuild({ fly: false }), null, 100);
  slider('duration', 'dur', 'durOut', (v) => (v / 1000).toFixed(1) + ' s', null, null, 0.001);
  slider('sunAz', 'sunAz', 'sunAzOut', (v) => Math.round(v) + '°', null, fitLight);
  slider('sunEl', 'sunEl', 'sunElOut', (v) => Math.round(v) + '°', null, fitLight);
  slider('sunDiff', 'diff', 'diffOut', (v) => Math.round(v * 100) + '%', null, fitLight, 100);
  slider('labelCount', 'nLabels', 'labelOut', (v) => v);
  $('showLabels').checked = state.labels;
  $('showLabels').onchange = (e) => { state.labels = e.target.checked; $('labelCountRow').hidden = !state.labels; writeHash(); };
  $('labelCountRow').hidden = !state.labels;
  $('titleOverride').value = state.title;
  $('titleOverride').oninput = (e) => { state.title = e.target.value; updateText(); writeHash(); };

  // palettes & colors
  const palEl = $('palettes');
  const palButton = (p) => `<button class="pal" data-id="${p.id}" title="${p.name}">
    <span class="pbg">${p.colors.slice(1).map((c) => `<i style="background:${c}"></i>`).join('')}</span><span class="pname">${p.name}</span></button>`;
  palEl.innerHTML = PALETTES.filter((p) => p.kind !== 'div').map(palButton).join('')
    + '<p class="pal-head">Diverging</p>' + PALETTES.filter((p) => p.kind === 'div').map(palButton).join('');
  palEl.onclick = (e) => {
    const b = e.target.closest('.pal');
    if (!b) return;
    state.pal = b.dataset.id; state.colors = null; state.bg = null; state.ink = null;
    onPaletteChange();
  };
  document.querySelectorAll('.colors input[data-ci]').forEach((inp) => {
    inp.oninput = () => {
      const c = [...baseColors()], i = +inp.dataset.ci;
      c[state.inv && i ? 5 - i : i] = inp.value;
      state.colors = c;
      onPaletteChange(300);
    };
  });
  $('bgColor').oninput = (e) => { state.bg = e.target.value; onPaletteChange(0); };
  $('inkColor').oninput = (e) => { state.ink = e.target.value; onPaletteChange(0); };
  $('invertColors').onchange = (e) => { state.inv = e.target.checked; onPaletteChange(); };
  // light / dark: a new theme brings its own paper and text, so custom ones are dropped
  $('themeToggle').onclick = () => {
    state.theme = themeMode() === 'dark' ? 'light' : 'dark';
    state.bg = null; state.ink = null;
    onPaletteChange(0);
  };
  systemDark.addEventListener('change', () => { if (!state.theme && !state.bg) onPaletteChange(0); });
  syncPaletteUI();

  // export / share
  initExport();
  initCustom();
  initTimeline();
  initPanel();
  $('copyLink').onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); flash($('copyLink'), 'Copied!'); }
    catch { flash($('copyLink'), 'Copy failed'); }
  };

  // panel
  const togglePanel = () => {
    document.body.classList.toggle('panel-hidden');
    document.body.classList.toggle('poster', document.body.classList.contains('panel-hidden'));
    updateViewShift();
    if (view) fitView(700);
  };
  $('panelToggle').onclick = togglePanel;
  if (window.innerWidth < 720) togglePanel();
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'h' || e.key === 'H') togglePanel();
    if (e.key === ' ' && timeline.active) { e.preventDefault(); $('tlPlay').click(); }
    if (e.key === 'f' || e.key === 'F') $('fitView').click();
  });

  // map interaction
  const canvas = $('map');
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && performance.now() - down.t < 600) {
      onMapClick(pick(e.clientX, e.clientY), e);
    }
    down = null;
  });
  canvas.addEventListener('pointermove', (e) => { hover = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerleave', () => { hover = null; showTooltip(null); });

  syncFocusUI();
  syncSizeUI();
}

// ---------------------------------------------------------------- poster export
function posterSpec() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const L = legendInfo();
  return {
    title: $('title').textContent, subtitle: $('subtitle').textContent,
    legendTitle: L.title, legendKind: L.kind,
    swatches: L.items.map(({ color: c, label }) => ({ top: c, left: shade(c, -0.18), right: shade(c, -0.32), label })),
    meta: [$('sourceText').textContent, $('sourceNote').textContent],
    bg: v('--bg'), bgEdge: v('--bg-edge'), ink: v('--ink'), inkSoft: v('--ink-soft'), halo: v('--halo'), accent: v('--accent'),
    box: [...view.box, view.maxH * 0.85],
    labels: state.labels ? labels.items.map(({ name, x, y, cid }) => ({ name, x, y, cid })) : [],
    nLabels: state.nLabels,
    heightOf: labelHeight,
    rangeOf: labelRange,
    outline: focusOutline(),
    stamp: $('stamp').textContent,
    stampAll: timeline.active ? timeline.data.stamps : null,
    chart: timeline.active && timeline.chart ? { ...timeline.chart, frame: timeline.frame } : null,
  };
}

// Framing adjustments per poster shape, made in the editor; reset when the focus changes.
const exportAdjust = { key: '', byRatio: new Map() };
function adjustFor(ratio) {
  const key = view ? view.box.join(',') : '';
  if (exportAdjust.key !== key) { exportAdjust.key = key; exportAdjust.byRatio.clear(); }
  return exportAdjust.byRatio.get(ratio.join(':')) || null;
}
const exportSlug = () => `${$('title').textContent}-${domains.cm.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function initExport() {
  const modal = $('exportModal'), grid = $('exportGrid');
  let token = 0, results = [];
  const download = (r) => {
    const a = document.createElement('a');
    a.href = r.url;
    a.download = `${exportSlug()}-${r.ratio.join('x')}.png`;
    a.click();
  };
  const clear = () => { results.forEach((r) => r && URL.revokeObjectURL(r.url)); results = []; };

  async function renderCard(i, spec, long, t) {
    const canvas = renderPoster(renderer, spec, RATIOS[i], long, adjustFor(RATIOS[i]));
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (t !== token) return;
    if (results[i]) URL.revokeObjectURL(results[i].url);
    results[i] = { ratio: RATIOS[i], url: URL.createObjectURL(blob) };
    const card = grid.children[i];
    card.querySelector('.xthumb').innerHTML = `<img alt="${RATIOS[i].join(':')} poster preview" src="${results[i].url}">`;
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    card.classList.toggle('adjusted', !!adjustFor(RATIOS[i]));
  }

  async function generate() {
    await logoReady;
    const t = ++token;
    clear();
    const long = +$('exportSize').value;
    $('exportAll').disabled = true;
    grid.innerHTML = RATIOS.map((r, i) => {
      const [w, h] = posterSize(r, long);
      return `<figure class="xcard"><div class="xthumb"><div class="spinner"></div></div>
        <figcaption><b>${r[0]}:${r[1]}</b><span>${w} × ${h} px</span>
        <button class="xbtn ghost" data-adjust="${i}" disabled>Adjust</button><button class="xbtn" data-i="${i}" disabled>Download</button></figcaption></figure>`;
    }).join('');
    const spec = posterSpec();
    for (let i = 0; i < RATIOS.length; i++) {
      await nextFrame();
      if (t !== token) return;
      await renderCard(i, spec, long, t);
    }
    $('exportAll').disabled = false;
  }

  const close = () => { token++; modal.hidden = true; clear(); };
  $('savePng').onclick = () => { modal.hidden = false; generate(); };
  $('exportSize').onchange = generate;
  $('exportClose').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && $('editModal').hidden) close(); });
  grid.onclick = (e) => {
    const adj = e.target.closest('button[data-adjust]');
    if (adj) {
      const i = +adj.dataset.adjust;
      openFramingEditor(RATIOS[i], () => renderCard(i, posterSpec(), +$('exportSize').value, token));
      return;
    }
    const b = e.target.closest('button[data-i]');
    if (b && results[+b.dataset.i]) download(results[+b.dataset.i]);
  };
  $('exportAll').onclick = async () => {
    for (const r of results) { download(r); await new Promise((res) => setTimeout(res, 250)); }
  };
  initFramingEditor();
}

// The framing editor: a live poster preview you can drag to orbit, right-drag (or Shift-drag) to
// pan, scroll to zoom, and where the legend and chart can be dragged into place.
let editor = null;
function openFramingEditor(ratio, onDone) {
  const key = ratio.join(':');
  const start = adjustFor(ratio);
  editor = {
    ratio, key, onDone,
    adj: start ? structuredClone(start) : { cam: { yaw: 0, tilt: 0, zoom: 1, px: 0, py: 0 }, legend: { dx: 0, dy: 0 }, chart: { dx: 0, dy: 0 } },
    spec: posterSpec(), hit: null, dirty: true,
  };
  editor.spec.labelPlan = null;
  $('editTitle').textContent = `Adjust ${ratio[0]}:${ratio[1]} framing`;
  $('editModal').hidden = false;
  renderer.beginBatch();
  requestAnimationFrame(drawEditor);
}

function drawEditor() {
  if (!editor) return;
  if (editor.dirty) {
    editor.dirty = false;
    const el = $('editCanvas'), box = $('editStage').getBoundingClientRect();
    const [rw, rh] = editor.ratio;
    // fit the preview inside the stage, render it at screen resolution (capped for speed)
    const scale = Math.min(box.width / rw, box.height / rh);
    const cw = Math.floor(rw * scale), ch = Math.floor(rh * scale);
    el.style.width = cw + 'px'; el.style.height = ch + 'px';
    const long = Math.min(1400, Math.round(Math.max(cw, ch) * Math.min(window.devicePixelRatio || 1, 1.5)));
    const poster = renderPoster(renderer, editor.spec, editor.ratio, long, editor.adj);
    el.width = poster.width; el.height = poster.height;
    el.getContext('2d').drawImage(poster, 0, 0);
    editor.hit = poster.hit;
  }
  requestAnimationFrame(drawEditor);
}

function initFramingEditor() {
  const el = $('editCanvas');
  let drag = null;
  const toPoster = (e) => {
    const r = el.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * editor.hit.W, ((e.clientY - r.top) / r.height) * editor.hit.H];
  };
  const inside = (b, [x, y]) => b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    if (!editor?.hit) return;
    el.setPointerCapture(e.pointerId);
    const p = toPoster(e);
    const what = inside(editor.hit.legend, p) ? 'legend' : inside(editor.hit.chart, p) ? 'chart'
      : e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    drag = { what, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointermove', (e) => {
    if (!editor?.hit) return;
    if (!drag) {
      const p = toPoster(e);
      el.style.cursor = inside(editor.hit.legend, p) || inside(editor.hit.chart, p) ? 'move' : 'grab';
      return;
    }
    const r = el.getBoundingClientRect();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    const c = editor.adj.cam;
    if (drag.what === 'legend' || drag.what === 'chart') {
      editor.adj[drag.what].dx += dx / r.width;
      editor.adj[drag.what].dy += dy / r.height;
    } else if (drag.what === 'pan') {
      // about half the camera distance spans the poster's width at this field of view
      const k = 0.5 / c.zoom;
      c.px -= (dx / r.width) * k * (r.width / r.height);
      c.py += (dy / r.height) * k * 1.4;
    } else {
      c.yaw += dx * 0.35;
      c.tilt = Math.min(38, Math.max(-42, c.tilt + dy * 0.25));
    }
    editor.dirty = true;
  });
  const end = () => { drag = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    if (!editor) return;
    e.preventDefault();
    editor.adj.cam.zoom = Math.min(8, Math.max(0.4, editor.adj.cam.zoom * Math.exp(-e.deltaY * 0.0015)));
    editor.dirty = true;
  }, { passive: false });
  $('editReset').onclick = () => {
    editor.adj = { cam: { yaw: 0, tilt: 0, zoom: 1, px: 0, py: 0 }, legend: { dx: 0, dy: 0 }, chart: { dx: 0, dy: 0 } };
    editor.dirty = true;
  };
  const finish = (keep) => {
    if (!editor) return;
    const ed = editor;
    editor = null;
    renderer.endBatch();
    $('editModal').hidden = true;
    if (keep) {
      const a = ed.adj, c = a.cam;
      const isDefault = !c.yaw && !c.tilt && c.zoom === 1 && !c.px && !c.py && !a.legend.dx && !a.legend.dy && !a.chart.dx && !a.chart.dy;
      adjustFor(ed.ratio);
      if (isDefault) exportAdjust.byRatio.delete(ed.key); else exportAdjust.byRatio.set(ed.key, a);
      ed.onDone?.();
    }
  };
  $('editDone').onclick = () => finish(true);
  $('editCancel').onclick = () => finish(false);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editor) finish(false); });
  window.addEventListener('resize', () => { if (editor) editor.dirty = true; });
}

// ---------------------------------------------------------------- panel: tabs and the "Show" switch
// Show = census measures | an election | a timeline | the user's own CSV. Only one drives the map at a time.
let sourceView = 'census';

function syncSource(v = sourceView) {
  sourceView = v;
  document.querySelectorAll('#sourceMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.src').forEach((el) => (el.hidden = el.dataset.src !== v));
  const canGif = timeline.active;
  $('exportGif').disabled = !canGif;
  $('exportGifHint').innerHTML = canGif ? `Animates <b>${escapeHtml(timeline.def.label)}</b> with the date on every frame.`
    : 'Choose <b>Over time</b> on the Map tab to animate a timeline.';
}

async function chooseSource(v) {
  if (v === sourceView) return;
  if (v !== 'time' && timeline.active) await setTimeline('');
  if (v !== 'custom' && state.metric === 'custom') state.metric = custom.prevMetric || 'density';
  if (v === 'custom' && custom.ds) state.metric = 'custom';
  if (v !== 'elections' && state.el) { state.el = ''; usePalette(null); }
  syncSource(v);
  if (v === 'elections') return setElection(state.el || defaultElection());
  syncMetricOptions();
  if (v === 'time') {
    const first = [...$('timelineSel').options].find((o) => !o.disabled);
    if (first) await setTimeline(first.value);
    syncSource('time');
  } else {
    recolor();
    writeHash();
  }
  if (v === 'custom' && !custom.ds) $('customOpen').focus();
}

function initPanel() {
  const tabs = document.querySelectorAll('.tabs button');
  const show = (name) => {
    tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
    try { localStorage.setItem('hexmap.tab', name); } catch { /* storage may be blocked */ }
  };
  tabs.forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  let saved = null;
  try { saved = localStorage.getItem('hexmap.tab'); } catch { /* ignore */ }
  if (saved && document.querySelector(`.tabs button[data-tab="${saved}"]`)) show(saved);

  document.querySelectorAll('#sourceMode button').forEach((b) => (b.onclick = () => chooseSource(b.dataset.v)));
  $('exportGif').onclick = () => { if (timeline.active) $('tlGif').click(); };
  syncSource(state.tl ? 'time' : 'census');
  initElections();
}

// ---------------------------------------------------------------- elections
// Precinct results (data/elections/, see scripts/elections/), summed into hexes like census tracts.
// Color is the margin, Republican minus Democratic share of all votes, on a fixed D+60..R+60 scale so
// any two maps compare; height is votes cast. States that didn't hold the race stay grey.
const RACES = { pres: 'Presidential Election', sen: 'U.S. Senate', gov: 'Governor' };
const margin = (d) => (v) => (Math.abs(v) < 0.05 ? 'Even' : `${v < 0 ? 'D' : 'R'}+${(+Math.abs(v).toFixed(d)).toLocaleString('en-US')}`);
const MARGIN_DOMAIN = { kind: 'linear', lo: -60, hi: 60, breaks: [NaN, -60, -20, 20, 60], max: 60 };
const election = { index: null, years: new Map(), agg: null, aggKey: '', results: new Map() };

const parseElection = (v) => { const [race, y] = (v || '').split('-'); return { race, year: +y }; };
const electionActive = () => !!state.el && !timeline.active && election.years.get(parseElection(state.el).year)?.ready === true;
function defaultElection() {
  const years = election.index?.years || [];
  const last = [...years].reverse().find((y) => y.races.pres) || years[years.length - 1];
  return last ? `${last.races.pres ? 'pres' : Object.keys(last.races)[0]}-${last.year}` : '';
}

// one year's precincts: shared positions and areas, per-race weights (votes) and margins
function loadElectionYear(year) {
  if (!election.years.has(year)) {
    const entry = { ready: false };
    entry.promise = fetch(`data/elections/${year}.json`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j) return null;
      const x = new Float32Array(j.n), y = new Float32Array(j.n);
      for (let i = 0; i < j.n; i++) { x[i] = j.x[i] / 100; y[i] = j.y[i] / 100; }
      entry.base = pointSet({ x, y, area: Float32Array.from(j.a), state: Uint8Array.from(j.s), pop: null, metrics: {} }, data.miPerUnit);
      entry.races = {};
      for (const [race, v] of Object.entries(j.races)) {
        const m = new Float32Array(j.n);
        for (let i = 0; i < j.n; i++) m[i] = v.t[i] > 0 ? ((v.r[i] - v.d[i]) / v.t[i]) * 100 : NaN;
        entry.races[race] = { pop: Float32Array.from(v.t), metrics: { margin: m } };
      }
      entry.ready = true;
      return entry;
    }).catch(() => null);
    election.years.set(year, entry);
  }
  return election.years.get(year).promise;
}

async function setElection(v) {
  const { race, year } = parseElection(v);
  if (!race || !year) return;
  if (!election.years.get(year)?.ready) {
    setLoading('Loading election results…', true);
    const ok = await loadElectionYear(year);
    doneLoading();
    if (!ok) { $('elHint').textContent = `${year} results aren't built yet; see the README.`; return; }
  }
  state.el = `${race}-${year}`;
  if (state.metric === 'custom') state.metric = custom.prevMetric || 'density';
  usePalette('rdbu');
  syncSource('elections');
  syncElectionUI();
  recolor();
  updateLabelsSoon();
  writeHash();
}

function electionLayers() {
  const { race, year } = parseElection(state.el);
  const Y = election.years.get(year);
  const key = `${year}|${build.cellCount}|${build.lattice.R}`;
  if (election.aggBuild !== build || election.aggKey !== key) {
    election.agg = makeAggregation(Y.base, build.lattice, build.keyToCell, build.cellCount, build.cellX, build.cellY);
    election.aggBuild = build; election.aggKey = key;
    election.results.clear();
  }
  if (!election.results.has(race)) {
    const a = { ...election.agg, points: { ...Y.base, ...Y.races[race] } };
    const res = { margin: aggregate(a, 'margin'), votes: aggregate(a, 'votes') };
    // hexes without a precinct of their own borrow the nearest one, which can sit across a state line:
    // a state that didn't hold this race (or has no data this year) stays "No race"
    if (countyCells?.build !== build) countyCells = { build, map: cellCounties(build, data.counties) };
    const held = new Set(election.index.years.find((y) => y.year === year).races[race]);
    for (let c = 0; c < build.cellCount; c++) {
      const ci = countyCells.map[c];
      if (ci >= 0 && !held.has(STATE_ABBR[data.counties[ci].stateId])) { res.margin[c] = NaN; res.votes[c] = 0; }
    }
    election.results.set(race, res);
  }
  const res = election.results.get(race);
  const cm = { id: 'election', label: `${year} ${RACES[race]}`, legend: 'Vote margin', fmt: margin(1), short: margin(0), naLabel: 'No race' };
  let hm = null, hv = null, hd = null;
  if (state.elh === 'votes') {
    hm = { label: 'votes cast', fmt: (v) => Math.round(v).toLocaleString('en-US') };
    hv = res.votes;
    const vals = [];
    for (let c = 0; c < hv.length; c++) if (build.cellFlags[c] & 1) vals.push(hv[c]);
    hd = computeDomain({ scale: 'log' }, vals);
  }
  return { cm, hm, cv: res.margin, cd: MARGIN_DOMAIN, hv, hd };
}

function showElectionTooltip(hit, cx, cy) {
  const tt = $('tooltip'), { race } = parseElection(state.el), res = election.results.get(race);
  const v = res.margin[hit.cid], votes = res.votes[hit.cid];
  let html = `<div class="tt-place">${hit.county ? hit.county.fullName : hit.state.name}</div>`;
  html += `<div class="tt-value">${Number.isFinite(v) ? domains.cm.fmt(v) : 'No race'}</div><div class="tt-sub">${domains.cm.label}</div>`;
  if (votes > 0) html += `<div class="tt-sub">${Math.round(votes).toLocaleString('en-US')} votes cast</div>`;
  tt.innerHTML = html;
  tt.hidden = false;
  const w = tt.offsetWidth, h = tt.offsetHeight;
  tt.style.left = Math.min(window.innerWidth - w - 10, cx + 16) + 'px';
  tt.style.top = Math.min(window.innerHeight - h - 10, cy + 16) + 'px';
}

// Race and year pickers; a year notes when its data covers only some states.
function syncElectionUI() {
  const idx = election.index;
  if (!idx) return;
  const { race, year } = parseElection(state.el || defaultElection());
  const races = Object.keys(RACES).filter((r) => idx.years.some((y) => y.races[r]));
  $('elRace').innerHTML = races.map((r) => `<option value="${r}">${RACES[r]}</option>`).join('');
  $('elRace').value = race;
  const all = Object.values(STATE_ABBR);
  const years = idx.years.filter((y) => y.races[race]);
  $('elYear').innerHTML = years.map((y) => {
    const missing = all.filter((a) => !y.states.includes(a));
    const note = y.states.length <= 5 ? ` (${y.states.join(', ')} only)` : missing.length ? ` (no ${missing.join(', ')})` : '';
    return `<option value="${y.year}">${y.year}${note}</option>`;
  }).reverse().join('');
  $('elYear').value = year;
  $('elHeight').value = state.elh;
  const n = years.find((e) => e.year === year)?.races[race]?.length || 0;
  $('elHint').textContent = (race === 'pres' ? '' : `${n} ${n === 1 ? 'state' : 'states'} held this race; the rest stay grey. `)
    + 'Margin is the Republican minus the Democratic share of all votes.';
}

async function initElections() {
  election.index = await fetch('data/elections/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const btn = document.querySelector('#sourceMode button[data-v="elections"]');
  if (!election.index?.years.length) { btn.disabled = true; btn.title = 'Election data not built yet'; return; }
  $('elRace').onchange = () => {
    // keep the year if this race was held then, else take its latest
    const race = $('elRace').value, year = +$('elYear').value;
    const years = election.index.years.filter((y) => y.races[race]).map((y) => y.year);
    setElection(`${race}-${years.includes(year) ? year : years[years.length - 1]}`);
  };
  $('elYear').onchange = () => setElection(`${$('elRace').value}-${$('elYear').value}`);
  $('elHeight').onchange = (e) => { state.elh = e.target.value; recolor(); writeHash(); };
  syncElectionUI();
  if (state.el && !state.tl) setElection(state.el);
}

// ---------------------------------------------------------------- custom data
// options: colorBy 'c1' | 'count'; agg 'mean' | 'sum' (numeric category 1); height 'count' | 'c2' |
// 'color' | 'flat'; filter = category 2 code to keep (categorical category 2), -1 = all
const custom = { ds: null, agg: null, aggKey: '', colorBy: 'c1', aggFn: 'mean', height: 'count', filter: -1, prevMetric: 'density' };
const customActive = () => !!custom.ds && state.metric === 'custom';

function customLayers() {
  const ds = custom.ds;
  const key = `${build.cellCount}|${build.lattice.R}|${custom.filter}`;
  if (custom.aggBuild !== build || custom.aggKey !== key) {
    custom.agg = aggregateCustom(ds, build, { filter: custom.filter });
    custom.aggBuild = build; custom.aggKey = key;
  }
  const a = custom.agg, n = build.cellCount;
  const inFocus = (arr) => { const out = []; for (let c = 0; c < n; c++) if (build.cellFlags[c] & 1) out.push(arr[c]); return out; };
  const counts = a.count.map((v) => v || NaN);
  // counts are whole numbers starting at zero: a linear scale from 0 reads 0 / 10 / 20 / 30+
  const countMetric = { ...customMetric('Point count', 'Points per hex'), scale: 'linear', naLabel: 'None' };
  const countDomain = () => computeDomain(countMetric, inFocus(counts), { zero: true });
  let cm, cv, cd = null, catColor = null;
  if (custom.colorBy === 'count') {
    cm = countMetric; cv = counts; cd = countDomain();
  } else if (ds.c1.kind === 'cat') {
    const lin = ds.c1.cats.map((_, i) => hexToLin(CAT_COLORS[i]));
    cm = { id: 'custom', kind: 'cat', label: `Most common ${ds.c1.name}`, legend: ds.c1.name, cats: ds.c1.cats, fmt: String };
    cv = a.topShare;
    catColor = (c) => (a.top[c] >= 0 ? lin[a.top[c]] : null);
  } else {
    const sum = custom.aggFn === 'sum';
    cv = sum ? a.sum1 : a.mean1;
    cm = { ...customMetric(ds.c1.name, `${ds.c1.name}, ${sum ? 'total' : 'average'} per hex`,
      { percent: ds.c1.percent && !sum, values: inFocus(cv) }), naLabel: 'No points' };
    cd = computeDomain(cm, inFocus(cv));
  }
  let hm = null, hv = null, hd = null;
  const h = custom.height;
  if (h === 'count' || (h === 'color' && (cm.kind === 'cat' || cm === countMetric))) {
    // counts are skewed (a metro holds hundreds of points): square-root heights keep small towns visible
    hm = countMetric; hv = counts; hd = computeDomain({ scale: 'log' }, inFocus(counts));
  } else if (h === 'c2' && a.mean2) {
    hm = customMetric(ds.c2.name, ds.c2.name, { percent: ds.c2.percent, values: inFocus(a.mean2) });
    hv = a.mean2; hd = computeDomain(hm, inFocus(hv));
  } else if (h === 'color') {
    hm = cm; hv = cv; hd = cd;
  }
  return { cm, hm, cv, cd, hv, hd, catColor };
}

function showCustomTooltip(hit, cx, cy) {
  const tt = $('tooltip'), a = custom.agg, ds = custom.ds, c = hit.cid, { cm } = domains;
  let html = `<div class="tt-place">${hit.county ? hit.county.fullName : hit.state.name}</div>`;
  const pts = a.count[c];
  if (!pts) html += `<div class="tt-value">No points</div>`;
  else if (custom.colorBy === 'count') html += `<div class="tt-value">${pts.toLocaleString('en-US')}</div><div class="tt-sub">points in this hex</div>`;
  else if (cm.kind === 'cat') {
    html += `<div class="tt-value">${escapeHtml(ds.c1.cats[a.top[c]])}</div><div class="tt-sub">${Math.round(a.topShare[c] * 100)}% of ${pts.toLocaleString('en-US')} points</div>`;
    const others = ds.c1.cats.map((k, i) => [k, a.cat1[c * a.k1 + i]]).filter(([, v]) => v).sort((x, y) => y[1] - x[1]).slice(1, 4);
    if (others.length) html += `<div class="tt-sub">Also: ${others.map(([k, v]) => `${escapeHtml(k)} ${v}`).join(', ')}</div>`;
  } else {
    const v = (custom.aggFn === 'sum' ? a.sum1 : a.mean1)[c];
    html += `<div class="tt-value">${Number.isFinite(v) ? cm.fmt(v) : 'No data'}</div><div class="tt-sub">${escapeHtml(cm.legend)}</div>`;
    html += `<div class="tt-sub">${pts.toLocaleString('en-US')} points</div>`;
  }
  if (pts && a.mean2 && custom.height === 'c2' && Number.isFinite(a.mean2[c])) html += `<div class="tt-sub">${escapeHtml(ds.c2.name)}: ${domains.hm.fmt(a.mean2[c])} (average)</div>`;
  tt.innerHTML = html;
  tt.hidden = false;
  const w = tt.offsetWidth, hh = tt.offsetHeight;
  tt.style.left = Math.min(window.innerWidth - w - 10, cx + 16) + 'px';
  tt.style.top = Math.min(window.innerHeight - hh - 10, cy + 16) + 'px';
}

function syncMetricOptions() {
  const sel = $('metric');
  sel.querySelector('optgroup[data-custom]')?.remove();
  if (state.metric !== 'custom') sel.value = state.metric;
  $('customEmpty').hidden = !!custom.ds;
  $('customOpen').textContent = custom.ds ? 'Load a different CSV...' : 'Load a CSV...';
  $('heightMetric').closest('.field').hidden = customActive();
  $('customBox').hidden = !custom.ds;
  if (!custom.ds) return;
  const ds = custom.ds;
  $('customName').textContent = `${ds.name} · ${ds.n.toLocaleString('en-US')} points`;
  $('cColor').innerHTML = `<option value="c1">${escapeHtml(ds.c1.name)}${ds.c1.kind === 'cat' ? ' (most common)' : ''}</option><option value="count">Point count</option>`;
  $('cColor').value = custom.colorBy;
  $('cAggRow').hidden = ds.c1.kind !== 'num' || custom.colorBy !== 'c1';
  $('cAgg').value = custom.aggFn;
  const heights = [['count', 'Point count']];
  if (ds.c2?.kind === 'num') heights.push(['c2', `${ds.c2.name} (average)`]);
  if (ds.c1.kind === 'num' || custom.colorBy === 'count') heights.push(['color', 'Same as color']);
  heights.push(['flat', 'Flat']);
  if (!heights.some(([v]) => v === custom.height)) custom.height = 'count';
  $('cHeight').innerHTML = heights.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
  $('cHeight').value = custom.height;
  $('cFilterRow').hidden = ds.c2?.kind !== 'cat';
  if (ds.c2?.kind === 'cat') {
    $('cFilterLabel').textContent = `Only ${ds.c2.name}`;
    $('cFilter').innerHTML = `<option value="-1">All</option>` + ds.c2.cats.map((k, i) => `<option value="${i}">${escapeHtml(k)}</option>`).join('');
    $('cFilter').value = custom.filter;
  }
}

function initCustom() {
  const modal = $('customModal');
  let parsed = null, fileName = '';
  const open = () => { modal.hidden = false; };
  const close = () => { modal.hidden = true; };
  $('customOpen').onclick = open;
  $('customClose').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });

  const showMapping = () => {
    const { header, rows } = parsed;
    const g = guessColumns(header);
    const opts = (none) => (none ? '<option value="-1">None</option>' : '<option value="-1">Choose…</option>') +
      header.map((h, i) => `<option value="${i}">${escapeHtml(h || `Column ${i + 1}`)}</option>`).join('');
    for (const [id, idx, none] of [['cmLat', g.lat], ['cmLon', g.lon], ['cm1', g.c1], ['cm2', g.c2, true]]) {
      $(id).innerHTML = opts(none);
      $(id).value = idx;
    }
    $('cmRows').textContent = `${rows.length.toLocaleString('en-US')} rows, ${header.length} columns in ${fileName}`;
    $('cmPreview').innerHTML = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>` +
      rows.slice(0, 4).map((r) => `<tr>${header.map((_, i) => `<td>${escapeHtml(r[i] ?? '')}</td>`).join('')}</tr>`).join('');
    $('cmError').textContent = '';
    $('customStep2').hidden = false;
  };
  const load = (text, name) => {
    try {
      parsed = parseCsv(text);
      if (!parsed.header.length || !parsed.rows.length) throw new Error('That file has no data rows.');
      fileName = name;
      showMapping();
    } catch (err) {
      $('cmError').textContent = err.message;
    }
  };
  $('customFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) load(await f.text(), f.name);
  };
  const drop = $('customDrop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) load(await f.text(), f.name);
  };
  $('customPasteGo').onclick = () => load($('customPaste').value, 'pasted data');

  $('customMap').onclick = () => {
    try {
      const cols = { lat: +$('cmLat').value, lon: +$('cmLon').value, c1: +$('cm1').value, c2: +$('cm2').value };
      const name = fileName.replace(/\.(csv|tsv|txt)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Custom data';
      const ds = buildDataset(parsed, cols, name.charAt(0).toUpperCase() + name.slice(1));
      if (state.metric !== 'custom') custom.prevMetric = state.metric;
      Object.assign(custom, { ds, agg: null, aggBuild: null, colorBy: 'c1', aggFn: 'mean', filter: -1, height: 'count' });
      state.metric = 'custom';
      if (timeline.active) setTimeline('');
      syncSource('custom');
      syncMetricOptions();
      close();
      const s = ds.skipped;
      $('customNote').textContent = s.bad || s.outside
        ? `${(s.bad + s.outside).toLocaleString('en-US')} rows skipped (${s.bad} without valid coordinates, ${s.outside} outside the map).` : '';
      recolor();
      writeHash();
    } catch (err) {
      $('cmError').textContent = err.message;
    }
  };

  const changed = () => { syncMetricOptions(); recolor(); };
  $('cColor').onchange = (e) => { custom.colorBy = e.target.value; changed(); };
  $('cAgg').onchange = (e) => { custom.aggFn = e.target.value; changed(); };
  $('cHeight').onchange = (e) => { custom.height = e.target.value; changed(); };
  $('cFilter').onchange = (e) => { custom.filter = +e.target.value; changed(); };
  $('customRemove').onclick = () => {
    custom.ds = null; custom.agg = null;
    if (state.metric === 'custom') state.metric = custom.prevMetric || 'density';
    $('customNote').textContent = '';
    syncSource('census');
    syncMetricOptions();
    recolor();
    writeHash();
  };
  syncMetricOptions();
}

// ---------------------------------------------------------------- timelines
const timeline = { active: false, def: null, data: null, mapping: null, domain: null, values: null, frame: 0, playing: false, nextTick: 0 };
let countyCells = null; // { build, map } county under each hex, cached per build

function prepareTimeline() {
  const { def, data: tl } = timeline;
  if (def.kind === 'county' && countyCells?.build !== build) countyCells = { build, map: cellCounties(build, data.counties) };
  timeline.mapping = cellMapping(def, tl, build, countyCells?.map, data.counties);
  // one fixed scale for the whole run: cumulative series from their final frame, others across frames
  const frames = def.mode === 'weekly'
    ? Array.from({ length: Math.ceil(tl.frameCount / 2) }, (_, i) => i * 2)
    : [tl.frameCount - 1];
  const vals = [];
  for (const f of frames) {
    const v = frameValues(def, tl, timeline.mapping, build.cellCount, f);
    for (let c = 0; c < v.length; c++) if (build.cellFlags[c] & 1) vals.push(v[c]);
  }
  timeline.domain = computeDomain(def, vals, { zero: def.scale === 'linear' });
  timeline.chart = def.kind === 'county' ? chartSeries() : null;
  document.body.classList.toggle('has-chart', !!timeline.chart);
  // heights for county series: the county rate spread over the hex's own population density
  timeline.heightDomain = null;
  if (def.kind === 'county') {
    const hv = [];
    for (const f of frames) {
      const v = perAreaValues(frameValues(def, tl, timeline.mapping, build.cellCount, f));
      for (let c = 0; c < v.length; c++) if (build.cellFlags[c] & 1) hv.push(v[c]);
    }
    timeline.heightDomain = computeDomain({ scale: 'log' }, hv);
  }
}

// Focus-area totals for the corner chart: running total and trailing 3-week count.
const NYC_BOROUGHS = new Set(['36005', '36047', '36061', '36081', '36085']);
function chartSeries() {
  const tl = timeline.data, series = tl[timeline.def.series];
  const counties = new Set();
  for (let c = 0; c < build.cellCount; c++) if (build.cellFlags[c] & 1 && timeline.mapping[c] >= 0) counties.add(timeline.mapping[c]);
  const total = new Array(tl.frameCount).fill(0);
  let nyc = false;
  for (const k of counties) {
    // NYC is reported once and copied to each borough: count it once
    if (NYC_BOROUGHS.has(tl.fips[k])) { if (nyc) continue; nyc = true; }
    const s = series[k];
    for (let i = 0; i < total.length; i++) total[i] += s[i];
  }
  const trailing = total.map((v, i) => Math.max(0, v - (i >= 3 ? total[i - 3] : 0)));
  return { dates: tl.dates, total, trailing, noun: timeline.def.series === 'deaths' ? 'Deaths' : 'Cases' };
}

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return { ink: v('--ink'), inkSoft: v('--ink-soft'), accent: v('--accent') };
}

function drawChart() {
  const el = $('tlChart');
  if (!timeline.active || !timeline.chart) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = el.clientWidth, h = el.clientHeight;
  if (!w) return;
  if (el.width !== Math.round(w * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
  const ctx = el.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawTimelineChart(ctx, { ...timeline.chart, frame: timeline.frame, ...chartColors() }, 0, 0, w, h, w < 300 ? 0.85 : 1);
}

// Label anchor: the top of the column as it animates, so pins rise and fall with their bar.
// Which cities show and which side each label takes stay fixed (see Labels.update / labelPlan).
function labelHeight(cid) {
  return renderer.cellHeight(cid, !!(build.cellFlags[cid] & 1));
}

// Lowest..highest height a label's column passes through: over every frame on a timeline,
// otherwise between where the bar is now and where it is heading.
let rangeCache = { key: '', map: null };
function labelRange(cid) {
  const focus = !!(build.cellFlags[cid] & 1);
  if (!timeline.active || !timeline.mapping) {
    const a = renderer.cellHeight(cid, focus), b = renderer.targetHeight(cid, focus);
    return [Math.min(a, b), Math.max(a, b)];
  }
  const key = `${timeline.def.id}|${build.cellCount}|${view.maxH}|${labels.items.length}`;
  if (rangeCache.key !== key) rangeCache = { key, map: timelineRanges() };
  return rangeCache.map.get(cid) || [view.base, view.base];
}

function timelineRanges() {
  const { def, data: tl, mapping } = timeline;
  const hd = timeline.heightDomain || timeline.domain;
  const dens = timeline.heightDomain ? cellValues('density') : null;
  const out = new Map();
  for (const { cid } of labels.items) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tl.frameCount; i++) {
      let v = cellFrameValue(def, tl, mapping, cid, i);
      if (dens) v = (v / 1e5) * dens[cid];
      const t = heightNorm(hd, v);
      const h = view.maxH * (Number.isFinite(t) ? t : 0) + view.base;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    out.set(cid, [lo, hi]);
  }
  return out;
}

// Outline points of the focused regions (map units), for keeping posters' maps clear of the corner blocks.
function focusOutline() {
  const pts = [];
  for (const r of view.focus) for (const poly of r.polys) for (const p of poly[0]) pts.push(p);
  const step = Math.max(1, Math.ceil(pts.length / 4000));
  return pts.filter((_, i) => i % step === 0);
}

// per-100k rates -> events per sq mi, using each hex's population density
function perAreaValues(rates) {
  const dens = cellValues('density');
  const out = new Float32Array(rates.length);
  for (let c = 0; c < rates.length; c++) out[c] = (rates[c] / 1e5) * dens[c];
  return out;
}

async function setTimeline(id) {
  timeline.playing = false;
  if (!id) {
    timeline.active = false;
    state.tl = '';
    $('timebar').hidden = true;
    document.body.classList.remove('timeline', 'has-chart');
    if (view) fitView(800);
    $('timelineSel').value = '';
    recolor();
    writeHash();
    return;
  }
  const def = TIMELINE[id];
  setLoading('Loading timeline…', true);
  const tl = await loadTimeline(def);
  doneLoading();
  if (!tl) {
    $('timelineHint').textContent = `${def.label} data isn't built yet — see the README.`;
    $('timelineSel').value = state.tl || '';
    return;
  }
  Object.assign(timeline, { active: true, def, data: tl, frame: 0 });
  state.tl = id;
  // on a cold start the first build may still be running; rebuild() prepares the timeline when it lands
  if (build) prepareTimeline();
  labels.plan = null; // lay labels out again using this timeline's height ranges
  const scrub = $('tlScrub');
  scrub.max = tl.frameCount - 1;
  scrub.value = 0;
  $('tlStart').textContent = tl.stamps[0];
  $('tlEnd').textContent = tl.stamps[tl.frameCount - 1];
  $('timebar').hidden = false;
  document.body.classList.add('timeline');
  if (typeof syncSource === 'function') syncSource('time');
  $('timelineSel').value = id;
  $('timelineHint').textContent = '';
  recolor({ duration: 600 });
  syncTimebar();
  if (build) fitView(800);
  writeHash();
}

// A view's own palette (unless a diverging one is already chosen); null restores the user's.
let paletteBefore = null;
function usePalette(id) {
  if (id) {
    if (state.colors || PALETTES.find((p) => p.id === state.pal)?.kind === 'div') return;
    paletteBefore ??= { pal: state.pal, inv: state.inv };
    Object.assign(state, { pal: id, inv: false });
  } else if (paletteBefore) {
    Object.assign(state, paletteBefore);
    paletteBefore = null;
  } else return;
  applyTheme();
  syncPaletteUI();
}

// seconds per frame at 1x: weekly COVID frames move quickly, decades slowly
const tickMs = () => (timeline.def.kind === 'grid' ? 1100 : 170) / +$('tlSpeed').value;

function tickTimeline(now) {
  const last = timeline.data.frameCount - 1;
  if (timeline.frame >= last) { timeline.playing = false; syncTimebar(); return; }
  timeline.frame = Math.min(last, Math.floor(timeline.frame) + 1);
  const ms = tickMs();
  timeline.nextTick = now + ms;
  recolor({ duration: ms });
  syncTimebar();
}

function syncTimebar() {
  const f = Math.round(timeline.frame);
  $('tlScrub').value = f;
  $('tlLabel').textContent = timeline.data.labels[f];
  $('tlPlay').textContent = timeline.playing ? '❚❚' : '▶';
  $('tlPlay').setAttribute('aria-label', timeline.playing ? 'Pause' : 'Play');
}

async function initTimeline() {
  const sel = $('timelineSel');
  sel.innerHTML = TIMELINES.map((t) => `<option value="${t.id}">${t.label}${t.span ? `, ${t.span}` : ''}</option>`).join('');
  sel.onchange = () => setTimeline(sel.value);
  // grey out timelines whose data hasn't been built
  for (const t of TIMELINES) {
    timelineAvailable(t).then((ok) => {
      const opt = sel.querySelector(`option[value="${t.id}"]`);
      if (!ok && opt) { opt.disabled = true; opt.textContent += ' (data not built)'; }
    });
  }
  $('tlPlay').onclick = () => {
    if (!timeline.active) return;
    if (timeline.frame >= timeline.data.frameCount - 1) { timeline.frame = 0; recolor({ duration: 400 }); }
    timeline.playing = !timeline.playing;
    timeline.nextTick = performance.now() + 250;
    syncTimebar();
  };
  $('tlScrub').oninput = (e) => {
    timeline.playing = false;
    timeline.frame = +e.target.value;
    recolor({ duration: 120 });
    syncTimebar();
  };
  $('tlClose').onclick = () => { setTimeline(''); syncSource('census'); };
  initGif();
  if (state.tl && TIMELINE[state.tl]) setTimeline(state.tl);
}

// ---------------------------------------------------------------- GIF export
function initGif() {
  const modal = $('gifModal');
  $('gifRatio').innerHTML = RATIOS.map((r, i) => `<option value="${i}">${r[0]}:${r[1]}</option>`).join('');
  let busy = false, url = null;
  const close = () => { if (busy) return; modal.hidden = true; };
  $('tlGif').onclick = () => {
    if (!timeline.active) return;
    timeline.playing = false;
    syncTimebar();
    // weekly series have plenty of frames; decades need in-betweens to read as motion
    $('gifStep').innerHTML = timeline.def.kind === 'grid'
      ? '<option value="0.25">Smooth (4 per decade)</option><option value="0.5" selected>Normal (2 per decade)</option><option value="1">Decades only</option>'
      : '<option value="1">Every week</option><option value="2" selected>Every 2nd week</option><option value="4">Every 4th week</option>';
    $('gifStatus').textContent = '';
    $('gifBar').style.width = '0';
    modal.hidden = false;
  };
  $('gifClose').onclick = close;
  $('gifAdjust').onclick = () => { if (!busy) openFramingEditor(RATIOS[+$('gifRatio').value]); };
  modal.onclick = (e) => { if (e.target === modal) close(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && $('editModal').hidden) close(); });

  $('gifGo').onclick = async () => {
    if (busy) return;
    busy = true;
    $('gifGo').disabled = true;
    $('gifImg').hidden = true;
    $('gifDl').hidden = true;
    if (url) { URL.revokeObjectURL(url); url = null; }
    const keepFrame = timeline.frame;
    const ratio = RATIOS[+$('gifRatio').value], long = +$('gifSize').value;
    const [W, H] = posterSize(ratio, long);
    const step = +$('gifStep').value, delay = +$('gifDelay').value;
    const last = timeline.data.frameCount - 1;
    const frames = [];
    for (let f = 0; f < last; f += step) frames.push(f);
    frames.push(last);
    const ctxOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true });
    const labelPlan = {}; // decided on the first frame, reused for the rest
    await logoReady;
    const draw = (f) => {
      timeline.frame = f;
      recolor({ duration: 0 });
      const spec = posterSpec();
      spec.labelPlan = labelPlan;
      spec.stamp = timeline.data.stamps[Math.round(f)];
      return ctxOf(renderPoster(renderer, spec, ratio, long, adjustFor(ratio))).getImageData(0, 0, W, H).data;
    };
    renderer.beginBatch();
    try {
      // one palette shared by every frame, sampled from the start, middle and end, so colors don't flicker
      $('gifStatus').textContent = 'Building palette…';
      await nextFrame();
      const sampleFrames = [frames[0], frames[frames.length >> 1], last];
      const pick = [];
      for (const f of sampleFrames) {
        const px = draw(f);
        for (let i = 0; i < px.length; i += 4 * 7) pick.push(px[i], px[i + 1], px[i + 2], 255);
      }
      const palette = quantize(new Uint8Array(pick), 256);
      const gif = GIFEncoder();
      for (let i = 0; i < frames.length; i++) {
        const px = draw(frames[i]);
        const index = applyPalette(px, palette);
        gif.writeFrame(index, W, H, {
          ...(i === 0 ? { palette, repeat: 0 } : {}),
          delay: i === frames.length - 1 ? 2500 : delay,
        });
        $('gifBar').style.width = `${((i + 1) / frames.length) * 100}%`;
        $('gifStatus').textContent = `Frame ${i + 1} of ${frames.length}`;
        if (i % 2 === 0) await nextFrame();
      }
      gif.finish();
      const blob = new Blob([gif.bytes()], { type: 'image/gif' });
      url = URL.createObjectURL(blob);
      $('gifImg').src = url;
      $('gifImg').hidden = false;
      const name = `${exportSlug()}-${ratio.join('x')}`;
      $('gifDl').href = url;
      $('gifDl').download = `${name}.gif`;
      $('gifDl').hidden = false;
      $('gifStatus').textContent = `${frames.length} frames · ${W} × ${H} px · ${(blob.size / 1048576).toFixed(1)} MB`;
    } catch (err) {
      console.error(err);
      $('gifStatus').textContent = 'GIF export failed: ' + err.message;
    } finally {
      renderer.endBatch();
      timeline.frame = keepFrame;
      recolor({ duration: 0 });
      syncTimebar();
      busy = false;
      $('gifGo').disabled = false;
    }
  };
}

let labelTimer = 0;
function updateLabelsSoon() { clearTimeout(labelTimer); labelTimer = setTimeout(() => (labels.measured = false), 50); }

function onPaletteChange(duration = state.dur * 0.6) {
  applyTheme();
  syncPaletteUI();
  recolor({ duration });
  writeHash();
}

function syncPaletteUI() {
  const mode = themeMode();
  document.querySelectorAll('.pal').forEach((b) => {
    const p = PALETTES.find((x) => x.id === b.dataset.id);
    b.classList.toggle('on', p.id === state.pal && !state.colors);
    b.style.background = p[mode];
    b.style.color = INK[mode];
    b.querySelector('.pbg').style.flexDirection = state.inv ? 'row-reverse' : '';
  });
  $('invertColors').checked = state.inv;
  $('themeToggle').dataset.mode = mode;
  $('themeToggle').title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const c = colors();
  document.querySelectorAll('.colors input[data-ci]').forEach((inp) => (inp.value = c[+inp.dataset.ci]));
  $('bgColor').value = bgColor();
  $('inkColor').value = inkColor();
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}

init();
