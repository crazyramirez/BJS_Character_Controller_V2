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

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  console.log('=== character_animated.glb Meshes ===');
  for (const mesh of doc.getRoot().listMeshes()) {
    const prim = mesh.listPrimitives()[0];
    const pos = prim?.getAttribute('POSITION');
    console.log(`  Mesh: "${mesh.getName()}" vertices=${pos ? pos.getCount() : 0}`);
  }
}

main().catch(console.error);
