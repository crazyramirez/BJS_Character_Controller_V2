import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Document } from '@gltf-transform/core';
import BABYLON from 'babylonjs';
import { inferNumberedHumanoid } from '../js/core/rig_topology.mjs';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';
import { createIO, approx } from './helpers.mjs';

// A small generated game-rig fixture: numeric IDs, split hip/pelvis, two spine
// segments, wrist helpers and a shared ring/pinky cup. No external model needed.
function fixture({ scale = 1, partialHand = false, named = false } = {}) {
  const doc = new Document(), scene = doc.createScene();
  const buffer = doc.createBuffer();
  const axis = doc.createNode('ExporterAxis').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  scene.addChild(axis);
  const root = doc.createNode('_rootJoint');
  axis.addChild(root);
  const skin = doc.createSkin().setSkeleton(root).addJoint(root);
  const roles = new Map();
  let index = 0;
  const add = (role, parent, position) => {
    // Deliberately scramble the IDs: numeric order conveys no anatomy.
    const id = (index++ * 47 + 113) % 997;
    const node = doc.createNode(named ? role : `${id}_${index}`);
    const wp = BABYLON.Vector3.FromArray(position.map(v => v * scale));
    const inverse = BABYLON.Matrix.FromArray(parent.getWorldMatrix()).invert();
    node.setTranslation(BABYLON.Vector3.TransformCoordinates(wp, inverse).asArray());
    node.setRotation(BABYLON.Quaternion.FromArray(parent.getWorldRotation()).conjugate().asArray());
    parent.addChild(node);
    skin.addJoint(node);
    roles.set(role, node);
    return node;
  };
  const hips = add('Hips', root, [0, 1, 0]);
  const spine = add('Spine', hips, [0, 1.05, 0]);
  const chest = add('Spine2', spine, [0, 1.24, 0]);
  const neck = add('Neck', chest, [0, 1.45, 0]);
  const head = add('Head', neck, [0, 1.55, 0]);
  for (let i = 0; i < 8; i++) add(`Face${i}`, head, [(i % 2 ? 1 : -1) * 0.025, 1.6 + i * 0.003, 0.06]);
  const pelvis = add('PelvisHelper', hips, [0, 1, 0]);
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const p = (x, y, z = 0) => [sign * x, y, z];
    const shoulder = add(side + 'Shoulder', chest, p(0.03, 1.38));
    const arm = add(side + 'Arm', shoulder, p(0.13, 1.4));
    const forearm = add(side + 'ForeArm', arm, p(0.38, 1.4));
    const hand = add(side + 'Hand', forearm, p(0.62, 1.4));
    add(side + 'ElbowHelper', forearm, p(0.62, 1.4));
    const palm = add(side + 'PalmHelper', hand, p(0.62, 1.4));
    const cup = add(side + 'CupHelper', palm, p(0.64, 1.398, -0.01));
    for (const [f, finger] of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].entries()) {
      let parent = f >= 3 ? cup : palm;
      for (let i = 1; i <= 3; i++) {
        if (partialHand && side === 'Left' && f === 4 && i === 3) continue;
        parent = add(`${side}Hand${finger}${i}`, parent, f === 0
          ? p([0.63, 0.68, 0.705][i - 1], 1.39, [0.017, 0.04, 0.04][i - 1])
          : p(0.70 + (i - 1) * 0.028, 1.407, 0.03 - (f - 1) * 0.02));
      }
    }
    const thigh = add(side + 'UpLeg', pelvis, p(0.075, 0.95));
    const shin = add(side + 'Leg', thigh, p(0.075, 0.55));
    add(side + 'Foot', shin, p(0.075, 0.1));
  }
  const ibms = new Float32Array(skin.listJoints().length * 16);
  skin.listJoints().forEach((node, i) => ibms.set(i === 0
    ? BABYLON.Matrix.Identity().asArray() // unused synthetic root with mismatching palette
    : BABYLON.Matrix.FromArray(node.getWorldMatrix()).invert().asArray(), i * 16));
  skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibms).setBuffer(buffer));
  const positions = [], indices = [], weights = [];
  for (const node of roles.values()) {
    const center = node.getWorldTranslation();
    for (const offset of [[-0.006, 0, 0], [0.006, 0, 0], [0, 0.01, 0.006]]) {
      positions.push(...center.map((v, i) => v + scale * offset[i]));
      indices.push(skin.listJoints().indexOf(node), 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
  }
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array(positions)))
    .setAttribute('JOINTS_0', accessor('VEC4', new Uint16Array(indices)))
    .setAttribute('WEIGHTS_0', accessor('VEC4', new Float32Array(weights)));
  const mesh = doc.createMesh('Body').addPrimitive(primitive);
  axis.addChild(doc.createNode('BodyMesh').setMesh(mesh).setSkin(skin));
  return { doc, roles, skin };
}

test('numbered humanoid recognition uses anatomy, including shared palm and wrist helpers', async () => {
  const io = await createIO();
  for (const scale of [0.01, 1, 100]) {
    const { doc, roles, skin } = fixture({ scale });
    const mapping = inferNumberedHumanoid(skin.listJoints().slice().reverse());
    assert.equal(mapping.size, 49);
    for (const [role, node] of mapping) assert.equal(node, roles.get(role), role);
    const analysis = await analyzeGLB(await io.writeBinary(doc));
    assert.equal(analysis.skeletonType.id, 'numbered-humanoid');
    assert.equal(analysis.mapping.entries.find(e => e.canonical === 'spine_02').node, null);
    assert.equal(analysis.mapping.entries.find(e => e.canonical === 'spine_03').node, roles.get('Spine2').getName());
    assert.equal(analysis.mapping.entries.find(e => e.canonical === 'hand_l').reason, 'humanoid-topology');
    approx(analysis.health.metrics.height, 1.531 * scale, 0.0011);
  }
});

test('incomplete hands, ambiguous arm poses, and named rigs do not trigger numeric fallback', () => {
  assert.equal(inferNumberedHumanoid(fixture({ partialHand: true }).skin.listJoints()).size, 0);
  assert.equal(inferNumberedHumanoid(fixture({ named: true }).skin.listJoints()).size, 0);
  const { skin, roles } = fixture();
  roles.get('LeftArm').setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  assert.equal(inferNumberedHumanoid(skin.listJoints()).size, 0);
});

test('source marker positions and unchanged apply preserve a numbered rig byte for byte', async () => {
  const io = await createIO(), { doc, roles } = fixture();
  const bytes = await io.writeBinary(doc), guess = await guessJoints(bytes);
  assert.equal(Object.keys(guess.jointSources).length, 49);
  for (const [role, source] of Object.entries(guess.jointSources)) {
    assert.equal(source, roles.get(role).getName());
    guess.joints[role].forEach((v, i) => approx(v, roles.get(role).getWorldTranslation()[i]));
  }
  assert.equal(guess.fingerDetection.Left.status, 'existing');
  assert.equal(guess.fingerDetection.Right.status, 'existing');
  const report = {};
  assert.deepEqual(await autoRigGLB(bytes, { joints: guess.joints, reportSink: report }), bytes);
  assert.equal(report.adjustedJoints, 0);
});

test('retargeting numbered rigs preserves rest palettes and maps each animation target once', async () => {
  const io = await createIO(), { doc, skin, roles } = fixture();
  const bytes = await io.writeBinary(doc);
  const output = await mergeGLBs(bytes, await fs.readFile(new URL('../assets/animations.glb', import.meta.url)), {
    COMPRESS_OUTPUT: false, removeExistingAnimations: true,
    boneMapOverrides: { hand_l: roles.get('LeftHand').getName() },
  });
  const merged = await io.readBinary(output);
  const mergedSkin = merged.getRoot().listSkins()[0];
  assert.ok(mergedSkin.listJoints().some(n => n.getName() === 'Spine1'));
  assert.equal((await analyzeGLB(output)).health.metrics.rootBoneCount, 1);
  const targets = new Map(merged.getRoot().listNodes().map(n => [n.getExtras().bjsSourceName || n.getName(), n]));
  const originalIBM = skin.getInverseBindMatrices().getArray();
  const mergedIBM = mergedSkin.getInverseBindMatrices().getArray();
  for (const [i, source] of skin.listJoints().entries()) {
    if (i === 0) continue;
    const target = targets.get(source.getName());
    assert.ok(target, source.getName());
    const j = mergedSkin.listJoints().indexOf(target);
    assert.ok(j >= 0);
    target.getWorldMatrix().forEach((v, k) => approx(v, source.getWorldMatrix()[k], 2e-5, target.getName()));
    assert.deepEqual(mergedIBM.slice(j * 16, j * 16 + 16), originalIBM.slice(i * 16, i * 16 + 16));
  }
  const before = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const after = merged.getRoot().listMeshes()[0].listPrimitives()[0];
  for (const semantic of ['POSITION', 'WEIGHTS_0']) assert.deepEqual(after.getAttribute(semantic).getArray(), before.getAttribute(semantic).getArray());
  const originalIndices = before.getAttribute('JOINTS_0').getArray();
  const resultIndices = after.getAttribute('JOINTS_0').getArray();
  for (let i = 0; i < originalIndices.length; i += 4) {
    assert.equal(mergedSkin.listJoints()[resultIndices[i]], targets.get(skin.listJoints()[originalIndices[i]].getName()));
  }
  assert.ok(merged.getRoot().listAnimations().length > 30);
  const animated = new Set();
  for (const clip of merged.getRoot().listAnimations()) {
    const seen = new Set();
    for (const channel of clip.listChannels()) {
      const name = channel.getTargetNode().getName(), path = channel.getTargetPath();
      const key = name + '/' + path;
      assert.ok(!seen.has(key), `${clip.getName()}: duplicate ${key}`);
      seen.add(key);
      animated.add(key);
      assert.ok([...channel.getSampler().getOutput().getArray()].every(Number.isFinite));
    }
  }
  for (const role of ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftArm', 'RightLeg', 'LeftHand', 'RightHandThumb3', 'LeftHandPinky1']) {
    assert.ok(animated.has(role + '/rotation'), role);
  }
  assert.ok(animated.has('Hips/translation'));
});
