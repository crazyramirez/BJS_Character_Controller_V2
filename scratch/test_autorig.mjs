/** Test autorig_api: build a skinless humanoid-proportioned mesh, rig it, analyze result. */
import { Document, NodeIO } from '@gltf-transform/core';
import { autoRigGLB, guessJoints } from '../js/core/autorig_api.mjs';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';
import { readFileSync } from 'fs';

// Build a simple "humanoid" out of vertices: a 1.8m tall, 1.6m wide T cloud
const doc = new Document();
const buffer = doc.createBuffer();
const positions = [];
// torso column
for (let y = 0; y <= 1.8; y += 0.05) positions.push(0, y, 0, 0.08, y, 0, -0.08, y, 0);
// arms at shoulder height
for (let x = -0.8; x <= 0.8; x += 0.05) positions.push(x, 1.45, 0);
// legs
for (let y = 0; y <= 0.9; y += 0.05) positions.push(0.11, y, 0, -0.11, y, 0);
const posArr = new Float32Array(positions);
const indices = [];
for (let i = 0; i + 2 < posArr.length / 3; i++) indices.push(i, i + 1, i + 2);

const pos = doc.createAccessor().setType('VEC3').setArray(posArr).setBuffer(buffer);
const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer);
const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);
const mesh = doc.createMesh('body').addPrimitive(prim);
const node = doc.createNode('BodyNode').setMesh(mesh).setTranslation([0, 0, 0]);
doc.createScene('scene').addChild(node);

const io = new NodeIO();
const glb = await io.writeBinary(doc);

console.log('1. guessJoints...');
const guess = await guessJoints(glb);
console.log('   height:', guess.height.toFixed(2), 'Hips:', guess.joints.Hips.map(v => v.toFixed(2)).join(','));

console.log('2. autoRigGLB (default joints)...');
const rigged = await autoRigGLB(glb);
console.log('   rigged size:', rigged.length, 'bytes');

console.log('3. analyzeGLB on rigged output...');
const analysis = await analyzeGLB(rigged);
console.log('   hasSkin:', analysis.hasSkin, '| bones:', analysis.boneCount, '| type:', analysis.skeletonType.label, '| pose:', analysis.poseStyle);
if (!analysis.hasSkin || analysis.boneCount < 20) throw new Error('FAIL: rig missing');

console.log('4. autoRigGLB with custom joint override...');
const rigged2 = await autoRigGLB(glb, { joints: { Hips: [0, 1.0, 0] } });
console.log('   ok, size:', rigged2.length);

console.log('5. mergeGLBs rigged char + animations.glb...');
try {
  const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));
  const merged = await mergeGLBs(rigged, animBuf, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
  const mAnalysis = await analyzeGLB(merged);
  console.log('   merged animations:', mAnalysis.animations.length);
  if (mAnalysis.animations.length === 0) throw new Error('FAIL: no animations after merge');
} catch (e) {
  if (e.code === 'ENOENT') console.log('   (skipped — assets/animations.glb not found)');
  else throw e;
}

console.log('6. re-rig: guessJoints on already-rigged GLB (should seed from existing bones)...');
const guess2 = await guessJoints(rigged);
console.log('   reRig:', guess2.reRig, '| Hips seed:', guess2.joints.Hips.map(v => v.toFixed(2)).join(','));
if (!guess2.reRig) throw new Error('FAIL: reRig flag missing');

console.log('7. re-rig: autoRigGLB on already-rigged GLB...');
const reRigged = await autoRigGLB(rigged, { joints: { Hips: [0, 0.95, 0] } });
const reAnalysis = await analyzeGLB(reRigged);
console.log('   hasSkin:', reAnalysis.hasSkin, '| bones:', reAnalysis.boneCount, '| anims:', reAnalysis.animations.length);
if (!reAnalysis.hasSkin || reAnalysis.boneCount !== 22) throw new Error('FAIL: re-rig produced wrong skeleton');

console.log('8. re-rig on MERGED char (with animations) — old anims must be stripped...');
const animBuf2 = readFileSync(new URL('../assets/animations.glb', import.meta.url));
const mergedChar = await mergeGLBs(rigged, animBuf2, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
const reRigged2 = await autoRigGLB(mergedChar);
const reAnalysis2 = await analyzeGLB(reRigged2);
console.log('   hasSkin:', reAnalysis2.hasSkin, '| bones:', reAnalysis2.boneCount, '| anims left:', reAnalysis2.animations.length);
if (reAnalysis2.animations.length !== 0) throw new Error('FAIL: old animations survived re-rig');

console.log('\nALL OK');
