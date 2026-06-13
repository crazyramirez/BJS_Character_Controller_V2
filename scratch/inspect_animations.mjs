import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();

async function inspect(path) {
  console.log(`\n=== Inspecting: ${path} ===`);
  try {
    const document = await io.read(path);
    const root = document.getRoot();
    const animations = root.listAnimations();
    console.log(`Found ${animations.length} animations:`);
    animations.forEach(anim => {
      console.log(` - ${anim.getName()}`);
    });
  } catch (err) {
    console.error(`Error reading ${path}:`, err.message);
  }
}

async function main() {
  await inspect('assets/character_animated.glb');
  await inspect('assets/animations.glb');
}

main();
