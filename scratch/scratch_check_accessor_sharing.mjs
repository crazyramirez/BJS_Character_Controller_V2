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

  const joints0Map = new Map(); // accessor -> list of primitives using it
  const joints1Map = new Map();

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const j0 = prim.getAttribute('JOINTS_0');
      if (j0) {
        if (!joints0Map.has(j0)) joints0Map.set(j0, []);
        joints0Map.get(j0).push(`${mesh.getName()} -> primitive`);
      }
      const j1 = prim.getAttribute('JOINTS_1');
      if (j1) {
        if (!joints1Map.has(j1)) joints1Map.set(j1, []);
        joints1Map.get(j1).push(`${mesh.getName()} -> primitive`);
      }
    }
  }

  console.log('=== JOINTS_0 Accessor Sharing ===');
  let j0Idx = 0;
  for (const [accessor, users] of joints0Map.entries()) {
    console.log(`Accessor ${j0Idx++} (count=${accessor.getCount()}): used by ${users.length} primitives:`);
    for (const user of users) {
      console.log(`  - ${user}`);
    }
  }

  console.log('\n=== JOINTS_1 Accessor Sharing ===');
  let j1Idx = 0;
  for (const [accessor, users] of joints1Map.entries()) {
    console.log(`Accessor ${j1Idx++} (count=${accessor.getCount()}): used by ${users.length} primitives:`);
    for (const user of users) {
      console.log(`  - ${user}`);
    }
  }
}

main().catch(console.error);
