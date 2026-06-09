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

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  const parentMap = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) {
      parentMap.set(child, node);
    }
  }

  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) {
      console.log(`\nMesh node: "${node.getName()}"`);
      let current = node;
      while (current) {
        const t = current.getTranslation() || [0, 0, 0];
        const r = current.getRotation() || [0, 0, 0, 1];
        const s = current.getScale() || [1, 1, 1];
        console.log(`  Ancestor: "${current.getName()}"`);
        console.log(`    T: [${t.map(v=>v.toFixed(4)).join(', ')}]`);
        console.log(`    R: [${r.map(v=>v.toFixed(4)).join(', ')}]`);
        console.log(`    S: [${s.map(v=>v.toFixed(4)).join(', ')}]`);
        current = parentMap.get(current);
      }
      break; // just check one mesh
    }
  }
}

main().catch(console.error);
