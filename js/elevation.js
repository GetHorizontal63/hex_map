// Mean elevation per hexagon, from the grids in data/elevation/ (see scripts/elevation/).
//
// Each grid cell already holds the mean of the ~30 m USGS 3DEP pixels inside it. A hex takes the mean of
// the cells whose centers fall in it: the national 0.5-unit grid for large hexes, and 0.1-unit tiles
// (loaded on demand for the area being built) for small ones.
import { cellKey } from './hex.js';

let indexLoad = null, ix = null, coarse = null;
const fine = new Map(); // tile key -> grid, or a pending promise
const BASE = 'data/elevation/';

function loadIndex() {
  indexLoad ??= fetch(BASE + 'index.json').then((r) => (r.ok ? r.json() : null)).then((j) => (ix = j)).catch(() => null);
  return indexLoad;
}

// PNG -> meters (R * 256 + G - offset; 0, 0 = no data)
async function loadGrid(file, x0, y0, size, offset) {
  const res = await fetch(BASE + file);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Float32Array(bmp.width * bmp.height);
  for (let i = 0; i < data.length; i++) {
    const v = px[i * 4] * 256 + px[i * 4 + 1];
    data[i] = v ? v - offset : NaN;
  }
  return { x0, y0, size, cols: bmp.width, rows: bmp.height, data };
}

export async function elevationAvailable() {
  return !!(await loadIndex());
}

// Fine tiles covering a map-unit box.
function tilesFor(ix, [bx0, by0, bx1, by1]) {
  const span = ix.fine.size * ix.fine.tile, have = new Set(ix.fine.tiles), out = [];
  for (let ty = Math.floor((by0 - ix.y0) / span); ty <= Math.floor((by1 - ix.y0) / span); ty++) {
    for (let tx = Math.floor((bx0 - ix.x0) / span); tx <= Math.floor((bx1 - ix.x0) / span); tx++) {
      const key = `${tx}_${ty}`;
      if (have.has(key)) out.push({ key, x0: ix.x0 + tx * span, y0: ix.y0 + ty * span });
    }
  }
  return out;
}

// Mean elevation for every cell of a hex build. Returns { values, complete }, or null while the national
// grid loads. `complete` is false while fine tiles the build wants are still loading; `onLoaded` fires
// when they (or the national grid) arrive, so the caller can ask again.
export function hexElevation(build, wantFine, onLoaded) {
  if (!coarse) {
    loadIndex().then(() => ix && loadGrid(ix.coarse.file, ix.x0, ix.y0, ix.coarse.size, ix.offset)).then((g) => {
      if (g) { coarse = g; onLoaded(); }
    });
    return null;
  }
  const box = buildBox(build);
  let grids = [coarse], complete = true;
  if (wantFine) {
    const tiles = tilesFor(ix, box); // the index is loaded: the national grid needed it
    // not requested yet, or still loading (a tile that failed is stored as null and treated as empty)
    const missing = tiles.filter((t) => !fine.has(t.key) || fine.get(t.key) instanceof Promise);
    if (missing.length) {
      complete = false;
      Promise.all(missing.map((t) => {
        if (!fine.has(t.key)) {
          fine.set(t.key, loadGrid(`fine/${t.key}.png`, t.x0, t.y0, ix.fine.size, ix.offset).then((g) => { fine.set(t.key, g); return g; }));
        }
        return fine.get(t.key);
      })).then(onLoaded);
    } else if (tiles.length) {
      grids = tiles.map((t) => fine.get(t.key)).filter(Boolean);
    }
  }
  return { values: average(build, grids, box), complete };
}

function buildBox(build) {
  const R = build.lattice.R;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let c = 0; c < build.cellCount; c++) {
    const x = build.cellX[c], y = build.cellY[c];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0 - R, y0 - R, x1 + R, y1 + R];
}

function average(build, grids, [bx0, by0, bx1, by1]) {
  const n = build.cellCount, sum = new Float64Array(n), cnt = new Uint32Array(n), L = build.lattice;
  for (const g of grids) {
    const c0 = Math.max(0, Math.floor((bx0 - g.x0) / g.size)), c1 = Math.min(g.cols - 1, Math.floor((bx1 - g.x0) / g.size));
    const r0 = Math.max(0, Math.floor((by0 - g.y0) / g.size)), r1 = Math.min(g.rows - 1, Math.floor((by1 - g.y0) / g.size));
    for (let r = r0; r <= r1; r++) {
      const y = g.y0 + (r + 0.5) * g.size;
      for (let c = c0; c <= c1; c++) {
        const v = g.data[r * g.cols + c];
        if (v !== v) continue; // NaN: no land
        const [q, rr] = L.locate(g.x0 + (c + 0.5) * g.size, y);
        const cell = build.keyToCell.get(cellKey(q, rr));
        if (cell === undefined) continue;
        sum[cell] += v; cnt[cell]++;
      }
    }
  }
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    if (cnt[c]) { out[c] = sum[c] / cnt[c]; continue; }
    // a hex smaller than a grid cell (or a sliver of one) takes the cell under its center
    out[c] = NaN;
    for (const g of grids) {
      const gc = Math.floor((build.cellX[c] - g.x0) / g.size), gr = Math.floor((build.cellY[c] - g.y0) / g.size);
      if (gc >= 0 && gr >= 0 && gc < g.cols && gr < g.rows && g.data[gr * g.cols + gc] === g.data[gr * g.cols + gc]) {
        out[c] = g.data[gr * g.cols + gc];
        break;
      }
    }
  }
  return out;
}
