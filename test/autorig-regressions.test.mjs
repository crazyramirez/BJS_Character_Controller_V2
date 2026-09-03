import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Document } from '@gltf-transform/core';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
import BABYLON from 'babylonjs';
import { autoRigGLB, guessJoints } from '../js/core/autorig_api.mjs';
import { createIO, approx } from './helpers.mjs';

const identity = () => BABYLON.Matrix.Identity().asArray();
const inverse = matrix => BABYLON.Matrix.FromArray(matrix).invert().asArray();
const multiply = (a, b) => BABYLON.Matrix.FromArray(b).multiply(BABYLON.Matrix.FromArray(a)).asArray();

function palette(skin) {
  return skin.listJoints().map((joint, i) => multiply(joint.getWorldMatrix(),
    skin.getInverseBindMatrices()?.getElement(i, []) || identity()));
}

function assertMatrix(actual, expected, label) {
  actual.forEach((value, i) => approx(value, expected[i], 2e-5, `${label} [${i}]`));
}

function rigFixture({ scaled = false, helper = false, implicitIBM = false } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const armature = doc.createNode('Armature');
  if (scaled) armature.setScale([-2, 3, 0.5]).setRotation([0, 0, Math.sin(0.3), Math.cos(0.3)]);
  scene.addChild(armature);
  const hips = doc.createNode('Hips').setTranslation([0, 1, 0]);
  const arm = doc.createNode('LeftArm').setTranslation([0.3, 0.5, 0]);
  const forearm = doc.createNode('LeftForeArm').setTranslation([0.4, 0, 0]);
  armature.addChild(hips);
  hips.addChild(arm);
  if (helper) {
    const spacer = doc.createNode('ArmHelper').setTranslation([0.1, 0, 0])
      .setRotation([0, Math.sin(0.2), 0, Math.cos(0.2)]);
    arm.addChild(spacer);
    spacer.addChild(forearm);
  } else arm.addChild(forearm);
  const skin = doc.createSkin('BodySkin').setSkeleton(hips);
  [hips, arm, forearm].forEach(joint => skin.addJoint(joint));
  if (!implicitIBM) skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setBuffer(buffer)
    .setArray(new Float32Array(skin.listJoints().flatMap(joint => [...inverse(joint.getWorldMatrix())]))));
  const positions = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([-0.4, 0, 0, 0.4, 0, 0, 0, 2, 0.2]));
  const joints = doc.createAccessor().setType('VEC4').setBuffer(buffer)
    .setArray(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]));
  const weights = doc.createAccessor().setType('VEC4').setBuffer(buffer)
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const mesh = doc.createMesh('Body').addPrimitive(doc.createPrimitive()
    .setAttribute('POSITION', positions).setAttribute('JOINTS_0', joints).setAttribute('WEIGHTS_0', weights));
  scene.addChild(doc.createNode('Body').setMesh(mesh).setSkin(skin));
  return { doc, skin, hips, arm, forearm, positions };
}

function removeFixtureSkin(doc) {
  for (const node of doc.getRoot().listNodes()) node.setSkin(null);
  for (const skin of doc.getRoot().listSkins()) skin.dispose();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitive.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null);
    }
  }
}

for (const config of [{ scaled: true }, { helper: true }, { scaled: true, helper: true }, { implicitIBM: true }]) {
  test(`adjust rig preserves rendered geometry and reaches world-space markers: ${JSON.stringify(config)}`, async () => {
    const io = await createIO();
    const { doc, skin, arm, forearm } = rigFixture(config);
    const before = palette(skin);
    const armTarget = arm.getWorldTranslation().map((v, i) => v + [0.12, 0.08, -0.03][i]);
    const forearmTarget = forearm.getWorldTranslation().map((v, i) => v + [0.25, 0.17, 0.04][i]);
    const output = await autoRigGLB(await io.writeBinary(doc), {
      joints: { LeftArm: armTarget, LeftForeArm: forearmTarget },
    });
    const result = await io.readBinary(output);
    const after = result.getRoot().listSkins()[0];
    palette(after).forEach((matrix, i) => assertMatrix(matrix, before[i], `joint ${i} render palette`));
    for (const [name, target] of [['LeftArm', armTarget], ['LeftForeArm', forearmTarget]]) {
      const actual = result.getRoot().listNodes().find(node => node.getName() === name).getWorldTranslation();
      actual.forEach((v, i) => approx(v, target[i], 2e-5, `${name} axis ${i}`));
    }
  });
}

test('applying an unchanged rig preserves animation and exact bytes', async () => {
  const io = await createIO();
  const { doc, arm } = rigFixture({ scaled: true });
  const input = doc.createAccessor().setType('SCALAR').setBuffer(doc.getRoot().listBuffers()[0])
    .setArray(new Float32Array([0, 1]));
  const output = doc.createAccessor().setType('VEC3').setBuffer(doc.getRoot().listBuffers()[0])
    .setArray(new Float32Array([0.3, 0.5, 0, 0.4, 0.5, 0]));
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
  doc.createAnimation('KeepMe').addSampler(sampler).addChannel(doc.createAnimationChannel()
    .setTargetNode(arm).setTargetPath('translation').setSampler(sampler));
  const source = await io.writeBinary(doc);
  assert.deepEqual(await autoRigGLB(source, { joints: { LeftArm: arm.getWorldTranslation() } }), source);
});

test('unknown joint mappings fail rather than silently discarding an edit', async () => {
  const io = await createIO();
  const { doc } = rigFixture();
  await assert.rejects(autoRigGLB(await io.writeBinary(doc), { joints: { Head: [0, 2, 0] } }), /matching|mapped/i);
});

test('shared geometry across primitives is transformed once per owner', async () => {
  const io = await createIO();
  const { doc, positions } = rigFixture();
  for (const node of doc.getRoot().listNodes()) node.setSkin(null);
  for (const skin of doc.getRoot().listSkins()) skin.dispose();
  const body = doc.getRoot().listNodes().find(node => node.getMesh());
  const primitive = body.getMesh().listPrimitives()[0];
  primitive.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null);
  body.getMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions));
  body.setTranslation([5, 0, 0]);
  const source = await io.writeBinary(doc);
  const guessed = await guessJoints(source, { fingerCount: 0 });
  const result = await io.readBinary(await autoRigGLB(source, {
    joints: guessed.joints, fingerCount: 0, geodesicWeights: false,
  }));
  const mesh = result.getRoot().listNodes().find(node => node.getSkin()).getMesh();
  for (const prim of mesh.listPrimitives()) {
    const actual = prim.getAttribute('POSITION').getArray();
    positions.getArray().forEach((value, i) => approx(actual[i], value + (i % 3 === 0 ? 5 : 0), 1e-5));
  }
});

test('adjustment preserves each skin palette even when IBMs are shared', async () => {
  const io = await createIO();
  const { doc, skin, arm } = rigFixture();
  const otherRoot = doc.createNode('OtherRoot').setTranslation([3, 0, 0]);
  doc.getRoot().listScenes()[0].addChild(otherRoot);
  const otherSkin = doc.createSkin('OtherSkin').setInverseBindMatrices(skin.getInverseBindMatrices());
  for (const joint of skin.listJoints()) {
    const other = doc.createNode(`Other_${joint.getName()}`).setMatrix(joint.getWorldMatrix());
    otherRoot.addChild(other);
    otherSkin.addJoint(other);
  }
  const mesh = doc.getRoot().listMeshes()[0];
  doc.getRoot().listScenes()[0].addChild(doc.createNode('OtherBody').setMesh(mesh).setSkin(otherSkin));
  const before = palette(otherSkin);
  const out = await autoRigGLB(await io.writeBinary(doc), {
    joints: { LeftArm: arm.getWorldTranslation().map((v, i) => v + (i === 1 ? 0.1 : 0)) },
  });
  const result = await io.readBinary(out);
  palette(result.getRoot().listSkins().find(s => s.getName() === 'OtherSkin'))
    .forEach((matrix, i) => assertMatrix(matrix, before[i], `untouched skin ${i}`));
});

test('generating a skin preserves static children of transformed mesh nodes', async () => {
  const io = await createIO();
  const { doc } = rigFixture();
  for (const node of doc.getRoot().listNodes()) node.setSkin(null);
  for (const skin of doc.getRoot().listSkins()) skin.dispose();
  const body = doc.getRoot().listNodes().find(node => node.getMesh());
  body.setTranslation([4, 0, 0]);
  const child = doc.createNode('StaticChild').setTranslation([0, 2, 0]);
  body.addChild(child);
  const before = child.getWorldMatrix();
  const output = await autoRigGLB(await io.writeBinary(doc), { fingerCount: 0, geodesicWeights: false });
  const result = await io.readBinary(output);
  assertMatrix(result.getRoot().listNodes().find(node => node.getName() === 'StaticChild').getWorldMatrix(), before, 'child');
});

test('quantized mirrored geometry is decoded and retains front-facing triangles', async () => {
  const io = await createIO();
  const { doc, positions } = rigFixture();
  removeFixtureSkin(doc);
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  positions.setArray(new Int16Array([-16384, 0, 0, 16384, 0, 0, 0, 32767, 3277])).setNormalized(true);
  const expected = Array.from({ length: positions.getCount() }, (_, i) => positions.getElement(i, []));
  doc.getRoot().listNodes().find(node => node.getMesh()).setScale([-1, 2, 1]);
  const output = await autoRigGLB(await io.writeBinary(doc), { fingerCount: 0, geodesicWeights: false });
  const result = await io.readBinary(output);
  const primitive = result.getRoot().listNodes().find(node => node.getSkin()).getMesh().listPrimitives()[0];
  assert.equal(primitive.getAttribute('POSITION').getComponentType(), 5126);
  expected.forEach((position, i) => position.forEach((value, axis) => {
    approx(primitive.getAttribute('POSITION').getElement(i, [])[axis], value * [-1, 2, 1][axis], 1e-5);
  }));
  assert.deepEqual([...primitive.getIndices().getArray()], [0, 2, 1]);
});

test('rebuilding keeps excluded skinned meshes in their own render space', async () => {
  const io = await createIO();
  const { doc, skin } = rigFixture();
  const scene = doc.getRoot().listScenes()[0];
  const otherRoot = doc.createNode('AccessoryJoint').setTranslation([3, 0, 0]);
  scene.addChild(otherRoot);
  const otherSkin = doc.createSkin('AccessorySkin').addJoint(otherRoot)
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setBuffer(doc.getRoot().listBuffers()[0])
      .setArray(new Float32Array(identity())));
  const mesh = doc.createMesh('Accessory').copy(doc.getRoot().listMeshes()[0]).setName('Accessory');
  const accessory = doc.createNode('Accessory').setMesh(mesh).setSkin(otherSkin).setTranslation([10, 0, 0]);
  scene.addChild(accessory);
  const before = palette(otherSkin)[0];
  const bodyJoints = skin.listJoints();
  assert.ok(bodyJoints.length > 0);
  const source = await io.writeBinary(doc);
  const guess = await guessJoints(source, { fingerCount: 0, bodyMeshIds: ['mesh-1'] });
  const output = await autoRigGLB(source, {
    joints: guess.joints, fingerCount: 0, bodyMeshIds: ['mesh-1'], rebuild: true,
    geodesicWeights: false, attachProps: false,
  });
  const result = await io.readBinary(output);
  const kept = result.getRoot().listNodes().find(node => node.getName() === 'Accessory');
  assert.equal(kept.getSkin(), null);
  assertMatrix(kept.getWorldMatrix(), before, 'excluded mesh render space');
});

test('collapsed edits fail while existing coincident joints can still be opened', async () => {
  const io = await createIO();
  const { doc, arm, forearm } = rigFixture();
  await assert.rejects(autoRigGLB(await io.writeBinary(doc), {
    joints: { LeftForeArm: arm.getWorldTranslation() },
  }), /overlaps its parent/);
  forearm.setTranslation([0, 0, 0]);
  const guess = await guessJoints(await io.writeBinary(doc), { fingerCount: 0 });
  assert.deepEqual(guess.joints.LeftForeArm, guess.joints.LeftArm);
});

for (const filename of ['low_poly.glb', 'characters_test/prisioner_hostage.glb',
  'characters_test/medieval_character_sample.glb', 'characters_test/gang.glb',
  'characters_test/business_man.glb', 'characters_test/talking_male.glb']) {
  test(`existing rig round-trip and edited render palette: ${filename}`, async () => {
    const io = await createIO();
    const source = await fs.readFile(new URL(`../assets/${filename}`, import.meta.url));
    const guess = await guessJoints(source);
    const unchanged = await autoRigGLB(source, { joints: guess.joints });
    assert.ok(Buffer.from(unchanged).equals(source), 'unchanged markers preserve the original file');
    const before = await io.readBinary(source);
    const originalPalettes = before.getRoot().listSkins().map(palette);
    const joints = { ...guess.joints, LeftForeArm: guess.joints.LeftForeArm.map((v, i) => v + (i === 1 ? guess.height * 0.015 : 0)) };
    const result = await io.readBinary(await autoRigGLB(source, { joints }));
    result.getRoot().listSkins().forEach((skin, s) => palette(skin).forEach((matrix, j) => {
      // Large centimeter rigs amplify Float32 matrix cancellation; compare
      // absolute translation in model units and linear components separately.
      matrix.forEach((value, k) => approx(value, originalPalettes[s][j][k],
        k >= 12 && k < 15 ? Math.max(1, guess.height) * 2e-5 : 2e-5, `skin ${s}, joint ${j}, component ${k}`));
    }));
  });
}
