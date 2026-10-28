// City labels: uppercase names with a leader line down to the top of the hex
// column. Placement is greedy by population with simple collision avoidance.
import { Vector3 } from 'three';

const NS = 'http://www.w3.org/2000/svg';
const MAX_CANDIDATES = 80;

export class Labels {
  constructor(root) {
    this.root = root;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.classList.add('leaders');
    root.appendChild(this.svg);
    this.items = [];
    this.v = new Vector3();
  }

  // candidates: [{ name, pop, x, y (map units), cid, focus }] sorted by population
  setCandidates(cands) {
    for (const it of this.items) { it.el.remove(); it.line.remove(); it.dot.remove(); }
    this.items = cands.slice(0, MAX_CANDIDATES).map((c) => {
      const el = document.createElement('div');
      el.className = 'plabel';
      el.textContent = c.name;
      this.root.appendChild(el);
      const line = document.createElementNS(NS, 'line');
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '2.6');
      this.svg.append(line, dot);
      return { ...c, el, line, dot, w: 0, h: 0, shown: false };
    });
    this.measured = false;
    this.plan = null;
  }

  measure() {
    for (const it of this.items) {
      it.el.style.display = 'block';
      const r = it.el.getBoundingClientRect();
      it.w = r.width; it.h = r.height;
      it.el.style.display = 'none';
      it.shown = false;
    }
    this.measured = true;
  }

  // Which cities show, and on which side, is decided by plan() and then held: labels only follow
  // their anchors until the inputs change (city list, count, viewport, settled camera). That keeps
  // them from swapping or blinking while bars animate or a timeline plays.
  // avoid: [{x0,y0,x1,y1}] screen rects to keep clear (title, legend, panel)
  // rangeOf(cid) -> [lowest, highest] column height the label will ride through
  update(camera, width, height, heightOf, maxCount, avoid, settled = true, rangeOf = null) {
    if (!this.measured && this.items.length) { this.measure(); this.planKey = null; }
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('height', height);
    // Re-plan only when the view itself changes (label count, viewport, camera pose). Data changes,
    // timeline frames and the size of on-screen text (e.g. the date stamp) never trigger it.
    const e = camera.matrixWorld.elements;
    const key = [maxCount, width, height, ...[12, 13, 14, 8, 9, 10].map((i) => e[i].toFixed(1))].join('|');
    if (!this.plan || (settled && key !== this.planKey)) {
      this.plan = this.makePlan(camera, width, height, heightOf, maxCount, avoid, rangeOf);
      this.planKey = key;
    }
    for (const it of this.items) {
      const opt = this.plan.get(it);
      let show = opt !== undefined;
      if (show) {
        const a = this.anchor(it, camera, width, height, heightOf);
        if (!a) show = false;
        else {
          const [lx, ly, ex, ey] = this.options(it, a[0], a[1])[opt];
          it.el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
          it.line.setAttribute('x1', a[0]); it.line.setAttribute('y1', a[1]);
          it.line.setAttribute('x2', ex); it.line.setAttribute('y2', ey);
          it.dot.setAttribute('cx', a[0]); it.dot.setAttribute('cy', a[1]);
          it.sx = lx; it.sy = ly; it.ax = a[0]; it.ay = a[1]; it.ex = ex; it.ey = ey;
        }
      }
      if (show !== it.shown) {
        it.shown = show;
        const d = show ? '' : 'none';
        it.el.style.display = show ? 'block' : 'none';
        it.line.style.display = d; it.dot.style.display = d;
      }
    }
  }

  anchor(it, camera, width, height, heightOf) {
    this.v.set(it.x, heightOf(it.cid), it.y).project(camera);
    if (this.v.z >= 1 || Math.abs(this.v.x) >= 1 || Math.abs(this.v.y) >= 1) return null;
    return [(this.v.x * 0.5 + 0.5) * width, (-this.v.y * 0.5 + 0.5) * height];
  }

  options(it, ax, ay) {
    const lead = 18;
    return [
      [ax - it.w / 2, ay - lead - it.h, ax, ay - lead + 1],
      [ax + 10, ay - lead - it.h + 4, ax + 10, ay - lead + 0.5 - it.h / 2 + 4],
      [ax - 10 - it.w, ay - lead - it.h + 4, ax - 10, ay - lead + 0.5 - it.h / 2 + 4],
      [ax - it.w / 2, ay - lead * 2.2 - it.h, ax, ay - lead * 2.2 + 1],
    ];
  }

  // Greedy by population (biggest first); returns item -> option index. Each label is tested over
  // the whole vertical sweep of its column (lowest to highest height), so if two labels would
  // overlap at any height, the smaller town is the one left out.
  makePlan(camera, width, height, heightOf, maxCount, avoid, rangeOf) {
    const plan = new Map(), placed = [...avoid], anchors = [];
    const minSep = Math.max(48, Math.min(width, height) * 0.06);
    for (const it of this.items) {
      if (plan.size >= maxCount) break;
      const [lo, hi] = rangeOf ? rangeOf(it.cid) : [heightOf(it.cid), heightOf(it.cid)];
      const aLo = this.anchor(it, camera, width, height, () => lo);
      const aHi = this.anchor(it, camera, width, height, () => hi);
      if (!aLo || !aHi) continue;
      // keep satellite towns from crowding a bigger neighbour, at either end of the sweep
      if (anchors.some(([x, y]) => [aLo, aHi].some(([ax, ay]) => Math.hypot(x - ax, y - ay) < minSep))) continue;
      const oLo = this.options(it, aLo[0], aLo[1]), oHi = this.options(it, aHi[0], aHi[1]);
      for (let k = 0; k < oLo.length; k++) {
        const box = {
          x0: Math.min(oLo[k][0], oHi[k][0]) - 4, y0: Math.min(oLo[k][1], oHi[k][1]) - 2,
          x1: Math.max(oLo[k][0], oHi[k][0]) + it.w + 4, y1: Math.max(oLo[k][1], oHi[k][1]) + it.h + 2,
        };
        if (box.x0 < 4 || box.y0 < 4 || box.x1 > width - 4 || box.y1 > height - 4) continue;
        if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
        // the pin's own path (dot and leader) is off limits to later labels too
        placed.push(box, {
          x0: Math.min(aLo[0], aHi[0]) - 3, y0: Math.min(aLo[1], aHi[1], oLo[k][3], oHi[k][3]) - 3,
          x1: Math.max(aLo[0], aHi[0]) + 3, y1: Math.max(aLo[1], aHi[1]) + 3,
        });
        anchors.push(aLo, aHi);
        plan.set(it, k);
        break;
      }
    }
    return plan;
  }

  visible() { return this.items.filter((i) => i.shown); }
}
