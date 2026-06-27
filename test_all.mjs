import { guessJoints } from './js/core/autorig_api.mjs';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  const dirs = ['.', './assets'];
  for (const dir of dirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.glb'));
    for (const file of files) {
      const path = join(dir, file);
      try {
        const buffer = readFileSync(path);
        const guess = await guessJoints(buffer);
        console.log(`\n=== File: ${path} ===`);
        console.log('Method:', guess.method);
        console.log('Humanoid:', guess.humanoid);
        console.log('Score:', guess.score);
        console.log('Reason:', guess.reason);
        console.log('Hips Y:', guess.joints.Hips?.[1]?.toFixed(3));
        console.log('Spine Y:', guess.joints.Spine?.[1]?.toFixed(3));
        console.log('Spine1 Y:', guess.joints.Spine1?.[1]?.toFixed(3));
        console.log('Spine2 Y:', guess.joints.Spine2?.[1]?.toFixed(3));
        console.log('Neck Y:', guess.joints.Neck?.[1]?.toFixed(3));
        console.log('Head Y:', guess.joints.Head?.[1]?.toFixed(3));
        console.log('LeftShoulder Y:', guess.joints.LeftShoulder?.[1]?.toFixed(3));
        console.log('LeftArm Y:', guess.joints.LeftArm?.[1]?.toFixed(3));
        console.log('LeftUpLeg Y:', guess.joints.LeftUpLeg?.[1]?.toFixed(3));
      } catch (e) {
        console.error(`Error on ${path}:`, e.message);
      }
    }
  }
}

main().catch(console.error);
