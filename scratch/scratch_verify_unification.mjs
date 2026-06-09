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

  const files = [
    'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang_animated.glb',
    'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\medieval_animated.glb'
  ];

  for (const file of files) {
    console.log(`\n===========================================`);
    console.log(`VERIFYING FILE: ${file}`);
    console.log(`===========================================`);
    const doc = await io.readBinary(fs.readFileSync(file));

    console.log('--- SCENE HIERARCHY ---');
    for (const scene of doc.getRoot().listScenes()) {
      console.log(`Scene: "${scene.getName()}"`);
      for (const child of scene.listChildren()) {
        const t = child.getTranslation() || [0,0,0];
        const s = child.getScale() || [1,1,1];
        console.log(`  Root Child: "${child.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}] scale=[${s.map(v=>v.toFixed(4)).join(', ')}]`);
        for (const sub of child.listChildren()) {
          console.log(`    Child: "${sub.getName()}" trans=[${(sub.getTranslation() || [0,0,0]).map(v=>v.toFixed(4)).join(', ')}]`);
          // Show some descendants
          if (sub.getName().toLowerCase().includes('hips')) {
            for (const bone of sub.listChildren()) {
              console.log(`      Bone child: "${bone.getName()}"`);
            }
          }
        }
      }
    }

    console.log('--- SKINS & BONE NAMES (first 10) ---');
    for (const skin of doc.getRoot().listSkins()) {
      const joints = skin.listJoints();
      console.log(`Skin joints count: ${joints.length}`);
      for (let i = 0; i < Math.min(10, joints.length); i++) {
        console.log(`  Joint [${i}]: "${joints[i].getName()}"`);
      }
    }
  }
}

main().catch(console.error);
