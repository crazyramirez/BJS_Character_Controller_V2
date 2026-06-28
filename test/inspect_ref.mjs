import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await dracoLib.createDecoderModule(),
    'draco3d.encoder': await dracoLib.createEncoderModule(),
  });
const doc = await io.read('assets/character_animated_1.glb');
const root = doc.getRoot();
console.log('nodes', root.listNodes().length);
console.log('skins', root.listSkins().length);

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) map.set(child, node);
  }
  return map;
}
function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}
function invertRigidMat4(m) {
  const a00 = m[0], a10 = m[1], a20 = m[2];
  const a01 = m[4], a11 = m[5], a21 = m[6];
  const a02 = m[8], a12 = m[9], a22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (!det || !Number.isFinite(det)) return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  const id = 1 / det;
  const i00 = (a11 * a22 - a12 * a21) * id, i01 = (a02 * a21 - a01 * a22) * id, i02 = (a01 * a12 - a02 * a11) * id;
  const i10 = (a12 * a20 - a10 * a22) * id, i11 = (a00 * a22 - a02 * a20) * id, i12 = (a02 * a10 - a00 * a12) * id;
  const i20 = (a10 * a21 - a11 * a20) * id, i21 = (a01 * a20 - a00 * a21) * id, i22 = (a00 * a11 - a01 * a10) * id;
  return new Float32Array([i00, i10, i20, 0, i01, i11, i21, 0, i02, i12, i22, 0, -(i00*tx+i01*ty+i02*tz), -(i10*tx+i11*ty+i12*tz), -(i20*tx+i21*ty+i22*tz), 1]);
}
function worldMatrixOf(node, parentMap, cache) {
  if (cache.has(node)) return cache.get(node);
  const local = node.getMatrix();
  const parent = parentMap.get(node);
  const world = parent ? mat4Mul(worldMatrixOf(parent, parentMap, cache), local) : local;
  cache.set(node, world);
  return world;
}

const parentMap = buildParentMap(doc);
const cache = new Map();
const skin = root.listSkins()[0];
const joints = skin.listJoints();
const ibmAcc = skin.getInverseBindMatrices();
const ibmArr = ibmAcc.getArray();
console.log('\nHierarchy & bind positions:');
for (let i = 0; i < joints.length; i++) {
  const j = joints[i];
  const W = worldMatrixOf(j, parentMap, cache);
  const p = [W[12], W[13], W[14]];
  const parent = parentMap.get(j);
  const ibm = ibmArr.slice(i*16, i*16+16);
  const inv = invertRigidMat4(ibm);
  console.log(i, j.getName(), 'parent:', parent ? parent.getName() : 'null', 'pos:', p.map(v=>v.toFixed(4)).join(','), 'ibmPos:', [inv[12],inv[13],inv[14]].map(v=>v.toFixed(4)).join(','));
}
