#!/usr/bin/env node

/**
 * GLB Animation Merger & Optimizer
 *
 * Combines animations from an animations GLB file into a character GLB file.
 * Maps animation channels to character bones using name matching (Mixamo).
 * Strips redundant meshes, skins, and nodes from the animation source.
 *
 * Retargeting uses world-space change-of-basis:
 *   C = inv(Wchar) · Wanim
 *   q_final = rChar · C · inv(rAnim) · qKeyframe · inv(C)
 *
 * For same-convention skeletons (pure Mixamo→Mixamo) C≈identity → direct copy.
 * For skeletons re-exported from BabylonJS (baked coordinate frames) C correctly
 * compensates — no A-pose correction is applied (that was the source of distortion).
 */

import fs from 'fs-extra';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, unpartition, draco as dracoCompress, resample } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

// ============================================================================
// CONFIGURATION
// ============================================================================
const SKELETON_SOURCE = 'character';

// Discard scale channels on all bones (prevents stretching)
const IGNORE_SCALE = true;
// Discard translation on non-root bones (prevents limb stretching)
const IGNORE_NON_ROOT_TRANSLATION = true;

// ── MANUAL POSTURE ADJUSTMENTS ────────────────────────────────────────────
// Manual per-bone yaw offset (degrees). Leave at 0 if not needed.
const ARM_SPREAD_ANGLE = 0;
const LEG_SPREAD_ANGLE = 0;

// Per-bone rotation offsets applied AFTER retargeting (in degrees: [pitch, yaw, roll]).
// Bone names must be LOWERCASE and match the CHARACTER skeleton (Mixamo names).
const POSE_OFFSETS = {
  // e.g., 'mixamorig:leftshoulder': [0, 0, 0]
};

// Compress the output with Draco + Resample (reduces file size significantly)
const COMPRESS_OUTPUT = true;
// ============================================================================

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let charPath = '', animPath = '', outputPath = '';
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '-c' || args[i] === '--character') && args[i + 1]) { charPath = args[++i]; }
  else if ((args[i] === '-a' || args[i] === '--animations') && args[i + 1]) { animPath = args[++i]; }
  else if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) { outputPath = args[++i]; }
}
charPath = charPath || '../assets/character.glb';
animPath = animPath || './assets//animations.glb';
outputPath = outputPath || '../assets/character_animated.glb';

// ── Bone name mapping ───────────────────────────────────────────────────────
const BONE_MAP = {
  // ── Root / Spine ───────────────────────────────────
  'pelvis': ['hips', 'mixamorig:hips', 'hip', 'root', 'hips_joint'],
  'spine_01': ['spine', 'mixamorig:spine', 'spine_a', 'spinea', 'lowerback'],
  'spine_02': ['spine1', 'mixamorig:spine1', 'spine_b', 'spineb', 'midspine'],
  'spine_03': ['spine2', 'mixamorig:spine2', 'chest', 'upperchest', 'upperbody'],
  'neck_01': ['neck', 'mixamorig:neck', 'neck1'],
  'neck_02': ['neck1', 'mixamorig:neck1'],
  'head': ['head', 'mixamorig:head'],
  // ── Left arm ───────────────────────────────────
  'clavicle_l': ['leftshoulder', 'mixamorig:leftshoulder', 'leftcollar', 'leftclavicle',
    'collar_l', 'l_shoulder', 'shoulder_l', 'shoulderl'],
  'upperarm_l': ['leftarm', 'mixamorig:leftarm', 'leftupperarm', 'l_upperarm', 'upperarm_l',
    'upperarml', 'arm_l', 'arml', 'left_arm', 'l_arm'],
  'lowerarm_l': ['leftforearm', 'mixamorig:leftforearm', 'leftlowerarm', 'l_lowerarm',
    'lowerarm_l', 'lowerarml', 'forearm_l', 'forearml', 'left_forearm'],
  'hand_l': ['lefthand', 'mixamorig:lefthand', 'l_hand', 'handl', 'hand_l'],
  // ── Right arm ──────────────────────────────────
  'clavicle_r': ['rightshoulder', 'mixamorig:rightshoulder', 'rightcollar', 'rightclavicle',
    'collar_r', 'r_shoulder', 'shoulder_r', 'shoulderr'],
  'upperarm_r': ['rightarm', 'mixamorig:rightarm', 'rightupperarm', 'r_upperarm', 'upperarm_r',
    'upperarmr', 'arm_r', 'armr', 'right_arm', 'r_arm'],
  'lowerarm_r': ['rightforearm', 'mixamorig:rightforearm', 'rightlowerarm', 'r_lowerarm',
    'lowerarm_r', 'lowerarmr', 'forearm_r', 'forearmr', 'right_forearm'],
  'hand_r': ['righthand', 'mixamorig:righthand', 'r_hand', 'handr', 'hand_r'],
  // ── Left leg ───────────────────────────────────
  'thigh_l': ['leftupleg', 'mixamorig:leftupleg', 'leftupperleg', 'l_thigh', 'thigh_l',
    'thighl', 'l_upleg', 'leftthigh', 'left_upleg', 'hip_l', 'hipl'],
  'calf_l': ['leftleg', 'mixamorig:leftleg', 'leftlowerleg', 'l_calf', 'calf_l',
    'calfl', 'shinl', 'shin_l', 'leftcalf', 'left_leg', 'l_knee'],
  'foot_l': ['leftfoot', 'mixamorig:leftfoot', 'l_foot', 'footl', 'leftankle', 'ankle_l'],
  'toe_l': ['lefttoebase', 'mixamorig:lefttoebase', 'l_toe', 'toel', 'lefttoe'],
  'ball_l': ['lefttoebase', 'mixamorig:lefttoebase', 'l_ball', 'balll'],
  // ── Right leg ─────────────────────────────────
  'thigh_r': ['rightupleg', 'mixamorig:rightupleg', 'rightupperleg', 'r_thigh', 'thigh_r',
    'thighr', 'r_upleg', 'rightthigh', 'right_upleg', 'hip_r', 'hipr'],
  'calf_r': ['rightleg', 'mixamorig:rightleg', 'rightlowerleg', 'r_calf', 'calf_r',
    'calfr', 'shinr', 'shin_r', 'rightcalf', 'right_leg', 'r_knee'],
  'foot_r': ['rightfoot', 'mixamorig:rightfoot', 'r_foot', 'footr', 'rightankle', 'ankle_r'],
  'toe_r': ['righttoebase', 'mixamorig:righttoebase', 'r_toe', 'toer', 'righttoe'],
  'ball_r': ['righttoebase', 'mixamorig:righttoebase', 'r_ball', 'ballr'],
  // ── Fingers (Left) ──────────────────────────────
  'thumb_01_l': ['lefthandthumb1', 'mixamorig:lefthandthumb1', 'thumb1l', 'l_thumb1'],
  'thumb_02_l': ['lefthandthumb2', 'mixamorig:lefthandthumb2', 'thumb2l', 'l_thumb2'],
  'thumb_03_l': ['lefthandthumb3', 'mixamorig:lefthandthumb3', 'thumb3l', 'l_thumb3'],
  'index_01_l': ['lefthandindex1', 'mixamorig:lefthandindex1', 'index1l', 'l_index1'],
  'index_02_l': ['lefthandindex2', 'mixamorig:lefthandindex2', 'index2l', 'l_index2'],
  'index_03_l': ['lefthandindex3', 'mixamorig:lefthandindex3', 'index3l', 'l_index3'],
  'middle_01_l': ['lefthandmiddle1', 'mixamorig:lefthandmiddle1', 'middle1l', 'l_middle1'],
  'middle_02_l': ['lefthandmiddle2', 'mixamorig:lefthandmiddle2', 'middle2l', 'l_middle2'],
  'middle_03_l': ['lefthandmiddle3', 'mixamorig:lefthandmiddle3', 'middle3l', 'l_middle3'],
  'ring_01_l': ['lefthandring1', 'mixamorig:lefthandring1', 'ring1l', 'l_ring1'],
  'ring_02_l': ['lefthandring2', 'mixamorig:lefthandring2', 'ring2l', 'l_ring2'],
  'ring_03_l': ['lefthandring3', 'mixamorig:lefthandring3', 'ring3l', 'l_ring3'],
  'pinky_01_l': ['lefthandpinky1', 'mixamorig:lefthandpinky1', 'pinky1l', 'l_pinky1'],
  'pinky_02_l': ['lefthandpinky2', 'mixamorig:lefthandpinky2', 'pinky2l', 'l_pinky2'],
  'pinky_03_l': ['lefthandpinky3', 'mixamorig:lefthandpinky3', 'pinky3l', 'l_pinky3'],
  // ── Fingers (Right) ─────────────────────────────
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function stripBJSSuffix(name) {
  if (!name) return name;
  return name.replace(/_\d+$/, '');
}

function normalizeName(name) {
  if (!name) return '';
  let n = stripBJSSuffix(name).toLowerCase();
  n = n.replace(/^j_?bip_?([lr])_?/i, '$1_');
  n = n.replace(/^(mixamorig\d*|armature|char|bi|bip\d+|biped|def[-_]?|root|gltf_created_\d+_)\b[:_ ]*/i, '');
  n = n.replace(/\.([lr])$/i, '$1');
  n = n.replace(/[:_\-\.\s]/g, '');
  return n;
}

// Quaternion helpers
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

/** Build child→parent map. */
function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) {
      map.set(child, node);
    }
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
function vec3Add([x1, y1, z1], [x2, y2, z2]) {
  return [x1 + x2, y1 + y2, z1 + z2];
}
function vec3Subtract([x1, y1, z1], [x2, y2, z2]) {
  return [x1 - x2, y1 - y2, z1 - z2];
}
function vec3Normalize([x, y, z]) {
  const len = Math.sqrt(x * x + y * y + z * z);
  return len > 0 ? [x / len, y / len, z / len] : [0, 0, 0];
}
function vec3Cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function vec3Dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vec3Length(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
function quatNormalize(q) {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return len > 0 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [0, 0, 0, 1];
}
function quatFromTwoVectors(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.99999) {
    let axis = vec3Cross(a, [1, 0, 0]);
    if (vec3Length(axis) < 0.0001) {
      axis = vec3Cross(a, [0, 1, 0]);
    }
    axis = vec3Normalize(axis);
    return [axis[0], axis[1], axis[2], 0];
  }
  if (dot > 0.99999) {
    return [0, 0, 0, 1];
  }
  const cross = vec3Cross(a, b);
  const q = [cross[0], cross[1], cross[2], 1 + dot];
  return quatNormalize(q);
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
  const yVal = dir[1];

  if (yVal > -0.22 && yVal < 0.22) {
    return 'T-POSE';
  } else if (yVal <= -0.22 && yVal >= -0.75) {
    return 'A-POSE';
  }
  return 'CUSTOM';
}

function adjustToVirtualTPose(doc, charByName, charByNorm, charWorldRots) {
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

  // Compute initial world transforms
  for (const node of doc.getRoot().listNodes()) {
    getTransforms(node);
  }

  // Copy initial world rotations
  const worldRotT = new Map();
  for (const node of doc.getRoot().listNodes()) {
    worldRotT.set(node, rotations.get(node) || [0, 0, 0, 1]);
  }

  // Find arm bones
  const leftArm = findMatchingBone({ getName: () => 'leftarm' }, charByName, charByNorm);
  const leftForearm = findMatchingBone({ getName: () => 'leftforearm' }, charByName, charByNorm);
  let leftHand = findMatchingBone({ getName: () => 'lefthand' }, charByName, charByNorm);
  if (!leftHand && leftForearm) {
    const children = leftForearm.listChildren();
    if (children.length > 0) leftHand = children[0];
  }

  const rightArm = findMatchingBone({ getName: () => 'rightarm' }, charByName, charByNorm);
  const rightForearm = findMatchingBone({ getName: () => 'rightforearm' }, charByName, charByNorm);
  let rightHand = findMatchingBone({ getName: () => 'righthand' }, charByName, charByNorm);
  if (!rightHand && rightForearm) {
    const children = rightForearm.listChildren();
    if (children.length > 0) rightHand = children[0];
  }

  // Helper for recursive descendants list
  function getDescendants(node, list = []) {
    list.push(node);
    for (const child of node.listChildren()) {
      getDescendants(child, list);
    }
    return list;
  }

  // Helper to apply world rotation correction to a node and its descendants
  function applyCorrection(rootNode, qCorr) {
    const descendants = getDescendants(rootNode);
    for (const desc of descendants) {
      const wrot = worldRotT.get(desc) || [0, 0, 0, 1];
      worldRotT.set(desc, qMul(qCorr, wrot));
    }
  }

  // 1. Left Arm
  if (leftArm && leftForearm) {
    const pArm = positions.get(leftArm);
    const pFore = positions.get(leftForearm);
    if (pArm && pFore) {
      const vArm = vec3Normalize(vec3Subtract(pFore, pArm));
      const qAlignArm = quatFromTwoVectors(vArm, [1, 0, 0]);
      applyCorrection(leftArm, qAlignArm);

      // Now Left Forearm
      let vForeOriginal = null;
      if (leftHand) {
        const pHand = positions.get(leftHand);
        if (pHand) vForeOriginal = vec3Normalize(vec3Subtract(pHand, pFore));
      }
      if (!vForeOriginal) {
        vForeOriginal = vArm;
      }
      const vForeUpdated = rotateVec3(vForeOriginal, qAlignArm);
      const qAlignFore = quatFromTwoVectors(vForeUpdated, [1, 0, 0]);
      applyCorrection(leftForearm, qAlignFore);
    }
  }

  // 2. Right Arm
  if (rightArm && rightForearm) {
    const pArm = positions.get(rightArm);
    const pFore = positions.get(rightForearm);
    if (pArm && pFore) {
      const vArm = vec3Normalize(vec3Subtract(pFore, pArm));
      const qAlignArm = quatFromTwoVectors(vArm, [-1, 0, 0]);
      applyCorrection(rightArm, qAlignArm);

      // Now Right Forearm
      let vForeOriginal = null;
      if (rightHand) {
        const pHand = positions.get(rightHand);
        if (pHand) vForeOriginal = vec3Normalize(vec3Subtract(pHand, pFore));
      }
      if (!vForeOriginal) {
        vForeOriginal = vArm;
      }
      const vForeUpdated = rotateVec3(vForeOriginal, qAlignArm);
      const qAlignFore = quatFromTwoVectors(vForeUpdated, [-1, 0, 0]);
      applyCorrection(rightForearm, qAlignFore);
    }
  }

  // Compute local rotations in virtual T-pose
  const localRotT = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const parent = parentMap.get(node);
    const wrot = worldRotT.get(node) || [0, 0, 0, 1];
    if (parent) {
      const pwrot = worldRotT.get(parent) || [0, 0, 0, 1];
      localRotT.set(node, qMul(qInvert(pwrot), wrot));
    } else {
      localRotT.set(node, wrot);
    }
  }

  return { worldRotT, localRotT };
}

/** Compute world-space quaternion for every node. */
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

function invertRigidMat4(m) {
  const R00 = m[0], R10 = m[1], R20 = m[2];
  const R01 = m[4], R11 = m[5], R21 = m[6];
  const R02 = m[8], R12 = m[9], R22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  return new Float32Array([
    R00, R01, R02, 0,
    R10, R11, R12, 0,
    R20, R21, R22, 0,
    -(R00 * tx + R10 * ty + R20 * tz),
    -(R01 * tx + R11 * ty + R21 * tz),
    -(R02 * tx + R12 * ty + R22 * tz),
    1,
  ]);
}

function mat4RotToQuat(m) {
  const m00 = m[0], m10 = m[1], m20 = m[2];
  const m01 = m[4], m11 = m[5], m21 = m[6];
  const m02 = m[8], m12 = m[9], m22 = m[10];
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
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  return len > 0 ? [x / len, y / len, z / len, w / len] : [0, 0, 0, 1];
}

/**
 * Extract bind pose from skin IBMs.
 * W_j_bind = inv(IBM_j), L_j = IBM_parent * inv(IBM_j)
 * Handles BJS re-exports with non-T-pose baked into node rotations.
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
  return null;
async function main() {
  console.log('==================================================');
  console.log('       GLB ANIMATION MERGER & OPTIMIZER           ');
  console.log('==================================================');
  console.log(`Character:  ${charPath}`);
  console.log(`Animations: ${animPath}`);
  console.log(`Output:     ${outputPath}`);
  console.log(`Mode:       ${SKELETON_SOURCE.toUpperCase()} (world-space retarget, no A-pose correction)`);
  console.log('--------------------------------------------------');

  if (!(await fs.pathExists(charPath))) { console.error(`Missing: ${charPath}`); process.exit(1); }
  if (!(await fs.pathExists(animPath))) { console.error(`Missing: ${animPath}`); process.exit(1); }
  await fs.ensureDir(path.dirname(outputPath));

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  console.log('Loading documents...');
  const charDoc = await io.read(charPath);
  const animDoc = await io.read(animPath);

  // Build character lookup tables early
  const charByName = new Map();
  const charByNorm = new Map();
  for (const node of charDoc.getRoot().listNodes()) {
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
  }

  // ── Pre-merge: compute world+local rest rotations and translations ─────────
  const charWorldRots = computeWorldRotations(charDoc);
  const animWorldRots = computeWorldRotations(animDoc);

  const poseStyle = detectPoseStyle(charDoc, charByName, charByNorm);
  console.log(`Character pose style detected: ${poseStyle}`);

  let virtualPose = null;
  if (poseStyle !== 'T-POSE') {
    console.log(`Character is not in T-pose (${poseStyle}) — generating virtual T-pose...`);
    virtualPose = adjustToVirtualTPose(charDoc, charByName, charByNorm, charWorldRots);
  }

  const charRestByName = new Map(); // lowercase → local quat
  const charWorldByName = new Map(); // lowercase → world quat

  // IBM-derived bind pose — handles BJS re-exports with non-T-pose baked into node rotations
  const { bindRotByName, bindWorldByName } = extractBindPoseFromIBMs(charDoc);

  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    
    let restRot, worldRot;
    if (virtualPose) {
      restRot = virtualPose.localRotT.get(node) || [0, 0, 0, 1];
      worldRot = virtualPose.worldRotT.get(node) || [0, 0, 0, 1];
    } else {
      restRot = bindRotByName.get(name?.toLowerCase()) || node.getRotation() || [0, 0, 0, 1];
      worldRot = bindWorldByName.get(name?.toLowerCase()) || charWorldRots.get(node) || [0, 0, 0, 1];
    }

    if (name) {
      const key = name.toLowerCase();
      charRestByName.set(key, restRot);
      charWorldByName.set(key, worldRot);
    }
  }

  const animRestByName = new Map();
  const animWorldByName = new Map();
  const animTransByName = new Map(); // for root translation delta
  const animParentNameMap = new Map();
  for (const node of animDoc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      animRestByName.set(name.toLowerCase(), node.getRotation() || [0, 0, 0, 1]);
      animWorldByName.set(name.toLowerCase(), animWorldRots.get(node) || [0, 0, 0, 1]);
      animTransByName.set(name.toLowerCase(), node.getTranslation() || [0, 0, 0]);
    }
    for (const child of node.listChildren()) {
      const cn = child.getName()?.toLowerCase();
      const pn = node.getName()?.toLowerCase();
      if (cn && pn) animParentNameMap.set(cn, pn);
    }
  }

  const charTransByName = new Map();
  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) charTransByName.set(name.toLowerCase(), node.getTranslation() || [0, 0, 0]);
  }

  // Snapshot original assets before merge
  const origNodes = new Set(charDoc.getRoot().listNodes());
  const origScenes = new Set(charDoc.getRoot().listScenes());
  const origMeshes = new Set(charDoc.getRoot().listMeshes());
  const origSkins = new Set(charDoc.getRoot().listSkins());
  const origAnims = new Set(charDoc.getRoot().listAnimations());



  console.log(`Character: ${origNodes.size} nodes, ${origMeshes.size} meshes, ${origAnims.size} anims, ${origSkins.size} skins`);

  // ── Merge ───────────────────────────────────────────────────────────────
  console.log('Merging animation document...');
  charDoc.merge(animDoc);

  let removedMixamo = 0;
  for (const anim of [...charDoc.getRoot().listAnimations()]) {
    if (anim.getName() === 'mixamo.com') {
      console.log('Removing animation: mixamo.com');
      anim.dispose();
      removedMixamo++;
    }
    if (anim.getName() === 'A_TPose') {
      console.log('Renaming animation: A_TPose → TPose');
      anim.setName('TPose');
    }
  }

  const importedAnims = charDoc.getRoot().listAnimations().filter(a => !origAnims.has(a));
  console.log(`Imported ${importedAnims.length} animations. Removed ${removedMixamo} "mixamo.com" animations.`);

  // ── MODE: character ──────────────────────────────────────────────────────
  if (SKELETON_SOURCE === 'character') {
    console.log('Retargeting animation channels to character skeleton...');
    let bound = 0, disposed = 0, unmatched = 0;

    for (const anim of importedAnims) {
      console.log(`  "${anim.getName() || '?'}"...`);
      for (const ch of anim.listChannels()) {
        const chPath = ch.getTargetPath();
        const src = ch.getTargetNode();
        if (!src || !src.getName()) { ch.dispose(); disposed++; continue; }

        if (chPath === 'scale' && IGNORE_SCALE) { ch.dispose(); disposed++; continue; }

        const target = findMatchingBone(src, charByName, charByNorm);
        if (!target) { ch.dispose(); disposed++; unmatched++; continue; }

        const tgtName = target.getName().toLowerCase();
        const srcName = src.getName().toLowerCase();
        const isRoot = tgtName.includes('hips') || tgtName.includes('pelvis') || tgtName === '__root__';

        if (chPath === 'translation' && !isRoot && IGNORE_NON_ROOT_TRANSLATION) {
          ch.dispose(); disposed++; continue;
        }

        // ── Rotation: world-space change-of-basis retarget ──────────────────
        // C = inv(Wchar) · Wanim
        // q_final = rChar · C · inv(rAnim) · qKeyframe · inv(C)
        //
        // For same-convention skeletons (pure Mixamo): Wchar≈Wanim → C≈identity → direct copy.
        // For BJS re-exported (baked coordinate frames): C correctly compensates.
        if (chPath === 'rotation') {
          const rAnim = animRestByName.get(srcName) || [0, 0, 0, 1];
          const rChar = charRestByName.get(tgtName) || [0, 0, 0, 1];
          const Wanim = animWorldByName.get(srcName) || [0, 0, 0, 1];
          const Wchar = charWorldByName.get(tgtName) || [0, 0, 0, 1];

          const C = qMul(qInvert(Wchar), Wanim);
          const Cinv = qInvert(C);
          const rAnimInv = qInvert(rAnim);

          const sampler = ch.getSampler();
          const output = sampler?.getOutput();
          const arr = output?.getArray();
          if (arr) {
            const out = new Float32Array(arr.length);
            for (let j = 0; j < arr.length; j += 4) {
              const qKey = [arr[j], arr[j + 1], arr[j + 2], arr[j + 3]];
              // delta = inv(rAnim) · qKeyframe  (anim-local delta)
              const delta = qMul(rAnimInv, qKey);
              // rotate into character space: C · delta · inv(C)
              const rotated = qMul(qMul(C, delta), Cinv);
              // apply on top of character rest
              let final = qMul(rChar, rotated);

              // Optional manual pose offsets
              let pOffset = POSE_OFFSETS[tgtName] ? [...POSE_OFFSETS[tgtName]] : [0, 0, 0];
              if (ARM_SPREAD_ANGLE !== 0) {
                if (tgtName.includes('leftshoulder') || tgtName.includes('leftarm')) {
                  pOffset[1] += ARM_SPREAD_ANGLE;
                } else if (tgtName.includes('rightshoulder') || tgtName.includes('rightarm')) {
                  pOffset[1] -= ARM_SPREAD_ANGLE;
                }
              }
              if (LEG_SPREAD_ANGLE !== 0) {
                if (tgtName.includes('leftupleg') || tgtName.includes('leftthigh')) {
                  pOffset[1] -= LEG_SPREAD_ANGLE;
                } else if (tgtName.includes('rightupleg') || tgtName.includes('rightthigh')) {
                  pOffset[1] += LEG_SPREAD_ANGLE;
                }
              }
              if (pOffset[0] !== 0 || pOffset[1] !== 0 || pOffset[2] !== 0) {
                final = qMul(final, eulerToQuat(pOffset[0], pOffset[1], pOffset[2]));
              }

              out[j] = final[0]; out[j + 1] = final[1]; out[j + 2] = final[2]; out[j + 3] = final[3];
            }
            output.setArray(out);
          }
        }

        // ── Root translation: simple delta remap ─────────────────────────────
        if (chPath === 'translation' && isRoot) {
          const animRest = animTransByName.get(srcName) || [0, 0, 0];
          const charRest = charTransByName.get(tgtName) || [0, 0, 0];
          const output = ch.getSampler()?.getOutput();
          const arr = output?.getArray();
          if (arr) {
            const out = new Float32Array(arr.length);
            for (let j = 0; j < arr.length; j += 3) {
              out[j] = charRest[0] + arr[j] - animRest[0];
              out[j + 1] = charRest[1] + arr[j + 1] - animRest[1];
              out[j + 2] = charRest[2] + arr[j + 2] - animRest[2];
            }
            output.setArray(out);
          }
        }

        ch.setTargetNode(target);
        bound++;
      }
    }
    console.log(`Retargeting done: ${bound} bound, ${disposed} disposed, ${unmatched} unmatched.`);

    // Dispose all imported nodes/meshes/skins (character keeps its own)
    for (const node of charDoc.getRoot().listNodes()) {
      if (!origNodes.has(node)) node.dispose();
    }
    for (const mesh of charDoc.getRoot().listMeshes()) {
      if (!origMeshes.has(mesh)) mesh.dispose();
    }
    for (const skin of charDoc.getRoot().listSkins()) {
      if (!origSkins.has(skin)) skin.dispose();
    }
  }

  // Dispose imported scenes
  for (const scene of charDoc.getRoot().listScenes()) {
    if (!origScenes.has(scene)) scene.dispose();
  }

  console.log('Pruning unused data...');
  await charDoc.transform(prune());
  console.log('Consolidating buffers...');
  await charDoc.transform(unpartition());

  if (COMPRESS_OUTPUT) {
    console.log('Applying animation resampling and Draco mesh compression...');
    await charDoc.transform(
      resample(),
      dracoCompress(),
    );
  }

  // Flatten RootNode: promote children directly to scene
  console.log('Flattening RootNode...');
  for (const scene of charDoc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      if (node.getName() !== 'RootNode') continue;
      for (const child of node.listChildren()) {
        scene.addChild(child);
      }
      node.dispose();
    }
  }

  console.log(`Writing: ${outputPath}...`);
  const buf = await io.writeBinary(charDoc);
  await fs.writeFile(outputPath, buf);

  // Generate animation name list
  const animationNames = charDoc
    .getRoot()
    .listAnimations()
    .map(anim => anim.getName() || 'UnnamedAnimation')
    .filter(name => name.trim() !== '');

  const txtPath = outputPath.replace(/\.glb$/i, '_animations.txt');
  await fs.writeFile(txtPath, animationNames.join('\n'), 'utf8');
  console.log(`Animation list saved: ${txtPath}`);

  console.log('==================================================');
  console.log(` 🎉 DONE! Output: ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log('==================================================');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
