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

  const originalFile = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb';
  const mergedFile = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang_animated.glb';

  const docOrig = await io.readBinary(fs.readFileSync(originalFile));
  const docMerged = await io.readBinary(fs.readFileSync(mergedFile));

  const skinOrig = docOrig.getRoot().listSkins()[0];
  const skinMerged = docMerged.getRoot().listSkins()[0];

  const jointsOrig = skinOrig.listJoints();
  const jointsMerged = skinMerged.listJoints();

  console.log(`=== SKELETON JOINTS COMPARISON ===`);
  console.log(`Original joints count: ${jointsOrig.length}`);
  console.log(`Merged joints count: ${jointsMerged.length}`);

  const ibmOrigAcc = skinOrig.getInverseBindMatrices();
  const ibmOrigArr = ibmOrigAcc ? ibmOrigAcc.getArray() : null;
  const ibmMergedAcc = skinMerged.getInverseBindMatrices();
  const ibmMergedArr = ibmMergedAcc ? ibmMergedAcc.getArray() : null;

  console.log(`\nOriginal IBM array length: ${ibmOrigArr ? ibmOrigArr.length : 'null'}`);
  console.log(`Merged IBM array length: ${ibmMergedArr ? ibmMergedArr.length : 'null'}`);

  console.log(`\n--- First 5 joints alignment check ---`);
  for (let i = 0; i < Math.min(10, jointsOrig.length); i++) {
    const origJ = jointsOrig[i];
    const origName = origJ.getName();
    
    // In merged skin, joint i-1 should correspond to origJ if i > 0
    let mergedName = 'N/A';
    let ibmOrigMatch = false;
    let ibmMergedMatch = false;

    const idxOrig = i * 16;
    const origIBM = ibmOrigArr ? Array.from(ibmOrigArr.slice(idxOrig, idxOrig + 16)) : [];

    if (i === 0) {
      console.log(`Original [0]: "${origName}"`);
      console.log(`  Orig IBM: [${origIBM.slice(12, 15).map(v => v.toFixed(4)).join(', ')}]`);
    } else {
      const mergedJ = jointsMerged[i - 1];
      mergedName = mergedJ ? mergedJ.getName() : 'NULL';
      const idxMerged = (i - 1) * 16;
      const mergedIBM = ibmMergedArr ? Array.from(ibmMergedArr.slice(idxMerged, idxMerged + 16)) : [];

      console.log(`Original [${i}]: "${origName}" <-> Merged [${i-1}]: "${mergedName}"`);
      console.log(`  Orig IBM trans:   [${origIBM.slice(12, 15).map(v => v.toFixed(4)).join(', ')}]`);
      console.log(`  Merged IBM trans: [${mergedIBM.slice(12, 15).map(v => v.toFixed(4)).join(', ')}]`);
      
      // Check if they are identical
      let diff = 0;
      for (let k = 0; k < 16; k++) {
        diff += Math.abs(origIBM[k] - mergedIBM[k]);
      }
      console.log(`  IBM Difference: ${diff.toFixed(6)}`);
    }
  }

  // Check joint indices in primitives
  console.log(`\n--- Mesh Joint Indices Check ---`);
  for (const node of docMerged.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh && node.getSkin() === skinMerged) {
      console.log(`Node "${node.getName()}" has skin & mesh "${mesh.getName()}"`);
      for (const prim of mesh.listPrimitives()) {
        const joints0 = prim.getAttribute('JOINTS_0');
        if (joints0) {
          const jArr = joints0.getArray();
          let maxVal = -1;
          for (let i = 0; i < jArr.length; i++) {
            if (jArr[i] > maxVal) maxVal = jArr[i];
          }
          console.log(`  Primitive: JOINTS_0 array type: ${jArr.constructor.name}, length: ${jArr.length}, max index: ${maxVal}`);
        }
        const joints1 = prim.getAttribute('JOINTS_1');
        if (joints1) {
          const jArr = joints1.getArray();
          let maxVal = -1;
          for (let i = 0; i < jArr.length; i++) {
            if (jArr[i] > maxVal) maxVal = jArr[i];
          }
          console.log(`  Primitive: JOINTS_1 array type: ${jArr.constructor.name}, length: ${jArr.length}, max index: ${maxVal}`);
        }
      }
    }
  }
}

main().catch(console.error);
