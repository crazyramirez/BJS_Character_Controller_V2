import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { autoRigGLB, guessJoints, SKELETON_PRESETS, validateJointLayout } from '../js/core/autorig_api.mjs';

const fixture = new URL('../assets/female_character_simple.glb', import.meta.url);

async function createIO() {
  const lib = draco3d.createDecoderModule ? draco3d : draco3d.default;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await lib.createDecoderModule(),
    'draco3d.encoder': await lib.createEncoderModule(),
  });
}

test('all exported skeleton presets produce a valid 52-joint skin', async () => {
  const source = await fs.readFile(fixture);
  const guess = await guessJoints(source);
  const io = await createIO();
  assert.equal(guess.supportedSkeletonPresets.length, Object.keys(SKELETON_PRESETS).length);
  for (const id of Object.keys(SKELETON_PRESETS)) {
    const output = await autoRigGLB(source, { joints: guess.joints, skeletonPreset: id });
    const doc = await io.readBinary(output);
    const skins = doc.getRoot().listSkins();
    assert.equal(skins.length, 1, id);
    assert.equal(skins[0].listJoints().length, 52, id);
    const skinnedMeshes = new Set(doc.getRoot().listNodes().filter(node => node.getSkin()).map(node => node.getMesh()));
    assert.ok(skinnedMeshes.size > 0, `${id}: skinned mesh`);
    for (const primitive of [...skinnedMeshes].flatMap(mesh => mesh.listPrimitives())) {
      assert.ok(primitive.getAttribute('JOINTS_0'), `${id}: JOINTS_0`);
      const jointIndices = primitive.getAttribute('JOINTS_0').getArray();
      let maxJoint = 0;
      for (const index of jointIndices) if (index > maxJoint) maxJoint = index;
      assert.ok(maxJoint < 22, `${id}: guessed fingers do not deform hands before opt-in`);
      const weights = primitive.getAttribute('WEIGHTS_0')?.getArray();
      assert.ok(weights, `${id}: WEIGHTS_0`);
      for (let i = 0; i < weights.length; i += 4) {
        const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
        assert.ok(Math.abs(sum - 1) < 1e-5, `${id}: normalized weight ${i / 4}`);
      }
    }
  }
});

test('joint validation rejects typos, NaN and collapsed bones', () => {
  assert.throws(() => validateJointLayout({ LeftElbo: [0, 0, 0] }, 1, { partial: true }), /Unknown/);
  assert.throws(() => validateJointLayout({ Hips: [0, NaN, 0] }, 1, { partial: true }), /finite/);
  assert.throws(() => validateJointLayout({}, 0), /height/);
});

test('unknown skeleton presets fail explicitly', async () => {
  const source = await fs.readFile(fixture);
  await assert.rejects(autoRigGLB(source, { skeletonPreset: 'mystery' }), /Unknown skeleton preset/);
});

test('re-rig preserves an existing extended skeleton instead of replacing it', async () => {
  const source = await fs.readFile(new URL('../assets/low_poly.glb', import.meta.url));
  const io = await createIO();
  const before = await io.readBinary(source);
  const beforeNames = before.getRoot().listSkins()[0].listJoints().map(j => j.getName());
  const guess = await guessJoints(source);
  assert.equal(guess.reRig, true);
  const output = await autoRigGLB(source, { joints: guess.joints });
  const after = await io.readBinary(output);
  const afterNames = after.getRoot().listSkins()[0].listJoints().map(j => j.getName());
  assert.deepEqual(afterNames, beforeNames);
});

test('finger-count selector builds matching hierarchies and rigs', async () => {
  const source = await fs.readFile(fixture);
  const io = await createIO();
  for (const fingerCount of [0, 2, 3, 5]) {
    const guess = await guessJoints(source, { fingerCount });
    const expected = 22 + fingerCount * 6;
    assert.equal(Object.keys(guess.joints).length, expected, `guess fingers=${fingerCount}`);
    assert.equal(guess.fingerCount, fingerCount);
    const output = await autoRigGLB(source, { joints: guess.joints, fingerCount });
    const doc = await io.readBinary(output);
    assert.equal(doc.getRoot().listSkins()[0].listJoints().length, expected, `rig fingers=${fingerCount}`);
  }
  await assert.rejects(guessJoints(source, { fingerCount: 7 }), /finger count/);
});

test('quadruped body plan rigs four legs plus a tail chain', async () => {
  const source = await fs.readFile(fixture);
  const io = await createIO();
  const guess = await guessJoints(source, { bodyPlan: 'quadruped', fingerCount: 0 });
  assert.equal(guess.bodyPlan, 'quadruped');
  for (const t of ['Tail1', 'Tail2', 'Tail3']) assert.ok(guess.joints[t], t);
  assert.equal(Object.keys(guess.joints).length, 25);
  const output = await autoRigGLB(source, { joints: guess.joints, bodyPlan: 'quadruped', fingerCount: 0 });
  const names = new Set((await io.readBinary(output)).getRoot().listSkins()[0].listJoints().map(j => j.getName()));
  assert.equal(names.size, 25);
  assert.ok(names.has('Tail3') && names.has('LeftHand') && names.has('RightFoot'));
  await assert.rejects(guessJoints(source, { bodyPlan: 'insect' }), /body plan/);
});

test('twist bones extend the layout and the quality report is filled', async () => {
  const source = await fs.readFile(fixture);
  const io = await createIO();
  const guess = await guessJoints(source, { fingerCount: 0 });
  const reportSink = {};
  const output = await autoRigGLB(source, { joints: guess.joints, fingerCount: 0, twistBones: true, reportSink });
  const doc = await io.readBinary(output);
  const names = doc.getRoot().listSkins()[0].listJoints().map(j => j.getName());
  assert.equal(names.length, 24); // 22 body + 2 forearm twists
  assert.ok(names.includes('LeftForeArmTwist') && names.includes('RightForeArmTwist'));
  // Twist joints sit between elbow and wrist, parented to the forearm
  const twist = doc.getRoot().listNodes().find(n => n.getName() === 'LeftForeArmTwist');
  assert.ok(twist);
  // Report populated with a sane score
  assert.ok(Number.isFinite(reportSink.score) && reportSink.score >= 0 && reportSink.score <= 100);
  assert.equal(reportSink.twistBones, true);
  assert.equal(typeof reportSink.geodesicWeights, 'boolean');
  assert.ok(Array.isArray(reportSink.notes));
  // Weights still normalized with the extended bone set
  const prim = doc.getRoot().listNodes().find(n => n.getSkin())?.getMesh()?.listPrimitives()[0];
  const weights = prim.getAttribute('WEIGHTS_0').getArray();
  for (let i = 0; i < weights.length; i += 4) {
    const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
    assert.ok(Math.abs(sum - 1) < 1e-5, `normalized weight ${i / 4}`);
  }
});

test('geodesic weighting can be disabled and euclidean output stays valid', async () => {
  const source = await fs.readFile(fixture);
  const io = await createIO();
  const guess = await guessJoints(source, { fingerCount: 0 });
  const reportSink = {};
  const output = await autoRigGLB(source, { joints: guess.joints, fingerCount: 0, geodesicWeights: false, reportSink });
  const doc = await io.readBinary(output);
  assert.equal(reportSink.geodesicWeights, false);
  assert.equal(doc.getRoot().listSkins()[0].listJoints().length, 22);
});

test('rebuild strips an existing rig and generates the requested layout', async () => {
  const source = await fs.readFile(new URL('../assets/low_poly.glb', import.meta.url));
  const io = await createIO();
  const guess = await guessJoints(source, { fingerCount: 2 });
  assert.equal(guess.reRig, true);
  const output = await autoRigGLB(source, { joints: guess.joints, fingerCount: 2, rebuild: true });
  const doc = await io.readBinary(output);
  const names = doc.getRoot().listSkins()[0].listJoints().map(j => j.getName());
  assert.equal(names.length, 34); // 22 body + 2 fingers × 3 segments × 2 hands
  assert.ok(names.includes('LeftHandIndex3') && !names.includes('LeftHandMiddle1'));
  // Weights valid on the rebuilt skin
  const prim = doc.getRoot().listNodes().find(n => n.getSkin())?.getMesh()?.listPrimitives()[0];
  const weights = prim.getAttribute('WEIGHTS_0').getArray();
  for (let i = 0; i < weights.length; i += 4) {
    const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
    assert.ok(Math.abs(sum - 1) < 1e-5, `normalized weight ${i / 4}`);
  }
});
