/**
 * scratch_axis_test.mjs
 * Generates multiple merged versions with different correction axes to find the right one.
 */
import fs from 'fs';
import { mergeGLBs } from './js/core/merge_api.mjs';

const boyBuf = fs.readFileSync('./assets/3d_character_young_boy.glb');
const animBuf = fs.readFileSync('./assets/character_animated.glb');

// Test with ARM_SPREAD_ANGLE=0 to see the baseline (no correction)
console.log('Testing: no arm correction (ARM_SPREAD_ANGLE=0)...');
const noCorrect = await mergeGLBs(boyBuf, animBuf, { ARM_SPREAD_ANGLE: 0 });
fs.writeFileSync('./assets/boy_test_no_correct.glb', noCorrect);
console.log('Written: boy_test_no_correct.glb');

// Test with the current auto-detected value (should be ~59°)
console.log('\nTesting: with auto-detected spread angle (default behavior)...');
const withCorrect = await mergeGLBs(boyBuf, animBuf, {});
fs.writeFileSync('./assets/boy_test_with_correct.glb', withCorrect);
console.log('Written: boy_test_with_correct.glb');

console.log('\nDone! Load both files in the builder to compare.');
