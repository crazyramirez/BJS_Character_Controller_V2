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

function computeBindWorldMatrices(doc) {
  const root = doc.getRoot();
  const parentMap = buildParentMap(doc);
  const cache = new Map();

  // 1. Map skin to the mesh nodes that use it
  const skinMeshes = new Map();
  for (const node of root.listNodes()) {
    const skin = node.getSkin();
    if (skin) {
      if (!skinMeshes.has(skin)) skinMeshes.set(skin, []);
      skinMeshes.get(skin).push(node);
    }
  }

  // 2. Pre-populate bind world matrices for all joints using skins
  const tempCache = new Map();
  for (const skin of root.listSkins()) {
    const joints = skin.listJoints();
    const ibmAcc = skin.getInverseBindMatrices();
    const ibmArr = ibmAcc ? ibmAcc.getArray() : null;
    if (!ibmArr) continue;

    // Find a mesh node using this skin
    const meshes = skinMeshes.get(skin) || [];
    const meshNode = meshes[0];

    // S is the mesh node's world transform.
    // If no mesh node, fallback to identity.
    const S = meshNode 
      ? worldMatrixOf(meshNode, parentMap, tempCache) 
      : new Float32Array(MAT4_IDENTITY);

    joints.forEach((joint, idx) => {
      const ibm = ibmArr.slice(idx * 16, idx * 16 + 16);
      const invIbm = invertRigidMat4(ibm);
      const W_bind = mat4Mul(S, invIbm);
      
      // Fallback: if the IBM-derived position is at [0,0,0] (or extremely close)
      // but the hierarchical world matrix position in the scene is NOT at [0,0,0],
      // fall back to the world matrix position so we don't collapse helper/unweighted joints.
      const ibmDistSq = W_bind[12] * W_bind[12] + W_bind[13] * W_bind[13] + W_bind[14] * W_bind[14];
      if (ibmDistSq < 1e-8) {
        const W_hier = worldMatrixOf(joint, parentMap, tempCache);
        const hierDistSq = W_hier[12] * W_hier[12] + W_hier[13] * W_hier[13] + W_hier[14] * W_hier[14];
        if (hierDistSq > 1e-5) {
          W_bind[12] = W_hier[12];
          W_bind[13] = W_hier[13];
          W_bind[14] = W_hier[14];
        }
      }
      
      cache.set(joint, W_bind);
    });
  }

  // 3. For any other nodes (non-joints, or joints not in a skin), fall back to worldMatrixOf
  for (const node of root.listNodes()) {
    if (!cache.has(node)) {
      cache.set(node, worldMatrixOf(node, parentMap, tempCache));
    }
  }

  return cache;
}

// ── Skin space → render world ────────────────────────────────────────────────
// Skinned vertices are authored in skin space and rendered as jointWorld·IBM·v.
// At bind pose jointWorld·IBM is the same matrix S for every joint that actually
// skins the mesh — but S is NOT always identity: FBX-sourced exports (UE, Blender,
// 3ds Max, AccuRig) keep vertices Z-up and put the up-axis fix on an armature
// ancestor, so S is that rotation. Returns Map<mesh, mat4> for every skinned mesh.
//
// The reference joint must be one that REALLY skins the mesh. joints[0] is often
// a synthetic root (_rootJoint, Armature) whose jointWorld·IBM does NOT match the
// body joints' S (e.g. Sketchfab Jill: _rootJoint·IBM₀ misses the -90°X that every
// body joint carries) — using it flips the whole mesh back to Z-up and scatters
// the auto-rig markers on the floor. So pick the most-weighted joint of the mesh.
function dominantJointIndex(mesh) {
  const counts = new Map();
  for (const prim of mesh.listPrimitives()) {
    const J = prim.getAttribute('JOINTS_0');
    const W = prim.getAttribute('WEIGHTS_0');
    if (!J || !W) continue;
    const ji = [0, 0, 0, 0], wi = [0, 0, 0, 0];
    for (let i = 0; i < J.getCount(); i++) {
      J.getElement(i, ji); W.getElement(i, wi);
      for (let k = 0; k < 4; k++) {
        if (wi[k] > 0) counts.set(ji[k], (counts.get(ji[k]) || 0) + wi[k]);
      }
    }
  }
  let best = -1, bestW = -1;
  for (const [idx, w] of counts) { if (w > bestW) { bestW = w; best = idx; } }
  return best;
}

function skinWorldXforms(doc) {
  const parentMap = buildParentMap(doc);
  const bindWorldMatrices = computeBindWorldMatrices(doc);
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
    // Reference on a joint that actually weights this mesh (fall back to 0).
    let ref = dominantJointIndex(mesh);
    if (ref < 0 || ref * 16 + 16 > ibm.length || !joints[ref]) ref = 0;
    const W = bindWorldMatrices.get(joints[ref]) || worldMatrixOf(joints[ref], parentMap, new Map());
    byMesh.set(mesh, mat4Mul(W, ibm.slice(ref * 16, ref * 16 + 16)));
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
 * Detect which way the character faces along Z. Combines multiple anatomical
 * cues with a weighted vote so symmetric shoes, helmets or action poses don't
 * flip the facing.
 * Returns { sign: +1/-1, certainty: 0..1 }.
 */
function detectForwardZWithConfidence(doc, { min, max }, skinXforms = new Map(), bodyMeshes = null) {
  if (global.MOCK_FORWARD_Z !== undefined) return { sign: global.MOCK_FORWARD_Z, certainty: 1 };
  const H = max[1] - min[1];
  const footY = min[1] + 0.10 * H;
  const shinY = min[1] + 0.30 * H;
  const hipY = min[1] + 0.45 * H;
  const shoulderY = min[1] + 0.75 * H;
  const faceY = min[1] + 0.82 * H;
  const parentMap = buildParentMap(doc);
  const cache = new Map();

  // Collect per-band Z samples
  const footZ = [], shinZ = [], hipZ = [], shoulderZ = [], faceZ = [];
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
        const y = p[1];
        if (y <= footY) footZ.push(p[2]);
        else if (y <= shinY) shinZ.push(p[2]);
        else if (y <= hipY) hipZ.push(p[2]);
        else if (y <= shoulderY) shoulderZ.push(p[2]);
        else if (y >= faceY) faceZ.push(p[2]);
      }
    }
  }

  const depth = Math.max(1e-6, max[2] - min[2]);
  const bodyCz = (min[2] + max[2]) / 2;

  // Vote from asymmetric overhang + offset of a Z distribution.
  const bandVote = (zs, needMin = 4) => {
    if (zs.length < needMin) return { vote: 0, strength: 0 };
    const med = median(zs);
    let zmax = -Infinity, zmin = Infinity, sum = 0;
    for (const z of zs) {
      if (z > zmax) zmax = z;
      if (z < zmin) zmin = z;
      sum += z;
    }
    const range = zmax - zmin;
    const overhang = range > 0 ? ((zmax - med) - (med - zmin)) / range : 0;
    const offset = ((sum / zs.length) - bodyCz) / depth;
    const vote = overhang + offset;
    const asym = Math.abs(overhang);
    const strength = Math.min(1, zs.length / 200) * Math.min(1, asym * 3 + Math.abs(offset) * 2);
    return { vote, strength };
  };

  const f = bandVote(footZ);
  const s = bandVote(shinZ);
  const h = bandVote(hipZ);
  const sh = bandVote(shoulderZ);
  const fc = bandVote(faceZ);

  // Face cue: frontal face has more vertices forward of the head median Z.
  let faceFrontVote = 0, faceFrontStrength = 0;
  if (faceZ.length >= 10) {
    const med = median(faceZ);
    let front = 0, back = 0;
    for (const z of faceZ) {
      if (z > med) front++;
      else if (z < med) back++;
    }
    const total = front + back;
    if (total > 0) {
      faceFrontVote = (front - back) / total;
      faceFrontStrength = Math.min(1, total / 400) * Math.abs(faceFrontVote);
    }
  }

  // Torso frontal curvature: shoulders usually protrude forward of hips.
  let shoulderHipVote = 0, shoulderHipStrength = 0;
  if (shoulderZ.length >= 10 && hipZ.length >= 10) {
    const shMed = median(shoulderZ);
    const hipMed = median(hipZ);
    shoulderHipVote = (shMed - hipMed) / depth;
    shoulderHipStrength = Math.min(1, Math.min(shoulderZ.length, hipZ.length) / 200);
  }

  const weights = {
    foot: 1.0,
    shin: 0.5,
    faceOverhang: 0.4,
    faceFront: 0.35,
    shoulderHip: 0.25,
  };

  let weightedVote =
    f.vote * weights.foot * Math.min(1, f.strength + 0.3) +
    s.vote * weights.shin * Math.min(1, s.strength + 0.2) +
    fc.vote * weights.faceOverhang * Math.min(1, fc.strength + 0.2) +
    faceFrontVote * weights.faceFront * Math.min(1, faceFrontStrength + 0.2) +
    shoulderHipVote * weights.shoulderHip * Math.min(1, shoulderHipStrength + 0.2);

  let totalWeight =
    weights.foot * Math.min(1, f.strength + 0.3) +
    weights.shin * Math.min(1, s.strength + 0.2) +
    weights.faceOverhang * Math.min(1, fc.strength + 0.2) +
    weights.faceFront * Math.min(1, faceFrontStrength + 0.2) +
    weights.shoulderHip * Math.min(1, shoulderHipStrength + 0.2);

  if (totalWeight < 0.01) {
    return { sign: 1, certainty: 0.1 };
  }

  const normalized = weightedVote / totalWeight;
  const certainty = Math.min(1, Math.abs(normalized) * 4 + totalWeight * 0.3);
  return { sign: normalized >= 0 ? 1 : -1, certainty };
}

/**
 * Backward-compatible wrapper: returns only the facing sign.
 */
function detectForwardZ(...args) {
  return detectForwardZWithConfidence(...args).sign;
}

export function guessJointsFromBounds({ min, max }, forwardZ = 1) {
  const H = max[1] - min[1];
  const groundY = min[1];
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const halfW = Math.max((max[0] - min[0]) / 2, 0.3 * H);

  const y = f => groundY + f * H;
  const J = (x, yy, z) => [cx + x, yy, cz + z];

  // Vertical fractions calibrated to the reference Mixamo humanoid rig (Erika
  // Archer, 1.78 m T-pose): Hips 0.589, Spine 0.646, Spine1 0.703, Spine2 0.754,
  // Neck 0.848, Head 0.902, UpLeg 0.551, Leg 0.302, Foot 0.052.
  const shoulderY = y(0.812);
  const joints = {
    Hips: J(0, y(0.589), 0),
    Spine: J(0, y(0.646), 0),
    Spine1: J(0, y(0.703), 0),
    Spine2: J(0, y(0.754), 0),
    Neck: J(0, y(0.848), 0),
    Head: J(0, y(0.902), 0),

    // Arm lateral offsets as fractions of the bbox half-width (T-pose: arms span
    // the box). Ref ratios: Arm 0.18, ForeArm 0.50, Hand 0.83 of the half-span;
    // Shoulder just outside the neck.
    LeftShoulder: J(0.10 * halfW * forwardZ, shoulderY, 0),
    LeftArm: J(0.18 * halfW * forwardZ, shoulderY, 0),
    LeftForeArm: J(0.50 * halfW * forwardZ, shoulderY, 0),
    LeftHand: J(0.83 * halfW * forwardZ, shoulderY, 0),

    RightShoulder: J(-0.10 * halfW * forwardZ, shoulderY, 0),
    RightArm: J(-0.18 * halfW * forwardZ, shoulderY, 0),
    RightForeArm: J(-0.50 * halfW * forwardZ, shoulderY, 0),
    RightHand: J(-0.83 * halfW * forwardZ, shoulderY, 0),

    LeftUpLeg: J(0.046 * H * forwardZ, y(0.551), 0),
    LeftLeg: J(0.046 * H * forwardZ, y(0.302), 0),
    LeftFoot: J(0.046 * H * forwardZ, y(0.052), 0),
    LeftToeBase: J(0.046 * H * forwardZ, y(0.003), 0.06 * H * forwardZ),

    RightUpLeg: J(-0.046 * H * forwardZ, y(0.551), 0),
    RightLeg: J(-0.046 * H * forwardZ, y(0.302), 0),
    RightFoot: J(-0.046 * H * forwardZ, y(0.052), 0),
    RightToeBase: J(-0.046 * H * forwardZ, y(0.003), 0.06 * H * forwardZ),
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
  const yf = p => (p[1] - groundY) / H; // normalized height of a vertex

  // Body centerline from medians — robust against asymmetric props/capes.
  // Use the pelvis band for Z so the skeleton root is anchored on the hips,
  // not pulled forward by the chest/head mass.
  const cx = median(verts.map(p => p[0]));
  // Centre Z: use the central sagittal strip of the pelvis band so the hip joint
  // aligns with the spinal column, not the front of the abdomen.
  const pelvisZ = verts
    .filter(p => yf(p) > 0.45 && yf(p) < 0.65 && Math.abs(p[0] - cx) < 0.05 * H)
    .map(p => p[2]);
  const cz = pelvisZ.length ? median(pelvisZ) : median(verts.map(p => p[2]));


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

  // Closed-leg fallback: the split test often misses trousers/jeans/closed
  // stances. The crotch is then the narrowest horizontal band between the hips
  // and the knees that still has mass on both sides.
  if (crotchY === null && !skirtMode) {
    let narrowestY = null, narrowestW = Infinity;
    const crotchLo = Math.floor(0.28 * BINS), crotchHi = Math.floor(0.52 * BINS);
    for (let b = crotchLo; b <= crotchHi; b++) {
      const bin = bins[b];
      if (!bin || bin.n < 8 || bin.left.length < 3 || bin.right.length < 3) continue;
      const w = median(bin.left) + median(bin.right);
      if (w < narrowestW) { narrowestW = w; narrowestY = groundY + (b / BINS) * H; }
    }
    if (narrowestY !== null) crotchY = narrowestY;
  }

  if (crotchY !== null) {
    // Hips (pelvis root) sits ABOVE the leg roots, at the real pelvis/iliac
    // crest — never glued to the crotch. We find the waist (narrowest body band
    // above the crotch and below the shoulders) and place Hips ~40% of the way
    // from crotch up to the waist. This gives the lower Spine a correct anchor
    // to grow from instead of starting it down at the crotch.
    const waistLo = Math.min(BINS - 2, Math.floor(((crotchY - groundY) / H) * BINS) + 1);
    const waistHi = Math.min(BINS - 1, Math.floor(0.78 * BINS));
    const widthAtB = b => {
      const bin = bins[b];
      if (!bin || bin.n < 8) return null;
      const all = bin.left.concat(bin.right);
      return all.length ? median(all) : null;
    };
    let waistB = -1, waistW = Infinity;
    for (let b = waistLo; b <= waistHi; b++) {
      const w = widthAtB(b);
      if (w !== null && w < waistW) { waistW = w; waistB = b; }
    }
    const waistY = waistB >= 0 ? groundY + ((waistB + 0.5) / BINS) * H : crotchY + 0.16 * H;

    // ── Hip socket (UpLeg) height ─────────────────────────────────────────────
    // CRITICAL: the femur-head / hip-socket joint is NOT at the visible crotch.
    // In every standard humanoid rig (Mixamo, UE, CC) the leg roots sit up at the
    // pelvis, level with the hips (~0.55·H), while the geometric crotch where the
    // inner thighs meet is markedly lower. Anchoring UpLeg at the crotch drops the
    // whole leg chain ~0.3·H too low and inverts the leg/hip relationship.
    //
    // Place UpLeg at the pelvis: most of the way (≈80%) from the crotch up to the
    // waist, clamped to a sane anatomical band so short-leg/long-torso meshes stay
    // correct. This keeps it relative to the measured body (not a fixed fraction)
    // while matching the reference rig's hip-socket height.
    let upLegY = crotchY + (waistY - crotchY) * 0.57;
    // Anatomical clamp: hip sockets fall in ~0.51–0.57·H for upright humanoids
    // (reference Mixamo rig: 0.545·H). Bias toward that canonical band so a low
    // waist/crotch measurement can't drag the leg roots down the thigh.
    upLegY = Math.max(groundY + 0.51 * H, Math.min(upLegY, groundY + 0.57 * H));
    // But never below the crotch+margin (degenerate measurements).
    upLegY = Math.max(crotchY + 0.04 * H, upLegY);

    // Hips (pelvis root) sits just ABOVE the leg roots (ref: Hips 0.589·H,
    // UpLeg 0.551·H — only ~0.04·H apart). Anchor it a small step above UpLeg,
    // not far up toward the waist (that over-raised the lower spine anchor).
    let hipsY = upLegY + (waistY - upLegY) * 0.22;
    hipsY = Math.max(upLegY + 0.03 * H, Math.min(hipsY, waistY + 0.02 * H));
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
      // Hip/knee stay on the pelvis midline; only the ankle/toes drop slightly back.
      const footZ = cz - 0.025 * H * forwardZ;
      joints[side + 'UpLeg'] = [cx + sgnAdjusted * legDX, upLegY, cz];
      joints[side + 'Leg'] = [cx + sgnAdjusted * legDX, kneeY, cz];
      joints[side + 'Foot'] = [cx + sgnAdjusted * legDX, ankleY, footZ];
      joints[side + 'ToeBase'] = [cx + sgnAdjusted * legDX, joints[side + 'ToeBase'][1], footZ + 0.06 * H * forwardZ];
    }
    joints.Hips = [cx, hipsY, cz];
    if (process.env.AUTORIG_DEBUG) console.log('[autorig] crotchY', crotchY.toFixed(3), 'waistY', waistY.toFixed(3), 'upLegY', upLegY.toFixed(3), 'hipsY', hipsY.toFixed(3));
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

    // Hands: centroid of the outermost 8% of each arm span (any arm angle).
    // This centroid lands at the FINGERTIPS, not the wrist — the hand JOINT sits
    // ~one finger length (≈0.08·H) inboard. We pull it back along the arm so the
    // wrist marker matches the reference rig (ref hand 0.40·H, fingertip 0.48·H).
    const handL = centroidOf(upperVerts.filter(p => (p[0] - cx) > 0.92 * spanL));
    const handR = centroidOf(upperVerts.filter(p => (cx - p[0]) > 0.92 * spanR));
    if (handL && handR) {
      // Symmetrize so the skeleton stays mirrored even on asymmetric meshes
      const tipX = ((handL[0] - cx) + (cx - handR[0])) / 2; // fingertip half-span
      const hy = (handL[1] + handR[1]) / 2;
      const hz = (handL[2] + handR[2]) / 2;
      // Wrist = fingertip pulled in by a finger length, floored so it can't pass
      // the elbow region. Finger length scales with the arm but is capped.
      const fingerLen = Math.min(0.09 * H, 0.18 * tipX);
      const hx = Math.max(0.55 * tipX, tipX - fingerLen);

      // ── Arm root (shoulder joint) lateral offset = armpit half-width ─────────
      // The shoulder joint sits at the armpit, NOT at 0.45·span (which placed it
      // far down the upper arm). Measure the body half-width at shoulder height
      // by the inner edge of the arm: scan inward from the fingertip for the first
      // big horizontal gap (arm↔torso). Fall back to an anatomical fraction.
      let armRootX = 0.085 * H; // reference Mixamo armpit ≈ 0.085·H
      const shoulderBand = upperVerts.filter(p => Math.abs(p[1] - shoulderY) < 0.05 * H);
      if (shoulderBand.length >= 20) {
        // Torso half-width at the shoulders = median |x| of vertices well inboard
        // of the arms (within the middle 55% of the span).
        const inner = shoulderBand
          .map(p => Math.abs(p[0] - cx))
          .filter(a => a < 0.55 * tipX);
        if (inner.length >= 8) {
          const torsoHalf = median(inner.sort((a, b) => a - b));
          // Arm root sits just outside the torso edge.
          armRootX = Math.min(Math.max(torsoHalf, 0.06 * H), 0.13 * H);
        }
      }

      for (const [side, sgn] of [['Left', 1], ['Right', -1]]) {
        const sgnAdjusted = sgn * forwardZ;
        // Arms hang slightly behind the pelvis centre in a relaxed T/A-pose.
        const armZ = cz - 0.04 * H * forwardZ;
        const shoulder = [cx + sgnAdjusted * 0.45 * armRootX, shoulderY, armZ];
        const hand = [cx + sgnAdjusted * hx, hy, hz];
        // The shoulder joint sits at the armpit, but the arm joint (humerus head)
        // is well out on the upper arm — place it a fixed fraction along the
        // shoulder-to-hand line to match Mixamo proportions.
        const armT = 0.14;
        const arm = [
          shoulder[0] + sgnAdjusted * Math.abs(hand[0] - shoulder[0]) * armT,
          shoulder[1] + (hand[1] - shoulder[1]) * armT,
          shoulder[2] + (hand[2] - shoulder[2]) * armT,
        ];
        const fore = [(arm[0] + hand[0]) / 2, (arm[1] + hand[1]) / 2, (arm[2] + hand[2]) / 2];
        joints[side + 'Shoulder'] = shoulder;
        joints[side + 'Arm'] = arm;
        joints[side + 'ForeArm'] = fore;
        joints[side + 'Hand'] = hand;
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
  // Reference calibration: the narrowest-band neck detector tends to sit slightly
  // above the anatomical neck base on Mixamo-style proportions.
  neckY -= 0.015 * H;


  const hipsY2 = joints.Hips[1];
  // Keep the spine chain near the body midline in Z. Pure per-band median Z pulls
  // chest/neck joints onto the back surface of hunched/rounded torsos. Use the
  // detected body centre cz and add a mild Mixamo-style backward lean (pelvis
  // forward, upper spine slightly back) proportional to height.
  const spineZ = f => {
    if (f <= hipsY2) return cz;
    const t = Math.min(1, Math.max(0, (f - hipsY2) / Math.max(1e-6, neckY - hipsY2)));
    // Mixamo reference: the upper spine leans back slowly; offset is negligible
    // until the chest, then grows to ~0.013*H at the neck.
    return cz - H * 0.0135 * Math.pow(t, 3);
  };
  const targetSpine2Y = Math.max(hipsY2 + 0.1 * H, Math.min(shoulderY - 0.055 * H, neckY - 0.02 * H));
  const lerpSpineY = t => hipsY2 + (targetSpine2Y - hipsY2) * t;
  joints.Spine = [cx, lerpSpineY(0.33), spineZ(lerpSpineY(0.33))];
  joints.Spine1 = [cx, lerpSpineY(0.66), spineZ(lerpSpineY(0.66))];
  joints.Spine2 = [cx, targetSpine2Y, spineZ(targetSpine2Y)];
  joints.Neck = [cx, neckY, spineZ(neckY)];

  // ── Head = centroid of the skull blob ABOVE the neck ──────────────────────
  // Everything above the neck pinch is the head; its centroid is the head joint
  // regardless of skull size. This lifts the head marker to the real head
  // centre on cartoon proportions instead of pinning it just above the neck.
  const headPts = verts.filter(p => p[1] > neckY + 0.01 * H);
  const headC = centroidOf(headPts);
  let headY = headC
    ? Math.min(Math.max(headC[1], neckY + 0.03 * H), groundY + 0.98 * H)
    : Math.min(neckY + 0.05 * H, groundY + 0.97 * H);
  // The skull centroid is biased upward by hair/helmet geometry; nudge it down
  // to the Mixamo head-joint height.
  headY -= 0.015 * H;

  joints.Head = [cx, headY, spineZ(headY)];

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
  return { joints, height: H, bounds, flags: { crotch: crotchY !== null, arms: armsDetected, skirt: skirtMode } };
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
export function guessJointsAuto(doc, skinXforms, bounds, forwardZ, bodyMeshes = null, precomputed = {}) {
  const verts = precomputed.verts || collectWorldVertices(doc, skinXforms, bodyMeshes);
  const sliced = precomputed.sliced || guessJointsFromMesh(verts, bounds, forwardZ);
  if (!sliced.method) sliced.method = 'slicing';

  let topo = precomputed.topo;
  if (topo === undefined) {
    try {
      topo = guessJointsFromTopology(doc, skinXforms, bounds, forwardZ, bodyMeshes);
    } catch (e) {
      console.warn('[autorig] Topology pass failed, using slicing guess:', e.message);
    }
  }
  if (topo && !isSkeletonAnatomicallySane(topo.joints)) {
    console.warn('[autorig] Topology skeleton failed anatomical sanity checks (joints inverted). Rejecting topology guess.');
    topo = null;
  }
  if (!topo) return sliced;

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
    // Even an "upright" topology skeleton can be broken on an action pose: a
    // spurious 6th extremity (bent elbow/knee spur) corrupts the pair matching,
    // collapsing both UpLeg roots onto the SAME side. Slicing already proved the
    // mesh is a clean upright stance (real crotch + arm span), so before letting
    // topology overrule it, demand topology's own legs be anatomically sane:
    // the two thighs must straddle the body — opposite sides, clearly apart.
    const ulL = topo.joints.LeftUpLeg, ulR = topo.joints.RightUpLeg;
    const legSpread = Math.abs(ulL[0] - ulR[0]);
    const straddle = (ulL[0] - topo.joints.Hips[0]) * (ulR[0] - topo.joints.Hips[0]) < 0;
    const topoLegsSane = straddle && legSpread > 0.06 * H;
    if (process.env.AUTORIG_DEBUG) console.log(`[autorig] cross-check: topoConf=${topo.confidence.toFixed(2)} disagree=${(disagree * 100).toFixed(0)}% topoUpright=${topoUpright} topoLegsSane=${topoLegsSane} (spread=${(legSpread / H).toFixed(2)}H straddle=${straddle})`);
    if (disagree > 0.22 && topoUpright && topoLegsSane) {
      console.log(`[autorig] Detectors disagree (${(disagree * 100).toFixed(0)}% of height) — pose is non-standard, using topology skeleton.`);
      return topo;
    }
    if (disagree > 0.22 && topoUpright && !topoLegsSane) {
      console.log('[autorig] Topology legs collapsed to one side (broken pair-matching on an action pose) — keeping upright slicing skeleton.');
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
  Spine1: ['spine01', 'spine1', 'spine02', 'chest'],
  Spine2: ['spine02', 'spine2', 'spine03', 'upperchest'],
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

// Populate finger joint aliases dynamically
for (const side of ['Left', 'Right']) {
  const s = side.toLowerCase();
  const sPrefix = side === 'Left' ? 'l' : 'r';
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    const f = finger.toLowerCase();
    for (let i = 1; i <= 3; i++) {
      const canon = `${side}Hand${finger}${i}`;
      SEED_ALIASES[canon] = [
        `${s}hand${f}${i}`,
        `${sPrefix}hand${f}${i}`,
        `${s}${f}${i}`,
        `${sPrefix}${f}${i}`,
        `${sPrefix}${f}0${i}`,
        `${f}0${i}${sPrefix}`,
        `${f}${i}${sPrefix}`,
      ];
    }
  }
}

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
  const worldByNorm = new Map();
  const bindWorldMatrices = computeBindWorldMatrices(doc);
  for (const skin of doc.getRoot().listSkins()) {
    const joints = skin.listJoints();
    if (!joints.length) continue;
    joints.forEach((joint) => {
      const W = bindWorldMatrices.get(joint) || MAT4_IDENTITY;
      const p = [W[12], W[13], W[14]];
      for (const n of seedNormVariants(joint.getName())) {
        if (n && !worldByNorm.has(n)) worldByNorm.set(n, { name: joint.getName(), pos: p });
      }
    });
  }
  const seeded = {};
  const assignedNames = new Set();
  for (const [canon, aliases] of Object.entries(SEED_ALIASES)) {
    for (const a of aliases) {
      if (worldByNorm.has(a)) {
        const item = worldByNorm.get(a);
        if (!assignedNames.has(item.name)) {
          seeded[canon] = item.pos;
          assignedNames.add(item.name);
          break;
        }
      }
    }
  }
  // CC/AccuRig 3-bone spine (Waist→Spine01→Spine02, no spine03): align seeds
  // with the merge-time chain shift (Spine→Waist, Spine1→Spine01, Spine2→Spine02)
  // so Spine2 gets a real seed instead of a mesh guess overlapping Spine1.
  if (worldByNorm.has('waist') && worldByNorm.has('spine01') &&
    worldByNorm.has('spine02') && !worldByNorm.has('spine03')) {
    seeded.Spine = worldByNorm.get('waist').pos;
    seeded.Spine1 = worldByNorm.get('spine01').pos;
    seeded.Spine2 = worldByNorm.get('spine02').pos;
  }
  return seeded;
}

function fillMissingSpineJoints(joints, H) {
  // Ensure Hips and Head exist (they are baseline anchors)
  if (!joints.Hips || !joints.Head) return;

  // 1. If Neck is missing, place it between Head and Spine2 (or Hips)
  if (!joints.Neck) {
    const base = joints.Spine2 || joints.Spine1 || joints.Spine || joints.Hips;
    joints.Neck = [
      joints.Head[0],
      base[1] + (joints.Head[1] - base[1]) * 0.7,
      (joints.Head[2] + base[2]) / 2
    ];
  }

  // 2. If Spine2 is missing, interpolate it between Spine1 (or Spine/Hips) and Neck
  if (!joints.Spine2) {
    const base = joints.Spine1 || joints.Spine || joints.Hips;
    joints.Spine2 = [
      base[0],
      base[1] + (joints.Neck[1] - base[1]) * 0.65,
      (base[2] + joints.Neck[2]) / 2
    ];
  }

  // 3. If Spine1 is missing, interpolate it between Spine (or Hips) and Spine2 (or Neck)
  if (!joints.Spine1) {
    const base = joints.Spine || joints.Hips;
    const top = joints.Spine2 || joints.Neck;
    joints.Spine1 = [
      base[0],
      base[1] + (top[1] - base[1]) * 0.5,
      (base[2] + top[2]) / 2
    ];
  }

  // 4. If Spine is missing, interpolate it between Hips and Spine1 (or Spine2/Neck)
  if (!joints.Spine) {
    const top = joints.Spine1 || joints.Spine2 || joints.Neck;
    joints.Spine = [
      joints.Hips[0],
      joints.Hips[1] + (top[1] - joints.Hips[1]) * 0.5,
      (joints.Hips[2] + top[2]) / 2
    ];
  }
}

function sanitizeJoints(joints, H, bounds) {
  if (!joints) return;

  const hips = joints.Hips;
  const head = joints.Head;
  const neck = joints.Neck;
  const spine2 = joints.Spine2;
  const spine1 = joints.Spine1;
  const spine = joints.Spine;
  const shL = joints.LeftShoulder;
  const shR = joints.RightShoulder;

  // Hips and Head must exist for central Spine chain sanity
  if (!hips || !head) return;

  const groundY = bounds ? bounds.min[1] : hips[1] - 0.5 * H;

  // 1. Enforce Hips Y bounds sanity. The upper bound must never pull Hips below
  // the leg roots (UpLeg) — short-legged / long-torso characters legitimately
  // have a high pelvis, and clamping it under the crotch inverts the leg
  // hierarchy. So the cap is the higher of 0.58*H and just above the leg roots.
  const upLegYs = [joints.LeftUpLeg, joints.RightUpLeg].filter(Boolean).map(j => j[1]);
  const legRootY = upLegYs.length ? Math.max(...upLegYs) : -Infinity;
  const maxHipsY = Math.max(groundY + 0.58 * H, legRootY + 0.06 * H);
  const minHipsY = Math.max(groundY + 0.45 * H, legRootY + 0.06 * H);
  if (hips[1] > maxHipsY) hips[1] = maxHipsY;
  if (hips[1] < minHipsY) hips[1] = minHipsY;

  // 2. Head must not exceed maximum height
  if (bounds && head[1] > bounds.max[1]) {
    head[1] = bounds.max[1] - 0.01 * H;
  }

  // 3. Neck must sit below Head and above Hips
  if (neck) {
    if (neck[1] >= head[1] - 0.02 * H) neck[1] = head[1] - 0.04 * H;
    if (neck[1] <= hips[1] + 0.1 * H) neck[1] = hips[1] + (head[1] - hips[1]) * 0.8;
  }

  // 4. Clavicles (Shoulder joints) must sit below Neck and above Hips
  const neckY = neck ? neck[1] : head[1] - 0.04 * H;
  const shoulderY = shL && shR ? (shL[1] + shR[1]) / 2 : (shL ? shL[1] : (shR ? shR[1] : neckY - 0.04 * H));
  const targetShoulderY = Math.max(hips[1] + 0.15 * H, Math.min(shoulderY, neckY - 0.02 * H));
  if (shL) shL[1] = targetShoulderY;
  if (shR) shR[1] = targetShoulderY;

  // 5. Spine2 (Chest) must sit below Clavicles and Neck
  const targetSpine2Y = targetShoulderY - 0.01 * H;
  if (spine2) {
    spine2[1] = Math.max(hips[1] + 0.1 * H, Math.min(spine2[1], targetSpine2Y));
  }

  // 6. Spine1 and Spine must sit between Hips and Spine2/Neck
  const spine2ValY = spine2 ? spine2[1] : targetSpine2Y;
  if (spine1) {
    spine1[1] = Math.max(hips[1] + 0.05 * H, Math.min(spine1[1], spine2ValY - 0.02 * H));
  }
  if (spine) {
    const nextY = spine1 ? spine1[1] : spine2ValY;
    spine[1] = Math.max(hips[1] + 0.02 * H, Math.min(spine[1], nextY - 0.02 * H));
  }

  // 7. Leg hierarchy sequence check (UpLeg > Leg > Foot)
  const sides = ['Left', 'Right'];
  for (const side of sides) {
    const upLeg = joints[side + 'UpLeg'];
    const leg = joints[side + 'Leg'];
    const foot = joints[side + 'Foot'];
    if (upLeg && leg && foot) {
      // UpLeg must sit below Hips. Only correct a genuine inversion/collapse —
      // don't drag healthy leg roots down (that breaks leg detection).
      if (upLeg[1] >= hips[1] - 0.02 * H) upLeg[1] = hips[1] - 0.06 * H;
      if (leg[1] >= upLeg[1] || leg[1] <= foot[1]) {
        leg[1] = foot[1] + (upLeg[1] - foot[1]) * 0.5;
      }
    }
  }
}

/**
 * Verifies that the guessed joints follow humanoid anatomy height relationships.
 * In a +Y-up coordinate system, we expect the following vertical order:
 * Head > Neck > Spine2 > Spine1 > Spine > Hips > Feet.
 * We also verify legs layout: UpLeg > Leg > Foot.
 */
function isSkeletonAnatomicallySane(joints) {
  if (!joints) return false;
  const critical = ['Head', 'Neck', 'Spine2', 'Spine1', 'Spine', 'Hips', 'LeftFoot', 'RightFoot'];
  for (const name of critical) {
    if (!joints[name] || !Array.isArray(joints[name]) || joints[name].length < 2) {
      return false;
    }
  }

  const headY = joints.Head[1];
  const neckY = joints.Neck[1];
  const spine2Y = joints.Spine2[1];
  const spine1Y = joints.Spine1[1];
  const spineY = joints.Spine[1];
  const hipsY = joints.Hips[1];
  const leftFootY = joints.LeftFoot[1];
  const rightFootY = joints.RightFoot[1];

  // Head and neck must be higher than hips
  if (headY <= neckY) return false;
  if (neckY <= hipsY) return false;
  if (headY <= hipsY) return false;

  // Spine hierarchy sequence checks
  if (neckY <= spine2Y) return false;
  if (spine2Y <= spine1Y) return false;
  if (spine1Y <= spineY) return false;
  if (spineY <= hipsY) return false;

  // Hips must be above the feet
  if (hipsY <= leftFootY) return false;
  if (hipsY <= rightFootY) return false;

  // Leg hierarchy sequence checks
  for (const side of ['Left', 'Right']) {
    const upLeg = joints[side + 'UpLeg'];
    const leg = joints[side + 'Leg'];
    const foot = joints[side + 'Foot'];
    if (upLeg && leg && foot) {
      if (upLeg[1] <= leg[1]) return false;
      if (leg[1] <= foot[1]) return false;
    }
  }

  return true;
}

// ── Humanoid validation & confidence scoring ─────────────────────────────────
// Decide whether the mesh is plausibly a humanoid character, and score the
// overall quality of the detection so the UI can warn or reject.
function isHumanoidGuess(sliced, topo, score, reason) {
  // Re-rig path: an existing named humanoid skeleton is always treated as valid.
  if (sliced.reRig || topo?.reRig) return { humanoid: true, reason: 'Existing humanoid skeleton detected.' };

  // Strong upright humanoid cues (T-pose / A-pose standing character).
  const upright = sliced.flags?.crotch && sliced.flags?.arms;
  if (upright) return { humanoid: true, reason: 'Upright humanoid shape detected (crotch + arms).' };

  // Topology pass found a coherent 5-extremity body graph AND overall score is
  // high enough to rule out boxes / abstract shapes that happen to have corners.
  if (topo && topo.confidence >= 0.7 && score >= 55) {
    return { humanoid: true, reason: `Pose-independent topology detected (${(topo.confidence * 100).toFixed(0)}% confidence).` };
  }

  // Fallback: aggregate score above threshold.
  if (score >= 60) return { humanoid: true, reason: 'Low-confidence detection — please review markers.' };

  // Rejection reasons.
  if (!topo) {
    return { humanoid: false, reason: reason || 'Could not find a humanoid body topology (head + hands + feet).' };
  }
  if (topo.confidence < 0.5 || score < 40) {
    return { humanoid: false, reason: reason || 'Mesh does not appear to be a humanoid character.' };
  }
  return { humanoid: false, reason: reason || 'Character shape is too ambiguous for automatic rigging.' };
}

function computeAutoRigConfidence(sliced, topo, fwdCertainty, bounds) {
  let score = 20; // base

  // Slicing pass quality (upright T/A pose)
  if (sliced.flags?.crotch) score += 15;
  if (sliced.flags?.arms) score += 15;
  if (sliced.flags?.skirt) score += 5; // we found a garment silhouette, still humanoid

  // Topology pass quality (pose-independent)
  if (topo) {
    score += Math.round(topo.confidence * 20);
  }

  // Forward-Z certainty
  score += Math.round(fwdCertainty * 10);

  // Humanoid proportions: height should dominate width/depth
  const H = bounds.max[1] - bounds.min[1];
  const W = bounds.max[0] - bounds.min[0];
  const D = bounds.max[2] - bounds.min[2];
  const aspect = H / Math.max(W, D);
  if (aspect > 2.0) score += 10;
  else if (aspect > 1.3) score += 5;

  // Symmetry check on slicing arm span
  if (sliced.flags?.arms) {
    const verts = [];
    // We don't have the vertex list here; approximate via joint positions.
    const leftReach = Math.abs(sliced.joints.LeftHand?.[0] - sliced.joints.Hips?.[0]) || 0;
    const rightReach = Math.abs(sliced.joints.RightHand?.[0] - sliced.joints.Hips?.[0]) || 0;
    const avgReach = (leftReach + rightReach) / 2;
    if (avgReach > 0) {
      const asym = Math.abs(leftReach - rightReach) / avgReach;
      if (asym < 0.15) score += 10;
      else if (asym < 0.35) score += 5;
    }
  }

  return Math.max(0, Math.min(100, score));
}

function detectScaleUnit(bounds) {
  const H = bounds.max[1] - bounds.min[1];
  if (H >= 1.0 && H <= 3.5) return { unit: 'm', scale: 1.0, height: H };
  if (H >= 100 && H <= 350) return { unit: 'cm', scale: 0.01, height: H * 0.01 };
  if (H >= 39 && H <= 138) return { unit: 'in', scale: 0.0254, height: H * 0.0254 };
  return { unit: 'unknown', scale: 1.0, height: H };
}

export async function guessJoints(buffer, options = {}) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));
  const skinXf = skinWorldXforms(doc);
  const bodyMeshes = selectBodyMeshes(doc, skinXf);
  const bounds = computeWorldBounds(doc, skinXf, bodyMeshes);
  const fwdResult = detectForwardZWithConfidence(doc, bounds, skinXf, bodyMeshes);
  // Allow the client to override the detected facing. Keeps the marker proposal
  // consistent with the same override applied at rig-bake time:
  //   options.forwardZ (+1/-1) → absolute, options.flipFacing → invert detected.
  let fwd = fwdResult.sign;
  if (options.forwardZ === 1 || options.forwardZ === -1) fwd = options.forwardZ;
  else if (options.flipFacing) fwd = -fwdResult.sign;
  const fwdCertainty = fwdResult.certainty;

  const verts = collectWorldVertices(doc, skinXf, bodyMeshes);
  const sliced = guessJointsFromMesh(verts, bounds, fwd);
  sliced.method = 'slicing';

  let topo = null;
  let topoError = null;
  try {
    topo = guessJointsFromTopology(doc, skinXf, bounds, fwd, bodyMeshes);
    if (topo && !isSkeletonAnatomicallySane(topo.joints)) {
      console.warn('[autorig] Topology skeleton failed anatomical sanity checks (joints inverted). Rejecting topology guess.');
      topoError = 'Topology skeleton failed anatomical sanity checks (joints inverted).';
      topo = null;
    }
  } catch (e) {
    topoError = e.message;
    console.warn('[autorig] Topology pass failed:', e.message);
  }

  const guess = guessJointsAuto(doc, skinXf, bounds, fwd, bodyMeshes, { verts, sliced, topo });

  const guessH = guess.height || (bounds.max[1] - bounds.min[1]);

  const scaleInfo = detectScaleUnit(bounds);
  const score = computeAutoRigConfidence(sliced, topo, fwdCertainty, bounds);
  const { humanoid, reason } = isHumanoidGuess(sliced, topo, score, topoError);

  // Existing skeleton (re-rig): seed markers from current bind pose where names
  // match.
  if (doc.getRoot().listSkins().length > 0) {
    const seeded = seedJointsFromSkins(doc);
    guess.joints = { ...guess.joints, ...seeded };
    // Interpolate missing spine joints if they were not in the skin
    fillMissingSpineJoints(guess.joints, guessH);
    guess.reRig = true;
  }

  // Add procedural finger joints to the proposal so the client can show and edit
  // them. Since existing-skin seeds have been matched, we append fingers afterwards
  // so they are correctly positioned relative to the final hand markers.
  // Twist bones are intentionally omitted from the UI — they are created at rig
  // time but are not meant to be edited manually.
  appendFingerJoints(guess.joints, guessH);

  // Enforce strict anatomical/vertical height relationships to guarantee correct
  // skeletal progression. Skip for re-rig: those joints are seeded straight from
  // the existing skin's real bind pose, which may legitimately be a non-T pose
  // (raised arms, sitting, action pose) — clamping them into a heuristic "sane"
  // vertical order would corrupt accurate data with a worse guess.
  if (!guess.reRig) sanitizeJoints(guess.joints, guessH, bounds);

  // Enrich response with validation metadata
  guess.humanoid = humanoid;
  guess.score = score;
  guess.reason = reason;
  guess.fwdCertainty = fwdCertainty;
  guess.scaleInfo = scaleInfo;
  guess.topoConfidence = topo ? topo.confidence : 0;
  guess.slicingFlags = sliced.flags;

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
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return len > 0 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [0, 0, 0, 1];
}
function vec3Subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vec3Normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}
function vec3Length(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
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
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.99999) {
    let axis = [a[1], -a[0], 0];
    if (Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1]) < 0.0001) {
      axis = [0, a[2], -a[1]];
    }
    const len = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    return qNormalize([axis[0] / len, axis[1] / len, axis[2] / len, 0]);
  }
  if (dot > 0.99999) return [0, 0, 0, 1];
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  return qNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}

function vec3Cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function vec3Dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Build a quaternion that rotates the local +Y axis to `dir` and keeps `up`
 * as close as possible to the local +Z axis (so +X is roughly cross(up, dir)).
 * Returns [x, y, z, w].
 */
function lookRotation(dir, up) {
  const yAxis = vec3Normalize(dir);
  if (vec3Length(yAxis) < 1e-6) return [0, 0, 0, 1];

  let xAxis = vec3Normalize(vec3Cross(up, yAxis));
  if (vec3Length(xAxis) < 1e-6) {
    // dir and up are parallel: pick an orthogonal fallback.
    const fallback = Math.abs(yAxis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    xAxis = vec3Normalize(vec3Cross(fallback, yAxis));
  }
  const zAxis = vec3Cross(xAxis, yAxis);

  // Rotation matrix (column-major for glTF) with columns xAxis, yAxis, zAxis.
  const m = [
    xAxis[0], xAxis[1], xAxis[2],
    yAxis[0], yAxis[1], yAxis[2],
    zAxis[0], zAxis[1], zAxis[2],
  ];
  return mat3ToQuat(m);
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
    skinData.push({ skin, joints, acc, arr: Float32Array.from(arr) });
    joints.forEach(j => jointSet.add(j));
  }
  if (skinData.length === 0) throw new Error('Skin has no inverse bind matrices.');

  // S maps skin space → render world. It must be anchored on a joint that REALLY
  // skins the mesh: joints[0] is frequently a synthetic root (_rootJoint) whose
  // jointWorld·IBM does NOT carry the same coordinate fix (e.g. the -90°X on
  // Sketchfab wrappers) as the body joints — using it lays the rig flat on its
  // back. Pick the most-weighted joint of the skin's mesh instead (same logic as
  // skinWorldXforms), so the markers↔skin-space round-trip stays upright.
  const bindWorldMatrices = computeBindWorldMatrices(doc);
  let sRefJoint = skinData[0].joints[0];
  let sRefIdx = 0;
  {
    let refMesh = null;
    for (const node of root.listNodes()) {
      if (node.getSkin() === skinData[0].skin && node.getMesh()) { refMesh = node.getMesh(); break; }
    }
    const dom = refMesh ? dominantJointIndex(refMesh) : -1;
    if (dom >= 0 && dom < skinData[0].joints.length) { sRefIdx = dom; sRefJoint = skinData[0].joints[dom]; }
  }
  const S = mat4Mul(
    bindWorldMatrices.get(sRefJoint) || MAT4_IDENTITY,
    skinData[0].arr.slice(sRefIdx * 16, sRefIdx * 16 + 16)
  );
  const invS = invertRigidMat4(S);

  // Compute original bind world positions, rotations, and scales for ALL nodes in the scene in GLTF world space
  const origWorldPos = new Map();
  const origWorldRot = new Map();
  const origWorldScale = new Map();

  for (const node of doc.getRoot().listNodes()) {
    const W_render = bindWorldMatrices.get(node) || MAT4_IDENTITY; // Node's bind matrix in GLTF world space

    origWorldPos.set(node, [W_render[12], W_render[13], W_render[14]]);

    const sx = Math.hypot(W_render[0], W_render[1], W_render[2]) || 1;
    const sy = Math.hypot(W_render[4], W_render[5], W_render[6]) || 1;
    const sz = Math.hypot(W_render[8], W_render[9], W_render[10]) || 1;
    origWorldScale.set(node, [sx, sy, sz]);

    const m = [
      W_render[0] / sx, W_render[1] / sx, W_render[2] / sx,
      W_render[4] / sy, W_render[5] / sy, W_render[6] / sy,
      W_render[8] / sz, W_render[9] / sz, W_render[10] / sz
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
      if (normToNode.has(a)) { markerByNode.set(normToNode.get(a), [...targetJoints[canon]]); break; }
    }
  }
  // CC/AccuRig 3-bone spine: markers follow the same chain shift as the merge
  // (Spine→Waist, Spine1→Spine01, Spine2→Spine02); overrides the generic pass.
  if (normToNode.has('waist') && normToNode.has('spine01') &&
    normToNode.has('spine02') && !normToNode.has('spine03')) {
    for (const [canon, alias] of [['Spine', 'waist'], ['Spine1', 'spine01'], ['Spine2', 'spine02']]) {
      if (targetJoints[canon]) markerByNode.set(normToNode.get(alias), [...targetJoints[canon]]);
    }
  }

  // Get original local transforms for all nodes to compute correct descendants world spaces later
  const origLocalT = new Map();
  const origLocalR = new Map();
  const origLocalS = new Map();
  for (const node of doc.getRoot().listNodes()) {
    origLocalT.set(node, node.getTranslation() || [0, 0, 0]);
    origLocalR.set(node, node.getRotation() || [0, 0, 0, 1]);
    origLocalS.set(node, node.getScale() || [1, 1, 1]);
  }

  // New world positions, rotations, and scales: computed in downward hierarchical pass
  const newWorldPos = new Map();
  const newWorldRot = new Map();
  const newWorldScale = new Map();
  let resolved = new Set();

  function resolveNode(node) {
    if (resolved.has(node)) return;
    resolved.add(node);

    const parent = parentMap.get(node);
    if (parent) {
      resolveNode(parent);
    }

    // 1. Scale
    newWorldScale.set(node, origWorldScale.get(node));

    // 2. Rotation (inherits from parent)
    if (parent) {
      const pRot = newWorldRot.get(parent);
      const localR = origLocalR.get(node);
      newWorldRot.set(node, qNormalize(qMul(pRot, localR)));
    } else {
      newWorldRot.set(node, origWorldRot.get(node));
    }

    // 3. Position
    if (markerByNode.has(node)) {
      // If node is a joint mapped to a marker, its position is absolute (controlled by marker)
      newWorldPos.set(node, markerByNode.get(node));
    } else if (parent) {
      // If node has no marker, it keeps its original local translation relative to parent's new world transform
      const pPos = newWorldPos.get(parent);
      const pRot = newWorldRot.get(parent);
      const pScale = origWorldScale.get(parent) || [1, 1, 1];
      const localT = origLocalT.get(node);
      const scaledLocalT = [localT[0] * pScale[0], localT[1] * pScale[1], localT[2] * pScale[2]];
      const rotated = rotateVec3(scaledLocalT, pRot);
      newWorldPos.set(node, [pPos[0] + rotated[0], pPos[1] + rotated[1], pPos[2] + rotated[2]]);
    } else {
      // Scene root with no marker
      newWorldPos.set(node, origWorldPos.get(node));
    }
  }

  for (const node of doc.getRoot().listNodes()) {
    resolveNode(node);
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

  // Since aim corrections changed ancestor rotations, re-evaluate world positions for all non-marker nodes
  resolved = new Set();
  function resolveNodePositionFinal(node) {
    if (resolved.has(node)) return;
    resolved.add(node);

    const parent = parentMap.get(node);
    if (parent) {
      resolveNodePositionFinal(parent);
    }

    if (markerByNode.has(node)) {
      newWorldPos.set(node, markerByNode.get(node));
    } else if (parent) {
      const pPos = newWorldPos.get(parent);
      const pRot = newWorldRot.get(parent);
      const pScale = origWorldScale.get(parent) || [1, 1, 1];
      const localT = origLocalT.get(node);
      const scaledLocalT = [localT[0] * pScale[0], localT[1] * pScale[1], localT[2] * pScale[2]];
      const rotated = rotateVec3(scaledLocalT, pRot);
      newWorldPos.set(node, [pPos[0] + rotated[0], pPos[1] + rotated[1], pPos[2] + rotated[2]]);
    }
  }

  for (const node of doc.getRoot().listNodes()) {
    resolveNodePositionFinal(node);
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
      const W_gltf = composeMat4(newWorldPos.get(j), newWorldRot.get(j), origWorldScale.get(j));
      // Transform joint world bind matrix from GLTF world space back to skin space (S)
      const W_skin = mat4Mul(invS, W_gltf);
      const IBM_new = invertRigidMat4(W_skin);
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

  // Bake each skinned mesh's skin-space → render-world transform (S) into its
  // vertices BEFORE clearing the skin, then reparent the mesh to the scene root
  // so no stale ancestor rotation (e.g. Sketchfab's -90°X) is applied on top.
  // Skinned verts live in skin space; the node transform is ignored by glTF
  // skinning, so without this the rebuilt rig would lie down (raw skin space is
  // usually Z-up). S is anchored on the mesh's dominant (most-weighted) joint —
  // a synthetic _rootJoint at index 0 does NOT carry the body's coordinate fix.
  const parentMap = buildParentMap(doc);
  const bindWorldMatrices = computeBindWorldMatrices(doc);
  const skinXformByMesh = new Map();
  for (const node of root.listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh || skinXformByMesh.has(mesh)) continue;
    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices()?.getArray();
    if (!joints.length || !ibm || ibm.length < 16) { skinXformByMesh.set(mesh, MAT4_IDENTITY); continue; }
    let ref = dominantJointIndex(mesh);
    if (ref < 0 || ref * 16 + 16 > ibm.length || !joints[ref]) ref = 0;
    const W = bindWorldMatrices.get(joints[ref]) || worldMatrixOf(joints[ref], parentMap, new Map());
    skinXformByMesh.set(mesh, mat4Mul(W, ibm.slice(ref * 16, ref * 16 + 16)));
  }

  const skinnedMeshes = new Set();
  const bakedForStrip = new Set();
  const scene0 = root.listScenes()[0];
  for (const node of [...root.listNodes()]) {
    if (node.getSkin()) {
      const mesh = node.getMesh();
      if (mesh) {
        skinnedMeshes.add(mesh);
        if (!bakedForStrip.has(mesh)) {
          bakedForStrip.add(mesh);
          const S = skinXformByMesh.get(mesh) || MAT4_IDENTITY;
          for (const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION');
            if (pos) {
              const arr = pos.getArray().slice();
              for (let i = 0; i < arr.length; i += 3) {
                const p = transformPoint(S, [arr[i], arr[i + 1], arr[i + 2]]);
                arr[i] = p[0]; arr[i + 1] = p[1]; arr[i + 2] = p[2];
              }
              pos.setArray(arr);
            }
            const nrm = prim.getAttribute('NORMAL');
            if (nrm) {
              const arr = nrm.getArray().slice();
              for (let i = 0; i < arr.length; i += 3) {
                const d = transformDirection(S, [arr[i], arr[i + 1], arr[i + 2]]);
                arr[i] = d[0]; arr[i + 1] = d[1]; arr[i + 2] = d[2];
              }
              nrm.setArray(arr);
            }
          }
        }
      }
      node.setSkin(null);
      // Verts are now in render world; neutralize the node transform AND lift the
      // node to the scene root so ancestor coordinate rotations no longer apply.
      node.setTranslation([0, 0, 0]);
      node.setRotation([0, 0, 0, 1]);
      node.setScale([1, 1, 1]);
      if (scene0) scene0.addChild(node);
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
  LeftHandMiddle1: 'LeftHand', LeftHandMiddle2: 'LeftHandMiddle1', LeftHandMiddle3: 'LeftHandMiddle2',
  LeftHandThumb1: 'LeftHand', LeftHandThumb2: 'LeftHandThumb1', LeftHandThumb3: 'LeftHandThumb2',
  LeftHandIndex1: 'LeftHand', LeftHandIndex2: 'LeftHandIndex1', LeftHandIndex3: 'LeftHandIndex2',
  LeftHandRing1: 'LeftHand', LeftHandRing2: 'LeftHandRing1', LeftHandRing3: 'LeftHandRing2',
  LeftHandPinky1: 'LeftHand', LeftHandPinky2: 'LeftHandPinky1', LeftHandPinky3: 'LeftHandPinky2',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  RightHandMiddle1: 'RightHand', RightHandMiddle2: 'RightHandMiddle1', RightHandMiddle3: 'RightHandMiddle2',
  RightHandThumb1: 'RightHand', RightHandThumb2: 'RightHandThumb1', RightHandThumb3: 'RightHandThumb2',
  RightHandIndex1: 'RightHand', RightHandIndex2: 'RightHandIndex1', RightHandIndex3: 'RightHandIndex2',
  RightHandRing1: 'RightHand', RightHandRing2: 'RightHandRing1', RightHandRing3: 'RightHandRing2',
  RightHandPinky1: 'RightHand', RightHandPinky2: 'RightHandPinky1', RightHandPinky3: 'RightHandPinky2',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',

  // Twist bones are declared after their real first child so FIRST_CHILD_OF
  // stays aimed at the next major joint (e.g. LeftArm → LeftForeArm).
  LeftArmTwist: 'LeftArm', LeftForeArmTwist: 'LeftForeArm',
  RightArmTwist: 'RightArm', RightForeArmTwist: 'RightForeArm',
  LeftUpLegTwist: 'LeftUpLeg', LeftLegTwist: 'LeftLeg',
  RightUpLegTwist: 'RightUpLeg', RightLegTwist: 'RightLeg',
};
const JOINT_ORDER = Object.keys(HIERARCHY);

function getJointOrder(fingerCount = 5) {
  const allowedFingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].slice(0, Math.max(1, Math.min(5, Math.round(fingerCount))));
  return JOINT_ORDER.filter(name => {
    const match = name.match(/Hand([a-zA-Z]+)(\d+)$/);
    if (match) {
      const fingerName = match[1];
      return allowedFingers.includes(fingerName);
    }
    return true;
  });
}

// Build a map child -> parent and parent -> first child for bone-roll work.
const CHILD_OF = {};
for (const [name, parent] of Object.entries(HIERARCHY)) {
  CHILD_OF[name] = parent;
}
const FIRST_CHILD_OF = {};
for (const [name, parent] of Object.entries(HIERARCHY)) {
  if (parent) {
    if (!FIRST_CHILD_OF[parent]) FIRST_CHILD_OF[parent] = name;
  }
}

/**
 * Compute anatomically-consistent local rotations for a fresh Mixamo-style
 * skeleton. The goal is a stable bone roll: every limb's local Y axis points
 * toward its child, and the roll axis is chosen so left/right sides mirror
 * each other instead of twisting randomly.
 *
 * `flipRoot180` is true when the character faces -Z relative to Mixamo's +Z
 * convention; in that case the whole skeleton (root only) is rotated 180°
 * about Y so retargeted animations line up.
 */
function computeJointRotations(joints, flipRoot180 = false, jointOrder = JOINT_ORDER) {
  const worldUp = [0, 1, 0];
  const forward = [0, 0, 1]; // Mixamo convention
  const worldRots = {};

  const isSpineChain = (name) => /^(Spine|Spine1|Spine2|Neck|Head|Hips)$/.test(name);
  const isArm = (name) => /(Shoulder|Arm|ForeArm|Hand)$/.test(name);
  const isLeg = (name) => /(UpLeg|Leg|Foot|ToeBase)$/.test(name);
  const isFinger = (name) => /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name);
  const isLeft = (name) => name.startsWith('Left');
  const isRight = (name) => name.startsWith('Right');

  for (const name of jointOrder) {
    // Twist bones share the parent bone's orientation so their local bind
    // rotation is identity and retargeted twist channels apply cleanly.
    if (/Twist$/.test(name)) {
      worldRots[name] = worldRots[CHILD_OF[name]];
      continue;
    }
    const child = FIRST_CHILD_OF[name];
    let dir;
    if (child) {
      dir = vec3Normalize(vec3Subtract(joints[child], joints[name]));
    } else {
      // Terminal joint: reuse the parent bone direction.
      const parent = CHILD_OF[name];
      dir = parent ? vec3Normalize(vec3Subtract(joints[name], joints[parent])) : worldUp;
    }

    let up;
    if (isSpineChain(name)) {
      up = worldUp;
    } else if (isLeft(name) && (isArm(name) || isFinger(name))) {
      // Left arm/finger: palm forward, thumb up → X local points up
      up = forward;
    } else if (isRight(name) && (isArm(name) || isFinger(name))) {
      // Right arm/finger: mirror of left
      up = [-forward[0], -forward[1], -forward[2]];
    } else if (isLeft(name) && isLeg(name)) {
      // Left leg: knee forward, X local points outward (-X world)
      up = [-forward[0], -forward[1], -forward[2]];
    } else if (isRight(name) && isLeg(name)) {
      // Right leg: mirror of left
      up = forward;
    } else {
      up = worldUp;
    }

    // Avoid gimbal lock when a limb happens to point parallel to its up vector.
    if (Math.abs(vec3Dot(dir, up)) > 0.999) {
      up = Math.abs(dir[1]) > 0.9 ? [0, 0, 1] : worldUp;
    }

    worldRots[name] = lookRotation(dir, up);
  }

  // Convert world rotations to local rotations relative to parent.
  const localRots = {};
  for (const name of jointOrder) {
    const parent = CHILD_OF[name];
    if (parent) {
      localRots[name] = qNormalize(qMul(qInvert(worldRots[parent]), worldRots[name]));
    } else {
      localRots[name] = qNormalize(worldRots[name]);
    }
  }

  // Apply global 180° Y flip for -Z-facing characters.
  if (flipRoot180) {
    const r180y = [0, 1, 0, 0];
    localRots.Hips = qNormalize(qMul(r180y, localRots.Hips));
  }

  return { worldRots, localRots };
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
  const segments = {
    Hips: seg('Hips', 'Spine'),
    Spine: seg('Spine', 'Spine1'),
    Spine1: seg('Spine1', 'Spine2'),
    Spine2: seg('Spine2', 'Neck'),
    // Neck only spans the lower half of neck→head so it does not out-compete the
    // Head bone for skull vertices (which sit above the Head joint). Without this
    // most of the skull weighted to Neck and the head tore off when the neck/spine
    // moved.
    Neck: [joints.Neck, [
      joints.Neck[0] + (joints.Head[0] - joints.Neck[0]) * 0.5,
      joints.Neck[1] + (joints.Head[1] - joints.Neck[1]) * 0.5,
      joints.Neck[2] + (joints.Head[2] - joints.Neck[2]) * 0.5,
    ]],
    // Head segment must cover the WHOLE skull. The Head marker sits at the skull
    // base (~chin/jaw height), so extend generously upward (skull is ~0.13·H tall)
    // and start a little below the joint so the jaw/face also bind to Head, not Neck.
    Head: [
      [joints.Head[0], joints.Head[1] - 0.03 * H, joints.Head[2]],
      [joints.Head[0], joints.Head[1] + 0.16 * H, joints.Head[2]],
    ],
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

  // Twist-bone segments run through the middle of their parent bone so the
  // diffusion step has a heat source in the limb mid-section.
  const midSeg = (a, b, t0 = 0.2, t1 = 0.8) => {
    const lerp = (v0, v1, t) => v0 + (v1 - v0) * t;
    return [
      [lerp(joints[a][0], joints[b][0], t0), lerp(joints[a][1], joints[b][1], t0), lerp(joints[a][2], joints[b][2], t0)],
      [lerp(joints[a][0], joints[b][0], t1), lerp(joints[a][1], joints[b][1], t1), lerp(joints[a][2], joints[b][2], t1)],
    ];
  };
  segments.LeftArmTwist = midSeg('LeftArm', 'LeftForeArm');
  segments.LeftForeArmTwist = midSeg('LeftForeArm', 'LeftHand');
  segments.RightArmTwist = midSeg('RightArm', 'RightForeArm');
  segments.RightForeArmTwist = midSeg('RightForeArm', 'RightHand');
  segments.LeftUpLegTwist = midSeg('LeftUpLeg', 'LeftLeg');
  segments.LeftLegTwist = midSeg('LeftLeg', 'LeftFoot');
  segments.RightUpLegTwist = midSeg('RightUpLeg', 'RightLeg');
  segments.RightLegTwist = midSeg('RightLeg', 'RightFoot');

  // Finger segments (5 digits × 3 joints per hand).
  for (const side of ['Left', 'Right']) {
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      const b1 = `${side}Hand${finger}1`;
      const b2 = `${side}Hand${finger}2`;
      const b3 = `${side}Hand${finger}3`;
      segments[b1] = seg(b1, b2);
      segments[b2] = seg(b2, b3);
      // Terminal phalanx extends a little past the last joint.
      segments[b3] = ext(b3, [
        (joints[b3][0] - joints[b2][0]) * 0.6,
        (joints[b3][1] - joints[b2][1]) * 0.6,
        (joints[b3][2] - joints[b2][2]) * 0.6,
      ]);
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
function smoothWeightField(W, nBones, adjacency, iters, lambda, sourceMask = null) {
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
    tmp.set(W);
    for (const [r, nbrs] of adjSet) {
      const n = nbrs.size;
      if (n === 0) continue;
      const base = r * nBones;
      for (let b = 0; b < nBones; b++) {
        const idx = base + b;
        if (sourceMask && sourceMask[idx]) { tmp[idx] = W[idx]; continue; }
        let acc = 0;
        for (const nb of nbrs) acc += W[nb * nBones + b];
        tmp[idx] = W[idx] * (1 - lambda) + (acc / n) * lambda;
      }
    }
    W.set(tmp);
  }
  // Broadcast representative rows back to their duplicates (watertight seams).
  for (let v = 0; v < count; v++) {
    const r = repOf[v];
    if (r === v) continue;
    for (let b = 0; b < nBones; b++) W[v * nBones + b] = W[r * nBones + b];
  }
}

// Distance from point to segment plus closest point and parametric t.
function distPointSegmentFull(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const abLen2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  let t = abLen2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const c = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
  return { d: Math.sqrt(dx * dx + dy * dy + dz * dz), t, c };
}

function vec3Dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// After the top-4 normalization, steal a fraction of the parent bone's weight
// in the limb mid-section and give it to the corresponding twist bone. This
// guarantees the twist bone has real influence without having to win the
// global heat-diffusion competition against the parent/child bones.
function redistributeTwistWeights(positions, jointsOut, weightsOut, parentIdx, twistIdx, parentSeg, H, fraction = 0.4) {
  const count = positions.length / 3;
  const [a, b] = parentSeg;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const abLen2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];

  for (let v = 0; v < count; v++) {
    const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let t = abLen2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLen2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (t < 0.2 || t > 0.8) continue;

    const base = v * 4;
    let parentSlot = -1, twistSlot = -1, minSlot = -1, minW = Infinity;
    for (let k = 0; k < 4; k++) {
      const idx = jointsOut[base + k];
      const w = weightsOut[base + k];
      if (idx === parentIdx) parentSlot = k;
      if (idx === twistIdx) twistSlot = k;
      if (w < minW) { minW = w; minSlot = k; }
    }
    if (parentSlot < 0 || weightsOut[base + parentSlot] <= 1e-6) continue;

    const localFraction = fraction * Math.sin(((t - 0.2) / 0.6) * Math.PI);
    const transfer = weightsOut[base + parentSlot] * localFraction;
    weightsOut[base + parentSlot] -= transfer;

    if (twistSlot >= 0) {
      weightsOut[base + twistSlot] += transfer;
    } else {
      // Avoid evicting the parent if it happens to be the lowest slot.
      if (minSlot === parentSlot) {
        minW = Infinity; minSlot = -1;
        for (let k = 0; k < 4; k++) {
          if (k === parentSlot) continue;
          const w = weightsOut[base + k];
          if (w < minW) { minW = w; minSlot = k; }
        }
      }
      jointsOut[base + minSlot] = twistIdx;
      weightsOut[base + minSlot] = transfer;
    }

    let total = 0;
    for (let k = 0; k < 4; k++) total += weightsOut[base + k];
    if (total > 0) {
      for (let k = 0; k < 4; k++) weightsOut[base + k] /= total;
    }
  }
}

// Per-bone source radius used to seed the heat field. Torso/head bones get a
// larger capture so the chest/hips/skull are fully covered; thin limb bones
// get a tighter radius to keep elbows/knees sharp.
function boneSourceRadius(name, H) {
  if (name === 'Head' || name === 'Neck') return 0.18 * H;
  if (name === 'Hips' || name === 'Spine' || name === 'Spine1' || name === 'Spine2') return 0.08 * H;
  if (name === 'LeftShoulder' || name === 'RightShoulder') return 0.05 * H;
  if (name === 'LeftHand' || name === 'RightHand' ||
    name === 'LeftFoot' || name === 'RightFoot' ||
    name === 'LeftToeBase' || name === 'RightToeBase') return 0.06 * H;
  if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name)) return 0.025 * H;
  if (/Twist$/.test(name)) return 0.04 * H;
  return 0.05 * H;
}

// ── Heat-diffusion source generation ─────────────────────────────────────────
// For every bone, vertices within a bone-specific geodesic neighbourhood of the
// bone segment become heat sources (value 1). The side gate keeps left/right
// limb sources on their own side, so diffusion cannot carry them across the
// body midline. The output field is 0/1; smoothing happens in diffuseWeightField.
function computeBoneSources(positions, segList, boneSide, leftAxis, leftAxisValid, centerAtY, H, jointOrder = JOINT_ORDER) {
  const count = positions.length / 3;
  const nB = segList.length;
  const field = new Float32Array(count * nB);
  const sourceMask = new Uint8Array(count * nB);
  const sideMargin = 0.02 * H;

  for (let v = 0; v < count; v++) {
    const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    const ctr = centerAtY(p[1]);
    const sd = leftAxisValid
      ? (p[0] - ctr[0]) * leftAxis[0] + (p[1] - ctr[1]) * leftAxis[1] + (p[2] - ctr[2]) * leftAxis[2]
      : p[0] - ctr[0];

    for (let b = 0; b < nB; b++) {
      const seg = segList[b];
      const { d } = distPointSegmentFull(p, seg[0], seg[1]);
      const radius = boneSourceRadius(jointOrder[b], H);

      // Soft side gate for left/right limb bones.
      const side = boneSide[b];
      let gate = 1;
      if (side !== 0) {
        const signed = side * sd;
        const g = (signed + sideMargin) / (2 * sideMargin);
        gate = g <= 0 ? 0 : g >= 1 ? 1 : g * g * (3 - 2 * g);
      }

      if (gate > 0.3 && d < radius) {
        const idx = v * nB + b;
        field[idx] = 1;
        sourceMask[idx] = 1;
      }
    }
  }
  return { field, sourceMask };
}

// ── Dirichlet heat diffusion on the welded mesh graph ────────────────────────
// Repeatedly Laplacian-smooth each bone's heat field while clamping source
// vertices back to 1.0 after every pass. This is a discrete approximation of
// the heat kernel (I - λL)u = δ with Dirichlet boundary conditions at the bone
// sources. The result is a smooth, geometry-aware weight field that follows the
// mesh surface instead of jumping through empty space.
function diffuseWeightField(W, nBones, adjacency, sourceMask, iters, lambda) {
  const { repOf, adjSet, count } = adjacency;

  // Collapse duplicates onto their representative so seams are watertight.
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
        const idx = base + b;
        if (sourceMask[idx]) { tmp[idx] = 1; continue; }
        let acc = 0;
        for (const nb of nbrs) acc += W[nb * nBones + b];
        tmp[idx] = W[idx] * (1 - lambda) + (acc / n) * lambda;
      }
    }
    for (const [r] of adjSet) {
      const base = r * nBones;
      for (let b = 0; b < nBones; b++) {
        const idx = base + b;
        W[idx] = sourceMask[idx] ? 1 : tmp[idx];
      }
    }
  }

  // Broadcast back to duplicated seam vertices.
  for (let v = 0; v < count; v++) {
    const r = repOf[v];
    if (r === v) continue;
    for (let b = 0; b < nBones; b++) W[v * nBones + b] = W[r * nBones + b];
  }
}

// ── Rigid anatomical zones ───────────────────────────────────────────────────
// Returns a per-vertex/per-bone field that overrides diffusion in regions that
// should remain rigid (head, hands, feet, torso core). Values are normalized per
// vertex; where no zone applies the row is all zero and the caller keeps the
// diffused weights.
function computeRigidZones(positions, joints, boneIndex, H) {
  const count = positions.length / 3;
  const nB = Object.keys(boneIndex).length;
  const zone = new Float32Array(count * nB);

  const set = (v, name, w) => {
    const b = boneIndex[name];
    if (b != null) zone[v * nB + b] = w;
  };

  const headY = joints.Neck[1] - 0.02 * H;
  const footY = Math.min(joints.LeftFoot[1], joints.RightFoot[1]) + 0.05 * H;
  const torsoBottom = joints.Hips[1] - 0.04 * H;
  const torsoTop = joints.Spine2[1] + 0.04 * H;

  for (let v = 0; v < count; v++) {
    const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];

    // Head zone: above neck, close to head joint. Generous radius catches
    // disconnected hair/helmet geometry that shares no edges with the face.
    if (p[1] >= headY && vec3Dist(p, joints.Head) < 0.30 * H) {
      set(v, 'Head', 1);
      continue;
    }

    // Hand zones: close to the hand joint. We skip the forearm comparison so
    // the palm and nearby floating gloves stay locked to the hand.
    const lHand = vec3Dist(p, joints.LeftHand);
    const rHand = vec3Dist(p, joints.RightHand);
    if (lHand < rHand && lHand < 0.06 * H) { set(v, 'LeftHand', 1); continue; }
    if (rHand <= lHand && rHand < 0.06 * H) { set(v, 'RightHand', 1); continue; }

    // Foot zones: low on the body, close to foot/toe chain.
    if (p[1] <= footY) {
      const lFoot = distPointSegmentFull(p, joints.LeftLeg, joints.LeftFoot).d;
      const lToe = distPointSegmentFull(p, joints.LeftFoot, joints.LeftToeBase).d;
      const rFoot = distPointSegmentFull(p, joints.RightLeg, joints.RightFoot).d;
      const rToe = distPointSegmentFull(p, joints.RightFoot, joints.RightToeBase).d;
      const best = Math.min(lFoot, lToe, rFoot, rToe);
      if (best < 0.08 * H) {
        if (best === lFoot) { set(v, 'LeftFoot', 1); continue; }
        if (best === lToe) { set(v, 'LeftToeBase', 1); continue; }
        if (best === rFoot) { set(v, 'RightFoot', 1); continue; }
        if (best === rToe) { set(v, 'RightToeBase', 1); continue; }
      }
    }

    // Torso core: inside the torso cylinder and not close to a limb segment.
    if (p[1] >= torsoBottom && p[1] <= torsoTop) {
      const spineT = (p[1] - joints.Hips[1]) / Math.max(joints.Spine2[1] - joints.Hips[1], 0.01 * H);
      const spinePoint = [
        joints.Hips[0] + (joints.Spine2[0] - joints.Hips[0]) * spineT,
        p[1],
        joints.Hips[2] + (joints.Spine2[2] - joints.Hips[2]) * spineT,
      ];
      const dSpine = vec3Dist(p, spinePoint);
      if (dSpine < 0.12 * H) {
        // Blend between Hips and Spine chain based on height.
        if (spineT < 0.20) { set(v, 'Hips', 0.7); set(v, 'Spine', 0.3); }
        else if (spineT < 0.45) { set(v, 'Spine', 0.5); set(v, 'Spine1', 0.5); }
        else if (spineT < 0.70) { set(v, 'Spine1', 0.5); set(v, 'Spine2', 0.5); }
        else { set(v, 'Spine2', 0.7); set(v, 'Neck', 0.3); }
        continue;
      }
    }
  }
  return zone;
}

// Blend the diffused field with the rigid-zone overrides. `zoneBlend` controls
// how dominant the rigid zone is (0.8 = 80% zone, 20% diffused).
function blendRigidZones(field, zone, nBones, zoneBlend) {
  const count = field.length / nBones;
  const blend1 = 1 - zoneBlend;
  for (let v = 0; v < count; v++) {
    const base = v * nBones;
    let zoneTotal = 0;
    for (let b = 0; b < nBones; b++) zoneTotal += zone[base + b];
    if (zoneTotal <= 0) continue;
    for (let b = 0; b < nBones; b++) {
      field[base + b] = zone[base + b] * zoneBlend + field[base + b] * blend1;
    }
  }
}

// Per-hand finger offsets in hand-local space. Y points toward the digits,
// X spans across the palm (positive = thumb side on the left hand), Z is palm
// normal. Values are fractions of the detected finger length.
const FINGER_DEFS = [
  // Calibrated against Mixamo reference (character_animated_1.glb T-pose) using
  // the same hand rotation convention as appendFingerJoints. Offsets are in the
  // hand's local frame: X = lateral splay, Y = length along the forearm,
  // Z = palm height. They are scaled by fingerLen.
  { name: 'Thumb', offsets: [[-0.065, 0.10, -0.10], [-0.14, 0.23, -0.17], [-0.21, 0.34, -0.23]] },
  { name: 'Index', offsets: [[-0.025, 0.37, -0.08], [-0.025, 0.51, -0.08], [-0.025, 0.63, -0.08]] },
  { name: 'Middle', offsets: [[0.00, 0.38, 0.01], [0.00, 0.53, 0.01], [0.00, 0.65, 0.01]] },
  { name: 'Ring', offsets: [[0.00, 0.37, 0.09], [0.00, 0.49, 0.09], [0.00, 0.61, 0.09]] },
  { name: 'Pinky', offsets: [[-0.02, 0.32, 0.16], [-0.02, 0.47, 0.16], [-0.02, 0.55, 0.16]] },
];

// Append Mixamo-style finger joints to the `joints` record. Fingers are
// positioned procedurally from the hand orientation and character height, so
// they work on meshes with no explicit finger geometry (they simply collapse
// near the palm) and provide a reasonable starting pose for detailed hand meshes.
// Place a single twist bone at the midpoint of each major limb segment.
// Skip joints that already exist (e.g. seeded from an existing skeleton or
// overridden by the user) so manual finger/twist edits survive the rig pass.
function appendTwistJoints(joints, H) {
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const pairs = [
    ['LeftArmTwist', 'LeftArm', 'LeftForeArm'],
    ['LeftForeArmTwist', 'LeftForeArm', 'LeftHand'],
    ['RightArmTwist', 'RightArm', 'RightForeArm'],
    ['RightForeArmTwist', 'RightForeArm', 'RightHand'],
    ['LeftUpLegTwist', 'LeftUpLeg', 'LeftLeg'],
    ['LeftLegTwist', 'LeftLeg', 'LeftFoot'],
    ['RightUpLegTwist', 'RightUpLeg', 'RightLeg'],
    ['RightLegTwist', 'RightLeg', 'RightFoot'],
  ];
  for (const [name, a, b] of pairs) {
    if (joints[name] || !joints[a] || !joints[b]) continue;
    joints[name] = lerp3(joints[a], joints[b], 0.5);
  }
}

function appendFingerJoints(joints, H) {
  const handLen = Math.hypot(
    joints.LeftHand[0] - joints.LeftForeArm[0],
    joints.LeftHand[1] - joints.LeftForeArm[1],
    joints.LeftHand[2] - joints.LeftForeArm[2]
  );
  const fingerLen = Math.min(0.14 * H, handLen * 1.6);
  if (fingerLen <= 1e-4) return;

  for (const side of ['Left', 'Right']) {
    const handName = side + 'Hand';
    const foreName = side + 'ForeArm';
    const handPos = joints[handName];
    const forePos = joints[foreName];
    if (!handPos || !forePos) continue;
    const dir = vec3Normalize(vec3Subtract(handPos, forePos));
    const forward = [0, 0, 1];
    const up = side === 'Left' ? forward : [-forward[0], -forward[1], -forward[2]];
    const handRot = lookRotation(dir, Math.abs(vec3Dot(dir, up)) > 0.999 ? [0, 1, 0] : up);

    // Mirror X and Z offsets for the right hand (left hand uses palm forward +Z,
    // right hand palm forward -Z). The thumb is asymmetric: keep its calibrated
    // lateral (X) offset but mirror its palm-height (Z) offset.
    const mirror = side === 'Right' ? -1 : 1;
    for (const { name: fingerName, offsets } of FINGER_DEFS) {
      const mirrorX = fingerName === 'Thumb' ? 1 : mirror;
      const mirrorZ = mirror;
      for (let i = 0; i < 3; i++) {
        const jointName = `${side}Hand${fingerName}${i + 1}`;
        if (joints[jointName]) continue; // keep existing / user-overridden joints
        const off = offsets[i];
        const local = [off[0] * mirrorX * fingerLen, off[1] * fingerLen, off[2] * mirrorZ * fingerLen];
        const w = rotateVec3(local, handRot);
        joints[jointName] = [handPos[0] + w[0], handPos[1] + w[1], handPos[2] + w[2]];
      }
    }
  }
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

  // Drop malformed morph targets (attribute vertex count ≠ base mesh). Invalid
  // per the glTF spec; BabylonJS rejects the mesh on load ("Targets and mesh
  // must all have the same vertices count"). A rebuilt rig also bakes POSITION
  // into world space, so a stale-count target could never align anyway.
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const baseCount = prim.getAttribute('POSITION')?.getCount();
      if (baseCount == null) continue;
      for (const target of prim.listTargets()) {
        const bad = target.listSemantics().some(sem => {
          const c = target.getAttribute(sem)?.getCount();
          return c != null && c !== baseCount;
        });
        if (bad) { prim.removeTarget(target); target.dispose(); }
      }
    }
  }

  // Already rigged → ADJUST the existing skeleton instead of rebuilding it.
  // Keeps hierarchy, bind orientations, extra bones (fingers/twist) and the
  // original artist skin weights; only joint positions move to the markers.
  // BUT only when the existing bones carry anatomical names we can map markers
  // to. Some rigs use opaque names (e.g. _rootJoint, 0_01, 1_02 …) that match no
  // canonical joint — adjusting them moves a handful of bones and scatters the
  // rest, producing a broken pose. For those, strip the useless rig and build a
  // fresh Mixamo skeleton from the markers (same as the skinless path).
  if (root.listSkins().length > 0 && options.forceRebuild) {
    console.log('[autorig] forceRebuild requested — stripping existing rig and rebuilding from markers.');
    stripExistingRig(doc);
  } else if (root.listSkins().length > 0) {
    let mappable = 0;
    const allNorms = new Set();
    for (const skin of root.listSkins()) {
      for (const j of skin.listJoints()) {
        for (const n of seedNormVariants(j.getName())) if (n) allNorms.add(n);
      }
    }
    for (const aliases of Object.values(SEED_ALIASES)) {
      if (aliases.some(a => allNorms.has(a))) mappable++;
    }
    // Need a usable core (hips/spine/limbs ≈ 20 canon joints). < 8 → not a real
    // named humanoid rig; rebuild fresh instead of adjusting.
    if (mappable >= 8) {
      adjustExistingRig(doc, options.joints || {});
      await doc.transform(prune({ keepLeaves: true }));
      return io.writeBinary(doc);
    }
    console.log(`[autorig] Existing skeleton has non-anatomical bone names (only ${mappable} canonical joints mappable) — stripping and rebuilding a fresh skeleton.`);
    stripExistingRig(doc);
  }
  const previouslySkinned = new Map(); // mesh → skin-space xform (none: file is unskinned here)

  const bodyMeshes = selectBodyMeshes(doc, previouslySkinned);
  const bounds = computeWorldBounds(doc, previouslySkinned, bodyMeshes);
  // forwardZ override: the auto-detector mis-reads forward on non-human shapes
  // (long tails, snouts, digitigrade legs), which flips the whole bind 180° and
  // produces a collapsed/twisted skeleton even when the joint markers are right.
  // The client can force the facing two ways:
  //   options.forwardZ (+1/-1) → absolute override
  //   options.flipFacing (bool) → invert whatever was auto-detected
  const detectedForwardZ = detectForwardZ(doc, bounds, previouslySkinned, bodyMeshes);
  let forwardZ = detectedForwardZ;
  if (options.forwardZ === 1 || options.forwardZ === -1) forwardZ = options.forwardZ;
  else if (options.flipFacing) forwardZ = -detectedForwardZ;
  if (forwardZ !== detectedForwardZ) {
    console.log(`[autorig] forwardZ overridden by client: ${detectedForwardZ} → ${forwardZ}`);
  }
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
  const hasOverride = (options.forwardZ === 1 || options.forwardZ === -1) || options.flipFacing;
  const fwdSign = hasOverride ? forwardZ : (toeFwd !== 0 ? Math.sign(toeFwd) : forwardZ);
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
  appendTwistJoints(joints, H);
  appendFingerJoints(joints, H);
  const jointOrder = getJointOrder(options.fingerCount || 5);
  const { worldRots, localRots } = computeJointRotations(joints, flip, jointOrder);

  // For a -Z-facing mesh the skeleton root is rotated 180° about Y so the bind
  // pose matches the character's actual forward. The actual world rotation of
  // every joint must include that flip when we compute local offsets and the
  // inverse bind matrices — otherwise W_bind·IBM ≠ identity and the mesh is
  // deformed/rotated at rest.
  const r180y = [0, 1, 0, 0];
  const bindWorldRots = {};
  for (const name of jointOrder) {
    bindWorldRots[name] = flip ? qNormalize(qMul(r180y, worldRots[name])) : worldRots[name];
  }

  const glbBuffer = root.listBuffers()[0] || doc.createBuffer();
  const jointNodes = new Map();
  for (const name of jointOrder) {
    const parentName = HIERARCHY[name];
    const world = joints[name];
    let localT;
    if (parentName) {
      const p = joints[parentName];
      const d = [world[0] - p[0], world[1] - p[1], world[2] - p[2]];
      // Convert world-space offset to parent's LOCAL space so the joint node
      // hierarchy reproduces the intended world positions exactly. Use the
      // parent's actual bind world rotation (including the -Z flip).
      localT = rotateVec3(d, qInvert(bindWorldRots[parentName]));
    } else {
      localT = world.slice();
    }
    const node = doc.createNode(name)
      .setTranslation(localT)
      .setRotation(localRots[name]);
    jointNodes.set(name, node);
    if (parentName) jointNodes.get(parentName).addChild(node);
  }
  const scene = root.getDefaultScene() || root.listScenes()[0];
  scene.addChild(jointNodes.get('Hips'));

  // ── 3. Inverse bind matrices ───────────────────────────────────────────────
  // W_bind = T(p)·R. IBM = inv(W_bind) = R⁻¹·T(-p).
  // Use bindWorldRots so the IBM matches the node's actual world rotation after
  // the optional -Z root flip. This keeps W_bind·IBM = identity at rest.
  const ibmData = new Float32Array(jointOrder.length * 16);
  jointOrder.forEach((name, i) => {
    const W = composeMat4(joints[name], bindWorldRots[name], [1, 1, 1]);
    const IBM = invertRigidMat4(W);
    ibmData.set(IBM, i * 16);
  });
  const ibmAcc = doc.createAccessor('autorig_ibm')
    .setType('MAT4')
    .setArray(ibmData)
    .setBuffer(glbBuffer);

  const skin = doc.createSkin('AutoRigSkin').setInverseBindMatrices(ibmAcc);
  jointOrder.forEach(name => skin.addJoint(jointNodes.get(name)));
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
  const segList = jointOrder.map(name => segments[name]);
  const boneSide = jointOrder.map(name =>
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

  const nB = segList.length;
  const boneIndex = Object.fromEntries(jointOrder.map((n, i) => [n, i]));

  for (const mesh of bakedMeshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      const count = arr.length / 3;
      const indices = prim.getIndices()?.getArray() || null;

      // ── Heat-diffusion skin weights ────────────────────────────────────────
      // Bone sources are pinned to 1.0 and diffused over the welded mesh graph.
      // This produces geometry-aware blending that follows the surface instead
      // of crossing through empty space. Rigid anatomical zones are blended in
      // afterwards to keep the head, hands, feet and torso core from warping.
      const weldEps = 1e-4 * H;
      const adjacency = buildVertexAdjacency(arr, indices, weldEps);

      const { field, sourceMask } = computeBoneSources(arr, segList, boneSide, leftAxis, leftAxisValid, centerAtY, H, jointOrder);
      diffuseWeightField(field, nB, adjacency, sourceMask, 40, 0.5);

      const zoneField = computeRigidZones(arr, joints, boneIndex, H);
      blendRigidZones(field, zoneField, nB, 0.85);

      // Run Laplacian smoothing to make all bone weight boundaries perfectly organic and soft
      smoothWeightField(field, nB, adjacency, 5, 0.4, sourceMask);

      // ── Reduce to top-4 influences + normalize ─────────────────────────────
      const jointsOut = new Uint8Array(count * 4);
      const weightsOut = new Float32Array(count * 4);
      // Precompute nearest bone per vertex for the zero-weight fallback.
      const nearestBone = new Uint8Array(count);
      for (let v = 0; v < count; v++) {
        const p = [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];
        let nb = 0, nd = Infinity;
        for (let b = 0; b < nB; b++) {
          const d = distPointSegment(p, segList[b][0], segList[b][1]);
          if (d < nd) { nd = d; nb = b; }
        }
        nearestBone[v] = nb;
      }

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
        // Safety fallback for vertices that escaped every source and zone:
        // Use smooth distance-based inverse square falloff for top 4 closest bones.
        if (total <= 0) {
          const dists = [];
          const p = [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];
          const ctr = centerAtY(p[1]);
          const sd = leftAxisValid
            ? (p[0] - ctr[0]) * leftAxis[0] + (p[1] - ctr[1]) * leftAxis[1] + (p[2] - ctr[2]) * leftAxis[2]
            : p[0] - ctr[0];
          const sideMargin = 0.02 * H;

          for (let b = 0; b < nB; b++) {
            const side = boneSide[b];
            let gate = 1;
            if (side !== 0) {
              const signed = side * sd;
              const g = (signed + sideMargin) / (2 * sideMargin);
              gate = g <= 0 ? 0 : g >= 1 ? 1 : g * g * (3 - 2 * g);
            }
            let d = distPointSegment(p, segList[b][0], segList[b][1]);
            if (gate <= 0) {
              d = Infinity;
            } else {
              d /= Math.max(1e-4, gate);
            }
            dists.push({ index: b, dist: d });
          }
          dists.sort((x, y) => x.dist - y.dist);
          let dTotal = 0;
          const limit = Math.min(4, dists.length);
          for (let k = 0; k < limit; k++) {
            const dVal = Math.max(1e-4, dists[k].dist);
            // Ignore infinite distances
            const w = dVal === Infinity ? 0 : 1.0 / (dVal * dVal);
            best[k] = [dists[k].index, w];
            dTotal += w;
          }
          total = dTotal;
        }
        for (let k = 0; k < 4; k++) {
          const [b, w] = best[k];
          jointsOut[v * 4 + k] = b >= 0 ? b : 0;
          weightsOut[v * 4 + k] = total > 0 && b >= 0 ? w / total : 0;
        }
      }

      // Carve out mid-limb weight for twist bones so they actually deform skin.
      for (const twistName of jointOrder.filter(n => /Twist$/.test(n))) {
        const parentName = CHILD_OF[twistName];
        redistributeTwistWeights(arr, jointsOut, weightsOut, boneIndex[parentName], boneIndex[twistName], segments[parentName], H);
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
