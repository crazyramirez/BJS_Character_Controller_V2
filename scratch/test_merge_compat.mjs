/**
 * Compatibility harness: synthetic variants of the character emulating quirks
 * of common ecosystems (Sketchfab/Max Z-up ancestor rotation, Blender/Unity
 * ×100 armature scale, ancestor translation, UE5/CC/Biped bone names), run
 * through mergeGLBs + animations, validating final orientation & animations.
 */
import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs, analyzeGLB } from '../js/core/merge_api.mjs';

const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
  'draco3d.encoder': await dracoLib.createEncoderModule(),
});

const charBuf = readFileSync(new URL('../assets/character_animated.glb', import.meta.url));
const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));

const qMul = ([x1, y1, z1, w1], [x2, y2, z2, w2]) => [
  x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2, y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
  z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
];
const qConj = ([x, y, z, w]) => [-x, -y, -z, w];
const qRotVec = (q, v) => {
  const p = [v[0], v[1], v[2], 0];
  const r = qMul(qMul(q, p), qConj(q));
  return [r[0], r[1], r[2]];
};

function findHipsAncestorChain(doc) {
  // returns { hips, sceneTopAncestor } — top-level ancestor node of the skeleton
  const skins = doc.getRoot().listSkins();
  const hips = skins[0].listJoints().find(j => /hips|pelvis/i.test(j.getName())) || skins[0].listJoints()[0];
  const parentOf = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  let top = hips;
  while (parentOf.get(top)) top = parentOf.get(top);
  return { hips, top };
}

// Insert a junk ancestor with rotation/scale/translation above the whole scene
// content, compensating on the direct children so WORLD transforms stay
// identical (exactly what DCC exports do: junk in hierarchy, net identity).
async function makeVariant({ rotDeg = null, axis = 'x', scale = 1, trans = [0, 0, 0], renames = null, name }) {
  const doc = await io.readBinary(new Uint8Array(charBuf));
  const root = doc.getRoot();

  if (rotDeg !== null || scale !== 1 || trans.some(v => v !== 0)) {
    const half = (rotDeg || 0) * Math.PI / 360;
    const q = axis === 'x' ? [Math.sin(half), 0, 0, Math.cos(half)] : [0, Math.sin(half), 0, Math.cos(half)];
    const qi = qConj(q);
    const wrapper = doc.createNode(`JunkAncestor_${name}`)
      .setRotation(q).setScale([scale, scale, scale]).setTranslation(trans);
    for (const scene of root.listScenes()) {
      const children = [...scene.listChildren()];
      scene.addChild(wrapper);
      for (const child of children) {
        // compensate: child' local = inv(wrapper) * child local
        const ct = child.getTranslation() || [0, 0, 0];
        const cr = child.getRotation() || [0, 0, 0, 1];
        const cs = child.getScale() || [1, 1, 1];
        const t2 = qRotVec(qi, [(ct[0] - trans[0]) / scale, (ct[1] - trans[1]) / scale, (ct[2] - trans[2]) / scale]);
        child.setTranslation(t2);
        child.setRotation(qMul(qi, cr));
        child.setScale([cs[0] / scale, cs[1] / scale, cs[2] / scale]);
        wrapper.addChild(child);
      }
    }
  }

  if (renames) {
    for (const node of root.listNodes()) {
      const clean = (node.getName() || '').replace(/^mixamorig\d*:/i, '');
      if (renames[clean]) node.setName(renames[clean]);
    }
  }
  return io.writeBinary(doc);
}

const UE5 = {
  Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'head',
  LeftShoulder: 'clavicle_l', LeftArm: 'upperarm_l', LeftForeArm: 'lowerarm_l', LeftHand: 'hand_l',
  RightShoulder: 'clavicle_r', RightArm: 'upperarm_r', RightForeArm: 'lowerarm_r', RightHand: 'hand_r',
  LeftUpLeg: 'thigh_l', LeftLeg: 'calf_l', LeftFoot: 'foot_l', LeftToeBase: 'ball_l',
  RightUpLeg: 'thigh_r', RightLeg: 'calf_r', RightFoot: 'foot_r', RightToeBase: 'ball_r',
};
const CC = Object.fromEntries(Object.entries({
  Hips: 'CC_Base_Hip', Spine: 'CC_Base_Waist', Spine1: 'CC_Base_Spine01', Spine2: 'CC_Base_Spine02',
  Neck: 'CC_Base_NeckTwist01', Head: 'CC_Base_Head',
  LeftShoulder: 'CC_Base_L_Clavicle', LeftArm: 'CC_Base_L_Upperarm', LeftForeArm: 'CC_Base_L_Forearm', LeftHand: 'CC_Base_L_Hand',
  RightShoulder: 'CC_Base_R_Clavicle', RightArm: 'CC_Base_R_Upperarm', RightForeArm: 'CC_Base_R_Forearm', RightHand: 'CC_Base_R_Hand',
  LeftUpLeg: 'CC_Base_L_Thigh', LeftLeg: 'CC_Base_L_Calf', LeftFoot: 'CC_Base_L_Foot', LeftToeBase: 'CC_Base_L_ToeBase',
  RightUpLeg: 'CC_Base_R_Thigh', RightLeg: 'CC_Base_R_Calf', RightFoot: 'CC_Base_R_Foot', RightToeBase: 'CC_Base_R_ToeBase',
}).map(([k, v]) => [k, v]));
const BIPED = {
  Hips: 'Bip001 Pelvis', Spine: 'Bip001 Spine', Spine1: 'Bip001 Spine1', Spine2: 'Bip001 Spine2',
  Neck: 'Bip001 Neck', Head: 'Bip001 Head',
  LeftShoulder: 'Bip001 L Clavicle', LeftArm: 'Bip001 L UpperArm', LeftForeArm: 'Bip001 L Forearm', LeftHand: 'Bip001 L Hand',
  RightShoulder: 'Bip001 R Clavicle', RightArm: 'Bip001 R UpperArm', RightForeArm: 'Bip001 R Forearm', RightHand: 'Bip001 R Hand',
  LeftUpLeg: 'Bip001 L Thigh', LeftLeg: 'Bip001 L Calf', LeftFoot: 'Bip001 L Foot', LeftToeBase: 'Bip001 L Toe0',
  RightUpLeg: 'Bip001 R Thigh', RightLeg: 'Bip001 R Calf', RightFoot: 'Bip001 R Foot', RightToeBase: 'Bip001 R Toe0',
};

// Validate world-bind orientation of the merged GLB: invert IBMs → joint
// world positions. Head above hips, hands separated in ±X, similar heights.
async function validate(buf, label) {
  const doc = await io.readBinary(new Uint8Array(buf));
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) return `${label}: FAIL no skin`;
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices().getArray();
  const worldOf = (i) => {
    // invert affine: w = -R⁻¹t ; for orientation we only need translation of inverse
    const m = ibm.slice(i * 16, i * 16 + 16);
    // proper 3x3 inverse via adjugate (handles scale)
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
    const inv = [
      (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
      (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
      (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det,
    ];
    const t = [m[12], m[13], m[14]];
    return [-(inv[0] * t[0] + inv[3] * t[1] + inv[6] * t[2]),
            -(inv[1] * t[0] + inv[4] * t[1] + inv[7] * t[2]),
            -(inv[2] * t[0] + inv[5] * t[1] + inv[8] * t[2])];
  };
  const find = (re) => joints.findIndex(j => re.test(j.getName()));
  const iHips = find(/hip|pelvis/i), iHead = find(/head/i);
  const iLH = find(/(left|_l\b|l_)?.*(hand)/i) >= 0 ? joints.findIndex(j => /lefthand|hand_l|l_hand|L Hand/i.test(j.getName())) : -1;
  const iRH = joints.findIndex(j => /righthand|hand_r|r_hand|R Hand/i.test(j.getName()));
  if (iHips < 0 || iHead < 0) return `${label}: FAIL hips/head joint not found`;
  const hips = worldOf(iHips), head = worldOf(iHead);
  const analysis = await analyzeGLB(buf);
  const anims = analysis.animations.length;
  const upY = head[1] - hips[1];
  const lateral = Math.hypot(head[0] - hips[0], head[2] - hips[2]);
  let hands = '';
  if (iLH >= 0 && iRH >= 0) {
    const lh = worldOf(iLH), rh = worldOf(iRH);
    const dx = lh[0] - rh[0];
    hands = ` | hands dx=${dx.toFixed(2)} dy=${Math.abs(lh[1] - rh[1]).toFixed(2)}`;
    if (!(dx > 0.5)) return `${label}: FAIL hands not spread L>R in X (dx=${dx.toFixed(2)})${hands}`;
  }
  const msg = `${label}: upY=${upY.toFixed(2)} lateral=${lateral.toFixed(2)} anims=${anims} pose=${analysis.poseStyle}${hands}`;
  if (!(upY > 0.4)) return `${label}: FAIL not upright (upY=${upY.toFixed(2)}) — ${msg}`;
  if (!(lateral < 0.35)) return `${label}: FAIL leaning (lateral=${lateral.toFixed(2)}) — ${msg}`;
  if (anims < 10) return `${label}: FAIL too few animations (${anims})`;
  return `${label}: OK — ${msg}`;
}

const variants = [
  { name: 'baseline', opts: {} },
  { name: 'zup-rot-90x', opts: { rotDeg: 90, axis: 'x' } },
  { name: 'rot180y', opts: { rotDeg: 180, axis: 'y' } },
  { name: 'scale100', opts: { scale: 100 } },
  { name: 'scale001', opts: { scale: 0.01 } },
  { name: 'trans-offset', opts: { trans: [3, 1.5, -2] } },
  { name: 'rot90x+scale100', opts: { rotDeg: 90, axis: 'x', scale: 100 } },
  { name: 'ue5-names', opts: { renames: UE5 } },
  { name: 'cc-names', opts: { renames: CC } },
  { name: 'biped-names', opts: { renames: BIPED } },
  { name: 'ue5+rot90x', opts: { rotDeg: 90, axis: 'x', renames: UE5 } },
];

let failures = 0;
for (const v of variants) {
  try {
    const buf = await makeVariant({ ...v.opts, name: v.name });
    const merged = await mergeGLBs(buf, animBuf, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
    const res = await validate(merged, v.name);
    console.log(res);
    if (res.includes('FAIL')) failures++;
  } catch (e) {
    console.log(`${v.name}: FAIL exception: ${e.message}`);
    failures++;
  }
}
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
