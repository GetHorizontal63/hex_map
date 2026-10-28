// Builds data/elevation/: mean elevation grids in the app's map units (Albers USA, scale 1300), from
// USGS 3DEP elevation as served by AWS Terrain Tiles (Terrarium PNGs, s3://elevation-tiles-prod).
//
//   cd scripts/elevation && npm install && node build_elevation.mjs
//
// Source pixels: zoom 12 for the lower 48 and Hawaii (about 25-35 m), zoom 11 for Alaska (about 25-48 m).
// Every source pixel over land is projected and averaged into a fine grid (0.1 map units, about
// 0.3 mi / 470 m on the mainland), so a hexagon's elevation is the mean of the 3DEP pixels inside it.
// Ocean and the Great Lakes are masked out with the map's own national outline.
//
// Output:
//   coarse.png   whole country at 0.5 map units (about 1.5 mi), for large hexes
//   fine/*.png   50 x 50 unit tiles at 0.1 map units, loaded only where small hexes need them
//   index.json   grid layout and encoding
// Pixels encode meters as R * 256 + G - 1001 (0, 0 = no data).
//
// Options: --limit N  (process only the first N tiles, for testing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoAlbersUsa } from 'd3-geo';
import { PNG } from 'pngjs';
import { feature } from 'topojson-client';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(ROOT, 'scripts', '.cache', 'terrain');
const OUT = path.join(ROOT, 'data', 'elevation');
const URL_T = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const LIMIT = opt('--limit') ? +opt('--limit') : Infinity;

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const X0 = -10, Y0 = -10, W = 1000, H = 640; // map-unit extent of every grid
const FINE = 0.1, MASK = 0.025, COARSE = 0.5, TILE = 500; // cell sizes (map units); fine tile = 500 cells
const FC = Math.round(W / FINE), FR = Math.round(H / FINE);
const OFFSET = 1001;

// ---------------------------------------------------------------- land mask from the national outline
console.log('rasterizing the land mask…');
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'counties-albers-10m.json'), 'utf8'));
const nation = feature(topo, topo.objects.nation).features[0].geometry;
const MC = Math.round(W / MASK), MR = Math.round(H / MASK);
const mask = new Uint8Array(Math.ceil((MC * MR) / 8));
{
  const rows = Array.from({ length: MR }, () => []);
  const rings = nation.type === 'Polygon' ? nation.coordinates : nation.coordinates.flat();
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xa, ya] = ring[j], [xb, yb] = ring[i];
      if (ya === yb) continue;
      const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
      // rows whose center line crosses this edge (half-open, so shared vertices count once)
      for (let r = Math.max(0, Math.ceil((lo - Y0) / MASK - 0.5)); r < MR; r++) {
        const yc = Y0 + (r + 0.5) * MASK;
        if (yc >= hi) break;
        if (yc < lo) continue;
        rows[r].push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
      }
    }
  }
  for (let r = 0; r < MR; r++) {
    const xs = rows[r].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - X0) / MASK - 0.5)), c1 = Math.min(MC - 1, Math.floor((xs[k + 1] - X0) / MASK - 0.5));
      for (let c = c0; c <= c1; c++) { const b = r * MC + c; mask[b >> 3] |= 1 << (b & 7); }
    }
  }
}
const isLand = (x, y) => {
  const c = Math.floor((x - X0) / MASK), r = Math.floor((y - Y0) / MASK);
  if (c < 0 || r < 0 || c >= MC || r >= MR) return false;
  const b = r * MC + c;
  return (mask[b >> 3] >> (b & 7)) & 1;
};
// coarse "near land" grid (1 unit, dilated by one cell) for choosing which source tiles to fetch
const NC = W, NR = H, near = new Uint8Array(NC * NR);
for (let r = 0; r < MR; r++) for (let c = 0; c < MC; c++) {
  const b = r * MC + c;
  if (!((mask[b >> 3] >> (b & 7)) & 1)) continue;
  const gc = Math.floor((c * MASK) / 1), gr = Math.floor((r * MASK) / 1);
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const cc = gc + dc, rr = gr + dr;
    if (cc >= 0 && rr >= 0 && cc < NC && rr < NR) near[rr * NC + cc] = 1;
  }
}
const nearLand = (p) => p && near[Math.floor(p[1] - Y0) * NC + Math.floor(p[0] - X0)] === 1;

// ---------------------------------------------------------------- source tiles
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

const REGIONS = [
  { z: 12, lon: [-125, -66], lat: [24, 50] },    // lower 48
  { z: 12, lon: [-161, -154], lat: [18, 23] },   // Hawaii
  { z: 11, lon: [-180, -129], lat: [51, 72] },   // Alaska
];
const tiles = [];
for (const { z, lon, lat } of REGIONS) {
  const xa = Math.floor(lon2x(lon[0], z)), xb = Math.floor(lon2x(lon[1], z));
  const ya = Math.floor(lat2y(lat[1], z)), yb = Math.floor(lat2y(lat[0], z));
  for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) {
    let hit = false;
    for (let i = 0; i <= 4 && !hit; i++) for (let j = 0; j <= 4 && !hit; j++) {
      hit = nearLand(projection([x2lon(x + i / 4, z), y2lat(y + j / 4, z)]));
    }
    if (hit) tiles.push({ z, x, y });
  }
}
console.log(`${tiles.length} source tiles over land`);

// ---------------------------------------------------------------- accumulate
const sum = new Float32Array(FC * FR), cnt = new Uint16Array(FC * FR);
const G = 16, STEP = 256 / G; // project a 17 x 17 lattice per tile and interpolate between
function accumulate(t, png) {
  const P = [];
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    P.push(projection([x2lon(t.x + (i * STEP) / 256, t.z), y2lat(t.y + (j * STEP) / 256, t.z)]));
  }
  const d = png.data;
  for (let py = 0; py < 256; py++) {
    const fy = (py + 0.5) / STEP, j = Math.min(G - 1, Math.floor(fy)), ty = fy - j;
    for (let px = 0; px < 256; px++) {
      const fx = (px + 0.5) / STEP, i = Math.min(G - 1, Math.floor(fx)), tx = fx - i;
      const a = P[j * (G + 1) + i], b = P[j * (G + 1) + i + 1], c = P[(j + 1) * (G + 1) + i], e = P[(j + 1) * (G + 1) + i + 1];
      if (!a || !b || !c || !e) continue;
      const X = (a[0] * (1 - tx) + b[0] * tx) * (1 - ty) + (c[0] * (1 - tx) + e[0] * tx) * ty;
      const Y = (a[1] * (1 - tx) + b[1] * tx) * (1 - ty) + (c[1] * (1 - tx) + e[1] * tx) * ty;
      if (!isLand(X, Y)) continue;
      const k = (py * 256 + px) * 4;
      const m = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
      // the 1:10M outline lets some sea through on coasts; no U.S. land is below Death Valley (-86 m).
      // A few tiles hold glitch pixels near the format's maximum (~32,767 m); nothing is above Denali (6,190 m).
      if (m < -90 || m > 6200) continue;
      const f = Math.floor((Y - Y0) / FINE) * FC + Math.floor((X - X0) / FINE);
      if (cnt[f] === 65535) continue;
      sum[f] += m; cnt[f]++;
    }
  }
}

async function fetchTile(t) {
  const file = path.join(CACHE, String(t.z), String(t.x), `${t.y}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(URL_T(t.z, t.x, t.y));
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      return buf;
    } catch (e) {
      if (attempt >= 5) { console.warn(`  skipped ${t.z}/${t.x}/${t.y}: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

const todo = tiles.slice(0, LIMIT);
let done = 0, missing = 0;
const started = Date.now();
await Promise.all(Array.from({ length: 24 }, async () => {
  while (todo.length) {
    const t = todo.shift();
    const buf = await fetchTile(t);
    if (buf) {
      try { accumulate(t, PNG.sync.read(buf)); } catch { missing++; }
    } else missing++;
    if (++done % 2000 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done} / ${Math.min(tiles.length, LIMIT)} tiles (${rate.toFixed(0)}/s, ~${Math.round((Math.min(tiles.length, LIMIT) - done) / rate / 60)} min left)`);
    }
  }
}));
console.log(`accumulated ${done} tiles (${missing} missing)`);

// ---------------------------------------------------------------- write grids
function encode(cols, rows, valueAt) {
  const png = new PNG({ width: cols, height: rows, colorType: 6 });
  let any = false;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = valueAt(c, r), k = (r * cols + c) * 4;
    png.data[k + 3] = 255;
    if (!Number.isFinite(m)) continue;
    const v = Math.max(1, Math.min(65535, Math.round(m) + OFFSET));
    png.data[k] = v >> 8; png.data[k + 1] = v & 255;
    any = true;
  }
  return any ? PNG.sync.write(png, { colorType: 2, deflateLevel: 9 }) : null;
}

// clear the old output but keep the folders (an open file explorer can lock them on Windows)
fs.mkdirSync(path.join(OUT, 'fine'), { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, 'fine'))) fs.rmSync(path.join(OUT, 'fine', f), { force: true });
const fineMean = (c, r) => { const f = r * FC + c; return cnt[f] ? sum[f] / cnt[f] : NaN; };

const k = Math.round(COARSE / FINE), CC = Math.round(W / COARSE), CR = Math.round(H / COARSE);
const coarse = encode(CC, CR, (c, r) => {
  let s = 0, n = 0;
  for (let dr = 0; dr < k; dr++) for (let dc = 0; dc < k; dc++) {
    const f = (r * k + dr) * FC + c * k + dc;
    s += sum[f]; n += cnt[f];
  }
  return n ? s / n : NaN;
});
fs.writeFileSync(path.join(OUT, 'coarse.png'), coarse);

const fineTiles = [];
let fineBytes = 0;
for (let ty = 0; ty < Math.ceil(FR / TILE); ty++) for (let tx = 0; tx < Math.ceil(FC / TILE); tx++) {
  const buf = encode(TILE, TILE, (c, r) => {
    const gc = tx * TILE + c, gr = ty * TILE + r;
    return gc < FC && gr < FR ? fineMean(gc, gr) : NaN;
  });
  if (!buf) continue;
  fs.writeFileSync(path.join(OUT, 'fine', `${tx}_${ty}.png`), buf);
  fineTiles.push(`${tx}_${ty}`);
  fineBytes += buf.length;
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  source: 'USGS 3D Elevation Program (3DEP), via AWS Terrain Tiles',
  x0: X0, y0: Y0, offset: OFFSET,
  coarse: { size: COARSE, cols: CC, rows: CR, file: 'coarse.png' },
  fine: { size: FINE, tile: TILE, tiles: fineTiles },
}));
console.log(`wrote data/elevation: coarse.png ${(coarse.length / 1e6).toFixed(1)} MB, ${fineTiles.length} fine tiles ${(fineBytes / 1e6).toFixed(1)} MB`);
