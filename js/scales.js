// Metric definitions, palettes, color ramps and number formatting.

const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
const moneyShort = (v) => {
  if (v >= 1e6) return '$' + trim(v / 1e6, 1) + 'M';
  if (v >= 1e3) return '$' + trim(v / 1e3, v >= 1e4 ? 0 : 1) + 'k';
  return '$' + Math.round(v);
};
const pct = (v) => trim(v, 1) + '%';
const pctShort = (v) => trim(v, v < 10 && v % 1 ? 1 : 0) + '%';
const num = (v) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toLocaleString('en-US');
const numShort = (v) => {
  if (v >= 1e4) return trim(v / 1e3, 0) + 'k';
  return (v >= 10 ? Math.round(v) : +v.toFixed(1)).toLocaleString('en-US');
};

function trim(v, d) {
  return (+v.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d });
}

const COVID_SOURCE = 'The New York Times COVID-19 data (totals through March 2023); Census Bureau 2020 population estimates';
// Hypsometric tints, meters -> color: green lowlands, tan and brown uplands, grey rock above treeline,
// and white snow and ice on the highest peaks (from about 3,800 m).
export const HYPSO = [
  [-100, '#4f8a4b'], [0, '#68a262'], [150, '#8dba72'], [400, '#bccd8a'], [700, '#e2db9c'], [1000, '#e8cd88'],
  [1400, '#d8b06d'], [1800, '#c39457'], [2200, '#a77a4b'], [2600, '#8d6b50'], [3000, '#9b8d82'], [3300, '#c3bbb3'],
  [3600, '#e9e6e2'], [3800, '#ffffff'], [6200, '#ffffff'],
];
const HEALTH_SOURCE = 'CDC PLACES 2025 release (model-based estimates from BRFSS)';

export const METRICS = [
  { id: 'population', group: 'People', label: 'Net Population', legend: 'People per hexagon', scale: 'log', fmt: num, short: numShort },
  { id: 'density', group: 'People', label: 'Population Density', legend: 'People per sq mi', scale: 'log', fmt: num, short: numShort },
  { id: 'medianAge', group: 'People', label: 'Median Age', legend: 'Years', scale: 'linear', fmt: (v) => trim(v, 1) + ' yrs', short: (v) => trim(v, 0) },
  { id: 'foreignBorn', group: 'People', label: 'Foreign-Born Population', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  // from data/elevation, not the tract files; colors are fixed tints, not the palette
  {
    id: 'elevation', group: 'Land', label: 'Elevation', legend: 'Average elevation (m)', grid: true, scale: 'linear',
    ramp: HYPSO, legendStops: [0, 1000, 2000, 3000, 4000],
    fixedDomain: { kind: 'linear', lo: -100, hi: 6200, breaks: [NaN, -100, 2000, 4100, 6200], max: 6200 },
    fmt: (v) => `${num(v)} m (${Math.round(v * 3.28084).toLocaleString('en-US')} ft)`, short: (v) => `${numShort(v)} m`,
    source: 'USGS 3D Elevation Program (3DEP), ~30 m, via AWS Terrain Tiles',
  },
  { id: 'covidDeaths', group: 'COVID-19', label: 'COVID-19 Total Deaths', legend: 'Deaths per 100k residents', covid: 1, peaks: 'deaths per sq mi', scale: 'linear', fmt: num, short: numShort, source: COVID_SOURCE },
  { id: 'covidCases', group: 'COVID-19', label: 'COVID-19 Total Cases', legend: 'Cases per 100k residents', covid: 0, peaks: 'cases per sq mi', scale: 'linear', fmt: num, short: numShort, source: COVID_SOURCE },
  { id: 'income', group: 'Economy', label: 'Median Household Income', legend: 'Dollars per year', scale: 'linear', fmt: money, short: moneyShort },
  { id: 'poverty', group: 'Economy', label: 'Poverty Rate', legend: 'Share below poverty line', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'unemployment', group: 'Economy', label: 'Unemployment Rate', legend: 'Share of labor force', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'gini', group: 'Economy', label: 'Income Inequality', legend: 'Gini index', scale: 'linear', fmt: (v) => v.toFixed(3), short: (v) => v.toFixed(2) },
  { id: 'homeValue', group: 'Housing', label: 'Median Home Value', legend: 'Dollars', scale: 'linear', fmt: money, short: moneyShort },
  { id: 'rent', group: 'Housing', label: 'Median Gross Rent', legend: 'Dollars per month', scale: 'linear', fmt: money, short: moneyShort },
  { id: 'owner', group: 'Housing', label: 'Homeownership Rate', legend: 'Owner-occupied homes', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'bachelors', group: 'Education', label: "Bachelor's Degree or Higher", legend: 'Adults 25+', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'white', group: 'Race & Ethnicity', label: 'White (non-Hispanic)', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'black', group: 'Race & Ethnicity', label: 'Black (non-Hispanic)', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'hispanic', group: 'Race & Ethnicity', label: 'Hispanic or Latino', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'asian', group: 'Race & Ethnicity', label: 'Asian (non-Hispanic)', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'native', group: 'Race & Ethnicity', label: 'American Indian & Alaska Native', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  { id: 'multi', group: 'Race & Ethnicity', label: 'Two or More Races', legend: 'Share of residents', scale: 'linear', fmt: pct, short: pctShort },
  ...[
    ['chronicIndex', 'Chronic Conditions Index'],
    ['obesity', 'Obesity'], ['bphigh', 'High Blood Pressure'], ['highchol', 'High Cholesterol'],
    ['diabetes', 'Diabetes'], ['chd', 'Coronary Heart Disease'], ['stroke', 'Stroke'], ['copd', 'COPD'],
    ['casthma', 'Asthma'], ['cancer', 'Cancer (excl. skin)'], ['arthritis', 'Arthritis'], ['depression', 'Depression'],
  ].map(([id, label]) => (id === 'chronicIndex'
    // PolicyMap's method: per condition 0/1/2 for bottom quartile/middle/top quartile, summed
    ? { id, group: 'Health', label, legend: 'Index score (0–22, 11 conditions)', scale: 'linear', max: 22, fmt: (v) => v.toFixed(1), short: (v) => trim(v, 0), source: HEALTH_SOURCE }
    : { id, group: 'Health', label, legend: 'Share of adults', scale: 'linear', fmt: pct, short: pctShort, source: HEALTH_SOURCE })),
];
// shares can't exceed 100%, so percentage scales top out there instead of at a rounded 150%
for (const m of METRICS) if (m.fmt === pct && m.max == null) m.max = 100;
export const METRIC = Object.fromEntries(METRICS.map((m) => [m.id, m]));
// the measures offered in the panel, in order; the rest stay loadable from older links
export const SHOWN_METRICS = ['population', 'density', 'foreignBorn', 'covidDeaths', 'covidCases', 'elevation'].map((id) => METRIC[id]);

// color of a fixed ramp ([[value, hex], ...]) at a value
export function rampColor(ramp, v) {
  if (v <= ramp[0][0]) return ramp[0][1];
  for (let i = 1; i < ramp.length; i++) {
    if (v <= ramp[i][0]) return mixHex(ramp[i - 1][1], ramp[i][1], (v - ramp[i - 1][0]) / (ramp[i][0] - ramp[i - 1][0]));
  }
  return ramp[ramp.length - 1][1];
}
export const FORMATS = { pct, pctShort, num, numShort, money, moneyShort };

// colors: [zero / no data, ramp low ... ramp high]
// light / dark: the paper behind the map in each app theme
export const PALETTES = [
  { id: 'ember', name: 'Ember', light: '#e9e5df', dark: '#1c1916', colors: ['#5c5652', '#f4e6d8', '#f3bb8f', '#f18a3d', '#ea561c'] },
  { id: 'indigo', name: 'Indigo', light: '#e8e2d7', dark: '#151821', colors: ['#b39f86', '#dbe2ec', '#a9bde0', '#5e7fca', '#3c4796'] },
  { id: 'crimson', name: 'Crimson', light: '#efe7e2', dark: '#1d1613', colors: ['#6f6865', '#f2ddd2', '#e9a68c', '#e2582f', '#9a0f17'] },
  { id: 'forest', name: 'Forest', light: '#e6e8df', dark: '#2b2c26', colors: ['#595d58', '#d8e8b8', '#8cc46b', '#2d8a3b', '#123f1f'] },
  { id: 'coral', name: 'Coral', light: '#efe9e1', dark: '#16201a', colors: ['#6b7767', '#f5dbab', '#f3b27a', '#ef7854', '#df2f3d'] },
  { id: 'glacier', name: 'Glacier', light: '#e4ebef', dark: '#0f1a24', colors: ['#4c5964', '#d9f0f2', '#86cfd8', '#2c97b7', '#164f8f'] },
  { id: 'saffron', name: 'Saffron', light: '#f1ece2', dark: '#1f1a12', colors: ['#8f8778', '#f6eac4', '#f2cf6d', '#e09a1e', '#a4520c'] },
  { id: 'plum', name: 'Plum', light: '#ece6ea', dark: '#1d1720', colors: ['#7d7380', '#ecdff0', '#cfa6dd', '#9a5cb8', '#5b2380'] },
  // diverging: two pale middle stops meet near white at the center of the scale
  { id: 'rdbu', name: 'Blue–Red', kind: 'div', light: '#ebe8e4', dark: '#17181b', colors: ['#77736f', '#2b5c9e', '#d3e3ef', '#f7d6c6', '#b2272f'] },
  { id: 'brbg', name: 'Earth', kind: 'div', light: '#ece8e1', dark: '#191814', colors: ['#77736f', '#8c510a', '#efdcb2', '#c9eae3', '#01665e'] },
  { id: 'puor', name: 'Dusk', kind: 'div', light: '#ebe8ec', dark: '#18161c', colors: ['#77736f', '#5e3c99', '#dcd5ec', '#fbdab0', '#e66101'] },
  { id: 'piyg', name: 'Bloom', kind: 'div', light: '#ebe9e6', dark: '#171a16', colors: ['#77736f', '#4d9221', '#dbefc4', '#f7d4e7', '#c51b7d'] },
];
export const INK = { light: '#1c1916', dark: '#f4efe9' };

// ---------- color math (OKLab interpolation) ----------
function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linToSrgb(c) { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

export function hexToLin(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLin(((n >> 16) & 255) / 255), srgbToLin(((n >> 8) & 255) / 255), srgbToLin((n & 255) / 255)];
}
export function linToHex([r, g, b]) {
  const to = (c) => Math.round(linToSrgb(c) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
export function mixHex(a, b, t) {
  const A = linToOklab(hexToLin(a)), B = linToOklab(hexToLin(b));
  return linToHex(oklabToLin(A.map((v, i) => v + (B[i] - v) * t)));
}
export function luminance(hex) {
  const [r, g, b] = hexToLin(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const LUT_N = 512;
// stops: [[t, hex], ...] sorted by t. Returns Float32Array of linear rgb triples.
export function buildLut(stops) {
  const labs = stops.map(([t, h]) => [t, linToOklab(hexToLin(h))]);
  const lut = new Float32Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    let k = 0;
    while (k < labs.length - 2 && t > labs[k + 1][0]) k++;
    const [t0, c0] = labs[k], [t1, c1] = labs[k + 1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    const rgb = oklabToLin(c0.map((v, j) => v + (c1[j] - v) * f));
    lut.set(rgb.map((v) => Math.max(0, v)), i * 3);
  }
  return lut;
}
export function sampleLut(lut, t, out, o) {
  const i = Math.round(Math.min(1, Math.max(0, t)) * (LUT_N - 1)) * 3;
  out[o] = lut[i]; out[o + 1] = lut[i + 1]; out[o + 2] = lut[i + 2];
}

// ---------- domains ----------
const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function niceRound(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  let best = NICE[0];
  for (const n of NICE) if (Math.abs(n - f) < Math.abs(best - f)) best = n;
  return best * p;
}
function niceStep(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

// values: iterable of numbers (NaN skipped)
// opts.zero: anchor linear scales at 0 (cumulative timelines start from nothing)
export function computeDomain(metric, values, opts = {}) {
  const arr = [];
  for (const v of values) if (Number.isFinite(v)) arr.push(v);
  arr.sort((a, b) => a - b);
  if (metric.scale === 'log') {
    const top = niceRound(Math.max(1, quantile(arr, 0.995)));
    return { kind: 'log', top, a: top / 1000, breaks: [0, top / 1000, top / 100, top / 10, top], max: quantile(arr, 0.999) || top };
  }
  let lo = opts.zero ? 0 : quantile(arr, 0.02), hi = quantile(arr, 0.98);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (hi <= lo) hi = lo + (Math.abs(lo) || 1) * 0.1;
  let step = niceStep((hi - lo) / 3);
  let nlo = Math.floor(lo / step) * step;
  while (nlo + 3 * step < hi) { step = niceStep(step * 1.01); nlo = Math.floor(lo / step) * step; }
  if (lo >= 0 && nlo < 0) nlo = 0;
  // a metric's hard ceiling (e.g. a 0-22 index) wins over nice rounding
  if (metric.max != null && nlo + 3 * step > metric.max) step = (metric.max - nlo) / 3;
  // colors saturate at `hi` (a nice-rounded 98th percentile); heights run on to `max`, the 99.9th
  // percentile, so values above the color scale still rank by height without a lone outlier flattening the rest
  const max = quantile(arr, 0.999);
  return { kind: 'linear', lo: nlo, hi: nlo + 3 * step, breaks: [NaN, nlo, nlo + step, nlo + 2 * step, nlo + 3 * step], max: Number.isFinite(max) ? max : nlo + 3 * step };
}

const LOG_DEN = Math.log10(1001);
// Height position in [0, 1]. Unlike color, heights run to the true maximum so
// values above the color scale's top still rank by height.
export function heightNorm(domain, v) {
  if (!Number.isFinite(v)) return NaN;
  if (domain.kind === 'log') return v > 0 ? Math.sqrt(Math.min(1, v / Math.max(domain.top, domain.max))) : 0;
  const top = Math.max(domain.hi, domain.max);
  return Math.pow(Math.min(1, Math.max(0, (v - domain.lo) / (top - domain.lo))), 1.2);
}

// Legend text for the five swatches; the top label gets "+" when values exceed the color scale.
export function legendLabels(metric, domain) {
  const over = domain.max > (domain.kind === 'log' ? domain.top : domain.hi) ? '+' : '';
  const labels = domain.kind === 'log'
    ? domain.breaks.map((b, i) => (i === 0 ? '0' : metric.short(b)))
    : [metric.naLabel || 'N/A', ...domain.breaks.slice(1).map((b) => metric.short(b))];
  labels[4] += over;
  return labels;
}

export function normalize(domain, v) {
  if (!Number.isFinite(v)) return NaN;
  if (domain.kind === 'log') return v <= 0 ? 0 : Math.min(1, Math.log10(1 + v / domain.a) / LOG_DEN);
  return Math.min(1, Math.max(0, (v - domain.lo) / (domain.hi - domain.lo)));
}

// palette colors -> ramp stops for this domain
export function rampStops(domain, colors) {
  if (domain.kind === 'log') {
    // grey is reserved for (near) zero: reach the first ramp color early
    return domain.breaks.map((b, i) => [normalize(domain, b) * (i === 1 ? 0.4 : 1), colors[i]]);
  }
  return [[0, colors[1]], [1 / 3, colors[2]], [2 / 3, colors[3]], [1, colors[4]]];
}
