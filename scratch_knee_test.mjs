import fs from 'fs';
import { guessJoints, autoRigGLB } from './js/core/autorig_api.mjs';
import { mergeGLBs } from './js/core/merge_api.mjs';

async function testKnees() {
  try {
    global.MOCK_FORWARD_Z = -1; // Mock character facing -Z
    
    const baseBuffer = fs.readFileSync('./js/core/low_poly_female_base_character_lightmapped.glb');
    
    // 1. Get initial guess
    const firstGuess = await guessJoints(baseBuffer);
    
    // Move LeftLeg (knee) forward: original is -0.101, let's move it to +0.200 (forward)
    const originalLeftLeg = [...firstGuess.joints.LeftLeg];
    firstGuess.joints.LeftLeg[2] = 0.200; // bent forward
    
    console.log(`Original LeftLeg: ${originalLeftLeg.map(v => v.toFixed(3)).join(', ')}`);
    console.log(`Placed LeftLeg (Forward): ${firstGuess.joints.LeftLeg.map(v => v.toFixed(3)).join(', ')}`);
    
    // 2. Rig for the first time (faces -Z, should not swap Left/Right labels because they are already placed correctly)
    const riggedBuffer = await autoRigGLB(baseBuffer, { joints: firstGuess.joints });
    
    // 3. Merge
    const mergedBuffer = await mergeGLBs(riggedBuffer, null, {
      COMPRESS_OUTPUT: false,
      ARM_SPREAD_ANGLE: 0,
      ARM_SPLAY_ANGLE: 0,
      SHOULDER_RAISE_ANGLE: 0,
      LEG_SPREAD_ANGLE: 0,
      SPINE_STRAIGHTEN_ANGLE: 0,
      HIPS_TILT_ANGLE: 0,
    });
    
    // 4. Guess again on merged (seeds from skin)
    const secondGuess = await guessJoints(mergedBuffer);
    console.log(`Second Guess LeftLeg (from skin): ${secondGuess.joints.LeftLeg.map(v => v.toFixed(3)).join(', ')}`);
    console.log(`Second Guess RightLeg (from skin): ${secondGuess.joints.RightLeg.map(v => v.toFixed(3)).join(', ')}`);
    
    // 5. Move knee again to a new position (e.g. +0.400)
    secondGuess.joints.LeftLeg[2] = 0.400;
    console.log(`Moving knee further forward to: ${secondGuess.joints.LeftLeg.map(v => v.toFixed(3)).join(', ')}`);
    
    // 6. Rig again (this triggers adjustExistingRig)
    const reRiggedBuffer = await autoRigGLB(mergedBuffer, { joints: secondGuess.joints });
    
    // 7. Merge again
    const reMergedBuffer = await mergeGLBs(reRiggedBuffer, null, {
      COMPRESS_OUTPUT: false,
      ARM_SPREAD_ANGLE: 0,
      ARM_SPLAY_ANGLE: 0,
      SHOULDER_RAISE_ANGLE: 0,
      LEG_SPREAD_ANGLE: 0,
      SPINE_STRAIGHTEN_ANGLE: 0,
      HIPS_TILT_ANGLE: 0,
    });
    
    // 8. Guess again on re-merged
    const thirdGuess = await guessJoints(reMergedBuffer);
    const finalLeftLeg = thirdGuess.joints.LeftLeg;
    console.log(`Final LeftLeg (after adjust & merge): ${finalLeftLeg.map(v => v.toFixed(3)).join(', ')}`);
    console.log(`Final RightLeg (after adjust & merge): ${thirdGuess.joints.RightLeg.map(v => v.toFixed(3)).join(', ')}`);
    
    const diffZ = finalLeftLeg[2] - 0.400;
    console.log(`Z-axis difference: ${diffZ.toFixed(6)}`);
    
    if (Math.abs(diffZ) < 0.01) {
      console.log('✓ Knee Z position is stable after re-rig!');
    } else {
      console.error('✗ Knee Z position FLIPPED or shifted after re-rig!');
    }
  } catch (err) {
    console.error(err);
  }
}

testKnees();
