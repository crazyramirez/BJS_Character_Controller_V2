/**
 * A-POSE AccuRig-pattern rig (CC_Base names, Z-up skin space, -90°X armature,
 * arms angled 35° down). A-pose triggers adjustToVirtualTPose — the old code
 * forced spine world rotations to identity, folding CC torsos at the waist.
 * Checks: after merging Mixamo anims, frame 0 of a locomotion clip keeps the
 * torso upright (head above hips, no forward fold).
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFileSync } from 'fs';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const doc = new Document();
const buffer = doc.createBuffer();

// Z-up skin space, height 1.8. Arms angled down ~35° (A-pose).
const dn = (x, drop) => [x, 0, 1.45 - drop]; // arm point with Z drop
const pts = [];
for (let h = 0; h <= 1.8; h += 0.04) pts.push([0, 0, h], [0.08, 0, h], [-0.08, 0, h]);
for (let t = 0; t <= 1; t += 0.05) {
  const x = 0.1 + t * 0.7, drop = t * 0.45;
  pts.push([x, 0, 1.45 - drop], [-x, 0, 1.45 - drop]);
}
for (let h = 0; h <= 0.9; h += 0.04) pts.push([0.12, 0, h], [-0.12, 0, h]);
const posArr = new Float32Array(pts.flat());
const indices = [];
for (let i = 0; i + 2 < posArr.length / 3; i++) indices.push(i, i + 1, i + 2);

const BONES = [
  ['CC_Base_BoneRoot', null, [0, 0, 0]],
  ['CC_Base_Hip', 'CC_Base_BoneRoot', [0, 0, 0.95]],
  ['CC_Base_Pelvis', 'CC_Base_Hip', [0, 0, 0.95]],
  ['CC_Base_Waist', 'CC_Base_Hip', [0, 0, 1.05]],
  ['CC_Base_Spine01', 'CC_Base_Waist', [0, 0, 1.15]],
  ['CC_Base_Spine02', 'CC_Base_Spine01', [0, 0, 1.3]],
  ['CC_Base_NeckTwist01', 'CC_Base_Spine02', [0, 0, 1.5]],
  ['CC_Base_Head', 'CC_Base_NeckTwist01', [0, 0, 1.6]],
  ['CC_Base_L_Clavicle', 'CC_Base_Spine02', [0.08, 0, 1.45]],
  ['CC_Base_L_Upperarm', 'CC_Base_L_Clavicle', dn(0.2, 0.06)],
  ['CC_Base_L_Forearm', 'CC_Base_L_Upperarm', dn(0.5, 0.24)],
  ['CC_Base_L_Hand', 'CC_Base_L_Forearm', dn(0.8, 0.43)],
  ['CC_Base_R_Clavicle', 'CC_Base_Spine02', [-0.08, 0, 1.45]],
  ['CC_Base_R_Upperarm', 'CC_Base_R_Clavicle', dn(-0.2, 0.06)],
  ['CC_Base_R_Forearm', 'CC_Base_R_Upperarm', dn(-0.5, 0.24)],
  ['CC_Base_R_Hand', 'CC_Base_R_Forearm', dn(-0.8, 0.43)],
  ['CC_Base_L_Thigh', 'CC_Base_Pelvis', [0.12, 0, 0.9]],
  ['CC_Base_L_Calf', 'CC_Base_L_Thigh', [0.12, 0, 0.45]],
  ['CC_Base_L_Foot', 'CC_Base_L_Calf', [0.12, 0, 0.05]],
  ['CC_Base_L_ToeBase', 'CC_Base_L_Foot', [0.12, -0.12, 0.02]],
  ['CC_Base_R_Thigh', 'CC_Base_Pelvis', [-0.12, 0, 0.9]],
  ['CC_Base_R_Calf', 'CC_Base_R_Thigh', [-0.12, 0, 0.45]],
  ['CC_Base_R_Foot', 'CC_Base_R_Calf', [-0.12, 0, 0.05]],
  ['CC_Base_R_ToeBase', 'CC_Base_R_Foot', [-0.12, -0.12, 0.02]],
];

const nodeByName = new Map();
const posByName = new Map();
for (const [name, parent, p] of BONES) {
  const local = parent ? p.map((v, i) => v - posByName.get(parent)[i]) : p.slice();
  const n = doc.createNode(name).setTranslation(local);
  if (parent) nodeByName.get(parent).addChild(n);
  nodeByName.set(name, n);
  posByName.set(name, p);
}

const s = Math.SQRT1_2;
const armature = doc.createNode('Armature').setRotation([-s, 0, 0, s]);
armature.addChild(nodeByName.get('CC_Base_BoneRoot'));

const ibm = new Float32Array(BONES.length * 16);
BONES.forEach(([name], i) => {
  const p = posByName.get(name);
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
});

const joints01 = new Uint16Array((posArr.length / 3) * 4);
const weights = new Float32Array((posArr.length / 3) * 4);
for (let i = 0; i < posArr.length / 3; i++) { joints01[i * 4] = 1; weights[i * 4] = 1; }

const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
const prim = doc.createPrimitive()
  .setAttribute('POSITION', acc('VEC3', posArr))
  .setAttribute('JOINTS_0', acc('VEC4', joints01))
  .setAttribute('WEIGHTS_0', acc('VEC4', weights))
  .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer));
const mesh = doc.createMesh('body').addPrimitive(prim);
const skin = doc.createSkin().setInverseBindMatrices(acc('MAT4', ibm));
for (const [name] of BONES) skin.addJoint(nodeByName.get(name));
const meshNode = doc.createNode('BodyNode').setMesh(mesh).setSkin(skin);
doc.createScene('scene').addChild(armature).addChild(meshNode);
const glb = await new NodeIO().writeBinary(doc);

// ── Merge Mixamo animations ───────────────────────────────────────────────────
const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));
const merged = await mergeGLBs(glb, animBuf, { removeExistingAnimations: true });

const draco3d = (await import('draco3dgltf')).default ?? (await import('draco3dgltf'));
const dracoLib = draco3d.createDecoderModule ? draco3d : draco3d.default;
const mio = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
});
const mdoc = await mio.readBinary(new Uint8Array(merged));

// ── Evaluate frame 0 of an idle/locomotion clip: torso must stay upright ─────
const anims = mdoc.getRoot().listAnimations();
const clip = anims.find(a => /^idle_loop$/i.test(a.getName() || ''))
  || anims.find(a => /^idle/i.test(a.getName() || ''))
  || anims[0];

const rotAt0 = new Map(); // node → quat at t=0
const trsAt0 = new Map();
for (const ch of clip.listChannels()) {
  const node = ch.getTargetNode();
  const out = ch.getSampler()?.getOutput()?.getArray();
  if (!node || !out) continue;
  if (ch.getTargetPath() === 'rotation') rotAt0.set(node, [out[0], out[1], out[2], out[3]]);
  if (ch.getTargetPath() === 'translation') trsAt0.set(node, [out[0], out[1], out[2]]);
}

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const rotV = (v, q) => {
  const u = [q[0], q[1], q[2]], w = q[3];
  const uv = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const uuv = [u[1] * uv[2] - u[2] * uv[1], u[2] * uv[0] - u[0] * uv[2], u[0] * uv[1] - u[1] * uv[0]];
  return [v[0] + 2 * (w * uv[0] + uuv[0]), v[1] + 2 * (w * uv[1] + uuv[1]), v[2] + 2 * (w * uv[2] + uuv[2])];
};

const parentOf = new Map();
for (const n of mdoc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
function worldAt0(node) {
  const lr = rotAt0.get(node) || node.getRotation() || [0, 0, 0, 1];
  const lp = trsAt0.get(node) || node.getTranslation() || [0, 0, 0];
  const parent = parentOf.get(node);
  if (!parent) return { p: lp, q: lr };
  const pw = worldAt0(parent);
  return { p: [...rotV(lp, pw.q)].map((v, i) => v + pw.p[i]), q: qMul(pw.q, lr) };
}

const byName = new Map(mdoc.getRoot().listNodes().map(n => [n.getName(), n]));
const head = worldAt0(byName.get('CC_Base_Head')).p;
const hip = worldAt0(byName.get('CC_Base_Hip')).p;
const lHand = worldAt0(byName.get('CC_Base_L_Hand')).p;
const rHand = worldAt0(byName.get('CC_Base_R_Hand')).p;

let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) fail++;
};

const torsoLen = Math.hypot(head[0] - hip[0], head[1] - hip[1], head[2] - hip[2]);
const upY = (head[1] - hip[1]) / torsoLen; // 1 = perfectly vertical
const fwdLean = Math.abs(head[2] - hip[2]) / torsoLen;
check(`clip='${clip.getName()}' torso upright (upY > 0.85)`, upY > 0.85, `upY=${upY.toFixed(2)}`);
check('no waist fold (forward lean < 0.45)', fwdLean < 0.45, `lean=${fwdLean.toFixed(2)}`);
check('head above hips', head[1] > hip[1] + 0.3, `headY=${head[1].toFixed(2)} hipY=${hip[1].toFixed(2)}`);
check('hands lateral, below head', lHand[1] < head[1] && rHand[1] < head[1],
  `lHandY=${lHand[1].toFixed(2)} rHandY=${rHand[1].toFixed(2)}`);

process.exit(fail ? 1 : 0);
