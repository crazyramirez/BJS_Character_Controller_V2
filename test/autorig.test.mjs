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
