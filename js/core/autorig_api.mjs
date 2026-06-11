/**
 * autorig_api.mjs
 *
 * Auto-rigging for skinless GLB meshes.
 *  - guessJoints(buffer): analyze mesh bounds and propose Mixamo-style joint positions.
 *  - autoRigGLB(buffer, { joints }): build a Mixamo-named humanoid skeleton at the given
 *    joint positions, compute proximity-based skin weights, and return a rigged GLB.
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
  const keep = new Set();
  for (const e of entries) {
    const cx = (e.min[0] + e.max[0]) / 2, cy = (e.min[1] + e.max[1]) / 2, cz = (e.min[2] + e.max[2]) / 2;
    const inside =
      cx > main.min[0] - m && cx < main.max[0] + m &&
      cy > main.min[1] - m && cy < main.max[1] + m &&
      cz > main.min[2] - m && cz < main.max[2] + m;
    if (e === main || (inside && e.footprint <= 2.5 * main.footprint)) keep.add(e.mesh);
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
  const H = max[1] - min[1];
  const cz = (min[2] + max[2]) / 2;
  const footY = min[1] + 0.12 * H;
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  let sum = 0, count = 0;

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
        if (p[1] <= footY) { sum += p[2] - cz; count++; }
      }
    }
  }
  if (count === 0) return 1;
  return sum / count >= 0 ? 1 : -1;
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

    LeftShoulder: J(0.10 * halfW, shoulderY, 0),
    LeftArm: J(0.24 * halfW, shoulderY, 0),
    LeftForeArm: J(0.58 * halfW, shoulderY, 0),
    LeftHand: J(0.88 * halfW, shoulderY, 0),

    RightShoulder: J(-0.10 * halfW, shoulderY, 0),
    RightArm: J(-0.24 * halfW, shoulderY, 0),
    RightForeArm: J(-0.58 * halfW, shoulderY, 0),
    RightHand: J(-0.88 * halfW, shoulderY, 0),

    LeftUpLeg: J(0.06 * H, y(0.50), 0),
    LeftLeg: J(0.06 * H, y(0.27), 0),
    LeftFoot: J(0.06 * H, y(0.06), 0),
    LeftToeBase: J(0.06 * H, y(0.02), 0.10 * H * forwardZ),

    RightUpLeg: J(-0.06 * H, y(0.50), 0),
    RightLeg: J(-0.06 * H, y(0.27), 0),
    RightFoot: J(-0.06 * H, y(0.06), 0),
    RightToeBase: J(-0.06 * H, y(0.02), 0.10 * H * forwardZ),
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

  if (crotchY !== null) {
    const hipsY = Math.min(crotchY + 0.05 * H, groundY + 0.62 * H);
    const upLegY = Math.min(crotchY + 0.015 * H, hipsY - 0.02 * H);
    const ankleY = joints.LeftFoot[1];
    const kneeY = (upLegY + ankleY) / 2;

    // Per-leg X offset measured halfway down the legs
    const midLegBin = bins[Math.max(0, Math.floor(((crotchY - groundY) / H) * BINS * 0.5))];
    let legDX = 0.06 * H;
    if (midLegBin && midLegBin.left.length >= 3 && midLegBin.right.length >= 3) {
      const l = median(midLegBin.left), r = median(midLegBin.right);
      const m = (l + r) / 2;
      if (Number.isFinite(m)) legDX = Math.min(Math.max(m, 0.03 * H), 0.15 * H);
    }

    for (const [side, sgn] of [['Left', 1], ['Right', -1]]) {
      joints[side + 'UpLeg'] = [cx + sgn * legDX, upLegY, cz];
      joints[side + 'Leg'] = [cx + sgn * legDX, kneeY, cz];
      joints[side + 'Foot'] = [cx + sgn * legDX, ankleY, cz];
      joints[side + 'ToeBase'] = [cx + sgn * legDX, joints[side + 'ToeBase'][1], cz + 0.10 * H * forwardZ];
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
        const shoulder = [cx + sgn * 0.4 * tw, shoulderY, cz];
        const arm = [cx + sgn * tw, shoulderY, cz];
        const hand = [cx + sgn * hx, hy, hz];
        const fore = [(arm[0] + hand[0]) / 2, (arm[1] + hand[1]) / 2, (arm[2] + hand[2]) / 2];
        joints[side + 'Shoulder'] = shoulder;
        joints[side + 'Arm'] = arm;
        joints[side + 'ForeArm'] = fore;
        joints[side + 'Hand'] = hand;
      }
    }
  }

  // ── Spine / neck / head anchored to measured hips & shoulders ─────────────
  const hipsY2 = joints.Hips[1];
  const neckY = Math.min(shoulderY + 0.05 * H, groundY + 0.90 * H);
  const spineZ = f => {
    const b = bins[Math.min(BINS - 1, Math.max(0, Math.floor(((f - groundY) / H) * BINS)))];
    return b && b.n >= 8 ? b.sumZ / b.n : cz; // follow hunched spines
  };
  const lerpY = t => hipsY2 + (neckY - hipsY2) * t;
  joints.Spine = [cx, lerpY(0.28), spineZ(lerpY(0.28))];
  joints.Spine1 = [cx, lerpY(0.55), spineZ(lerpY(0.55))];
  joints.Spine2 = [cx, lerpY(0.82), spineZ(lerpY(0.82))];
  joints.Neck = [cx, neckY, spineZ(neckY)];

  const headPts = verts.filter(p => yf(p) > 0.92);
  const headC = centroidOf(headPts);
  const headY = Math.min(neckY + 0.045 * H, groundY + 0.95 * H);
  joints.Head = [cx, headY, headC ? (headC[2] + cz) / 2 : cz];

  // Re-anchor shoulders to Spine2 height sanity (clavicles sit below the neck)
  for (const side of ['Left', 'Right']) {
    joints[side + 'Shoulder'][1] = Math.min(joints[side + 'Shoulder'][1], neckY - 0.01 * H);
  }

  // Quality flags: when these fail the mesh is likely NOT in an upright
  // T/A-pose and the caller should try the pose-independent topology pass.
  return { joints, height: H, bounds, flags: { crotch: crotchY !== null, arms: armsDetected } };
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
  let fwd = [0, 0, forwardZ];
  if (Math.abs(up[0] * fwd[0] + up[1] * fwd[1] + up[2] * fwd[2]) > 0.9) fwd = [0, 0, 1];
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

  return {
    joints, height: H, bounds, confidence, method: 'topology',
    debug: { extremities: picks.map(worldOf), headTip: worldOf(head.tip) },
  };
}

// Run BOTH detectors and cross-validate. The slicing pass is more precise but
// only valid for upright T/A-poses; the topology pass is pose-independent.
// They agree on standard poses — strong disagreement on hands/feet means the
// pose is non-standard and topology wins.
function guessJointsAuto(doc, skinXforms, bounds, forwardZ, bodyMeshes = null) {
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
      console.log(`[autorig] Detectors disagree (${(disagree * 100).toFixed(0)}% of height) — pose is non-standard, using topology skeleton.`);
      return topo;
    }
  }
  return sliced;
}

// ── Seed markers from an existing skeleton ───────────────────────────────────
// Aliases per canonical Mixamo joint, in normalized form (lowercase, no prefix,
// no separators, no trailing _N). Covers Mixamo/Unity/UE5/generic conventions.
const SEED_ALIASES = {
  Hips: ['hips', 'pelvis', 'hip'],
  Spine: ['spine', 'spine01', 'lowerback', 'waist'],
  Spine1: ['spine1', 'spine02', 'chest'],
  Spine2: ['spine2', 'spine03', 'upperchest'],
  Neck: ['neck', 'neck01', 'necktwist01', 'necktwist'],
  Head: ['head'],
  LeftShoulder: ['leftshoulder', 'claviclel', 'shoulderl', 'lclavicle', 'leftcollar', 'lshoulder', 'collarl'],
  LeftArm: ['leftarm', 'leftupperarm', 'upperarml', 'larm', 'lupperarm', 'arml'],
  LeftForeArm: ['leftforearm', 'leftlowerarm', 'lowerarml', 'forearml', 'lforearm'],
  LeftHand: ['lefthand', 'handl', 'lhand'],
  LeftUpLeg: ['leftupleg', 'leftupperleg', 'thighl', 'lthigh', 'upperlegl'],
  LeftLeg: ['leftleg', 'leftlowerleg', 'calfl', 'shinl', 'lcalf', 'lowerlegl'],
  LeftFoot: ['leftfoot', 'footl', 'lfoot'],
  LeftToeBase: ['lefttoebase', 'toel', 'toebasel', 'lefttoe', 'ltoebase', 'balll', 'lball', 'ltoe0', 'ltoe'],
  RightShoulder: ['rightshoulder', 'clavicler', 'shoulderr', 'rclavicle', 'rightcollar', 'rshoulder', 'collarr'],
  RightArm: ['rightarm', 'rightupperarm', 'upperarmr', 'rarm', 'rupperarm', 'armr'],
  RightForeArm: ['rightforearm', 'rightlowerarm', 'lowerarmr', 'forearmr', 'rforearm'],
  RightHand: ['righthand', 'handr', 'rhand'],
  RightUpLeg: ['rightupleg', 'rightupperleg', 'thighr', 'rthigh', 'upperlegr'],
  RightLeg: ['rightleg', 'rightlowerleg', 'calfr', 'shinr', 'rcalf', 'lowerlegr'],
  RightFoot: ['rightfoot', 'footr', 'rfoot'],
  RightToeBase: ['righttoebase', 'toer', 'toebaser', 'righttoe', 'rtoebase', 'ballr', 'rball', 'rtoe0', 'rtoe'],
};

function seedNorm(name) {
  if (!name) return '';
  let n = name.toLowerCase();
  if (n.includes(':')) n = n.split(':').pop();
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
  return seeded;
}

export async function guessJoints(buffer) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));
  const skinXf = skinWorldXforms(doc);
  const bodyMeshes = selectBodyMeshes(doc, skinXf);
  const bounds = computeWorldBounds(doc, skinXf, bodyMeshes);
  const fwd = detectForwardZ(doc, bounds, skinXf, bodyMeshes);
  const guess = guessJointsAuto(doc, skinXf, bounds, fwd, bodyMeshes);
  // Existing skeleton (re-rig): seed markers from current bind pose where names match
  if (doc.getRoot().listSkins().length > 0) {
    const seeded = seedJointsFromSkins(doc);
    guess.joints = { ...guess.joints, ...seeded };
    guess.reRig = true;
  }
  return guess;
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

  // Original bind world position per joint (from inverted IBMs) + pristine IBMs
  const origWorld = new Map();
  const skinData = [];
  for (const skin of root.listSkins()) {
    const joints = skin.listJoints();
    const acc = skin.getInverseBindMatrices();
    const arr = acc?.getArray();
    if (!arr) continue;
    skinData.push({ joints, acc, arr: Float32Array.from(arr) });
    joints.forEach((j, i) => {
      if (!origWorld.has(j)) {
        const W = invertRigidMat4(arr.slice(i * 16, i * 16 + 16));
        origWorld.set(j, [W[12], W[13], W[14]]);
      }
    });
  }
  if (origWorld.size === 0) throw new Error('Skin has no inverse bind matrices.');

  const jointSet = new Set(origWorld.keys());

  // Markers arrive in render-world space (same space guessJoints reports);
  // origWorld/IBMs live in skin space. S maps skin space → render world.
  const matCache0 = new Map();
  const S = mat4Mul(
    worldMatrixOf(skinData[0].joints[0], parentMap, matCache0),
    skinData[0].arr.slice(0, 16)
  );
  const invS = invertRigidMat4(S);

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

  const jointParentOf = (j) => {
    let p = parentMap.get(j);
    while (p && !jointSet.has(p)) p = parentMap.get(p);
    return p || null;
  };

  // New world positions: markers win; others keep their offset to the parent
  const newWorld = new Map();
  function computeNew(j) {
    if (newWorld.has(j)) return newWorld.get(j);
    const marker = markerByNode.get(j);
    if (marker) { newWorld.set(j, marker); return marker; }
    const p = jointParentOf(j);
    const o = origWorld.get(j);
    if (!p) { newWorld.set(j, o); return o; }
    const pNew = computeNew(p);
    const pOld = origWorld.get(p);
    const np = [o[0] + pNew[0] - pOld[0], o[1] + pNew[1] - pOld[1], o[2] + pNew[2] - pOld[2]];
    newWorld.set(j, np);
    return np;
  }
  for (const j of jointSet) computeNew(j);

  // Find a pristine IBM (linear part = world→local incl. rotation/scale) per joint
  const ibmByJoint = new Map();
  for (const { joints, arr } of skinData) {
    joints.forEach((j, i) => {
      if (!ibmByJoint.has(j)) ibmByJoint.set(j, arr.slice(i * 16, i * 16 + 16));
    });
  }

  // Update node local translations (rotations/scales untouched)
  const matCache = new Map();
  for (const j of jointSet) {
    const np = newWorld.get(j);
    const directParent = parentMap.get(j) || null;
    let local;
    if (directParent && jointSet.has(directParent)) {
      const M = ibmByJoint.get(directParent); // world → parent-local (rot+scale)
      const d = [np[0] - newWorld.get(directParent)[0], np[1] - newWorld.get(directParent)[1], np[2] - newWorld.get(directParent)[2]];
      local = [
        M[0] * d[0] + M[4] * d[1] + M[8] * d[2],
        M[1] * d[0] + M[5] * d[1] + M[9] * d[2],
        M[2] * d[0] + M[6] * d[1] + M[10] * d[2],
      ];
    } else if (directParent) {
      // np is skin-space; parent worlds are render-space → go through S
      const inv = invertRigidMat4(worldMatrixOf(directParent, parentMap, matCache));
      local = transformPoint(mat4Mul(inv, S), np);
    } else {
      local = transformPoint(S, np);
    }
    j.setTranslation(local);
  }

  // Update IBM translations: t = -(linear3x3 · newWorldPos); linear unchanged
  for (const { joints, acc, arr } of skinData) {
    const out = Float32Array.from(arr);
    joints.forEach((j, i) => {
      const np = newWorld.get(j);
      const o = i * 16;
      out[o + 12] = -(out[o] * np[0] + out[o + 4] * np[1] + out[o + 8] * np[2]);
      out[o + 13] = -(out[o + 1] * np[0] + out[o + 5] * np[1] + out[o + 9] * np[2]);
      out[o + 14] = -(out[o + 2] * np[0] + out[o + 6] * np[1] + out[o + 10] * np[2]);
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
const HIERARCHY = {
  Hips: null,
  Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};
const JOINT_ORDER = Object.keys(HIERARCHY);

// Weighting segment per bone: [start joint, end joint or offset fn]
function boneSegments(joints, H) {
  const seg = (a, b) => [joints[a], joints[b]];
  const ext = (a, off) => [joints[a], [joints[a][0] + off[0], joints[a][1] + off[1], joints[a][2] + off[2]]];
  const handDir = (arm, fore) => {
    const d = [joints[fore][0] - joints[arm][0], joints[fore][1] - joints[arm][1], joints[fore][2] - joints[arm][2]];
    const l = Math.hypot(...d) || 1;
    return [d[0] / l * 0.10 * H, d[1] / l * 0.10 * H, d[2] / l * 0.10 * H];
  };
  return {
    Hips: seg('Hips', 'Spine'),
    Spine: seg('Spine', 'Spine1'),
    Spine1: seg('Spine1', 'Spine2'),
    Spine2: seg('Spine2', 'Neck'),
    Neck: seg('Neck', 'Head'),
    Head: ext('Head', [0, 0.11 * H, 0]),
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

// ── Main: rig a skinless GLB ─────────────────────────────────────────────────
/**
 * @param {Buffer|Uint8Array} buffer skinless GLB
 * @param {{ joints?: Record<string, [number,number,number]> }} options
 *        joints: world-space override for any of the Mixamo joint names.
 * @returns {Promise<Uint8Array>} rigged GLB
 */
export async function autoRigGLB(buffer, options = {}) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));
  const root = doc.getRoot();

  // Already rigged → ADJUST the existing skeleton instead of rebuilding it.
  // Keeps hierarchy, bind orientations, extra bones (fingers/twist) and the
  // original artist skin weights; only joint positions move to the markers.
  if (root.listSkins().length > 0) {
    adjustExistingRig(doc, options.joints || {});
    await doc.transform(prune({ keepLeaves: true }));
    return io.writeBinary(doc);
  }
  const previouslySkinned = new Map(); // mesh → skin-space xform (none: file is unskinned here)

  const bodyMeshes = selectBodyMeshes(doc, previouslySkinned);
  const bounds = computeWorldBounds(doc, previouslySkinned, bodyMeshes);
  const forwardZ = detectForwardZ(doc, bounds, previouslySkinned, bodyMeshes);
  const guess = guessJointsAuto(doc, previouslySkinned, bounds, forwardZ, bodyMeshes);
  const joints = { ...guess.joints, ...(options.joints || {}) };
  const H = guess.height;

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
  if (guess.method !== 'topology' && leftSide !== fwdSign) {
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
    if (previouslySkinned.has(mesh)) continue; // already in skin/world space
    const world = worldMatrixOf(node, parentMap, matCache);
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
  for (const name of JOINT_ORDER) {
    const parentName = HIERARCHY[name];
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
    const node = doc.createNode(name).setTranslation(localT);
    if (!parentName && flip) node.setRotation([0, 1, 0, 0]); // 180° about Y
    jointNodes.set(name, node);
    if (parentName) jointNodes.get(parentName).addChild(node);
  }
  const scene = root.getDefaultScene() || root.listScenes()[0];
  scene.addChild(jointNodes.get('Hips'));

  // ── 3. Inverse bind matrices ───────────────────────────────────────────────
  // W_bind = T(p)·R, with R = identity or R180y. IBM = inv(W_bind) = R⁻¹·T(-p).
  const ibmData = new Float32Array(JOINT_ORDER.length * 16);
  JOINT_ORDER.forEach((name, i) => {
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

  const skin = doc.createSkin('AutoRigSkin').setInverseBindMatrices(ibmAcc);
  JOINT_ORDER.forEach(name => skin.addJoint(jointNodes.get(name)));
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
  const segList = JOINT_ORDER.map(name => segments[name]);
  const boneSide = JOINT_ORDER.map(name =>
    name.startsWith('Left') ? 1 : name.startsWith('Right') ? -1 : 0);
  const midX = joints.Hips[0];
  const sideMargin = 0.02 * H;
  const eps = (0.01 * H) ** 2;
  const CUTOFF = 2.2;

  for (const mesh of bakedMeshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      const count = arr.length / 3;
      const jointsOut = new Uint8Array(count * 4);
      const weightsOut = new Float32Array(count * 4);
      const dists = new Float32Array(segList.length);

      for (let v = 0; v < count; v++) {
        const p = [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];
        const dx = p[0] - midX;

        // Pass 1: distances (side-gated) + nearest
        let dMin = Infinity;
        for (let b = 0; b < segList.length; b++) {
          const side = boneSide[b];
          if ((side === 1 && dx < -sideMargin) || (side === -1 && dx > sideMargin)) {
            dists[b] = Infinity;
            continue;
          }
          const d = distPointSegment(p, segList[b][0], segList[b][1]);
          dists[b] = d;
          if (d < dMin) dMin = d;
        }

        // Pass 2: keep top 4 within relative cutoff
        const dMax = dMin * CUTOFF;
        const best = [[-1, 0], [-1, 0], [-1, 0], [-1, 0]];
        for (let b = 0; b < segList.length; b++) {
          const d = dists[b];
          if (d > dMax) continue;
          const w = 1 / ((d * d + eps) * (d * d + eps));
          for (let k = 0; k < 4; k++) {
            if (w > best[k][1]) {
              best.splice(k, 0, [b, w]);
              best.pop();
              break;
            }
          }
        }
        let total = 0;
        for (const [, w] of best) total += w;
        for (let k = 0; k < 4; k++) {
          const [b, w] = best[k];
          jointsOut[v * 4 + k] = b >= 0 ? b : 0;
          weightsOut[v * 4 + k] = total > 0 && b >= 0 ? w / total : (k === 0 ? 1 : 0);
        }
      }

      prim.setAttribute('JOINTS_0', doc.createAccessor()
        .setType('VEC4').setArray(jointsOut).setBuffer(glbBuffer));
      prim.setAttribute('WEIGHTS_0', doc.createAccessor()
        .setType('VEC4').setArray(weightsOut).setBuffer(glbBuffer));
    }
  }

  for (const node of meshNodes) node.setSkin(skin);

  await doc.transform(prune({ keepLeaves: true }));
  return io.writeBinary(doc);
}
