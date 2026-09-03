import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Document } from '@gltf-transform/core';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';
import { approx, createIO, parentMap } from './helpers.mjs';

const characterDir = new URL('../assets/characters_test/', import.meta.url);

for (const filename of ['gang.glb', 'medieval_character_sample.glb', 'prisioner_hostage.glb']) {
  test(`merge preserves rendered height for ${filename}`, async () => {
    const source = await fs.readFile(new URL(filename, characterDir));
    const before = await analyzeGLB(source);
    const output = await mergeGLBs(source, null, { COMPRESS_OUTPUT: false });
    const after = await analyzeGLB(output);
    const ratio = after.health.metrics.height / before.health.metrics.height;
    assert.ok(ratio > 0.995 && ratio < 1.005,
      `${filename}: height changed from ${before.health.metrics.height} to ${after.health.metrics.height}`);
  });
}

test('merge preserves rigid attachments below skeleton joints', async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const hips = doc.createNode('Hips');
  const hand = doc.createNode('LeftHand').setTranslation([0.5, 1, 0]);
  const prop = doc.createNode('SwordProp').setTranslation([0, 0.2, 0]);
  const positions = doc.createAccessor('positions').setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.5, 0]));
  const primitive = doc.createPrimitive().setAttribute('POSITION', positions);
  prop.setMesh(doc.createMesh('Sword').addPrimitive(primitive));
  hips.addChild(hand);
  hand.addChild(prop);
  scene.addChild(hips);

  const io = await createIO();
  const output = await mergeGLBs(await io.writeBinary(doc), null, { COMPRESS_OUTPUT: false });
  const result = await io.readBinary(output);
  const sword = result.getRoot().listNodes().find((node) => node.getName() === 'SwordProp');
  assert.equal(parentMap(result).get(sword)?.getName(), 'LeftHand');
});

test('merge preserves Z-up skin geometry when its armature supplies the Y-up rotation', async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const armature = doc.createNode('root').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  const hips = doc.createNode('Hips').setTranslation([0, 0, 1]);
  armature.addChild(hips);
  scene.addChild(armature);
  const positions = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([-0.3, 0, 0, 0.3, 0, 0, 0, 0.1, 2]));
  const ibm = doc.createAccessor().setType('MAT4').setBuffer(buffer)
    .setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1]));
  const skin = doc.createSkin().addJoint(hips).setSkeleton(hips).setInverseBindMatrices(ibm);
  const primitive = doc.createPrimitive().setAttribute('POSITION', positions)
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setBuffer(buffer).setArray(new Uint8Array(12)))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setBuffer(buffer)
      .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  scene.addChild(doc.createNode('Body').setMesh(doc.createMesh().addPrimitive(primitive)).setSkin(skin));
  const io = await createIO();
  const source = await io.writeBinary(doc);
  const output = await mergeGLBs(source, null, { COMPRESS_OUTPUT: false });
  const before = await analyzeGLB(source);
  const after = await analyzeGLB(output);
  assert.deepEqual(after.health.metrics.boundsSize, before.health.metrics.boundsSize);
  const result = await io.readBinary(output);
  assert.deepEqual([...result.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION').getArray()], [...positions.getArray()]);
  const actualHips = result.getRoot().listNodes().find(n => n.getName() === 'Hips');
  actualHips.getWorldMatrix().forEach((value, i) => approx(value, hips.getWorldMatrix()[i], 1e-5));
});

test('skinless meshes are not classified as Rigify from unrelated DEF prefixes', async () => {
  const source = await fs.readFile(new URL('../assets/female_character_simple.glb', import.meta.url));
  const analysis = await analyzeGLB(source);
  assert.notEqual(analysis.skeletonType.id, 'rigify');
});

test('real quadruped corpus uses quadruped health requirements', async () => {
  const source = await fs.readFile(new URL('../wolf.actor.glb', import.meta.url));
  const analysis = await analyzeGLB(source);
  assert.equal(analysis.bodyPlan, 'quadruped');
  assert.equal(analysis.skeletonType.id, 'quadruped');
  assert.equal(analysis.health.bodyPlan, 'quadruped');
  assert.equal(analysis.health.coverage, 100);
  assert.equal(analysis.health.missingBones.length, 0);
});

test('explicit canonical bone assignment overrides automatic retarget matching', async () => {
  const [character, animations, io] = await Promise.all([
    fs.readFile(new URL('prisioner_hostage.glb', characterDir)),
    fs.readFile(new URL('../assets/animations.glb', import.meta.url)),
    createIO(),
  ]);
  const analysis = await analyzeGLB(character);
  const left = analysis.mapping.entries.find(entry => entry.canonical === 'upperarm_l')?.node;
  const right = analysis.mapping.entries.find(entry => entry.canonical === 'upperarm_r')?.node;
  assert.ok(left && right && left !== right);

  const output = await mergeGLBs(character, animations, {
    COMPRESS_OUTPUT: false,
    removeExistingAnimations: true,
    boneMapOverrides: { upperarm_l: right },
  });
  const doc = await io.readBinary(output);
  const rotationTargets = doc.getRoot().listAnimations().flatMap(clip => clip.listChannels())
    .filter(channel => channel.getTargetPath() === 'rotation')
    .map(channel => channel.getTargetNode()?.getName());
  const outputRight = right.replace(/_\d+$/, '');
  const outputLeft = left.replace(/_\d+$/, '');
  assert.ok(rotationTargets.includes(outputRight));
  assert.equal(rotationTargets.includes(outputLeft), false);

  await assert.rejects(mergeGLBs(character, animations, {
    boneMapOverrides: { not_a_role: right },
  }), /Unknown canonical bone override/);
  await assert.rejects(mergeGLBs(character, animations, {
    boneMapOverrides: { upperarm_l: 'Missing_Node' },
  }), /does not exist/);
});
