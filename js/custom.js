// Custom data sets: a CSV of points (lat, long, category1, optional category2) loaded in the
// browser and aggregated onto the hex grid. Nothing is uploaded anywhere.
//
// A category column is numeric when nearly all its values parse as numbers (then hexes take the
// mean or sum), otherwise it is categorical (then hexes take their most common value).
import { projection } from './data.js';
import { cellKey } from './hex.js';
import { FORMATS } from './scales.js';

// muted, distinguishable hues for categories; the last one is "Other"
export const CAT_COLORS = ['#3b6fb6', '#e07b39', '#4f9a5b', '#c4473f', '#8565b0', '#c9a227', '#3fa3a8', '#b05d8f', '#9a958d'];
const MAX_CATS = CAT_COLORS.length - 1;

export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const delim = sniffDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  const header = (rows.shift() || []).map((h) => h.trim().replace(/^﻿/, ''));
  return { header, rows };
}

function sniffDelimiter(text) {
  const line = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 2000);
  const counts = [',', '\t', ';', '|'].map((d) => [d, line.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

// best guess at which column is which, from the header names
export function guessColumns(header) {
  const find = (...res) => {
    for (const re of res) {
      const i = header.findIndex((h) => re.test(h.trim()));
      if (i >= 0) return i;
    }
    return -1;
  };
  const lat = find(/^lat(itude)?$/i, /lat/i);
  const lon = find(/^(long|lon|lng|longitude)$/i, /lon|lng/i);
  let c1 = find(/^category ?1$/i, /^cat(egory)?_?1$/i, /^category$/i);
  let c2 = find(/^category ?2$/i, /^cat(egory)?_?2$/i);
  const free = header.map((_, i) => i).filter((i) => i !== lat && i !== lon);
  if (c1 < 0) c1 = free.find((i) => i !== c2) ?? -1;
  if (c2 === c1) c2 = -1;
  return { lat, lon, c1, c2 };
}

const toNum = (s) => {
  const t = String(s).trim().replace(/[$,%\s]/g, '');
  return t === '' ? NaN : Number(t);
};

function describeColumn(name, raw) {
  const filled = raw.filter((v) => String(v).trim() !== '');
  const nums = filled.map(toNum);
  const numeric = filled.length > 0 && nums.filter(Number.isFinite).length / filled.length >= 0.9;
  if (numeric) {
    const values = new Float32Array(raw.map(toNum));
    const pctName = /%|pct|percent|share|rate/i.test(name);
    const inRange = nums.every((v) => !Number.isFinite(v) || (v >= 0 && v <= 100));
    return { name, kind: 'num', values, percent: pctName && inRange };
  }
  // categories ranked by frequency; the long tail folds into "Other"
  const freq = new Map();
  for (const v of raw) {
    const k = String(v).trim() || '(blank)';
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const cats = ranked.slice(0, MAX_CATS).map(([k]) => k);
  const other = ranked.length > MAX_CATS;
  if (other) cats.push('Other');
  const index = new Map(cats.map((k, i) => [k, i]));
  const codes = new Int16Array(raw.map((v) => index.get(String(v).trim() || '(blank)') ?? cats.length - 1));
  return { name, kind: 'cat', codes, cats, distinct: ranked.length };
}

/**
 * parsed: parseCsv() result; cols: { lat, lon, c1, c2 } column indexes (c2 = -1 for none).
 * Returns the dataset (points projected into map units) or throws with a readable message.
 */
export function buildDataset(parsed, cols, name) {
  const { header, rows } = parsed;
  if (cols.lat < 0 || cols.lon < 0) throw new Error('Choose the latitude and longitude columns.');
  if (cols.c1 < 0) throw new Error('Choose a column for category 1.');
  const keep = [], xs = [], ys = [];
  let bad = 0, outside = 0;
  rows.forEach((r, i) => {
    const lat = toNum(r[cols.lat]), lon = toNum(r[cols.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { bad++; return; }
    const p = projection([lon, lat]);
    if (!p) { outside++; return; }
    keep.push(i); xs.push(p[0]); ys.push(p[1]);
  });
  if (!keep.length) throw new Error(`No usable points: ${bad} rows had no valid lat/long and ${outside} fell outside the U.S. map.`);
  const col = (j) => keep.map((i) => rows[i][j] ?? '');
  return {
    name,
    n: keep.length, skipped: { bad, outside },
    x: Float32Array.from(xs), y: Float32Array.from(ys),
    c1: describeColumn(header[cols.c1], col(cols.c1)),
    c2: cols.c2 >= 0 ? describeColumn(header[cols.c2], col(cols.c2)) : null,
  };
}

// Points -> hex cells. opts: { filter: category2 code or -1 }
export function aggregate(ds, build, opts = {}) {
  const n = build.cellCount;
  const count = new Float32Array(n);
  const sum1 = new Float32Array(n), n1 = new Float32Array(n);
  const sum2 = new Float32Array(n), n2 = new Float32Array(n);
  const k1 = ds.c1.kind === 'cat' ? ds.c1.cats.length : 0;
  const cat1 = k1 ? new Float32Array(n * k1) : null;
  const L = build.lattice;
  const f2 = ds.c2?.kind === 'cat' && opts.filter >= 0 ? opts.filter : -1;
  let mapped = 0;
  for (let i = 0; i < ds.n; i++) {
    if (f2 >= 0 && ds.c2.codes[i] !== f2) continue;
    const [q, r] = L.locate(ds.x[i], ds.y[i]);
    const c = build.keyToCell.get(cellKey(q, r));
    if (c === undefined) continue;
    mapped++;
    count[c]++;
    if (k1) cat1[c * k1 + ds.c1.codes[i]]++;
    else if (Number.isFinite(ds.c1.values[i])) { sum1[c] += ds.c1.values[i]; n1[c]++; }
    if (ds.c2?.kind === 'num' && Number.isFinite(ds.c2.values[i])) { sum2[c] += ds.c2.values[i]; n2[c]++; }
  }
  const top = k1 ? new Int16Array(n).fill(-1) : null, topShare = k1 ? new Float32Array(n) : null;
  if (k1) {
    for (let c = 0; c < n; c++) {
      let best = -1, bv = 0;
      for (let k = 0; k < k1; k++) if (cat1[c * k1 + k] > bv) { bv = cat1[c * k1 + k]; best = k; }
      top[c] = best;
      topShare[c] = count[c] ? bv / count[c] : 0;
    }
  }
  const ratio = (s, m) => s.map((v, c) => (m[c] ? v / m[c] : NaN));
  return {
    mapped, count, cat1, k1, top, topShare,
    mean1: k1 ? null : ratio(sum1, n1), sum1: k1 ? null : sum1.map((v, c) => (count[c] ? v : NaN)),
    mean2: ds.c2?.kind === 'num' ? ratio(sum2, n2) : null,
    sum2: ds.c2?.kind === 'num' ? sum2.map((v, c) => (count[c] ? v : NaN)) : null,
  };
}

// metric-like description of a numeric custom measure, for scales, legend and tooltip
export function customMetric(label, legend, { percent = false, values = [] } = {}) {
  const { pct, pctShort, num, numShort } = FORMATS;
  const finite = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const q = (p) => finite[Math.min(finite.length - 1, Math.floor(p * finite.length))];
  // strongly skewed positive values (counts, sales) read better on a log scale
  const skewed = !percent && finite.length > 20 && q(0.98) / Math.max(q(0.5), 1e-9) > 25;
  return {
    id: 'custom', label, legend, scale: skewed ? 'log' : 'linear',
    fmt: percent ? pct : num, short: percent ? pctShort : numShort, max: percent ? 100 : undefined,
  };
}
