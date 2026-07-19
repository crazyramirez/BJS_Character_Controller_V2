/**
 * autorig_api.mjs
 *
 * Auto-rigging for skinless GLB meshes.
 *  - guessJoints(buffer, { bodyPlan, fingerCount }): analyze the mesh and propose
 *    Mixamo-style joint positions for the requested rig layout.
 *  - autoRigGLB(buffer, { joints, bodyPlan, fingerCount, skeletonPreset, skinFingers }):
 *    build the skeleton at the given joint positions, compute proximity-based
 *    skin weights, and return a rigged GLB.
 *
 * Rig layouts: bodyPlan 'humanoid' (default) or 'quadruped' (horizontal spine,
 * four legs, Tail1-3); fingerCount 0|2|3|4|5 finger chains per hand.
 *
 * The generated bones use plain Mixamo names (Hips, Spine, LeftArm, ...) so the
 * existing merge_api.mjs BONE_MAP retargeting works on the result unchanged.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

let _io = null;
async function getIO() {
  if (_io) return _io;
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  _io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });
  return _io;
}

// ── mat4 helpers (column-major) ──────────────────────────────────────────────
function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}
const MAT4_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
function transformDirection(m, [x, y, z]) {
  const v = [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : v;
}

// Invert affine column-major mat4 (same approach as merge_api: handles scaled IBMs)
function invertRigidMat4(m) {
  const a00 = m[0], a10 = m[1], a20 = m[2];
  const a01 = m[4], a11 = m[5], a21 = m[6];
  const a02 = m[8], a12 = m[9], a22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (!det || !Number.isFinite(det)) return new Float32Array(MAT4_IDENTITY);
  const id = 1 / det;
  const i00 = (a11 * a22 - a12 * a21) * id, i01 = (a02 * a21 - a01 * a22) * id, i02 = (a01 * a12 - a02 * a11) * id;
  const i10 = (a12 * a20 - a10 * a22) * id, i11 = (a00 * a22 - a02 * a20) * id, i12 = (a02 * a10 - a00 * a12) * id;
  const i20 = (a10 * a21 - a11 * a20) * id, i21 = (a01 * a20 - a00 * a21) * id, i22 = (a00 * a11 - a01 * a10) * id;
  return new Float32Array([
    i00, i10, i20, 0,
    i01, i11, i21, 0,
    i02, i12, i22, 0,
    -(i00 * tx + i01 * ty + i02 * tz),
    -(i10 * tx + i11 * ty + i12 * tz),
    -(i20 * tx + i21 * ty + i22 * tz),
    1,
  ]);
}

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) map.set(child, node);
  }
  return map;
}

function worldMatrixOf(node, parentMap, cache) {
  if (cache.has(node)) return cache.get(node);
  const local = node.getMatrix();
  const parent = parentMap.get(node);
  const world = parent ? mat4Mul(worldMatrixOf(parent, parentMap, cache), local) : local;
  cache.set(node, world);
  return world;
}

// ── Skin space → render world ────────────────────────────────────────────────
// Skinned vertices are authored in skin space and rendered as jointWorld·IBM·v.
// At bind pose jointWorld·IBM is the same matrix S for every joint, but S is
// NOT always identity: FBX-sourced exports (UE, Blender, 3ds Max, AccuRig)
// keep vertices Z-up and put the up-axis fix on an armature ancestor, so
// S is that rotation. Returns Map<mesh, mat4> for every skinned mesh.
function skinWorldXforms(doc) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const byMesh = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh || byMesh.has(mesh)) continue;
    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices()?.getArray();
    if (!joints.length || !ibm || ibm.length < 16) {
      byMesh.set(mesh, MAT4_IDENTITY);
      continue;
    }
    const W = worldMatrixOf(joints[0], parentMap, cache);
    byMesh.set(mesh, mat4Mul(W, ibm.slice(0, 16)));
  }
  return byMesh;
}

// ── Mesh bounds (world space) ────────────────────────────────────────────────
function computeWorldBounds(doc, skinXforms = new Map(), bodyMeshes = null) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (bodyMeshes && !bodyMeshes.has(mesh)) continue;
    // Skinned vertices: skin space → world via jointWorld·IBM, not the node chain
    const world = skinXforms.get(mesh) || worldMatrixOf(node, parentMap, cache);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        const p = transformPoint(world, [arr[i], arr[i + 1], arr[i + 2]]);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
  }
  if (!Number.isFinite(min[0])) throw new Error('No mesh geometry found in GLB.');
  return { min, max };
}

// ── Body mesh selection ──────────────────────────────────────────────────────
// Scene files (Sketchfab & co.) often bundle the character with a ground
// plane, props and light gizmos. Rigging/measuring against ALL meshes ruins
// the joint guess and skins the floor to the skeleton. Pick the "body": the
// densest tall mesh plus everything contained in (or near) its bounding box.
function selectBodyMeshes(doc, skinXforms = new Map()) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const entries = [];
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || seen.has(mesh)) continue;
    seen.add(mesh);
    const world = skinXforms.get(mesh) || worldMatrixOf(node, parentMap, cache);
    const min = [1 / 0, 1 / 0, 1 / 0], max = [-1 / 0, -1 / 0, -1 / 0];
    let count = 0;
    for (const prim of mesh.listPrimitives()) {
      const arr = prim.getAttribute('POSITION')?.getArray();
      if (!arr) continue;
      count += arr.length / 3;
      for (let i = 0; i < arr.length; i += 3) {
        const p = transformPoint(world, [arr[i], arr[i + 1], arr[i + 2]]);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
    if (count === 0 || !Number.isFinite(min[0])) continue;
    entries.push({
      mesh, min, max, count,
      height: max[1] - min[1],
      footprint: Math.max(1e-6, (max[0] - min[0]) * (max[2] - min[2])),
    });
  }
  if (entries.length <= 1) return null; // single mesh → no filtering needed

  // Main body = densest tall mesh
  let main = entries[0];
  for (const e of entries) {
    if (e.count * e.height > main.count * main.height) main = e;
  }
  const m = 0.25 * Math.max(main.height, 0.01); // margin around the body box
  // Fraction of [a,b] overlapping [c,d].
  const overlap1D = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  const keep = new Set();
  for (const e of entries) {
    if (e === main) { keep.add(e.mesh); continue; }
    const cx = (e.min[0] + e.max[0]) / 2, cy = (e.min[1] + e.max[1]) / 2, cz = (e.min[2] + e.max[2]) / 2;
    const inside =
      cx > main.min[0] - m && cx < main.max[0] + m &&
      cy > main.min[1] - m && cy < main.max[1] + m &&
      cz > main.min[2] - m && cz < main.max[2] + m;
    if (!inside) continue; // far prop / light gizmo

    // A ground plane / pedestal is a FLAT SLAB: tiny vertical extent but a large
    // footprint. Clothing (capes, coats, robes, armor) is tall and overlaps the
    // body's vertical span heavily, so it must be kept even with a big footprint.
    const flat = e.height < 0.12 * main.height;
    const wide = e.footprint > 1.5 * main.footprint;
    const vOverlap = overlap1D(e.min[1], e.max[1], main.min[1], main.max[1]) / Math.max(e.height, 1e-6);
    const isGround = flat && wide;                       // floor / base disc
    const tooDetached = vOverlap < 0.25 && e.footprint > main.footprint; // big & barely shares the body's height
    if (!isGround && !tooDetached) keep.add(e.mesh);
  }
  if (keep.size === entries.length) return null;
  const dropped = entries.filter(e => !keep.has(e.mesh)).length;
  console.log(`[autorig] Ignoring ${dropped} non-body mesh(es) (ground/props/lights) for rigging.`);
  return keep;
}

// ── Default joint guess from bounds (T/A-pose humanoid heuristics) ───────────
/**
 * Returns Mixamo-named joint world positions guessed from the mesh bounding box.
 * All positions are in glTF world space of the input file.
 */
/**
 * Detect which way the character faces along Z by looking at the feet: toes
 * stick out forward, so the lowest vertices are biased toward the facing side.
 * Returns +1 (faces +Z, Mixamo convention) or -1 (faces -Z).
 */
function detectForwardZ(doc, { min, max }, skinXforms = new Map(), bodyMeshes = null) {
  if (global.MOCK_FORWARD_Z !== undefined) return global.MOCK_FORWARD_Z;
  const H = max[1] - min[1];
  const footY = min[1] + 0.12 * H;
  const faceY = min[1] + 0.85 * H;   // head region: nose/chin protrude forward
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  // Collect the foot and face vertex Z values so each cue can be measured by
  // its ASYMMETRIC OVERHANG (how far the silhouette pokes past its own centre),
  // not the mean. A foot has a short heel and a long toe: the mean is dominated
  // by the dense heel/ankle mass and can point the wrong way, but the toe is the
  // farther-protruding tip — that is the real forward direction.
  const footZ = [], faceZ = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (bodyMeshes && !bodyMeshes.has(mesh)) continue;
    const world = skinXforms.get(mesh) || worldMatrixOf(node, parentMap, cache);
    for (const prim of mesh.listPrimitives()) {
      const arr = prim.getAttribute('POSITION')?.getArray();
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3) {
        const p = transformPoint(world, [arr[i], arr[i + 1], arr[i + 2]]);
        if (p[1] <= footY) footZ.push(p[2]);
        else if (p[1] >= faceY) faceZ.push(p[2]);
      }
    }
  }
  const depth = max[2] - min[2] || 1;
  const bodyCz = (min[2] + max[2]) / 2;
  // Two ways to read a foot's facing, combined:
  //  • offset:  how far the whole foot sits in front of the body centre — strong
  //    when the foot is displaced forward (sitting/running poses).
  //  • overhang: how far the toe TIP protrudes past the foot's own median — the
  //    reliable cue for an upright foot planted under the body (heel↔toe).
  // Summing both means a forward-displaced foot AND a toe overhang each vote,
  // and neither alone has to be decisive.
  const footVote = (zs) => {
    if (zs.length < 4) return 0;
    const med = median(zs);
    let zmax = -Infinity, zmin = Infinity, sum = 0;
    for (const z of zs) { if (z > zmax) zmax = z; if (z < zmin) zmin = z; sum += z; }
    const overhang = ((zmax - med) - (med - zmin)) / depth;
    const offset = ((sum / zs.length) - bodyCz) / depth;
    return overhang + offset;
  };
  const fVote = footVote(footZ);
  const faceVote = footVote(faceZ);
  // Feet dominate; the face only breaks ties when the foot signal is weak
  // (barefoot, perfectly symmetric, flat-foot meshes).
  const footStrong = Math.abs(fVote) > 0.04;
  const combined = footStrong ? fVote : (2.0 * fVote + 1.0 * faceVote);
  if (combined === 0) return 1;
  return combined >= 0 ? 1 : -1;
}

export function guessJointsFromBounds({ min, max }, forwardZ = 1) {
  const H = max[1] - min[1];
  const groundY = min[1];
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const halfW = Math.max((max[0] - min[0]) / 2, 0.3 * H);

  const y = f => groundY + f * H;
  const J = (x, yy, z) => [cx + x, yy, cz + z];

  const shoulderY = y(0.80);
  const joints = {
    Hips: J(0, y(0.53), 0),
    Spine: J(0, y(0.58), 0),
    Spine1: J(0, y(0.66), 0),
    Spine2: J(0, y(0.74), 0),
    Neck: J(0, y(0.85), 0),
    Head: J(0, y(0.89), 0),

    LeftShoulder: J(0.10 * halfW * forwardZ, shoulderY, 0),
    LeftArm: J(0.24 * halfW * forwardZ, shoulderY, 0),
    LeftForeArm: J(0.58 * halfW * forwardZ, shoulderY, 0),
    LeftHand: J(0.88 * halfW * forwardZ, shoulderY, 0),

    RightShoulder: J(-0.10 * halfW * forwardZ, shoulderY, 0),
    RightArm: J(-0.24 * halfW * forwardZ, shoulderY, 0),
    RightForeArm: J(-0.58 * halfW * forwardZ, shoulderY, 0),
    RightHand: J(-0.88 * halfW * forwardZ, shoulderY, 0),

    LeftUpLeg: J(0.06 * H * forwardZ, y(0.50), 0),
    LeftLeg: J(0.06 * H * forwardZ, y(0.27), 0),
    LeftFoot: J(0.06 * H * forwardZ, y(0.06), 0),
    LeftToeBase: J(0.06 * H * forwardZ, y(0.02), 0.10 * H * forwardZ),

    RightUpLeg: J(-0.06 * H * forwardZ, y(0.50), 0),
    RightLeg: J(-0.06 * H * forwardZ, y(0.27), 0),
    RightFoot: J(-0.06 * H * forwardZ, y(0.06), 0),
    RightToeBase: J(-0.06 * H * forwardZ, y(0.02), 0.10 * H * forwardZ),
  };
  return { joints, height: H, bounds: { min, max } };
}

// ── Vertex-based joint refinement ────────────────────────────────────────────
// The bounds guess assumes ideal T-pose proportions. Real meshes vary: A-poses,
// wide stances, hunched spines, big heads. Analyze the actual vertex cloud and
// override the bounds guess where the measurement is reliable.
function collectWorldVertices(doc, skinXforms = new Map(), bodyMeshes = null, maxVerts = 200000) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const pts = [];
  let total = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (bodyMeshes && !bodyMeshes.has(mesh)) continue;
    for (const prim of mesh.listPrimitives()) {
      total += (prim.getAttribute('POSITION')?.getCount()) || 0;
    }
  }
  const stride = Math.max(1, Math.ceil(total / maxVerts));
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (bodyMeshes && !bodyMeshes.has(mesh)) continue;
    const world = skinXforms.get(mesh) || worldMatrixOf(node, parentMap, cache);
    for (const prim of mesh.listPrimitives()) {
      const arr = prim.getAttribute('POSITION')?.getArray();
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3 * stride) {
        pts.push(transformPoint(world, [arr[i], arr[i + 1], arr[i + 2]]));
      }
    }
  }
  return pts;
}

function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function centroidOf(pts) {
  if (!pts.length) return null;
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
}

/**
 * Refine the bounds-based guess using the vertex cloud.
 * Detects: body centerline, crotch height (leg/torso split), per-leg X offset,
 * shoulder height, hand positions (works for T- and A-poses), head centroid.
 * Falls back to the bounds guess for anything that can't be measured reliably.
 */
export function guessJointsFromMesh(verts, bounds, forwardZ = 1) {
  const base = guessJointsFromBounds(bounds, forwardZ);
  if (!verts || verts.length < 300) return base;
  const { min, max } = bounds;
  const H = max[1] - min[1];
  const groundY = min[1];
  const joints = base.joints;
  const fingerTips = {};

  // Body centerline from medians — robust against asymmetric props/capes
  const cx = median(verts.map(p => p[0]));
  const cz = median(verts.map(p => p[2]));
  const yf = p => (p[1] - groundY) / H; // normalized height of a vertex

  // ── Crotch: highest band where the body splits into two legs ──────────────
  // A bin is "split" when both sides are occupied but the centerline is empty.
  const BINS = 80;
  const binOf = p => Math.min(BINS - 1, Math.max(0, Math.floor(yf(p) * BINS)));
  const bins = Array.from({ length: BINS }, () => ({ n: 0, center: 0, left: [], right: [], sumZ: 0 }));
  for (const p of verts) {
    const b = bins[binOf(p)];
    b.n++; b.sumZ += p[2];
    const dx = p[0] - cx;
    if (Math.abs(dx) < 0.025 * H) b.center++;
    else if (dx > 0) b.left.push(dx);
    else b.right.push(-dx);
  }
  let crotchY = null;
  const lo = Math.floor(0.15 * BINS), hi = Math.floor(0.62 * BINS);
  for (let b = lo; b <= hi; b++) {
    const bin = bins[b];
    if (bin.n < 8) continue;
    const split = bin.center === 0 && bin.left.length >= 3 && bin.right.length >= 3;
    if (split) crotchY = groundY + ((b + 1) / BINS) * H; // top of the split band
  }
  // Armour panels, long coats and disconnected accessories can create a false
  // center gap around the knees. A humanoid crotch below 36% of total height is
  // not a useful anatomical measurement; retain the proportion-based fallback.
  if (crotchY !== null && crotchY < groundY + 0.36 * H) crotchY = null;

  // ── Skirt / robe / dress / coat fallback ──────────────────────────────────
  // A garment fills the centerline so the split test never fires and the legs
  // would default to the bounds guess (often wrong). Detect the garment by its
  // silhouette: a robe FLARES — lower bins are markedly wider than the waist.
  // When two feet still poke out below the hem they give a real leg X offset;
  // otherwise fall back to anatomical defaults. Crotch is placed at the waist
  // (where the width starts flaring) so UpLeg roots sit inside the garment.
  let skirtMode = false, skirtLegDX = null;
  if (crotchY === null) {
    const widthAt = b => {
      const bin = bins[b];
      if (!bin || bin.n < 8) return null;
      const all = bin.left.concat(bin.right);
      return all.length ? median(all) : null;
    };
    // Hem = widest lower-body bin; waist = narrowest bin above the hem.
    let hemB = -1, hemW = -1;
    for (let b = lo; b <= Math.floor(0.45 * BINS); b++) {
      const w = widthAt(b);
      if (w !== null && w > hemW) { hemW = w; hemB = b; }
    }
    let waistB = -1, waistW = Infinity;
    for (let b = (hemB >= 0 ? hemB : lo); b <= hi; b++) {
      const w = widthAt(b);
      if (w !== null && w < waistW) { waistW = w; waistB = b; }
    }
    // Flare ratio: a real skirt is clearly wider at the hem than the waist.
    if (hemB >= 0 && waistB > hemB && hemW > 1.35 * waistW && hemW > 0.10 * H) {
      skirtMode = true;
      crotchY = groundY + ((waistB) / BINS) * H - 0.02 * H;
      // Try to read leg X from feet sticking out below the hem (lowest bins).
      for (let b = 0; b < lo; b++) {
        const bin = bins[b];
        if (bin && bin.center === 0 && bin.left.length >= 3 && bin.right.length >= 3) {
          const l = median(bin.left), r = median(bin.right);
          const m = (l + r) / 2;
          if (Number.isFinite(m)) { skirtLegDX = Math.min(Math.max(m, 0.03 * H), 0.12 * H); break; }
        }
      }
      console.log('[autorig] Skirt/robe silhouette detected — estimating legs from waist + hem.');
    }
  }

  if (crotchY !== null) {
    const hipsY = Math.min(crotchY + 0.05 * H, groundY + 0.62 * H);
    const upLegY = Math.min(crotchY + 0.015 * H, hipsY - 0.02 * H);
    const ankleY = joints.LeftFoot[1];
    const kneeY = (upLegY + ankleY) / 2;

    // Per-leg X offset measured halfway down the legs
    const midLegBin = bins[Math.max(0, Math.floor(((crotchY - groundY) / H) * BINS * 0.5))];
    let legDX = 0.06 * H;
    if (skirtMode && skirtLegDX !== null) {
      legDX = skirtLegDX; // measured from feet below the hem
    } else if (!skirtMode && midLegBin && midLegBin.left.length >= 3 && midLegBin.right.length >= 3) {
      const l = median(midLegBin.left), r = median(midLegBin.right);
      const m = (l + r) / 2;
      if (Number.isFinite(m)) legDX = Math.min(Math.max(m, 0.03 * H), 0.15 * H);
    }

    for (const [side, sgn] of [['Left', 1], ['Right', -1]]) {
      const sgnAdjusted = sgn * forwardZ;
      joints[side + 'UpLeg'] = [cx + sgnAdjusted * legDX, upLegY, cz];
      joints[side + 'Leg'] = [cx + sgnAdjusted * legDX, kneeY, cz];
      joints[side + 'Foot'] = [cx + sgnAdjusted * legDX, ankleY, cz];
      joints[side + 'ToeBase'] = [cx + sgnAdjusted * legDX, joints[side + 'ToeBase'][1], cz + 0.10 * H * forwardZ];
    }
    joints.Hips = [cx, hipsY, cz];
  }

  // ── Arms: lateral extremes above the waist (T-pose and A-pose) ────────────
  const upperVerts = verts.filter(p => yf(p) > 0.45);
  let spanL = 0, spanR = 0;
  for (const p of upperVerts) {
    const dx = p[0] - cx;
    if (dx > spanL) spanL = dx;
    else if (-dx > spanR) spanR = -dx;
  }
  // Torso half width: capped fraction of arm span so armpit estimates stay sane
  const tw = Math.min(0.16 * H, 0.45 * Math.min(spanL, spanR));
  const armsDetected = spanL > 0.20 * H && spanR > 0.20 * H && tw > 0.05 * H;

  let shoulderY = joints.LeftArm[1];
  if (armsDetected) {
    // Shoulder height: vertices just outside the torso = upper-arm root
    const rootYs = upperVerts
      .filter(p => { const a = Math.abs(p[0] - cx); return a > 1.05 * tw && a < 1.6 * tw && yf(p) > 0.55; })
      .map(p => p[1]);
    if (rootYs.length >= 10) {
      shoulderY = Math.min(Math.max(median(rootYs), groundY + 0.70 * H), groundY + 0.88 * H);
    }

    // Hands: centroid of the outermost 8% of each arm span (any arm angle)
    const handL = centroidOf(upperVerts.filter(p => (p[0] - cx) > 0.92 * spanL));
    const handR = centroidOf(upperVerts.filter(p => (cx - p[0]) > 0.92 * spanR));
    if (handL && handR) {
      // Symmetrize so the skeleton stays mirrored even on asymmetric meshes
      const hx = ((handL[0] - cx) + (cx - handR[0])) / 2;
      const hy = (handL[1] + handR[1]) / 2;
      const hz = ((handL[2] + handR[2]) / 2 + cz) / 2;
      for (const [side, sgn] of [['Left', 1], ['Right', -1]]) {
        const sgnAdjusted = sgn * forwardZ;
        const shoulder = [cx + sgnAdjusted * 0.4 * tw, shoulderY, cz];
        const arm = [cx + sgnAdjusted * tw, shoulderY, cz];
        // The outer silhouette is the fingertip, not the wrist. Place Hand at
        // the anatomical wrist (~78% shoulder-to-tip), leaving real space for
        // palm and finger chains instead of extending them outside the mesh.
        const tip = [cx + sgnAdjusted * hx, hy, hz];
        const hand = [
          arm[0] + (tip[0] - arm[0]) * 0.78,
          arm[1] + (tip[1] - arm[1]) * 0.78,
          arm[2] + (tip[2] - arm[2]) * 0.78,
        ];
        const fore = [(arm[0] + hand[0]) / 2, (arm[1] + hand[1]) / 2, (arm[2] + hand[2]) / 2];
        joints[side + 'Shoulder'] = shoulder;
        joints[side + 'Arm'] = arm;
        joints[side + 'ForeArm'] = fore;
        joints[side + 'Hand'] = hand;
        fingerTips[side] = detectFingerTipsFromVertices(verts, hand, tip, H, forwardZ);
      }
    }
  }

  // ── Neck = narrowest band between the shoulders and the top ───────────────
  // Anatomy, not a fixed fraction: the body has a clear width minimum at the
  // neck (torso/shoulders widen below it, the skull widens above it). This is
  // what makes big-headed/cartoon and stylised meshes work — the head can be
  // 25% of the body and the neck is still found at the true pinch, instead of
  // shoulderY + a constant offset that buries the head and neck.
  const widthBins = Array.from({ length: BINS }, () => ({ minX: Infinity, maxX: -Infinity, n: 0 }));
  for (const p of verts) {
    const b = widthBins[binOf(p)];
    if (p[0] < b.minX) b.minX = p[0];
    if (p[0] > b.maxX) b.maxX = p[0];
    b.n++;
  }
  const widthAtBin = b => (widthBins[b]?.n >= 4 ? widthBins[b].maxX - widthBins[b].minX : NaN);
  // Search band: from just above the shoulders up to near the top.
  const shoulderFrac = (shoulderY - groundY) / H;
  const neckLo = Math.min(BINS - 2, Math.max(1, Math.floor((shoulderFrac + 0.02) * BINS)));
  const neckHi = Math.min(BINS - 1, Math.floor(0.95 * BINS));
  let neckBin = -1, neckW = Infinity;
  for (let b = neckLo; b <= neckHi; b++) {
    const w = widthAtBin(b);
    if (Number.isFinite(w) && w < neckW) { neckW = w; neckBin = b; }
  }
  let neckY;
  if (neckBin >= 0) {
    neckY = groundY + ((neckBin + 0.5) / BINS) * H;
  } else {
    neckY = Math.min(shoulderY + 0.05 * H, groundY + 0.90 * H); // fallback
  }
  // Clamp so the neck can't collapse onto the shoulders or shoot past the top.
  neckY = Math.min(Math.max(neckY, shoulderY + 0.02 * H), groundY + 0.93 * H);

  const hipsY2 = joints.Hips[1];
  const spineZ = f => {
    const b = bins[Math.min(BINS - 1, Math.max(0, Math.floor(((f - groundY) / H) * BINS)))];
    return b && b.n >= 8 ? b.sumZ / b.n : cz; // follow hunched spines
  };
  const lerpY = t => hipsY2 + (neckY - hipsY2) * t;
  joints.Spine = [cx, lerpY(0.28), spineZ(lerpY(0.28))];
  joints.Spine1 = [cx, lerpY(0.55), spineZ(lerpY(0.55))];
  joints.Spine2 = [cx, lerpY(0.82), spineZ(lerpY(0.82))];
  joints.Neck = [cx, neckY, spineZ(neckY)];

  // ── Head = centroid of the skull blob ABOVE the neck ──────────────────────
  // Everything above the neck pinch is the head; its centroid is the head joint
  // regardless of skull size. This lifts the head marker to the real head
  // centre on cartoon proportions instead of pinning it just above the neck.
  const headPts = verts.filter(p => p[1] > neckY + 0.01 * H);
  const headC = centroidOf(headPts);
  const headY = headC
    ? Math.min(Math.max(headC[1], neckY + 0.03 * H), groundY + 0.98 * H)
    : Math.min(neckY + 0.05 * H, groundY + 0.97 * H);
  joints.Head = [cx, headY, headC ? (headC[2] + cz) / 2 : cz];

  // Shoulders sit just below the neck. If the width-based shoulder estimate
  // landed well under the neck (common on big-headed meshes where the torso
  // width search is polluted by the wide skull), lift the arm/shoulder chain to
  // a sane clavicle height so arms don't droop down the ribcage.
  const minShoulderY = neckY - 0.10 * H;
  if (armsDetected && shoulderY < minShoulderY) {
    const lift = minShoulderY - shoulderY;
    for (const side of ['Left', 'Right']) {
      for (const part of ['Shoulder', 'Arm']) {
        if (joints[side + part]) joints[side + part][1] += lift;
      }
      // Raise the forearm/elbow by half the lift so the arm line stays straight.
      if (joints[side + 'ForeArm']) joints[side + 'ForeArm'][1] += lift * 0.5;
    }
    shoulderY = minShoulderY;
  }

  // Re-anchor shoulders to Spine2 height sanity (clavicles sit below the neck)
  for (const side of ['Left', 'Right']) {
    joints[side + 'Shoulder'][1] = Math.min(joints[side + 'Shoulder'][1], neckY - 0.01 * H);
  }

  // Quality flags: when these fail the mesh is likely NOT in an upright
  // T/A-pose and the caller should try the pose-independent topology pass.
  return { joints, height: H, bounds, fingerTips, flags: { crotch: crotchY !== null, arms: armsDetected, skirt: skirtMode } };
}

// ── Pose-independent topology pass (voxel curve-skeleton) ───────────────────
// For meshes NOT in an upright T/A-pose the height-slicing heuristics above
// fail. Body topology, however, is pose-invariant: five extremities (head,
// hands, feet) joined to a torso. This pass voxelizes the mesh, builds a
// geodesic graph over the solid voxels, finds the extremities by farthest-
// point sampling, classifies limbs by centerline thickness, and places the
// Mixamo joints along the limb centerlines.

function voxelizeSolid(doc, skinXforms, bounds, N = 64, bodyMeshes = null) {
  const { min, max } = bounds;
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cell = Math.max(...extent) / N;
  if (!(cell > 0)) return null;
  const nx = Math.ceil(extent[0] / cell) + 4;
  const ny = Math.ceil(extent[1] / cell) + 4;
  const nz = Math.ceil(extent[2] / cell) + 4;
  const origin = [min[0] - 2 * cell, min[1] - 2 * cell, min[2] - 2 * cell];
  const grid = new Uint8Array(nx * ny * nz); // 0 empty, 1 solid, 2 outside
  const idxOf = (x, y, z) => x + nx * (y + ny * z);
  const mark = (p) => {
    const x = Math.floor((p[0] - origin[0]) / cell);
    const y = Math.floor((p[1] - origin[1]) / cell);
    const z = Math.floor((p[2] - origin[2]) / cell);
    if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) grid[idxOf(x, y, z)] = 1;
  };

  // Rasterize triangle surfaces (subdivide until edges fit inside a voxel)
  const parentMap = buildParentMap(doc);
  const matCache = new Map();
  const limit = cell * 0.85;
  let budget = 4_000_000;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (bodyMeshes && !bodyMeshes.has(mesh)) continue;
    const world = skinXforms.get(mesh) || worldMatrixOf(node, parentMap, matCache);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')?.getArray();
      if (!pos) continue;
      const ind = prim.getIndices()?.getArray();
      const triCount = ind ? ind.length / 3 : pos.length / 9;
      const vtx = (i) => transformPoint(world, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      for (let t = 0; t < triCount && budget > 0; t++) {
        const a = vtx(ind ? ind[t * 3] : t * 3);
        const b = vtx(ind ? ind[t * 3 + 1] : t * 3 + 1);
        const c = vtx(ind ? ind[t * 3 + 2] : t * 3 + 2);
        const stack = [[a, b, c]];
        while (stack.length && budget-- > 0) {
          const [p, q, r] = stack.pop();
          mark(p); mark(q); mark(r);
          const e0 = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
          const e1 = Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]);
          const e2 = Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]);
          if (Math.max(e0, e1, e2) > limit) {
            const mpq = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
            const mqr = [(q[0] + r[0]) / 2, (q[1] + r[1]) / 2, (q[2] + r[2]) / 2];
            const mrp = [(r[0] + p[0]) / 2, (r[1] + p[1]) / 2, (r[2] + p[2]) / 2];
            stack.push([p, mpq, mrp], [mpq, q, mqr], [mrp, mqr, r], [mpq, mqr, mrp]);
          }
        }
      }
    }
  }

  // Interior fill with morphological closing: real-world meshes are rarely
  // watertight (open necks, eye sockets), so a naive outside flood leaks in
  // and the body stays hollow — killing the depth field and inflating all
  // geodesics onto the surface. Dilate the shell 2 voxels, flood the outside
  // over the dilated grid, then take interior = unreached ∧ not part of the
  // dilated ring (so the silhouette is not fattened).
  // Conservative dilation: only fill cells with ≥2 solid 6-neighbours. The
  // rim of a hole (neck, eye socket) is curved and qualifies; the flat 1–2
  // cell gap between two parallel surfaces (feet, legs, arm/torso) has only
  // one solid neighbour per cell and is preserved.
  const dil = Uint8Array.from(grid);
  for (let pass = 0; pass < 2; pass++) {
    const src = Uint8Array.from(dil);
    for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const i = idxOf(x, y, z);
      if (src[i]) continue;
      const n = src[i - 1] + src[i + 1] + src[i - nx] + src[i + nx] + src[i - nx * ny] + src[i + nx * ny];
      if (n >= 2) dil[i] = 1;
    }
  }
  const outside = new Uint8Array(grid.length);
  const queue = new Int32Array(nx * ny * nz);
  let qh = 0, qt = 0;
  const pushOut = (i) => { if (!dil[i] && !outside[i]) { outside[i] = 1; queue[qt++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { pushOut(idxOf(0, y, z)); pushOut(idxOf(nx - 1, y, z)); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { pushOut(idxOf(x, 0, z)); pushOut(idxOf(x, ny - 1, z)); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { pushOut(idxOf(x, y, 0)); pushOut(idxOf(x, y, nz - 1)); }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    if (x > 0) pushOut(i - 1);
    if (x < nx - 1) pushOut(i + 1);
    if (y > 0) pushOut(i - nx);
    if (y < ny - 1) pushOut(i + nx);
    if (z > 0) pushOut(i - nx * ny);
    if (z < nz - 1) pushOut(i + nx * ny);
  }
  let solid = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 1) { solid++; continue; } // original shell
    if (outside[i]) { grid[i] = 0; continue; }
    // Unreached cell: true interior — but drop the OUTER dilated ring (cells
    // touching the outside) so the silhouette is not fattened by the closing.
    if (dil[i]) {
      const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
      const touchesOut =
        (x > 0 && outside[i - 1]) || (x < nx - 1 && outside[i + 1]) ||
        (y > 0 && outside[i - nx]) || (y < ny - 1 && outside[i + nx]) ||
        (z > 0 && outside[i - nx * ny]) || (z < nz - 1 && outside[i + nx * ny]);
      if (touchesOut) { grid[i] = 0; continue; }
    }
    grid[i] = 1; solid++;
  }
  return { grid, nx, ny, nz, origin, cell, solid, idxOf };
}

// Multi-source BFS over solid voxels (26-conn); returns Int32 distances (-1
// unreachable) and parent pointers for path reconstruction.
function voxelBFS(vox, sources) {
  const { grid, nx, ny, nz } = vox;
  const dist = new Int32Array(grid.length).fill(-1);
  const parent = new Int32Array(grid.length).fill(-1);
  const queue = new Int32Array(vox.solid + 1);
  let qh = 0, qt = 0;
  for (const s of sources) if (grid[s] === 1 && dist[s] < 0) { dist[s] = 0; queue[qt++] = s; }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const j = X + nx * (Y + ny * Z);
      if (grid[j] === 1 && dist[j] < 0) { dist[j] = dist[i] + 1; parent[j] = i; queue[qt++] = j; }
    }
  }
  return { dist, parent };
}

/**
 * Pose-independent joint guess. Returns { joints, height, bounds, confidence,
 * method:'topology' } or null when the topology cannot be resolved.
 */
export function guessJointsFromTopology(doc, skinXforms, bounds, forwardZ = 1, bodyMeshes = null) {
  // 96³: fine enough that touching thighs/arms don't fuse prematurely
  const vox = voxelizeSolid(doc, skinXforms, bounds, 96, bodyMeshes);
  if (!vox || vox.solid < 500) return null;
  const { grid, nx, ny, origin, cell } = vox;
  const worldOf = (i) => {
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    return [origin[0] + (x + 0.5) * cell, origin[1] + (y + 0.5) * cell, origin[2] + (z + 0.5) * cell];
  };

  // Depth field: geodesic distance to the surface — thickness of the body
  const shell = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 1) continue;
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    const nbr = [i - 1, i + 1, i - nx, i + nx, i - nx * ny, i + nx * ny];
    const edge = x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === (grid.length / (nx * ny)) - 1 ||
      nbr.some(j => grid[j] !== 1);
    if (edge) shell.push(i);
  }
  const depth = voxelBFS(vox, shell).dist;

  // Tree root must sit in the torso. The deepest voxel is NOT safe (a big
  // skull can out-thicken the belly). Instead: take the graph diameter
  // (always extremity↔extremity, e.g. hand↔hand or foot↔head) — its geodesic
  // midpoint always lies in the torso.
  let seed = -1, bestD = -1;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 1 && depth[i] > bestD) { bestD = depth[i]; seed = i; }
  if (seed < 0) return null;
  const argmaxDist = (d) => { let e = -1, b = -1; for (let i = 0; i < d.length; i++) if (d[i] > b) { b = d[i]; e = i; } return e; };
  const a = argmaxDist(voxelBFS(vox, [seed]).dist);
  const fromA = voxelBFS(vox, [a]);
  const bEnd = argmaxDist(fromA.dist);
  const diamPath = [];
  for (let i = bEnd; i >= 0; i = fromA.parent[i]) diamPath.push(i);
  const root = diamPath[Math.floor(diamPath.length / 2)];
  const fromRoot = voxelBFS(vox, [root]);

  // Extremities: farthest-point sampling on geodesic distance
  const picks = [];
  let minDist = Int32Array.from(fromRoot.dist);
  for (let k = 0; k < 6; k++) {
    let e = -1, dBest = -1;
    for (let i = 0; i < grid.length; i++) if (grid[i] === 1 && minDist[i] > dBest) { dBest = minDist[i]; e = i; }
    // Real extremities sit at least a limb's length apart geodesically;
    // closer peaks are spurs on the same blob (ears, hair, fingers).
    if (e < 0 || dBest < Math.max(8, diamPath.length * 0.18)) break;
    picks.push(e);
    const de = voxelBFS(vox, [e]).dist;
    for (let i = 0; i < grid.length; i++) if (de[i] >= 0 && de[i] < minDist[i]) minDist[i] = de[i];
  }
  if (process.env.AUTORIG_DEBUG) console.log('picks:', picks.map(p => worldOf(p).map(v => v.toFixed(2)).join(',')).join(' | '));
  if (process.env.AUTORIG_PROBE) {
    for (const probe of process.env.AUTORIG_PROBE.split(';')) {
      const [px, py, pz] = probe.split(',').map(Number);
      const x = Math.round((px - origin[0]) / cell - 0.5), y = Math.round((py - origin[1]) / cell - 0.5), z = Math.round((pz - origin[2]) / cell - 0.5);
      // nearest solid within radius 3
      let bi = -1, bd = Infinity;
      for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const i = (x + dx) + nx * ((y + dy) + ny * (z + dz));
        if (grid[i] === 1 && dx * dx + dy * dy + dz * dz < bd) { bd = dx * dx + dy * dy + dz * dz; bi = i; }
      }
      console.log(`probe ${probe}: solidNear=${bi >= 0} fromRoot=${bi >= 0 ? fromRoot.dist[bi] : '-'} minDistFinal=${bi >= 0 ? minDist[bi] : '-'}`);
    }
  }
  if (picks.length < 5) return null;

  // Path tip→root per extremity + mean centerline thickness
  const paths = picks.map(e => {
    const path = [];
    for (let i = e; i >= 0; i = fromRoot.parent[i]) path.push(i);
    const span = Math.max(1, Math.floor(path.length * 0.7));
    let th = 0;
    for (let i = 0; i < span; i++) th += depth[path[i]];
    return { tip: e, path, len: path.length, thickness: th / span };
  }).filter(p => p.len >= 6);
  if (paths.length < 5) return null;

  // Merge points: first voxel a path shares with its sibling
  const mergeOf = (pa, pb) => {
    const set = new Set(pa.path);
    for (let i = 0; i < pb.path.length; i++) if (set.has(pb.path[i])) return pb.path[i];
    return root;
  };

  // ── Classification by pair matching ────────────────────────────────────────
  // True pairs stay together far from the torso core: feet merge at the
  // crotch, hands at the chest, while the head pairs with nothing deeply.
  // Choose 5 leaves + the matching (2 pairs + 1 head) maximizing the summed
  // merge depth. Tip thickness is NOT used (boots/gloves break it).
  let cands = paths.slice(0, 6).sort((a, b) => b.len - a.len);

  // Deduplicate blob spurs first: two leaves on the SAME body part (top of
  // head vs hair tail, fingers of one hand) are geodesically close
  // tip-to-tip; real extremities sit at least two limb lengths apart.
  // Keep the longest leaf per cluster.
  const minSep = diamPath.length * 0.25;
  const used = new Array(cands.length).fill(false);
  const dedup = [];
  for (let i = 0; i < cands.length; i++) {
    if (used[i]) continue;
    const dTip = voxelBFS(vox, [cands[i].tip]).dist;
    for (let j = i + 1; j < cands.length; j++) {
      const d = dTip[cands[j].tip];
      if (process.env.AUTORIG_DEBUG) console.log(`dedup ${i}-${j}: tipDist=${d} minSep=${minSep.toFixed(0)}`);
      if (d >= 0 && d < minSep) used[j] = true; // sorted by len → keep i
    }
    dedup.push(cands[i]);
  }
  if (process.env.AUTORIG_DEBUG) {
    let maxDepth = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === 1 && depth[i] > maxDepth) maxDepth = depth[i];
    console.log(`solid=${vox.solid} maxDepth=${maxDepth} diam=${diamPath.length} rootW=${worldOf(root).map(v => v.toFixed(2))}`);
  }
  cands = dedup;
  if (cands.length < 5) return null;

  // Pair score: deep merge (limbs stay together away from the core) MINUS a
  // strong symmetry penalty — real pairs (two feet, two hands) have
  // near-equal limb segments, while head+hand pairings are very asymmetric.
  const minLimbLen = Math.max(6, diamPath.length * 0.12);
  const pairScore = (pa, pb) => {
    const m = mergeOf(pa, pb);
    const la = Math.max(1, pa.path.indexOf(m));
    const lb = Math.max(1, pb.path.indexOf(m));
    if (Math.min(la, lb) < minLimbLen) return -1000;
    return fromRoot.dist[m] - 2 * Math.abs(la - lb);
  };
  if (process.env.AUTORIG_DEBUG) {
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      const m = mergeOf(cands[i], cands[j]);
      console.log(`pair ${i}-${j}: tipI=${worldOf(cands[i].tip).map(v => v.toFixed(2))} tipJ=${worldOf(cands[j].tip).map(v => v.toFixed(2))} mergeDist=${fromRoot.dist[m]} la=${cands[i].path.indexOf(m)} lb=${cands[j].path.indexOf(m)} minLimbLen=${minLimbLen.toFixed(0)} score=${pairScore(cands[i], cands[j]).toFixed(1)}`);
    }
  }
  const MATCHINGS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  let bestSel = null, bestScore = -Infinity;
  const subsets = cands.length <= 5 ? [cands] : cands.map((_, drop) => cands.filter((_, i) => i !== drop));
  for (const sub of subsets) {
    if (sub.length < 5) continue;
    for (let h = 0; h < 5; h++) {
      const rest = sub.filter((_, i) => i !== h);
      for (const m of MATCHINGS) {
        const score = pairScore(rest[m[0][0]], rest[m[0][1]]) + pairScore(rest[m[1][0]], rest[m[1][1]])
          + 0.05 * sub[h].len; // tie-break: prefer the longer leaf as head
        if (score > bestScore) {
          bestScore = score;
          bestSel = { head: sub[h], pairA: [rest[m[0][0]], rest[m[0][1]]], pairB: [rest[m[1][0]], rest[m[1][1]]] };
        }
      }
    }
  }
  if (!bestSel) return null;
  const head = bestSel.head;

  // Legs vs arms: pose-invariant anatomy — the arm pair merges NEAR the head
  // (chest/shoulders), the leg pair merges FAR from it (crotch). Thickness is
  // unreliable (touching calves merge early into a thin bridge).
  const mA = mergeOf(bestSel.pairA[0], bestSel.pairA[1]);
  const mB = mergeOf(bestSel.pairB[0], bestSel.pairB[1]);
  const fromHead = voxelBFS(vox, [head.tip]).dist;
  const dA = fromHead[mA] >= 0 ? fromHead[mA] : Infinity;
  const dB = fromHead[mB] >= 0 ? fromHead[mB] : Infinity;
  const [legs, arms, crotchVox, chestVox] = dA >= dB
    ? [bestSel.pairA, bestSel.pairB, mA, mB]
    : [bestSel.pairB, bestSel.pairA, mB, mA];
  const legArmSeparation = Number.isFinite(dA) && Number.isFinite(dB)
    ? Math.abs(dA - dB) / Math.max(1, diamPath.length) : 0;
  // ── Thickness-refined limb ends ─────────────────────────────────────────
  // The raw merge voxel can sit too early (touching calves/arms fuse the
  // paths below the real joint). Walk past the merge toward the root until
  // the centerline thickness reaches torso scale — that is the true limb end
  // (crotch for legs, shoulder/chest for arms).
  const limbEndIdx = (limb, mergeVox, thrDepth) => {
    let i = limb.path.indexOf(mergeVox);
    if (i < 1) i = Math.max(1, Math.floor(limb.path.length * 0.6));
    while (i < limb.path.length - 1 && depth[limb.path[i]] < thrDepth) i++;
    return i;
  };
  // Per-limb thickness over the segment up to the merge (for end thresholds)
  const segThickness = (p, mVox) => {
    let end = p.path.indexOf(mVox);
    if (end < 2) end = Math.max(2, Math.floor(p.path.length * 0.5));
    const span = Math.max(2, Math.floor(end * 0.6));
    let s = 0;
    for (let i = 0; i < span; i++) s += depth[p.path[i]];
    return s / span;
  };
  // Threshold anchored to BOTH limb thickness and torso-core depth: knees and
  // calf-contact bridges stay below it, pelvis/chest reach it.
  const coreDepth = depth[root];
  const legEnd = new Map(legs.map(l => [l, limbEndIdx(l, crotchVox, Math.max(1.7 * segThickness(l, crotchVox), 0.7 * coreDepth))]));
  const armEnd = new Map(arms.map(a => [a, limbEndIdx(a, chestVox, Math.max(1.5 * segThickness(a, chestVox), 0.55 * coreDepth))]));
  const midOf = (pa, ea, pb, eb) => {
    const A = worldOf(pa.path[ea]), B = worldOf(pb.path[eb]);
    return [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  };
  const crotch = midOf(legs[0], legEnd.get(legs[0]), legs[1], legEnd.get(legs[1]));
  const chest = midOf(arms[0], armEnd.get(arms[0]), arms[1], armEnd.get(arms[1]));
  const headTip = worldOf(head.tip);

  // Body frame: up = crotch→head, left = up × forward
  const H = Math.max(...[0, 1, 2].map(k => bounds.max[k] - bounds.min[k]));
  const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const up = norm([headTip[0] - crotch[0], headTip[1] - crotch[1], headTip[2] - crotch[2]]);
  // Forward: start from the detected facing, but if it is (near-)parallel to up
  // — e.g. a character lying on its back, up≈±Z — pick the world axis LEAST
  // aligned with up so the cross product never degenerates. Then orthogonalize.
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let fwd = [0, 0, forwardZ];
  if (Math.abs(dot(up, fwd)) > 0.9) {
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    fwd = axes.reduce((best, ax) => Math.abs(dot(up, ax)) < Math.abs(dot(up, best)) ? ax : best, axes[0]);
  }
  // Gram-Schmidt: remove the up component so fwd ⟂ up, then renormalize.
  const fdotu = dot(fwd, up);
  fwd = norm([fwd[0] - fdotu * up[0], fwd[1] - fdotu * up[1], fwd[2] - fdotu * up[2]]);
  const left = norm([up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]]);
  const sideOf = (p, ref) => (p[0] - ref[0]) * left[0] + (p[1] - ref[1]) * left[1] + (p[2] - ref[2]) * left[2];

  // Point at fraction t (0 = tip) along a limb centerline up to end index
  const limbPoint = (limb, end, t) =>
    worldOf(limb.path[Math.max(0, Math.min(end, Math.round(t * end)))]);

  const [legL, legR] = sideOf(worldOf(legs[0].tip), crotch) >= sideOf(worldOf(legs[1].tip), crotch)
    ? [legs[0], legs[1]] : [legs[1], legs[0]];
  const [armL, armR] = sideOf(worldOf(arms[0].tip), chest) >= sideOf(worldOf(arms[1].tip), chest)
    ? [arms[0], arms[1]] : [arms[1], arms[0]];

  const joints = {};
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (const [side, leg, arm] of [['Left', legL, armL], ['Right', legR, armR]]) {
    const le = legEnd.get(leg), ae = armEnd.get(arm);
    joints[side + 'ToeBase'] = limbPoint(leg, le, 0);
    joints[side + 'Foot'] = limbPoint(leg, le, 0.12);
    joints[side + 'Leg'] = limbPoint(leg, le, 0.52);   // knee
    joints[side + 'UpLeg'] = limbPoint(leg, le, 0.94);
    joints[side + 'Hand'] = limbPoint(arm, ae, 0.04);
    joints[side + 'ForeArm'] = limbPoint(arm, ae, 0.45); // elbow
    joints[side + 'Arm'] = limbPoint(arm, ae, 0.85);     // shoulder head
    joints[side + 'Shoulder'] = limbPoint(arm, ae, 0.96);
  }
  joints.Hips = lerp3(crotch, chest, 0.12);
  joints.Spine = lerp3(crotch, chest, 0.35);
  joints.Spine1 = lerp3(crotch, chest, 0.6);
  joints.Spine2 = lerp3(crotch, chest, 0.85);

  // Head chain: the neck is the thickness local minimum of the head path
  // (skull blob → thin neck → thick chest), searched over the first 70%.
  const headSearch = Math.max(3, Math.floor(head.path.length * 0.7));
  let neckIdx = Math.floor(head.path.length * 0.4);
  let neckDepth = Infinity;
  for (let i = Math.floor(head.path.length * 0.1); i < headSearch; i++) {
    if (depth[head.path[i]] < neckDepth) { neckDepth = depth[head.path[i]]; neckIdx = i; }
  }
  joints.Neck = worldOf(head.path[neckIdx]);
  joints.Head = limbPoint(head, neckIdx, 0.5); // mid-skull, above the neck

  // Confidence: a clean pair matching (no same-blob pairs forced), clear
  // geodesic separation of the REFINED crotch/chest from the head, and the
  // leg merge sitting below the arm merge along the body axis.
  let confidence = 0.5;
  if (bestScore > -100) confidence += 0.2; // both pairs were real limb pairs
  const crotchGeo = fromHead[legs[0].path[legEnd.get(legs[0])]];
  const chestGeo = fromHead[arms[0].path[armEnd.get(arms[0])]];
  const refinedSep = (crotchGeo >= 0 && chestGeo >= 0)
    ? Math.abs(crotchGeo - chestGeo) / Math.max(1, diamPath.length)
    : legArmSeparation;
  if (refinedSep > 0.08) confidence += 0.2;
  const crotchBelowChest = (crotch[0] - chest[0]) * up[0] + (crotch[1] - chest[1]) * up[1] + (crotch[2] - chest[2]) * up[2] < 0;
  if (crotchBelowChest) confidence += 0.1;
  else confidence -= 0.3;

  // Left/Right sanity: the assigned left & right feet (and hands) must sit on
  // OPPOSITE sides of the body's left axis by a clear margin. If they don't,
  // the side labeling is unreliable (degenerate left axis / wrong forward) and
  // the resulting rig would retarget mirrored — drop confidence so the slicing
  // skeleton or a manual marker pass takes over.
  const sideMarginH = 0.04 * H;
  const lrSane = (l, r, ref) => {
    const sl = sideOf(worldOf(l.tip), ref), sr = sideOf(worldOf(r.tip), ref);
    return sl - sr > sideMarginH; // L clearly on +left, R on −left
  };
  const legsLR = lrSane(legL, legR, crotch);
  const armsLR = lrSane(armL, armR, chest);
  if (!legsLR || !armsLR) confidence -= 0.25;

  return {
    joints, height: H, bounds, confidence, method: 'topology',
    debug: { extremities: picks.map(worldOf), headTip: worldOf(head.tip) },
  };
}

// Run BOTH detectors and cross-validate. The slicing pass is more precise but
// only valid for upright T/A-poses; the topology pass is pose-independent.
// They agree on standard poses — strong disagreement on hands/feet means the
// pose is non-standard and topology wins.
function guessJointsAuto(doc, skinXforms, bounds, forwardZ, bodyMeshes = null, bodyPlan = 'humanoid') {
  // Quadrupeds: the upright-slicing heuristics are humanoid-only. The
  // pose-independent topology pass classifies four limbs + head naturally
  // (front limbs merge near the head = arm chain, hind limbs at the pelvis =
  // leg chain); fall back to a standing-animal bounds layout.
  if (bodyPlan === 'quadruped') {
    let topo = null;
    try {
      topo = guessJointsFromTopology(doc, skinXforms, bounds, forwardZ, bodyMeshes);
    } catch (e) {
      console.warn('[autorig] Topology pass failed:', e.message);
    }
    if (topo && topo.confidence >= 0.4) {
      console.log(`[autorig] Quadruped topology skeleton (confidence ${topo.confidence.toFixed(2)}).`);
      return topo;
    }
    console.log('[autorig] Quadruped topology unresolved — using bounds layout.');
    return guessQuadrupedFromBounds(bounds, forwardZ);
  }

  const verts = collectWorldVertices(doc, skinXforms, bodyMeshes);
  const sliced = guessJointsFromMesh(verts, bounds, forwardZ);
  sliced.method = 'slicing';

  let topo = null;
  try {
    topo = guessJointsFromTopology(doc, skinXforms, bounds, forwardZ, bodyMeshes);
  } catch (e) {
    console.warn('[autorig] Topology pass failed, using slicing guess:', e.message);
  }
  if (!topo) return sliced;

  // Graph confidence measures path separation, not whether extremities were
  // assigned the correct anatomical roles. Reject impossible role layouts.
  const topologyPlausible = (() => {
    const j = topo.joints, H = topo.height;
    const separation = (a, b) => vec3Length(vec3Subtract(j[a], j[b]));
    return j.Head[1] >= bounds.min[1] + 0.72 * H &&
      j.Head[1] > j.Neck[1] && j.Neck[1] > j.Spine2[1] &&
      separation('LeftArm', 'RightArm') > 0.12 * H &&
      separation('LeftShoulder', 'RightShoulder') > 0.04 * H &&
      separation('LeftUpLeg', 'RightUpLeg') > 0.025 * H;
  })();
  if (!topologyPlausible) {
    console.log('[autorig] Rejected implausible topology roles — using silhouette skeleton.');
    return sliced;
  }

  // Skirt/robe: the garment cone fuses both legs into one voxel blob, so the
  // topology pass mislabels feet/legs. The slicing silhouette analysis is
  // purpose-built for this case — trust it, never let topology override.
  if (sliced.flags?.skirt) {
    console.log('[autorig] Skirt/robe — using upright slicing skeleton (topology unreliable on garments).');
    return sliced;
  }

  const standardPose = sliced.flags?.crotch && sliced.flags?.arms;
  if (process.env.AUTORIG_DEBUG) console.log(`[autorig] standardPose=${standardPose} (crotch=${sliced.flags?.crotch} arms=${sliced.flags?.arms}) topoConf=${topo.confidence.toFixed(2)}`);
  if (!standardPose && topo.confidence >= 0.6) {
    console.log(`[autorig] Non-standard pose detected — using topology skeleton (confidence ${topo.confidence.toFixed(2)}).`);
    return topo;
  }
  if (standardPose && topo.confidence >= 0.7) {
    // Cross-check: average hand/foot disagreement between the two detectors
    const H = sliced.height;
    let disagree = 0;
    for (const n of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']) {
      const a = sliced.joints[n], b = topo.joints[n];
      disagree += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
    disagree /= 4 * H;
    // standardPose means slicing found a clear crotch and arm span, so the mesh
    // IS upright (+Y up). Topology may only overrule it if its own skeleton is
    // upright too — when the graph root lands on the crotch (foot-head diameter
    // midpoint), the leg pair merges at depth 0 and topology misclassifies a
    // foot as the head, producing an inverted skeleton with high self-reported
    // confidence. Disagreement then means topology broke, not the pose.
    const topoUpright = topo.joints.Head[1] > topo.joints.Hips[1];
    if (process.env.AUTORIG_DEBUG) console.log(`[autorig] cross-check: topoConf=${topo.confidence.toFixed(2)} disagree=${(disagree * 100).toFixed(0)}% topoUpright=${topoUpright}`);
    if (disagree > 0.22 && topoUpright) {
      console.log(`[autorig] Detectors disagree (${(disagree * 100).toFixed(0)}% of height) — upright silhouette is reliable, using slicing skeleton.`);
      return sliced;
    }
  }
  return sliced;
}

// ── Seed markers from an existing skeleton ───────────────────────────────────
// Aliases per canonical Mixamo joint, in normalized form (lowercase, no prefix,
// no separators, no trailing _N). Covers Mixamo/Unity/UE5/generic conventions.
const SEED_ALIASES = {
  Hips: ['hips', 'pelvis', 'hip', 'root'],
  Spine: ['spine', 'spine01', 'lowerback', 'waist'],
  Spine1: ['spine1', 'spine02', 'chest'],
  Spine2: ['spine2', 'spine03', 'upperchest'],
  Neck: ['neck', 'neck01', 'necktwist01', 'necktwist'],
  Head: ['head'],
  LeftShoulder: ['leftshoulder', 'claviclel', 'shoulderl', 'lclavicle', 'leftcollar', 'lshoulder', 'collarl', 'scapulal'],
  LeftArm: ['leftarm', 'leftupperarm', 'upperarml', 'larm', 'lupperarm', 'arml'],
  LeftForeArm: ['leftforearm', 'leftlowerarm', 'lowerarml', 'forearml', 'lforearm', 'elbowl'],
  LeftHand: ['lefthand', 'handl', 'lhand', 'wristl'],
  LeftUpLeg: ['leftupleg', 'leftupperleg', 'thighl', 'lthigh', 'upperlegl', 'hipl'],
  LeftLeg: ['leftleg', 'leftlowerleg', 'calfl', 'shinl', 'lcalf', 'lowerlegl', 'kneel'],
  LeftFoot: ['leftfoot', 'footl', 'lfoot', 'anklel'],
  LeftToeBase: ['lefttoebase', 'toel', 'toebasel', 'lefttoe', 'ltoebase', 'balll', 'lball', 'ltoe0', 'ltoe', 'toes1l', 'toesl'],
  RightShoulder: ['rightshoulder', 'clavicler', 'shoulderr', 'rclavicle', 'rightcollar', 'rshoulder', 'collarr', 'scapular'],
  RightArm: ['rightarm', 'rightupperarm', 'upperarmr', 'rarm', 'rupperarm', 'armr'],
  RightForeArm: ['rightforearm', 'rightlowerarm', 'lowerarmr', 'forearmr', 'rforearm', 'elbowr'],
  RightHand: ['righthand', 'handr', 'rhand', 'wristr'],
  RightUpLeg: ['rightupleg', 'rightupperleg', 'thighr', 'rthigh', 'upperlegr', 'hipr'],
  RightLeg: ['rightleg', 'rightlowerleg', 'calfr', 'shinr', 'rcalf', 'lowerlegr', 'kneer'],
  RightFoot: ['rightfoot', 'footr', 'rfoot', 'ankler'],
  RightToeBase: ['righttoebase', 'toer', 'toebaser', 'righttoe', 'rtoebase', 'ballr', 'rball', 'rtoe0', 'rtoe', 'toes1r', 'toesr'],
  Tail1: ['tail1', 'tail01', 'tail', 'taila'],
  Tail2: ['tail2', 'tail02', 'tailb'],
  Tail3: ['tail3', 'tail03', 'tailc'],
};

// Finger aliases are generated to cover Mixamo/Unity canonical names,
// Character Creator/AccuRig (CC_Base_L_Index1, L_Mid1), Unreal
// (index_01_l) and Blender/Rigify suffixes. Existing artist rigs must seed
// finger markers from their bind matrices, never from geometry heuristics.
for (const side of ['Left', 'Right']) {
  const short = side === 'Left' ? 'l' : 'r';
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    const lower = finger.toLowerCase();
    const cc = finger === 'Middle' ? 'mid' : lower;
    for (let segment = 1; segment <= 3; segment++) {
      SEED_ALIASES[`${side}Hand${finger}${segment}`] = [
        `${side.toLowerCase()}hand${lower}${segment}`,
        `${side.toLowerCase()}${lower}${segment}`,
        `${short}${lower}${segment}`,
        `${short}${cc}${segment}`,
        `${lower}0${segment}${short}`,
        `f${lower}0${segment}${short}`,
      ];
    }
  }
}

function seedNorm(name) {
  if (!name) return '';
  let n = name.toLowerCase();
  if (n.includes(':')) n = n.split(':').pop();
  // AdvancedSkeleton / Maya center-bone suffix: Root_M, Neck_M, Tail1_M → root…
  // Stripped BEFORE the prefix pass so root_m → root (not "m" via root_ prefix).
  n = n.replace(/[_.]m$/, '');
  // VRM: J_Bip_C_Hips → hips, J_Bip_L_UpperArm → l_upperarm
  n = n.replace(/^j_?bip_?c_?/, '');
  n = n.replace(/^j_?bip_?([lr])_?/, '$1_');
  // Rig prefixes followed by an explicit separator (AccuRig cc_base_, Biped
  // bip001, Rigify def-, Source valvebiped...). \b fails before '_'.
  n = n.replace(/^(valvebiped\.?bip\d+|cc_base|mixamorig\d*|armature|bip\d+|biped|def|root|gltf_created_\d+)[:_\-. ]+/, '');
  n = n.replace(/^mixamorig\d*/, '');
  // Blender side suffix: thigh.L → thighl
  n = n.replace(/\.([lr])$/, '$1');
  n = n.replace(/_\d+$/, '');
  return n.replace(/[:_\-\.\s]/g, '');
}

// Both normalized variants of a bone name: with the trailing _N stripped (BJS
// suffix: Hips_66 → hips) and kept (meaningful index: spine_02 → spine02).
function seedNormVariants(name) {
  if (!name) return [];
  const stripped = seedNorm(name);
  const kept = seedNorm(name.replace(/_(\d+)$/, ' $1')).replace(/ /g, '');
  return stripped === kept ? [stripped] : [stripped, kept];
}

/**
 * World bind position per existing skin joint (from inverted IBMs), matched to
 * canonical Mixamo joint names. Used to pre-place markers when re-rigging.
 */
function seedJointsFromSkins(doc) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const worldByNorm = new Map();
  for (const skin of doc.getRoot().listSkins()) {
    const joints = skin.listJoints();
    const ibmAcc = skin.getInverseBindMatrices();
    const ibmArray = ibmAcc?.getArray();
    if (!ibmArray || !joints.length) continue;
    // Skin space → render world (FBX-sourced rigs keep IBMs Z-up)
    const S = mat4Mul(worldMatrixOf(joints[0], parentMap, cache), ibmArray.slice(0, 16));
    joints.forEach((joint, i) => {
      if (i * 16 + 16 > ibmArray.length) return;
      const W = invertRigidMat4(ibmArray.slice(i * 16, i * 16 + 16));
      const p = transformPoint(S, [W[12], W[13], W[14]]);
      for (const n of seedNormVariants(joint.getName())) {
        if (n && !worldByNorm.has(n)) worldByNorm.set(n, p);
      }
    });
  }
  const seeded = {};
  for (const [canon, aliases] of Object.entries(SEED_ALIASES)) {
    for (const a of aliases) {
      if (worldByNorm.has(a)) { seeded[canon] = worldByNorm.get(a); break; }
    }
  }
  // CC/AccuRig 3-bone spine (Waist→Spine01→Spine02, no spine03): align seeds
  // with the merge-time chain shift (Spine→Waist, Spine1→Spine01, Spine2→Spine02)
  // so Spine2 gets a real seed instead of a mesh guess overlapping Spine1.
  if (worldByNorm.has('waist') && worldByNorm.has('spine01') &&
      worldByNorm.has('spine02') && !worldByNorm.has('spine03')) {
    seeded.Spine = worldByNorm.get('waist');
    seeded.Spine1 = worldByNorm.get('spine01');
    seeded.Spine2 = worldByNorm.get('spine02');
  }
  // AdvancedSkeleton (Maya): Scapula = clavicle, Shoulder = upper arm. When
  // both exist the generic pass mapped Shoulder→clavicle — shift the chain.
  for (const s of ['l', 'r']) {
    if (worldByNorm.has(`scapula${s}`) && worldByNorm.has(`shoulder${s}`)) {
      const side = s === 'l' ? 'Left' : 'Right';
      seeded[`${side}Shoulder`] = worldByNorm.get(`scapula${s}`);
      seeded[`${side}Arm`] = worldByNorm.get(`shoulder${s}`);
    }
  }
  // 1-indexed spine chain with no plain "spine" (AdvancedSkeleton Spine1..3):
  // shift down one so Spine gets a real seed instead of a mesh guess.
  if (!worldByNorm.has('spine') && worldByNorm.has('spine1') &&
      worldByNorm.has('spine2') && worldByNorm.has('spine3')) {
    seeded.Spine = worldByNorm.get('spine1');
    seeded.Spine1 = worldByNorm.get('spine2');
    seeded.Spine2 = worldByNorm.get('spine3');
  }
  return seeded;
}

export async function guessJoints(buffer, options = {}) {
  const layout = buildRigLayout(options);
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));
  const skinXf = skinWorldXforms(doc);
  const bodyMeshes = selectBodyMeshes(doc, skinXf);
  const bounds = computeWorldBounds(doc, skinXf, bodyMeshes);
  const fwd = detectForwardZ(doc, bounds, skinXf, bodyMeshes);
  const guess = guessJointsAuto(doc, skinXf, bounds, fwd, bodyMeshes, layout.bodyPlan);
  addFingerJoints(guess.joints, guess.height, fwd, guess.fingerTips, layout.fingers);
  if (layout.bodyPlan === 'quadruped') addTailJoints(guess.joints, guess.height);
  // Existing skeleton (re-rig): seed markers from current bind pose where names match
  if (doc.getRoot().listSkins().length > 0) {
    const seeded = seedJointsFromSkins(doc);
    // The rig's own L/R naming is ground truth. If the guessed Left/Right
    // labels sit on the opposite side of the seeded ones, mirror-swap the
    // guessed labels BEFORE merging — otherwise seeded joints and guessed
    // fill-ins land on opposite sides and the marker set comes out crossed.
    let sideDot = 0;
    for (const [L, R] of [['LeftShoulder', 'RightShoulder'], ['LeftArm', 'RightArm'],
      ['LeftUpLeg', 'RightUpLeg'], ['LeftFoot', 'RightFoot'], ['LeftHand', 'RightHand']]) {
      if (seeded[L] && seeded[R] && guess.joints[L] && guess.joints[R]) {
        const sv = vec3Subtract(seeded[L], seeded[R]);
        const gv = vec3Subtract(guess.joints[L], guess.joints[R]);
        sideDot += sv[0] * gv[0] + sv[1] * gv[1] + sv[2] * gv[2];
      }
    }
    if (sideDot < 0) {
      for (const name of Object.keys(guess.joints)) {
        if (!name.startsWith('Left')) continue;
        const twin = 'Right' + name.slice(4);
        if (guess.joints[twin]) {
          const t = guess.joints[name];
          guess.joints[name] = guess.joints[twin];
          guess.joints[twin] = t;
        }
      }
      console.log('[autorig] Guessed Left/Right opposed the existing rig’s naming — swapped to match.');
    }
    guess.joints = { ...guess.joints, ...seeded };
    guess.reRig = true;
  }
  // A body clearly longer than it is tall is almost certainly a quadruped —
  // surface the hint so the UI can nudge the user to the Animal body plan.
  if (layout.bodyPlan === 'humanoid') {
    const spanY = bounds.max[1] - bounds.min[1];
    const spanH = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]);
    if (spanH > 1.25 * spanY) guess.suggestedBodyPlan = 'quadruped';
  }
  // Drop joints the requested layout doesn't include (e.g. fingers beyond the
  // selected count seeded from an existing rig).
  for (const name of Object.keys(guess.joints)) {
    if (!layout.order.includes(name)) delete guess.joints[name];
  }
  validateJointLayout(guess.joints, guess.height, { layout });
  guess.bodyPlan = layout.bodyPlan;
  guess.fingerCount = resolveFingerCount(options.fingerCount);
  guess.supportedSkeletonPresets = Object.entries(SKELETON_PRESETS).map(([id, preset]) => ({ id, label: preset.label }));
  guess.supportedBodyPlans = Object.entries(BODY_PLANS).map(([id, plan]) => ({ id, label: plan.label }));
  guess.supportedFingerCounts = Object.keys(FINGER_SETS).map(Number);
  return guess;
}

// ── Helper functions for matrix/quaternion operations ─────────────────────────
function mat3ToQuat(m) {
  const tr = m[0] + m[4] + m[8];
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1.0) * 2;
    w = 0.25 * s;
    x = (m[5] - m[7]) / s;
    y = (m[6] - m[2]) / s;
    z = (m[1] - m[3]) / s;
  } else if ((m[0] > m[4]) && (m[0] > m[8])) {
    const s = Math.sqrt(1.0 + m[0] - m[4] - m[8]) * 2;
    w = (m[5] - m[7]) / s;
    x = 0.25 * s;
    y = (m[1] + m[3]) / s;
    z = (m[6] + m[2]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1.0 + m[4] - m[0] - m[8]) * 2;
    w = (m[6] - m[2]) / s;
    x = (m[1] + m[3]) / s;
    y = 0.25 * s;
    z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1.0 + m[8] - m[0] - m[4]) * 2;
    w = (m[1] - m[3]) / s;
    x = (m[6] + m[2]) / s;
    y = (m[5] + m[7]) / s;
    z = 0.25 * s;
  }
  return qNormalize([x, y, z, w]);
}

function composeMat4([tx, ty, tz], [qx, qy, qz, qw], [sx, sy, sz]) {
  const out = new Float32Array(16);
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;

  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;

  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;

  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;

  return out;
}

function qNormalize(q) {
  const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
  return len > 0 ? [q[0]/len, q[1]/len, q[2]/len, q[3]/len] : [0, 0, 0, 1];
}
function vec3Subtract(a, b) {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}
function vec3Normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 0];
}
function vec3Length(v) {
  return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
}
function qInvert(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}
function qMul(a, b) {
  return [
    a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
    a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function rotateVec3(v, q) {
  const x = v[0], y = v[1], z = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}
function quatFromTwoVectors(a, b) {
  const dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  if (dot < -0.99999) {
    let axis = [a[1], -a[0], 0];
    if (Math.sqrt(axis[0]*axis[0] + axis[1]*axis[1]) < 0.0001) {
      axis = [0, a[2], -a[1]];
    }
    const len = Math.sqrt(axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]);
    return qNormalize([axis[0]/len, axis[1]/len, axis[2]/len, 0]);
  }
  if (dot > 0.99999) return [0, 0, 0, 1];
  const cross = [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0]
  ];
  return qNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}

// ── Adjust an existing rig in place ──────────────────────────────────────────
// Moves matched joints to the requested world (skin-space) positions while
// keeping hierarchy, bind orientations, extra bones (fingers, twist) and the
// original skin weights. Unmatched descendants follow their nearest moved
// ancestor rigidly. With unmoved markers this is an identity operation.
function adjustExistingRig(doc, targetJoints = {}) {
  const root = doc.getRoot();

  // Old animation tracks reference the old bind — caller re-merges afterwards
  for (const anim of root.listAnimations()) anim.dispose();

  const parentMap = buildParentMap(doc);

  // Find skins and identify joint set
  const skinData = [];
  const jointSet = new Set();
  for (const skin of root.listSkins()) {
    const joints = skin.listJoints();
    const acc = skin.getInverseBindMatrices();
    const arr = acc?.getArray();
    if (!arr) continue;
    skinData.push({ joints, acc, arr: Float32Array.from(arr) });
    joints.forEach(j => jointSet.add(j));
  }
  if (skinData.length === 0) throw new Error('Skin has no inverse bind matrices.');

  // S maps skin space → render world.
  const matCache0 = new Map();
  const S = mat4Mul(
    worldMatrixOf(skinData[0].joints[0], parentMap, matCache0),
    skinData[0].arr.slice(0, 16)
  );
  const invS = invertRigidMat4(S);

  // Compute original bind world positions, rotations, and scales for ALL nodes in the scene in skin space
  const origWorldPos = new Map();
  const origWorldRot = new Map();
  const origWorldScale = new Map();
  const matCache = new Map();
  
  for (const node of doc.getRoot().listNodes()) {
    const W_render = worldMatrixOf(node, parentMap, matCache);
    const B = mat4Mul(invS, W_render); // Node's bind matrix in skin space
    
    origWorldPos.set(node, [B[12], B[13], B[14]]);

    const sx = Math.hypot(B[0], B[1], B[2]) || 1;
    const sy = Math.hypot(B[4], B[5], B[6]) || 1;
    const sz = Math.hypot(B[8], B[9], B[10]) || 1;
    origWorldScale.set(node, [sx, sy, sz]);

    const m = [
      B[0] / sx, B[1] / sx, B[2] / sx,
      B[4] / sy, B[5] / sy, B[6] / sy,
      B[8] / sz, B[9] / sz, B[10] / sz
    ];
    origWorldRot.set(node, mat3ToQuat(m));
  }

  // canonical marker name → joint node
  const normToNode = new Map();
  for (const j of jointSet) {
    for (const n of seedNormVariants(j.getName())) {
      if (n && !normToNode.has(n)) normToNode.set(n, j);
    }
  }

  const markerByNode = new Map();
  for (const [canon, aliases] of Object.entries(SEED_ALIASES)) {
    if (!targetJoints[canon]) continue;
    for (const a of aliases) {
      if (normToNode.has(a)) { markerByNode.set(normToNode.get(a), transformPoint(invS, targetJoints[canon])); break; }
    }
  }
  // CC/AccuRig 3-bone spine: markers follow the same chain shift as the merge
  // (Spine→Waist, Spine1→Spine01, Spine2→Spine02); overrides the generic pass.
  if (normToNode.has('waist') && normToNode.has('spine01') &&
      normToNode.has('spine02') && !normToNode.has('spine03')) {
    for (const [canon, alias] of [['Spine', 'waist'], ['Spine1', 'spine01'], ['Spine2', 'spine02']]) {
      if (targetJoints[canon]) markerByNode.set(normToNode.get(alias), transformPoint(invS, targetJoints[canon]));
    }
  }
  // AdvancedSkeleton: Scapula = clavicle, Shoulder = upper arm — mirror the
  // seed-time chain shift so markers drive the right bones.
  for (const s of ['l', 'r']) {
    if (normToNode.has(`scapula${s}`) && normToNode.has(`shoulder${s}`)) {
      const side = s === 'l' ? 'Left' : 'Right';
      for (const [canon, alias] of [[`${side}Shoulder`, `scapula${s}`], [`${side}Arm`, `shoulder${s}`]]) {
        if (targetJoints[canon]) markerByNode.set(normToNode.get(alias), transformPoint(invS, targetJoints[canon]));
      }
    }
  }
  // 1-indexed spine chain (no plain "spine"): same shift as seed time.
  if (!normToNode.has('spine') && normToNode.has('spine1') &&
      normToNode.has('spine2') && normToNode.has('spine3')) {
    for (const [canon, alias] of [['Spine', 'spine1'], ['Spine1', 'spine2'], ['Spine2', 'spine3']]) {
      if (targetJoints[canon]) markerByNode.set(normToNode.get(alias), transformPoint(invS, targetJoints[canon]));
    }
  }

  // New world positions: markers win; others keep their offset to the parent (for ALL nodes in the scene)
  const newWorldPos = new Map();
  function computeNewPos(node) {
    if (newWorldPos.has(node)) return newWorldPos.get(node);
    const marker = markerByNode.get(node);
    if (marker) { newWorldPos.set(node, marker); return marker; }
    const p = parentMap.get(node);
    const o = origWorldPos.get(node);
    if (!p) { newWorldPos.set(node, o); return o; }
    const pNew = computeNewPos(p);
    const pOld = origWorldPos.get(p);
    const np = [o[0] + pNew[0] - pOld[0], o[1] + pNew[1] - pOld[1], o[2] + pNew[2] - pOld[2]];
    newWorldPos.set(node, np);
    return np;
  }
  for (const node of doc.getRoot().listNodes()) computeNewPos(node);

  // Initialize newWorldRot with a copy of origWorldRot (for ALL nodes in the scene)
  const newWorldRot = new Map();
  for (const node of doc.getRoot().listNodes()) {
    newWorldRot.set(node, [...origWorldRot.get(node)]);
  }

  // canonical name → joint node (for fast lookup during alignment)
  const canonToNode = new Map();
  for (const [canon, aliases] of Object.entries(SEED_ALIASES)) {
    for (const a of aliases) {
      if (normToNode.has(a)) {
        canonToNode.set(canon, normToNode.get(a));
        break;
      }
    }
  }
  if (normToNode.has('waist') && normToNode.has('spine01') &&
      normToNode.has('spine02') && !normToNode.has('spine03')) {
    canonToNode.set('Spine', normToNode.get('waist'));
    canonToNode.set('Spine1', normToNode.get('spine01'));
    canonToNode.set('Spine2', normToNode.get('spine02'));
  }
  for (const s of ['l', 'r']) {
    if (normToNode.has(`scapula${s}`) && normToNode.has(`shoulder${s}`)) {
      const side = s === 'l' ? 'Left' : 'Right';
      canonToNode.set(`${side}Shoulder`, normToNode.get(`scapula${s}`));
      canonToNode.set(`${side}Arm`, normToNode.get(`shoulder${s}`));
    }
  }
  if (!normToNode.has('spine') && normToNode.has('spine1') &&
      normToNode.has('spine2') && normToNode.has('spine3')) {
    canonToNode.set('Spine', normToNode.get('spine1'));
    canonToNode.set('Spine1', normToNode.get('spine2'));
    canonToNode.set('Spine2', normToNode.get('spine3'));
  }

  function applyRotationCorrection(node, qCorr) {
    const cur = newWorldRot.get(node) || [0, 0, 0, 1];
    newWorldRot.set(node, qNormalize(qMul(qCorr, cur)));
    for (const child of node.listChildren()) {
      applyRotationCorrection(child, qCorr);
    }
  }

  // Align limbs so bones look at their updated children, propagating corrections down.
  const alignPairs = [
    ['LeftShoulder', 'LeftArm'],
    ['LeftArm', 'LeftForeArm'],
    ['LeftForeArm', 'LeftHand'],
    ['RightShoulder', 'RightArm'],
    ['RightArm', 'RightForeArm'],
    ['RightForeArm', 'RightHand'],
    ['LeftUpLeg', 'LeftLeg'],
    ['LeftLeg', 'LeftFoot'],
    ['LeftFoot', 'LeftToeBase'],
    ['RightUpLeg', 'RightLeg'],
    ['RightLeg', 'RightFoot'],
    ['RightFoot', 'RightToeBase'],
  ];

  for (const [parentName, childName] of alignPairs) {
    const P = canonToNode.get(parentName);
    const C = canonToNode.get(childName);
    if (!P || !C) continue;

    const vOldWorld = vec3Subtract(origWorldPos.get(C), origWorldPos.get(P));
    const qDiff = qMul(newWorldRot.get(P), qInvert(origWorldRot.get(P)));
    const vCurr = rotateVec3(vOldWorld, qDiff);
    const vTarget = vec3Subtract(newWorldPos.get(C), newWorldPos.get(P));

    const vCurrNorm = vec3Normalize(vCurr);
    const vTargetNorm = vec3Normalize(vTarget);

    if (vec3Length(vCurrNorm) > 0.001 && vec3Length(vTargetNorm) > 0.001) {
      // quatFromTwoVectors is the minimal-twist (roll-free) rotation between the
      // two aim directions. The single ill-defined case is a ~180° flip, where
      // the rotation axis is arbitrary and would inject random roll into the
      // limb and everything below it. A re-rig marker move almost never inverts
      // a limb, so treat that as a measurement error and skip the correction
      // rather than twist the mesh.
      const aim = vCurrNorm[0] * vTargetNorm[0] + vCurrNorm[1] * vTargetNorm[1] + vCurrNorm[2] * vTargetNorm[2];
      if (aim > -0.98) {
        const qCorr = quatFromTwoVectors(vCurrNorm, vTargetNorm);
        applyRotationCorrection(P, qCorr);
      } else {
        console.warn(`[autorig] Skipping near-180° ${parentName}→${childName} alignment (would inject arbitrary roll).`);
      }
    }
  }

  // Update node local translations and rotations
  for (const j of jointSet) {
    const np = newWorldPos.get(j);
    const directParent = parentMap.get(j) || null;
    let localT;
    if (directParent) {
      const pNewPos = newWorldPos.get(directParent);
      const pNewRot = newWorldRot.get(directParent);
      const d = vec3Subtract(np, pNewPos);
      localT = rotateVec3(d, qInvert(pNewRot));

      // Handle parent scale if present
      const pScale = origWorldScale.get(directParent) || [1, 1, 1];
      localT = [localT[0] / pScale[0], localT[1] / pScale[1], localT[2] / pScale[2]];
    } else {
      localT = np.slice();
    }
    j.setTranslation(localT);

    // Set local rotation
    const parent = parentMap.get(j);
    let localR;
    if (parent) {
      const pNewRot = newWorldRot.get(parent);
      localR = qNormalize(qMul(qInvert(pNewRot), newWorldRot.get(j)));
    } else {
      localR = qNormalize(newWorldRot.get(j));
    }
    j.setRotation(localR);
  }

  // Update Inverse Bind Matrices (IBMs)
  for (const { joints, acc, arr } of skinData) {
    const out = Float32Array.from(arr);
    joints.forEach((j, i) => {
      const W_new = composeMat4(newWorldPos.get(j), newWorldRot.get(j), origWorldScale.get(j));
      const IBM_new = invertRigidMat4(W_new);
      for (let k = 0; k < 16; k++) {
        out[i * 16 + k] = IBM_new[k];
      }
    });
    acc.setArray(out);
  }
}

// ── Strip an existing rig (skin, weights, bones, animations) ─────────────────
function stripExistingRig(doc) {
  const root = doc.getRoot();

  // Old animations target old bones — remove (caller re-merges afterwards)
  for (const anim of root.listAnimations()) anim.dispose();

  const jointSet = new Set();
  for (const skin of root.listSkins()) {
    for (const j of skin.listJoints()) jointSet.add(j);
  }

  const skinnedMeshes = new Set();
  for (const node of root.listNodes()) {
    if (node.getSkin()) {
      if (node.getMesh()) skinnedMeshes.add(node.getMesh());
      node.setSkin(null);
      // Skinned node transforms are ignored by the glTF skinning path —
      // neutralize so the now-static mesh doesn't pick up a stale transform.
      node.setTranslation([0, 0, 0]);
      node.setRotation([0, 0, 0, 1]);
      node.setScale([1, 1, 1]);
    }
  }
  for (const mesh of skinnedMeshes) {
    for (const prim of mesh.listPrimitives()) {
      for (const sem of ['JOINTS_0', 'WEIGHTS_0', 'JOINTS_1', 'WEIGHTS_1']) {
        const attr = prim.getAttribute(sem);
        if (attr) prim.setAttribute(sem, null);
      }
    }
  }
  for (const skin of root.listSkins()) skin.dispose();

  // Dispose joint nodes that carry no mesh anywhere in their subtree
  const hasMeshInSubtree = (node) =>
    !!node.getMesh() || node.listChildren().some(hasMeshInSubtree);
  for (const joint of jointSet) {
    if (joint.isDisposed?.() === true) continue;
    if (!hasMeshInSubtree(joint)) joint.dispose();
  }

  return skinnedMeshes;
}

// ── Skeleton hierarchy definition ────────────────────────────────────────────
// The 22-joint body core is shared by every body plan; tails and finger chains
// are layered on per rig layout (body plan + finger count selectors).
const BODY_HIERARCHY = {
  Hips: null,
  Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};
const TAIL_HIERARCHY = { Tail1: 'Hips', Tail2: 'Tail1', Tail3: 'Tail2' };

const ALL_FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
// Finger-count selector: which anatomical fingers each hand gets.
const FINGER_SETS = Object.freeze({
  0: [],
  2: ['Thumb', 'Index'],                       // mitten / claw
  3: ['Thumb', 'Index', 'Middle'],             // cartoon hand
  4: ['Thumb', 'Index', 'Middle', 'Ring'],
  5: ALL_FINGER_NAMES,
});
function resolveFingerCount(v) {
  if (v === undefined || v === null || v === '') return 5;
  const n = Number(v);
  if (!Object.hasOwn(FINGER_SETS, n)) {
    throw new Error(`Unsupported finger count "${String(v)}". Supported: ${Object.keys(FINGER_SETS).join(', ')}.`);
  }
  return n;
}

export const BODY_PLANS = Object.freeze({
  humanoid: Object.freeze({ label: 'Humanoid (biped)' }),
  quadruped: Object.freeze({ label: 'Animal (quadruped)' }),
});
function resolveBodyPlan(id = 'humanoid') {
  if (typeof id !== 'string' || !Object.hasOwn(BODY_PLANS, id)) {
    throw new Error(`Unknown body plan "${String(id)}". Supported: ${Object.keys(BODY_PLANS).join(', ')}.`);
  }
  return id;
}

function fingerHierarchy(fingers) {
  const h = {};
  for (const side of ['Left', 'Right']) {
    for (const finger of fingers) {
      h[`${side}Hand${finger}1`] = `${side}Hand`;
      h[`${side}Hand${finger}2`] = `${side}Hand${finger}1`;
      h[`${side}Hand${finger}3`] = `${side}Hand${finger}2`;
    }
  }
  return h;
}

/** Rig layout for a body plan + finger count: hierarchy, joint order, and which
 *  joints are body (always skin-weighted) vs fingers (opt-in weighting). */
export function buildRigLayout({ bodyPlan = 'humanoid', fingerCount = 5 } = {}) {
  const plan = resolveBodyPlan(bodyPlan);
  const fingers = FINGER_SETS[resolveFingerCount(fingerCount)];
  const hierarchy = {
    ...BODY_HIERARCHY,
    ...(plan === 'quadruped' ? TAIL_HIERARCHY : {}),
    ...fingerHierarchy(fingers),
  };
  const order = Object.keys(hierarchy);
  const isFinger = (n) => /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[123]$/.test(n);
  return {
    bodyPlan: plan,
    fingers,
    hierarchy,
    order,
    bodyOrder: order.filter(n => !isFinger(n)),
  };
}

// Optional roll-distribution bones between elbow and wrist. Never guessed or
// marker-driven: positions derive from the final ForeArm/Hand placement, and a
// runtime driver (character controller) rotates them from the hand's twist.
const TWIST_HIERARCHY = { LeftForeArmTwist: 'LeftForeArm', RightForeArmTwist: 'RightForeArm' };
const TWIST_FRACTION = 0.55; // fraction along ForeArm→Hand where the twist joint sits

// Every joint name any layout can produce (for unknown-name validation).
const FULL_HIERARCHY = {
  ...BODY_HIERARCHY,
  ...TAIL_HIERARCHY,
  ...TWIST_HIERARCHY,
  ...fingerHierarchy(ALL_FINGER_NAMES),
};
const DEFAULT_LAYOUT = buildRigLayout();

// Canonical anatomy is deliberately independent from exported bone names. This
// keeps detection and weighting stable while allowing the generated rig to plug
// directly into the naming conventions used by common engines/DCC pipelines.
export const SKELETON_PRESETS = Object.freeze({
  mixamo: Object.freeze({ label: 'Mixamo / Babylon.js', names: Object.freeze({}) }),
  unity: Object.freeze({ label: 'Unity Humanoid', names: Object.freeze({
    Hips: 'Hips', Spine: 'Spine', Spine1: 'Chest', Spine2: 'UpperChest',
    LeftArm: 'LeftUpperArm', LeftForeArm: 'LeftLowerArm', LeftUpLeg: 'LeftUpperLeg', LeftLeg: 'LeftLowerLeg',
    RightArm: 'RightUpperArm', RightForeArm: 'RightLowerArm', RightUpLeg: 'RightUpperLeg', RightLeg: 'RightLowerLeg',
    LeftToeBase: 'LeftToes', RightToeBase: 'RightToes',
  }) }),
  unreal: Object.freeze({ label: 'Unreal Engine', names: Object.freeze({
    Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'head',
    LeftShoulder: 'clavicle_l', LeftArm: 'upperarm_l', LeftForeArm: 'lowerarm_l', LeftHand: 'hand_l',
    RightShoulder: 'clavicle_r', RightArm: 'upperarm_r', RightForeArm: 'lowerarm_r', RightHand: 'hand_r',
    LeftUpLeg: 'thigh_l', LeftLeg: 'calf_l', LeftFoot: 'foot_l', LeftToeBase: 'ball_l',
    RightUpLeg: 'thigh_r', RightLeg: 'calf_r', RightFoot: 'foot_r', RightToeBase: 'ball_r',
  }) }),
  blender: Object.freeze({ label: 'Blender / Rigify', names: Object.freeze({
    Hips: 'hips', Spine: 'spine', Spine1: 'spine.001', Spine2: 'spine.002', Neck: 'neck', Head: 'head',
    LeftShoulder: 'shoulder.L', LeftArm: 'upper_arm.L', LeftForeArm: 'forearm.L', LeftHand: 'hand.L',
    RightShoulder: 'shoulder.R', RightArm: 'upper_arm.R', RightForeArm: 'forearm.R', RightHand: 'hand.R',
    LeftUpLeg: 'thigh.L', LeftLeg: 'shin.L', LeftFoot: 'foot.L', LeftToeBase: 'toe.L',
    RightUpLeg: 'thigh.R', RightLeg: 'shin.R', RightFoot: 'foot.R', RightToeBase: 'toe.R',
  }) }),
});

function resolveSkeletonPreset(id = 'mixamo') {
  if (typeof id !== 'string' || !Object.hasOwn(SKELETON_PRESETS, id)) {
    throw new Error(`Unknown skeleton preset "${String(id)}". Supported: ${Object.keys(SKELETON_PRESETS).join(', ')}.`);
  }
  return SKELETON_PRESETS[id];
}

const FINGER_NAMES = ALL_FINGER_NAMES;

function detectFingerTipsFromVertices(verts, wrist, silhouetteTip, H, forwardZ) {
  const outward = vec3Normalize(vec3Subtract(silhouetteTip, wrist));
  const reach = vec3Length(vec3Subtract(silhouetteTip, wrist));
  if (reach < 0.015 * H) return silhouetteTip;
  const forward = [0, 0, forwardZ];
  let across = vec3Normalize([
    forward[1] * outward[2] - forward[2] * outward[1],
    forward[2] * outward[0] - forward[0] * outward[2],
    forward[0] * outward[1] - forward[1] * outward[0],
  ]);
  if (vec3Length(across) < 1e-4) return silhouetteTip;
  const samples = [];
  for (const p of verts) {
    const d = vec3Subtract(p, wrist);
    const along = d[0] * outward[0] + d[1] * outward[1] + d[2] * outward[2];
    const lateral = d[0] * across[0] + d[1] * across[1] + d[2] * across[2];
    const axial2 = Math.max(0, d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - along * along);
    if (along > -0.08 * reach && along < 1.45 * reach && axial2 < (1.05 * reach) ** 2) {
      samples.push({ p, along, lateral });
    }
  }
  if (samples.length < 100) return silhouetteTip;
  let min = Infinity, max = -Infinity;
  for (const s of samples) { min = Math.min(min, s.lateral); max = Math.max(max, s.lateral); }
  if (max - min < 0.35 * reach) return silhouetteTip;
  let centers = Array.from({ length: 5 }, (_, i) => min + (max - min) * (i + 0.5) / 5);
  let groups = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    groups = Array.from({ length: 5 }, () => []);
    for (const s of samples) {
      let best = 0;
      for (let i = 1; i < 5; i++) if (Math.abs(s.lateral - centers[i]) < Math.abs(s.lateral - centers[best])) best = i;
      groups[best].push(s);
    }
    centers = groups.map((g, i) => g.length ? g.reduce((sum, s) => sum + s.lateral, 0) / g.length : centers[i]);
  }
  if (groups.some(g => g.length < 12)) return silhouetteTip;
  const clusters = groups.map((g, i) => {
    const ordered = [...g].sort((a, b) => b.along - a.along);
    const cap = ordered.slice(0, Math.max(3, Math.ceil(ordered.length * 0.06)));
    return { center: centers[i], along: cap.reduce((s, v) => s + v.along, 0) / cap.length,
      tip: centroidOf(cap.map(v => v.p)) };
  }).sort((a, b) => a.center - b.center);
  // Thumb is the outside branch with the larger lateral gap to its neighbour.
  // Length is unreliable on bent/open hands and was reversing finger labels.
  const thumbAtStart = (clusters[1].center - clusters[0].center) >=
    (clusters[4].center - clusters[3].center);
  const ordered = thumbAtStart ? clusters : [...clusters].reverse();
  const result = {};
  FINGER_NAMES.forEach((name, i) => { result[name] = ordered[i].tip; });
  return result;
}

function addFingerJoints(joints, H, forwardZ = 1, fingerTips = null, fingers = FINGER_NAMES) {
  if (!fingers.length) return;
  // Non-thumb knuckles spread evenly across the palm regardless of how many
  // fingers the hand has (2-finger claws get one wide digit, 5 the full fan).
  const nonThumb = fingers.filter(f => f !== 'Thumb');
  const lateral = {};
  nonThumb.forEach((f, i) => {
    lateral[f] = nonThumb.length === 1 ? 0 : -0.36 + (0.72 * i) / (nonThumb.length - 1);
  });
  for (const side of ['Left', 'Right']) {
    const hand = joints[`${side}Hand`], fore = joints[`${side}ForeArm`];
    if (!hand || !fore) continue;
    const guide = fingerTips?.[side];
    const silhouetteTip = Array.isArray(guide) ? guide : null;
    const representativeTip = silhouetteTip || guide?.Middle || guide?.Index;
    const outward = vec3Normalize(vec3Subtract(representativeTip || hand, representativeTip ? hand : fore));
    const handReach = representativeTip ? vec3Length(vec3Subtract(representativeTip, hand)) : 0.11 * H;
    const sideSign = side === 'Left' ? 1 : -1;
    const forward = [0, 0, forwardZ];
    let across = vec3Normalize([
      forward[1] * outward[2] - forward[2] * outward[1],
      forward[2] * outward[0] - forward[0] * outward[2],
      forward[0] * outward[1] - forward[1] * outward[0],
    ]);
    if (vec3Length(across) < 1e-4) across = [0, sideSign, 0];
    for (const finger of fingers) {
      const detectedTip = !Array.isArray(guide) ? guide?.[finger] : null;
      if (detectedTip) {
        // Hand is the wrist. Finger joints begin at the knuckle, not midway
        // across the palm, so reserve the first ~58% for the metacarpal/palm.
        const fractions = finger === 'Thumb' ? [0.52, 0.74, 0.96] : [0.60, 0.79, 0.97];
        for (let segment = 1; segment <= 3; segment++) {
          const t = fractions[segment - 1];
          joints[`${side}Hand${finger}${segment}`] = [
            hand[0] + (detectedTip[0] - hand[0]) * t,
            hand[1] + (detectedTip[1] - hand[1]) * t,
            hand[2] + (detectedTip[2] - hand[2]) * t,
          ];
        }
        continue;
      }
      const thumb = finger === 'Thumb';
      const rootAcross = (thumb ? -0.55 : lateral[finger]) * handReach * sideSign;
      const palmAdvance = (thumb ? 0.15 : 0.28) * handReach;
      let prev = [
        hand[0] + outward[0] * palmAdvance + across[0] * rootAcross,
        hand[1] + outward[1] * palmAdvance + across[1] * rootAcross,
        hand[2] + outward[2] * palmAdvance + across[2] * rootAcross,
      ];
      for (let segment = 1; segment <= 3; segment++) {
        const length = (thumb ? 0.18 : 0.24) * handReach;
        const direction = thumb
          ? vec3Normalize([
            outward[0] * 0.65 + across[0] * -0.55 * sideSign,
            outward[1] * 0.65 + across[1] * -0.55 * sideSign,
            outward[2] * 0.65 + across[2] * -0.55 * sideSign + forwardZ * 0.18,
          ])
          : outward;
        const p = [prev[0] + direction[0] * length, prev[1] + direction[1] * length, prev[2] + direction[2] * length];
        joints[`${side}Hand${finger}${segment}`] = p;
        prev = p;
      }
    }
  }
}

// Tail chain for quadrupeds: extends from the hips away from the chest, with a
// gentle droop. Pure seed — the user refines the markers.
function addTailJoints(joints, H) {
  const away = vec3Normalize(vec3Subtract(joints.Hips, joints.Spine2));
  if (vec3Length(away) < 1e-4) return;
  for (let i = 1; i <= 3; i++) {
    const t = 0.16 * i * H;
    joints[`Tail${i}`] = [
      joints.Hips[0] + away[0] * t,
      joints.Hips[1] + away[1] * t - 0.03 * i * H,
      joints.Hips[2] + away[2] * t,
    ];
  }
}

// Quadruped fallback when the topology pass can't resolve the mesh: a standing
// animal seen from the bounds. Spine runs horizontally along the facing axis;
// front limbs use the arm chain, hind limbs the leg chain.
function guessQuadrupedFromBounds({ min, max }, forwardZ = 1) {
  const H = max[1] - min[1];
  const cx = (min[0] + max[0]) / 2;
  const halfW = Math.max((max[0] - min[0]) / 2, 0.05 * H);
  const zAt = f => forwardZ > 0 ? min[2] + f * (max[2] - min[2]) : max[2] - f * (max[2] - min[2]);
  const y = f => min[1] + f * H;
  const legX = 0.55 * halfW;
  const frontZ = zAt(0.74), hindZ = zAt(0.24);
  const spineY = y(0.68);

  const joints = {
    Hips: [cx, spineY, hindZ],
    Spine: [cx, spineY + 0.01 * H, zAt(0.38)],
    Spine1: [cx, spineY + 0.02 * H, zAt(0.52)],
    Spine2: [cx, spineY + 0.02 * H, zAt(0.66)],
    Neck: [cx, y(0.78), zAt(0.84)],
    Head: [cx, y(0.88), zAt(0.95)],
  };
  for (const [side, sgn] of [['Left', 1], ['Right', -1]]) {
    const x = cx + sgn * forwardZ * legX;
    joints[side + 'Shoulder'] = [cx + sgn * forwardZ * 0.3 * legX, spineY, frontZ];
    joints[side + 'Arm'] = [x, y(0.55), frontZ];
    joints[side + 'ForeArm'] = [x, y(0.30), frontZ];
    joints[side + 'Hand'] = [x, y(0.06), frontZ];
    joints[side + 'UpLeg'] = [x, y(0.55), hindZ];
    joints[side + 'Leg'] = [x, y(0.30), hindZ];
    joints[side + 'Foot'] = [x, y(0.06), hindZ];
    joints[side + 'ToeBase'] = [x, y(0.02), hindZ + forwardZ * 0.05 * H];
  }
  return { joints, height: H, bounds: { min, max }, method: 'quadruped-bounds' };
}

function exportedJointName(presetId, preset, canonical) {
  if (preset.names[canonical]) return preset.names[canonical];
  const twist = /^(Left|Right)ForeArmTwist$/.exec(canonical);
  if (twist) {
    if (presetId === 'unreal') return `lowerarm_twist_01_${twist[1] === 'Left' ? 'l' : 'r'}`;
    if (presetId === 'blender') return `forearm_twist.${twist[1] === 'Left' ? 'L' : 'R'}`;
    if (presetId === 'unity') return `${twist[1]}LowerArmTwist`;
    return canonical;
  }
  const tail = /^Tail([123])$/.exec(canonical);
  if (tail) {
    if (presetId === 'unreal') return `tail_0${tail[1]}`;
    if (presetId === 'blender') return `tail.00${tail[1]}`;
    return canonical;
  }
  const m = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/.exec(canonical);
  if (!m) return canonical;
  const [, side, finger, segment] = m;
  if (presetId === 'unreal') return `${finger.toLowerCase()}_0${segment}_${side === 'Left' ? 'l' : 'r'}`;
  if (presetId === 'blender') return `f_${finger.toLowerCase()}.${String(segment).padStart(2, '0')}.${side === 'Left' ? 'L' : 'R'}`;
  return canonical;
}

export function validateJointLayout(joints, height, { partial = false, layout = DEFAULT_LAYOUT } = {}) {
  if (!joints || typeof joints !== 'object' || Array.isArray(joints)) throw new Error('joints must be an object.');
  if (!Number.isFinite(height) || height <= 1e-6) throw new Error('Character bounds have zero or invalid height.');
  for (const [name, value] of Object.entries(joints)) {
    if (!Object.hasOwn(FULL_HIERARCHY, name)) throw new Error(`Unknown autorig joint "${name}".`);
    if (!Array.isArray(value) || value.length !== 3 || value.some(v => !Number.isFinite(v))) {
      throw new Error(`Joint "${name}" must be an array of 3 finite numbers.`);
    }
  }
  if (partial) return true;
  for (const name of layout.order) if (!joints[name]) throw new Error(`Missing required joint "${name}".`);
  const minLength = height * 1e-4;
  for (const [name, parent] of Object.entries(layout.hierarchy)) {
    if (!parent) continue;
    if (vec3Length(vec3Subtract(joints[name], joints[parent])) < minLength) {
      throw new Error(`Joint "${name}" overlaps its parent "${parent}".`);
    }
  }
  return true;
}

// Weighting segment per bone: [start joint, end joint or offset fn]
function boneSegments(joints, H) {
  const seg = (a, b) => [joints[a], joints[b]];
  const ext = (a, off) => [joints[a], [joints[a][0] + off[0], joints[a][1] + off[1], joints[a][2] + off[2]]];
  const handDir = (arm, fore) => {
    const d = [joints[fore][0] - joints[arm][0], joints[fore][1] - joints[arm][1], joints[fore][2] - joints[arm][2]];
    const l = Math.hypot(...d) || 1;
    return [d[0] / l * 0.10 * H, d[1] / l * 0.10 * H, d[2] / l * 0.10 * H];
  };
  // Head continues along the neck→head axis (up for bipeds, forward for
  // quadrupeds and hunched characters) instead of a hardcoded vertical.
  const headDir = (() => {
    const d = vec3Subtract(joints.Head, joints.Neck);
    const l = vec3Length(d) || 1;
    return [d[0] / l * 0.11 * H, d[1] / l * 0.11 * H, d[2] / l * 0.11 * H];
  })();
  const segments = {
    Hips: seg('Hips', 'Spine'),
    Spine: seg('Spine', 'Spine1'),
    Spine1: seg('Spine1', 'Spine2'),
    Spine2: seg('Spine2', 'Neck'),
    Neck: seg('Neck', 'Head'),
    Head: ext('Head', headDir),
    LeftShoulder: seg('LeftShoulder', 'LeftArm'),
    LeftArm: seg('LeftArm', 'LeftForeArm'),
    LeftForeArm: seg('LeftForeArm', 'LeftHand'),
    LeftHand: ext('LeftHand', handDir('LeftForeArm', 'LeftHand')),
    RightShoulder: seg('RightShoulder', 'RightArm'),
    RightArm: seg('RightArm', 'RightForeArm'),
    RightForeArm: seg('RightForeArm', 'RightHand'),
    RightHand: ext('RightHand', handDir('RightForeArm', 'RightHand')),
    LeftUpLeg: seg('LeftUpLeg', 'LeftLeg'),
    LeftLeg: seg('LeftLeg', 'LeftFoot'),
    LeftFoot: seg('LeftFoot', 'LeftToeBase'),
    LeftToeBase: ext('LeftToeBase', [0, 0, 0.05 * H * Math.sign(joints.LeftToeBase[2] - joints.LeftFoot[2] || 1)]),
    RightUpLeg: seg('RightUpLeg', 'RightLeg'),
    RightLeg: seg('RightLeg', 'RightFoot'),
    RightFoot: seg('RightFoot', 'RightToeBase'),
    RightToeBase: ext('RightToeBase', [0, 0, 0.05 * H * Math.sign(joints.RightToeBase[2] - joints.RightFoot[2] || 1)]),
  };
  // Twist bones: split the forearm span so weights fade elbow→twist→wrist and
  // the runtime roll driver produces a smooth candy-wrapper-free wrist.
  for (const side of ['Left', 'Right']) {
    const twist = `${side}ForeArmTwist`;
    if (!joints[twist]) continue;
    segments[`${side}ForeArm`] = seg(`${side}ForeArm`, twist);
    segments[twist] = seg(twist, `${side}Hand`);
  }
  // Tail chain (quadrupeds): only when the layout includes it.
  if (joints.Tail1) {
    segments.Tail1 = seg('Tail1', 'Tail2');
    segments.Tail2 = seg('Tail2', 'Tail3');
    segments.Tail3 = ext('Tail3', vec3Subtract(joints.Tail3, joints.Tail2));
  }
  for (const side of ['Left', 'Right']) {
    for (const finger of FINGER_NAMES) {
      if (!joints[`${side}Hand${finger}1`]) continue; // finger not in this layout
      for (let n = 1; n <= 3; n++) {
        const name = `${side}Hand${finger}${n}`;
        const next = n < 3 ? `${side}Hand${finger}${n + 1}` : null;
        const previous = `${side}Hand${finger}${n - 1}`;
        segments[name] = next ? seg(name, next) : ext(name, vec3Subtract(joints[name], joints[previous]));
      }
    }
  }
  return segments;
}

function distPointSegment(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const abLen2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  let t = abLen2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = p[0] - (a[0] + ab[0] * t);
  const dy = p[1] - (a[1] + ab[1] * t);
  const dz = p[2] - (a[2] + ab[2] * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Mesh vertex adjacency (for weight smoothing) ─────────────────────────────
// Welds vertices by position (split UV/normal seams share one logical vertex so
// smoothing crosses the seam) and returns, per logical vertex, the set of
// logical neighbours from the triangle edges. Smoothing weights across this
// graph removes the hard creases pure proximity weighting leaves at elbows,
// knees, armpits and the crotch.
function buildVertexAdjacency(positions, indices, weldEps) {
  const count = positions.length / 3;
  // Weld: quantize positions to a grid, map duplicate coords to one repId.
  const inv = 1 / Math.max(weldEps, 1e-8);
  const keyToRep = new Map();
  const repOf = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    const kx = Math.round(positions[v * 3] * inv);
    const ky = Math.round(positions[v * 3 + 1] * inv);
    const kz = Math.round(positions[v * 3 + 2] * inv);
    const key = kx + ',' + ky + ',' + kz;
    let rep = keyToRep.get(key);
    if (rep === undefined) { rep = v; keyToRep.set(key, v); }
    repOf[v] = rep;
  }
  // Adjacency over representatives (Set per rep, then flatten).
  const adjSet = new Map();
  const link = (a, b) => {
    if (a === b) return;
    let s = adjSet.get(a);
    if (!s) { s = new Set(); adjSet.set(a, s); }
    s.add(b);
  };
  const triCount = indices ? indices.length / 3 : count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = repOf[indices ? indices[t * 3] : t * 3];
    const i1 = repOf[indices ? indices[t * 3 + 1] : t * 3 + 1];
    const i2 = repOf[indices ? indices[t * 3 + 2] : t * 3 + 2];
    link(i0, i1); link(i1, i0);
    link(i1, i2); link(i2, i1);
    link(i2, i0); link(i0, i2);
  }
  return { repOf, adjSet, count };
}

// Laplacian-smooth a dense per-vertex weight matrix (count × nBones) over the
// welded vertex graph. Uniform weights, in place, `iters` passes, `lambda`
// blend. Operates on representatives; non-representative duplicates copy their
// rep afterwards so seams stay watertight.
function smoothWeightField(W, nBones, adjacency, iters, lambda) {
  const { repOf, adjSet, count } = adjacency;
  // Collapse onto representatives first (average duplicates into their rep row).
  const repCount = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    const r = repOf[v];
    if (r === v) continue;
    repCount[r]++;
    for (let b = 0; b < nBones; b++) W[r * nBones + b] += W[v * nBones + b];
  }
  for (let r = 0; r < count; r++) {
    if (repCount[r] === 0) continue;
    const inv = 1 / (repCount[r] + 1);
    for (let b = 0; b < nBones; b++) W[r * nBones + b] *= inv;
  }
  const tmp = new Float32Array(W.length);
  for (let it = 0; it < iters; it++) {
    for (const [r, nbrs] of adjSet) {
      const n = nbrs.size;
      if (n === 0) continue;
      const base = r * nBones;
      for (let b = 0; b < nBones; b++) {
        let acc = 0;
        for (const nb of nbrs) acc += W[nb * nBones + b];
        tmp[base + b] = W[base + b] * (1 - lambda) + (acc / n) * lambda;
      }
    }
    for (const [r] of adjSet) {
      const base = r * nBones;
      for (let b = 0; b < nBones; b++) W[base + b] = tmp[base + b];
    }
  }
  // Broadcast representative rows back to their duplicates (watertight seams).
  for (let v = 0; v < count; v++) {
    const r = repOf[v];
    if (r === v) continue;
    for (let b = 0; b < nBones; b++) W[v * nBones + b] = W[r * nBones + b];
  }
}

// ── Main: rig a skinless GLB ─────────────────────────────────────────────────
/**
 * @param {Buffer|Uint8Array} buffer skinless GLB
 * @param {{ joints?: Record<string, [number,number,number]> }} options
 *        joints: world-space override for any of the Mixamo joint names.
 * @returns {Promise<Uint8Array>} rigged GLB
 */
// ── L/R symmetrization of upright guesses ────────────────────────────────────
// Slicing guesses inherit mesh asymmetries (hair, cloth, a held prop) that
// leave one shoulder lower or one leg wider than the other. Bind skeletons are
// symmetric, so mirror-average every Left/Right pair across the body midline.
// Only valid for upright slicing guesses: topology guesses follow genuinely
// asymmetric poses (crouch, run) where averaging would be wrong, and
// user-provided marker positions are never touched.
function symmetrizeGuess(joints) {
  const pairs = [];
  for (const name of Object.keys(joints)) {
    if (!name.startsWith('Left')) continue;
    const twin = 'Right' + name.slice(4);
    if (joints[twin]) pairs.push([name, twin]);
  }
  if (!pairs.length) return;
  let mid = 0;
  for (const [l, r] of pairs) mid += (joints[l][0] + joints[r][0]) / 2;
  mid /= pairs.length;
  for (const [l, r] of pairs) {
    const L = joints[l], R = joints[r];
    const span = (L[0] - R[0]) / 2; // signed: preserves which label sits on which side
    const y = (L[1] + R[1]) / 2, z = (L[2] + R[2]) / 2;
    L[0] = mid + span; R[0] = mid - span;
    L[1] = y; R[1] = y;
    L[2] = z; R[2] = z;
  }
}

// ── Optional forearm twist bones ─────────────────────────────────────────────
// Returns a layout copy with Left/RightForeArmTwist appended (parents are the
// forearms, so parent-before-child ordering holds) and writes their positions
// into `joints` at TWIST_FRACTION along the final ForeArm→Hand span.
function addTwistBones(layout, joints) {
  const hierarchy = { ...layout.hierarchy, ...TWIST_HIERARCHY };
  for (const side of ['Left', 'Right']) {
    const a = joints[`${side}ForeArm`], b = joints[`${side}Hand`];
    joints[`${side}ForeArmTwist`] = [
      a[0] + (b[0] - a[0]) * TWIST_FRACTION,
      a[1] + (b[1] - a[1]) * TWIST_FRACTION,
      a[2] + (b[2] - a[2]) * TWIST_FRACTION,
    ];
  }
  const order = Object.keys(hierarchy);
  const isFinger = (n) => /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[123]$/.test(n);
  return { ...layout, hierarchy, order, bodyOrder: order.filter(n => !isFinger(n)) };
}

// ── Geodesic bone distances (voxel BFS) ──────────────────────────────────────
// Euclidean point→segment distance leaks across gaps the surface never
// bridges: closed thighs pull each other, a relaxed hand pulls the hip, a
// cross-body arm pulls the chest. Distance measured THROUGH the solid body
// (BFS from each bone's voxels over the voxelized interior) cannot take those
// shortcuts. Weighting uses max(euclidean, geodesic): near the bone both
// agree; across an air gap the geodesic explodes and the influence dies.
// Returns Map(prim → Float32Array(count·nB)) with 0 = "no data, use euclidean"
// (vertex outside the voxel shell or in a disconnected component).
function buildGeodesicDistances(doc, bounds, bodyMeshes, bakedMeshes, segList) {
  let vox = null;
  try {
    // Positions are already baked to world and node transforms neutralized,
    // so voxelize with no extra skin transforms.
    vox = voxelizeSolid(doc, new Map(), bounds, 96, bodyMeshes);
  } catch (e) {
    console.warn('[autorig] Voxelization for geodesic weights failed:', e.message);
  }
  if (!vox) return null;
  const { grid, nx, ny, nz, origin, cell, idxOf } = vox;

  const nearestSolid = (p, maxR) => {
    const cx = Math.floor((p[0] - origin[0]) / cell);
    const cy = Math.floor((p[1] - origin[1]) / cell);
    const cz = Math.floor((p[2] - origin[2]) / cell);
    for (let r = 0; r <= maxR; r++) {
      let best = -1, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue; // shell only
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        const i = idxOf(x, y, z);
        if (grid[i] !== 1) continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) return best;
    }
    return -1;
  };

  // Per-vertex voxel snap (surface verts sit on the shell; r≤2 covers the rest)
  const prims = [];
  const geoPerPrim = new Map();
  let mapped = 0, totalVerts = 0;
  for (const mesh of bakedMeshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      const count = arr.length / 3;
      const vidx = new Int32Array(count).fill(-1);
      for (let v = 0; v < count; v++) {
        vidx[v] = nearestSolid([arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]], 2);
        if (vidx[v] >= 0) mapped++;
      }
      totalVerts += count;
      prims.push({ prim, count, vidx });
      geoPerPrim.set(prim, new Float32Array(count * segList.length)); // 0 = no data
    }
  }
  if (totalVerts === 0 || mapped / totalVerts < 0.5) {
    console.warn('[autorig] Geodesic weights disabled: voxel coverage too low.');
    return null;
  }

  const segmentSeeds = ([a, b]) => {
    const seeds = new Set();
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const i = nearestSolid([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], 3);
      if (i >= 0) seeds.add(i);
    }
    return [...seeds];
  };

  const nB = segList.length;
  for (let b = 0; b < nB; b++) {
    const seeds = segmentSeeds(segList[b]);
    if (!seeds.length) continue;
    const { dist } = voxelBFS(vox, seeds);
    for (const { prim, count, vidx } of prims) {
      const geo = geoPerPrim.get(prim);
      for (let v = 0; v < count; v++) {
        const gi = vidx[v];
        if (gi >= 0 && dist[gi] >= 0) geo[v * nB + b] = dist[gi] * cell;
      }
    }
  }
  console.log(`[autorig] Geodesic weight fields ready (${(100 * mapped / totalVerts).toFixed(0)}% voxel coverage).`);
  return geoPerPrim;
}

// ── Rigid props (glasses, weapons, hats, backpacks) ──────────────────────────
// Non-body meshes are excluded from skinning, which used to leave them frozen
// in world space while the body animates away. Small props close to a bone are
// re-parented under that joint node (world transform preserved via
// local' = inv(jointBindWorld)·world), so they follow the skeleton rigidly.
// Large or distant meshes (ground, backdrop, light gizmos) stay untouched.
function attachRigidProps(doc, bodyMeshes, jointNodes, segNames, segList, joints, H, flip) {
  if (!bodyMeshes) return 0; // single-mesh character: nothing was excluded
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const jointNodeSet = new Set(jointNodes.values());
  const hasBodyDescendant = (n) => n.listChildren().some(c =>
    (c.getMesh() && bodyMeshes.has(c.getMesh())) || hasBodyDescendant(c));
  let attached = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || bodyMeshes.has(mesh) || jointNodeSet.has(node)) continue;
    if (hasBodyDescendant(node)) continue; // don't drag body geometry along
    const world = worldMatrixOf(node, parentMap, cache);
    const min = [1 / 0, 1 / 0, 1 / 0], max = [-1 / 0, -1 / 0, -1 / 0];
    for (const prim of mesh.listPrimitives()) {
      const arr = prim.getAttribute('POSITION')?.getArray();
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3) {
        const p = transformPoint(world, [arr[i], arr[i + 1], arr[i + 2]]);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
    if (!Number.isFinite(min[0])) continue;
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    if (diag > 0.6 * H) continue; // too big to be a wearable prop
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let bestName = null, bestD = Infinity;
    for (let b = 0; b < segList.length; b++) {
      const d = distPointSegment(center, segList[b][0], segList[b][1]);
      if (d < bestD) { bestD = d; bestName = segNames[b]; }
    }
    if (!bestName || bestD > 0.35 * H) continue; // detached scenery
    const jointNode = jointNodes.get(bestName);
    if (!jointNode) continue;
    const [px, py, pz] = joints[bestName];
    const bind = MAT4_IDENTITY.slice();
    if (flip) { bind[0] = -1; bind[10] = -1; }
    bind[12] = px; bind[13] = py; bind[14] = pz;
    jointNode.addChild(node);
    node.setMatrix(Array.from(mat4Mul(invertRigidMat4(bind), world)));
    attached++;
    console.log(`[autorig] Rigid prop "${mesh.getName() || node.getName() || 'mesh'}" attached to ${bestName} (d=${(bestD / H).toFixed(2)}·H).`);
  }
  return attached;
}

export async function autoRigGLB(buffer, options = {}) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));
  const root = doc.getRoot();
  const presetId = options.skeletonPreset || 'mixamo';
  const preset = resolveSkeletonPreset(presetId);
  const layout = buildRigLayout(options);

  // Already rigged → ADJUST the existing skeleton instead of rebuilding it.
  // Keeps hierarchy, bind orientations, extra bones (fingers/twist) and the
  // original artist skin weights; only joint positions move to the markers.
  // With options.rebuild the old rig is stripped (destructive) and a brand-new
  // skeleton with the requested layout is generated instead.
  let previouslySkinned = new Map(); // mesh → skin-space→world xform (rebuilt rigs)
  if (root.listSkins().length > 0) {
    if (options.rebuild === true) {
      previouslySkinned = skinWorldXforms(doc);
      stripExistingRig(doc);
      console.log('[autorig] Existing rig stripped — rebuilding skeleton with the requested layout.');
    } else {
      validateJointLayout(options.joints || {}, 1, { partial: true });
      adjustExistingRig(doc, options.joints || {});
      await doc.transform(prune({ keepLeaves: true }));
      return io.writeBinary(doc);
    }
  }

  const bodyMeshes = selectBodyMeshes(doc, previouslySkinned);
  const bounds = computeWorldBounds(doc, previouslySkinned, bodyMeshes);
  const forwardZ = detectForwardZ(doc, bounds, previouslySkinned, bodyMeshes);
  const guess = guessJointsAuto(doc, previouslySkinned, bounds, forwardZ, bodyMeshes, layout.bodyPlan);
  // Upright slicing guesses get mirror-averaged L/R (mesh asymmetries like hair
  // or a held prop must not skew the bind skeleton). User markers override later.
  if (guess.method === 'slicing' && options.symmetrize !== false) symmetrizeGuess(guess.joints);
  addFingerJoints(guess.joints, guess.height, forwardZ, guess.fingerTips, layout.fingers);
  if (layout.bodyPlan === 'quadruped') addTailJoints(guess.joints, guess.height);
  validateJointLayout(options.joints || {}, guess.height, { partial: true });
  const joints = { ...guess.joints, ...(options.joints || {}) };
  for (const name of Object.keys(joints)) {
    if (!layout.order.includes(name)) delete joints[name];
  }
  const H = guess.height;
  // Optional forearm twist bones (humanoid only): positions derive from the
  // FINAL forearm/hand placement (markers included), never from raw guesses.
  const rigLayout = (options.twistBones === true && layout.bodyPlan === 'humanoid')
    ? addTwistBones(layout, joints)
    : layout;
  validateJointLayout(joints, H, { layout: rigLayout });

  // ── Left/Right label correction ────────────────────────────────────────────
  // Anatomical left = up × forward. Facing +Z → left at +X; facing -Z → left at
  // -X. If the "Left*" joints sit on the wrong side for the detected facing,
  // animations retarget mirrored and the arms cross — swap the labels (positions
  // stay, names trade places). Forward comes from the toe markers (user-placed),
  // falling back to the mesh heuristic.
  const toeFwd = ((joints.LeftToeBase[2] - joints.LeftFoot[2]) +
    (joints.RightToeBase[2] - joints.RightFoot[2])) / 2;
  const fwdSign = toeFwd !== 0 ? Math.sign(toeFwd) : forwardZ;
  const leftSide = Math.sign(joints.LeftArm[0] - joints.RightArm[0]) || 1;
  // Topology guesses assign Left/Right from the detected body frame — the
  // toe-direction heuristic is meaningless in arbitrary poses, skip the swap.
  // Quadruped bounds layouts already place Left/Right from forwardZ.
  if (guess.method !== 'topology' && guess.method !== 'quadruped-bounds' && leftSide !== fwdSign) {
    for (const name of Object.keys(joints)) {
      if (!name.startsWith('Left')) continue;
      const twin = 'Right' + name.slice(4);
      if (joints[twin]) {
        const tmp = joints[name];
        joints[name] = joints[twin];
        joints[twin] = tmp;
      }
    }
    console.log('[autorig] Character faces -Z relative to marker layout — swapped Left/Right joint labels.');
  }

  // ── 1. Bake node world transforms into vertex data ────────────────────────
  // Skinned vertices live in skin space (the mesh node transform is ignored per
  // glTF spec), so positions must be expressed in the same world space as the
  // joints before weights are assigned.
  const parentMap = buildParentMap(doc);
  const matCache = new Map();
  const bakedMeshes = new Set();
  const meshNodes = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    // Non-body meshes (ground, props, lights) stay static: no bake, no skin
    if (bodyMeshes && !bodyMeshes.has(mesh)) continue;
    meshNodes.push(node);
    if (bakedMeshes.has(mesh)) continue; // shared mesh: bake once with first node's matrix
    bakedMeshes.add(mesh);
    // Previously-skinned meshes (rebuild) live in skin space: bake S (skin →
    // render world). Identity for glTF-native rigs, a real rotation/scale for
    // FBX-sourced exports that keep vertices Z-up under an armature fix.
    const world = previouslySkinned.get(mesh) || worldMatrixOf(node, parentMap, matCache);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos) {
        const arr = pos.getArray().slice();
        for (let i = 0; i < arr.length; i += 3) {
          const p = transformPoint(world, [arr[i], arr[i + 1], arr[i + 2]]);
          arr[i] = p[0]; arr[i + 1] = p[1]; arr[i + 2] = p[2];
        }
        pos.setArray(arr);
      }
      const nrm = prim.getAttribute('NORMAL');
      if (nrm) {
        const arr = nrm.getArray().slice();
        for (let i = 0; i < arr.length; i += 3) {
          const d = transformDirection(world, [arr[i], arr[i + 1], arr[i + 2]]);
          arr[i] = d[0]; arr[i + 1] = d[1]; arr[i + 2] = d[2];
        }
        nrm.setArray(arr);
      }
    }
  }
  // Neutralize mesh node transforms (positions are now world-space)
  for (const node of meshNodes) {
    node.setTranslation([0, 0, 0]);
    node.setRotation([0, 0, 0, 1]);
    node.setScale([1, 1, 1]);
  }

  // ── 2. Build joint node hierarchy ──────────────────────────────────────────
  // Bind orientation must encode the character's facing: retargeting computes
  // C = inv(Wchar_bind)·Wanim_bind, and animation rigs (Mixamo) face +Z. If the
  // mesh faces -Z and we bind with identity rotations, every animation lands
  // 180° off the body (crossed arms, twisted limbs). So for -Z characters the
  // whole skeleton binds with a 180° Y rotation (on the root; children inherit).
  const flip = fwdSign === -1;
  const glbBuffer = root.listBuffers()[0] || doc.createBuffer();
  const jointNodes = new Map();
  for (const name of rigLayout.order) {
    const parentName = rigLayout.hierarchy[name];
    const world = joints[name];
    let localT;
    if (parentName) {
      const p = joints[parentName];
      const d = [world[0] - p[0], world[1] - p[1], world[2] - p[2]];
      // Parent world rotation is R180y when flipped: local = R180⁻¹ · Δworld
      localT = flip ? [-d[0], d[1], -d[2]] : d;
    } else {
      localT = world.slice();
    }
    const node = doc.createNode(exportedJointName(presetId, preset, name)).setTranslation(localT);
    if (!parentName && flip) node.setRotation([0, 1, 0, 0]); // 180° about Y
    jointNodes.set(name, node);
    if (parentName) jointNodes.get(parentName).addChild(node);
  }
  const scene = root.getDefaultScene() || root.listScenes()[0];
  scene.addChild(jointNodes.get('Hips'));

  // ── 3. Inverse bind matrices ───────────────────────────────────────────────
  // W_bind = T(p)·R, with R = identity or R180y. IBM = inv(W_bind) = R⁻¹·T(-p).
  const ibmData = new Float32Array(rigLayout.order.length * 16);
  rigLayout.order.forEach((name, i) => {
    const [px, py, pz] = joints[name];
    const m = MAT4_IDENTITY.slice();
    if (flip) {
      m[0] = -1; m[10] = -1;             // diag(-1, 1, -1) = R180y
      m[12] = px; m[13] = -py; m[14] = pz; // -R180y·p
    } else {
      m[12] = -px; m[13] = -py; m[14] = -pz;
    }
    ibmData.set(m, i * 16);
  });
  const ibmAcc = doc.createAccessor('autorig_ibm')
    .setType('MAT4')
    .setArray(ibmData)
    .setBuffer(glbBuffer);

  const skin = doc.createSkin(`AutoRigSkin_${options.skeletonPreset || 'mixamo'}`).setInverseBindMatrices(ibmAcc);
  rigLayout.order.forEach(name => skin.addJoint(jointNodes.get(name)));
  skin.setSkeleton(jointNodes.get('Hips'));

  // ── 4. Proximity skin weights ──────────────────────────────────────────────
  // Distance to bone segment, d^-4 falloff, top-4, with two hardening rules:
  //  a) relative cutoff: drop bones farther than 2.2× the nearest bone — a 4th
  //     influence at 2× distance still gets ~6% weight, which visibly drags
  //     vertices in extreme poses (punch cross, sitting, roll).
  //  b) side gate: Left*/Right* limb bones cannot influence vertices clearly on
  //     the opposite side of the body midline (inner thighs / cross-body bleed),
  //     with a small blend zone around the centerline.
  const segments = boneSegments(joints, H);
  // Finger markers/bones are always available, but guessed finger chains must
  // never deform a hand automatically. Finger weighting is explicit opt-in
  // after the user has verified their placement.
  const weightedJointOrder = options.skinFingers === true ? rigLayout.order : rigLayout.bodyOrder;
  const segList = weightedJointOrder.map(name => {
    if (!segments[name]) throw new Error(`Missing weight segment for joint "${name}".`);
    return segments[name];
  });
  const boneSide = weightedJointOrder.map(name =>
    name.startsWith('Left') ? 1 : name.startsWith('Right') ? -1 : 0);

  // Anatomical "left" axis (positive side of the body). Upright +Z facing →
  // left = +X; the Arm markers give it directly and survive any baked mirror.
  const leftAxisRaw = [
    joints.LeftArm[0] - joints.RightArm[0],
    joints.LeftArm[1] - joints.RightArm[1],
    joints.LeftArm[2] - joints.RightArm[2],
  ];
  const leftAxis = vec3Normalize(leftAxisRaw);
  const leftAxisValid = vec3Length(leftAxisRaw) > 1e-4;

  // Per-height body centerline: the central skeleton chain sampled by Y, so the
  // side gate follows a leaning/seated torso instead of a fixed vertical plane
  // at Hips[0]. Y-sorted; feet seed the low end so legs gate correctly.
  const spineSamples = [
    [joints.LeftFoot[1], [(joints.LeftFoot[0] + joints.RightFoot[0]) / 2, joints.LeftFoot[1], (joints.LeftFoot[2] + joints.RightFoot[2]) / 2]],
    [joints.Hips[1], joints.Hips],
    [joints.Spine[1], joints.Spine],
    [joints.Spine1[1], joints.Spine1],
    [joints.Spine2[1], joints.Spine2],
    [joints.Neck[1], joints.Neck],
    [joints.Head[1], joints.Head],
  ].sort((a, b) => a[0] - b[0]);
  const centerAtY = (y) => {
    if (y <= spineSamples[0][0]) return spineSamples[0][1];
    const last = spineSamples[spineSamples.length - 1];
    if (y >= last[0]) return last[1];
    for (let i = 1; i < spineSamples.length; i++) {
      if (y <= spineSamples[i][0]) {
        const [y0, c0] = spineSamples[i - 1], [y1, c1] = spineSamples[i];
        const t = (y - y0) / Math.max(y1 - y0, 1e-6);
        return [c0[0] + (c1[0] - c0[0]) * t, y, c0[2] + (c1[2] - c0[2]) * t];
      }
    }
    return last[1];
  };

  const sideMargin = 0.02 * H;       // soft blend half-width around the midline
  const eps = (0.01 * H) ** 2;
  const CUTOFF = 2.2;
  const nB = segList.length;

  // Geodesic distance fields: kill influences that would have to jump through
  // air (closed thighs, hand-near-hip, cross-body arms). 0 entries fall back
  // to plain euclidean distance.
  const geoPerPrim = options.geodesicWeights !== false
    ? buildGeodesicDistances(doc, bounds, bodyMeshes, bakedMeshes, segList)
    : null;

  // Quality report accumulators (see reportSink below)
  let qaVerts = 0, qaCross = 0, qaDistant = 0;

  for (const mesh of bakedMeshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      const count = arr.length / 3;
      const indices = prim.getIndices()?.getArray() || null;

      // Dense per-vertex weight field (count × nB), built from proximity with a
      // SOFT side gate, then Laplacian-smoothed across the mesh graph, then
      // reduced to the glTF 4-influence limit.
      const field = new Float32Array(count * nB);
      const dists = new Float32Array(nB);
      const geoArr = geoPerPrim ? geoPerPrim.get(prim) : null;

      for (let v = 0; v < count; v++) {
        const p = [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];
        const ctr = centerAtY(p[1]);
        // Signed distance from the midline along the anatomical left axis.
        const sd = leftAxisValid
          ? (p[0] - ctr[0]) * leftAxis[0] + (p[1] - ctr[1]) * leftAxis[1] + (p[2] - ctr[2]) * leftAxis[2]
          : p[0] - ctr[0];

        let dMin = Infinity;
        for (let b = 0; b < nB; b++) {
          let d = distPointSegment(p, segList[b][0], segList[b][1]);
          // max(euclid, geodesic): near the bone the two agree; across an air
          // gap the geodesic explodes and the influence dies. 26-conn BFS
          // underestimates true length, so it can only ever REMOVE bad
          // influences, never starve a legitimate nearby bone.
          if (geoArr) {
            const g = geoArr[v * nB + b];
            if (g > d) d = g;
          }
          dists[b] = d;
          if (d < dMin) dMin = d;
        }
        const dMax = dMin * CUTOFF;

        let total = 0;
        const base = v * nB;
        for (let b = 0; b < nB; b++) {
          const d = dists[b];
          if (d > dMax) continue;
          let w = 1 / ((d * d + eps) * (d * d + eps));
          // Soft side gate: a Left bone fades out as the vertex crosses to the
          // right of the midline (and vice-versa) over a 2·sideMargin band, so
          // inner thighs / cross-body bleed vanish without a hard cut that the
          // smoothing pass would otherwise have to fight.
          const side = boneSide[b];
          if (side !== 0) {
            const signed = side * sd; // >0 = correct side
            const g = (signed + sideMargin) / (2 * sideMargin);
            const gate = g <= 0 ? 0 : g >= 1 ? 1 : g * g * (3 - 2 * g); // smoothstep
            w *= gate;
          }
          field[base + b] = w;
          total += w;
        }
        // Fallback: no bone survived the gate (vertex far off to one side) →
        // assign full weight to the unconditionally nearest bone, gate ignored.
        if (total <= 0) {
          let nb = 0, nd = Infinity;
          for (let b = 0; b < nB; b++) if (dists[b] < nd) { nd = dists[b]; nb = b; }
          field[base + nb] = 1;
        }
      }

      // ── Laplacian weight smoothing (crease-free joints) ────────────────────
      const weldEps = 1e-4 * H;
      const adjacency = buildVertexAdjacency(arr, indices, weldEps);
      smoothWeightField(field, nB, adjacency, 5, 0.6);

      // ── Reduce to top-4 influences + normalize ─────────────────────────────
      const jointsOut = new Uint8Array(count * 4);
      const weightsOut = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        const base = v * nB;
        const best = [[-1, 0], [-1, 0], [-1, 0], [-1, 0]];
        for (let b = 0; b < nB; b++) {
          const w = field[base + b];
          if (w <= 0) continue;
          for (let k = 0; k < 4; k++) {
            if (w > best[k][1]) { best.splice(k, 0, [b, w]); best.pop(); break; }
          }
        }
        let total = 0;
        for (const [bi, w] of best) if (bi >= 0) total += w;
        for (let k = 0; k < 4; k++) {
          const [b, w] = best[k];
          jointsOut[v * 4 + k] = b >= 0 ? b : 0;
          weightsOut[v * 4 + k] = total > 0 && b >= 0 ? w / total : (k === 0 ? 1 : 0);
        }

        // ── Quality metrics on the FINAL influences ──────────────────────────
        // cross-side: meaningful weight from an opposite-side limb bone while
        // the vertex is clearly off the midline (smoothing can reintroduce it).
        // distant: meaningful weight from a bone far away in euclidean terms —
        // the classic "hip vertex follows the hand" defect.
        qaVerts++;
        const p = [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];
        const ctr = centerAtY(p[1]);
        const sd = leftAxisValid
          ? (p[0] - ctr[0]) * leftAxis[0] + (p[1] - ctr[1]) * leftAxis[1] + (p[2] - ctr[2]) * leftAxis[2]
          : p[0] - ctr[0];
        let wrongSide = 0, distant = false;
        for (let k = 0; k < 4; k++) {
          const b = jointsOut[v * 4 + k], w = weightsOut[v * 4 + k];
          if (w <= 0.05) continue;
          if (Math.abs(sd) > 0.06 * H && boneSide[b] !== 0 && boneSide[b] * sd < 0) wrongSide += w;
          if (w > 0.15 && distPointSegment(p, segList[b][0], segList[b][1]) > 0.35 * H) distant = true;
        }
        if (wrongSide > 0.10) qaCross++;
        if (distant) qaDistant++;
      }

      prim.setAttribute('JOINTS_0', doc.createAccessor()
        .setType('VEC4').setArray(jointsOut).setBuffer(glbBuffer));
      prim.setAttribute('WEIGHTS_0', doc.createAccessor()
        .setType('VEC4').setArray(weightsOut).setBuffer(glbBuffer));
    }
  }

  for (const node of meshNodes) node.setSkin(skin);

  // Re-parent small nearby props (glasses, weapons, hats) under their nearest
  // joint so they follow the animation instead of freezing in world space.
  const propsAttached = options.attachProps !== false
    ? attachRigidProps(doc, bodyMeshes, jointNodes, weightedJointOrder, segList, joints, H, flip)
    : 0;

  // ── Skinning quality report ────────────────────────────────────────────────
  // Heuristic score from the final influences; surfaced by the server as the
  // X-Autorig-Report header and rendered in the builder's skeleton health panel.
  {
    const crossPct = qaVerts ? qaCross / qaVerts : 0;
    const distantPct = qaVerts ? qaDistant / qaVerts : 0;
    const score = Math.max(0, Math.round(100 * (1 - Math.min(1, 3 * crossPct + 4 * distantPct))));
    const notes = [];
    if (crossPct > 0.01) notes.push(`${(crossPct * 100).toFixed(1)}% of vertices carry cross-side limb weight.`);
    if (distantPct > 0.01) notes.push(`${(distantPct * 100).toFixed(1)}% of vertices are influenced by a distant bone.`);
    if (!geoPerPrim && options.geodesicWeights !== false) notes.push('Geodesic weighting unavailable (voxelization failed) — euclidean fallback used.');
    if (propsAttached > 0) notes.push(`${propsAttached} prop mesh(es) rigidly attached to the skeleton.`);
    const report = {
      score,
      vertices: qaVerts,
      crossSidePct: +(crossPct * 100).toFixed(2),
      distantInfluencePct: +(distantPct * 100).toFixed(2),
      geodesicWeights: !!geoPerPrim,
      symmetrized: guess.method === 'slicing' && options.symmetrize !== false,
      twistBones: rigLayout !== layout,
      propsAttached,
      guessMethod: guess.method,
      notes,
    };
    console.log(`[autorig] Skin quality score: ${score}/100` + (notes.length ? ` — ${notes.join(' ')}` : ''));
    if (options.reportSink && typeof options.reportSink === 'object') Object.assign(options.reportSink, report);
  }

  await doc.transform(prune({ keepLeaves: true }));
  // Draco-compressed sources (rebuild path): re-encoding on write quantizes the
  // fresh JOINTS/WEIGHTS accessors and drifts the weight normalization. Drop
  // the extension — output is written uncompressed, exactly like merge_api.
  const dracoExt = root.listExtensionsUsed().find(ext => ext.extensionName === 'KHR_draco_mesh_compression');
  if (dracoExt) {
    console.log('[autorig] Disposing KHR_draco_mesh_compression extension (uncompressed output).');
    dracoExt.dispose();
  }
  return io.writeBinary(doc);
}
