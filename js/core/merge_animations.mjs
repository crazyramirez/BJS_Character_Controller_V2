#!/usr/bin/env node

/**
 * GLB Animation Merger & Optimizer
 * 
 * Combines animations from an animations GLB file into a character GLB file.
 * Maps animation channels to character bones using name matching (Mixamo ↔ UE/Unity).
 * Strips redundant meshes, skins, and nodes from the animation source.
 * 
 * Mode 'character': Keeps character skeleton, retargets rotation keyframes via
 *   world-space change-of-basis so the coordinate-system difference between
 *   the animation skeleton and the character skeleton is corrected automatically.
 */

import fs from 'fs-extra';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, unpartition, draco as dracoCompress, quantize, resample } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

// ============================================================================
// CONFIGURATION
// ============================================================================
const SKELETON_SOURCE = 'character';

// Discard scale channels on all bones (prevents stretching)
const IGNORE_SCALE = true;
// Discard translation on non-root bones (prevents limb stretching)
const IGNORE_NON_ROOT_TRANSLATION = true;

// ── EASY POSTURE ADJUSTMENTS ─────────────────────────────────────────────
// Manual per-bone yaw offset (degrees). Set to non-zero to manually tweak arm spread.
// Leave at 0 when AUTO_APOSE_CORRECTION is true (recommended).
const ARM_SPREAD_ANGLE = 0;
const LEG_SPREAD_ANGLE = 0;

// Automatically correct A-pose characters (arms drooped > APOSE_THRESHOLD_DEG).
// Uses parent bone world rotation for the change-of-basis C matrix on arm/forearm bones.
const AUTO_APOSE_CORRECTION = true;
const APOSE_THRESHOLD_DEG = 15;

// Per-bone rotation offsets applied AFTER retargeting (in degrees: [pitch, yaw, roll]).
// Use this for custom per-bone tweaks. Values are added on top of ARM_SPREAD_ANGLE / LEG_SPREAD_ANGLE.
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

// ── Bone name mapping ───────────────────────────────────────────────
// Shared with merge_api.mjs — covers Mixamo, RPM, UE5, Unity, VRM, Rigify.
const BONE_MAP = {
  // ── Root / Spine ───────────────────────────────────
  'pelvis':    ['hips', 'mixamorig:hips', 'hip', 'root', 'hips_joint'],
  'spine_01':  ['spine', 'mixamorig:spine', 'spine_a', 'spinea', 'lowerback'],
  'spine_02':  ['spine1', 'mixamorig:spine1', 'spine_b', 'spineb', 'midspine'],
  'spine_03':  ['spine2', 'mixamorig:spine2', 'chest', 'upperchest', 'upperbody'],
  'neck_01':   ['neck', 'mixamorig:neck', 'neck1'],
  'neck_02':   ['neck1', 'mixamorig:neck1'],
  'head':      ['head', 'mixamorig:head'],
  // ── Left arm ───────────────────────────────────
  'clavicle_l': ['leftshoulder', 'mixamorig:leftshoulder', 'leftcollar', 'leftclavicle',
                 'collar_l', 'l_shoulder', 'shoulder_l', 'shoulderl'],
  'upperarm_l': ['leftarm', 'mixamorig:leftarm', 'leftupperarm', 'l_upperarm', 'upperarm_l',
                 'upperarml', 'arm_l', 'arml', 'left_arm', 'l_arm'],
  'lowerarm_l': ['leftforearm', 'mixamorig:leftforearm', 'leftlowerarm', 'l_lowerarm',
                 'lowerarm_l', 'lowerarml', 'forearm_l', 'forearml', 'left_forearm'],
  'hand_l':    ['lefthand', 'mixamorig:lefthand', 'l_hand', 'handl', 'hand_l'],
  // ── Right arm ──────────────────────────────────
  'clavicle_r': ['rightshoulder', 'mixamorig:rightshoulder', 'rightcollar', 'rightclavicle',
                 'collar_r', 'r_shoulder', 'shoulder_r', 'shoulderr'],
  'upperarm_r': ['rightarm', 'mixamorig:rightarm', 'rightupperarm', 'r_upperarm', 'upperarm_r',
                 'upperarmr', 'arm_r', 'armr', 'right_arm', 'r_arm'],
  'lowerarm_r': ['rightforearm', 'mixamorig:rightforearm', 'rightlowerarm', 'r_lowerarm',
                 'lowerarm_r', 'lowerarmr', 'forearm_r', 'forearmr', 'right_forearm'],
  'hand_r':    ['righthand', 'mixamorig:righthand', 'r_hand', 'handr', 'hand_r'],
  // ── Left leg ───────────────────────────────────
  'thigh_l':   ['leftupleg', 'mixamorig:leftupleg', 'leftupperleg', 'l_thigh', 'thigh_l',
                'thighl', 'l_upleg', 'leftthigh', 'left_upleg', 'hip_l', 'hipl'],
  'calf_l':    ['leftleg', 'mixamorig:leftleg', 'leftlowerleg', 'l_calf', 'calf_l',
                'calfl', 'shinl', 'shin_l', 'leftcalf', 'left_leg', 'l_knee'],
  'foot_l':    ['leftfoot', 'mixamorig:leftfoot', 'l_foot', 'footl', 'leftankle', 'ankle_l'],
  'toe_l':     ['lefttoebase', 'mixamorig:lefttoebase', 'l_toe', 'toel', 'lefttoe'],
  'ball_l':    ['lefttoebase', 'mixamorig:lefttoebase', 'l_ball', 'balll'],
  // ── Right leg ─────────────────────────────────
  'thigh_r':   ['rightupleg', 'mixamorig:rightupleg', 'rightupperleg', 'r_thigh', 'thigh_r',
                'thighr', 'r_upleg', 'rightthigh', 'right_upleg', 'hip_r', 'hipr'],
  'calf_r':    ['rightleg', 'mixamorig:rightleg', 'rightlowerleg', 'r_calf', 'calf_r',
                'calfr', 'shinr', 'shin_r', 'rightcalf', 'right_leg', 'r_knee'],
  'foot_r':    ['rightfoot', 'mixamorig:rightfoot', 'r_foot', 'footr', 'rightankle', 'ankle_r'],
  'toe_r':     ['righttoebase', 'mixamorig:righttoebase', 'r_toe', 'toer', 'righttoe'],
  'ball_r':    ['righttoebase', 'mixamorig:righttoebase', 'r_ball', 'ballr'],
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

/**
 * Strip trailing numeric suffix added by BJS GLTF importer (e.g. Hips_66 → Hips)
 * Also strips dot-suffixes used in Blender (thigh.L → thighL handled downstream)
 */
function stripBJSSuffix(name) {
  if (!name) return name;
  return name.replace(/_\d+$/, '');
}

/** Strip common prefixes and separators to produce a canonical bone id.
 * Handles Mixamo, UE5, Unity, VRM (J_Bip_L_*), Rigify (.L/.R), Biped (Bip001).
 */
function normalizeName(name) {
  if (!name) return '';
  let n = stripBJSSuffix(name).toLowerCase();
  // VRM: J_Bip_L_UpperArm → l_upperarm
  n = n.replace(/^j_?bip_?([lr])_?/i, '$1_');
  // Common prefixes (mixamorig, bip001, def-, armature, etc.)
  n = n.replace(/^(mixamorig\d*|armature|char|bi|bip\d+|biped|def[-_]?|root|gltf_created_\d+_)\b[:_ ]*/i, '');
  // Rigify/Blender: .L / .R side suffix
  n = n.replace(/\.([lr])$/i, '$1');
  // Strip remaining separators
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
/** Convert Euler angles [pitch, yaw, roll] in degrees to a quaternion. */
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

/** Build child→parent map using forward references (safe in gltf-transform). */
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


/** Compute world-space quaternion rotation for every node. */
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

// ── Vec3 helpers (used for A-pose arm droop detection) ──────────────────────
function vec3Add([a, b, c], [d, e, f]) { return [a + d, b + e, c + f]; }
function vec3Subtract([a, b, c], [d, e, f]) { return [a - d, b - e, c - f]; }
function vec3Normalize([x, y, z]) {
  const l = Math.sqrt(x * x + y * y + z * z);
  return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0];
}


/** Find a character bone that corresponds to an animation bone. */
function findMatchingBone(animNode, charByName, charByNorm) {
  const src = animNode.getName();
  if (!src) return null;
  const lo = src.toLowerCase();

  // 1. Exact / lowercase
  let hit = charByName.get(src) || charByName.get(lo);
  if (hit) return hit;

  // 2. BONE_MAP forward (anim→char)
  const mapEntry = BONE_MAP[lo];
  if (mapEntry) {
    for (const alt of mapEntry) {
      hit = charByName.get(alt) || charByName.get(alt.toLowerCase());
      if (hit) return hit;
    }
  }

  // 3. BONE_MAP reverse (char→anim names might be Mixamo)
  for (const [key, alts] of Object.entries(BONE_MAP)) {
    if (alts.includes(lo)) {
      hit = charByName.get(key) || charByName.get(key.toLowerCase());
      if (hit) return hit;
    }
  }

  // 4. Normalized
  const norm = normalizeName(src);
  hit = charByNorm.get(norm);
  if (hit) return hit;

  // 5. Suffix / contains
  for (const [n, node] of charByNorm) {
    if (norm.endsWith(n) || n.endsWith(norm)) return node;
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('==================================================');
  console.log('       GLB ANIMATION MERGER & OPTIMIZER           ');
  console.log('==================================================');
  console.log(`Character:  ${charPath}`);
  console.log(`Animations: ${animPath}`);
  console.log(`Output:     ${outputPath}`);
  console.log(`Mode:       ${SKELETON_SOURCE.toUpperCase()}`);
  console.log('--------------------------------------------------');

  if (!(await fs.pathExists(charPath))) { console.error(`Missing: ${charPath}`); process.exit(1); }
  if (!(await fs.pathExists(animPath))) { console.error(`Missing: ${animPath}`); process.exit(1); }
  await fs.ensureDir(path.dirname(outputPath));

  // I/O setup
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

  // ── Pre-merge analysis ──────────────────────────────────────────────────
  // Compute world-space rest rotations for BOTH skeletons (before merge changes parents)
  const charWorldRots = computeWorldRotations(charDoc);
  const animWorldRots = computeWorldRotations(animDoc);

  // Index character rest rotations by lowercase name
  const charRestByName = new Map(); // lowercase → local quat
  const charWorldByName = new Map(); // lowercase → world quat
  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      charRestByName.set(name.toLowerCase(), node.getRotation() || [0, 0, 0, 1]);
      charWorldByName.set(name.toLowerCase(), charWorldRots.get(node) || [0, 0, 0, 1]);
    }
  }

  // Index anim rest rotations by lowercase name
  const animRestByName = new Map();
  const animWorldByName = new Map();
  const animParentNameMap = new Map(); // child-name → parent-name (for post-merge lookup)
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

  // Snapshot original assets before merge
  const origNodes = new Set(charDoc.getRoot().listNodes());
  const origScenes = new Set(charDoc.getRoot().listScenes());
  const origMeshes = new Set(charDoc.getRoot().listMeshes());
  const origSkins = new Set(charDoc.getRoot().listSkins());
  const origAnims = new Set(charDoc.getRoot().listAnimations());

  // Build character bone lookup tables
  const charByName = new Map();
  const charByNorm = new Map();
  const charWorldByNode = new Map();
  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    const wrot = charWorldRots.get(node) || [0, 0, 0, 1];
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
    charWorldByNode.set(node, wrot);
  }

  console.log(`Character: ${origNodes.size} nodes, ${origMeshes.size} meshes, ${origAnims.size} anims, ${origSkins.size} skins`);

  // ── A-pose detection ─────────────────────────────────────────────────────
  let _armDroopDeg = 0;
  try {
    const prePositions = new Map();
    const preRotations = new Map();
    const prePM = buildParentMap(charDoc);
    function _preTrans(node) {
      if (preRotations.has(node)) return;
      const lr = node.getRotation() || [0,0,0,1];
      const lp = node.getTranslation() || [0,0,0];
      const par = prePM.get(node);
      if (par) {
        _preTrans(par);
        preRotations.set(node, qMul(preRotations.get(par), lr));
        prePositions.set(node, vec3Add(prePositions.get(par), rotateVec3(lp, preRotations.get(par))));
      } else { preRotations.set(node, lr); prePositions.set(node, lp); }
    }
    for (const n of charDoc.getRoot().listNodes()) _preTrans(n);
    const leftArm  = findMatchingBone({ getName: () => 'leftarm' }, charByName, charByNorm);
    const leftFore = findMatchingBone({ getName: () => 'leftforearm' }, charByName, charByNorm);
    if (leftArm && leftFore) {
      const pA = prePositions.get(leftArm), pF = prePositions.get(leftFore);
      if (pA && pF) {
        const dir = vec3Normalize(vec3Subtract(pF, pA));
        _armDroopDeg = Math.asin(-Math.min(1, Math.max(-1, dir[1]))) * (180 / Math.PI);
        console.log(`Detected arm droop: ${_armDroopDeg.toFixed(1)}° ${_armDroopDeg > APOSE_THRESHOLD_DEG ? '→ A-pose correction enabled' : '→ near T-pose, no correction needed'}`);
      }
    }
  } catch (e) { console.warn('A-pose detection failed:', e.message); }

  const _aposeCorrection = AUTO_APOSE_CORRECTION && _armDroopDeg > APOSE_THRESHOLD_DEG;

  // ── Merge ───────────────────────────────────────────────────────────────
  console.log('Merging animation document...');
  charDoc.merge(animDoc);

  // Eliminar cualquier animación llamada exactamente "mixamo.com",
  // venga de character.glb o de animations.glb
  let removedMixamo = 0;

  for (const anim of [...charDoc.getRoot().listAnimations()]) {
    if (anim.getName() === 'mixamo.com') {
      console.log('Removing animation: mixamo.com');
      anim.dispose();
      removedMixamo++;
    }
    if (anim.getName() === 'A_TPose') {
      console.log('Renaming animation: A_TPose');
      anim.setName('TPose');
    }
  }

  // Recalcular animaciones importadas restantes
  const importedAnims = charDoc.getRoot().listAnimations().filter(a => !origAnims.has(a));

  console.log(`Imported ${importedAnims.length} animations. Removed ${removedMixamo} "mixamo.com" animations.`);

  // ── MODE: character ──────────────────────────────────────────────────────
  if (SKELETON_SOURCE === 'character') {
    console.log('Retargeting animation channels to character skeleton...');
    let bound = 0, disposed = 0, unmatched = 0;
    const charParentMap = buildParentMap(charDoc); // built once after merge

    for (const anim of importedAnims) {
      console.log(`  "${anim.getName() || '?'}"...`);
      for (const ch of anim.listChannels()) {
        const path = ch.getTargetPath();
        const src = ch.getTargetNode();
        if (!src || !src.getName()) { ch.dispose(); disposed++; continue; }

        // Discard scale channels
        if (path === 'scale' && IGNORE_SCALE) { ch.dispose(); disposed++; continue; }

        const target = findMatchingBone(src, charByName, charByNorm);
        if (!target) { ch.dispose(); disposed++; unmatched++; continue; }

        const tgtName = target.getName().toLowerCase();
        const srcName = src.getName().toLowerCase();
        const isRoot = tgtName.includes('hips') || tgtName.includes('pelvis') || tgtName === '__root__';

        // Discard non-root translation
        if (path === 'translation' && !isRoot && IGNORE_NON_ROOT_TRANSLATION) {
          ch.dispose(); disposed++; continue;
        }

        // ── Retarget rotation keyframes via change-of-basis ──
        if (path === 'rotation') {
          const rAnim = animRestByName.get(srcName) || [0, 0, 0, 1];
          const rChar = charRestByName.get(tgtName) || [0, 0, 0, 1];
          const Wanim = animWorldByName.get(srcName) || [0, 0, 0, 1];
          let Wchar = charWorldByName.get(tgtName) || [0, 0, 0, 1];

          // A-pose correction: walk up to nearest shoulder/clavicle/collar ancestor
          // making C ≈ identity for same-convention (Mixamo/RPM/Unity→Mixamo) pairs.
          // Shoulder/clavicle bones are excluded (they ARE the reference).
          // Arm-bone patterns: Mixamo leftarm/leftforearm, UE5 upperarm_l/lowerarm_l,
          //                    Unity leftupperarm/leftlowerarm, Rigify upperarml/forearml
          const _isForearm = /leftforearm|rightforearm|lowerarm[_]?[lr]|forearm[_]?[lr]|forearml|forearmr|lowerarml|lowerarmr/.test(tgtName);
          const _isUpperArm = !_isForearm && /leftarm|rightarm|upperarm[_]?[lr]|upperarml|upperarmr|arm[_]?[lr]|arml$|armr$/.test(tgtName);
          if (_aposeCorrection && (_isUpperArm || _isForearm)) {
            let ancestor = charParentMap.get(target);
            while (ancestor) {
              const aName = (ancestor.getName() || '').toLowerCase();
              const isShoulderLike = aName.includes('shoulder') || aName.includes('clavicle') || aName.includes('collar');
              if (isShoulderLike) {
                const sw = charWorldByNode.get(ancestor);
                if (sw) Wchar = sw;
                break;
              }
              // Safety: stop at spine/chest level
              if (aName.includes('spine') || aName.includes('chest') || aName.includes('pelvis') || aName.includes('hips')) break;
              ancestor = charParentMap.get(ancestor);
            }
          }

          // Change-of-basis: C = Wchar⁻¹ · Wanim
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
                  // delta = rAnim⁻¹ · qKeyframe  (animation-local delta)
                  const delta = qMul(rAnimInv, qKey);
                  // rotate delta into character space: C · delta · C⁻¹
                  const rotated = qMul(qMul(C, delta), Cinv);
                  // apply on top of character rest: rChar · rotated
                  let final = qMul(rChar, rotated);
                  // apply user-defined pose offset and dynamic spread adjustments if any
                  let pOffset = [0, 0, 0];
                  if (POSE_OFFSETS[tgtName]) {
                    pOffset = [...POSE_OFFSETS[tgtName]];
                  }

                  // Manual ARM/LEG spread angle overrides (only when non-zero)
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
          }
        }

        // ── Retarget root translation ──────────────────────────────────────
        // animations.glb has root node Rx(-90°) — bone translations are in Z-up space.
        // character.glb has identity root — bones are in Y-up space.
        // Cp converts Z-up→Y-up. We rotate both keyframe AND animRest by Cp before
        // computing delta, so the delta is in world space and applies correctly.
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

  // Prune & consolidate
  console.log('Pruning unused data...');
  await charDoc.transform(prune());
  console.log('Consolidating buffers...');
  await charDoc.transform(unpartition());

  // Compress
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

  // Write
  console.log(`Writing: ${outputPath}...`);
  const buf = await io.writeBinary(charDoc);
  await fs.writeFile(outputPath, buf);


  // Generar listado de animaciones
  const animationNames = charDoc
    .getRoot()
    .listAnimations()
    .map(anim => anim.getName() || 'UnnamedAnimation')
    .filter(name => name.trim() !== '');

  const txtPath = outputPath.replace(/\.glb$/i, '_animations.txt');

  await fs.writeFile(
    txtPath,
    animationNames.join('\n'),
    'utf8'
  );

  console.log(`Animation list saved: ${txtPath}`);


  console.log('==================================================');
  console.log(` 🎉 DONE! Output: ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log('==================================================');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
