/** Compare frame-0 FK hand X between original-rig merge and re-rigged merge. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

function qMul([x1,y1,z1,w1],[x2,y2,z2,w2]){return[x1*w2+w1*x2+y1*z2-z1*y2,y1*w2+w1*y2+z1*x2-x1*z2,z1*w2+w1*z2+x1*y2-y1*x2,w1*w2-x1*x2-y1*y2-z1*z2];}
function rot([x,y,z],[qx,qy,qz,qw]){const ix=qw*x+qy*z-qz*y,iy=qw*y+qz*x-qx*z,iz=qw*z+qx*y-qy*x,iw=-qx*x-qy*y-qz*z;return[ix*qw+iw*-qx+iy*-qz-iz*-qy,iy*qw+iw*-qy+iz*-qx-ix*-qz,iz*qw+iw*-qz+ix*-qy-iy*-qx];}

async function report(label, buf) {
  const doc = await io.readBinary(new Uint8Array(buf));
  const root = doc.getRoot();
  const parentMap = new Map();
  for (const n of root.listNodes()) for (const c of n.listChildren()) parentMap.set(c, n);
  const findBone = suffix => root.listNodes().find(n => {
    const nm = (n.getName()||'').toLowerCase().replace(/_\d+$/,'');
    return nm === suffix || nm.endsWith(':'+suffix) || nm === 'mixamorig:'+suffix;
  });
  console.log(`\n── ${label}`);
  for (const animName of ['Punch_Cross','Roll','Sitting_Idle_Loop','Driving_Loop']) {
    const anim = root.listAnimations().find(a => (a.getName()||'').toLowerCase() === animName.toLowerCase());
    if (!anim) { console.log(animName, 'not found'); continue; }
    const localRot = new Map();
    for (const ch of anim.listChannels()) {
      if (ch.getTargetPath() !== 'rotation') continue;
      const arr = ch.getSampler()?.getOutput()?.getArray();
      if (arr) localRot.set(ch.getTargetNode(), [arr[0],arr[1],arr[2],arr[3]]);
    }
    const wPos = new Map(), wRot = new Map();
    function fk(n){
      if (wPos.has(n)) return;
      const p = parentMap.get(n);
      const lr = localRot.get(n) || n.getRotation() || [0,0,0,1];
      const lt = n.getTranslation() || [0,0,0];
      if (p) { fk(p); wRot.set(n, qMul(wRot.get(p), lr)); wPos.set(n, [0,1,2].map(i => wPos.get(p)[i] + rot(lt, wRot.get(p))[i])); }
      else { wRot.set(n, lr); wPos.set(n, lt); }
    }
    for (const n of root.listNodes()) fk(n);
    const lh = findBone('lefthand'), rh = findBone('righthand');
    if (!lh || !rh) { console.log(animName, 'hands not found'); continue; }
    console.log(`${animName}: LH=(${wPos.get(lh).map(v=>v.toFixed(2))}) RH=(${wPos.get(rh).map(v=>v.toFixed(2))})`);
  }
}

const charBuf = readFileSync(new URL('../assets/character_animated.glb', import.meta.url));
const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));
const origMerged = await mergeGLBs(charBuf, animBuf, { removeExistingAnimations: true });
await report('ORIGINAL rig + merge', origMerged);
await report('RE-RIGGED + merge', readFileSync(new URL('./out_rerigged_merged.glb', import.meta.url)));
