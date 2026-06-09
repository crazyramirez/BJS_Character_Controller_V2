import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

async function checkFile(filePath) {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  console.log(`\nChecking file: ${filePath}`);
  const doc = await io.readBinary(fs.readFileSync(filePath));

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const joints0 = prim.getAttribute('JOINTS_0');
        if (joints0) {
          console.log(`  Mesh "${mesh.getName()}" primitive JOINTS_0: type=${joints0.getArray().constructor.name}, componentType=${joints0.getComponentType()}`);
          return; // just check the first one to be brief
        }
      }
    }
  }
}

async function main() {
  await checkFile('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  await checkFile('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang_animated.glb');
  await checkFile('d:\\DEV\\BJS Character Controller V2\\assets\\test_output.glb');
}

main().catch(console.error);
