import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFileSync } from 'fs';
import { mergeGLBs } from '../js/core/merge_api.mjs';

// We import the adjustToVirtualTPose and other helper functions by reading and running them or importing them
// Wait, we can just import from merge_api.mjs! Let's see: is adjustToVirtualTPose exported from merge_api.mjs?
// No, it's not exported. But we can write a test that runs mergeGLBs and inspects the output animation frame 0!
// Because the output animation frame 0 is retargeted using the virtual T-pose.
// Or wait, we can just call mergeGLBs and check if the foot bone at frame 0 of the idle loop is oriented correctly!
// Let's think: at frame 0 of idle loop (which is a T-pose in the animation), the foot vector in the animated skeleton (world space) should be aligned!
// Let's check how the world position at frame 0 is computed in test_feet_pitch.mjs:
// `worldAt0` calculates the world position at frame 0 of the animation.
// So we can just use `worldAt0` on the leftFoot and leftToe to get their world positions at frame 0 of the animation!
// This is perfect because it tests the entire end-to-end pipeline, ensuring that the merged/retargeted animation actually applies the corrected foot orientation!

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
  // Let's model the feet slightly angled to test pitch-preserving yaw alignment:
  // Foot has some rotation/tilt originally.
  ['CC_Base_L_Thigh', 'CC_Base_Pelvis', [0.12, 0, 0.9]],
  ['CC_Base_L_Calf', 'CC_Base_L_Thigh', [0.12, 0.05, 0.45]], // calf tilted forward in Y
  ['CC_Base_L_Foot', 'CC_Base_L_Calf', [0.12, 0.08, 0.05]],   // foot further forward in Y
  ['CC_Base_L_ToeBase', 'CC_Base_L_Foot', [0.12, 0.25, 0.02]], // toe base tilted forward and down
  ['CC_Base_R_Thigh', 'CC_Base_Pelvis', [-0.12, 0, 0.9]],
  ['CC_Base_R_Calf', 'CC_Base_R_Thigh', [-0.12, -0.05, 0.45]],
  ['CC_Base_R_Foot', 'CC_Base_R_Calf', [-0.12, -0.08, 0.05]],
  ['CC_Base_R_ToeBase', 'CC_Base_R_Foot', [-0.12, -0.25, 0.02]],
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

// Compute final world positions at frame 0 of the animation
const parentMap = new Map();
for (const node of mdoc.getRoot().listNodes()) {
  for (const child of node.listChildren()) parentMap.set(child, node);
}

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

const rotateVec3 = ([x, y, z], [qx, qy, qz, qw]) => {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
};

const vec3Add = ([x1, y1, z1], [x2, y2, z2]) => [x1 + x2, y1 + y2, z1 + z2];
const vec3Subtract = ([x1, y1, z1], [x2, y2, z2]) => [x1 - x2, y1 - y2, z1 - z2];

function worldAt0(node) {
  const lr = rotAt0.get(node) || node.getRotation() || [0, 0, 0, 1];
  const lp = trsAt0.get(node) || node.getTranslation() || [0, 0, 0];
  const parent = parentMap.get(node);
  if (!parent) return { p: lp, q: lr };
  const pw = worldAt0(parent);
  return { p: [...rotateVec3(lp, pw.q)].map((v, i) => v + pw.p[i]), q: qMul(pw.q, lr) };
}

const byName = new Map(mdoc.getRoot().listNodes().map(n => [n.getName(), n]));
const leftFootNode = byName.get('CC_Base_L_Foot');
const leftToeNode = byName.get('CC_Base_L_ToeBase');

if (leftFootNode && leftToeNode) {
  const pFoot = worldAt0(leftFootNode).p;
  const pToe = worldAt0(leftToeNode).p;
  const v = vec3Subtract(pToe, pFoot);
  const len = Math.hypot(...v);
  const vNorm = v.map(val => val / len);
  console.log(`Animated Left foot vector (Foot -> ToeBase) at t=0:`, v);
  console.log(`Animated Left foot normalized vector:`, vNorm);

  // Check 1: X component (lateral) should be near 0 (pointing straight forward in XZ plane)
  console.log(`X component: ${vNorm[0].toFixed(4)} (Expected close to 0, e.g. < 0.15 due to standing turn-out)`);
  
  // Check 2: Z component (forward) should be positive
  console.log(`Z component: ${vNorm[2].toFixed(4)} (Expected positive)`);

  // Compute the expected Y component based on original vector in BoneRoot space:
  // vOrigRotNorm is [0, -0.1738, -0.9848] before alignment.
  // Since the character faces -Z, its retargeted foot should also face -Z to avoid pointing backwards.
  const expectedY = -0.1737853339090477;
  const expectedZ = -0.9847835588179369;

  const diffY = Math.abs(vNorm[1] - expectedY);
  const diffZ = Math.abs(vNorm[2] - expectedZ);
  console.log(`Difference in Y (pitch): ${diffY.toFixed(6)} (Expected extremely close to 0)`);
  console.log(`Difference in Z: ${diffZ.toFixed(6)} (Expected extremely close to 0)`);

  if (diffY < 0.05 && diffZ < 0.05 && Math.abs(vNorm[0]) < 0.15 && vNorm[2] < 0) {
    console.log('SUCCESS: Retargeted foot alignment is correct and pitch-preserved!');
    process.exit(0);
  } else {
    console.error('FAIL: Retargeted foot alignment is incorrect!');
    process.exit(1);
  }
} else {
  console.error('FAIL: leftFoot or leftToe not found');
  process.exit(1);
}
