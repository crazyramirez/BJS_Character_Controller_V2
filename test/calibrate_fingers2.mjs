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
function vec3Normalize(v){const len=Math.hypot(...v)||1;return v.map(x=>x/len);}
function vec3Cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function mat3ToQuat(m){const tr=m[0]+m[4]+m[8];let x,y,z,w;if(tr>0){const s=Math.sqrt(tr+1.0)*2;w=0.25*s;x=(m[5]-m[7])/s;y=(m[6]-m[2])/s;z=(m[1]-m[3])/s;}else if((m[0]>m[4])&&(m[0]>m[8])){const s=Math.sqrt(1.0+m[0]-m[4]-m[8])*2;w=(m[5]-m[7])/s;x=0.25*s;y=(m[1]+m[3])/s;z=(m[6]+m[2])/s;}else if(m[4]>m[8]){const s=Math.sqrt(1.0+m[4]-m[0]-m[8])*2;w=(m[6]-m[2])/s;x=(m[1]+m[3])/s;y=0.25*s;z=(m[5]+m[7])/s;}else{const s=Math.sqrt(1.0+m[8]-m[0]-m[4])*2;w=(m[1]-m[3])/s;x=(m[6]+m[2])/s;y=(m[5]+m[7])/s;z=0.25*s;}const len=Math.sqrt(x*x+y*y+z*z+w*w);return [x/len,y/len,z/len,w/len];}
function qInvert(q){return[-q[0],-q[1],-q[2],q[3]];}
function rotateVec3(v,q){const x=v[0],y=v[1],z=v[2],qx=q[0],qy=q[1],qz=q[2],qw=q[3];const ix=qw*x+qy*z-qz*y;const iy=qw*y+qz*x-qx*z;const iz=qw*z+qx*y-qy*x;const iw=-qx*x-qy*y-qz*z;return [ix*qw+iw*-qx+iy*-qz-iz*-qy,iy*qw+iw*-qy+iz*-qx-ix*-qz,iz*qw+iw*-qz+ix*-qy-iy*-qx];}
function lookRotation(dir, up) {
  const yAxis = vec3Normalize(dir);
  if (Math.hypot(...yAxis) < 1e-6) return [0,0,0,1];
  let xAxis = vec3Normalize(vec3Cross(up, yAxis));
  if (Math.hypot(...xAxis) < 1e-6) {
    const fallback = Math.abs(yAxis[1]) > 0.9 ? [0,0,1] : [0,1,0];
    xAxis = vec3Normalize(vec3Cross(fallback, yAxis));
  }
  const zAxis = vec3Cross(xAxis, yAxis);
  const m = [xAxis[0],xAxis[1],xAxis[2],yAxis[0],yAxis[1],yAxis[2],zAxis[0],zAxis[1],zAxis[2]];
  return mat3ToQuat(m);
}

const pm = buildParentMap(doc);
const cache = new Map();
const H = 1.7774;
const handLen = 0.283;
const fingerLen = Math.min(0.14*H, handLen*1.6);
console.log('fingerLen', fingerLen);
for (const side of ['Left','Right']) {
  const hand = byName.get('mixamorig:'+side+'Hand');
  const fore = byName.get('mixamorig:'+side+'ForeArm');
  const handW = worldMatrixOf(hand, pm, cache);
  const foreW = worldMatrixOf(fore, pm, cache);
  const handPos = [handW[12],handW[13],handW[14]];
  const forePos = [foreW[12],foreW[13],foreW[14]];
  const dir = vec3Normalize([handPos[0]-forePos[0], handPos[1]-forePos[1], handPos[2]-forePos[2]]);
  const forward = [0,0,1];
  const up = side==='Left' ? forward : [-forward[0],-forward[1],-forward[2]];
  const handRot = lookRotation(dir, Math.abs(dir[0]*up[0]+dir[1]*up[1]+dir[2]*up[2])>0.999 ? [0,1,0] : up);
  console.log('\n'+side+' handRot', handRot.map(v=>v.toFixed(3)).join(','));
  console.log(side+' FINGER_DEFS:');
  for (const finger of ['Thumb','Index','Middle','Ring','Pinky']) {
    const offsets = [];
    for (let i=1;i<=3;i++) {
      const j = byName.get('mixamorig:'+side+'Hand'+finger+i);
      const w = worldMatrixOf(j, pm, cache);
      const worldOffset = [w[12]-handPos[0], w[13]-handPos[1], w[14]-handPos[2]];
      const local = rotateVec3(worldOffset, qInvert(handRot));
      offsets.push([local[0]/fingerLen, local[1]/fingerLen, local[2]/fingerLen]);
    }
    console.log(`  { name: '${finger}', offsets: [${offsets.map(o=>'['+o.map(v=>v.toFixed(3)).join(',')+']').join(', ')}] },`);
  }
}
