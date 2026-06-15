import fs from 'fs';
import { guessJoints } from './js/core/autorig_api.mjs';

async function test() {
  try {
    const buffer = fs.readFileSync('./js/core/low_poly_female_base_character_lightmapped.glb');
    const result = await guessJoints(buffer);
    console.log('HEIGHT:', result.height);
    console.log('BOUNDS:', result.bounds);
    console.log('JOINTS:', JSON.stringify(result.joints, null, 2));
  } catch (err) {
    console.error(err);
  }
}

test();
