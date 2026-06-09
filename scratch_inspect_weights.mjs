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

  const skins = doc.getRoot().listSkins();
  console.log(`Number of skins: ${skins.length}`);
  for (const skin of skins) {
    const joints = skin.listJoints();
    console.log(`Skin: "${skin.getName()}" has ${joints.length} joints.`);
    console.log(`Joint 0: "${joints[0]?.getName()}"`);
    console.log(`Joint 1: "${joints[1]?.getName()}"`);

    // Let's look for meshes using this skin
    for (const node of doc.getRoot().listNodes()) {
      if (node.getSkin() === skin) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        console.log(`Node "${node.getName()}" uses skin, has mesh "${mesh.getName()}"`);
        for (const prim of mesh.listPrimitives()) {
          console.log(`  Primitive mode=${prim.getMode()}`);
          const joints0 = prim.getAttribute('JOINTS_0');
          const weights0 = prim.getAttribute('WEIGHTS_0');
          if (joints0 && weights0) {
            const jArr = joints0.getArray();
            const wArr = weights0.getArray();
            console.log(`    JOINTS_0 array type: ${jArr.constructor.name}, length: ${jArr.length}`);
            console.log(`    WEIGHTS_0 array type: ${wArr.constructor.name}, length: ${wArr.length}`);
            
            // Check if any vertex weights joint 0
            let jointZeroWeightsCount = 0;
            let maxWeightForJointZero = 0;
            for (let i = 0; i < jArr.length; i++) {
              if (Math.round(jArr[i]) === 0 && wArr[i] > 0) {
                jointZeroWeightsCount++;
                if (wArr[i] > maxWeightForJointZero) {
                  maxWeightForJointZero = wArr[i];
                }
              }
            }
            console.log(`    Vertices with non-zero weight for Joint 0: ${jointZeroWeightsCount}, Max weight: ${maxWeightForJointZero}`);
          }
        }
      }
    }
  }
}

main().catch(console.error);
