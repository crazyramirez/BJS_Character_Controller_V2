/**
 * scratch_arm_debug.mjs
 * Diagnoses arm bone orientations for both characters to understand
 * the root cause of arm distortion during retargeting.
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
  return [
    x1*w2 + w1*x2 + y1*z2 - z1*y2,
    y1*w2 + w1*y2 + z1*x2 - x1*z2,
    z1*w2 + w1*z2 + x1*y2 - y1*x2,
    w1*w2 - x1*x2 - y1*y2 - z1*z2,
  ];
}
function rotateVec3([x,y,z],[qx,qy,qz,qw]) {
  const ix = qw*x + qy*z - qz*y, iy = qw*y + qz*x - qx*z, iz = qw*z + qx*y - qy*x, iw = -qx*x - qy*y - qz*z;
  return [ix*qw+iw*-qx+iy*-qz-iz*-qy, iy*qw+iw*-qy+iz*-qx-ix*-qz, iz*qw+iw*-qz+ix*-qy-iy*-qx];
}
function vecAdd([a,b,c],[d,e,f]) { return [a+d,b+e,c+f]; }
function vecSub([a,b,c],[d,e,f]) { return [a-d,b-e,c-f]; }
function vecLen([a,b,c]) { return Math.sqrt(a*a+b*b+c*c); }
function vecNorm(v) { const l=vecLen(v); return l>0?v.map(x=>x/l):[0,0,0]; }
function toDeg(r) { return r * 180 / Math.PI; }

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes())
    for (const child of node.listChildren()) map.set(child, node);
  return map;
}

function computeWorldTransforms(doc) {
  const pm = buildParentMap(doc);
  const rotCache = new Map(), posCache = new Map();
  function get(node) {
    if (rotCache.has(node)) return { rot: rotCache.get(node), pos: posCache.get(node) };
    const localRot = node.getRotation() || [0,0,0,1];
    const localPos = node.getTranslation() || [0,0,0];
    const parent = pm.get(node);
    if (parent) {
      const { rot: pRot, pos: pPos } = get(parent);
      const worldRot = qMul(pRot, localRot);
      const worldPos = vecAdd(pPos, rotateVec3(localPos, pRot));
      rotCache.set(node, worldRot);
      posCache.set(node, worldPos);
      return { rot: worldRot, pos: worldPos };
    }
    rotCache.set(node, localRot);
    posCache.set(node, localPos);
    return { rot: localRot, pos: localPos };
  }
  for (const n of doc.getRoot().listNodes()) get(n);
  return { rotCache, posCache };
}

function analyzeCharacter(doc, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('='.repeat(60));
  
  const { rotCache, posCache } = computeWorldTransforms(doc);
  
  const ARM_BONES = ['leftarm', 'leftforearm', 'leftshoulder', 'rightarm', 'rightforearm', 'rightshoulder'];
  
  for (const node of doc.getRoot().listNodes()) {
    const name = (node.getName() || '').toLowerCase();
    if (!ARM_BONES.some(ab => name.includes(ab))) continue;
    
    const worldRot = rotCache.get(node);
    const worldPos = posCache.get(node);
    const localRot = node.getRotation() || [0,0,0,1];
    const localPos = node.getTranslation() || [0,0,0];
    
    // The bone points in its local +X axis direction (for Mixamo arms)
    // Transform local X = [1,0,0] into world space using world rotation
    const boneDir = rotateVec3([1,0,0], worldRot);
    
    console.log(`\n  Bone: ${node.getName()}`);
    console.log(`  Local rotation (xyzw): [${localRot.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  Local position:        [${localPos.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  World rotation (xyzw): [${worldRot.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  World position:        [${worldPos.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  Bone-forward dir (+X): [${boneDir.map(v=>v.toFixed(4)).join(', ')}]`);
    
    // Calculate yaw (Y-up angle from +X axis in XZ plane) and pitch (elevation from XZ plane)
    const yaw = toDeg(Math.atan2(boneDir[2], boneDir[0]));
    const pitch = toDeg(Math.asin(Math.min(1, Math.max(-1, boneDir[1]))));
    console.log(`  Pitch (up/down):       ${pitch.toFixed(2)}°   (0°=horizontal, +ve=up, -ve=down)`);
    console.log(`  Yaw (left/right):      ${yaw.toFixed(2)}°`);
  }
}

async function run() {
  const boyBuf = fs.readFileSync('d:/DEV/BJS Character Controller V2/assets/3d_character_young_boy.glb');
  const pepeBuf = fs.readFileSync('d:/DEV/BJS Character Controller V2/assets/pepe.glb');
  
  const boyDoc = await io.readBinary(new Uint8Array(boyBuf));
  const pepeDoc = await io.readBinary(new Uint8Array(pepeBuf));
  
  analyzeCharacter(boyDoc, '3d_character_young_boy.glb');
  analyzeCharacter(pepeDoc, 'pepe.glb (reference, working)');
  
  // Also show direction vector from LeftArm → LeftForearm in world space for each
  for (const [doc, label] of [[boyDoc, 'Boy'], [pepeDoc, 'Pepe']]) {
    const { posCache } = computeWorldTransforms(doc);
    let leftArm = null, leftForearm = null;
    for (const n of doc.getRoot().listNodes()) {
      const name = (n.getName() || '').toLowerCase();
      if (name === 'leftarm' || name.endsWith(':leftarm')) leftArm = n;
      if (name === 'leftforearm' || name.endsWith(':leftforearm')) leftForearm = n;
    }
    if (leftArm && leftForearm) {
      const pA = posCache.get(leftArm);
      const pF = posCache.get(leftForearm);
      const dir = vecNorm(vecSub(pF, pA));
      const pitch = toDeg(Math.asin(Math.min(1, Math.max(-1, dir[1]))));
      console.log(`\n[${label}] LeftArm → LeftForearm world direction: [${dir.map(v=>v.toFixed(4)).join(', ')}]`);
      console.log(`  Pitch: ${pitch.toFixed(2)}° (0=horizontal T-pose, negative=arms angled down = A-pose)`);
    }
  }
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
