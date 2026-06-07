import fs from 'fs';
import draco3d from 'draco3dgltf';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

async function getIO() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });
}

function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
  return [
    x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2,
    y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
    z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}

function rotateVec3([x, y, z], [qx, qy, qz, qw]) {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function vec3Add([x1, y1, z1], [x2, y2, z2]) {
  return [x1 + x2, y1 + y2, z1 + z2];
}

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) {
      map.set(child, node);
    }
  }
  return map;
}

function computeWorldTransforms(doc) {
  const parentMap = buildParentMap(doc);
  const rotations = new Map();
  const positions = new Map();

  function getTransforms(node) {
    if (rotations.has(node)) return { rot: rotations.get(node), pos: positions.get(node) };

    const localRot = node.getRotation() || [0, 0, 0, 1];
    const localPos = node.getTranslation() || [0, 0, 0];

    const parent = parentMap.get(node);
    if (parent) {
      const parentTransforms = getTransforms(parent);
      const worldRot = qMul(parentTransforms.rot, localRot);
      const worldPos = vec3Add(parentTransforms.pos, rotateVec3(localPos, parentTransforms.rot));
      rotations.set(node, worldRot);
      positions.set(node, worldPos);
      return { rot: worldRot, pos: worldPos };
    } else {
      rotations.set(node, localRot);
      positions.set(node, localPos);
      return { rot: localRot, pos: localPos };
    }
  }

  for (const node of doc.getRoot().listNodes()) {
    getTransforms(node);
  }

  return { rotations, positions };
}

async function compare() {
  const io = await getIO();
  const pepeBuf = fs.readFileSync('assets/pepe.glb');
  const pepeDoc = await io.readBinary(new Uint8Array(pepeBuf));
  const pepeTransforms = computeWorldTransforms(pepeDoc);

  console.log('=== Pepe Character ===');
  pepeDoc.getRoot().listNodes().forEach(node => {
    const name = node.getName() || '';
    if (name.toLowerCase().includes('leftarm') || name.toLowerCase().includes('leftshoulder')) {
      console.log(`Node: ${name}`);
      console.log(`  Local Rotation: `, node.getRotation());
      console.log(`  World Rotation: `, pepeTransforms.rotations.get(node));
      if (name.toLowerCase().includes('leftarm')) {
        const armDir = rotateVec3([0, 1, 0], pepeTransforms.rotations.get(node));
        console.log(`  Arm World Dir:  `, armDir);
      }
    }
  });
}

compare().catch(console.error);
