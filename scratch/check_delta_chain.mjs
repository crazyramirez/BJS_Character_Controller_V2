/** Compare per-bone world-delta D = W(t)·Wbind⁻¹ between original-rig merge and re-rigged merge. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

function qMul([x1,y1,z1,w1],[x2,y2,z2,w2]){return[x1*w2+w1*x2+y1*z2-z1*y2,y1*w2+w1*y2+z1*x2-x1*z2,z1*w2+w1*z2+x1*y2-y1*x2,w1*w2-x1*x2-y1*y2-z1*z2];}
function qInv([x,y,z,w]){return[-x,-y,-z,w];}
function mat4RotToQuat(m){const s0=Math.hypot(m[0],m[1],m[2])||1,s1=Math.hypot(m[4],m[5],m[6])||1,s2=Math.hypot(m[8],m[9],m[10])||1;
const m00=m[0]/s0,m10=m[1]/s0,m20=m[2]/s0,m01=m[4]/s1,m11=m[5]/s1,m21=m[6]/s1,m02=m[8]/s2,m12=m[9]/s2,m22=m[10]/s2;
const tr=m00+m11+m22;let x,y,z,w;
if(tr>0){const s=0.5/Math.sqrt(tr+1);w=0.25/s;x=(m21-m12)*s;y=(m02-m20)*s;z=(m10-m01)*s;}
else if(m00>m11&&m00>m22){const s=2*Math.sqrt(1+m00-m11-m22);w=(m21-m12)/s;x=0.25*s;y=(m01+m10)/s;z=(m02+m20)/s;}
else if(m11>m22){const s=2*Math.sqrt(1+m11-m00-m22);w=(m02-m20)/s;x=(m01+m10)/s;y=0.25*s;z=(m12+m21)/s;}
else{const s=2*Math.sqrt(1+m22-m00-m11);w=(m10-m01)/s;x=(m02+m20)/s;y=(m12+m21)/s;z=0.25*s;}
const l=Math.hypot(x,y,z,w);return[x/l,y/l,z/l,w/l];}
// invert affine, take rotation
function invRotOfIBM(ibm){ // W_bind = inv(IBM); rotation of inverse = inverse of rotation
  return qInv(mat4RotToQuat(ibm));
}

const CHAIN = ['hips','spine','spine1','spine2','rightshoulder','rightarm','rightforearm','righthand','leftarm','lefthand'];

async function deltas(buf, clip) {
  const doc = await io.readBinary(new Uint8Array(buf));
  const root = doc.getRoot();
  const parentMap = new Map();
  for (const n of root.listNodes()) for (const c of n.listChildren()) parentMap.set(c, n);

  // bind world rot per joint from IBMs
  const bindW = new Map();
  for (const skin of root.listSkins()) {
    const joints = skin.listJoints();
    const arr = skin.getInverseBindMatrices()?.getArray();
    if (!arr) continue;
    joints.forEach((j, i) => {
      const nm = (j.getName()||'').toLowerCase().replace(/_\d+$/,'').replace(/^mixamorig\d*:/,'');
      if (!bindW.has(nm)) bindW.set(nm, invRotOfIBM(arr.slice(i*16, i*16+16)));
    });
  }

  const anim = root.listAnimations().find(a => a.getName() === clip);
  const localRot = new Map();
  for (const ch of anim.listChannels()) {
    if (ch.getTargetPath() !== 'rotation') continue;
    const arr = ch.getSampler()?.getOutput()?.getArray();
    if (arr) localRot.set(ch.getTargetNode(), [arr[0],arr[1],arr[2],arr[3]]);
  }
  const wRot = new Map();
  function fk(n){
    if (wRot.has(n)) return wRot.get(n);
    const p = parentMap.get(n);
    const lr = localRot.get(n) || n.getRotation() || [0,0,0,1];
    const w = p ? qMul(fk(p), lr) : lr;
    wRot.set(n, w);
    return w;
  }
  const out = new Map();
  for (const n of root.listNodes()) {
    const nm = (n.getName()||'').toLowerCase().replace(/_\d+$/,'').replace(/^mixamorig\d*:/,'');
    if (!CHAIN.includes(nm) || out.has(nm)) continue;
    const D = qMul(fk(n), qInv(bindW.get(nm) || [0,0,0,1]));
    out.set(nm, D);
  }
  return out;
}

const charBuf = readFileSync(new URL('../assets/character_animated.glb', import.meta.url));
const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));
const orig = await mergeGLBs(charBuf, animBuf, { removeExistingAnimations: true });
const rerig = readFileSync(new URL('./out_rerigged_merged.glb', import.meta.url));

for (const clip of ['Punch_Cross', 'Crouch_Idle_Loop']) {
  const a = await deltas(orig, clip);
  const b = await deltas(rerig, clip);
  console.log(`\n── ${clip} (quat dot |D_orig·D_rerig| — 1.0 = identical)`);
  for (const nm of CHAIN) {
    const qa = a.get(nm), qb = b.get(nm);
    if (!qa || !qb) { console.log(`  ${nm}: missing`); continue; }
    const dot = Math.abs(qa[0]*qb[0]+qa[1]*qb[1]+qa[2]*qb[2]+qa[3]*qb[3]);
    console.log(`  ${nm}: ${dot.toFixed(4)} ${dot < 0.99 ? '← DIVERGES' : ''}`);
  }
}
