import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) map.set(child, node);
  }
  return map;
}

function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
  return [
    x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2,
    y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
    z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
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

function vec3Length(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

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

const BONE_MAP = {
  'pelvis': ['hips', 'mixamorig:hips', 'hip', 'root', 'hips_joint', 'pelvis_joint'],
  'spine_01': ['spine', 'mixamorig:spine', 'spine_a', 'spinea', 'lower_back', 'lowerback'],
  'spine_02': ['spine1', 'mixamorig:spine1', 'spine_b', 'spineb', 'midspine'],
  'spine_03': ['spine2', 'mixamorig:spine2', 'chest', 'upperchest', 'upperspine', 'upperbody'],
  'neck_01': ['neck', 'mixamorig:neck', 'neck1'],
  'neck_02': ['neck1', 'mixamorig:neck1'],
  'head': ['head', 'mixamorig:head'],
  'clavicle_l': ['leftshoulder', 'mixamorig:leftshoulder', 'leftcollar', 'leftclavicle', 'collar_l', 'l_shoulder', 'shoulder_l', 'shoulderl'],
  'upperarm_l': ['leftarm', 'mixamorig:leftarm', 'leftupperarm', 'l_upperarm', 'upperarm_l', 'upperarml', 'arm_l', 'arml', 'left_arm', 'l_arm'],
  'lowerarm_l': ['leftforearm', 'mixamorig:leftforearm', 'leftlowerarm', 'l_lowerarm', 'lowerarm_l', 'lowerarml', 'forearm_l', 'forearml', 'left_forearm'],
  'hand_l': ['lefthand', 'mixamorig:lefthand', 'l_hand', 'handl', 'hand_l'],
  'clavicle_r': ['rightshoulder', 'mixamorig:rightshoulder', 'rightcollar', 'rightclavicle', 'collar_r', 'r_shoulder', 'shoulder_r', 'shoulderr'],
  'upperarm_r': ['rightarm', 'mixamorig:rightarm', 'rightupperarm', 'r_upperarm', 'upperarm_r', 'upperarmr', 'arm_r', 'armr', 'right_arm', 'r_arm'],
  'lowerarm_r': ['rightforearm', 'mixamorig:rightforearm', 'rightlowerarm', 'r_lowerarm', 'lowerarm_r', 'lowerarmr', 'forearm_r', 'forearmr', 'right_forearm'],
  'hand_r': ['righthand', 'mixamorig:righthand', 'r_hand', 'handr', 'hand_r'],
  'thigh_l': ['leftupleg', 'mixamorig:leftupleg', 'leftupperleg', 'l_thigh', 'thigh_l', 'thighl', 'l_upleg', 'leftthigh', 'left_upleg', 'hip_l', 'hipl'],
  'calf_l': ['leftleg', 'mixamorig:leftleg', 'leftlowerleg', 'l_calf', 'calf_l', 'calfl', 'shinl', 'shin_l', 'leftcalf', 'left_leg', 'l_knee'],
  'foot_l': ['leftfoot', 'mixamorig:leftfoot', 'l_foot', 'footl', 'leftankle', 'ankle_l'],
  'toe_l': ['lefttoebase', 'mixamorig:lefttoebase', 'l_toe', 'toel', 'lefttoe'],
  'thigh_r': ['rightupleg', 'mixamorig:rightupleg', 'rightupperleg', 'r_thigh', 'thigh_r', 'thighr', 'r_upleg', 'rightthigh', 'right_upleg', 'hip_r', 'hipr'],
  'calf_r': ['rightleg', 'mixamorig:rightleg', 'rightlowerleg', 'r_calf', 'calf_r', 'calfr', 'shinr', 'shin_r', 'rightcalf', 'right_leg', 'r_knee'],
  'foot_r': ['rightfoot', 'mixamorig:rightfoot', 'r_foot', 'footr', 'rightankle', 'ankle_r'],
  'toe_r': ['righttoebase', 'mixamorig:righttoebase', 'r_toe', 'toer', 'righttoe'],
};

function findMatchingBone(animNodeName, charByName, charByNorm) {
  const src = animNodeName;
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
  const norm = normalizeName(src);
  hit = charByNorm.get(norm);
  if (hit) return hit;
  return null;
}

async function inspectFile(filename) {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const doc = await io.readBinary(fs.readFileSync(filename));

  // Strip suffixes
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      const clean = name.replace(/_\d+$/, '');
      if (clean !== name) node.setName(clean);
    }
  }

  const charByName = new Map();
  const charByNorm = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      charByName.set(name, node);
      charByName.set(name.toLowerCase(), node);
      const stripped = name.replace(/_\d+$/, '');
      if (stripped !== name) {
        charByName.set(stripped, node);
        charByName.set(stripped.toLowerCase(), node);
      }
      const n = normalizeName(name);
      if (n) charByNorm.set(n, node);
    }
  }

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

  const leftFoot = findMatchingBone('foot_l', charByName, charByNorm);
  const leftToe = findMatchingBone('toe_l', charByName, charByNorm);

  console.log(`\n=== File: ${filename} ===`);
  if (leftFoot) {
    const pFoot = positions.get(leftFoot);
    const pToe = leftToe ? positions.get(leftToe) : null;
    console.log('leftFoot node name:', leftFoot.getName());
    console.log('leftToe node name:', leftToe ? leftToe.getName() : 'NOT FOUND');
    console.log('Original LeftFoot position:', pFoot);
    console.log('Original LeftToe position:', pToe);
    if (pToe) {
      const v = vec3Subtract(pToe, pFoot);
      console.log('Original vector Foot -> Toe:', v);

      const vNorm = vec3Normalize(v);
      console.log('Original vector normalized:', vNorm);

      // Horizontal projection
      const vXZ = vec3Normalize([v[0], 0, v[2]]);
      console.log('XZ projected vector normalized:', vXZ);
    }
  }
}

async function main() {
  await inspectFile('assets/character_animated.glb');
  await inspectFile('assets/characters_test/gang.glb');
}

main().catch(console.error);
