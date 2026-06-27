import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';
import { guessJoints } from './js/core/autorig_api.mjs';

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const buffer = readFileSync('d:/DEV/BJS Character Controller V2/kobold_trap_setter-male.glb');
  const doc = await io.readBinary(new Uint8Array(buffer));
  
  // Clear skins
  for (const skin of doc.getRoot().listSkins()) {
    skin.dispose();
  }
  for (const node of doc.getRoot().listNodes()) {
    node.setSkin(null);
  }

  const skinlessBuffer = await io.writeBinary(doc);
  const guess = await guessJoints(skinlessBuffer);
  
  console.log('--- JOINT GUESSES (SKINLESS) ---');
  for (const [name, pos] of Object.entries(guess.joints)) {
    console.log(`${name}: [${pos.map(n => n.toFixed(3)).join(', ')}]`);
  }
  console.log('Method:', guess.method);
  console.log('Humanoid:', guess.humanoid);
  console.log('Score:', guess.score);
  console.log('Reason:', guess.reason);
}

main().catch(console.error);
