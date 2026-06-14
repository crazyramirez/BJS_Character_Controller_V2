/** Recompute expected retargeted quat for RightShoulder (Punch_Cross, frame 0)
 *  with the merge formula and compare to what the re-rigged output contains. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
function qMul([x1,y1,z1,w1],[x2,y2,z2,w2]){return[x1*w2+w1*x2+y1*z2-z1*y2,y1*w2+w1*y2+z1*x2-x1*z2,z1*w2+w1*z2+x1*y2-y1*x2,w1*w2-x1*x2-y1*y2-z1*z2];}
function qInv([x,y,z,w]){return[-x,-y,-z,w];}

const animDoc = await io.readBinary(new Uint8Array(readFileSync(new URL('../assets/animations.glb', import.meta.url))));
const root = animDoc.getRoot();
const parentMap = new Map();
for (const n of root.listNodes()) for (const c of n.listChildren()) parentMap.set(c, n);

// anim rest/world from node rotations (no T_Pose in this file)
const wRest = new Map();
function fkRest(n){ if (wRest.has(n)) return wRest.get(n); const p=parentMap.get(n);
  const r = p ? qMul(fkRest(p), n.getRotation()||[0,0,0,1]) : (n.getRotation()||[0,0,0,1]);
  wRest.set(n,r); return r; }
for (const n of root.listNodes()) fkRest(n);

for (const clipName of ['Punch_Cross','Crouch_Idle_Loop']) {
  const anim = root.listAnimations().find(a => a.getName() === clipName);
  for (const ch of anim.listChannels()) {
    if (ch.getTargetPath() !== 'rotation') continue;
    const node = ch.getTargetNode();
    if (node.getName() !== 'RightShoulder') continue;
    const arr = ch.getSampler().getOutput().getArray();
    const q0 = [arr[0],arr[1],arr[2],arr[3]];
    const rAnim = node.getRotation() || [0,0,0,1];
    const Wanim = wRest.get(node);
    // our rig: rChar = identity, Wchar = identity → C = Wanim
    const delta = qMul(qInv(rAnim), q0);
    const expected = qMul(qMul(Wanim, delta), qInv(Wanim));
    console.log(`${clipName} RightShoulder:`);
    console.log('  rAnim   =', rAnim.map(v=>v.toFixed(4)).join(','));
    console.log('  q0      =', q0.map(v=>v.toFixed(4)).join(','));
    console.log('  Wanim   =', Wanim.map(v=>v.toFixed(4)).join(','));
    console.log('  expected=', expected.map(v=>v.toFixed(4)).join(','));
    console.log('  keys in track:', arr.length/4);
  }
}

// what's actually stored in the rerigged output
const reDoc = await io.readBinary(new Uint8Array(readFileSync(new URL('./out_rerigged_merged.glb', import.meta.url))));
const reRoot = reDoc.getRoot();
for (const clipName of ['Punch_Cross','Crouch_Idle_Loop']) {
  const anim = reRoot.listAnimations().find(a => a.getName() === clipName);
  for (const ch of anim.listChannels()) {
    if (ch.getTargetPath() !== 'rotation') continue;
    if (ch.getTargetNode()?.getName() !== 'RightShoulder') continue;
    const arr = ch.getSampler().getOutput().getArray();
    console.log(`${clipName} STORED RightShoulder q0 =`, [arr[0],arr[1],arr[2],arr[3]].map(v=>v.toFixed(4)).join(','), '| keys:', arr.length/4);
  }
}
