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

  console.log('=== ALL NODES IN GLTF DOCUMENT ===');
  for (const node of doc.getRoot().listNodes()) {
    console.log(`Node: "${node.getName()}"`);
  }

  console.log('\n=== SKINS IN GLTF DOCUMENT ===');
  for (const skin of doc.getRoot().listSkins()) {
    console.log(`Skin: "${skin.getName()}"`);
    for (const joint of skin.listJoints()) {
      console.log(`  Joint: "${joint.getName()}"`);
    }
  }
}

main().catch(console.error);
