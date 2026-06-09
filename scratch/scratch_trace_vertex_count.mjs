import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { prune, unpartition, draco as dracoCompress, resample } from '@gltf-transform/functions';

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

  const getCount = () => {
    const mesh = charDoc.getRoot().listMeshes().find(m => m.getName() === 'Body_PackedMaterial0_0');
    const prim = mesh?.listPrimitives()[0];
    const pos = prim?.getAttribute('POSITION');
    return pos ? pos.getCount() : 'N/A';
  };

  console.log('Initially:', getCount());

  // Replicate merge steps
  console.log('Stripping root joint...');
  // (we skip details, just stripping logic)
  const skin = charDoc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  if (joints.length > 0 && joints[0].getName().includes('_rootJoint')) {
    skin.removeJoint(joints[0]);
  }
  console.log('After stripping root joint:', getCount());

  console.log('Merging animDoc...');
  const origMeshes = new Set(charDoc.getRoot().listMeshes());
  charDoc.merge(animDoc);
  console.log('After merge:', getCount());

  console.log('Disposing imported meshes...');
  for (const mesh of charDoc.getRoot().listMeshes()) {
    if (!origMeshes.has(mesh)) mesh.dispose();
  }
  console.log('After disposing imported meshes:', getCount());

  console.log('Running prune...');
  await charDoc.transform(prune());
  console.log('After prune:', getCount());

  console.log('Running unpartition...');
  await charDoc.transform(unpartition());
  console.log('After unpartition:', getCount());

  console.log('Saving and reloading...');
  const buf = await io.writeBinary(charDoc);
  const charDoc2 = await io.readBinary(buf);
  
  const m2 = charDoc2.getRoot().listMeshes().find(m => m.getName() === 'Body_PackedMaterial0_0');
  const pos2 = m2?.listPrimitives()[0]?.getAttribute('POSITION');
  console.log('After reload:', pos2 ? pos2.getCount() : 'N/A');
}

main().catch(console.error);
