/**
 * scratch_c_matrix.mjs
 * Checks the actual C matrix (change-of-basis) computed between Boy character and the animation source.
 * This tells us if C is correctly capturing the arm pose difference.
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
function rotateVec3([x,y,z],[qx,qy,qz,qw]) {
  const ix=qw*x+qy*z-qz*y, iy=qw*y+qz*x-qx*z, iz=qw*z+qx*y-qy*x, iw=-qx*x-qy*y-qz*z;
  return [ix*qw+iw*-qx+iy*-qz-iz*-qy, iy*qw+iw*-qy+iz*-qx-ix*-qz, iz*qw+iw*-qz+ix*-qy-iy*-qx];
}
function buildParentMap(doc) {
  const map = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) map.set(c, n);
  return map;
}
function computeWorldRots(doc) {
  const pm = buildParentMap(doc), cache = new Map();
  function get(n) {
    if (cache.has(n)) return cache.get(n);
    const local = n.getRotation() || [0,0,0,1], parent = pm.get(n);
    const world = parent ? qMul(get(parent), local) : local;
    cache.set(n, world); return world;
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

// Index both by lowercase name
const charWorldByName = new Map();
for (const n of boyDoc.getRoot().listNodes()) {
  const name = n.getName();
  if (name) charWorldByName.set(name.toLowerCase(), boyWorldRots.get(n) || [0,0,0,1]);
}

const animWorldByName = new Map();
for (const n of animDoc.getRoot().listNodes()) {
  const name = n.getName();
  if (name) animWorldByName.set(name.toLowerCase(), animWorldRots.get(n) || [0,0,0,1]);
}

const charRestByName = new Map();
for (const n of boyDoc.getRoot().listNodes()) {
  const name = n.getName();
  if (name) charRestByName.set(name.toLowerCase(), n.getRotation() || [0,0,0,1]);
}

const animRestByName = new Map();
for (const n of animDoc.getRoot().listNodes()) {
  const name = n.getName();
  if (name) animRestByName.set(name.toLowerCase(), n.getRotation() || [0,0,0,1]);
}

// Check: after mergeGLBs, the target node is found by findMatchingBone.
// tgtName = target.getName().toLowerCase() = 'leftarm_27' (Boy)
// srcName = src.getName().toLowerCase() = whatever Pepe's bone is named in the merged doc

// First, let's see what Pepe's LeftArm is named in the animation file
console.log('Anim (character_animated) arm bones:');
for (const n of animDoc.getRoot().listNodes()) {
  const name = (n.getName() || '').toLowerCase();
  if (name.includes('leftarm') || name.includes('mixamorig:leftarm')) {
    const wrot = animWorldRots.get(n) || [0,0,0,1];
    const boneDir = rotateVec3([1,0,0], wrot);
    console.log(`  ${n.getName()} → world rot [${wrot.map(v=>v.toFixed(4))}], boneDir [${boneDir.map(v=>v.toFixed(4))}]`);
  }
}

console.log('\nBoy arm bones:');
for (const n of boyDoc.getRoot().listNodes()) {
  const name = (n.getName() || '').toLowerCase();
  if (name.includes('leftarm') || name === 'leftarm_27') {
    const wrot = boyWorldRots.get(n) || [0,0,0,1];
    const boneDir = rotateVec3([1,0,0], wrot);
    console.log(`  ${n.getName()} → world rot [${wrot.map(v=>v.toFixed(4))}], boneDir [${boneDir.map(v=>v.toFixed(4))}]`);
  }
}

// Simulate the retargeting for leftarm
const tgtName = 'leftarm_27'; // What charWorldByName will have
// The anim source after merge would reference the anim bone by its original name
// In character_animated.glb, Pepe's LeftArm is named...
let srcAnimBoneName = null;
for (const n of animDoc.getRoot().listNodes()) {
  if ((n.getName() || '').toLowerCase().includes('leftarm')) {
    srcAnimBoneName = n.getName().toLowerCase();
    break;
  }
}
console.log(`\nSrc anim bone name: "${srcAnimBoneName}"`);

const Wchar = charWorldByName.get(tgtName) || [0,0,0,1];
const Wanim = animWorldByName.get(srcAnimBoneName) || [0,0,0,1];
const rChar = charRestByName.get(tgtName) || [0,0,0,1];
const rAnim = animRestByName.get(srcAnimBoneName) || [0,0,0,1];
const C = qMul(qInvert(Wchar), Wanim);
const Cinv = qInvert(C);

console.log(`\nWchar (Boy LeftArm world rot):  [${Wchar.map(v=>v.toFixed(4))}]`);
console.log(`Wanim (Anim LeftArm world rot):  [${Wanim.map(v=>v.toFixed(4))}]`);
console.log(`C = Wchar⁻¹·Wanim:               [${C.map(v=>v.toFixed(4))}]`);
console.log(`rChar (Boy LeftArm local rest):  [${rChar.map(v=>v.toFixed(4))}]`);
console.log(`rAnim (Anim LeftArm local rest): [${rAnim.map(v=>v.toFixed(4))}]`);

// Test: when qKey = rAnim (rest → rest), what does final equal?
const rAnimInv = qInvert(rAnim);
const delta_rest = qMul(rAnimInv, rAnim); // = identity
const rotated_rest = qMul(qMul(C, delta_rest), Cinv); // = identity
const final_rest = qMul(rChar, rotated_rest); // = rChar
console.log(`\nWhen qKey=rAnim (rest→rest): final = [${final_rest.map(v=>v.toFixed(4))}]`);
console.log(`Expected (rChar):              [${rChar.map(v=>v.toFixed(4))}]`);

// Test: when the animation lifts the arm to T-pose (horizontal)
// In Pepe's local space, the LeftArm rest is nearly identity (slight bend).
// If we apply no rotation delta (qKey=rAnim), we get rChar (59° drooped).
// The animation needs to ACTIVELY drive the arm to a lifted position.
// Let's check if the animation source has any keyframe data for leftarm:
for (const anim of animDoc.getRoot().listAnimations()) {
  for (const ch of anim.listChannels()) {
    const n = ch.getTargetNode();
    if (n && (n.getName() || '').toLowerCase().includes('leftarm') && ch.getTargetPath() === 'rotation') {
      const sampler = ch.getSampler();
      const output = sampler?.getOutput();
      const arr = output?.getArray();
      if (arr && arr.length >= 4) {
        console.log(`\nFirst keyframe of ${n.getName()} rotation in "${anim.getName()}": [${[arr[0],arr[1],arr[2],arr[3]].map(v=>v.toFixed(4))}]`);
        // Apply retargeting
        const qKey = [arr[0],arr[1],arr[2],arr[3]];
        const delta = qMul(rAnimInv, qKey);
        const rotated = qMul(qMul(C, delta), Cinv);
        const final = qMul(rChar, rotated);
        
        // What world dir does this final rotation produce?
        const parentWrot = Wchar; // approximate: parent world rot ≈ Wchar (for first child of parent)
        // Actually we need the parent's world rot for the arm — that's LeftShoulder.
        // For simplicity, just show final rot direction  
        const armDir = rotateVec3([0,1,0], final); // arm goes along local Y for Mixamo
        console.log(`  Retargeted final rot: [${final.map(v=>v.toFixed(4))}]`);
        console.log(`  Local +Y direction: [${armDir.map(v=>v.toFixed(4))}]`);
      }
    }
  }
  break; // just first animation
}
