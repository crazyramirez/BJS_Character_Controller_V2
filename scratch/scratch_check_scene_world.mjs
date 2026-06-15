import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

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

function mat4_invert(out, a) {
  let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  let a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  let a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  let a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  let b00 = a00 * a11 - a01 * a10;
  let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10;
  let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11;
  let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30;
  let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30;
  let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31;
  let b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
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
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  // Build parent map for scene nodes
  const parentMap = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) {
      parentMap.set(child, node);
    }
  }

  // Helper to compute local matrix of a node
  function getLocalMatrix(node) {
    const t = node.getTranslation() || [0, 0, 0];
    const r = node.getRotation() || [0, 0, 0, 1];
    const s = node.getScale() || [1, 1, 1];
    const mat = mat4_create();
    mat4_fromRotationTranslationScale(mat, r, t, s);
    return mat;
  }

  // Helper to compute world matrix of a node
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

  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const ibmAcc = skin.getInverseBindMatrices();
  const ibmArr = ibmAcc ? ibmAcc.getArray() : null;

  console.log('=== NODE WORLD MATRICES IN SCENE ===');
  for (let i = 0; i < Math.min(5, joints.length); i++) {
    const j = joints[i];
    const worldMat = getWorldMatrix(j);
    console.log(`Node "${j.getName()}":`);
    console.log(`  World Position: ${[worldMat[12], worldMat[13], worldMat[14]].map(v => v.toFixed(6))}`);
    
    if (ibmArr) {
      const idx = i * 16;
      const ibm = ibmArr.slice(idx, idx + 16);
      const invIbm = mat4_create();
      mat4_invert(invIbm, ibm);
      console.log(`  IBM-derived Bind World Position: ${[invIbm[12], invIbm[13], invIbm[14]].map(v => v.toFixed(6))}`);
      
      // Compute the product: WorldMatrix * InverseBindMatrix
      // (This product should be Identity if the pose matches the bind pose)
      const prod = mat4_create();
      mat4_multiply(prod, worldMat, ibm);
      console.log(`  World * IBM translation: ${[prod[12], prod[13], prod[14]].map(v => v.toFixed(6))}`);
    }
  }
}

main().catch(console.error);
