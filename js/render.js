// Three.js scene. Hex heights and colors live in two float textures (from/to);
// the vertex shader mixes between them with a per-hex staggered delay, so a
// transition between data sets is a single uniform tween.
import * as THREE from 'three';
import { hexPrism } from './hex.js';

const TEX_W = 2048;
export const TRANSITION_SPREAD = 0.85; // fraction of the tween used to stagger hexes

const HEAD = /* glsl */`
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uT;
uniform float uMinX;
uniform float uSpanX;
uniform float uBase;
uniform float uCtxH;
uniform float uCtxMix;
uniform vec3 uCtxColor;
uniform float uBevel;
uniform float uStagger;
attribute float aCell;
attribute vec3 aIn;
#ifdef HEX_INSTANCED
attribute vec2 aOffset;
#endif
float hexHash(int i) {
  uint x = uint(i);
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return float(x & 0xffffffu) / 16777216.0;
}
`;
const BODY = /* glsl */`
vec3 transformed = vec3(position);
#ifdef HEX_INSTANCED
transformed.xz += aOffset;
#endif
int packedCell = int(aCell + 0.5);
int cid = packedCell / 2;
float hexFocus = float(packedCell - cid * 2);
ivec2 tsz = textureSize(uFrom, 0);
ivec2 tc = ivec2(cid % tsz.x, cid / tsz.x);
vec4 ca = texelFetch(uFrom, tc, 0);
vec4 cb = texelFetch(uTo, tc, 0);
float dly = (clamp((transformed.x - uMinX) / uSpanX, 0.0, 1.0) * 0.55 + hexHash(cid) * 0.3) * uStagger;
float lt = smoothstep(dly, dly + 1.0, uT * (1.0 + ${TRANSITION_SPREAD} * uStagger));
float hh = mix(ca.a, cb.a, lt);
vec3 hexCol = mix(ca.rgb, cb.rgb, lt);
if (hexFocus < 0.5) { hh *= uCtxH; hexCol = mix(hexCol, uCtxColor, uCtxMix); }
float hTot = hh + uBase;
float bev = min(uBevel, hTot * 0.45);   // short tiles get a proportionally smaller bevel
transformed.xz += aIn.xy * bev;
transformed.y = position.y * hTot - aIn.z * bev;
`;

// JS mirror of the shader timing, used for labels and picking
export function hexHash(i) {
  let x = i >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0; x ^= x >>> 16;
  return (x & 0xffffff) / 16777216;
}
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

const COLOR_VARYINGS = 'varying vec3 vHexColor;\nvarying float vHexY;\nvarying float vHexWall;\n';

function patch(material, uniforms, instanced, colored) {
  material.defines = { ...(material.defines || {}), ...(instanced ? { HEX_INSTANCED: '' } : {}) };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + HEAD + (colored ? COLOR_VARYINGS : ''))
      .replace('#include <begin_vertex>', BODY + (colored ? 'vHexColor = hexCol; vHexY = transformed.y; vHexWall = 1.0 - abs(normal.y);\n' : ''));
    if (colored) {
      // contact shading: walls darken toward the ground, like occlusion in the gaps between tiles
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uAO;\nuniform float uBase;\n' + COLOR_VARYINGS)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
          'vec4 diffuseColor = vec4( vHexColor * mix(1.0, 0.42 + 0.58 * smoothstep(0.0, uAO, vHexY), vHexWall), opacity );' +
          // the floor apron (flat, at ground level) is dark grout
          '\nif (vHexWall < 0.5 && vHexY < uBase * 0.25) diffuseColor.rgb = vHexColor * 0.16;');
    }
  };
  material.customProgramCacheKey = () => 'hex' + (instanced ? 'I' : 'P') + (colored ? 'C' : 'D');
  return material;
}

export class HexRenderer {
  constructor(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    // shadow filtering is chosen by setDiffusion()
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    // fixed viewpoint: the camera only moves when the app frames a new focus
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.5, 20000);
    this.target = new THREE.Vector3();

    // a low fill so shaded faces stay dark; the glaze highlight comes only from the
    // sun (which shadows block), not from unshadowed environment reflections
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.3);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff6ea, 6.5);
    this.sun.castShadow = true;
    const maxTex = renderer.capabilities.maxTextureSize;
    this.sun.shadow.mapSize.set(Math.min(4096, maxTex), Math.min(4096, maxTex));
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    this.sunAzimuth = 300; // degrees clockwise from north; light comes from the north-west
    this.sunElevation = 30;

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3, color: 0x000000 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.position.y = -0.001;
    this.scene.add(this.ground);

    this.uniforms = {
      uFrom: { value: null }, uTo: { value: null }, uT: { value: 1 },
      uMinX: { value: 0 }, uSpanX: { value: 1 }, uBase: { value: 0.1 },
      uCtxH: { value: 0.18 }, uCtxMix: { value: 0.8 }, uCtxColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uBevel: { value: 0.1 }, uAO: { value: 1 },
      uStagger: { value: 1 }, // 0 during timeline playback: every hex moves in lockstep
    };
    // glazed clay: satin body under a light clear coat
    const std = (inst) => patch(new THREE.MeshPhysicalMaterial({
      roughness: 0.5, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.28, shadowSide: THREE.BackSide,
    }), this.uniforms, inst, true);
    const depth = (inst) => patch(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), this.uniforms, inst, false);
    this.matInst = std(true); this.matPiece = std(false);
    this.depthInst = depth(true); this.depthPiece = depth(false);

    this.meshes = [];
    this.tween = null;
    this.camTween = null;
  }

  setSize(w, h) {
    this.renderer.setSize(w, h, false);
    this.width = w; this.height = h;
    this.camera.aspect = w / h;
    this.applyViewShift();
  }

  // shift the rendered view left by `px` so the map centers in the area beside the panel
  setViewShift(px) {
    this.viewShift = px;
    this.applyViewShift();
  }
  applyViewShift() {
    const s = this.viewShift || 0;
    if (s) this.camera.setViewOffset(this.width, this.height, s, 0, this.width, this.height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  setTheme({ bg, shadowOpacity, contextColor }) {
    this.ground.material.color.set(0x000000);
    this.ground.material.opacity = shadowOpacity;
    this.hemi.groundColor.set(new THREE.Color(bg).lerp(new THREE.Color(0x777777), 0.5));
    this.uniforms.uCtxColor.value.set(contextColor);
  }

  setBuild(build) {
    for (const m of this.meshes) { this.scene.remove(m); m.geometry.dispose(); }
    this.meshes = [];
    const { full, pieceGeometry, lattice, shrink, cellCount } = build;
    this.uniforms.uBevel.value = lattice.R * shrink * 0.16;
    this.uniforms.uAO.value = lattice.R * 1.6;

    if (full.count) {
      const prism = hexPrism(lattice, shrink);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(prism.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(prism.normals, 3));
      g.setAttribute('aIn', new THREE.BufferAttribute(prism.insets, 3));
      g.setIndex(new THREE.BufferAttribute(prism.index, 1));
      g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(full.offsets, 2));
      g.setAttribute('aCell', new THREE.InstancedBufferAttribute(full.cells, 1));
      g.instanceCount = full.count;
      this.meshes.push(this.makeMesh(g, this.matInst, this.depthInst));
    }
    if (pieceGeometry.positions.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pieceGeometry.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(pieceGeometry.normals, 3));
      g.setAttribute('aIn', new THREE.BufferAttribute(pieceGeometry.insets, 3));
      g.setAttribute('aCell', new THREE.BufferAttribute(pieceGeometry.cells, 1));
      g.setIndex(new THREE.BufferAttribute(pieceGeometry.index, 1));
      this.meshes.push(this.makeMesh(g, this.matPiece, this.depthPiece));
    }

    const texH = Math.max(1, Math.ceil(cellCount / TEX_W));
    const make = () => {
      const t = new THREE.DataTexture(new Float32Array(TEX_W * texH * 4), TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    this.uniforms.uFrom.value?.dispose();
    this.uniforms.uTo.value?.dispose();
    this.uniforms.uFrom.value = make();
    this.uniforms.uTo.value = make();
    this.cellX = build.cellX;
  }

  makeMesh(g, mat, depth) {
    const m = new THREE.Mesh(g, mat);
    m.customDepthMaterial = depth;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  get fromData() { return this.uniforms.uFrom.value.image.data; }
  get toData() { return this.uniforms.uTo.value.image.data; }

  // Snapshot what is currently on screen into `from`, then animate to `target` (rgba per cell).
  transition(target, duration, xRange) {
    const from = this.fromData, to = this.toData;
    const n = target.length / 4;
    if (this.uniforms.uT.value < 1) {
      for (let i = 0; i < n; i++) {
        const lt = this.cellT(i);
        for (let k = 0; k < 4; k++) from[i * 4 + k] = from[i * 4 + k] + (to[i * 4 + k] - from[i * 4 + k]) * lt;
      }
    } else {
      from.set(to.subarray(0, from.length));
    }
    to.set(target);
    this.uniforms.uFrom.value.needsUpdate = true;
    this.uniforms.uTo.value.needsUpdate = true;
    this.uniforms.uMinX.value = xRange[0];
    this.uniforms.uSpanX.value = Math.max(1e-3, xRange[1] - xRange[0]);
    if (duration <= 0) { this.uniforms.uT.value = 1; this.tween = null; return; }
    this.uniforms.uT.value = 0;
    this.tween = { start: performance.now(), duration };
  }

  // eased local progress of a cell, mirroring the shader
  cellT(cid) {
    const u = this.uniforms;
    if (u.uT.value >= 1) return 1;
    const st = u.uStagger.value;
    const d = (Math.min(1, Math.max(0, (this.cellX[cid] - u.uMinX.value) / u.uSpanX.value)) * 0.55 + hexHash(cid) * 0.3) * st;
    return smoothstep(d, d + 1, u.uT.value * (1 + TRANSITION_SPREAD * st));
  }
  // final height of the current transition (where the bar is heading), for steady label anchors
  targetHeight(cid, focus = true) {
    return this.toData[cid * 4 + 3] * (focus ? 1 : this.uniforms.uCtxH.value) + this.uniforms.uBase.value;
  }

  cellHeight(cid, focus = true) {
    const lt = this.cellT(cid);
    const a = this.fromData[cid * 4 + 3], b = this.toData[cid * 4 + 3];
    return (a + (b - a) * lt) * (focus ? 1 : this.uniforms.uCtxH.value) + this.uniforms.uBase.value;
  }

  // 0 = hard sun, crisp black shadows; 1 = overcast: blurred shadow edges and more sky fill
  setDiffusion(d) {
    // Crisp shadows use PCF-soft. Diffuse ones use variance shadow maps, which blur the map
    // itself into smooth penumbrae (a wide PCF radius only spreads its samples into grain),
    // but VSM turns blotchy when barely blurred, so it only takes over past a little diffusion.
    const type = d < 0.15 ? THREE.PCFSoftShadowMap : THREE.VSMShadowMap;
    const sm = this.renderer.shadowMap;
    if (sm.type !== type) {
      sm.type = type;
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      for (const m of [this.matInst, this.matPiece, this.depthInst, this.depthPiece, this.ground.material]) m.needsUpdate = true;
    }
    this.sun.shadow.radius = 1 + d * 14;
    this.sun.shadow.blurSamples = 8 + Math.round(d * 17);
    this.sun.intensity = 6.5 - d * 2.8;
    this.hemi.intensity = 0.3 + d * 1.3;
  }

  // Sun direction + shadow frustum sized to the given box (x0, z0, x1, z1, maxHeight)
  fitLight(box) {
    const [x0, z0, x1, z1, hMax] = box;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, span = Math.max(x1 - x0, z1 - z0);
    const az = THREE.MathUtils.degToRad(this.sunAzimuth), el = THREE.MathUtils.degToRad(this.sunElevation);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx, 0, cz).addScaledVector(dir, span * 2);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(this.sun.target.position);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, n = Infinity, f = -Infinity;
    const v = new THREE.Vector3();
    for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [0, hMax]) {
      v.set(x, y, z).applyMatrix4(inv);
      l = Math.min(l, v.x); r = Math.max(r, v.x); b = Math.min(b, v.y); t = Math.max(t, v.y);
      n = Math.min(n, -v.z); f = Math.max(f, -v.z);
    }
    Object.assign(cam, { left: l, right: r, bottom: b, top: t, near: Math.max(0.1, n - 10), far: f + span });
    cam.updateProjectionMatrix();
    this.ground.scale.set(span * 8, span * 8, 1);
    this.ground.position.set(cx, -0.001, cz);
  }

  // Camera pose that frames a box, viewed from the south at the given tilt.
  // Iteratively projects the box corners so the map lands inside `region`
  // (NDC bounds [x0, x1, y0, y1]), leaving room for the title and legend.
  framing(box, { tilt = 46, region = [-0.94, 0.94, -0.84, 0.64], camera = this.camera } = {}) {
    const [x0, z0, x1, z1, hMax] = box;
    const phi = THREE.MathUtils.degToRad(tilt);
    const dir = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi));
    const target = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    let dist = Math.max(x1 - x0, z1 - z0) * 2.2;
    const cam = camera.clone();
    const corners = [];
    for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [0, hMax]) corners.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    const [rx0, rx1, ry0, ry1] = region;
    for (let it = 0; it < 12; it++) {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let mx0 = Infinity, mx1 = -Infinity, my0 = Infinity, my1 = -Infinity;
      for (const c of corners) {
        v.copy(c).project(cam);
        mx0 = Math.min(mx0, v.x); mx1 = Math.max(mx1, v.x); my0 = Math.min(my0, v.y); my1 = Math.max(my1, v.y);
      }
      const scale = Math.max((mx1 - mx0) / (rx1 - rx0), (my1 - my0) / (ry1 - ry0));
      // shift the target so the projected box is centered in the region
      const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * dist;
      const halfW = halfH * cam.aspect;
      const dx = ((mx0 + mx1) / 2 - (rx0 + rx1) / 2) * halfW;
      const dy = ((my0 + my1) / 2 - (ry0 + ry1) / 2) * halfH;
      target.x += dx;
      target.z -= dy / Math.cos(phi);
      dist *= 0.35 + 0.65 * scale;
    }
    return { pos: target.clone().addScaledVector(dir, dist), target, dist };
  }

  flyTo(pose, duration = 1400) {
    if (duration <= 0) {
      this.camTween = null;
      this.camera.position.copy(pose.pos); this.target.copy(pose.target); this.camera.lookAt(this.target);
      return;
    }
    this.camTween = {
      start: performance.now(), duration,
      p0: this.camera.position.clone(), t0: this.target.clone(), p1: pose.pos, t1: pose.target,
    };
  }

  update(now) {
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.start) / this.tween.duration);
      this.uniforms.uT.value = k;
      if (k >= 1) this.tween = null;
    }
    if (this.camTween) {
      const c = this.camTween;
      const k = Math.min(1, (now - c.start) / c.duration);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(c.p0, c.p1, e);
      this.target.lerpVectors(c.t0, c.t1, e);
      if (k >= 1) this.camTween = null;
    }
    this.camera.lookAt(this.target);
  }

  render() { this.renderer.render(this.scene, this.camera); }

  // Render once at an arbitrary size with another camera (poster export), hand the
  // canvas to `draw` before it is cleared, then restore the on-screen size.
  renderTo(camera, w, h, draw) {
    if (this.batch) {
      // inside begin/endBatch the buffer stays at the export size between frames
      if (this.batch.w !== w || this.batch.h !== h) { this.renderer.setSize(w, h, false); this.batch.w = w; this.batch.h = h; }
      this.renderer.render(this.scene, camera);
      draw(this.renderer.domElement);
      return;
    }
    const r = this.renderer, pr = r.getPixelRatio();
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.render(this.scene, camera);
    draw(r.domElement);
    r.setPixelRatio(pr);
    r.setSize(this.width, this.height, false);
  }

  // many offscreen frames in a row (GIF export) without resizing back and forth each time
  beginBatch() {
    this.batch = { pr: this.renderer.getPixelRatio(), w: 0, h: 0 };
    this.renderer.setPixelRatio(1);
  }
  endBatch() {
    if (!this.batch) return;
    this.renderer.setPixelRatio(this.batch.pr);
    this.renderer.setSize(this.width, this.height, false);
    this.batch = null;
  }
}
