import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { normalizeConvertedGLB } from '../js/core/fbx_api.mjs';
import { approx, createIO, parentMap } from './helpers.mjs';

test('FBX RootNode flattening composes translation, rotation and scale', async () => {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('Scene');
  const half = Math.sin(Math.PI / 4);
  const root = doc.createNode('RootNode')
    .setTranslation([10, 20, 30])
    .setRotation([0, 0, half, half])
    .setScale([2, 3, 4]);
  const child = doc.createNode('Hips')
    .setTranslation([1, 2, 3])
    .setScale([5, 6, 7]);
  root.addChild(child);
  scene.addChild(root);

  const io = await createIO();
  const output = await normalizeConvertedGLB(await io.writeBinary(doc));
  const result = await io.readBinary(output);
  const hips = result.getRoot().listNodes().find((node) => node.getName() === 'Hips');
  assert.equal(parentMap(result).has(hips), false);
  const translation = hips.getTranslation();
  // parentTranslation + parentRotation * (parentScale * childTranslation)
  approx(translation[0], 4);
  approx(translation[1], 22);
  approx(translation[2], 42);
  assert.deepEqual(hips.getScale().map((value) => Math.round(value)), [10, 18, 28]);
});

test('FBX normalization preserves authored material factors by default', async () => {
  const doc = new Document();
  doc.createBuffer();
  doc.createScene('Scene').addChild(doc.createNode('RootNode'));
  doc.createMaterial('Metal').setMetallicFactor(0.8).setRoughnessFactor(0.2);
  const io = await createIO();
  const output = await normalizeConvertedGLB(await io.writeBinary(doc));
  const material = (await io.readBinary(output)).getRoot().listMaterials()[0];
  approx(material.getMetallicFactor(), 0.8);
  approx(material.getRoughnessFactor(), 0.2);
});
