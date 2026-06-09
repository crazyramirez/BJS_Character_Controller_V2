import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { prune, unpartition, draco as dracoCompress } from '@gltf-transform/functions';

function cleanBoneName(name) {
  if (!name) return '';
  let clean = name.replace(/_\d+$/, '');
  return clean.toLowerCase();
}

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  const animBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');

  const charDoc = await io.readBinary(new Uint8Array(charBuffer));
  const animDoc = await io.readBinary(new Uint8Array(animBuffer));

  // Find hips node
  let hipsNode = null;
  for (const node of charDoc.getRoot().listNodes()) {
    const name = (node.getName() || '').toLowerCase();
    if (name === 'mixamorig:hips' || name === 'hips' || name === 'pelvis') {
      hipsNode = node;
      break;
    }
  }

  // Strip synthetic root joints
  const skin = charDoc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const rootJointNode = joints[0];
  skin.removeJoint(rootJointNode);
  skin.setSkeleton(hipsNode);

  // Shift joints in primitives
  for (const node of charDoc.getRoot().listNodes()) {
    if (node.getSkin() === skin) {
      const mesh = node.getMesh();
      if (mesh) {
        for (const primitive of mesh.listPrimitives()) {
          const joints0 = primitive.getAttribute('JOINTS_0');
          if (joints0) {
            const arr = joints0.getArray();
            const newArr = new Uint16Array(arr.length);
            for (let i = 0; i < arr.length; i++) {
              newArr[i] = Math.max(0, Math.round(arr[i]) - 1);
            }
            joints0.setArray(newArr);
          }
          const joints1 = primitive.getAttribute('JOINTS_1');
          if (joints1) {
            const arr = joints1.getArray();
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

  // Slice IBMs
  const ibmAcc = skin.getInverseBindMatrices();
  if (ibmAcc) {
    const arr = ibmAcc.getArray();
    if (arr && arr.length >= 16) {
      ibmAcc.setArray(arr.slice(16));
    }
  }

  // Merge animDoc
  const origMeshes = new Set(charDoc.getRoot().listMeshes());
  charDoc.merge(animDoc);

  // Dispose Erika meshes
  for (const mesh of charDoc.getRoot().listMeshes()) {
    if (!origMeshes.has(mesh)) mesh.dispose();
  }

  await charDoc.transform(prune());
  await charDoc.transform(unpartition());

  // Dispose Draco extension first (clear cached old Draco buffers)
  const dracoExt = charDoc.getRoot().listExtensionsUsed().find(ext => ext.extensionName === 'KHR_draco_mesh_compression');
  if (dracoExt) {
    dracoExt.dispose();
    console.log('Disposed KHR_draco_mesh_compression extension.');
  }

  // Re-apply Draco compression cleanly
  console.log('Re-applying Draco compression...');
  await charDoc.transform(dracoCompress());

  // Write and reload
  const buf = await io.writeBinary(charDoc);
  const docMerged = await io.readBinary(buf);

  // Compare joint mapping
  const docOrig = await io.readBinary(charBuffer);
  const skinOrig = docOrig.getRoot().listSkins()[0];
  const skinMerged = docMerged.getRoot().listSkins()[0];
  const jointsOrig = skinOrig.listJoints();
  const jointsMerged = skinMerged.listJoints();

  console.log(`Original joints: ${jointsOrig.length}, Merged joints: ${jointsMerged.length}`);

  const meshesOrig = docOrig.getRoot().listMeshes();
  const meshesMerged = docMerged.getRoot().listMeshes();

  for (const mOrig of meshesOrig) {
    const name = mOrig.getName();
    const mMerged = meshesMerged.find(m => m.getName() === name);
    if (!mMerged) continue;

    const primOrig = mOrig.listPrimitives();
    const primMerged = mMerged.listPrimitives();

    for (let pIdx = 0; pIdx < primOrig.length; pIdx++) {
      const primO = primOrig[pIdx];
      const primM = primMerged[pIdx];

      const jOrig0 = primO.getAttribute('JOINTS_0');
      const wOrig0 = primO.getAttribute('WEIGHTS_0');
      const jMerged0 = primM.getAttribute('JOINTS_0');

      if (!jOrig0 || !jMerged0) continue;

      const aOrigJ = jOrig0.getArray();
      const aOrigW = wOrig0.getArray();
      const aMergedJ = jMerged0.getArray();

      let mismatches = 0;
      let totalChecked = 0;

      for (let i = 0; i < aOrigJ.length; i++) {
        const weight = aOrigW[i];
        if (weight > 0.001) {
          totalChecked++;
          const idxOrig = Math.round(aOrigJ[i]);
          const idxMerged = Math.round(aMergedJ[i]);

          const boneOrigNode = jointsOrig[idxOrig];
          const boneMergedNode = jointsMerged[idxMerged];

          const nameOrig = cleanBoneName(boneOrigNode?.getName());
          const nameMerged = cleanBoneName(boneMergedNode?.getName());

          if (nameOrig !== nameMerged) {
            mismatches++;
          }
        }
      }

      console.log(`Mesh "${name}" prim [${pIdx}]: JOINTS_0 componentType=${jMerged0.getComponentType()}, total checked = ${totalChecked}, mismatches = ${mismatches}`);
    }
  }
}

main().catch(console.error);
