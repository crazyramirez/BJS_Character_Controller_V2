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

  const file1 = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\business_man.glb';
  const file2 = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang_animated.glb';

  const doc1 = await io.readBinary(fs.readFileSync(file1));
  const doc2 = await io.readBinary(fs.readFileSync(file2));

  console.log('=== BUSINESS MAN ROOT NODES ===');
  for (const scene of doc1.getRoot().listScenes()) {
    for (const child of scene.listChildren()) {
      console.log(`  "${child.getName()}" scale=[${(child.getScale() || [1,1,1]).join(', ')}] trans=[${(child.getTranslation() || [0,0,0]).join(', ')}]`);
      for (const gc of child.listChildren()) {
        console.log(`    "${gc.getName()}" trans=[${(gc.getTranslation() || [0,0,0]).join(', ')}]`);
      }
    }
  }

  console.log('\n=== GANG ANIMATED ROOT NODES ===');
  for (const scene of doc2.getRoot().listScenes()) {
    for (const child of scene.listChildren()) {
      console.log(`  "${child.getName()}" scale=[${(child.getScale() || [1,1,1]).join(', ')}] trans=[${(child.getTranslation() || [0,0,0]).join(', ')}]`);
      for (const gc of child.listChildren()) {
        console.log(`    "${gc.getName()}" trans=[${(gc.getTranslation() || [0,0,0]).join(', ')}]`);
      }
    }
  }
}

main().catch(console.error);
