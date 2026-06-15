import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();

async function main() {
  try {
    const document = await io.read('assets/pete_base.glb');
    const root = document.getRoot();
    const meshes = root.listMeshes();
    console.log(`Found ${meshes.length} meshes.`);
    const skins = root.listSkins();
    console.log(`Found ${skins.length} skins.`);
    skins.forEach((skin, index) => {
      console.log(`Skin ${index} joints:`);
      skin.listJoints().forEach(joint => {
        console.log(` - ${joint.getName()}`);
      });
    });
  } catch (err) {
    console.error('Error reading pete_base.glb:', err.message);
  }
}

main();
