import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import fs from 'fs';
const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await dracoLib.createDecoderModule(),
    'draco3d.encoder': await dracoLib.createEncoderModule(),
  });
const doc = await io.read('assets/character_animated_1.glb');
const skin = doc.getRoot().listSkins()[0];
const joints = skin.listJoints();
const byName = new Map(joints.map(j=>[j.getName(), j]));
function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) for (const child of node.listChildren()) map.set(child, node);
  return map;
}
function mat4Mul(a,b){const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;}
function worldMatrixOf(node, pm, c){if(c.has(node))return c.get(node);const l=node.getMatrix();const p=pm.get(node);const w=p?mat4Mul(worldMatrixOf(p,pm,c),l):l;c.set(node,w);return w;}
function mat3ToQuat(m){const tr=m[0]+m[4]+m[8];let x,y,z,w;if(tr>0){const s=Math.sqrt(tr+1.0)*2;w=0.25*s;x=(m[5]-m[7])/s;y=(m[6]-m[2])/s;z=(m[1]-m[3])/s;}else if((m[0]>m[4])&&(m[0]>m[8])){const s=Math.sqrt(1.0+m[0]-m[4]-m[8])*2;w=(m[5]-m[7])/s;x=0.25*s;y=(m[1]+m[3])/s;z=(m[6]+m[2])/s;}else if(m[4]>m[8]){const s=Math.sqrt(1.0+m[4]-m[0]-m[8])*2;w=(m[6]-m[2])/s;x=(m[1]+m[3])/s;y=0.25*s;z=(m[5]+m[7])/s;}else{const s=Math.sqrt(1.0+m[8]-m[0]-m[4])*2;w=(m[1]-m[3])/s;x=(m[6]+m[2])/s;y=(m[5]+m[7])/s;z=0.25*s;}const len=Math.sqrt(x*x+y*y+z*z+w*w);return [x/len,y/len,z/len,w/len];}
const pm = buildParentMap(doc);
const cache = new Map();
const data = { joints: [], hierarchy: {}, positions: {}, rotations: {} };
for (const j of joints) {
  const name = j.getName().replace('mixamorig:', '');
  const W = worldMatrixOf(j, pm, cache);
  data.positions[name] = [W[12], W[13], W[14]];
  const sx = Math.hypot(W[0],W[1],W[2])||1;
  const sy = Math.hypot(W[4],W[5],W[6])||1;
  const sz = Math.hypot(W[8],W[9],W[10])||1;
  const m = [W[0]/sx,W[1]/sx,W[2]/sx,W[4]/sy,W[5]/sy,W[6]/sy,W[8]/sz,W[9]/sz,W[10]/sz];
  data.rotations[name] = mat3ToQuat(m);
  const parent = pm.get(j);
  data.hierarchy[name] = parent ? parent.getName().replace('mixamorig:', '') : null;
}
fs.writeFileSync('ref_skeleton.json', JSON.stringify(data, null, 2));
console.log('Wrote ref_skeleton.json');
