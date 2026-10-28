// Loads boundaries, census tracts and places; projects everything into the
// Albers USA plane used by us-atlas (scale 1300, translate [487.5, 305]).
import { geoAlbersUsa } from 'd3-geo';
import { feature } from 'topojson-client';
import { METRICS } from './scales.js';
import { ARC_SUBREGIONS } from './appalachia.js';

export const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);

export const STATE_ABBR = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY',
};
const ABBR_TO_FIPS = Object.fromEntries(Object.entries(STATE_ABBR).map(([f, a]) => [a, f]));

// Census regions & divisions and a few popular regions, as quick multi-state focus presets, listed
// under a `section`: each Census region with its divisions, then the other regions. Groups with
// `counties` (Appalachia, from ARC's county list) focus those counties instead of whole states.
const arc = (...subs) => subs.flatMap((s) => ARC_SUBREGIONS[s].split(' '));
const OTHER = 'Other regions';
const SECTIONS = ['Midwest', 'Northeast', 'South', 'West', OTHER];

const groups = [
  ['Midwest', 'Midwest', 'IL IN MI OH WI IA KS MN MO NE ND SD'],
  ['Midwest', 'East North Central', 'IL IN MI OH WI'],
  ['Midwest', 'West North Central', 'IA KS MN MO NE ND SD'],
  ['Northeast', 'Northeast', 'CT ME MA NH RI VT NJ NY PA'],
  ['Northeast', 'Mid-Atlantic', 'NJ NY PA'],
  ['Northeast', 'New England', 'CT ME MA NH RI VT'],
  ['South', 'South', 'DE DC FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX'],
  ['South', 'East South Central', 'AL KY MS TN'],
  ['South', 'South Atlantic', 'DE DC FL GA MD NC SC VA WV'],
  ['South', 'West South Central', 'AR LA OK TX'],
  ['West', 'West', 'AZ CO ID MT NV NM UT WY AK CA HI OR WA'],
  ['West', 'Mountain', 'AZ CO ID MT NV NM UT WY'],
  ['West', 'Pacific', 'AK CA HI OR WA'],
  [OTHER, 'American Rockies', 'CO ID MT NM UT WY'],
  [OTHER, 'Carolinas', 'NC SC'],
  [OTHER, 'Four Corners', 'AZ CO NM UT'],
  [OTHER, 'Great Lakes', 'IL IN MI MN NY OH PA WI'],
  [OTHER, 'Great Plains', 'KS NE ND OK SD'],
  [OTHER, 'Lower 48', Object.values(STATE_ABBR).filter((a) => a !== 'AK' && a !== 'HI').join(' ')],
  [OTHER, 'Pacific Northwest', 'ID OR WA'],
  [OTHER, 'Rust Belt', 'IL IN MI NY OH PA WI'],
].map(([section, name, list]) => ({ section, name, ids: list.split(' ').map((a) => ABBR_TO_FIPS[a]) }))
  .concat([
    ['Appalachia', arc('Northern', 'North Central', 'Central', 'South Central', 'Southern')],
    ['Upper Appalachia', arc('Northern', 'North Central')],
    ['Lower Appalachia', arc('Central', 'South Central', 'Southern')],
  ].map(([name, counties]) => ({ section: OTHER, name, counties })));

// Sorted by section, the section's own region first, then alphabetically, except that "Upper X" and
// "Lower X" sit right after X.
const family = (name) => {
  const base = name.replace(/^(Upper|Lower) /, '');
  return base !== name && groups.some((g) => g.name === base) ? base : name;
};
export const STATE_GROUPS = groups.sort((a, b) =>
  SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section)
  || (b.name === b.section) - (a.name === a.section)
  || family(a.name).localeCompare(family(b.name))
  || (family(b.name) === b.name) - (family(a.name) === a.name)
  || a.name.localeCompare(b.name));

function countyName(id, name) {
  const st = id.slice(0, 2), code = +id.slice(2);
  if (st === '11') return 'District of Columbia';
  if (st === '22') return name + ' Parish';
  if (st === '02') return name;
  if (code >= 500 && (st === '51' || st === '24' || st === '29' || st === '32')) return /City/.test(name) ? name : name + ' city';
  return name + ' County';
}

function toPolys(geom) {
  if (!geom) return [];
  const list = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  // topojson rings are closed; drop the duplicated last point
  return list.map((p) => p.map((ring) => ring.slice(0, -1)));
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

function makeRegion(kind, id, name, fullName, geom) {
  const polys = toPolys(geom);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
  for (const p of polys) {
    for (const [x, y] of p[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    area += Math.abs(ringArea(p[0])) - p.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
  }
  return { kind, id, name, fullName, polys, bbox: [x0, y0, x1, y1], area };
}

export function pointInRegion(region, x, y) {
  const [x0, y0, x1, y1] = region.bbox;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  for (const p of region.polys) {
    let inside = false;
    for (const ring of p) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}

export async function loadAll(onProgress) {
  onProgress('Loading boundaries, tracts and places…');
  const [topo, tractJson, placeJson, covidJson] = await Promise.all([
    fetchJSON('data/counties-albers-10m.json'),
    fetchJSON('data/tracts.json'),
    fetchJSON('data/places.json'),
    fetchJSON('data/timeline/covid.json').catch(() => null),
  ]);
  onProgress('Projecting census tracts…');

  const states = feature(topo, topo.objects.states).features.map((f) =>
    makeRegion('state', f.id, f.properties.name, f.properties.name, f.geometry));
  const stateById = new Map(states.map((s) => [s.id, s]));
  const counties = feature(topo, topo.objects.counties).features.map((f) => {
    const st = stateById.get(f.id.slice(0, 2));
    const name = countyName(f.id, f.properties.name);
    const abbr = STATE_ABBR[f.id.slice(0, 2)] || '';
    const r = makeRegion('county', f.id, name, `${name}, ${abbr}`, f.geometry);
    r.stateId = f.id.slice(0, 2);
    r.stateName = st ? st.name : '';
    return r;
  });
  const nation = makeRegion('nation', 'US', 'United States', 'United States', feature(topo, topo.objects.nation).features[0].geometry);
  states.sort((a, b) => a.name.localeCompare(b.name));
  counties.sort((a, b) => a.fullName.localeCompare(b.fullName));

  // miles per projected unit, measured over one degree of latitude near the center of the country
  const a = projection([-98, 38.5]), b = projection([-98, 39.5]);
  const miPerUnit = 69.05 / Math.hypot(b[0] - a[0], b[1] - a[1]);

  const covidAt = covidLookup(covidJson, counties);
  const tc = tractJson.columns;
  const tracts = preparePoints(tc, tractJson.count, miPerUnit, (i) => Math.floor(tc.county[i] / 1000), covidAt);
  tracts.index = buildGridIndex(tracts.x, tracts.y, tracts.radius, 2);
  const places = preparePlaces(placeJson);

  // Block groups are loaded per state, on demand, and swapped in for that
  // state's tracts. Connecticut has no block-group file and keeps its tracts.
  const bgCache = new Map();
  async function blockGroups(st) {
    if (!bgCache.has(st)) {
      bgCache.set(st, fetchJSON(`data/bg/${st}.json`)
        .then((j) => preparePoints(j.columns, j.count, miPerUnit, () => +st, covidAt))
        .catch(() => null));
    }
    return bgCache.get(st);
  }
  let lastSet = { key: '', set: tracts };
  async function pointsFor(stateIds) {
    const ids = [...new Set(stateIds)].sort();
    const key = ids.join(',');
    if (key === lastSet.key) return lastSet.set;
    const bgs = (await Promise.all(ids.map(blockGroups))).filter(Boolean);
    if (!bgs.length) return tracts;
    const swapped = new Set(bgs.map((g) => g.state[0]));
    const keep = [];
    for (let i = 0; i < tracts.count; i++) if (!swapped.has(tracts.state[i])) keep.push(i);
    const set = mergePoints([{ src: tracts, idx: keep }, ...bgs.map((g) => ({ src: g }))]);
    set.index = buildGridIndex(set.x, set.y, set.radius, 2);
    set.blockGroups = true;
    lastSet = { key, set };
    return set;
  }

  return {
    states, counties, nation, tracts, places, miPerUnit, year: tractJson.year, pointsFor,
    stateById, countyById: new Map(counties.map((c) => [c.id, c])),
  };
}

// Alaska is drawn at 0.35x scale in the Albers USA composite
export const AK_SCALE = 0.35;
const POINT_FIELDS = ['x', 'y', 'area', 'pop', 'radius'];

// COVID-19 totals per 100k (last NYT report) for the county under a projected point. Matched by
// location against the map's counties, as the timelines are, since tract FIPS codes use
// Connecticut's newer planning regions while the NYT series uses its old counties.
function covidLookup(json, counties) {
  if (!json) return null;
  const last = json.dates.length - 1, rate = new Map();
  json.fips.forEach((f, k) => {
    const p = json.pop[k];
    if (p > 0) rate.set(f, [(json.cases[k][last] / p) * 1e5, (json.deaths[k][last] / p) * 1e5]);
  });
  const size = 4, grid = new Map();
  counties.forEach((r, i) => {
    const [x0, y0, x1, y1] = r.bbox;
    for (let gx = Math.floor(x0 / size); gx <= Math.floor(x1 / size); gx++) {
      for (let gy = Math.floor(y0 / size); gy <= Math.floor(y1 / size); gy++) {
        const k = gx * 10000 + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return (x, y) => {
    for (const i of grid.get(Math.floor(x / size) * 10000 + Math.floor(y / size)) || []) {
      if (pointInRegion(counties[i], x, y)) return rate.get(counties[i].id) || null;
    }
    return null;
  };
}

// Columnar census rows -> projected point set (tract or block-group centroids).
function preparePoints(c, n, miPerUnit, stateOf, covidAt) {
  const x = new Float32Array(n), y = new Float32Array(n), area = new Float32Array(n), pop = new Float32Array(n);
  const radius = new Float32Array(n), state = new Uint8Array(n);
  const metrics = {};
  for (const m of METRICS) metrics[m.id] = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = projection([c.lon[i], c.lat[i]]);
    if (!p) continue; // Puerto Rico and other areas outside the Albers USA composite
    x[k] = p[0]; y[k] = p[1];
    area[k] = c.area[i];
    pop[k] = c.pop[i];
    state[k] = stateOf(i);
    // radius of a disk with the unit's land area, in projected units
    radius[k] = Math.max(0.01, (Math.sqrt(c.area[i] / Math.PI) / miPerUnit) * (state[k] === 2 ? AK_SCALE : 1));
    const covid = covidAt ? covidAt(p[0], p[1]) : null;
    for (const m of METRICS) {
      let v;
      if (m.id === 'density') v = c.area[i] > 0 ? c.pop[i] / c.area[i] : (c.pop[i] > 0 ? NaN : 0);
      else if (m.id === 'population') v = c.pop[i];
      else if (m.covid != null) v = covid ? covid[m.covid] : NaN;
      else if (m.grid) v = NaN; // sampled from its own grid, not the census rows
      else v = c[m.id][i];
      metrics[m.id][k] = v == null ? NaN : v;
    }
    k++;
  }
  const t = { count: k, x, y, area, pop, radius, state, metrics };
  for (const f of [...POINT_FIELDS, 'state']) t[f] = t[f].subarray(0, k);
  for (const m of METRICS) metrics[m.id] = metrics[m.id].subarray(0, k);
  return t;
}

function mergePoints(parts) {
  const n = parts.reduce((s, p) => s + (p.idx ? p.idx.length : p.src.count), 0);
  const out = { count: n, state: new Uint8Array(n), metrics: {} };
  for (const f of POINT_FIELDS) out[f] = new Float32Array(n);
  for (const m of METRICS) out.metrics[m.id] = new Float32Array(n);
  let k = 0;
  for (const { src, idx } of parts) {
    if (!idx) {
      for (const f of [...POINT_FIELDS, 'state']) out[f].set(src[f], k);
      for (const m of METRICS) out.metrics[m.id].set(src.metrics[m.id], k);
      k += src.count;
      continue;
    }
    for (const i of idx) {
      for (const f of POINT_FIELDS) out[f][k] = src[f][i];
      out.state[k] = src.state[i];
      for (const m of METRICS) out.metrics[m.id][k] = src.metrics[m.id][i];
      k++;
    }
  }
  return out;
}

// Uniform grid over points stored CSR-style. `owner` finds the tract whose
// centroid is nearest relative to the tract's size (min distance / radius),
// a multiplicatively weighted Voronoi that approximates the tract containing
// a point without needing tract polygons.
// A point set from points already in map units (election precincts), ready for hex aggregation.
// pop is the weight for averages and the count for totals; metrics are per-point values.
export function pointSet({ x, y, area, state, pop, metrics }, miPerUnit) {
  const n = x.length, radius = new Float32Array(n);
  for (let i = 0; i < n; i++) radius[i] = Math.max(0.01, (Math.sqrt(area[i] / Math.PI) / miPerUnit) * (state[i] === 2 ? AK_SCALE : 1));
  const t = { count: n, x, y, area, pop, radius, state, metrics };
  t.index = buildGridIndex(x, y, radius, 2);
  return t;
}

function buildGridIndex(xs, ys, rs, size) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
  }
  const cols = Math.ceil((x1 - x0) / size) + 1, rows = Math.ceil((y1 - y0) / size) + 1;
  const start = new Uint32Array(cols * rows + 1);
  const cellOf = new Uint32Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const c = Math.floor((xs[i] - x0) / size) + Math.floor((ys[i] - y0) / size) * cols;
    cellOf[i] = c; start[c + 1]++;
  }
  for (let i = 0; i < cols * rows; i++) start[i + 1] += start[i];
  const fill = start.slice(0, -1);
  const items = new Uint32Array(xs.length);
  for (let i = 0; i < xs.length; i++) items[fill[cellOf[i]]++] = i;
  const cellMaxR = new Float32Array(cols * rows);
  let maxR = 0;
  for (let i = 0; i < xs.length; i++) {
    if (rs[i] > cellMaxR[cellOf[i]]) cellMaxR[cellOf[i]] = rs[i];
    if (rs[i] > maxR) maxR = rs[i];
  }

  // skip(i) excludes candidates (e.g. tracts already counted inside a hex)
  function owner(px, py, skip, maxRing = 60) {
    const cx = Math.floor((px - x0) / size), cy = Math.floor((py - y0) / size);
    let best = -1, bestS = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (best >= 0 && (Math.max(0, ring - 1) * size) / maxR >= bestS) break;
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= rows) continue;
        const step = gy === cy - ring || gy === cy + ring ? 1 : 2 * ring;
        for (let gx = cx - ring; gx <= cx + ring; gx += step || 1) {
          if (gx < 0 || gx >= cols) continue;
          const c = gx + gy * cols;
          if (!cellMaxR[c]) continue;
          const rx = x0 + gx * size, ry = y0 + gy * size;
          const dx = Math.max(rx - px, 0, px - rx - size), dy = Math.max(ry - py, 0, py - ry - size);
          if (Math.hypot(dx, dy) / cellMaxR[c] >= bestS) continue;
          for (let k = start[c]; k < start[c + 1]; k++) {
            const i = items[k];
            if (skip && skip(i)) continue;
            const s = Math.hypot(xs[i] - px, ys[i] - py) / rs[i];
            if (s < bestS) { bestS = s; best = i; }
          }
        }
      }
    }
    return best;
  }
  return { owner };
}

function preparePlaces(json) {
  const out = [];
  for (const [name, state, lon, lat, pop] of json.rows) {
    const p = projection([lon, lat]);
    if (!p) continue;
    out.push({ name, state, x: p[0], y: p[1], pop });
  }
  return out;
}
