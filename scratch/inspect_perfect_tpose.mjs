import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

async function main() {
  const buf = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');
  
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
    });

  const doc = await io.readBinary(new Uint8Array(buf));
  const root = doc.getRoot();

  console.log('--- Bone Rotations in character_animated.glb ---');

  const bones = [
    'Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
    'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'
  ];

  const parentMap = new Map();
  for (const node of root.listNodes()) {
    for (const child of node.listChildren()) parentMap.set(child, node);
  }

  function getTransforms(node) {
    const localRot = node.getRotation() || [0, 0, 0, 1];
    const localPos = node.getTranslation() || [0, 0, 0];
    return { rot: localRot, pos: localPos };
  }

  for (const node of root.listNodes()) {
    const name = node.getName();
    // Normalize name to see if it matches our list
    const matched = bones.find(b => name.toLowerCase().includes(b.toLowerCase()));
    if (matched) {
      const { rot, pos } = getTransforms(node);
      console.log(`Node: ${name}`);
      console.log(`  Translation: [${pos.map(v => v.toFixed(4)).join(', ')}]`);
      console.log(`  Rotation (quat): [${rot.map(v => v.toFixed(4)).join(', ')}]`);
      
      // Compute world position
      let current = node;
      let worldPos = pos.slice();
      let worldRot = rot.slice();
      while (parentMap.has(current)) {
        current = parentMap.get(current);
        const pRot = current.getRotation() || [0, 0, 0, 1];
        const pTrans = current.getTranslation() || [0, 0, 0];
        // Rotate current translation by parent rotation, then add parent translation
        worldPos = vec3Add(pTrans, rotateVec3(worldPos, pRot));
        worldRot = qMul(pRot, worldRot);
      }
      console.log(`  World Position: [${worldPos.map(v => v.toFixed(4)).join(', ')}]`);
      console.log(`  World Rotation: [${worldRot.map(v => v.toFixed(4)).join(', ')}]`);
    }
  }
}

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const rotateVec3 = ([x, y, z], [qx, qy, qz, qw]) => {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
};

const vec3Add = ([x1, y1, z1], [x2, y2, z2]) => [x1 + x2, y1 + y2, z1 + z2];

main().catch(console.error);
