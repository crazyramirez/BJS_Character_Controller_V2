import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from '../js/core/merge_api.mjs';

async function main() {
  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  const animBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');

  const mergedBuffer = await mergeGLBs(charBuffer, animBuffer, { COMPRESS_OUTPUT: true });

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const docOrig = await io.readBinary(charBuffer);
  const docMerged = await io.readBinary(new Uint8Array(mergedBuffer));

  const skinOrig = docOrig.getRoot().listSkins()[0];
  const skinMerged = docMerged.getRoot().listSkins()[0];

  const jointsOrig = skinOrig.listJoints();
  const jointsMerged = skinMerged.listJoints();

  console.log(`Original skin joints (count=${jointsOrig.length}):`);
  for (let i = 0; i < jointsOrig.length; i++) {
    console.log(`  [${i}]: "${jointsOrig[i].getName()}"`);
  }

  console.log(`\nMerged skin joints (count=${jointsMerged.length}):`);
  for (let i = 0; i < jointsMerged.length; i++) {
    console.log(`  [${i}]: "${jointsMerged[i].getName()}"`);
  }
}

main().catch(console.error);
