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
  ARM_SPREAD_ANGLE: -5,
  LEG_SPREAD_ANGLE: 5,
  POSE_OFFSETS: {},
  COMPRESS_OUTPUT: true,
};

// ── Bone name mapping ────────────────────────────────────────────────────────
const BONE_MAP = {
  'pelvis': ['hips', 'mixamorig:hips'],
  'spine_01': ['spine', 'mixamorig:spine'],
  'spine_02': ['spine1', 'mixamorig:spine1'],
  'spine_03': ['spine2', 'mixamorig:spine2'],
  'neck_01': ['neck', 'mixamorig:neck'],
  'head': ['head', 'mixamorig:head'],
  'clavicle_l': ['leftshoulder', 'mixamorig:leftshoulder'],
  'upperarm_l': ['leftarm', 'mixamorig:leftarm'],
  'lowerarm_l': ['leftforearm', 'mixamorig:leftforearm'],
  'hand_l': ['lefthand', 'mixamorig:lefthand'],
  'clavicle_r': ['rightshoulder', 'mixamorig:rightshoulder'],
  'upperarm_r': ['rightarm', 'mixamorig:rightarm'],
  'lowerarm_r': ['rightforearm', 'mixamorig:rightforearm'],
  'hand_r': ['righthand', 'mixamorig:righthand'],
  'thigh_l': ['leftupleg', 'mixamorig:leftupleg'],
  'calf_l': ['leftleg', 'mixamorig:leftleg'],
  'foot_l': ['leftfoot', 'mixamorig:leftfoot'],
  'toe_l': ['lefttoebase', 'mixamorig:lefttoebase'],
  'ball_l': ['lefttoebase', 'mixamorig:lefttoebase'],
  'thigh_r': ['rightupleg', 'mixamorig:rightupleg'],
  'calf_r': ['rightleg', 'mixamorig:rightleg'],
  'foot_r': ['rightfoot', 'mixamorig:rightfoot'],
  'toe_r': ['righttoebase', 'mixamorig:righttoebase'],
  'ball_r': ['righttoebase', 'mixamorig:righttoebase'],
  'thumb_01_l': ['lefthandthumb1', 'mixamorig:lefthandthumb1'],
  'thumb_02_l': ['lefthandthumb2', 'mixamorig:lefthandthumb2'],
  'thumb_03_l': ['lefthandthumb3', 'mixamorig:lefthandthumb3'],
  'index_01_l': ['lefthandindex1', 'mixamorig:lefthandindex1'],
  'index_02_l': ['lefthandindex2', 'mixamorig:lefthandindex2'],
  'index_03_l': ['lefthandindex3', 'mixamorig:lefthandindex3'],
  'middle_01_l': ['lefthandmiddle1', 'mixamorig:lefthandmiddle1'],
  'middle_02_l': ['lefthandmiddle2', 'mixamorig:lefthandmiddle2'],
  'middle_03_l': ['lefthandmiddle3', 'mixamorig:lefthandmiddle3'],
  'ring_01_l': ['lefthandring1', 'mixamorig:lefthandring1'],
  'ring_02_l': ['lefthandring2', 'mixamorig:lefthandring2'],
  'ring_03_l': ['lefthandring3', 'mixamorig:lefthandring3'],
  'pinky_01_l': ['lefthandpinky1', 'mixamorig:lefthandpinky1'],
  'pinky_02_l': ['lefthandpinky2', 'mixamorig:lefthandpinky2'],
  'pinky_03_l': ['lefthandpinky3', 'mixamorig:lefthandpinky3'],
  'thumb_01_r': ['righthandthumb1', 'mixamorig:righthandthumb1'],
  'thumb_02_r': ['righthandthumb2', 'mixamorig:righthandthumb2'],
  'thumb_03_r': ['righthandthumb3', 'mixamorig:righthandthumb3'],
  'index_01_r': ['righthandindex1', 'mixamorig:righthandindex1'],
  'index_02_r': ['righthandindex2', 'mixamorig:righthandindex2'],
  'index_03_r': ['righthandindex3', 'mixamorig:righthandindex3'],
  'middle_01_r': ['righthandmiddle1', 'mixamorig:righthandmiddle1'],
  'middle_02_r': ['righthandmiddle2', 'mixamorig:righthandmiddle2'],
  'middle_03_r': ['righthandmiddle3', 'mixamorig:righthandmiddle3'],
  'ring_01_r': ['righthandring1', 'mixamorig:righthandring1'],
  'ring_02_r': ['righthandring2', 'mixamorig:righthandring2'],
  'ring_03_r': ['righthandring3', 'mixamorig:righthandring3'],
  'pinky_01_r': ['righthandpinky1', 'mixamorig:righthandpinky1'],
  'pinky_02_r': ['righthandpinky2', 'mixamorig:righthandpinky2'],
  'pinky_03_r': ['righthandpinky3', 'mixamorig:righthandpinky3'],
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
 * Works on both raw GLTF names and BJS-suffixed names.
 */
function normalizeName(name) {
  if (!name) return '';
  return stripBJSSuffix(name).toLowerCase()
    .replace(/^(mixamorig\d*|armature|char|bi|bip\d*|biped|root|gltf_created_\d+_)\b[:_]*/i, '')
    .replace(/[:_\-\.\s]/g, '');
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
      const hasParent   = parentMap.has(n);
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
    const rawName   = node.getName() || '(unnamed)';
    const cleanName = stripBJSSuffix(rawName); // remove BJS _N suffix for display
    const depth     = getDepth(node);
    const parent    = parentMap.get(node);
    const isRoot    = !parent || !nodeSet.has(parent) || SYNTHETIC_ROOTS.test(parent.getName() || '');

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

  // Pre-merge analysis
  const charWorldRots = computeWorldRotations(charDoc);
  const animWorldRots = computeWorldRotations(animDoc);

  const charRestByName = new Map();
  const charWorldByName = new Map();
  for (const node of charDoc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      charRestByName.set(name.toLowerCase(), node.getRotation() || [0, 0, 0, 1]);
      charWorldByName.set(name.toLowerCase(), charWorldRots.get(node) || [0, 0, 0, 1]);
    }
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

  const origNodes  = new Set(charDoc.getRoot().listNodes());
  const origScenes = new Set(charDoc.getRoot().listScenes());
  const origMeshes = new Set(charDoc.getRoot().listMeshes());
  const origSkins  = new Set(charDoc.getRoot().listSkins());
  const origAnims  = new Set(charDoc.getRoot().listAnimations());

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

  // Merge
  charDoc.merge(animDoc);

  // Remove junk animations
  for (const anim of [...charDoc.getRoot().listAnimations()]) {
    if (anim.getName() === 'mixamo.com') { anim.dispose(); continue; }
    if (anim.getName() === 'A_TPose') anim.setName('TPose');
  }

  const importedAnims = charDoc.getRoot().listAnimations().filter(a => !origAnims.has(a));

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
          const Wchar = charWorldByName.get(tgtName) || [0, 0, 0, 1];
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
                  const qKey = [arr[j], arr[j+1], arr[j+2], arr[j+3]];
                  const delta = qMul(rAnimInv, qKey);
                  const rotated = qMul(qMul(C, delta), Cinv);
                  let final = qMul(rChar, rotated);

                  let pOffset = [0, 0, 0];
                  if (cfg.POSE_OFFSETS[tgtName]) pOffset = [...cfg.POSE_OFFSETS[tgtName]];
                  if (tgtName.includes('leftshoulder') || tgtName.includes('leftarm')) pOffset[1] += cfg.ARM_SPREAD_ANGLE;
                  else if (tgtName.includes('rightshoulder') || tgtName.includes('rightarm')) pOffset[1] -= cfg.ARM_SPREAD_ANGLE;
                  if (tgtName.includes('leftupleg') || tgtName.includes('leftthigh')) pOffset[1] -= cfg.LEG_SPREAD_ANGLE;
                  else if (tgtName.includes('rightupleg') || tgtName.includes('rightthigh')) pOffset[1] += cfg.LEG_SPREAD_ANGLE;

                  if (pOffset[0] !== 0 || pOffset[1] !== 0 || pOffset[2] !== 0) {
                    final = qMul(final, eulerToQuat(pOffset[0], pOffset[1], pOffset[2]));
                  }
                  out[j] = final[0]; out[j+1] = final[1]; out[j+2] = final[2]; out[j+3] = final[3];
                }
                output.setArray(out);
              }
            }
          }
        }

        if (path === 'translation' && isRoot) {
          const srcParentName = animParentNameMap.get(srcName);
          const WanimP = srcParentName ? (animWorldByName.get(srcParentName) || [0,0,0,1]) : [0,0,0,1];
          const charParent = charParentMap.get(target);
          const WcharP = charParent ? (charWorldByName.get(charParent.getName()?.toLowerCase()) || [0,0,0,1]) : [0,0,0,1];
          const Cp = qMul(qInvert(WcharP), WanimP);
          const animRestLocal = src.getTranslation() || [0, 0, 0];
          const charRest = target.getTranslation() || [0, 0, 0];
          const animRestWorld = rotateVec3(animRestLocal, Cp);
          const output = ch.getSampler()?.getOutput();
          const arr = output?.getArray();
          if (arr) {
            const out = new Float32Array(arr.length);
            for (let j = 0; j < arr.length; j += 3) {
              const kw = rotateVec3([arr[j], arr[j+1], arr[j+2]], Cp);
              out[j]   = charRest[0] + kw[0] - animRestWorld[0];
              out[j+1] = charRest[1] + kw[1] - animRestWorld[1];
              out[j+2] = charRest[2] + kw[2] - animRestWorld[2];
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
    for (const skin of charDoc.getRoot().listSkins())  { if (!origSkins.has(skin)) skin.dispose(); }
  }

  for (const scene of charDoc.getRoot().listScenes()) { if (!origScenes.has(scene)) scene.dispose(); }

  await charDoc.transform(prune());
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
