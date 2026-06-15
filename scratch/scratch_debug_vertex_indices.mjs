import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from '../js/core/merge_api.mjs';

async function main() {
  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  const animBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');

  const mergedBuffer = await mergeGLBs(charBuffer, animBuffer, { COMPRESS_OUTPUT: false });

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const docOrig = await io.readBinary(charBuffer);
  const docMerged = await io.readBinary(new Uint8Array(mergedBuffer));

  console.log('=== ORIGINAL MESHES ===');
  for (const mesh of docOrig.getRoot().listMeshes()) {
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION');
    console.log(`  Mesh: "${mesh.getName()}" vertices=${pos ? pos.getCount() : 0}`);
  }

  console.log('\n=== MERGED MESHES ===');
  for (const mesh of docMerged.getRoot().listMeshes()) {
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION');
    console.log(`  Mesh: "${mesh.getName()}" vertices=${pos ? pos.getCount() : 0}`);
  }
}

main().catch(console.error);
