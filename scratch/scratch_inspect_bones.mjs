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

  const animFile = 'd:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb';
  const doc = await io.readBinary(fs.readFileSync(animFile));

  console.log('--- ANIMATION FILE BONES ---');
  const boneNames = [];
  for (const skin of doc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) {
      boneNames.push(joint.getName());
    }
  }
  console.log(JSON.stringify(boneNames.slice(0, 40), null, 2));
  console.log(`Total bones in anim file: ${boneNames.length}`);
}

main().catch(console.error);
