import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from './js/core/merge_api.mjs';

// Inline matrix 4 math implementation
function mat4_create() {
  return new Float32Array(16);
}

function mat4_copy(out, a) {
  for (let i = 0; i < 16; i++) out[i] = a[i];
  return out;
}

function mat4_multiply(out, a, b) {
  let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  let a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  let a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  let a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
  out[1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
  out[2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
  out[3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;

  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
  out[5] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
  out[6] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
  out[7] = b0*a03 + b1*a13 + b2*a23 + b3*a33;

  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
  out[9] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
  out[10] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
  out[11] = b0*a03 + b1*a13 + b2*a23 + b3*a33;

  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
  out[13] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
  out[14] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
  out[15] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
  return out;
}

function mat4_fromRotationTranslationScale(out, q, v, s) {
  let x = q[0], y = q[1], z = q[2], w = q[3];
  let x2 = x + x, y2 = y + y, z2 = z + z;
  let xx = x * x2, xy = x * y2, xz = x * z2;
  let yy = y * y2, yz = y * z2, zz = z * z2;
  let wx = w * x2, wy = w * y2, wz = w * z2;
  let sx = s[0], sy = s[1], sz = s[2];

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = v[0];
  out[13] = v[1];
  out[14] = v[2];
  out[15] = 1;
  return out;
}

async function main() {
  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  const animBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');

  console.log('Running mergeGLBs...');
  const mergedBuffer = await mergeGLBs(charBuffer, animBuffer, { COMPRESS_OUTPUT: false });

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const doc = await io.readBinary(new Uint8Array(mergedBuffer));

  const parentMap = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) parentMap.set(child, node);
  }

  function getLocalMatrix(node) {
    const t = node.getTranslation() || [0, 0, 0];
    const r = node.getRotation() || [0, 0, 0, 1];
    const s = node.getScale() || [1, 1, 1];
    const mat = mat4_create();
    mat4_fromRotationTranslationScale(mat, r, t, s);
    return mat;
  }

  const worldCache = new Map();
  function getWorldMatrix(node) {
    if (worldCache.has(node)) return worldCache.get(node);
    const local = getLocalMatrix(node);
    const parent = parentMap.get(node);
    const world = mat4_create();
    if (parent) {
      const parentWorld = getWorldMatrix(parent);
      mat4_multiply(world, parentWorld, local);
    } else {
      mat4_copy(world, local);
    }
    worldCache.set(node, world);
    return world;
  }

  // Find LeftFoot and LeftToeBase
  let foot = null;
  let toe = null;
  for (const node of doc.getRoot().listNodes()) {
    const name = (node.getName() || '').toLowerCase();
    if (name === 'mixamorig:leftfoot') foot = node;
    if (name === 'mixamorig:lefttoebase') toe = node;
  }

  if (foot && toe) {
    const mFoot = getWorldMatrix(foot);
    const mToe = getWorldMatrix(toe);
    const pFoot = [mFoot[12], mFoot[13], mFoot[14]];
    const pToe = [mToe[12], mToe[13], mToe[14]];
    const dir = [pToe[0] - pFoot[0], pToe[1] - pFoot[1], pToe[2] - pFoot[2]];
    console.log(`  Merged LeftFoot world pos: [${pFoot.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  Merged LeftToeBase world pos: [${pToe.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  Direction vector (Foot -> Toe): [${dir.map(v=>v.toFixed(4)).join(', ')}]`);
  } else {
    console.log('  Could not find LeftFoot or LeftToeBase in merged file.');
  }
}

main().catch(console.error);
