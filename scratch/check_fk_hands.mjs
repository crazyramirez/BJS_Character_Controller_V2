/** FK check: world X of hands at frame 0 of several clips in the re-rigged merged GLB.
 *  Left hand should stay at +X side (no crossing) for neutral-ish frames. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const doc = await io.readBinary(new Uint8Array(readFileSync(new URL('./out_rerigged_merged.glb', import.meta.url))));
const root = doc.getRoot();

const parentMap = new Map();
for (const n of root.listNodes()) for (const c of n.listChildren()) parentMap.set(c, n);

function qMul([x1,y1,z1,w1],[x2,y2,z2,w2]){return[x1*w2+w1*x2+y1*z2-z1*y2,y1*w2+w1*y2+z1*x2-x1*z2,z1*w2+w1*z2+x1*y2-y1*x2,w1*w2-x1*x2-y1*y2-z1*z2];}
function rot([x,y,z],[qx,qy,qz,qw]){const ix=qw*x+qy*z-qz*y,iy=qw*y+qz*x-qx*z,iz=qw*z+qx*y-qy*x,iw=-qx*x-qy*y-qz*z;return[ix*qw+iw*-qx+iy*-qz-iz*-qy,iy*qw+iw*-qy+iz*-qx-ix*-qz,iz*qw+iw*-qz+ix*-qy-iy*-qx];}

for (const animName of ['Idle_Loop','Punch_Cross','Roll','Driving_Loop','Sitting_Idle_Loop']) {
  const anim = root.listAnimations().find(a => (a.getName()||'').toLowerCase().includes(animName.toLowerCase().replace(/_/g,'_')));
  if (!anim) { console.log(animName, '— not found'); continue; }
  // first-keyframe local rotation per node
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
  const find = nm => root.listNodes().find(n => (n.getName()||'') === nm);
  const lh = find('LeftHand'), rh = find('RightHand'), hips = find('Hips');
  console.log(`${anim.getName()}: LeftHand x=${wPos.get(lh)[0].toFixed(2)} RightHand x=${wPos.get(rh)[0].toFixed(2)} hips=(${wPos.get(hips).map(v=>v.toFixed(2))})  LH=(${wPos.get(lh).map(v=>v.toFixed(2))})`);
}
