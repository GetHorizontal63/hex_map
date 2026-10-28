// Hex lattice + border clipping.
//
// The lattice is global (anchored at the projection origin), so a given tile
// size always produces the same hexes no matter what is in focus. Hexes that
// sit wholly inside a region are emitted as "full" (drawn instanced); hexes
// that straddle a border are cut by the real boundary and emitted as
// individually triangulated "pieces".
import { ShapeUtils, Vector2 } from 'three';

const SQRT3 = Math.sqrt(3);

export class Lattice {
  constructor(R) {
    this.R = R;          // circumradius (center to corner)
    this.w = SQRT3 * R;  // flat-to-flat width = column spacing
    this.h = 1.5 * R;    // row spacing
    this.area = 1.5 * SQRT3 * R * R;
  }
  center(q, r) { return [this.w * (q + r / 2), this.h * r]; }
  locate(x, y) {
    const fq = ((SQRT3 / 3) * x - y / 3) / this.R, fr = ((2 / 3) * y) / this.R;
    const fs = -fq - fr;
    let q = Math.round(fq), r = Math.round(fr);
    const s = Math.round(fs);
    const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return [q, r];
  }
  // pointy-top corners, counter-clockwise in (x, y) so the polygon has positive signed area
  corners(cx, cy, scale = 1) {
    const out = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (60 * k + 30);
      out.push([cx + this.R * scale * Math.cos(a), cy + this.R * scale * Math.sin(a)]);
    }
    return out;
  }
  hexesInRect(x0, y0, x1, y1) {
    const out = [];
    for (let r = Math.ceil(y0 / this.h); r <= Math.floor(y1 / this.h); r++) {
      const qa = Math.ceil(x0 / this.w - r / 2), qb = Math.floor(x1 / this.w - r / 2);
      for (let q = qa; q <= qb; q++) out.push({ q, r, x: this.w * (q + r / 2), y: this.h * r });
    }
    return out;
  }
}

export const cellKey = (q, r) => (q + 2097152) * 4194304 + (r + 2097152);

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

// Sutherland–Hodgman against one half-plane (left of a->b is inside)
function clipHalf(ring, ax, ay, bx, by) {
  const n = ring.length;
  if (!n) return ring;
  const out = [];
  const ex = bx - ax, ey = by - ay;
  let p = ring[n - 1];
  let dp = ex * (p[1] - ay) - ey * (p[0] - ax);
  for (let i = 0; i < n; i++) {
    const c = ring[i];
    const dc = ex * (c[1] - ay) - ey * (c[0] - ax);
    if ((dc >= 0) !== (dp >= 0)) {
      const t = dp / (dp - dc);
      out.push([p[0] + t * (c[0] - p[0]), p[1] + t * (c[1] - p[1])]);
    }
    if (dc >= 0) out.push(c);
    p = c; dp = dc;
  }
  return out;
}

function clipConvex(ring, clip) {
  let out = ring;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    out = clipHalf(out, a[0], a[1], b[0], b[1]);
  }
  return out;
}

const clipRect = (ring, x0, y0, x1, y1) => clipConvex(ring, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

function cleanRing(ring, eps) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p);
  }
  while (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) > eps || Math.abs(a[1] - b[1]) > eps) break;
    out.pop();
  }
  return out;
}

/**
 * Cut the lattice by a set of regions.
 * regions: [{ polys, focus: bool }]
 * Returns cells (unique hexes) plus full-hex instances and clipped pieces.
 */
export function buildHexes(regions, lattice, shrink) {
  const R = lattice.R;
  const hexArea = lattice.area * shrink * shrink;
  const minPiece = hexArea * 0.003;
  const unit = lattice.corners(0, 0, shrink);

  const keyToCell = new Map();
  const cellX = [], cellY = [], cellFlags = [];
  const fullOffsets = [], fullCells = [];
  const pieces = [];

  function cellOf(h, focus) {
    const key = cellKey(h.q, h.r);
    let id = keyToCell.get(key);
    if (id === undefined) {
      id = cellX.length;
      keyToCell.set(key, id);
      cellX.push(h.x); cellY.push(h.y); cellFlags.push(0);
    }
    cellFlags[id] |= focus ? 1 : 2;
    return id;
  }
  const emitFull = (h, focus) => {
    const id = cellOf(h, focus);
    fullOffsets.push(h.x, h.y);
    fullCells.push(id * 2 + (focus ? 1 : 0));
  };
  const emitPiece = (h, rings, focus) => pieces.push({ cell: cellOf(h, focus), focus, rings });

  function leaf(rings, hexes, focus) {
    const [outer, ...holes] = rings;
    for (const h of hexes) {
      const hp = unit.map(([x, y]) => [x + h.x, y + h.y]);
      const o = clipConvex(outer, hp);
      if (o.length < 3) continue;
      const a = Math.abs(ringArea(o));
      if (a < minPiece) continue;
      const hs = [];
      for (const hole of holes) {
        const c = clipConvex(hole, hp);
        if (c.length >= 3 && Math.abs(ringArea(c)) > hexArea * 1e-4) hs.push(c);
      }
      if (!hs.length && a > hexArea * (1 - 1e-6)) emitFull(h, focus);
      else emitPiece(h, [o, ...hs], focus);
    }
  }

  function recurse(rings, hexes, rect, focus) {
    const outer = rings[0];
    if (outer.length < 3 || !hexes.length) return;
    let nv = 0;
    for (const r of rings) nv += r.length;
    if (hexes.length <= 6 || nv <= 24) return leaf(rings, hexes, focus);
    const [x0, y0, x1, y1] = rect;
    const rectArea = (x1 - x0) * (y1 - y0);
    const a = Math.abs(ringArea(outer));
    if (a < 1e-12) return;
    if (rings.length === 1 && Math.abs(a - rectArea) < rectArea * 1e-9) {
      for (const h of hexes) emitFull(h, focus);
      return;
    }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const quads = [[], [], [], []];
    for (const h of hexes) quads[(h.x >= mx ? 1 : 0) + (h.y >= my ? 2 : 0)].push(h);
    for (let k = 0; k < 4; k++) {
      const hs = quads[k];
      if (!hs.length) continue;
      let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
      for (const h of hs) {
        if (h.x < qx0) qx0 = h.x; if (h.x > qx1) qx1 = h.x;
        if (h.y < qy0) qy0 = h.y; if (h.y > qy1) qy1 = h.y;
      }
      const qr = [qx0 - R, qy0 - R, qx1 + R, qy1 + R];
      const o = clipRect(outer, ...qr);
      if (o.length < 3) continue;
      const holes = [];
      for (let i = 1; i < rings.length; i++) {
        const c = clipRect(rings[i], ...qr);
        if (c.length >= 3) holes.push(c);
      }
      recurse([o, ...holes], hs, qr, focus);
    }
  }

  for (const region of regions) {
    for (const poly of region.polys) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of poly[0]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const hexes = lattice.hexesInRect(x0 - R, y0 - R, x1 + R, y1 + R);
      if (hexes.length) recurse(poly, hexes, [x0 - 2 * R, y0 - 2 * R, x1 + 2 * R, y1 + 2 * R], !!region.focus);
    }
  }

  return {
    lattice, shrink, keyToCell,
    cellCount: cellX.length,
    cellX: Float32Array.from(cellX), cellY: Float32Array.from(cellY), cellFlags: Uint8Array.from(cellFlags),
    full: { offsets: Float32Array.from(fullOffsets), cells: Float32Array.from(fullCells), count: fullCells.length },
    pieceGeometry: meshPieces(pieces, R),
    pieceCount: pieces.length,
  };
}

// ---------------------------------------------------------------- prism meshing
//
// Every column is a prism with a rounded bevel along its top edge, which is what
// catches the light and gives the glazed-tile look. Vertices carry:
//   position  x/z footprint, y = 0 (ground) or 1 (top; scaled to the column height in the shader)
//   normal    final surface normal (the bevel normals sweep from horizontal to up)
//   aIn       x/z: inward miter offset, z: drop below the top, both in bevel units;
//             the shader multiplies by the bevel size, which shrinks on very short columns
const BEVEL_STEPS = 3;
const PROFILE = Array.from({ length: BEVEL_STEPS + 1 }, (_, k) => {
  const t = (k / BEVEL_STEPS) * (Math.PI / 2);
  return { inset: 1 - Math.cos(t), drop: 1 - Math.sin(t), c: Math.cos(t), s: Math.sin(t) };
});

class PrismBuilder {
  constructor() { this.pos = []; this.nrm = []; this.ins = []; this.cell = []; this.index = []; }
  vert(x, y, z, nx, ny, nz, ix, iz, drop, packed) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.ins.push(ix, iz, drop);
    if (packed !== undefined) this.cell.push(packed);
    return this.pos.length / 3 - 1;
  }
  // rings: [outer, ...holes] as [[x, z], ...]
  add(rings, packed) {
    const flat = rings.flat();
    const ringInfo = rings.map((ring, ri) => {
      const m = ring.length;
      const s = Math.sign(ringArea(ring)) * (ri === 0 ? 1 : -1);
      // outward unit normal of each edge i -> i+1
      const out = ring.map((p, i) => {
        const q = ring[(i + 1) % m];
        const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz) || 1;
        return [(s * dz) / len, (-s * dx) / len];
      });
      // inward miter per vertex: offsetting both adjacent edges inward by 1
      const miter = ring.map((_, i) => {
        const n1 = out[(i - 1 + m) % m], n2 = out[i];
        const d = 1 + n1[0] * n2[0] + n1[1] * n2[1];
        let mx = -(n1[0] + n2[0]) / Math.max(d, 0.15), mz = -(n1[1] + n2[1]) / Math.max(d, 0.15);
        const l = Math.hypot(mx, mz);
        if (l > 2.5) { mx *= 2.5 / l; mz *= 2.5 / l; }
        return [mx, mz];
      });
      return { ring, s, out, miter };
    });

    // top face, fully inset
    const top0 = this.pos.length / 3;
    for (const { ring, miter } of ringInfo) {
      ring.forEach(([x, z], i) => this.vert(x, 1, z, 0, 1, 0, miter[i][0], miter[i][1], 0, packed));
    }
    const tris = ShapeUtils.triangulateShape(
      rings[0].map(([x, z]) => new Vector2(x, z)),
      rings.slice(1).map((r) => r.map(([x, z]) => new Vector2(x, z))),
    );
    for (const [a, b, c] of tris) {
      const A = flat[a], B = flat[b], C = flat[c];
      const up = (B[1] - A[1]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[1] - A[1]);
      if (up >= 0) this.index.push(top0 + a, top0 + b, top0 + c);
      else this.index.push(top0 + a, top0 + c, top0 + b);
    }

    // walls + bevel strips, one set of vertices per edge so each face keeps its own normal
    for (const { ring, s, out, miter } of ringInfo) {
      const m = ring.length;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const [xi, zi] = ring[i], [xj, zj] = ring[j];
        const [nx, nz] = out[i];
        const rows = [[
          this.vert(xi, 0, zi, nx, 0, nz, 0, 0, 0, packed),
          this.vert(xj, 0, zj, nx, 0, nz, 0, 0, 0, packed),
        ]];
        for (const p of PROFILE) {
          rows.push([
            this.vert(xi, 1, zi, nx * p.c, p.s, nz * p.c, miter[i][0] * p.inset, miter[i][1] * p.inset, p.drop, packed),
            this.vert(xj, 1, zj, nx * p.c, p.s, nz * p.c, miter[j][0] * p.inset, miter[j][1] * p.inset, p.drop, packed),
          ]);
        }
        for (let r = 0; r + 1 < rows.length; r++) {
          const [bi, bj] = rows[r], [ti, tj] = rows[r + 1];
          if (s > 0) this.index.push(bi, tj, bj, bi, ti, tj);
          else this.index.push(bi, bj, tj, bi, tj, ti);
        }
      }
    }
  }
  finish() {
    const n = this.pos.length / 3;
    return {
      positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), insets: new Float32Array(this.ins),
      cells: new Float32Array(this.cell), index: n > 65535 ? new Uint32Array(this.index) : new Uint16Array(this.index),
    };
  }
}

// Beveled prism for a full hex at the origin (drawn instanced).
export function hexPrism(lattice, shrink) {
  const b = new PrismBuilder();
  const inner = lattice.corners(0, 0, shrink);
  b.add([inner]);
  // floor apron filling the gap out to the full hex outline, so the space
  // between columns reads as dark grout rather than the page background
  if (shrink < 1) {
    const outer = lattice.corners(0, 0, 1);
    const iv = inner.map(([x, z]) => b.vert(x, 0, z, 0, 1, 0, 0, 0, 0));
    const ov = outer.map(([x, z]) => b.vert(x, 0, z, 0, 1, 0, 0, 0, 0));
    const tri = (a, c, d, pa, pc, pd) => {
      const up = (pc[1] - pa[1]) * (pd[0] - pa[0]) - (pc[0] - pa[0]) * (pd[1] - pa[1]);
      if (up >= 0) b.index.push(a, c, d); else b.index.push(a, d, c);
    };
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      tri(iv[i], ov[i], ov[j], inner[i], outer[i], outer[j]);
      tri(iv[i], ov[j], iv[j], inner[i], outer[j], inner[j]);
    }
  }
  return b.finish();
}

function meshPieces(pieces, R) {
  const eps = R * 1e-6;
  const b = new PrismBuilder();
  for (const piece of pieces) {
    const rings = piece.rings.map((r) => cleanRing(r, eps)).filter((r) => r.length >= 3);
    if (rings.length) b.add(rings, piece.cell * 2 + (piece.focus ? 1 : 0));
  }
  return b.finish();
}
