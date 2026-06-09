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

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang_animated.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  // Find Crouch or Death animation
  for (const anim of doc.getRoot().listAnimations()) {
    const name = anim.getName();
    if (name.includes('Crouch_Idle') || name.includes('Death')) {
      console.log(`\nAnimation: "${name}"`);
      for (const channel of anim.listChannels()) {
        const path = channel.getTargetPath();
        const node = channel.getTargetNode();
        if (path === 'translation' && node && node.getName().toLowerCase().includes('hip')) {
          const arr = channel.getSampler()?.getOutput()?.getArray();
          if (arr) {
            console.log(`  Channel target: "${node.getName()}"`);
            console.log(`  Translation values (first 3 frames):`);
            for (let i = 0; i < Math.min(3, arr.length / 3); i++) {
              const x = arr[i * 3].toFixed(4);
              const y = arr[i * 3 + 1].toFixed(4);
              const z = arr[i * 3 + 2].toFixed(4);
              console.log(`    [${i}]: [${x}, ${y}, ${z}]`);
            }
          }
        }
      }
    }
  }
}

main().catch(console.error);
