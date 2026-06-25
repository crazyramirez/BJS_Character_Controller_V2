/**
 * Twist-bone retargeting coverage test — Iteration 5.
 *
 * Verifies that the major source-skeleton twist-bone naming conventions are
 * covered by merge_api.mjs BONE_MAP so they are not silently dropped during
 * retargeting.
 *
 * Run with: node --test test/twist_retarget.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BONE_MAP, aliasNorm } from '../js/core/merge_api.mjs';

function covers(alias) {
  const norm = aliasNorm(alias);
  for (const [key, alts] of Object.entries(BONE_MAP)) {
    if (aliasNorm(key) === norm) return true;
    if (alts.some(a => aliasNorm(a) === norm)) return true;
  }
  return false;
}

describe('Twist-bone BONE_MAP coverage', () => {
  it('covers Mixamo-style twist bone names', () => {
    for (const name of [
      'LeftArmTwist', 'LeftForeArmTwist', 'LeftUpLegTwist', 'LeftLegTwist',
      'RightArmTwist', 'RightForeArmTwist', 'RightUpLegTwist', 'RightLegTwist',
    ]) {
      assert.ok(covers(name), `expected coverage for ${name}`);
    }
  });

  it('covers UE5/Mannequin twist bone names', () => {
    for (const name of [
      'upperarm_twist_01_l', 'upperarm_twist_01_r',
      'lowerarm_twist_01_l', 'lowerarm_twist_01_r',
      'thigh_twist_01_l', 'thigh_twist_01_r',
      'calf_twist_01_l', 'calf_twist_01_r',
    ]) {
      assert.ok(covers(name), `expected coverage for ${name}`);
    }
  });
});
