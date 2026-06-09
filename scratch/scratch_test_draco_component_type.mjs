import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco as dracoCompress } from '@gltf-transform/functions';
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

  // Check before Draco compress
  let joints0 = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  console.log('Before Draco: componentType =', joints0.getComponentType());

  // Run Draco compression
  console.log('Running Draco compression...');
  await doc.transform(dracoCompress());

  // Check after Draco compress (before save)
  joints0 = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  console.log('After Draco (before save): componentType =', joints0.getComponentType());

  // Write and reload
  const buf = await io.writeBinary(doc);
  const doc2 = await io.readBinary(buf);
  joints0 = doc2.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  console.log('After Draco save and load: componentType =', joints0.getComponentType());
}

main().catch(console.error);
