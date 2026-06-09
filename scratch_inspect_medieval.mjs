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

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\medieval_character_sample.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  console.log('\n=== SCENE HIERARCHY (top 4 levels) ===');
  for (const scene of doc.getRoot().listScenes()) {
    console.log(`Scene: "${scene.getName()}"`);
    for (const child of scene.listChildren()) {
      const t = child.getTranslation() || [0,0,0];
      const s = child.getScale() || [1,1,1];
      console.log(`  Node: "${child.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}] scale=[${s.map(v=>v.toFixed(4)).join(', ')}]`);
      for (const gc of child.listChildren()) {
        const t2 = gc.getTranslation() || [0,0,0];
        const s2 = gc.getScale() || [1,1,1];
        console.log(`    Node: "${gc.getName()}" trans=[${t2.map(v=>v.toFixed(4)).join(', ')}] scale=[${s2.map(v=>v.toFixed(4)).join(', ')}]`);
        for (const ggc of gc.listChildren()) {
          const t3 = ggc.getTranslation() || [0,0,0];
          console.log(`      Node: "${ggc.getName()}" trans=[${t3.map(v=>v.toFixed(4)).join(', ')}]`);
          for (const gggc of ggc.listChildren()) {
            const t4 = gggc.getTranslation() || [0,0,0];
            console.log(`        Node: "${gggc.getName()}" trans=[${t4.map(v=>v.toFixed(4)).join(', ')}]`);
          }
        }
      }
    }
  }

  console.log('\n=== SKINS ===');
  for (const skin of doc.getRoot().listSkins()) {
    console.log(`Skin: "${skin.getName()}" joints: ${skin.listJoints().length}`);
    const joints = skin.listJoints();
    for (let i = 0; i < Math.min(10, joints.length); i++) {
      const j = joints[i];
      const t = j.getTranslation() || [0,0,0];
      console.log(`  [${i}] "${j.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}]`);
    }
  }
}

main().catch(console.error);
