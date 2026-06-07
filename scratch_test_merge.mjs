/**
 * scratch_test_merge.mjs
 * Test merge of boy character with animations to see the effect of the spread angle.
 */
import fs from 'fs';
import { mergeGLBs } from './js/core/merge_api.mjs';

const boyBuf = fs.readFileSync('./assets/3d_character_young_boy.glb');

// Use the existing animated character as animation source
const animPath = './assets/character_animated.glb';
const animBuf = fs.existsSync(animPath) ? fs.readFileSync(animPath) : null;

if (!animBuf) {
  console.log('No animations.glb found. Testing spread detection only (no merge).');
  // Just call mergeGLBs with no animation to trigger the spread detection logs
  const result = await mergeGLBs(boyBuf, null, {});
  console.log('Merged size:', result.byteLength);
} else {
  console.log('Merging boy character with animations...');
  const result = await mergeGLBs(boyBuf, animBuf, {});
  fs.writeFileSync('./assets/boy_merged_test.glb', result);
  console.log('Output written to boy_merged_test.glb:', result.byteLength, 'bytes');
}
