/** Re-rig the real character_animated.glb and merge animations.glb */
import { readFileSync, writeFileSync } from 'fs';
import { autoRigGLB, guessJoints } from '../js/core/autorig_api.mjs';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';

const charBuf = readFileSync(new URL('../assets/character_animated.glb', import.meta.url));
const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));

const guess = await guessJoints(charBuf);
console.log('reRig:', guess.reRig, '| height:', guess.height.toFixed(2));
console.log('LeftFoot z:', guess.joints.LeftFoot[2].toFixed(3), '| LeftToeBase z:', guess.joints.LeftToeBase[2].toFixed(3),
  '→ facing', guess.joints.LeftToeBase[2] < guess.joints.LeftFoot[2] ? '-Z' : '+Z');
console.log('LeftArm x:', guess.joints.LeftArm[0].toFixed(3), '| RightArm x:', guess.joints.RightArm[0].toFixed(3));

const rigged = await autoRigGLB(charBuf, { joints: guess.joints });
const a = await analyzeGLB(rigged);
console.log('rigged → hasSkin:', a.hasSkin, '| bones:', a.boneCount, '| pose:', a.poseStyle, '| type:', a.skeletonType.label);

const merged = await mergeGLBs(rigged, animBuf, { removeExistingAnimations: true });
const ma = await analyzeGLB(merged);
console.log('merged → anims:', ma.animations.length, '| pose:', ma.poseStyle);
writeFileSync(new URL('./out_rerigged_merged.glb', import.meta.url), merged);
console.log('wrote scratch/out_rerigged_merged.glb — inspect visually in the builder');
