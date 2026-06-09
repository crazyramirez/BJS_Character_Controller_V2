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

  const joints0 = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  
  console.log('Original componentType:', joints0.getComponentType()); // should be 5126
  console.log('Original array type:', joints0.getArray().constructor.name);

  // Set array to Uint16Array
  joints0.setArray(new Uint16Array(joints0.getArray().length));
  
  console.log('After setArray componentType:', joints0.getComponentType());
  console.log('After setArray array type:', joints0.getArray().constructor.name);

  // Write out
  const outBuffer = await io.writeBinary(doc);
  const doc2 = await io.readBinary(outBuffer);
  const joints0_after = doc2.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  console.log('After save/load componentType:', joints0_after.getComponentType());
  console.log('After save/load array type:', joints0_after.getArray().constructor.name);
}

main().catch(console.error);
