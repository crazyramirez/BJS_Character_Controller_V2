import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) map.set(child, node);
  }
  return map;
}

function worldMatrixOf(node, parentMap, cache) {
  if (cache.has(node)) return cache.get(node);
  const local = node.getMatrix();
  const parent = parentMap.get(node);
  const world = parent ? mat4Mul(worldMatrixOf(parent, parentMap, cache), local) : local;
  cache.set(node, world);
  return world;
}

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const buffer = readFileSync('d:/DEV/BJS Character Controller V2/kobold_trap_setter-male.glb');
  const doc = await io.readBinary(new Uint8Array(buffer));
  const root = doc.getRoot();
  const parentMap = buildParentMap(doc);
  const cache = new Map();

  const skin = root.listSkins()[0];
  const joints = skin.listJoints();
  for (let j = 0; j < Math.min(15, joints.length); j++) {
    const joint = joints[j];
    const W = worldMatrixOf(joint, parentMap, cache);
    const pos = [W[12], W[13], W[14]];
    console.log(`Joint ${j}: "${joint.getName()}" -> pos: ${pos.map(n => n.toFixed(3))}`);
  }
}

main().catch(console.error);
