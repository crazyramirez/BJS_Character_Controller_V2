import { guessJoints } from '../js/core/autorig_api.mjs';
import { readFileSync } from 'fs';

async function main() {
  const buffer = readFileSync('d:/DEV/BJS Character Controller V2/kobold_trap_setter-male.glb');
  const guess = await guessJoints(buffer);

  console.log('--- JOINT GUESSES ---');
  for (const [name, pos] of Object.entries(guess.joints)) {
    console.log(`${name}: [${pos.map(n => n.toFixed(3)).join(', ')}]`);
  }
  console.log('Method:', guess.method);
  console.log('Humanoid:', guess.humanoid);
  console.log('Score:', guess.score);
  console.log('Reason:', guess.reason);
}

main().catch(console.error);
