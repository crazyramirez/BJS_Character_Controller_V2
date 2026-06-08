/**
 * merge_api.mjs
 * 
 * Exportable module wrapping the core logic of merge_animations.mjs.
 * Used by server.mjs to run GLB merges and analysis without spawning a subprocess.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, unpartition, draco as dracoCompress, resample } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

// ============================================================================
// CONFIGURATION DEFAULTS (can be overridden per-call via options)
// ============================================================================
const DEFAULTS = {
  SKELETON_SOURCE: 'character',
  IGNORE_SCALE: true,
  IGNORE_NON_ROOT_TRANSLATION: true,
  // Manual per-bone rotation offsets (degrees). Override for fine-tuning.
  // ARM_SPREAD_ANGLE / LEG_SPREAD_ANGLE are now only used as manual overrides.
  // Set ARM_SPREAD_ANGLE to a non-zero value to manually override auto A-pose correction.
  ARM_SPREAD_ANGLE: 0,
  LEG_SPREAD_ANGLE: 0,
  POSE_OFFSETS: {},
  COMPRESS_OUTPUT: true,
  // A-pose correction is disabled: the world-space change-of-basis C = inv(Wchar)·Wanim
  // already handles A-pose (and any other baked coordinate frame) correctly on its own.
  // Enabling this can corrupt the C matrix for characters re-exported from BabylonJS.
  AUTO_APOSE_CORRECTION: false,
  APOSE_THRESHOLD_DEG: 15,
};

/// ── Bone name mapping ──────────────────────────────────────────────────────
//
// Each key is a canonical Mixamo-normalized bone name.
// Each value is a list of aliases from other skeleton conventions.
// Conventions covered:
//   UE5 (Mannequin/MetaHuman): upperarm_l, lowerarm_l, thigh_l, calf_l ...
//   Unity Humanoid:            leftupperarm, leftlowerarm, leftshoulder ...
//   VRM/VRoid (normalized):    leftupperarm, leftupperleg ... (after j_bip strip)
//   Rigify (Blender):          upperarm.l, forearm.l (dots become blanks after normalize)
//   RPM / Generic Mixamo:      leftarm, leftforearm, hips ...
//   3ds Max Biped:             bip001 l upperarm (prefix stripped by normalizeName)
//
const BONE_MAP = {
  // ── Root / Spine ────────────────────────────────────────
  'pelvis':    ['hips', 'mixamorig:hips', 'hip', 'root', 'hips_joint', 'pelvis_joint'],
  'spine_01':  ['spine', 'mixamorig:spine', 'spine_a', 'spinea', 'lower_back', 'lowerback'],
  'spine_02':  ['spine1', 'mixamorig:spine1', 'spine_b', 'spineb', 'midspine'],
  'spine_03':  ['spine2', 'mixamorig:spine2', 'chest', 'upperchest', 'upperspine', 'upperbody'],
  'neck_01':   ['neck', 'mixamorig:neck', 'neck1'],
  'neck_02':   ['neck1', 'mixamorig:neck1'],
  'head':      ['head', 'mixamorig:head'],

  // ── Left arm ──────────────────────────────────────────
  //   UE5: clavicle_l    Unity: leftshoulder    Rigify: shoulderl (after normalize)
  'clavicle_l': ['leftshoulder', 'mixamorig:leftshoulder', 'leftcollar', 'leftclavicle',
                 'collar_l', 'l_shoulder', 'shoulder_l', 'shoulderl'],
  //   UE5: upperarm_l    Unity: leftupperarm    Rigify: upperarml
  'upperarm_l': ['leftarm', 'mixamorig:leftarm', 'leftupperarm', 'l_upperarm', 'upperarm_l',
                 'upperarml', 'arm_l', 'arml', 'left_arm', 'l_arm'],
  //   UE5: lowerarm_l    Unity: leftlowerarm    Rigify: forearml
  'lowerarm_l': ['leftforearm', 'mixamorig:leftforearm', 'leftlowerarm', 'l_lowerarm',
                 'lowerarm_l', 'lowerarml', 'forearm_l', 'forearml', 'left_forearm'],
  'hand_l':    ['lefthand', 'mixamorig:lefthand', 'l_hand', 'handl', 'hand_l'],

  // ── Right arm ─────────────────────────────────────────
  'clavicle_r': ['rightshoulder', 'mixamorig:rightshoulder', 'rightcollar', 'rightclavicle',
                 'collar_r', 'r_shoulder', 'shoulder_r', 'shoulderr'],
  'upperarm_r': ['rightarm', 'mixamorig:rightarm', 'rightupperarm', 'r_upperarm', 'upperarm_r',
                 'upperarmr', 'arm_r', 'armr', 'right_arm', 'r_arm'],
  'lowerarm_r': ['rightforearm', 'mixamorig:rightforearm', 'rightlowerarm', 'r_lowerarm',
                 'lowerarm_r', 'lowerarmr', 'forearm_r', 'forearmr', 'right_forearm'],
  'hand_r':    ['righthand', 'mixamorig:righthand', 'r_hand', 'handr', 'hand_r'],

  // ── Left leg ──────────────────────────────────────────
  //   UE5: thigh_l       Unity: leftupperleg    Rigify: thighl
  'thigh_l':   ['leftupleg', 'mixamorig:leftupleg', 'leftupperleg', 'l_thigh', 'thigh_l',
                'thighl', 'l_upleg', 'leftthigh', 'left_upleg', 'hip_l', 'hipl'],
  //   UE5: calf_l        Unity: leftlowerleg    Rigify: shinl
  'calf_l':    ['leftleg', 'mixamorig:leftleg', 'leftlowerleg', 'l_calf', 'calf_l',
                'calfl', 'shinl', 'shin_l', 'leftcalf', 'left_leg', 'l_knee'],
  'foot_l':    ['leftfoot', 'mixamorig:leftfoot', 'l_foot', 'footl', 'leftankle', 'ankle_l'],
  'toe_l':     ['lefttoebase', 'mixamorig:lefttoebase', 'l_toe', 'toel', 'lefttoe'],
  'ball_l':    ['lefttoebase', 'mixamorig:lefttoebase', 'l_ball', 'balll'],

  // ── Right leg ────────────────────────────────────────
  'thigh_r':   ['rightupleg', 'mixamorig:rightupleg', 'rightupperleg', 'r_thigh', 'thigh_r',
                'thighr', 'r_upleg', 'rightthigh', 'right_upleg', 'hip_r', 'hipr'],
  'calf_r':    ['rightleg', 'mixamorig:rightleg', 'rightlowerleg', 'r_calf', 'calf_r',
                'calfr', 'shinr', 'shin_r', 'rightcalf', 'right_leg', 'r_knee'],
  'foot_r':    ['rightfoot', 'mixamorig:rightfoot', 'r_foot', 'footr', 'rightankle', 'ankle_r'],
  'toe_r':     ['righttoebase', 'mixamorig:righttoebase', 'r_toe', 'toer', 'righttoe'],
  'ball_r':    ['righttoebase', 'mixamorig:righttoebase', 'r_ball', 'ballr'],

  // ── Fingers ────────────────────────────────────────────
  'thumb_01_l': ['lefthandthumb1', 'mixamorig:lefthandthumb1', 'thumb1l', 'l_thumb1', 'thumbproximall'],
  'thumb_02_l': ['lefthandthumb2', 'mixamorig:lefthandthumb2', 'thumb2l', 'l_thumb2', 'thumbintermediatel'],
  'thumb_03_l': ['lefthandthumb3', 'mixamorig:lefthandthumb3', 'thumb3l', 'l_thumb3', 'thumbdistall'],
  'index_01_l': ['lefthandindex1', 'mixamorig:lefthandindex1', 'index1l', 'l_index1', 'indexproximall'],
  'index_02_l': ['lefthandindex2', 'mixamorig:lefthandindex2', 'index2l', 'l_index2', 'indexintermediatel'],
  'index_03_l': ['lefthandindex3', 'mixamorig:lefthandindex3', 'index3l', 'l_index3', 'indexdistall'],
  'middle_01_l': ['lefthandmiddle1', 'mixamorig:lefthandmiddle1', 'middle1l', 'l_middle1'],
  'middle_02_l': ['lefthandmiddle2', 'mixamorig:lefthandmiddle2', 'middle2l', 'l_middle2'],
  'middle_03_l': ['lefthandmiddle3', 'mixamorig:lefthandmiddle3', 'middle3l', 'l_middle3'],
  'ring_01_l': ['lefthandring1', 'mixamorig:lefthandring1', 'ring1l', 'l_ring1'],
  'ring_02_l': ['lefthandring2', 'mixamorig:lefthandring2', 'ring2l', 'l_ring2'],
  'ring_03_l': ['lefthandring3', 'mixamorig:lefthandring3', 'ring3l', 'l_ring3'],
  'pinky_01_l': ['lefthandpinky1', 'mixamorig:lefthandpinky1', 'pinky1l', 'l_pinky1', 'littleproximal'],
  'pinky_02_l': ['lefthandpinky2', 'mixamorig:lefthandpinky2', 'pinky2l', 'l_pinky2'],
  'pinky_03_l': ['lefthandpinky3', 'mixamorig:lefthandpinky3', 'pinky3l', 'l_pinky3'],
  'thumb_01_r': ['righthandthumb1', 'mixamorig:righthandthumb1', 'thumb1r', 'r_thumb1'],
  'thumb_02_r': ['righthandthumb2', 'mixamorig:righthandthumb2', 'thumb2r', 'r_thumb2'],
  'thumb_03_r': ['righthandthumb3', 'mixamorig:righthandthumb3', 'thumb3r', 'r_thumb3'],
  'index_01_r': ['righthandindex1', 'mixamorig:righthandindex1', 'index1r', 'r_index1'],
  'index_02_r': ['righthandindex2', 'mixamorig:righthandindex2', 'index2r', 'r_index2'],
  'index_03_r': ['righthandindex3', 'mixamorig:righthandindex3', 'index3r', 'r_index3'],
  'middle_01_r': ['righthandmiddle1', 'mixamorig:righthandmiddle1', 'middle1r', 'r_middle1'],
  'middle_02_r': ['righthandmiddle2', 'mixamorig:righthandmiddle2', 'middle2r', 'r_middle2'],
  'middle_03_r': ['righthandmiddle3', 'mixamorig:righthandmiddle3', 'middle3r', 'r_middle3'],
  'ring_01_r': ['righthandring1', 'mixamorig:righthandring1', 'ring1r', 'r_ring1'],
  'ring_02_r': ['righthandring2', 'mixamorig:righthandring2', 'ring2r', 'r_ring2'],
  'ring_03_r': ['righthandring3', 'mixamorig:righthandring3', 'ring3r', 'r_ring3'],
  'pinky_01_r': ['righthandpinky1', 'mixamorig:righthandpinky1', 'pinky1r', 'r_pinky1'],
  'pinky_02_r': ['righthandpinky2', 'mixamorig:righthandpinky2', 'pinky2r', 'r_pinky2'],
  'pinky_03_r': ['righthandpinky3', 'mixamorig:righthandpinky3', 'pinky3r', 'r_pinky3'],
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Strip trailing numeric suffix added by BJS GLTF importer (e.g. Hips_66 → Hips)
 * Also strips dot-suffixes used in Blender (thigh.L → thighL handled downstream)
 */
function stripBJSSuffix(name) {
  if (!name) return name;
  return name.replace(/_\d+$/, '');
}

/**
 * Canonical bone id: lowercase, remove common rig prefixes and separators.
 * Handles:
 *   - Mixamo:  mixamorig:LeftArm       → leftarm
 *   - UE5:     upperarm_l              → upperarml
 *   - Unity:   LeftUpperArm            → leftupperarm
 *   - VRM:     J_Bip_L_UpperArm        → leftupperarm  (l/r mapped to left/right)
 *   - Rigify:  DEF-upper_arm.L         → upperarml (dots+dashes stripped)
 *   - Biped:   Bip001 L UpperArm       → lupperarm (prefix stripped)
 *   - BJS:     LeftArm_27              → leftarm (numeric suffix stripped first)
 */
function normalizeName(name) {
  if (!name) return '';
  let n = stripBJSSuffix(name).toLowerCase();

  // VRM: J_Bip_L_UpperArm → l_upperarm, J_Bip_R_UpperArm → r_upperarm
  n = n.replace(/^j_?bip_?([lr])_?/i, '$1_');

  // Common rig prefixes to strip  (mixamorig, bip001, def-, etc.)
  n = n.replace(/^(mixamorig\d*|armature|char|bi|bip\d+|biped|def[-_]?|root|gltf_created_\d+_)\b[:_ ]*/i, '');

  // Rigify/Blender: .L / .R side suffix → l / r (keep for later)
  n = n.replace(/\.([lr])$/i, '$1');

  // UE5 / generic: side suffix _l / _r at END of token → keep as-is, remove separators next
  // Strip remaining separators so 'upper_arm_l' → 'upperarml'
  n = n.replace(/[:_\-\.\s]/g, '');

  return n;
}

// ── Skeleton type fingerprinting ─────────────────────────────────────────────

/**
 * Known skeleton conventions.
 * Each entry: { id, label, color, signatures }
 * signatures: array of bone-name patterns (lowercased, stripped) that must ALL be present.
 */
const SKELETON_TYPES = [
  {
    id: 'mixamo',
    label: 'Mixamo',
    color: '#f97316',
    // Mixamo uses 'mixamorig:' prefix or clean Mixamo names
    test: (names) =>
      names.some(n => n.includes('mixamorig')) ||
      (names.some(n => n === 'hips' || n === 'hips') &&
        names.some(n => n === 'leftupleg' || n === 'leftarm')),
  },
  {
    id: 'unreal',
    label: 'Unreal Engine',
    color: '#0ea5e9',
    test: (names) =>
      names.some(n => n === 'pelvis') &&
      (names.some(n => n === 'spine01' || n === 'spine_01') ||
        names.some(n => n === 'thighl' || n === 'thigh_l')),
  },
  {
    id: 'unity',
    label: 'Unity Humanoid',
    color: '#6366f1',
    test: (names) =>
      names.some(n => n === 'hips') &&
      (names.some(n => n === 'leftupperleg' || n === 'rightupperleg') ||
        names.some(n => n === 'leftshoulder' && n === 'spine')),
  },
  {
    id: 'vrm',
    label: 'VRM / VRoid',
    color: '#a855f7',
    test: (names) =>
      names.some(n => n.startsWith('j_bip') || n.startsWith('jbip')) ||
      names.some(n => n.includes('_bip_') || n.includes('vrm')),
  },
  {
    id: 'rpm',
    label: 'Ready Player Me',
    color: '#ec4899',
    test: (names) =>
      names.some(n => n === 'armature' || n === 'avatarroot' || n === 'avatarhead') ||
      (names.some(n => n === 'hips') && names.some(n => n === 'leftshoulder') &&
        names.some(n => n.includes('lefthand') || n === 'lefthandindex1')),
  },
  {
    id: 'rigify',
    label: 'Rigify (Blender)',
    color: '#f59e0b',
    test: (names) =>
      (names.some(n => n.includes('thighl') && n.startsWith('thigh')) &&
        names.some(n => n.includes('upperarml'))) ||
      names.some(n => n === 'deftorso' || n === 'defspine' || n.startsWith('def')),
  },
  {
    id: 'biped',
    label: 'Biped / 3ds Max',
    color: '#14b8a6',
    test: (names) =>
      names.some(n => n.startsWith('bip') && (n.includes('pelvis') || n.includes('spine'))),
  },
];

/**
 * Detect skeleton convention from a list of raw bone names.
 * Returns { id, label, color } or a generic unknown entry.
 */
function detectSkeletonType(rawNames) {
  // Normalize for matching (strip BJS suffix + lowercase + remove separators)
  const normed = rawNames.map(n => normalizeName(n));

  for (const type of SKELETON_TYPES) {
    if (type.test(normed)) return { id: type.id, label: type.label, color: type.color };
  }

  // Fallback heuristics
  if (normed.some(n => n === 'hips' || n === 'pelvis')) {
    return { id: 'humanoid', label: 'Generic Humanoid', color: '#6ee7b7' };
  }
  if (normed.some(n => n === 'root' || n === 'armature')) {
    return { id: 'custom', label: 'Custom Rig', color: '#9ca3af' };
  }
  return { id: 'unknown', label: 'Unknown Rig', color: '#6b7280' };
}

function vec3Subtract([x1, y1, z1], [x2, y2, z2]) {
  return [x1 - x2, y1 - y2, z1 - z2];
}

function vec3Normalize([x, y, z]) {
  const len = Math.sqrt(x * x + y * y + z * z);
  return len > 0 ? [x / len, y / len, z / len] : [0, 0, 0];
}

function vec3Add([x1, y1, z1], [x2, y2, z2]) {
  return [x1 + x2, y1 + y2, z1 + z2];
}

function detectPoseStyle(doc, charByName, charByNorm) {
  const parentMap = buildParentMap(doc);
  const rotations = new Map();
  const positions = new Map();

  function getTransforms(node) {
    if (rotations.has(node)) return { rot: rotations.get(node), pos: positions.get(node) };

    const localRot = node.getRotation() || [0, 0, 0, 1];
    const localPos = node.getTranslation() || [0, 0, 0];

    const parent = parentMap.get(node);
    if (parent) {
      const parentTransforms = getTransforms(parent);
      const worldRot = qMul(parentTransforms.rot, localRot);
      const worldPos = vec3Add(parentTransforms.pos, rotateVec3(localPos, parentTransforms.rot));
      rotations.set(node, worldRot);
      positions.set(node, worldPos);
      return { rot: worldRot, pos: worldPos };
    } else {
      rotations.set(node, localRot);
      positions.set(node, localPos);
      return { rot: localRot, pos: localPos };
    }
  }

  for (const node of doc.getRoot().listNodes()) {
    getTransforms(node);
  }

  const leftArm = findMatchingBone({ getName: () => 'leftarm' }, charByName, charByNorm);
  const leftForearm = findMatchingBone({ getName: () => 'leftforearm' }, charByName, charByNorm);

  if (!leftArm || !leftForearm) return 'UNKNOWN';

  const posArm = positions.get(leftArm);
  const posForearm = positions.get(leftForearm);

  if (!posArm || !posForearm) return 'UNKNOWN';

  const dir = vec3Normalize(vec3Subtract(posForearm, posArm));
  const yVal = dir[1]; // y component

  if (yVal > -0.22 && yVal < 0.22) {
    return 'T-POSE';
  } else if (yVal <= -0.22 && yVal >= -0.75) {
    return 'A-POSE';
  }
  return 'CUSTOM';
}

function qInvert([x, y, z, w]) { return [-x, -y, -z, w]; }
function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
  return [
    x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2,
    y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
    z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}
function eulerToQuat(pitch, yaw, roll) {
  const p = (pitch * Math.PI / 180) / 2;
  const y = (yaw * Math.PI / 180) / 2;
  const r = (roll * Math.PI / 180) / 2;
  const sp = Math.sin(p), cp = Math.cos(p);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sr = Math.sin(r), cr = Math.cos(r);
  return [
    sp * cy * cr + cp * sy * sr,
    cp * sy * cr - sp * cy * sr,
    cp * cy * sr + sp * sy * cr,
    cp * cy * cr - sp * sy * sr,
  ];
}
function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) map.set(child, node);
  }
  return map;
}
function rotateVec3([x, y, z], [qx, qy, qz, qw]) {
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
function computeWorldRotations(doc) {
  const parentMap = buildParentMap(doc);
  const cache = new Map();
  function get(node) {
    if (cache.has(node)) return cache.get(node);
    const local = node.getRotation() || [0, 0, 0, 1];
    const parent = parentMap.get(node);
    const world = parent ? qMul(get(parent), local) : local;
    cache.set(node, world);
    return world;
  }
  for (const node of doc.getRoot().listNodes()) get(node);
  return cache;
}

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

// Invert a rigid-body (rotation + translation, no scale) column-major 4x4 matrix
function invertRigidMat4(m) {
  const R00=m[0], R10=m[1], R20=m[2];
  const R01=m[4], R11=m[5], R21=m[6];
  const R02=m[8], R12=m[9], R22=m[10];
  const tx=m[12], ty=m[13], tz=m[14];
  return new Float32Array([
    R00, R01, R02, 0,
    R10, R11, R12, 0,
    R20, R21, R22, 0,
    -(R00*tx + R10*ty + R20*tz),
    -(R01*tx + R11*ty + R21*tz),
    -(R02*tx + R12*ty + R22*tz),
    1,
  ]);
}

// Extract rotation quaternion from a column-major 4x4 matrix (Shepperd method)
function mat4RotToQuat(m) {
  const m00=m[0], m10=m[1], m20=m[2];
  const m01=m[4], m11=m[5], m21=m[6];
  const m02=m[8], m12=m[9], m22=m[10];
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const len = Math.sqrt(x*x + y*y + z*z + w*w);
  return len > 0 ? [x/len, y/len, z/len, w/len] : [0, 0, 0, 1];
}

/**
 * Extract bind pose rotations from skin Inverse Bind Matrices.
 * Returns per-bone local and world bind quaternions derived from IBMs, not node rotations.
 * This correctly handles BJS re-exports where non-T-pose is baked into node rotations.
 *
 * Math: IBM_j = inv(W_j_bind), so W_j_bind = inv(IBM_j).
 * Local bind: L_j = inv(W_parent_bind) * W_j_bind = IBM_parent * inv(IBM_j)
 */
function extractBindPoseFromIBMs(doc) {
  const bindRotByName = new Map();
  const bindWorldByName = new Map();
  const parentMap = buildParentMap(doc);

  for (const skin of doc.getRoot().listSkins()) {
    const joints = skin.listJoints();
    const ibmAcc = skin.getInverseBindMatrices();
    if (!ibmAcc || joints.length === 0) continue;

    const ibmArray = ibmAcc.getArray();
    if (!ibmArray) continue;

    const jointIndex = new Map();
    joints.forEach((j, i) => jointIndex.set(j, i));
    const jointSet = new Set(joints);

    for (let i = 0; i < joints.length; i++) {
      if (i * 16 + 16 > ibmArray.length) break;
      const joint = joints[i];
      const name = joint.getName();
      if (!name) continue;

      const ibm_i = ibmArray.slice(i * 16, i * 16 + 16);
      const W_bind = invertRigidMat4(ibm_i);
      const worldRot = mat4RotToQuat(W_bind);

      const key = name.toLowerCase();
      bindWorldByName.set(key, worldRot);
      const stripped = stripBJSSuffix(name);
      if (stripped !== name) bindWorldByName.set(stripped.toLowerCase(), worldRot);

      // Find nearest ancestor that is also a skin joint
      let parent = parentMap.get(joint);
      while (parent && !jointSet.has(parent)) parent = parentMap.get(parent);

      let localRot;
      if (parent && jointIndex.has(parent)) {
        const pi = jointIndex.get(parent);
        const ibm_p = ibmArray.slice(pi * 16, pi * 16 + 16);
        localRot = mat4RotToQuat(mat4Mul(ibm_p, W_bind));
      } else {
        localRot = worldRot;
      }

      bindRotByName.set(key, localRot);
      if (stripped !== name) bindRotByName.set(stripped.toLowerCase(), localRot);
    }
  }

  return { bindRotByName, bindWorldByName };
}
function findMatchingBone(animNode, charByName, charByNorm) {
  const src = animNode.getName();
  if (!src) return null;
  const lo = src.toLowerCase();
  let hit = charByName.get(src) || charByName.get(lo);
  if (hit) return hit;
  const mapEntry = BONE_MAP[lo];
  if (mapEntry) {
    for (const alt of mapEntry) {
      hit = charByName.get(alt) || charByName.get(alt.toLowerCase());
      if (hit) return hit;
    }
  }
  for (const [key, alts] of Object.entries(BONE_MAP)) {
    if (alts.includes(lo)) {
      hit = charByName.get(key) || charByName.get(key.toLowerCase());
      if (hit) return hit;
    }
  }
  const norm = normalizeName(src);
  hit = charByNorm.get(norm);
  if (hit) return hit;
  for (const [n, node] of charByNorm) {
    if (norm.endsWith(n) || n.endsWith(norm)) return node;
  }
  console.log(`[findMatchingBone] Failed to find match for anim bone: "${src}" (normalized: "${norm}")`);
  return null;
}

// ── Create shared IO instance ────────────────────────────────────────────────
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

// ============================================================================
// PUBLIC API
// ============================================================================

// Synthetic root joints injected by GLTF exporters/BJS — skip from display
const SYNTHETIC_ROOTS = /^(gltf_created_\d+_rootjoint|armature|root|rig|deformationrig)$/i;

/**
 * Analyze a GLB binary and return its skeleton bones, skeleton type, and animation names.
 * Handles all major skeleton conventions: Mixamo, Unreal, Unity, VRM, RPM, Rigify, Biped.
 * Strips BJS-appended numeric suffixes (_N) for clean display names.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{
 *   bones: Array<{name:string, cleanName:string, depth:number, children:string[], isRoot:boolean}>,
 *   rootBones: string[],
 *   animations: string[],
 *   hasSkin: boolean,
 *   boneCount: number,
 *   skeletonType: {id:string, label:string, color:string}
 * }}
 */
export async function analyzeGLB(buffer) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buffer));

  const parentMap = buildParentMap(doc);

  // ── 1. Collect bone nodes from all skins ──────────────────────────────────
  const boneNodes = new Set();
  for (const skin of doc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) boneNodes.add(joint);
  }

  const hasSkin = boneNodes.size > 0;

  // If no skin, fall back: every node that has a parent or children (i.e., part of a hierarchy)
  let relevantNodes;
  if (hasSkin) {
    relevantNodes = [...boneNodes];
  } else {
    // No skin — look for hierarchy nodes, exclude leaf meshes
    const allNodes = doc.getRoot().listNodes();
    relevantNodes = allNodes.filter(n => {
      const hasChildren = n.listChildren().length > 0;
      const hasParent = parentMap.has(n);
      return hasChildren || hasParent;
    });
  }

  // ── 2. Build depth map ────────────────────────────────────────────────────
  const depthMap = new Map();
  function getDepth(node) {
    if (depthMap.has(node)) return depthMap.get(node);
    const parent = parentMap.get(node);
    // Don't count synthetic root joints toward depth
    const parentIsSynthetic = parent && SYNTHETIC_ROOTS.test(parent.getName() || '');
    const d = (!parent || parentIsSynthetic) ? 0 : getDepth(parent) + 1;
    depthMap.set(node, d);
    return d;
  }

  // ── 3. Build bone list ────────────────────────────────────────────────────
  const nodeSet = new Set(relevantNodes);

  const bones = relevantNodes.map(node => {
    const rawName = node.getName() || '(unnamed)';
    const cleanName = stripBJSSuffix(rawName); // remove BJS _N suffix for display
    const depth = getDepth(node);
    const parent = parentMap.get(node);
    const isRoot = !parent || !nodeSet.has(parent) || SYNTHETIC_ROOTS.test(parent.getName() || '');

    const children = node.listChildren()
      .filter(c => !hasSkin || boneNodes.has(c))
      .map(c => stripBJSSuffix(c.getName() || '(unnamed)'));

    return { name: rawName, cleanName, depth, children, isRoot };
  });

  // Sort by depth so tree renders top-down
  bones.sort((a, b) => a.depth - b.depth || a.cleanName.localeCompare(b.cleanName));

  const rootBones = bones.filter(b => b.isRoot && !SYNTHETIC_ROOTS.test(b.cleanName));

  // ── 4. Skeleton type detection ────────────────────────────────────────────
  const rawNames = bones.map(b => b.name);
  const skeletonType = detectSkeletonType(rawNames);

  const charByName = new Map();
  const charByNorm = new Map();
  relevantNodes.forEach(node => {
    const name = node.getName();
    if (name) {
      charByName.set(name, node);
      charByName.set(name.toLowerCase(), node);
      const stripped = stripBJSSuffix(name);
      if (stripped !== name) {
        charByName.set(stripped, node);
        charByName.set(stripped.toLowerCase(), node);
      }
      const n = normalizeName(name);
      if (n) charByNorm.set(n, node);
    }
  });
  const poseStyle = detectPoseStyle(doc, charByName, charByNorm);

  // ── 5. Animations ─────────────────────────────────────────────────────────
  const animations = doc.getRoot().listAnimations()
    .map(a => a.getName() || 'Unnamed')
    .filter(n => !/t[_-]?pose/i.test(n) && n !== 'mixamo.com');

  // Filter out synthetic root joint bones from display list
  const displayBones = bones.filter(b => !SYNTHETIC_ROOTS.test(b.cleanName));

  return {
    bones: displayBones,
    rootBones: rootBones.map(b => b.cleanName),
    animations,
    hasSkin,
    boneCount: displayBones.length,
    skeletonType,
    poseStyle,
  };
}

/**
 * Merge animations from animBuffer into charBuffer and return the merged GLB as a Buffer.
 * @param {Buffer|Uint8Array} charBuffer   — base character GLB
 * @param {Buffer|Uint8Array} animBuffer   — animations GLB
 * @param {object} [options]               — overrides for merge config
 * @returns {Buffer}
 */
export async function mergeGLBs(charBuffer, animBuffer, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const io = await getIO();

  const charDoc = await io.readBinary(new Uint8Array(charBuffer));

  if (cfg.removeExistingAnimations) {
    charDoc.getRoot().listAnimations().forEach(anim => anim.dispose());
  }

  // If no animation buffer is provided, serialize and return the cleaned character directly
  if (!animBuffer || animBuffer.byteLength === 0) {
    if (cfg.COMPRESS_OUTPUT) {
      await charDoc.transform(unpartition(), prune());
    }
    return io.writeBinary(charDoc);
  }

  const animDoc = await io.readBinary(new Uint8Array(animBuffer));

  // Print bone names for debugging matching
  console.log('--- DEBUG BONE NAMES ---');
  const charJointNames = [];
  for (const skin of charDoc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) charJointNames.push(joint.getName());
  }
  console.log(`[debug] Character bone names (first 20): ${JSON.stringify(charJointNames.slice(0, 20))}`);
  console.log(`[debug] Total character bones: ${charJointNames.length}`);

  const animJointNames = [];
  for (const skin of animDoc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) animJointNames.push(joint.getName());
  }
  console.log(`[debug] Animation bone names (first 20): ${JSON.stringify(animJointNames.slice(0, 20))}`);
  console.log(`[debug] Total animation bones: ${animJointNames.length}`);
  console.log('------------------------');

  // Pre-merge analysis
  const charWorldRots = computeWorldRotations(charDoc);
  const animWorldRots = computeWorldRotations(animDoc);

  const charRestByName = new Map();
  const charWorldByName = new Map();
  // Also index by node reference for quick parent→world lookup
  const charWorldByNode = new Map();

  // IBM-derived bind pose — handles BJS re-exports with non-T-pose baked into node rotations
  const { bindRotByName, bindWorldByName } = extractBindPoseFromIBMs(charDoc);

  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    const wrot = charWorldRots.get(node) || [0, 0, 0, 1];
    if (name) {
      const key = name.toLowerCase();
      charRestByName.set(key, bindRotByName.get(key) || node.getRotation() || [0, 0, 0, 1]);
      charWorldByName.set(key, bindWorldByName.get(key) || wrot);
    }
    charWorldByNode.set(node, wrot);
  }

  const animRestByName = new Map();
  const animWorldByName = new Map();
  const animParentNameMap = new Map();
  for (const node of animDoc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      animRestByName.set(name.toLowerCase(), node.getRotation() || [0, 0, 0, 1]);
      animWorldByName.set(name.toLowerCase(), animWorldRots.get(node) || [0, 0, 0, 1]);
    }
    for (const child of node.listChildren()) {
      const cn = child.getName()?.toLowerCase();
      const pn = node.getName()?.toLowerCase();
      if (cn && pn) animParentNameMap.set(cn, pn);
    }
  }

  const origNodes = new Set(charDoc.getRoot().listNodes());
  const origScenes = new Set(charDoc.getRoot().listScenes());
  const origMeshes = new Set(charDoc.getRoot().listMeshes());
  const origSkins = new Set(charDoc.getRoot().listSkins());
  const origAnims = new Set(charDoc.getRoot().listAnimations());

  const charByName = new Map();
  const charByNorm = new Map();
  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      charByName.set(name, node);
      charByName.set(name.toLowerCase(), node);
      // Also index by BJS-suffix-stripped name so e.g. 'Hips_66' maps to 'Hips'
      const stripped = stripBJSSuffix(name);
      if (stripped !== name) {
        charByName.set(stripped, node);
        charByName.set(stripped.toLowerCase(), node);
      }
      const n = normalizeName(name);
      if (n) charByNorm.set(n, node);
    }
  }

  // ── A-pose detection ──────────────────────────────────────────────────────
  // Measure how far the character's arms droop from horizontal.
  // Used to decide whether to apply A-pose correction during retargeting.
  let _armDroopDeg = 0;
  try {
    const preParentMap = buildParentMap(charDoc);
    const prePositions = new Map();
    const preRotations = new Map();
    function _getPreTransforms(node) {
      if (preRotations.has(node)) return;
      const lr = node.getRotation() || [0, 0, 0, 1];
      const lp = node.getTranslation() || [0, 0, 0];
      const parent = preParentMap.get(node);
      if (parent) {
        _getPreTransforms(parent);
        preRotations.set(node, qMul(preRotations.get(parent), lr));
        prePositions.set(node, vec3Add(prePositions.get(parent), rotateVec3(lp, preRotations.get(parent))));
      } else {
        preRotations.set(node, lr);
        prePositions.set(node, lp);
      }
    }
    for (const node of charDoc.getRoot().listNodes()) _getPreTransforms(node);

    const leftArm  = findMatchingBone({ getName: () => 'leftarm' }, charByName, charByNorm);
    const leftFore = findMatchingBone({ getName: () => 'leftforearm' }, charByName, charByNorm);
    if (leftArm && leftFore) {
      const pA = prePositions.get(leftArm);
      const pF = prePositions.get(leftFore);
      if (pA && pF) {
        const dir = vec3Normalize(vec3Subtract(pF, pA));
        _armDroopDeg = Math.asin(-Math.min(1, Math.max(-1, dir[1]))) * (180 / Math.PI);
        console.log(`[merge] Detected arm droop: ${_armDroopDeg.toFixed(1)}° ${_armDroopDeg > cfg.APOSE_THRESHOLD_DEG ? '→ A-pose correction enabled' : '→ near T-pose, no correction needed'}`);
      }
    }
  } catch (err) {
    console.warn('[merge] Failed to detect arm pose:', err);
  }

  const _applyAposeCorrectionGlobal = cfg.AUTO_APOSE_CORRECTION && _armDroopDeg > cfg.APOSE_THRESHOLD_DEG;

  // Merge
  console.log(`[merge] charDoc anims BEFORE merge: ${charDoc.getRoot().listAnimations().map(a => a.getName()).join(', ')}`);
  console.log(`[merge] animDoc anims: ${animDoc.getRoot().listAnimations().map(a => a.getName()).join(', ')}`);
  charDoc.merge(animDoc);
  console.log(`[merge] charDoc anims AFTER merge: ${charDoc.getRoot().listAnimations().map(a => a.getName()).join(', ')}`);

  // Remove junk animations
  for (const anim of [...charDoc.getRoot().listAnimations()]) {
    if (anim.getName() === 'mixamo.com') { anim.dispose(); continue; }
    if (anim.getName() === 'A_TPose') anim.setName('TPose');
  }

  const importedAnims = charDoc.getRoot().listAnimations().filter(a => !origAnims.has(a));
  console.log(`[merge] importedAnims (${importedAnims.length}): ${importedAnims.map(a => a.getName()).join(', ')}`);

  // Retarget
  if (cfg.SKELETON_SOURCE === 'character') {
    const charParentMap = buildParentMap(charDoc);

    for (const anim of importedAnims) {
      for (const ch of anim.listChannels()) {
        const path = ch.getTargetPath();
        const src = ch.getTargetNode();
        if (!src || !src.getName()) { ch.dispose(); continue; }
        if (path === 'scale' && cfg.IGNORE_SCALE) { ch.dispose(); continue; }

        const target = findMatchingBone(src, charByName, charByNorm);
        if (!target) { ch.dispose(); continue; }

        const tgtName = target.getName().toLowerCase();
        const srcName = src.getName().toLowerCase();
        const isRoot = tgtName.includes('hips') || tgtName.includes('pelvis') || tgtName === '__root__';

        if (path === 'translation' && !isRoot && cfg.IGNORE_NON_ROOT_TRANSLATION) { ch.dispose(); continue; }

        if (path === 'rotation') {
          const rAnim = animRestByName.get(srcName) || [0, 0, 0, 1];
          const rChar = charRestByName.get(tgtName) || [0, 0, 0, 1];
          const Wanim = animWorldByName.get(srcName) || [0, 0, 0, 1];
          let Wchar = charWorldByName.get(tgtName) || [0, 0, 0, 1];

          // ── A-pose correction ────────────────────────────────────────────
          // When the character is in A-pose, its world rotation for arm bones
          // encodes the droop angle into C, which distorts the retargeted motion.
          // Fix: for upper arm and forearm bones, walk up to the nearest
          // shoulder/clavicle ancestor and use THAT world rotation as Wchar.
          // This makes C ≈ identity for same-convention (Mixamo→Mixamo) pairs,
          // so the animation's relative motion transfers correctly.
          // Shoulder/clavicle bones are NOT corrected (they're the reference).
          //
          // Arm-bone patterns covered (after normalizeName / lowercase raw):
          //   Mixamo/RPM:  leftarm, leftforearm
          //   UE5:         upperarm_l, lowerarm_l
          //   Unity:       leftupperarm, leftlowerarm
          //   Rigify:      upperarml, forearml
          const _isForearm = /leftforearm|rightforearm|lowerarm[_]?[lr]|forearm[_]?[lr]|forearml|forearmr|lowerarml|lowerarmr/.test(tgtName);
          const _isUpperArm = !_isForearm && /leftarm|rightarm|upperarm[_]?[lr]|upperarml|upperarmr|arm[_]?[lr]|arml$|armr$/.test(tgtName);

          if (_applyAposeCorrectionGlobal && (_isUpperArm || _isForearm)) {
            // Walk up parent chain to nearest shoulder/clavicle/collar bone
            // Shoulder ancestor patterns:
            //   Mixamo/RPM: leftshoulder, rightshoulder
            //   UE5:        clavicle_l, clavicle_r
            //   Unity:      leftcollar, rightcollar
            //   Generic:    collar, clavicle, shoulderblade
            let ancestor = charParentMap.get(target);
            while (ancestor) {
              const aName = (ancestor.getName() || '').toLowerCase();
              const isShoulderLike = aName.includes('shoulder') || aName.includes('clavicle')
                || aName.includes('collar') || aName.includes('clavicle_l')
                || aName.includes('clavicle_r');
              if (isShoulderLike) {
                const shoulderWorld = charWorldByNode.get(ancestor);
                if (shoulderWorld) Wchar = shoulderWorld;
                break;
              }
              // Safety: stop at spine/chest level to avoid going too far up
              const isSpineLike = aName.includes('spine') || aName.includes('chest')
                || aName.includes('pelvis') || aName.includes('hips');
              if (isSpineLike) break;
              ancestor = charParentMap.get(ancestor);
            }
          }
          // ────────────────────────────────────────────────────────────────

          const C = qMul(qInvert(Wchar), Wanim);
          const Cinv = qInvert(C);
          const rAnimInv = qInvert(rAnim);

          const sampler = ch.getSampler();
          if (sampler) {
            const output = sampler.getOutput();
            if (output) {
              const arr = output.getArray();
              if (arr) {
                const out = new Float32Array(arr.length);
                for (let j = 0; j < arr.length; j += 4) {
                  const qKey = [arr[j], arr[j + 1], arr[j + 2], arr[j + 3]];
                  const delta = qMul(rAnimInv, qKey);
                  const rotated = qMul(qMul(C, delta), Cinv);
                  let final = qMul(rChar, rotated);

                  // Manual per-bone overrides (POSE_OFFSETS and legacy spread angles)
                  let pOffset = [0, 0, 0];
                  if (cfg.POSE_OFFSETS[tgtName]) pOffset = [...cfg.POSE_OFFSETS[tgtName]];
                  if (cfg.ARM_SPREAD_ANGLE !== 0) {
                    if (tgtName.includes('leftshoulder') || tgtName.includes('leftarm')) pOffset[1] += cfg.ARM_SPREAD_ANGLE;
                    else if (tgtName.includes('rightshoulder') || tgtName.includes('rightarm')) pOffset[1] -= cfg.ARM_SPREAD_ANGLE;
                  }
                  if (cfg.LEG_SPREAD_ANGLE !== 0) {
                    if (tgtName.includes('leftupleg') || tgtName.includes('leftthigh')) pOffset[1] -= cfg.LEG_SPREAD_ANGLE;
                    else if (tgtName.includes('rightupleg') || tgtName.includes('rightthigh')) pOffset[1] += cfg.LEG_SPREAD_ANGLE;
                  }

                  if (pOffset[0] !== 0 || pOffset[1] !== 0 || pOffset[2] !== 0) {
                    final = qMul(final, eulerToQuat(pOffset[0], pOffset[1], pOffset[2]));
                  }
                  out[j] = final[0]; out[j + 1] = final[1]; out[j + 2] = final[2]; out[j + 3] = final[3];
                }
                output.setArray(out);
              }
            }
          }
        }

        if (path === 'translation' && isRoot) {
          const srcParentName = animParentNameMap.get(srcName);
          const WanimP = srcParentName ? (animWorldByName.get(srcParentName) || [0, 0, 0, 1]) : [0, 0, 0, 1];
          const charParent = charParentMap.get(target);
          const WcharP = charParent ? (charWorldByName.get(charParent.getName()?.toLowerCase()) || [0, 0, 0, 1]) : [0, 0, 0, 1];
          const Cp = qMul(qInvert(WcharP), WanimP);
          const animRestLocal = src.getTranslation() || [0, 0, 0];
          const charRest = target.getTranslation() || [0, 0, 0];
          const animRestWorld = rotateVec3(animRestLocal, Cp);
          const output = ch.getSampler()?.getOutput();
          const arr = output?.getArray();
          if (arr) {
            const out = new Float32Array(arr.length);
            for (let j = 0; j < arr.length; j += 3) {
              const kw = rotateVec3([arr[j], arr[j + 1], arr[j + 2]], Cp);
              out[j] = charRest[0] + kw[0] - animRestWorld[0];
              out[j + 1] = charRest[1] + kw[1] - animRestWorld[1];
              out[j + 2] = charRest[2] + kw[2] - animRestWorld[2];
            }
            output.setArray(out);
          }
        }

        ch.setTargetNode(target);
      }
    }

    // Dispose imported nodes/meshes/skins
    for (const node of charDoc.getRoot().listNodes()) { if (!origNodes.has(node)) node.dispose(); }
    for (const mesh of charDoc.getRoot().listMeshes()) { if (!origMeshes.has(mesh)) mesh.dispose(); }
    for (const skin of charDoc.getRoot().listSkins()) { if (!origSkins.has(skin)) skin.dispose(); }
    console.log(`[merge] Anims after retarget+dispose: ${charDoc.getRoot().listAnimations().map(a => `${a.getName()}(${a.listChannels().length}ch)`).join(', ')}`);
  }

  for (const scene of charDoc.getRoot().listScenes()) { if (!origScenes.has(scene)) scene.dispose(); }

  await charDoc.transform(prune());
  console.log(`[merge] Anims after prune: ${charDoc.getRoot().listAnimations().map(a => a.getName()).join(', ')}`);
  await charDoc.transform(unpartition());

  if (cfg.COMPRESS_OUTPUT) {
    await charDoc.transform(resample(), dracoCompress());
  }

  // Flatten RootNode
  for (const scene of charDoc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      if (node.getName() !== 'RootNode') continue;
      for (const child of node.listChildren()) scene.addChild(child);
      node.dispose();
    }
  }

  const buf = await io.writeBinary(charDoc);
  return Buffer.from(buf);
}
