/**
 * scratch_verify_c_matrix.mjs
 * Verifies C ≈ identity with the shoulder-ancestor Wchar approach.
 */
import fs from 'fs';
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

function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
  return [x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2, y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2, z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2];
}
function qInvert([x, y, z, w]) { return [-x, -y, -z, w]; }
function toDeg(r) { return r * 180 / Math.PI; }

function buildParentMap(doc) {
  const map = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) map.set(c, n);
  return map;
}
function computeWorldRots(doc) {
  const pm = buildParentMap(doc), cache = new Map();
  function get(n) {
    if (cache.has(n)) return cache.get(n);
    const l = n.getRotation() || [0, 0, 0, 1], par = pm.get(n);
    const w = par ? qMul(get(par), l) : l;
    cache.set(n, w); return w;
  }
  for (const n of doc.getRoot().listNodes()) get(n);
  return cache;
}

const boyBuf = fs.readFileSync('./assets/3d_character_young_boy.glb');
const animBuf = fs.readFileSync('./assets/character_animated.glb');

const boyDoc = await io.readBinary(new Uint8Array(boyBuf));
const animDoc = await io.readBinary(new Uint8Array(animBuf));

const boyWorldRots = computeWorldRots(boyDoc);
const animWorldRots = computeWorldRots(animDoc);
const boyPM = buildParentMap(boyDoc);

// Get boy's arm bones
let leftShoulder = null, leftArm = null, leftForeArm = null;
for (const n of boyDoc.getRoot().listNodes()) {
  const name = (n.getName() || '').toLowerCase();
  if (name === 'leftshoulder_28') leftShoulder = n;
  if (name === 'leftarm_27') leftArm = n;
  if (name === 'leftforearm_26') leftForeArm = n;
}

// Get pepe's arm bones
let pepeLeftArm = null, pepeLeftForeArm = null;
for (const n of animDoc.getRoot().listNodes()) {
  const name = (n.getName() || '').toLowerCase();
  if (name === 'mixamorig:leftarm') pepeLeftArm = n;
  if (name === 'mixamorig:leftforearm') pepeLeftForeArm = n;
}

const WshoulderBoy = boyWorldRots.get(leftShoulder);
const WarmBoy = boyWorldRots.get(leftArm);
const WforearmBoy = boyWorldRots.get(leftForeArm);
const WarmAnim = animWorldRots.get(pepeLeftArm);
const WforearmAnim = animWorldRots.get(pepeLeftForeArm);

function quatToAngleDeg(q) {
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
  return toDeg(angle);
}

console.log('=== C matrix analysis (new approach: shoulder as Wchar) ===\n');

// For LeftArm: Wchar = Wshoulder_boy
const C_arm = qMul(qInvert(WshoulderBoy), WarmAnim);
console.log('LeftArm:');
console.log(`  Wchar (Wshoulder_boy): [${WshoulderBoy.map(v => v.toFixed(4))}]`);
console.log(`  Wanim (Pepe LeftArm):  [${WarmAnim.map(v => v.toFixed(4))}]`);
console.log(`  C = Wchar⁻¹·Wanim:    [${C_arm.map(v => v.toFixed(4))}]`);
console.log(`  C angle:               ${quatToAngleDeg(C_arm).toFixed(2)}° (0=identity)`);

// For LeftForeArm: also use Wshoulder (ancestor walk finds shoulder 2 levels up)
const C_forearm = qMul(qInvert(WshoulderBoy), WforearmAnim);
console.log('\nLeftForeArm:');
console.log(`  Wchar (Wshoulder_boy):   [${WshoulderBoy.map(v => v.toFixed(4))}]`);
console.log(`  Wanim (Pepe LeftForeArm):[${WforearmAnim.map(v => v.toFixed(4))}]`);
console.log(`  C = Wchar⁻¹·Wanim:      [${C_forearm.map(v => v.toFixed(4))}]`);
console.log(`  C angle:                 ${quatToAngleDeg(C_forearm).toFixed(2)}° (0=identity)`);

// OLD approach: using bone's own world rotation
const C_arm_old = qMul(qInvert(WarmBoy), WarmAnim);
const C_forearm_old = qMul(qInvert(WforearmBoy), WforearmAnim);
console.log('\n=== OLD approach (own world rotation) ===');
console.log(`LeftArm    C angle: ${quatToAngleDeg(C_arm_old).toFixed(2)}°`);
console.log(`LeftForeArm C angle: ${quatToAngleDeg(C_forearm_old).toFixed(2)}°`);

console.log('\n=== Summary ===');
console.log(`New approach arm C angle:     ${quatToAngleDeg(C_arm).toFixed(2)}° → ${quatToAngleDeg(C_arm) < 5 ? '✓ NEAR IDENTITY - motion will transfer correctly' : '✗ NOT identity - may distort'}`);
console.log(`Old approach arm C angle:     ${quatToAngleDeg(C_arm_old).toFixed(2)}° → was encoding the A-pose difference`);
