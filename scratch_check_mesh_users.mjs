import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  // Count how many nodes reference each mesh
  const meshNodesMap = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) {
      if (!meshNodesMap.has(mesh)) {
        meshNodesMap.set(mesh, []);
      }
      meshNodesMap.get(mesh).push(node);
    }
  }

  console.log('=== Mesh Node References ===');
  for (const [mesh, nodes] of meshNodesMap.entries()) {
    console.log(`Mesh "${mesh.getName()}": referenced by ${nodes.length} nodes:`);
    for (const node of nodes) {
      console.log(`  - Node "${node.getName()}" (skin: "${node.getSkin()?.getName() || 'none'}")`);
    }
  }
}

main().catch(console.error);
