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

  const anim = doc.getRoot().listAnimations().find(a => a.getName().includes('Death01'));
  if (anim) {
    console.log(`Animation: "${anim.getName()}"`);
    for (const channel of anim.listChannels()) {
      const path = channel.getTargetPath();
      const node = channel.getTargetNode();
      if (path === 'translation' && node && node.getName().toLowerCase().includes('hip')) {
        const arr = channel.getSampler()?.getOutput()?.getArray();
        if (arr) {
          console.log(`  Hips translation Y values (total frames: ${arr.length / 3}):`);
          const steps = Math.min(10, arr.length / 3);
          const stride = Math.max(1, Math.floor((arr.length / 3) / steps));
          for (let i = 0; i < arr.length / 3; i += stride) {
            const y = arr[i * 3 + 1];
            console.log(`    Frame ${i}: Y = ${y.toFixed(4)} (world Y = ${(y * 0.001).toFixed(4)}m)`);
          }
        }
      }
    }
  }
}

main().catch(console.error);
