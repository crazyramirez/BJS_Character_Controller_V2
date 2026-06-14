/**
 * Reproduce the AccuRig/UE/FBX export pattern:
 *  - bone names with CC_Base_ prefix
 *  - vertices + IBMs authored Z-up (character lies along +Z in skin space)
 *  - armature root node carries the -90° X rotation that makes it upright
 * Checks: guessJoints height/markers in render space, analyzeGLB bone coverage.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';
import { analyzeGLB } from '../js/core/merge_api.mjs';

const doc = new Document();
const buffer = doc.createBuffer();

// Z-up skin space: up = +Z, height 1.8; render = rotate -90° about X (z→y)
const zup = ([x, y, z]) => [x, z, -y]; // not used for verts; verts stay z-up

// Humanoid point cloud in Z-UP space (height along +Z)
const pts = [];
for (let h = 0; h <= 1.8; h += 0.04) pts.push([0, 0, h], [0.08, 0, h], [-0.08, 0, h]); // torso col
for (let x = -0.85; x <= 0.85; x += 0.04) pts.push([x, 0, 1.45]); // arms
for (let h = 0; h <= 0.9; h += 0.04) pts.push([0.12, 0, h], [-0.12, 0, h]); // legs
const posArr = new Float32Array(pts.flat());
const indices = [];
for (let i = 0; i + 2 < posArr.length / 3; i++) indices.push(i, i + 1, i + 2);

// CC_Base bone chain, Z-up bind positions
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
  ['CC_Base_L_Upperarm', 'CC_Base_L_Clavicle', [0.2, 0, 1.45]],
  ['CC_Base_L_Forearm', 'CC_Base_L_Upperarm', [0.5, 0, 1.45]],
  ['CC_Base_L_Hand', 'CC_Base_L_Forearm', [0.8, 0, 1.45]],
  ['CC_Base_R_Clavicle', 'CC_Base_Spine02', [-0.08, 0, 1.45]],
  ['CC_Base_R_Upperarm', 'CC_Base_R_Clavicle', [-0.2, 0, 1.45]],
  ['CC_Base_R_Forearm', 'CC_Base_R_Upperarm', [-0.5, 0, 1.45]],
  ['CC_Base_R_Hand', 'CC_Base_R_Forearm', [-0.8, 0, 1.45]],
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

// Armature root: -90° X rotation (Z-up → Y-up), quaternion (-sin45,0,0,cos45)
const s = Math.SQRT1_2;
const armature = doc.createNode('Armature').setRotation([-s, 0, 0, s]);
armature.addChild(nodeByName.get('CC_Base_BoneRoot'));

// IBMs in Z-up skin space: translation = -bindPos, identity rotation
const ibm = new Float32Array(BONES.length * 16);
BONES.forEach(([name], i) => {
  const p = posByName.get(name);
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
});

const joints01 = new Uint16Array((posArr.length / 3) * 4); // all → joint 1 (Hip)
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

// ── Checks ────────────────────────────────────────────────────────────────────
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) fail++;
};

const a = await analyzeGLB(glb);
check('skeleton coverage > 80%', (a.health?.coverage ?? 0) > 80, `coverage=${a.health?.coverage}`);
check('no missing critical bones', !(a.health?.checks || []).some(c => /Missing controller-critical/.test(c.title)),
  (a.health?.checks || []).map(c => c.title).join(' | '));

const guess = await guessJoints(glb);
check('height ~1.8 (render Y-up)', Math.abs(guess.height - 1.8) < 0.15, `height=${guess.height.toFixed(2)}`);
check('reRig seeded', guess.reRig === true);
const hips = guess.joints.Hips;
check('Hips marker upright (y≈0.95, z≈0)', Math.abs(hips[1] - 0.95) < 0.1 && Math.abs(hips[2]) < 0.1,
  `Hips=${hips.map(v => v.toFixed(2)).join(',')}`);
const lh = guess.joints.LeftHand;
check('LeftHand seeded from CC_Base_L_Hand', Math.abs(lh[0] - 0.8) < 0.05 && Math.abs(lh[1] - 1.45) < 0.05,
  `LeftHand=${lh.map(v => v.toFixed(2)).join(',')}`);

// Adjust path: move markers slightly, re-rig, verify IBMs/locals stay consistent
const rigged = await autoRigGLB(glb, { joints: guess.joints });
const a2 = await analyzeGLB(rigged);
check('adjusted rig keeps skin', a2.hasSkin === true, `bones=${a2.boneCount}`);
check('adjusted rig coverage > 80%', (a2.health?.coverage ?? 0) > 80, `coverage=${a2.health?.coverage}`);

// Merge Mixamo animations: CC 3-bone spine must map Spine→Waist, Spine1→Spine01,
// Spine2→Spine02 (chain shift) so the chest bend is not dropped.
const { mergeGLBs } = await import('../js/core/merge_api.mjs');
const { readFileSync } = await import('fs');
const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));
const merged = await mergeGLBs(glb, animBuf, { removeExistingAnimations: true });
const draco3d = (await import('draco3dgltf')).default ?? (await import('draco3dgltf'));
const dracoLib = draco3d.createDecoderModule ? draco3d : draco3d.default;
const mio = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
});
const mdoc = await mio.readBinary(new Uint8Array(merged));
const anims = mdoc.getRoot().listAnimations();
const targets = new Set();
for (const ch of (anims[0]?.listChannels() || [])) {
  const n = ch.getTargetNode()?.getName();
  if (n) targets.add(n);
}
check('anims merged', anims.length > 0, `anims=${anims.length}`);
check('Spine→CC_Base_Waist driven', targets.has('CC_Base_Waist'));
check('Spine1→CC_Base_Spine01 driven', targets.has('CC_Base_Spine01'));
check('Spine2→CC_Base_Spine02 driven', targets.has('CC_Base_Spine02'));
check('NeckTwist01 driven (Neck)', targets.has('CC_Base_NeckTwist01'));
check('clavicles driven', targets.has('CC_Base_L_Clavicle') && targets.has('CC_Base_R_Clavicle'));

process.exit(fail ? 1 : 0);
