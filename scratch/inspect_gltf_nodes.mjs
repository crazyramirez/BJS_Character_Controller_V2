import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();

async function main() {
  const document = await io.read('assets/animations.glb');
  const root = document.getRoot();
  const animations = root.listAnimations();
  
  // Inspect the first animation group's channels
  if (animations.length > 0) {
    const firstAnim = animations.find(a => a.getName().includes('Walk_Loop') || a.getName().includes('Idle_Loop')) || animations[0];
    console.log(`\n=== Channels for animation: ${firstAnim.getName()} ===`);
    const channels = firstAnim.listChannels();
    channels.forEach(chan => {
      const targetNode = chan.getTargetNode();
      const targetPath = chan.getTargetPath();
      console.log(`Node: "${targetNode ? targetNode.getName() : 'none'}" | Path: "${targetPath}"`);
    });
  }
}

main();
