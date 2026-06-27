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
        // Check sanity manually
        const head = guess.joints.Head?.[1] || 0;
        const neck = guess.joints.Neck?.[1] || 0;
        const spine2 = guess.joints.Spine2?.[1] || 0;
        const spine1 = guess.joints.Spine1?.[1] || 0;
        const spine = guess.joints.Spine?.[1] || 0;
        const hips = guess.joints.Hips?.[1] || 0;
        const clavicle = guess.joints.LeftShoulder?.[1] || 0;
        
        const isSpineInverted = (head < neck) || (neck < spine2) || (spine2 < spine1) || (spine1 < spine) || (spine < hips);
        if (isSpineInverted || hips > (head + hips) / 2) {
          console.log(`\n!!! INCONSISTENCY IN FILE: ${path} !!!`);
          console.log(`Head: ${head.toFixed(3)}, Neck: ${neck.toFixed(3)}, Spine2: ${spine2.toFixed(3)}, Spine1: ${spine1.toFixed(3)}, Spine: ${spine.toFixed(3)}, Hips: ${hips.toFixed(3)}, LeftShoulder (Clavicle): ${clavicle.toFixed(3)}`);
        }
      } catch (e) {
        // ignore errors
      }
    }
  }
}

main().catch(console.error);
