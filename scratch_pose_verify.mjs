/**
 * scratch_pose_verify.mjs
 * Verifies what pose is detected for both characters and what ARM_SPREAD_ANGLE is computed.
 */
import fs from 'fs';
import { analyzeGLB, mergeGLBs } from './js/core/merge_api.mjs';

const boyBuf = fs.readFileSync('d:/DEV/BJS Character Controller V2/assets/3d_character_young_boy.glb');
const pepeBuf = fs.readFileSync('d:/DEV/BJS Character Controller V2/assets/pepe.glb');

console.log('\n--- Analyzing Boy ---');
const boyInfo = await analyzeGLB(boyBuf);
console.log('Skeleton type:', boyInfo.skeletonType);
console.log('Pose style:', boyInfo.poseStyle);
console.log('Bone count:', boyInfo.boneCount);

// Check bone names that contain 'arm'
console.log('\nArm-related bones in Boy:');
boyInfo.bones.filter(b => /arm|shoulder/i.test(b.cleanName)).forEach(b => {
  console.log(`  "${b.name}" (clean: "${b.cleanName}")`);
});

console.log('\n--- Analyzing Pepe ---');
const pepeInfo = await analyzeGLB(pepeBuf);
console.log('Skeleton type:', pepeInfo.skeletonType);
console.log('Pose style:', pepeInfo.poseStyle);

console.log('\nArm-related bones in Pepe:');
pepeInfo.bones.filter(b => /arm|shoulder/i.test(b.cleanName)).forEach(b => {
  console.log(`  "${b.name}" (clean: "${b.cleanName}")`);
});
