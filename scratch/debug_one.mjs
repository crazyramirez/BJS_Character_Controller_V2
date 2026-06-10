import { readFileSync } from 'fs';
import { mergeGLBs } from '../js/core/merge_api.mjs';
const ROOT = 'd:/DEV/BJS Character Controller V2';
const charBuf = readFileSync(`${ROOT}/scratch/synthetic/${process.argv[2] || 'syn_rpm_t.glb'}`);
const animBuf = readFileSync(`${ROOT}/assets/character_animated.glb`);
await mergeGLBs(charBuf, animBuf, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
