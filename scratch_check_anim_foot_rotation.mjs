import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from './js/core/merge_api.mjs';

async function main() {
  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  const animBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');

  console.log('Running mergeGLBs...');
  const mergedBuffer = await mergeGLBs(charBuffer, animBuffer, { COMPRESS_OUTPUT: false });

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const docRef = await io.readBinary(animBuffer);
  const docMerged = await io.readBinary(new Uint8Array(mergedBuffer));

  // Find LeftFoot channel in both
  function getFootKeys(doc, label) {
    const anim = doc.getRoot().listAnimations().find(a => a.getName().includes('Idle_Loop'));
    if (!anim) {
      console.log(`  [${label}] Could not find Idle_Loop animation.`);
      return;
    }
    for (const channel of anim.listChannels()) {
      const node = channel.getTargetNode();
      const path = channel.getTargetPath();
      if (path === 'rotation' && node && node.getName().toLowerCase().includes('leftfoot')) {
        const arr = channel.getSampler()?.getOutput()?.getArray();
        if (arr) {
          console.log(`  [${label}] LeftFoot rotation channel (first frame): [${arr[0].toFixed(4)}, ${arr[1].toFixed(4)}, ${arr[2].toFixed(4)}, ${arr[3].toFixed(4)}]`);
          return arr.slice(0, 4);
        }
      }
    }
    console.log(`  [${label}] LeftFoot rotation channel not found.`);
  }

  const keysRef = getFootKeys(docRef, 'Reference character_animated.glb');
  const keysMerged = getFootKeys(docMerged, 'Merged output.glb');
}

main().catch(console.error);
