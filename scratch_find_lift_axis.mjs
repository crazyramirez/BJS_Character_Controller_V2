/**
 * scratch_find_lift_axis.mjs
 * Figures out what rotation to apply to Boy's LeftArm to lift it from
 * 59° drooped to horizontal (T-pose equivalent).
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

function qMul([x1,y1,z1,w1],[x2,y2,z2,w2]) {
  return [x1*w2+w1*x2+y1*z2-z1*y2, y1*w2+w1*y2+z1*x2-x1*z2, z1*w2+w1*z2+x1*y2-y1*x2, w1*w2-x1*x2-y1*y2-z1*z2];
}
function qInvert([x,y,z,w]) { return [-x,-y,-z,w]; }
function qNorm([x,y,z,w]) { const l=Math.sqrt(x*x+y*y+z*z+w*w); return [x/l,y/l,z/l,w/l]; }
function rotateVec3([x,y,z],[qx,qy,qz,qw]) {
  const ix=qw*x+qy*z-qz*y, iy=qw*y+qz*x-qx*z, iz=qw*z+qx*y-qy*x, iw=-qx*x-qy*y-qz*z;
  return [ix*qw+iw*-qx+iy*-qz-iz*-qy, iy*qw+iw*-qy+iz*-qx-ix*-qz, iz*qw+iw*-qz+ix*-qy-iy*-qx];
}
function vecAdd([a,b,c],[d,e,f]) { return [a+d,b+e,c+f]; }
function vecSub([a,b,c],[d,e,f]) { return [a-d,b-e,c-f]; }
function vecLen([a,b,c]) { return Math.sqrt(a*a+b*b+c*c); }
function vecNorm(v) { const l=vecLen(v); return l>0?v.map(x=>x/l):[0,0,0]; }
function dot(a,b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross([a1,a2,a3],[b1,b2,b3]) { return [a2*b3-a3*b2, a3*b1-a1*b3, a1*b2-a2*b1]; }
function toDeg(r) { return r * 180 / Math.PI; }
function toRad(d) { return d * Math.PI / 180; }

function buildParentMap(doc) {
  const map = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) map.set(c, n);
  return map;
}
function computeWorldTransforms(doc) {
  const pm = buildParentMap(doc), rotC = new Map(), posC = new Map();
  function get(n) {
    if (rotC.has(n)) return;
    const lr = n.getRotation() || [0,0,0,1], lp = n.getTranslation() || [0,0,0], parent = pm.get(n);
    if (parent) { get(parent); rotC.set(n, qMul(rotC.get(parent), lr)); posC.set(n, vecAdd(posC.get(parent), rotateVec3(lp, rotC.get(parent)))); }
    else { rotC.set(n, lr); posC.set(n, lp); }
  }
  for (const n of doc.getRoot().listNodes()) get(n);
  return { rotC, posC };
}

const boyBuf = fs.readFileSync('./assets/3d_character_young_boy.glb');
const boyDoc = await io.readBinary(new Uint8Array(boyBuf));
const { rotC, posC } = computeWorldTransforms(boyDoc);
const pm = buildParentMap(boyDoc);

let leftShoulder = null, leftArm = null, leftForeArm = null;
for (const n of boyDoc.getRoot().listNodes()) {
  const name = (n.getName() || '').toLowerCase();
  if (name === 'leftshoulder_28') leftShoulder = n;
  if (name === 'leftarm_27') leftArm = n;
  if (name === 'leftforearm_26') leftForeArm = n;
}

if (!leftArm || !leftForeArm) { console.error('Bones not found!'); process.exit(1); }

// Current state
const posArm = posC.get(leftArm);
const posForearm = posC.get(leftForeArm);
const worldRotArm = rotC.get(leftArm);
const worldRotShoulder = leftShoulder ? rotC.get(leftShoulder) : [0,0,0,1];

// Current arm direction (from arm to forearm in world space)
const armDir = vecNorm(vecSub(posForearm, posArm));
const armPitch = toDeg(Math.asin(Math.min(1, Math.max(-1, armDir[1]))));

console.log('Boy LeftArm world pos:', posArm.map(v=>v.toFixed(4)));
console.log('Boy LeftForeArm world pos:', posForearm.map(v=>v.toFixed(4)));
console.log('Current arm direction:', armDir.map(v=>v.toFixed(4)));
console.log('Current arm pitch:', armPitch.toFixed(2) + '°');
console.log('Target arm pitch: 0°');
console.log('Needed correction: +' + (-armPitch).toFixed(2) + '°\n');

// The arm is in the XZ plane mostly (world). To lift it by ~59°, we rotate around Z.
// In PARENT (shoulder) space, what axis should we rotate around?

// Shoulder's world rotation
console.log('LeftShoulder world rot:', worldRotShoulder.map(v=>v.toFixed(4)));

// The arm's local axes in world space:
const armLocalX = rotateVec3([1,0,0], worldRotArm); // bone forward
const armLocalY = rotateVec3([0,1,0], worldRotArm); // bone up (= world Y when in T-pose)
const armLocalZ = rotateVec3([0,0,1], worldRotArm); // bone roll

console.log('\nBoy LeftArm bone axes in world space:');
console.log('  Local +X (bone forward):', armLocalX.map(v=>v.toFixed(4)));
console.log('  Local +Y (bone up):     ', armLocalY.map(v=>v.toFixed(4)));
console.log('  Local +Z (bone roll):   ', armLocalZ.map(v=>v.toFixed(4)));

// To lift the arm from -59° to 0°, we need to rotate around an axis perpendicular to both armDir and world-Y
// Rotation axis in world space: cross(armDir, [0,1,0]) normalized
const worldUpRef = [0, 1, 0];
const rotAxisWorld = vecNorm(cross(armDir, worldUpRef));
console.log('\nRotation axis in world space (to lift arm):', rotAxisWorld.map(v=>v.toFixed(4)));

// Project this world axis into the shoulder's local space
const shoulderWorldRotInv = qInvert(worldRotShoulder);
const rotAxisInShoulderSpace = rotateVec3(rotAxisWorld, shoulderWorldRotInv);
console.log('Rotation axis in shoulder local space:', rotAxisInShoulderSpace.map(v=>v.toFixed(4)));

// Project into the arm's local space (local rotation pOffset applied at arm level)
const armWorldRotInv = qInvert(worldRotArm);
const rotAxisInArmSpace = rotateVec3(rotAxisWorld, armWorldRotInv);
console.log('Rotation axis in arm local space:', rotAxisInArmSpace.map(v=>v.toFixed(4)));

// The current code applies pOffset as eulerToQuat(pitch, yaw, roll) = eulerToQuat(pOffset[0], pOffset[1], pOffset[2])
// Pitch = X-axis rotation, Yaw = Y-axis rotation, Roll = Z-axis rotation
// Let's see: if we set pOffset[1] = 59 (yaw/Y), does that correspond to the needed axis?
// Local Y in world space = [0.0479, -0.9967, 0.0479] (approx — let's check more carefully)
const armLocalYworld = rotateVec3([0,1,0], worldRotArm);
const armLocalXworld = rotateVec3([1,0,0], worldRotArm);  
const armLocalZworld = rotateVec3([0,0,1], worldRotArm);

console.log('\nArm local axes (as seen in world):');
console.log('  +X:', armLocalXworld.map(v=>v.toFixed(4)));
console.log('  +Y:', armLocalYworld.map(v=>v.toFixed(4)));
console.log('  +Z:', armLocalZworld.map(v=>v.toFixed(4)));

// The needed rotation is around rotAxisWorld
// Which local axis of the arm is most aligned with rotAxisWorld?
const dotX = Math.abs(dot(rotAxisWorld, armLocalXworld));
const dotY = Math.abs(dot(rotAxisWorld, armLocalYworld));
const dotZ = Math.abs(dot(rotAxisWorld, armLocalZworld));
console.log('\nAlignment of needed rotation axis with arm local axes:');
console.log('  |dot with +X|:', dotX.toFixed(4), '(pitch/X axis)');
console.log('  |dot with +Y|:', dotY.toFixed(4), '(yaw/Y axis)');
console.log('  |dot with +Z|:', dotZ.toFixed(4), '(roll/Z axis)');
console.log('\n→ Best local axis to use:', dotX > dotY && dotX > dotZ ? 'PITCH (X)' : dotY > dotZ ? 'YAW (Y)' : 'ROLL (Z)');

// Also determine the sign of the rotation needed
const signedDotY = dot(rotAxisWorld, armLocalYworld);
const signedDotZ = dot(rotAxisWorld, armLocalZworld);
console.log('\nSigned dot with +Y:', signedDotY.toFixed(4), '→', signedDotY > 0 ? 'positive Y rotation lifts arm' : 'NEGATIVE Y rotation lifts arm');
console.log('Signed dot with +Z:', signedDotZ.toFixed(4), '→', signedDotZ > 0 ? 'positive Z rotation lifts arm' : 'NEGATIVE Z rotation lifts arm');
