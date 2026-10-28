// Timelines: data sets with a time axis that the map can play through.
//
// Two kinds of source:
//   county  per-county series (NYT COVID-19), mapped to hexes by the county under each hex center
//   grid    a density raster per frame in map units (historical population, see scripts/nhgis/)
import { pointInRegion } from './data.js';

const num = (v) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toLocaleString('en-US');
const numShort = (v) => (v >= 1e4 ? Math.round(v / 1e3) + 'k' : Math.round(v).toLocaleString('en-US'));
const COVID_SOURCE = 'The New York Times COVID-19 data; Census Bureau 2020 population estimates';
const covidDate = (iso) => new Date(iso + 'T12:00:00Z');

export const TIMELINES = [
  {
    id: 'covidCases', kind: 'county', file: 'data/timeline/covid.json', series: 'cases', mode: 'cumulative',
    label: 'COVID-19 Cases', legend: 'Cumulative cases per 100k', heightLabel: 'cases per sq mi', scale: 'linear', fmt: num, short: numShort, source: COVID_SOURCE,
  },
  {
    id: 'covidWeekly', kind: 'county', file: 'data/timeline/covid.json', series: 'cases', mode: 'weekly',
    label: 'COVID-19 New Cases', legend: 'Weekly new cases per 100k (5-wk avg)', heightLabel: 'new cases per sq mi', smooth: 5, scale: 'log', fmt: num, short: numShort, source: COVID_SOURCE,
  },
  {
    id: 'covidDeaths', kind: 'county', file: 'data/timeline/covid.json', series: 'deaths', mode: 'cumulative',
    label: 'COVID-19 Deaths', legend: 'Cumulative deaths per 100k', heightLabel: 'deaths per sq mi', scale: 'linear', fmt: num, short: numShort, source: COVID_SOURCE,
  },
  {
    id: 'population', kind: 'grid', file: 'data/timeline/population.json', span: '1800–2020',
    label: 'Population Density', legend: 'People per sq mi', scale: 'log', fmt: num, short: numShort,
    source: 'IPUMS NHGIS, decennial census county populations on historical county boundaries',
  },
];
export const TIMELINE = Object.fromEntries(TIMELINES.map((t) => [t.id, t]));

const cache = new Map();

// Resolves to the loaded data, or null when the file isn't present (e.g. NHGIS data not built yet).
export function loadTimeline(def) {
  if (!cache.has(def.file)) {
    cache.set(def.file, (async () => {
      const res = await fetch(def.file);
      if (!res.ok) return null;
      const json = await res.json();
      if (def.kind === 'grid') {
        const bin = await fetch(new URL(json.bin, new URL(def.file, location.href)));
        if (!bin.ok) return null;
        json.frames = new Uint8Array(await bin.arrayBuffer());
        json.labels = json.years.map(String);
        json.stamps = json.labels;
      } else {
        json.index = new Map(json.fips.map((f, i) => [f, i]));
        json.labels = json.dates.map((d) => covidDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
        json.stamps = json.dates.map((d) => covidDate(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
      }
      json.frameCount = json.years ? json.years.length : json.dates.length;
      return json;
    })().catch(() => null));
  }
  return cache.get(def.file);
}

// data/timeline/index.json lists the timeline files that have been built
let manifest = null;
export async function timelineAvailable(def) {
  manifest ??= fetch('data/timeline/index.json').then((r) => (r.ok ? r.json() : { files: [] })).catch(() => ({ files: [] }));
  return (await manifest).files.includes(def.file.replace('data/timeline/', ''));
}

// County under each hex center (falls back to points around the center for border hexes).
export function cellCounties(build, counties) {
  const size = 4, grid = new Map();
  for (let i = 0; i < counties.length; i++) {
    const [x0, y0, x1, y1] = counties[i].bbox;
    for (let gx = Math.floor(x0 / size); gx <= Math.floor(x1 / size); gx++) {
      for (let gy = Math.floor(y0 / size); gy <= Math.floor(y1 / size); gy++) {
        const k = gx * 10000 + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  }
  const find = (x, y) => {
    const list = grid.get(Math.floor(x / size) * 10000 + Math.floor(y / size)) || [];
    for (const i of list) if (pointInRegion(counties[i], x, y)) return i;
    return -1;
  };
  const r = build.lattice.R * 0.5;
  const out = new Int32Array(build.cellCount);
  for (let c = 0; c < build.cellCount; c++) {
    const x = build.cellX[c], y = build.cellY[c];
    let hit = find(x, y);
    for (let k = 0; hit < 0 && k < 6; k++) hit = find(x + r * Math.cos(k * Math.PI / 3), y + r * Math.sin(k * Math.PI / 3));
    out[c] = hit;
  }
  return out;
}

// Per-cell lookup into the timeline's data (county series index, or grid sample positions).
export function cellMapping(def, tl, build, cellCounty, counties) {
  const n = build.cellCount;
  if (def.kind === 'county') {
    const m = new Int32Array(n);
    for (let c = 0; c < n; c++) {
      const ci = cellCounty[c];
      m[c] = ci < 0 ? -1 : tl.index.get(counties[ci].id) ?? -1;
    }
    return m;
  }
  // grid: average 7 samples (center + ring) so a hex reflects the area it covers
  const { x0, y0, size, cols, rows } = tl.grid;
  const m = new Int32Array(n * 7).fill(-1);
  const r = build.lattice.R * 0.55;
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < 7; k++) {
      const x = build.cellX[c] + (k ? r * Math.cos(k * Math.PI / 3) : 0);
      const y = build.cellY[c] + (k ? r * Math.sin(k * Math.PI / 3) : 0);
      const gx = Math.floor((x - x0) / size), gy = Math.floor((y - y0) / size);
      if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) m[c * 7 + k] = gy * cols + gx;
    }
  }
  return m;
}

function countyRate(def, tl, k, i) {
  const s = tl[def.series][k], pop = tl.pop[k];
  if (!pop) return NaN;
  let v = s[i];
  if (def.mode === 'weekly') {
    // centered moving average of weekly new cases, taken from the change in the cumulative count
    // across the window, so batch reporting and backlog corrections spread out instead of spiking
    const half = Math.floor((def.smooth || 1) / 2), last = s.length - 1;
    const a = i - half - 1, b = Math.min(last, i + half);
    const weeks = b - Math.max(a, -1);
    v = Math.max(0, (s[b] - (a >= 0 ? s[a] : 0)) / weeks);
  }
  return (v / pop) * 1e5;
}

function gridDensity(tl, frame, cell) {
  const q = tl.frames[frame * tl.grid.cols * tl.grid.rows + cell];
  if (!q) return 0;
  const { min, max } = tl.encoding; // log10 density range for codes 1..255
  return Math.pow(10, min + ((q - 1) / 254) * (max - min));
}

// Value of one cell at integer frame i (label sweep ranges over a whole run).
export function cellFrameValue(def, tl, mapping, c, i) {
  if (def.kind === 'county') {
    const k = mapping[c];
    return k < 0 ? NaN : countyRate(def, tl, k, i);
  }
  let s = 0, ns = 0;
  for (let j = 0; j < 7; j++) {
    const g = mapping[c * 7 + j];
    if (g >= 0) { s += gridDensity(tl, i, g); ns++; }
  }
  return ns ? s / ns : NaN;
}

// Values for every cell at fractional frame f (linear blend of the neighbouring frames).
export function frameValues(def, tl, mapping, n, f) {
  const i0 = Math.max(0, Math.min(tl.frameCount - 1, Math.floor(f)));
  const i1 = Math.min(tl.frameCount - 1, i0 + 1);
  const t = Math.min(1, Math.max(0, f - i0));
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    let a, b;
    if (def.kind === 'county') {
      const k = mapping[c];
      if (k < 0) { out[c] = NaN; continue; }
      a = countyRate(def, tl, k, i0); b = t ? countyRate(def, tl, k, i1) : a;
    } else {
      let sa = 0, sb = 0, ns = 0;
      for (let s = 0; s < 7; s++) {
        const g = mapping[c * 7 + s];
        if (g < 0) continue;
        sa += gridDensity(tl, i0, g); sb += t ? gridDensity(tl, i1, g) : 0; ns++;
      }
      if (!ns) { out[c] = NaN; continue; }
      a = sa / ns; b = t ? sb / ns : a;
    }
    out[c] = a + (b - a) * t;
  }
  return out;
}
