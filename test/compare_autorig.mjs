import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';
const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await dracoLib.createDecoderModule(),
    'draco3d.encoder': await dracoLib.createEncoderModule(),
  });

const refDoc = await io.read('assets/character_animated_1.glb');
const root = refDoc.getRoot();
for (const skin of root.listSkins()) skin.dispose();
for (const node of root.listNodes()) node.setSkin(null);
const skinlessBuf = await io.writeBinary(refDoc);

const guess = await guessJoints(skinlessBuf, {});
console.log('GUESS joints count:', Object.keys(guess.joints).length);
console.log('Humanoid:', guess.humanoid, 'score:', guess.score, 'reason:', guess.reason);

const riggedBuf = await autoRigGLB(skinlessBuf, {});
const rigDoc = await io.readBinary(riggedBuf);
const rigSkin = rigDoc.getRoot().listSkins()[0];
console.log('\nRIGGED joints:', rigSkin.listJoints().length);

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) map.set(child, node);
  }
  return map;
}
function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
    out[col * 4 + row] = s;
  }
  return out;
}
function worldMatrixOf(node, parentMap, cache) {
  if (cache.has(node)) return cache.get(node);
  const local = node.getMatrix();
  const parent = parentMap.get(node);
  const world = parent ? mat4Mul(worldMatrixOf(parent, parentMap, cache), local) : local;
  cache.set(node, world); return world;
}

const refDoc2 = await io.read('assets/character_animated_1.glb');
const refSkin = refDoc2.getRoot().listSkins()[0];
const refJoints = refSkin.listJoints();
const refMap = new Map(refJoints.map((j, i) => [j.getName().replace('mixamorig:', ''), { j, i }]));
const rigJoints = rigSkin.listJoints();
const rigMap = new Map(rigJoints.map((j, i) => [j.getName(), { j, i }]));
const refParentMap = buildParentMap(refDoc2);
const rigParentMap = buildParentMap(rigDoc);
const refCache = new Map(), rigCache = new Map();

console.log('\nPosition differences (ref vs rig) for common joints:');
for (const [name, { j: rj }] of rigMap) {
  const refItem = refMap.get(name);
  if (!refItem) continue;
  const refW = worldMatrixOf(refItem.j, refParentMap, refCache);
  const rigW = worldMatrixOf(rj, rigParentMap, rigCache);
  const dp = [refW[12] - rigW[12], refW[13] - rigW[13], refW[14] - rigW[14]];
  const dist = Math.hypot(...dp);
  if (dist > 0.001) console.log(name, 'dist', dist.toFixed(4), 'ref', [refW[12], refW[13], refW[14]].map(v => v.toFixed(3)).join(','), 'rig', [rigW[12], rigW[13], rigW[14]].map(v => v.toFixed(3)).join(','));
}
