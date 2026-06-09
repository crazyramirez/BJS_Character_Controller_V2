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

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const joints0 = prim.getAttribute('JOINTS_0');
        if (joints0) {
          // Get array, shift it
          const arr = joints0.getArray();
          const newArr = new Uint16Array(arr.length);
          for (let i = 0; i < arr.length; i++) {
            newArr[i] = Math.max(0, Math.round(arr[i]) - 1);
          }
          joints0.setArray(newArr);
          // Set component type explicitly to UNSIGNED_SHORT (5123)
          joints0.setComponentType(5123);
        }
      }
    }
  }

  // Write out to temp GLB
  const outBuffer = await io.writeBinary(doc);
  console.log('Successfully wrote binary GLB.');

  // Re-read and check
  const docCheck = await io.readBinary(outBuffer);
  for (const node of docCheck.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const joints0 = prim.getAttribute('JOINTS_0');
        if (joints0) {
          console.log(`Checked primitive JOINTS_0: type=${joints0.getArray().constructor.name}, componentType=${joints0.getComponentType()}`);
        }
      }
    }
  }
}

main().catch(console.error);
