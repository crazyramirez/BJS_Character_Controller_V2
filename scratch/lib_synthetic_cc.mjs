/** Factory: synthetic CC/AccuRig-pattern rig (Z-up skin space, -90°X armature). */
import { Document, NodeIO } from '@gltf-transform/core';

const qMulQ = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qRotV = (q, v) => {
  const u = [q[0], q[1], q[2]], w = q[3];
  const uv = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const uuv = [u[1] * uv[2] - u[2] * uv[1], u[2] * uv[0] - u[0] * uv[2], u[0] * uv[1] - u[1] * uv[0]];
  return [v[0] + 2 * (w * uv[0] + uuv[0]), v[1] + 2 * (w * uv[1] + uuv[1]), v[2] + 2 * (w * uv[2] + uuv[2])];
};
const axisAngle = (axis, deg) => {
  const r = (deg * Math.PI) / 180, s = Math.sin(r / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(r / 2)];
};
// Column-major 3x3 of quat, embedded in mat4
const quatToMat4 = (q) => {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
};

export async function buildSyntheticCC({ apose = false } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();

  const armDrop = apose ? 0.45 : 0;
  const dn = (x, dropFrac) => [x, 0, 1.45 - armDrop * dropFrac];

  const pts = [];
  for (let h = 0; h <= 1.8; h += 0.04) pts.push([0, 0, h], [0.08, 0, h], [-0.08, 0, h]);
  for (let t = 0; t <= 1; t += 0.05) {
    const x = 0.1 + t * 0.7;
    pts.push([x, 0, 1.45 - armDrop * t], [-x, 0, 1.45 - armDrop * t]);
  }
  for (let h = 0; h <= 0.9; h += 0.04) pts.push([0.12, 0, h], [-0.12, 0, h]);
  const posArr = new Float32Array(pts.flat());
  const indices = [];
  for (let i = 0; i + 2 < posArr.length / 3; i++) indices.push(i, i + 1, i + 2);

  const BONES = [
    ['CC_Base_BoneRoot', null, [0, 0, 0]],
    ['CC_Base_Hip', 'CC_Base_BoneRoot', [0, 0, 0.95]],
    ['CC_Base_Pelvis', 'CC_Base_Hip', [0, 0, 0.95]],
    ['CC_Base_Waist', 'CC_Base_Hip', [0, 0, 1.05]],
    ['CC_Base_Spine01', 'CC_Base_Waist', [0, 0, 1.15]],
    ['CC_Base_Spine02', 'CC_Base_Spine01', [0, 0, 1.3]],
    ['CC_Base_NeckTwist01', 'CC_Base_Spine02', [0, 0, 1.5]],
    ['CC_Base_Head', 'CC_Base_NeckTwist01', [0, 0, 1.6]],
    ['CC_Base_L_Clavicle', 'CC_Base_Spine02', [0.08, 0, 1.45]],
    ['CC_Base_L_Upperarm', 'CC_Base_L_Clavicle', dn(0.2, 0.13)],
    ['CC_Base_L_Forearm', 'CC_Base_L_Upperarm', dn(0.5, 0.53)],
    ['CC_Base_L_Hand', 'CC_Base_L_Forearm', dn(0.8, 0.95)],
    ['CC_Base_R_Clavicle', 'CC_Base_Spine02', [-0.08, 0, 1.45]],
    ['CC_Base_R_Upperarm', 'CC_Base_R_Clavicle', dn(-0.2, 0.13)],
    ['CC_Base_R_Forearm', 'CC_Base_R_Upperarm', dn(-0.5, 0.53)],
    ['CC_Base_R_Hand', 'CC_Base_R_Forearm', dn(-0.8, 0.95)],
    // Finger chains with per-phalanx joint orients (twist about the bone axis)
    // — exercises retarget chain-error accumulation like real CC rigs.
    ['CC_Base_L_Mid1', 'CC_Base_L_Hand', dn(0.85, 1.07), axisAngle([1, 0, 0], 15)],
    ['CC_Base_L_Index1', 'CC_Base_L_Hand', dn(0.85, 1.05)],
    ['CC_Base_L_Index2', 'CC_Base_L_Index1', dn(0.9, 1.12), axisAngle([1, 0, 0], 25)],
    ['CC_Base_L_Index3', 'CC_Base_L_Index2', dn(0.95, 1.19), axisAngle([1, 0, 0], 50)],
    ['CC_Base_R_Mid1', 'CC_Base_R_Hand', dn(-0.85, 1.07), axisAngle([1, 0, 0], -15)],
    ['CC_Base_L_Thigh', 'CC_Base_Pelvis', [0.12, 0, 0.9]],
    ['CC_Base_L_Calf', 'CC_Base_L_Thigh', [0.12, 0, 0.45]],
    ['CC_Base_L_Foot', 'CC_Base_L_Calf', [0.12, 0, 0.05]],
    ['CC_Base_L_ToeBase', 'CC_Base_L_Foot', [0.12, -0.12, 0.02]],
    ['CC_Base_R_Thigh', 'CC_Base_Pelvis', [-0.12, 0, 0.9]],
    ['CC_Base_R_Calf', 'CC_Base_R_Thigh', [-0.12, 0, 0.45]],
    ['CC_Base_R_Foot', 'CC_Base_R_Calf', [-0.12, 0, 0.05]],
    ['CC_Base_R_ToeBase', 'CC_Base_R_Foot', [-0.12, -0.12, 0.02]],
  ];

  const nodeByName = new Map();
  const posByName = new Map();
  const quatByName = new Map();
  for (const [name, parent, p, qWorld = [0, 0, 0, 1]] of BONES) {
    const pq = parent ? quatByName.get(parent) : [0, 0, 0, 1];
    const dp = parent ? p.map((v, i) => v - posByName.get(parent)[i]) : p.slice();
    const localPos = qRotV(qInv(pq), dp);
    const localRot = qMulQ(qInv(pq), qWorld);
    const n = doc.createNode(name).setTranslation(localPos).setRotation(localRot);
    if (parent) nodeByName.get(parent).addChild(n);
    nodeByName.set(name, n);
    posByName.set(name, p);
    quatByName.set(name, qWorld);
  }

  const s = Math.SQRT1_2;
  const armature = doc.createNode('Armature').setRotation([-s, 0, 0, s]);
  armature.addChild(nodeByName.get('CC_Base_BoneRoot'));

  const ibm = new Float32Array(BONES.length * 16);
  BONES.forEach(([name], i) => {
    const p = posByName.get(name);
    const qi = qInv(quatByName.get(name));
    const m = quatToMat4(qi);
    const t = qRotV(qi, p);
    m[12] = -t[0]; m[13] = -t[1]; m[14] = -t[2];
    ibm.set(m, i * 16);
  });

  const joints01 = new Uint16Array((posArr.length / 3) * 4);
  const weights = new Float32Array((posArr.length / 3) * 4);
  for (let i = 0; i < posArr.length / 3; i++) { joints01[i * 4] = 1; weights[i * 4] = 1; }

  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', posArr))
    .setAttribute('JOINTS_0', acc('VEC4', joints01))
    .setAttribute('WEIGHTS_0', acc('VEC4', weights))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer));
  const mesh = doc.createMesh('body').addPrimitive(prim);
  const skin = doc.createSkin().setInverseBindMatrices(acc('MAT4', ibm));
  for (const [name] of BONES) skin.addJoint(nodeByName.get(name));
  const meshNode = doc.createNode('BodyNode').setMesh(mesh).setSkin(skin);
  doc.createScene('scene').addChild(armature).addChild(meshNode);
  return new NodeIO().writeBinary(doc);
}
