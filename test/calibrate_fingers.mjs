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
function invertRigidMat4(m){
  const a00=m[0],a10=m[1],a20=m[2],a01=m[4],a11=m[5],a21=m[6],a02=m[8],a12=m[9],a22=m[10],tx=m[12],ty=m[13],tz=m[14];
  const det=a00*(a11*a22-a12*a21)-a01*(a10*a22-a12*a20)+a02*(a10*a21-a11*a20);
  if(!det||!Number.isFinite(det))return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  const id=1/det; const i00=(a11*a22-a12*a21)*id,i01=(a02*a21-a01*a22)*id,i02=(a01*a12-a02*a11)*id,i10=(a12*a20-a10*a22)*id,i11=(a00*a22-a02*a20)*id,i12=(a02*a10-a00*a12)*id,i20=(a10*a21-a11*a20)*id,i21=(a01*a20-a00*a21)*id,i22=(a00*a11-a01*a10)*id;
  return new Float32Array([i00,i10,i20,0,i01,i11,i21,0,i02,i12,i22,0,-(i00*tx+i01*ty+i02*tz),-(i10*tx+i11*ty+i12*tz),-(i20*tx+i21*ty+i22*tz),1]);
}
function transformPoint(m,[x,y,z]){return [m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];}
function qInvert(q){return[-q[0],-q[1],-q[2],q[3]];}
function rotateVec3(v,q){const x=v[0],y=v[1],z=v[2],qx=q[0],qy=q[1],qz=q[2],qw=q[3];const ix=qw*x+qy*z-qz*y;const iy=qw*y+qz*x-qx*z;const iz=qw*z+qx*y-qy*x;const iw=-qx*x-qy*y-qz*z;return [ix*qw+iw*-qx+iy*-qz-iz*-qy,iy*qw+iw*-qy+iz*-qx-ix*-qz,iz*qw+iw*-qz+ix*-qy-iy*-qx];}
function mat3ToQuat(m){const tr=m[0]+m[4]+m[8];let x,y,z,w;if(tr>0){const s=Math.sqrt(tr+1.0)*2;w=0.25*s;x=(m[5]-m[7])/s;y=(m[6]-m[2])/s;z=(m[1]-m[3])/s;}else if((m[0]>m[4])&&(m[0]>m[8])){const s=Math.sqrt(1.0+m[0]-m[4]-m[8])*2;w=(m[5]-m[7])/s;x=0.25*s;y=(m[1]+m[3])/s;z=(m[6]+m[2])/s;}else if(m[4]>m[8]){const s=Math.sqrt(1.0+m[4]-m[0]-m[8])*2;w=(m[6]-m[2])/s;x=(m[1]+m[3])/s;y=0.25*s;z=(m[5]+m[7])/s;}else{const s=Math.sqrt(1.0+m[8]-m[0]-m[4])*2;w=(m[1]-m[3])/s;x=(m[6]+m[2])/s;y=(m[5]+m[7])/s;z=0.25*s;}const len=Math.sqrt(x*x+y*y+z*z+w*w);return [x/len,y/len,z/len,w/len];}

const pm = buildParentMap(doc);
const cache = new Map();
const H = 1.7774; // reference height
const handLen = 0.283; // approx
const fingerLen = Math.min(0.14*H, handLen*1.6);
console.log('fingerLen', fingerLen);
for (const side of ['Left']) {
  const hand = byName.get('mixamorig:'+side+'Hand');
  const handW = worldMatrixOf(hand, pm, cache);
  const handInv = invertRigidMat4(handW);
  const handRot = mat3ToQuat([handW[0],handW[1],handW[2],handW[4],handW[5],handW[6],handW[8],handW[9],handW[10]]);
  console.log('\n'+side+' FINGER_DEFS calibrated offsets (x,y,z) relative to hand, normalized by fingerLen='+fingerLen.toFixed(3)+':');
  for (const finger of ['Thumb','Index','Middle','Ring','Pinky']) {
    const offsets = [];
    for (let i=1;i<=3;i++) {
      const j = byName.get('mixamorig:'+side+'Hand'+finger+i);
      const w = worldMatrixOf(j, pm, cache);
      const p = transformPoint(handInv, [w[12],w[13],w[14]]);
      // In autorig, local = [off[0]*mirror*fingerLen, off[1]*fingerLen, off[2]*fingerLen]
      // p = rotateVec3(local, handRot). For reference, handRot is already applied in world, so p is the local vector BEFORE rotation.
      // Wait: p is in hand's local space. local = p (since handRot is identity in hand's local space).
      offsets.push([p[0]/fingerLen, p[1]/fingerLen, p[2]/fingerLen]);
    }
    console.log(`  { name: '${finger}', offsets: [${offsets.map(o=>'['+o.map(v=>v.toFixed(3)).join(',')+']').join(', ')}] },`);
  }
}
