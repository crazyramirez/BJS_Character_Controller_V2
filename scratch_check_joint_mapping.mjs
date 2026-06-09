import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from './js/core/merge_api.mjs';

function cleanBoneName(name) {
  if (!name) return '';
  let clean = name.replace(/_\d+$/, '');
  return clean.toLowerCase();
}

async function main() {
  const charBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb');
  const animBuffer = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb');

  console.log('Generating UNCOMPRESSED merged GLB...');
  const mergedBuffer = await mergeGLBs(charBuffer, animBuffer, { COMPRESS_OUTPUT: false });

  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const docOrig = await io.readBinary(charBuffer);
  const docMerged = await io.readBinary(new Uint8Array(mergedBuffer));

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
    if (!mMerged) {
      console.log(`Could not find merged counterpart for mesh: ${name}`);
      continue;
    }

    console.log(`\nVerifying mesh: "${name}"`);
    const primsOrig = mOrig.listPrimitives();
    const primsMerged = mMerged.listPrimitives();

    for (let pIdx = 0; pIdx < primsOrig.length; pIdx++) {
      const primOrig = primsOrig[pIdx];
      const primMerged = primsMerged[pIdx];

      const jOrig0 = primOrig.getAttribute('JOINTS_0');
      const wOrig0 = primOrig.getAttribute('WEIGHTS_0');
      const jMerged0 = primMerged.getAttribute('JOINTS_0');
      const wMerged0 = primMerged.getAttribute('WEIGHTS_0');

      if (!jOrig0 || !jMerged0) {
        console.log(`  Primitive [${pIdx}] has no joints.`);
        continue;
      }

      const aOrigJ = jOrig0.getArray();
      const aOrigW = wOrig0.getArray();
      const aMergedJ = jMerged0.getArray();
      const aMergedW = wMerged0.getArray();

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
            if (mismatches <= 5) {
              console.log(`    Mismatch at vertex element ${i}: origJointIndex=${idxOrig} ("${boneOrigNode?.getName()}") <-> mergedJointIndex=${idxMerged} ("${boneMergedNode?.getName()}")`);
            }
          }
        }
      }

      console.log(`  Primitive [${pIdx}] verified: total active weights checked = ${totalChecked}, mismatches = ${mismatches}`);
    }
  }
}

main().catch(console.error);
