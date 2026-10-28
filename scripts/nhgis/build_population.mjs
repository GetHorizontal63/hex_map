// Builds data/timeline/population.{json,bin}: population density per decade, 1800-2020,
// from IPUMS NHGIS county populations on each decade's own (historical) county boundaries.
//
//   cd scripts/nhgis && npm install
//   NHGIS_API_KEY=... node build_population.mjs          (PowerShell: $env:NHGIS_API_KEY="..."; node build_population.mjs)
//
// Options:
//   --years 1800,1850,1900     subset of decades (default 1800..2020)
//   --mock                     no API: rasterize the current counties with 2010/2020 estimates
//                              (exercises everything after the download, for testing)
//
// Output is a density raster in the app's map units (Albers USA, scale 1300), one byte per
// cell per decade, log-encoded. The app samples it under each hex, so any tile size works.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { geoAlbersUsa } from 'd3-geo';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';
import { feature } from 'topojson-client';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(ROOT, 'scripts', '.cache', 'nhgis');
const OUT = path.join(ROOT, 'data', 'timeline');
const API = 'https://api.ipums.org';
const Q = 'collection=nhgis&version=2';

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
// raster in map units: 1 unit is about 3 miles
const GRID = { x0: -10, y0: -10, size: 1, cols: 1000, rows: 640 };
// codes 1..255 cover 10^-1 .. 10^5 people per sq mi; 0 means nobody / no data
const ENC = { min: -1, max: 5 };
const SQ_M_PER_SQ_MI = 2589988.11;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const YEARS = opt('--years') ? opt('--years').split(',').map(Number) : Array.from({ length: 23 }, (_, i) => 1800 + i * 10);

// ---------------------------------------------------------------- NHGIS API
function key() {
  const k = process.env.NHGIS_API_KEY;
  if (!k) throw new Error('Set NHGIS_API_KEY (free at https://account.ipums.org/api_keys) or use --mock.');
  return k;
}
async function api(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: key(), 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function allPages(url) {
  const out = [];
  let next = `${url}${url.includes('?') ? '&' : '?'}pageSize=2500`;
  while (next) {
    const page = await api(next);
    out.push(...page.data);
    next = page.links?.nextPage || null;
  }
  return out;
}

// Pick, for each decade, a county-level dataset with a total-population table, and the
// matching county boundary file. NHGIS names vary by era, so this goes by metadata.
async function plan() {
  const datasets = await allPages(`${API}/metadata/datasets?${Q}`);
  const shapes = await allPages(`${API}/metadata/shapefiles?${Q}`);
  const picks = [];
  for (const year of YEARS) {
    const candidates = datasets
      .filter((d) => d.name.startsWith(`${year}_`) && /census/i.test(d.group || d.description || ''))
      // the standard population datasets first: early cPop, then SF1/STF1/DHC
      .sort((a, b) => score(b.name) - score(a.name));
    let chosen = null;
    for (const d of candidates) {
      const meta = await api(`${API}/metadata/datasets/${encodeURIComponent(d.name)}?${Q}`);
      if (!meta.geogLevels?.some((g) => g.name === 'county')) continue;
      const table = meta.dataTables?.find((t) => /^total population$/i.test(t.description))
        || meta.dataTables?.find((t) => /total population|^persons$/i.test(t.description));
      if (table) { chosen = { dataset: d.name, table: table.name, code: table.nhgisCode }; break; }
    }
    const shape = shapes
      .filter((s) => /county/i.test(s.geographicLevel) && /united states/i.test(s.extent) && +s.year === year)
      .sort((a, b) => (/tl2008/.test(b.name) ? 1 : 0) - (/tl2008/.test(a.name) ? 1 : 0))[0];
    if (!chosen || !shape) { console.warn(`  ${year}: no county population dataset or boundaries found, skipping`); continue; }
    console.log(`  ${year}: ${chosen.dataset} / ${chosen.table} (${chosen.code}), boundaries ${shape.name}`);
    picks.push({ year, ...chosen, shapefile: shape.name });
  }
  return picks;
}
function score(name) {
  return /cPop|_cPHAM/.test(name) ? 3 : /DHCa|SF1a|STF1/.test(name) ? 2 : /SF1|DHC/.test(name) ? 1 : 0;
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  const res = await fetch(url, { headers: { Authorization: key() } });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function extract(picks) {
  const tag = picks.map((p) => p.year).join('-');
  const marker = path.join(CACHE, `extract-${tag}.json`);
  let ext = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  if (!ext) {
    const datasets = {};
    for (const p of picks) datasets[p.dataset] = { dataTables: [p.table], geogLevels: ['county'] };
    ext = await api(`${API}/extracts?${Q}`, {
      method: 'POST',
      body: JSON.stringify({
        datasets, shapefiles: picks.map((p) => p.shapefile),
        dataFormat: 'csv_no_header', breakdownAndDataTypeLayout: 'single_file',
        description: 'Hex Atlas: historical county population 1800-2020',
      }),
    });
    fs.writeFileSync(marker, JSON.stringify(ext));
    console.log(`  submitted NHGIS extract #${ext.number}`);
  }
  for (;;) {
    ext = await api(`${API}/extracts/${ext.number}?${Q}`);
    if (ext.status === 'completed') break;
    if (/failed|canceled/.test(ext.status)) throw new Error(`extract ${ext.number} ${ext.status}`);
    console.log(`  extract #${ext.number}: ${ext.status}…`);
    await new Promise((r) => setTimeout(r, 15000));
  }
  const tables = await download(ext.downloadLinks.tableData.url, path.join(CACHE, `nhgis-${ext.number}-csv.zip`));
  const gis = await download(ext.downloadLinks.gisData.url, path.join(CACHE, `nhgis-${ext.number}-shape.zip`));
  return { tables, gis };
}

// GISJOIN -> population, per year
function readPopulations(zipPath, picks) {
  const zip = new AdmZip(zipPath);
  const out = new Map();
  for (const p of picks) {
    const entry = zip.getEntries().find((e) => e.entryName.endsWith('.csv') && e.entryName.includes(`_${p.year}_county`));
    if (!entry) { console.warn(`  ${p.year}: table file not found in extract`); continue; }
    const [head, ...rows] = entry.getData().toString('latin1').trim().split(/\r?\n/).map(parseCsvLine);
    const gi = head.indexOf('GISJOIN');
    const pi = head.findIndex((h) => h === `${p.code}001`) >= 0 ? head.indexOf(`${p.code}001`) : head.findIndex((h) => h.startsWith(p.code));
    const pops = new Map();
    for (const r of rows) pops.set(r[gi], +r[pi] || 0);
    out.set(p.year, pops);
  }
  return out;
}
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// Each county as { rings (map units), density }
async function readCounties(zipPath, p, pops) {
  const outer = new AdmZip(zipPath);
  const inner = outer.getEntries().find((e) => e.entryName.endsWith('.zip') && e.entryName.includes(p.shapefile.replace(/^us_county_(\d+)_(\w+)$/, '$2_us_county_$1')))
    || outer.getEntries().find((e) => e.entryName.endsWith('.zip') && e.entryName.includes(`county_${p.year}`));
  const zip = inner ? new AdmZip(inner.getData()) : outer;
  const get = (ext) => zip.getEntries().find((e) => e.entryName.endsWith(ext) && (inner || e.entryName.includes(`county_${p.year}`)))?.getData();
  const shp = get('.shp'), dbf = get('.dbf'), prj = get('.prj')?.toString();
  if (!shp || !dbf || !prj) throw new Error(`${p.year}: shapefile parts missing`);
  const toLonLat = proj4(prj, 'WGS84');
  const source = await shapefile.open(shp, dbf);
  const counties = [];
  for (;;) {
    const { done, value } = await source.read();
    if (done) break;
    const pop = pops.get(value.properties.GISJOIN);
    if (pop == null || !value.geometry) continue;
    const polys = value.geometry.type === 'Polygon' ? [value.geometry.coordinates] : value.geometry.coordinates;
    let areaM2 = 0;
    const rings = [];
    for (const poly of polys) {
      poly.forEach((ring, ri) => {
        areaM2 += Math.abs(planarArea(ring)) * (ri === 0 ? 1 : -1);
        const pr = ring.map((c) => projection(toLonLat.forward(c))).filter(Boolean);
        if (pr.length >= 3) rings.push(pr);
      });
    }
    if (areaM2 > 0 && rings.length) counties.push({ rings, density: pop / (areaM2 / SQ_M_PER_SQ_MI) });
  }
  return counties;
}
function planarArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

// ---------------------------------------------------------------- raster
// Even-odd scanline fill of every county at cell centers.
function rasterize(counties) {
  const { x0, y0, size, cols, rows } = GRID;
  const out = new Uint8Array(cols * rows);
  for (const c of counties) {
    const code = encode(c.density);
    let ymin = Infinity, ymax = -Infinity;
    for (const r of c.rings) for (const [, y] of r) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    const r0 = Math.max(0, Math.ceil((ymin - y0) / size - 0.5)), r1 = Math.min(rows - 1, Math.floor((ymax - y0) / size - 0.5));
    for (let row = r0; row <= r1; row++) {
      const y = y0 + (row + 0.5) * size;
      const xs = [];
      for (const ring of c.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - x0) / size - 0.5)), c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - x0) / size - 0.5));
        for (let col = c0; col <= c1; col++) out[row * cols + col] = code;
      }
    }
  }
  return out;
}
function encode(d) {
  if (!(d > 0)) return 0;
  const t = (Math.log10(d) - ENC.min) / (ENC.max - ENC.min);
  return 1 + Math.round(Math.min(1, Math.max(0, t)) * 254);
}

function write(years, frames, source) {
  fs.mkdirSync(OUT, { recursive: true });
  const bin = new Uint8Array(frames.length * GRID.cols * GRID.rows);
  frames.forEach((f, i) => bin.set(f, i * GRID.cols * GRID.rows));
  fs.writeFileSync(path.join(OUT, 'population.bin'), bin);
  fs.writeFileSync(path.join(OUT, 'population.json'), JSON.stringify({ source, years, grid: GRID, encoding: ENC, bin: 'population.bin' }));
  const idx = path.join(OUT, 'index.json');
  const files = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')).files : [];
  if (!files.includes('population.json')) files.push('population.json');
  fs.writeFileSync(idx, JSON.stringify({ files: files.sort() }));
  console.log(`wrote population.json + population.bin (${years.length} frames, ${(bin.length / 1048576).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------- mock (no API)
async function mock() {
  const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'counties-albers-10m.json'), 'utf8'));
  const csv = fs.readFileSync(path.join(ROOT, 'scripts', '.cache', 'co-est2020-alldata.csv'), 'latin1').trim().split(/\r?\n/).map(parseCsvLine);
  const h = csv[0];
  const pop = (year) => new Map(csv.slice(1).filter((r) => r[h.indexOf('SUMLEV')] === '050')
    .map((r) => [r[h.indexOf('STATE')] + r[h.indexOf('COUNTY')], +r[h.indexOf(`POPESTIMATE${year}`)]]));
  const years = [2010, 2020];
  const frames = years.map((y) => {
    const pops = pop(y);
    const counties = feature(topo, topo.objects.counties).features.flatMap((f) => {
      const p = pops.get(f.id);
      if (p == null || !f.geometry) return [];
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const rings = polys.flat();
      const areaUnits = polys.reduce((s, poly) => s + poly.reduce((t, r, i) => t + Math.abs(planarArea(r)) * (i ? -1 : 1), 0), 0);
      return [{ rings, density: p / (areaUnits * 3.0453 ** 2) }];
    });
    return rasterize(counties);
  });
  write(years, frames, 'MOCK: 2010/2020 county estimates on current boundaries (pipeline test only)');
}

// ---------------------------------------------------------------- main
fs.mkdirSync(CACHE, { recursive: true });
if (args.includes('--mock')) {
  await mock();
} else {
  console.log('Planning datasets…');
  const picks = await plan();
  if (!picks.length) throw new Error('nothing to build');
  console.log('Requesting extract…');
  const { tables, gis } = await extract(picks);
  const pops = readPopulations(tables, picks);
  const years = [], frames = [];
  for (const p of picks) {
    if (!pops.has(p.year)) continue;
    const counties = await readCounties(gis, p, pops.get(p.year));
    console.log(`  ${p.year}: ${counties.length} counties`);
    years.push(p.year);
    frames.push(rasterize(counties));
  }
  write(years, frames, 'IPUMS NHGIS, decennial census county populations on historical county boundaries');
}
