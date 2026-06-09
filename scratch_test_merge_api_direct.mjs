import fs from 'fs';
import { mergeGLBs } from './js/core/merge_api.mjs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

async function main() {
  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  
  console.log('Running mergeGLBs...');
  const mergedBuffer = await mergeGLBs(charBuffer, null, { COMPRESS_OUTPUT: true });

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const doc = await io.readBinary(new Uint8Array(mergedBuffer));
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const joints0 = prim.getAttribute('JOINTS_0');
        if (joints0) {
          console.log(`Resulting mesh "${mesh.getName()}" JOINTS_0: type=${joints0.getArray().constructor.name}, componentType=${joints0.getComponentType()}`);
          return;
        }
      }
    }
  }
}

main().catch(console.error);
