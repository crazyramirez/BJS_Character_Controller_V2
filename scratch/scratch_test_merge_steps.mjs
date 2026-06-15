import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, unpartition, draco as dracoCompress, resample } from '@gltf-transform/functions';
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

  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const rootJointNode = joints[0];
  skin.removeJoint(rootJointNode);

  for (const node of doc.getRoot().listNodes()) {
    if (node.getSkin() === skin) {
      const mesh = node.getMesh();
      if (mesh) {
        for (const primitive of mesh.listPrimitives()) {
          const joints0 = primitive.getAttribute('JOINTS_0');
          if (joints0) {
            const arr = joints0.getArray();
            if (arr) {
              const newArr = new Uint16Array(arr.length);
              for (let i = 0; i < arr.length; i++) {
                newArr[i] = Math.max(0, Math.round(arr[i]) - 1);
              }
              joints0.setArray(newArr);
            }
          }
          const joints1 = primitive.getAttribute('JOINTS_1');
          if (joints1) {
            const arr = joints1.getArray();
            if (arr) {
              const newArr = new Uint16Array(arr.length);
              for (let i = 0; i < arr.length; i++) {
                newArr[i] = Math.max(0, Math.round(arr[i]) - 1);
              }
              joints1.setArray(newArr);
            }
          }
        }
      }
    }
  }

  const ibmAcc = skin.getInverseBindMatrices();
  if (ibmAcc) {
    const arr = ibmAcc.getArray();
    if (arr && arr.length >= 16) {
      ibmAcc.setArray(arr.slice(16));
    }
  }

  console.log('Before transform: componentType =', doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0').getComponentType());

  // Let's run the final transforms of merge_api.mjs
  await doc.transform(prune());
  console.log('After prune: componentType =', doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0').getComponentType());

  await doc.transform(unpartition());
  console.log('After unpartition: componentType =', doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0').getComponentType());

  await doc.transform(resample(), dracoCompress());
  console.log('After resample + dracoCompress: componentType =', doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0').getComponentType());

  const buf = await io.writeBinary(doc);
  const doc2 = await io.readBinary(buf);
  const joints0 = doc2.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  console.log('Final saved/loaded componentType =', joints0.getComponentType());
}

main().catch(console.error);
