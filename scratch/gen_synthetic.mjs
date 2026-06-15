/**
 * Generate synthetic humanoid skeleton GLBs covering all common conventions.
 * Output: scratch/synthetic/*.glb
 * Each file: skinned triangle-cloud mesh (3 verts per joint, weight 1.0) + full IBMs.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mkdirSync } from 'fs';
import { join } from 'path';

const OUT = 'd:/DEV/BJS Character Controller V2/scratch/synthetic';
mkdirSync(OUT, { recursive: true });

// ── canonical humanoid skeleton (Y-up, meters) ──────────────────────────────
// [key, parentKey, localTranslation]
const CANON = [
  ['hips', null, [0, 0.95, 0]],
  ['spine', 'hips', [0, 0.10, 0]],
  ['spine1', 'spine', [0, 0.12, 0]],
  ['spine2', 'spine1', [0, 0.12, 0]],
  ['neck', 'spine2', [0, 0.15, 0]],
  ['head', 'neck', [0, 0.10, 0]],
  ['clavicle_l', 'spine2', [0.03, 0.12, 0]],
  ['upperarm_l', 'clavicle_l', [0.14, 0, 0]],
  ['lowerarm_l', 'upperarm_l', [0.27, 0, 0]],
  ['hand_l', 'lowerarm_l', [0.26, 0, 0]],
  ['clavicle_r', 'spine2', [-0.03, 0.12, 0]],
  ['upperarm_r', 'clavicle_r', [-0.14, 0, 0]],
  ['lowerarm_r', 'upperarm_r', [-0.27, 0, 0]],
  ['hand_r', 'lowerarm_r', [-0.26, 0, 0]],
  ['thigh_l', 'hips', [0.09, -0.04, 0]],
  ['calf_l', 'thigh_l', [0, -0.42, 0]],
  ['foot_l', 'calf_l', [0, -0.43, 0]],
  ['toe_l', 'foot_l', [0, -0.07, 0.13]],
  ['thigh_r', 'hips', [-0.09, -0.04, 0]],
  ['calf_r', 'thigh_r', [0, -0.42, 0]],
  ['foot_r', 'calf_r', [0, -0.43, 0]],
  ['toe_r', 'foot_r', [0, -0.07, 0.13]],
];

// ── naming conventions ───────────────────────────────────────────────────────
const NAMES = {
  mixamo: {
    hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', spine1: 'mixamorig:Spine1', spine2: 'mixamorig:Spine2',
    neck: 'mixamorig:Neck', head: 'mixamorig:Head',
    clavicle_l: 'mixamorig:LeftShoulder', upperarm_l: 'mixamorig:LeftArm', lowerarm_l: 'mixamorig:LeftForeArm', hand_l: 'mixamorig:LeftHand',
    clavicle_r: 'mixamorig:RightShoulder', upperarm_r: 'mixamorig:RightArm', lowerarm_r: 'mixamorig:RightForeArm', hand_r: 'mixamorig:RightHand',
    thigh_l: 'mixamorig:LeftUpLeg', calf_l: 'mixamorig:LeftLeg', foot_l: 'mixamorig:LeftFoot', toe_l: 'mixamorig:LeftToeBase',
    thigh_r: 'mixamorig:RightUpLeg', calf_r: 'mixamorig:RightLeg', foot_r: 'mixamorig:RightFoot', toe_r: 'mixamorig:RightToeBase',
  },
  ue5: {
    hips: 'pelvis', spine: 'spine_01', spine1: 'spine_02', spine2: 'spine_03', neck: 'neck_01', head: 'head',
    clavicle_l: 'clavicle_l', upperarm_l: 'upperarm_l', lowerarm_l: 'lowerarm_l', hand_l: 'hand_l',
    clavicle_r: 'clavicle_r', upperarm_r: 'upperarm_r', lowerarm_r: 'lowerarm_r', hand_r: 'hand_r',
    thigh_l: 'thigh_l', calf_l: 'calf_l', foot_l: 'foot_l', toe_l: 'ball_l',
    thigh_r: 'thigh_r', calf_r: 'calf_r', foot_r: 'foot_r', toe_r: 'ball_r',
  },
  unity: {
    hips: 'Hips', spine: 'Spine', spine1: 'Chest', spine2: 'UpperChest', neck: 'Neck', head: 'Head',
    clavicle_l: 'LeftShoulder', upperarm_l: 'LeftUpperArm', lowerarm_l: 'LeftLowerArm', hand_l: 'LeftHand',
    clavicle_r: 'RightShoulder', upperarm_r: 'RightUpperArm', lowerarm_r: 'RightLowerArm', hand_r: 'RightHand',
    thigh_l: 'LeftUpperLeg', calf_l: 'LeftLowerLeg', foot_l: 'LeftFoot', toe_l: 'LeftToes',
    thigh_r: 'RightUpperLeg', calf_r: 'RightLowerLeg', foot_r: 'RightFoot', toe_r: 'RightToes',
  },
  vrm: {
    hips: 'J_Bip_C_Hips', spine: 'J_Bip_C_Spine', spine1: 'J_Bip_C_Chest', spine2: 'J_Bip_C_UpperChest', neck: 'J_Bip_C_Neck', head: 'J_Bip_C_Head',
    clavicle_l: 'J_Bip_L_Shoulder', upperarm_l: 'J_Bip_L_UpperArm', lowerarm_l: 'J_Bip_L_LowerArm', hand_l: 'J_Bip_L_Hand',
    clavicle_r: 'J_Bip_R_Shoulder', upperarm_r: 'J_Bip_R_UpperArm', lowerarm_r: 'J_Bip_R_LowerArm', hand_r: 'J_Bip_R_Hand',
    thigh_l: 'J_Bip_L_UpperLeg', calf_l: 'J_Bip_L_LowerLeg', foot_l: 'J_Bip_L_Foot', toe_l: 'J_Bip_L_ToeBase',
    thigh_r: 'J_Bip_R_UpperLeg', calf_r: 'J_Bip_R_LowerLeg', foot_r: 'J_Bip_R_Foot', toe_r: 'J_Bip_R_ToeBase',
  },
  blender: {
    hips: 'hips', spine: 'spine', spine1: 'chest', spine2: 'upper_chest', neck: 'neck', head: 'head',
    clavicle_l: 'shoulder.L', upperarm_l: 'upper_arm.L', lowerarm_l: 'forearm.L', hand_l: 'hand.L',
    clavicle_r: 'shoulder.R', upperarm_r: 'upper_arm.R', lowerarm_r: 'forearm.R', hand_r: 'hand.R',
    thigh_l: 'thigh.L', calf_l: 'shin.L', foot_l: 'foot.L', toe_l: 'toe.L',
    thigh_r: 'thigh.R', calf_r: 'shin.R', foot_r: 'foot.R', toe_r: 'toe.R',
  },
  biped: {
    hips: 'Bip001 Pelvis', spine: 'Bip001 Spine', spine1: 'Bip001 Spine1', spine2: 'Bip001 Spine2', neck: 'Bip001 Neck', head: 'Bip001 Head',
    clavicle_l: 'Bip001 L Clavicle', upperarm_l: 'Bip001 L UpperArm', lowerarm_l: 'Bip001 L Forearm', hand_l: 'Bip001 L Hand',
    clavicle_r: 'Bip001 R Clavicle', upperarm_r: 'Bip001 R UpperArm', lowerarm_r: 'Bip001 R Forearm', hand_r: 'Bip001 R Hand',
    thigh_l: 'Bip001 L Thigh', calf_l: 'Bip001 L Calf', foot_l: 'Bip001 L Foot', toe_l: 'Bip001 L Toe0',
    thigh_r: 'Bip001 R Thigh', calf_r: 'Bip001 R Calf', foot_r: 'Bip001 R Foot', toe_r: 'Bip001 R Toe0',
  },
  rpm: {
    hips: 'Hips', spine: 'Spine', spine1: 'Spine1', spine2: 'Spine2', neck: 'Neck', head: 'Head',
    clavicle_l: 'LeftShoulder', upperarm_l: 'LeftArm', lowerarm_l: 'LeftForeArm', hand_l: 'LeftHand',
    clavicle_r: 'RightShoulder', upperarm_r: 'RightArm', lowerarm_r: 'RightForeArm', hand_r: 'RightHand',
    thigh_l: 'LeftUpLeg', calf_l: 'LeftLeg', foot_l: 'LeftFoot', toe_l: 'LeftToeBase',
    thigh_r: 'RightUpLeg', calf_r: 'RightLeg', foot_r: 'RightFoot', toe_r: 'RightToeBase',
  },
};

// ── math helpers (column-major mat4) ─────────────────────────────────────────
function quatToMat3([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ]; // column-major 3x3
}
function compose(t, q, s) {
  const R = quatToMat3(q);
  return [
    R[0] * s[0], R[1] * s[0], R[2] * s[0], 0,
    R[3] * s[1], R[4] * s[1], R[5] * s[1], 0,
    R[6] * s[2], R[7] * s[2], R[8] * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mat4Mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function affineInvert(m) {
  // m = [A t; 0 1] column-major. inv = [Ai, -Ai*t]
  const a00 = m[0], a01 = m[4], a02 = m[8];
  const a10 = m[1], a11 = m[5], a12 = m[9];
  const a20 = m[2], a21 = m[6], a22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  const id = 1 / det;
  const i00 = (a11 * a22 - a12 * a21) * id, i01 = (a02 * a21 - a01 * a22) * id, i02 = (a01 * a12 - a02 * a11) * id;
  const i10 = (a12 * a20 - a10 * a22) * id, i11 = (a00 * a22 - a02 * a20) * id, i12 = (a02 * a10 - a00 * a12) * id;
  const i20 = (a10 * a21 - a11 * a20) * id, i21 = (a01 * a20 - a00 * a21) * id, i22 = (a00 * a11 - a01 * a10) * id;
  return [
    i00, i10, i20, 0,
    i01, i11, i21, 0,
    i02, i12, i22, 0,
    -(i00 * tx + i01 * ty + i02 * tz),
    -(i10 * tx + i11 * ty + i12 * tz),
    -(i20 * tx + i21 * ty + i22 * tz),
    1,
  ];
}
function mat4MulVec3(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
const ZUP = ([x, y, z]) => [x, -z, y]; // Y-up local vec → Z-up local vec

/**
 * Build one GLB.
 * opts: { names, rotations (key→quat), wrapper: {name, rotation, scale} | wrappers: [...], zUp, scalePos, nameSuffix }
 */
async function build(file, opts) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');

  const sp = opts.scalePos || 1;
  const nodes = new Map();
  let topParent = null;

  const wrappers = opts.wrappers || (opts.wrapper ? [opts.wrapper] : []);
  for (const w of wrappers) {
    const wn = doc.createNode(w.name);
    if (w.rotation) wn.setRotation(w.rotation);
    if (w.scale) wn.setScale(w.scale);
    if (w.translation) wn.setTranslation(w.translation);
    if (topParent) topParent.addChild(wn); else scene.addChild(wn);
    topParent = wn;
  }

  for (const [key, parentKey, trans] of CANON) {
    let t = opts.zUp ? ZUP(trans) : [...trans];
    t = [t[0] * sp, t[1] * sp, t[2] * sp];
    const name = opts.names[key] + (opts.nameSuffix ? opts.nameSuffix(key) : '');
    const node = doc.createNode(name).setTranslation(t);
    const rot = opts.rotations?.[key];
    if (rot) node.setRotation(rot);
    nodes.set(key, node);
    if (parentKey) nodes.get(parentKey).addChild(node);
    else if (topParent) topParent.addChild(node);
    else scene.addChild(node);
  }

  // world matrices
  const world = new Map();
  function wm(node) {
    if (world.has(node)) return world.get(node);
    const local = compose(node.getTranslation() || [0, 0, 0], node.getRotation() || [0, 0, 0, 1], node.getScale() || [1, 1, 1]);
    let parent = null;
    for (const n of doc.getRoot().listNodes()) if (n.listChildren().includes(node)) { parent = n; break; }
    const w = parent ? mat4Mul(wm(parent), local) : local;
    world.set(node, w);
    return w;
  }

  // skinned mesh: triangle per joint, vertices in world bind space
  const joints = CANON.map(([k]) => nodes.get(k));
  const positions = [], jointIdx = [], weights = [], indices = [];
  joints.forEach((j, i) => {
    const p = mat4MulVec3(wm(j), [0, 0, 0]);
    const base = positions.length / 3;
    positions.push(p[0], p[1], p[2], p[0] + 0.02, p[1], p[2], p[0], p[1] + 0.02, p[2]);
    for (let v = 0; v < 3; v++) { jointIdx.push(i, 0, 0, 0); weights.push(1, 0, 0, 0); }
    indices.push(base, base + 1, base + 2);
  });

  const ibms = [];
  joints.forEach(j => ibms.push(...affineInvert(wm(j))));

  const posAcc = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
  const jAcc = doc.createAccessor().setType('VEC4').setArray(new Uint16Array(jointIdx)).setBuffer(buffer);
  const wAcc = doc.createAccessor().setType('VEC4').setArray(new Float32Array(weights)).setBuffer(buffer);
  const iAcc = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer);
  const ibmAcc = doc.createAccessor().setType('MAT4').setArray(new Float32Array(ibms)).setBuffer(buffer);

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', posAcc)
    .setAttribute('JOINTS_0', jAcc)
    .setAttribute('WEIGHTS_0', wAcc)
    .setIndices(iAcc);
  const mesh = doc.createMesh('BodyMesh').addPrimitive(prim);
  const skin = doc.createSkin('Skin').setInverseBindMatrices(ibmAcc);
  joints.forEach(j => skin.addJoint(j));
  skin.setSkeleton(joints[0]);

  const meshNode = doc.createNode('Body').setMesh(mesh).setSkin(skin);
  if (topParent) topParent.addChild(meshNode); else scene.addChild(meshNode);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const glb = await io.writeBinary(doc);
  const { writeFileSync } = await import('fs');
  writeFileSync(join(OUT, file), glb);
  console.log(`wrote ${file} (${glb.length} bytes)`);
}

const deg = d => d * Math.PI / 180;
const qZ = a => [0, 0, Math.sin(deg(a) / 2), Math.cos(deg(a) / 2)];
const qX = a => [Math.sin(deg(a) / 2), 0, 0, Math.cos(deg(a) / 2)];

// A-pose: arms drooped 40°
const APOSE_ROT = { upperarm_l: qZ(-40), upperarm_r: qZ(40) };

await build('syn_mixamo_t.glb', { names: NAMES.mixamo });
await build('syn_mixamo_apose.glb', { names: NAMES.mixamo, rotations: APOSE_ROT });
await build('syn_ue5_t.glb', { names: NAMES.ue5 });
await build('syn_unity_t.glb', { names: NAMES.unity });
await build('syn_vrm_t.glb', { names: NAMES.vrm });
await build('syn_blender_t.glb', { names: NAMES.blender });
await build('syn_biped_t.glb', { names: NAMES.biped });
await build('syn_rpm_t.glb', { names: NAMES.rpm });
// Sketchfab-style: Z-up skeleton under rotated+scaled armature chain, positions ×100
await build('syn_ue5_zup_scaled.glb', {
  names: NAMES.ue5, zUp: true, scalePos: 100,
  wrappers: [
    { name: 'Sketchfab_model', rotation: qX(-90) },
    { name: 'Armature', scale: [0.01, 0.01, 0.01] },
  ],
});
// BJS re-export style: numeric suffixes + buried RootNode
await build('syn_mixamo_bjs.glb', {
  names: NAMES.rpm,
  nameSuffix: (() => { let i = 10; const m = new Map(); return k => { if (!m.has(k)) m.set(k, `_${i++}`); return m.get(k); }; })(),
  wrappers: [{ name: 'RootNode', scale: [1, 1, 1] }],
});
// Namespaced (Maya-style)
await build('syn_namespaced.glb', {
  names: Object.fromEntries(Object.entries(NAMES.rpm).map(([k, v]) => [k, `char01:${v}`])),
});
console.log('done');
