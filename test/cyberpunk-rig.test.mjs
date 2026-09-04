import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import BABYLON from 'babylonjs';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';
import { createIO, approx, parentMap } from './helpers.mjs';

// Reproduce the reported FBX naming/axis conventions with the small model
// already in the repository; the user's 75 MB file is not a test dependency.
async function fixture({ yaw = Math.PI, coincidentSpine = false, relaxedArms = false } = {}) {
  const io = await createIO();
  const doc = await io.readBinary(await fs.readFile(new URL('../assets/low_poly.glb', import.meta.url)));
  doc.getRoot().listAnimations().forEach(clip => clip.dispose());
  const names = new Map();
  const parents = parentMap(doc);
  const baseNames = { Hips: 'hips', Spine: 'spine1', Spine1: 'spine2', Spine2: 'spine3', Neck: 'neck', Head: 'head' };
  const limbNames = { Shoulder: 'shoulder', Arm: 'arm', ForeArm: 'forearm', Hand: 'hand', UpLeg: 'leg', Leg: 'knee', Foot: 'foot', ToeBase: 'toes' };
  let index = 0;
  for (const node of doc.getRoot().listNodes()) {
    const canonical = node.getName().replace(/^mixamorig:/, '');
    let name = baseNames[canonical];
    const side = canonical.match(/^(Left|Right)(.*)$/);
    if (side) name = `${side[1] === 'Left' ? 'l' : 'r'} ${limbNames[side[2]] || side[2].replace(/^Hand/, '').toLowerCase()}`;
    if (coincidentSpine && canonical === 'Spine') node.setTranslation([0, 0, 0]);
    if (relaxedArms && /^(Left|Right)Arm$/.test(canonical)) {
      const parent = BABYLON.Quaternion.FromArray(parents.get(node).getWorldRotation());
      const delta = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, canonical === 'LeftArm' ? -1 : 1);
      node.setRotation(parent.conjugate().multiply(delta).multiply(parent)
        .multiply(BABYLON.Quaternion.FromArray(node.getRotation())).asArray());
    }
    node.setName(`${name || canonical}_${index++}`);
    names.set(canonical, node.getName());
  }
  for (const scene of doc.getRoot().listScenes()) {
    const children = scene.listChildren();
    const axis = doc.createNode('SourceAxisConversion').setRotation([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    for (const child of children) { scene.removeChild(child); axis.addChild(child); }
    scene.addChild(axis);
  }
  return { bytes: await io.writeBinary(doc), doc, names };
}

test('FBX one-indexed spine, leg/knee/toes and all finger markers resolve to their source joints', async () => {
  const { bytes, doc, names } = await fixture();
  const analysis = await analyzeGLB(bytes);
  assert.equal(analysis.health.coverage, 100);
  for (const [role, canonical] of Object.entries({
    spine_01: 'Spine', spine_02: 'Spine1', spine_03: 'Spine2',
    thigh_l: 'LeftUpLeg', calf_l: 'LeftLeg', toe_l: 'LeftToeBase',
    thigh_r: 'RightUpLeg', calf_r: 'RightLeg', toe_r: 'RightToeBase',
  })) assert.equal(analysis.mapping.entries.find(e => e.canonical === role).node, names.get(canonical));
  const guess = await guessJoints(bytes);
  assert.equal(Object.keys(guess.jointSources).length, 52);
  for (const [canonical, source] of Object.entries(guess.jointSources)) {
    assert.equal(source, names.get(canonical));
    const position = doc.getRoot().listNodes().find(n => n.getName() === source).getWorldTranslation();
    guess.joints[canonical].forEach((v, i) => approx(v, position[i]));
  }
  const report = {};
  const unchanged = await autoRigGLB(bytes, { joints: guess.joints, reportSink: report });
  assert.deepEqual(report.ignoredJoints, []);
  assert.equal(report.adjustedJoints, 0);
  assert.deepEqual(unchanged, bytes);
});

test('rebuilding keeps imported coincident origins but rejects newly collapsed limbs', async () => {
  const { bytes } = await fixture({ coincidentSpine: true });
  const guess = await guessJoints(bytes, { rebuild: true });
  const report = {};
  const output = await autoRigGLB(bytes, { rebuild: true, joints: guess.joints, reportSink: report });
  assert.equal(report.restValidation.passed, true);
  const rebuilt = await guessJoints(output);
  for (const name of ['Hips', 'Spine', 'LeftUpLeg', 'RightLeg', 'LeftHandIndex3']) {
    rebuilt.joints[name].forEach((v, i) => approx(v, guess.joints[name][i], 2e-5, name));
  }
  await assert.rejects(autoRigGLB(bytes, {
    rebuild: true, joints: { ...guess.joints, LeftLeg: guess.joints.LeftUpLeg },
  }), /LeftLeg.*overlaps/);
});

test('reversed and sideways FBX roots produce the same rest pose and animation as a forward character', async () => {
  const io = await createIO();
  const animations = await fs.readFile(new URL('../assets/animations.glb', import.meta.url));
  const merge = async yaw => io.readBinary(await mergeGLBs((await fixture({ yaw, relaxedArms: true })).bytes, animations,
    { removeExistingAnimations: true, COMPRESS_OUTPUT: false }));
  const baseline = await merge(0);
  const reference = new Map(baseline.getRoot().listNodes().map(n => [n.getName(), n]));
  const referenceClips = new Map(baseline.getRoot().listAnimations().map(clip => [clip.getName(), clip]));
  for (const yaw of [Math.PI, Math.PI / 2]) {
    const result = await merge(yaw);
    for (const node of result.getRoot().listNodes()) {
      // glTF skinning uses jointWorld × IBM; the skinned container's own
      // matrix cancels out in rendering. Compare its palette below instead.
      if (node.getSkin()) continue;
      const expected = reference.get(node.getName());
      assert.ok(expected, node.getName());
      node.getWorldMatrix().forEach((v, i) => approx(v, expected.getWorldMatrix()[i], 2e-5, node.getName()));
    }
    for (const skin of result.getRoot().listSkins()) {
      const expected = baseline.getRoot().listSkins().find(s => s.getName() === skin.getName());
      assert.deepEqual(skin.getInverseBindMatrices().getArray(), expected.getInverseBindMatrices().getArray());
    }
    for (const clip of result.getRoot().listAnimations()) {
      const expected = referenceClips.get(clip.getName());
      assert.equal(clip.listChannels().length, expected.listChannels().length);
      for (const channel of clip.listChannels()) {
        const path = channel.getTargetPath();
        const other = expected.listChannels().find(c => c.getTargetNode().getName() === channel.getTargetNode().getName() && c.getTargetPath() === path);
        assert.ok(other, `${clip.getName()} / ${channel.getTargetNode().getName()}`);
        const a = channel.getSampler().getOutput().getArray(), b = other.getSampler().getOutput().getArray();
        assert.equal(a.length, b.length);
        if (path === 'rotation') {
          for (let i = 0; i < a.length; i += 4) {
            const dot = a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
            approx(Math.abs(dot), 1, 2e-5, `${clip.getName()} rotation`);
          }
        } else a.forEach((v, i) => approx(v, b[i], 2e-5, `${clip.getName()} ${path}`));
      }
    }
  }
});

test('quarter-turn facing correction does not stretch a character with unequal X/Z scales', async () => {
  const io = await createIO();
  const { bytes } = await fixture({ yaw: Math.PI / 2 });
  const options = { SCALE_X: 2, SCALE_Z: 1, COMPRESS_OUTPUT: false, removeExistingAnimations: true };
  const baseline = await io.readBinary(await mergeGLBs(bytes, null, options));
  const result = await io.readBinary(await mergeGLBs(bytes,
    await fs.readFile(new URL('../assets/animations.glb', import.meta.url)), options));
  const reference = new Map(baseline.getRoot().listSkins()[0].listJoints().map(n => [n.getName(), n.getWorldMatrix()]));
  for (const node of result.getRoot().listSkins()[0].listJoints()) {
    node.getWorldMatrix().forEach((v, i) => approx(v, reference.get(node.getName())[i], 2e-5, node.getName()));
  }
});
