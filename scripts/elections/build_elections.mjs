// Builds data/elections/{year}.json: President, U.S. Senate and Governor results by precinct, from the
// Voting and Election Science Team's precinct shapefiles (Harvard Dataverse, CC BY 4.0).
//
//   cd scripts/elections && npm install && node build_elections.mjs
//
// Options:
//   --years 2016,2020   subset of years (default: all VEST general-election years with shapes)
//   --states de,md      subset of states (for testing)
//
// Each precinct becomes a point: its centroid in the app's map units (Albers USA, scale 1300), its
// land area, and per race its Democratic, Republican and total votes. The app sums the points into
// hexes the same way it does census tracts, so any tile size works.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { geoAlbersUsa } from 'd3-geo';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(ROOT, 'scripts', '.cache', 'vest');
const OUT = path.join(ROOT, 'data', 'elections');

const DATASETS = {
  2012: 'doi:10.7910/DVN/B3NTZR', // Florida and Kansas only
  2016: 'doi:10.7910/DVN/NH5S2I',
  2018: 'doi:10.7910/DVN/UBKYRU', // no California or Kentucky
  2020: 'doi:10.7910/DVN/K7760H',
};
// VEST field codes: G (general) + 2-digit year + office + party letter + candidate, e.g. G20PREDBID
const RACES = { pres: 'PRE', sen: 'USS', gov: 'GOV' };
// independents who ran as the Democrats' candidate (no Democrat, or a token one): count them as D
const AS_DEM = /USSI(KIN|SAN)$/i; // Angus King (ME), Bernie Sanders (VT)

const STATES = 'ak al ar az ca co ct dc de fl ga hi ia id il in ks ky la ma md me mi mn mo ms mt nc nd ne nh nj nm nv ny oh ok or pa ri sc sd tn tx ut va vt wa wi wv wy'.split(' ');
const FIPS = { al: 1, ak: 2, az: 4, ar: 5, ca: 6, co: 8, ct: 9, de: 10, dc: 11, fl: 12, ga: 13, hi: 15, id: 16, il: 17, in: 18, ia: 19, ks: 20, ky: 21, la: 22, me: 23, md: 24, ma: 25, mi: 26, mn: 27, ms: 28, mo: 29, mt: 30, ne: 31, nv: 32, nh: 33, nj: 34, nm: 35, ny: 36, nc: 37, nd: 38, oh: 39, ok: 40, or: 41, pa: 42, ri: 44, sc: 45, sd: 46, tn: 47, tx: 48, ut: 49, vt: 50, va: 51, wa: 53, wv: 54, wi: 55, wy: 56 };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const YEARS = opt('--years') ? opt('--years').split(',').map(Number) : Object.keys(DATASETS).map(Number);
const ONLY = opt('--states') ? opt('--states').split(',') : STATES;

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
// equal-area metres, for precinct areas and centroids
const AEA = '+proj=aea +lat_1=29.5 +lat_2=45.5 +lat_0=37.5 +lon_0=-96 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs';
const SQ_M_PER_SQ_MI = 2589988.11;

// ---------------------------------------------------------------- downloads
async function listFiles(doi) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://dataverse.harvard.edu/api/datasets/:persistentId/?persistentId=${doi}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()).data.latestVersion.files.map((f) => ({ id: f.dataFile.id, name: f.dataFile.filename }));
    } catch (e) {
      if (attempt >= 4) throw new Error(`Dataverse listing ${doi}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// files that cover only part of their state; VEST's VTD estimates file covers all of it
const PREFER = { 2020: { nj: 'nj_2020_vtd_estimates.zip' } };

// the statewide general-election file: "ny_2020.zip" or "ny.zip", not the primaries, specials or estimates
function pickFile(files, st, year) {
  const pref = PREFER[year]?.[st];
  return (pref && files.find((f) => f.name === pref))
    || files.find((f) => f.name === `${st}_${year}.zip`) || files.find((f) => f.name === `${st}.zip`);
}

async function download(file, year) {
  const dest = path.join(CACHE, String(year), file.name);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://dataverse.harvard.edu/api/access/datafile/${file.id}`);
      if (!res.ok) throw new Error(`${res.status}`);
      fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
      fs.renameSync(dest + '.part', dest);
      return dest;
    } catch (e) {
      if (attempt >= 4) throw new Error(`download ${file.name} (${year}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// Some files (FL, MD, NJ, TX) pad numbers with NUL bytes, which the dbf reader turns into nothing.
// Records start after the header, so blank those NULs to spaces from there on.
function dbfWithSpaces(buf) {
  const b = Buffer.from(buf), start = b.readUInt16LE(8);
  for (let i = start; i < b.length; i++) if (b[i] === 0) b[i] = 32;
  return b;
}

// ---------------------------------------------------------------- geometry
// shoelace area and area-weighted centroid over every ring (holes wind the other way, so they subtract)
function ringsStats(rings, toAea) {
  let A = 0, cx = 0, cy = 0;
  for (const ring of rings) {
    const p = ring.map(toAea);
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const cross = p[j][0] * p[i][1] - p[i][0] * p[j][1];
      A += cross;
      cx += (p[j][0] + p[i][0]) * cross;
      cy += (p[j][1] + p[i][1]) * cross;
    }
  }
  if (!A) return null;
  return { area: Math.abs(A / 2), x: cx / (3 * A), y: cy / (3 * A) };
}

function polygonRings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

// ---------------------------------------------------------------- one state
// Which columns belong to each race, split by party. A race needs both a Democrat and a
// Republican to have a margin; otherwise (uncontested, or California's top-two) it's skipped.
function raceFields(keys, year, st) {
  const yy = String(year).slice(2), out = {}, skipped = [];
  for (const [race, code] of Object.entries(RACES)) {
    if (race === 'sen' && st === 'dc') continue; // DC's "shadow senator" isn't a Senate seat
    const all = keys.filter((k) => new RegExp(`^G${yy}${code}`, 'i').test(k));
    if (!all.length) continue;
    const party = (k) => k[6].toUpperCase();
    const d = all.filter((k) => party(k) === 'D' || AS_DEM.test(k));
    const r = all.filter((k) => party(k) === 'R');
    // a token Democrat beside an independent standing in for the party is left out of D
    const dem = d.some((k) => AS_DEM.test(k)) ? d.filter((k) => AS_DEM.test(k)) : d;
    if (!dem.length || !r.length) { skipped.push(race); continue; }
    out[race] = { all, d: dem, r };
  }
  return { races: out, skipped };
}

async function readState(zipPath, st, year) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const shp = entries.filter((e) => /\.shp$/i.test(e.entryName)).sort((a, b) => b.header.size - a.header.size)[0];
  if (!shp) throw new Error(`${st} ${year}: no .shp in ${path.basename(zipPath)}`);
  const base = shp.entryName.replace(/\.shp$/i, '');
  const get = (ext) => entries.find((e) => e.entryName.toLowerCase() === (base + ext).toLowerCase());
  const prj = get('.prj')?.getData().toString('utf8').trim();
  const aea = proj4(AEA);
  // shapes arrive in each state's own projection; geographic ones go straight to equal-area
  const toAea = prj && !/^GEOGCS/i.test(prj) ? proj4(prj, AEA).forward : aea.forward;
  const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const src = await shapefile.open(ab(shp.getData()), ab(dbfWithSpaces(get('.dbf').getData())));

  const rows = [];
  let fields = null, noShape = 0;
  for (;;) {
    const { done, value } = await src.read();
    if (done) break;
    const p = value.properties;
    fields ??= raceFields(Object.keys(p), year, st);
    const s = ringsStats(polygonRings(value.geometry), toAea);
    const xy = s && projection(aea.inverse([s.x, s.y]));
    if (!xy) { noShape++; continue; }
    const votes = {};
    for (const [race, f] of Object.entries(fields.races)) {
      const sum = (list) => list.reduce((acc, k) => acc + (+p[k] || 0), 0);
      votes[race] = [sum(f.d), sum(f.r), sum(f.all)];
    }
    rows.push({ x: xy[0], y: xy[1], a: s.area / SQ_M_PER_SQ_MI, votes });
  }
  return { rows, noShape, races: Object.keys(fields?.races || {}), skipped: fields?.skipped || [] };
}

// ---------------------------------------------------------------- main
fs.mkdirSync(OUT, { recursive: true });
const indexPath = path.join(OUT, 'index.json');
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { source: '', years: [] };
index.source = 'Voting and Election Science Team, precinct-level election results (Harvard Dataverse, CC BY 4.0)';

for (const year of YEARS) {
  const files = await listFiles(DATASETS[year]);
  const queue = ONLY.filter((st) => pickFile(files, st, year));
  const results = new Map();
  // a few downloads at a time
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const st = queue.shift();
      results.set(st, await readState(await download(pickFile(files, st, year), year), st, year));
    }
  }));

  const cols = { x: [], y: [], a: [], s: [] }, races = {}, meta = {};
  for (const race of Object.keys(RACES)) { races[race] = { d: [], r: [], t: [] }; meta[race] = { states: [], d: 0, r: 0, t: 0 }; }
  for (const st of ONLY) {
    const res = results.get(st);
    if (!res) continue;
    for (const row of res.rows) {
      cols.x.push(Math.round(row.x * 100)); cols.y.push(Math.round(row.y * 100));
      cols.a.push(Math.round(row.a * 1000) / 1000); cols.s.push(FIPS[st]);
      for (const race of Object.keys(RACES)) {
        const [d, r, t] = row.votes[race] || [0, 0, 0];
        races[race].d.push(d); races[race].r.push(r); races[race].t.push(t);
        meta[race].d += d; meta[race].r += r; meta[race].t += t;
      }
    }
    for (const race of res.races) meta[race].states.push(st.toUpperCase());
    const note = [res.noShape ? `${res.noShape} without shape` : '', res.skipped.length ? `skipped ${res.skipped.join(', ')} (no D vs R)` : ''].filter(Boolean).join('; ');
    console.log(`${year} ${st.toUpperCase()}: ${res.rows.length} precincts, races ${res.races.join(', ') || 'none'}${note ? ` (${note})` : ''}`);
  }
  // drop races nobody ran this year
  for (const race of Object.keys(RACES)) if (!meta[race].states.length) { delete races[race]; delete meta[race]; }
  for (const [race, m] of Object.entries(meta)) {
    console.log(`${year} ${race}: ${m.states.length} states, D ${m.d.toLocaleString()} R ${m.r.toLocaleString()} of ${m.t.toLocaleString()}`);
  }
  const file = `${year}.json`;
  fs.writeFileSync(path.join(OUT, file), JSON.stringify({ year, n: cols.x.length, ...cols, races }));
  index.years = index.years.filter((y) => y.year !== year);
  index.years.push({
    year, file, precincts: cols.x.length,
    states: [...results.keys()].map((s) => s.toUpperCase()),
    races: Object.fromEntries(Object.entries(meta).map(([race, m]) => [race, m.states])),
  });
  index.years.sort((a, b) => a.year - b.year);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
  console.log(`wrote data/elections/${file} (${(fs.statSync(path.join(OUT, file)).size / 1e6).toFixed(1)} MB)`);
}
