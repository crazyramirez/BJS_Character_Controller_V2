/**
 * scratch_spread_check.mjs
 * Checks if findMatchingBone finds arm bones and what spread angle is computed.
 * Mimics the exact logic in mergeGLBs' auto-detect block.
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
function rotateVec3([x,y,z],[qx,qy,qz,qw]) {
  const ix=qw*x+qy*z-qz*y, iy=qw*y+qz*x-qx*z, iz=qw*z+qx*y-qy*x, iw=-qx*x-qy*y-qz*z;
  return [ix*qw+iw*-qx+iy*-qz-iz*-qy, iy*qw+iw*-qy+iz*-qx-ix*-qz, iz*qw+iw*-qz+ix*-qy-iy*-qx];
}
function vecAdd([a,b,c],[d,e,f]) { return [a+d,b+e,c+f]; }
function vecSub([a,b,c],[d,e,f]) { return [a-d,b-e,c-f]; }
function vecNorm(v) { const l=Math.sqrt(v.reduce((s,x)=>s+x*x,0)); return l>0?v.map(x=>x/l):[0,0,0]; }

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes())
    for (const child of node.listChildren()) map.set(child, node);
  return map;
}

function stripBJSSuffix(name) { return name ? name.replace(/_\d+$/, '') : name; }
function normalizeName(name) {
  if (!name) return '';
  return stripBJSSuffix(name).toLowerCase()
    .replace(/^(mixamorig\d*|armature|char|bi|bip\d*|biped|root|gltf_created_\d+_)\b[:_]*/i, '')
    .replace(/[:_\-\.\s]/g, '');
}

// Replicate the BONE_MAP
const BONE_MAP = {
  'pelvis': ['hips', 'mixamorig:hips'],
  'upperarm_l': ['leftarm', 'mixamorig:leftarm'],
  'lowerarm_l': ['leftforearm', 'mixamorig:leftforearm'],
  'clavicle_l': ['leftshoulder', 'mixamorig:leftshoulder'],
  'upperarm_r': ['rightarm', 'mixamorig:rightarm'],
  'lowerarm_r': ['rightforearm', 'mixamorig:rightforearm'],
};

function findMatchingBone(animNode, charByName, charByNorm) {
  const src = animNode.getName();
  if (!src) return null;
  const lo = src.toLowerCase();
  let hit = charByName.get(src) || charByName.get(lo);
  if (hit) return hit;
  const mapEntry = BONE_MAP[lo];
  if (mapEntry) {
    for (const alt of mapEntry) {
      hit = charByName.get(alt) || charByName.get(alt.toLowerCase());
      if (hit) return hit;
    }
  }
  for (const [key, alts] of Object.entries(BONE_MAP)) {
    if (alts.includes(lo)) {
      hit = charByName.get(key) || charByName.get(key.toLowerCase());
      if (hit) return hit;
    }
  }
  const norm = normalizeName(src);
  hit = charByNorm.get(norm);
  if (hit) return hit;
  for (const [n, node] of charByNorm) {
    if (norm.endsWith(n) || n.endsWith(norm)) return node;
  }
  return null;
}

async function checkCharacter(buf, label) {
  const doc = await io.readBinary(new Uint8Array(buf));
  
  // Build charByName / charByNorm the same way mergeGLBs does
  const charByName = new Map();
  const charByNorm = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (name) {
      charByName.set(name, node);
      charByName.set(name.toLowerCase(), node);
      const stripped = stripBJSSuffix(name);
      if (stripped !== name) {
        charByName.set(stripped, node);
        charByName.set(stripped.toLowerCase(), node);
      }
      const n = normalizeName(name);
      if (n) charByNorm.set(n, node);
    }
  }
  
  // Try to find 'leftarm' and 'leftforearm' via the synthetic proxy nodes (as mergeGLBs does)
  const leftArm = findMatchingBone({ getName: () => 'leftarm' }, charByName, charByNorm);
  const leftForearm = findMatchingBone({ getName: () => 'leftforearm' }, charByName, charByNorm);
  
  console.log(`\n=== ${label} ===`);
  console.log('charByName keys (arm/shoulder):', [...charByName.keys()].filter(k => /arm|shoulder|forearm/i.test(k)));
  console.log('charByNorm keys (arm):', [...charByNorm.keys()].filter(k => /arm|shoulder|forearm/i.test(k)));
  console.log('findMatchingBone("leftarm")    →', leftArm?.getName() ?? 'NOT FOUND');
  console.log('findMatchingBone("leftforearm") →', leftForearm?.getName() ?? 'NOT FOUND');
  
  if (leftArm && leftForearm) {
    // Compute world positions
    const parentMap = buildParentMap(doc);
    const rotCache = new Map(), posCache = new Map();
    function getT(node) {
      if (rotCache.has(node)) return { rot: rotCache.get(node), pos: posCache.get(node) };
      const lr = node.getRotation() || [0,0,0,1];
      const lp = node.getTranslation() || [0,0,0];
      const parent = parentMap.get(node);
      if (parent) {
        const { rot: pR, pos: pP } = getT(parent);
        rotCache.set(node, qMul(pR, lr));
        posCache.set(node, vecAdd(pP, rotateVec3(lp, pR)));
      } else {
        rotCache.set(node, lr);
        posCache.set(node, lp);
      }
      return { rot: rotCache.get(node), pos: posCache.get(node) };
    }
    for (const n of doc.getRoot().listNodes()) getT(n);
    
    const posArm = posCache.get(leftArm);
    const posForearm = posCache.get(leftForearm);
    const dir = vecNorm(vecSub(posForearm, posArm));
    const yVal = dir[1];
    const angleDeg = Math.asin(-yVal) * (180 / Math.PI);
    
    console.log(`World pos LeftArm:     [${posArm.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`World pos LeftForearm: [${posForearm.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`Direction LeftArm→LeftForearm: [${dir.map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`Y component: ${yVal.toFixed(4)}`);
    console.log(`Computed ARM_SPREAD_ANGLE: ${angleDeg.toFixed(2)}°`);
  }
}

const boyBuf = fs.readFileSync('d:/DEV/BJS Character Controller V2/assets/3d_character_young_boy.glb');
const pepeBuf = fs.readFileSync('d:/DEV/BJS Character Controller V2/assets/pepe.glb');

await checkCharacter(boyBuf, '3d_character_young_boy.glb');
await checkCharacter(pepeBuf, 'pepe.glb (reference)');
