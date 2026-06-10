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

// ── Mesh bounds (world space) ────────────────────────────────────────────────
function computeWorldBounds(doc, identityMeshes = new Set()) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    // Skinned vertices live in skin space — the node chain does not apply
    const world = identityMeshes.has(mesh)
      ? MAT4_IDENTITY
      : worldMatrixOf(node, parentMap, cache);
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
function detectForwardZ(doc, { min, max }, identityMeshes = new Set()) {
  const H = max[1] - min[1];
  const cz = (min[2] + max[2]) / 2;
  const footY = min[1] + 0.12 * H;
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  let sum = 0, count = 0;

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = identityMeshes.has(mesh) ? MAT4_IDENTITY : worldMatrixOf(node, parentMap, cache);
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
function collectWorldVertices(doc, identityMeshes = new Set(), maxVerts = 200000) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  const pts = [];
  let total = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      total += (prim.getAttribute('POSITION')?.getCount()) || 0;
    }
  }
  const stride = Math.max(1, Math.ceil(total / maxVerts));
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = identityMeshes.has(mesh) ? MAT4_IDENTITY : worldMatrixOf(node, parentMap, cache);
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

  return { joints, height: H, bounds };
}

// ── Seed markers from an existing skeleton ───────────────────────────────────
// Aliases per canonical Mixamo joint, in normalized form (lowercase, no prefix,
// no separators, no trailing _N). Covers Mixamo/Unity/UE5/generic conventions.
const SEED_ALIASES = {
  Hips: ['hips', 'pelvis', 'hip'],
  Spine: ['spine', 'spine01', 'lowerback'],
  Spine1: ['spine1', 'spine02', 'chest'],
  Spine2: ['spine2', 'spine03', 'upperchest'],
  Neck: ['neck', 'neck01'],
  Head: ['head'],
  LeftShoulder: ['leftshoulder', 'claviclel', 'shoulderl', 'lclavicle', 'leftcollar'],
  LeftArm: ['leftarm', 'leftupperarm', 'upperarml', 'larm'],
  LeftForeArm: ['leftforearm', 'leftlowerarm', 'lowerarml', 'forearml'],
  LeftHand: ['lefthand', 'handl', 'lhand'],
  LeftUpLeg: ['leftupleg', 'leftupperleg', 'thighl', 'lthigh'],
  LeftLeg: ['leftleg', 'leftlowerleg', 'calfl', 'shinl', 'lcalf'],
  LeftFoot: ['leftfoot', 'footl', 'lfoot'],
  LeftToeBase: ['lefttoebase', 'toel', 'toebasel', 'lefttoe'],
  RightShoulder: ['rightshoulder', 'clavicler', 'shoulderr', 'rclavicle', 'rightcollar'],
  RightArm: ['rightarm', 'rightupperarm', 'upperarmr', 'rarm'],
  RightForeArm: ['rightforearm', 'rightlowerarm', 'lowerarmr', 'forearmr'],
  RightHand: ['righthand', 'handr', 'rhand'],
  RightUpLeg: ['rightupleg', 'rightupperleg', 'thighr', 'rthigh'],
  RightLeg: ['rightleg', 'rightlowerleg', 'calfr', 'shinr', 'rcalf'],
  RightFoot: ['rightfoot', 'footr', 'rfoot'],
  RightToeBase: ['righttoebase', 'toer', 'toebaser', 'righttoe'],
};

function seedNorm(name) {
  if (!name) return '';
  let n = name.toLowerCase();
  if (n.includes(':')) n = n.split(':').pop();
  n = n.replace(/^mixamorig\d*/, '');
  n = n.replace(/_\d+$/, '');
  return n.replace(/[:_\-\.\s]/g, '');
}

/**
 * World bind position per existing skin joint (from inverted IBMs), matched to
 * canonical Mixamo joint names. Used to pre-place markers when re-rigging.
 */
function seedJointsFromSkins(doc) {
  const worldByNorm = new Map();
  for (const skin of doc.getRoot().listSkins()) {
    const joints = skin.listJoints();
    const ibmAcc = skin.getInverseBindMatrices();
    const ibmArray = ibmAcc?.getArray();
    if (!ibmArray) continue;
    joints.forEach((joint, i) => {
      if (i * 16 + 16 > ibmArray.length) return;
      const W = invertRigidMat4(ibmArray.slice(i * 16, i * 16 + 16));
      const n = seedNorm(joint.getName());
      if (n && !worldByNorm.has(n)) worldByNorm.set(n, [W[12], W[13], W[14]]);
    });
  }
  const seeded = {};
  for (const [canon, aliases] of Object.entries(SEED_ALIASES)) {
    for (const a of aliases) {
      if (worldByNorm.has(a)) { seeded[canon] = worldByNorm.get(a); break; }
    }
  }
  return seeded;
}

export async function guessJoints(buffer) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));
  const skinnedMeshes = new Set();
  for (const node of doc.getRoot().listNodes()) {
    if (node.getSkin() && node.getMesh()) skinnedMeshes.add(node.getMesh());
  }
  const bounds = computeWorldBounds(doc, skinnedMeshes);
  const fwd = detectForwardZ(doc, bounds, skinnedMeshes);
  const verts = collectWorldVertices(doc, skinnedMeshes);
  const guess = guessJointsFromMesh(verts, bounds, fwd);
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

  // canonical marker name → joint node
  const normToNode = new Map();
  for (const j of jointSet) {
    const n = seedNorm(j.getName());
    if (n && !normToNode.has(n)) normToNode.set(n, j);
  }
  const markerByNode = new Map();
  for (const [canon, aliases] of Object.entries(SEED_ALIASES)) {
    if (!targetJoints[canon]) continue;
    for (const a of aliases) {
      if (normToNode.has(a)) { markerByNode.set(normToNode.get(a), targetJoints[canon]); break; }
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
      const inv = invertRigidMat4(worldMatrixOf(directParent, parentMap, matCache));
      local = transformPoint(inv, np);
    } else {
      local = np.slice();
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
  const previouslySkinned = new Set();

  const bounds = computeWorldBounds(doc, previouslySkinned);
  const forwardZ = detectForwardZ(doc, bounds, previouslySkinned);
  const guess = guessJointsFromMesh(collectWorldVertices(doc, previouslySkinned), bounds, forwardZ);
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
  if (leftSide !== fwdSign) {
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
