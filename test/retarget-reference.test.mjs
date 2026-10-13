import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { autoRigGLB, guessJoints } from '../js/core/autorig_api.mjs';
import { mergeGLBs } from '../js/core/merge_api.mjs';
import { createIO } from './helpers.mjs';

const options = { COMPRESS_OUTPUT: false, removeExistingAnimations: true };
let animationsPromise;
async function animationsWithoutReference() {
  animationsPromise ||= (async () => {
    const io = await createIO();
    const doc = await io.readBinary(await fs.readFile(new URL('../assets/animations.glb', import.meta.url)));
    const keep = new Set(['Idle_Loop', 'Walk_Loop', 'Punch_Cross', 'Roll']);
    for (const animation of doc.getRoot().listAnimations()) {
      if (!keep.has(animation.getName())) animation.dispose();
    }
    assert.ok(doc.getRoot().listAnimations().length >= 3);
    assert.ok(!doc.getRoot().listAnimations().some(a => /t[_-]?pose/i.test(a.getName())));
    return io.writeBinary(doc);
  })();
  return animationsPromise;
}

function tracks(doc) {
  const result = new Map();
  for (const animation of doc.getRoot().listAnimations()) for (const channel of animation.listChannels()) {
    const key = `${animation.getName()}/${channel.getTargetNode().getName()}/${channel.getTargetPath()}`;
    result.set(key, { path: channel.getTargetPath(), values: channel.getSampler().getOutput().getArray(),
      times: channel.getSampler().getInput().getArray() });
  }
  return result;
}

function assertSameMotion(before, after) {
  const expected = tracks(before), actual = tracks(after);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [name, a] of expected) {
    const b = actual.get(name);
    assert.deepEqual(b.times, a.times, `${name}: key times`);
    assert.equal(b.values.length, a.values.length, name);
    if (a.path === 'rotation') {
      for (let i = 0; i < a.values.length; i += 4) {
        let dot = 0;
        for (let k = 0; k < 4; k++) dot += a.values[i + k] * b.values[i + k];
        const sign = dot < 0 ? -1 : 1;
        for (let k = 0; k < 4; k++) assert.ok(Math.abs(a.values[i + k] - sign * b.values[i + k]) < 3e-5,
          `${name}: pose changed at sample ${i / 4}`);
      }
    } else {
      a.values.forEach((value, i) => assert.ok(Math.abs(value - b.values[i]) < 1e-4,
        `${name}: ${value} became ${b.values[i]}`));
    }
  }
}

for (const filename of ['female_character_simple.glb', 'pete_base.glb', 'characters_test/prisioner_hostage.glb']) {
  test(`Apply Rig/export preserves retargeted motion without a T-pose clip: ${filename}`, async () => {
    const io = await createIO();
    let source = await fs.readFile(new URL(`../assets/${filename}`, import.meta.url));
    if (filename === 'female_character_simple.glb') source = await autoRigGLB(source, { skinFingers: 'auto' });
    const first = await mergeGLBs(source, await animationsWithoutReference(), options);
    const unchangedRig = await autoRigGLB(source, { joints: (await guessJoints(source)).joints });
    const second = await mergeGLBs(unchangedRig, first, options);
    const third = await mergeGLBs(unchangedRig, second, options);
    const before = await io.readBinary(first);
    assertSameMotion(before, await io.readBinary(second));
    assertSameMotion(before, await io.readBinary(third));
    const poses = before.getRoot().getExtras().bjsRetargetPoses;
    assert.equal(Object.keys(poses).length, 1, 'clips share a compact reference pose');
    for (const animation of before.getRoot().listAnimations()) {
      assert.ok(poses[animation.getExtras().bjsRetargetPose]);
    }
  });
}

test('export does not apply posture corrections or root-motion scale a second time', async () => {
  const io = await createIO();
  const source = await fs.readFile(new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url));
  const transformed = { ...options, SCALE_X: 2, SCALE_Y: 2, SCALE_Z: 2, ARM_SPREAD_ANGLE: 12, HIPS_TILT_ANGLE: 5 };
  const first = await mergeGLBs(source, await animationsWithoutReference(), transformed);
  const second = await mergeGLBs(source, first, transformed);
  assertSameMotion(await io.readBinary(first), await io.readBinary(second));
});

test('merging and exporting a library retains references for previously imported clips', async () => {
  const io = await createIO();
  const source = await fs.readFile(new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url));
  const first = await mergeGLBs(source, await animationsWithoutReference(), options);
  const incoming = await io.readBinary(await animationsWithoutReference());
  for (const animation of incoming.getRoot().listAnimations()) animation.setName(`Extra_${animation.getName()}`);
  const merged = await mergeGLBs(first, await io.writeBinary(incoming), { ...options, removeExistingAnimations: false });
  const before = await io.readBinary(merged);
  assert.equal(Object.keys(before.getRoot().getExtras().bjsRetargetPoses).length, 2);
  const exported = await mergeGLBs(source, merged, options);
  assertSameMotion(before, await io.readBinary(exported));
});

test('missing reference metadata fails explicitly instead of silently distorting clips', async () => {
  const io = await createIO();
  const source = await fs.readFile(new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url));
  const merged = await io.readBinary(await mergeGLBs(source, await animationsWithoutReference(), options));
  merged.getRoot().setExtras({});
  await assert.rejects(mergeGLBs(source, await io.writeBinary(merged), options), /missing its retarget reference pose/);
});
