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

  for (const anim of doc.getRoot().listAnimations()) {
    const name = anim.getName();
    if (name.includes('Crouch_Idle') || name.includes('Death01')) {
      console.log(`\nAnimation: "${name}"`);
      for (const channel of anim.listChannels()) {
        const path = channel.getTargetPath();
        const node = channel.getTargetNode();
        if (path === 'translation' && node && node.getName().toLowerCase().includes('hip')) {
          const arr = channel.getSampler()?.getOutput()?.getArray();
          if (arr) {
            console.log(`  Hips translation Y values (first 3 frames):`);
            for (let i = 0; i < Math.min(3, arr.length / 3); i++) {
              console.log(`    [${i}]: ${arr[i * 3 + 1].toFixed(4)}`);
            }
          }
        }
      }
    }
  }
}

main().catch(console.error);
