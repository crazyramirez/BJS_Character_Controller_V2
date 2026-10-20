import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Document } from '@gltf-transform/core';
import { autoRigGLB, guessJoints, orientGLB, clearAutoRigCache, deformationStressTest } from '../js/core/autorig_api.mjs';
import { createIO } from './helpers.mjs';

const fixture = new URL('../assets/female_character_simple.glb', import.meta.url);
const STAGES = new Set(['select', 'orient', 'analyze', 'fingers', 'bind', 'weights', 'smooth', 'validate', 'deform-test', 'write']);

async function quietly(fn) {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
}

test('guess exposes per-joint confidence, review list, verdict and finger suggestion', async () => {
  const source = await fs.readFile(fixture);
  const g = await quietly(() => guessJoints(source));
  assert.equal(g.verdict, 'ok');
  assert.ok(g.confidence > 0.6 && g.confidence <= 1, `confidence ${g.confidence}`);
  assert.deepEqual(Object.keys(g.jointConfidence).sort(), Object.keys(g.joints).sort());
  for (const value of Object.values(g.jointConfidence)) assert.ok(value >= 0 && value <= 1);
  assert.deepEqual(g.reviewJoints, Object.keys(g.jointConfidence).filter(n => g.jointConfidence[n] < 0.5));
  assert.equal(g.suggestedBodyPlan, undefined);
  for (const side of ['Left', 'Right']) assert.equal(typeof g.fingerDetection[side].detectedCount, 'number');
  assert.equal(g.suggestedFingerCount, g.fingerDetection.Left.status === 'detected' && g.fingerDetection.Right.status === 'detected'
    ? g.fingerDetection.Left.detectedCount : null);
});

test('a featureless block is analyzed from proportions only and asks for review', async () => {
  const io = await createIO();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const p = [[-0.2, 0, -0.1], [0.2, 0, -0.1], [0.2, 0, 0.1], [-0.2, 0, 0.1], [-0.2, 1.8, -0.1], [0.2, 1.8, -0.1], [0.2, 1.8, 0.1], [-0.2, 1.8, 0.1]];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(p.flat())))
    .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint32Array(faces)));
  doc.createScene().addChild(doc.createNode('Block').setMesh(doc.createMesh('Block').addPrimitive(prim)));
  const guess = await quietly(async () => guessJoints(await io.writeBinary(doc), { fingerCount: 0 }));
  assert.equal(guess.diagnostics.method, 'bounds');
  assert.equal(guess.verdict, 'review');
  assert.ok(guess.reviewJoints.includes('Hips'));
  assert.ok(guess.reviewReasons.some(r => /landmarks/i.test(r)), guess.reviewReasons.join(' | '));
});

test('rig report carries verdict, confidence, review lists and the stress test', async () => {
  const source = await fs.readFile(fixture);
  const guess = await quietly(() => guessJoints(source));
  const report = {};
  await quietly(() => autoRigGLB(source, { joints: guess.joints, skinFingers: 'auto', reportSink: report }));
  assert.equal(report.verdict, 'ok');
  assert.ok(report.confidence > 0.6 && report.confidence <= 1);
  assert.deepEqual(report.reviewJoints, []);
  assert.ok(Array.isArray(report.reviewReasons));
  assert.ok(report.jointConfidence.Hips > 0.5 && report.jointConfidence.LeftHand > 0.5);
  const d = report.deformation;
  assert.ok(Array.isArray(d.poses) && d.poses.length >= 7, 'stress poses');
  for (const name of ['squat', 'armsUp', 'elbows', 'torsoTwist', 'headTurn', 'wristTwist']) assert.ok(d.poses.some(p => p.name === name), name);
  for (const region of ['LeftLeg', 'LeftArm', 'LeftForeArm', 'Spine1', 'Head', 'LeftHand']) {
    assert.ok(d.regions[region], region);
    assert.ok(d.regions[region].score >= 0 && d.regions[region].score <= 1 && Array.isArray(d.regions[region].issues));
  }
  assert.equal(typeof d.regions.LeftHand.candyWrapperLoss, 'number');
  assert.ok(d.worst && typeof d.worst.region === 'string');
  assert.ok(d.score > 0.8 && d.score <= 1, `mean region score ${d.score}`);
});

test('a hand marker dragged off the body is flagged for review', async () => {
  const source = await fs.readFile(fixture);
  const guess = await quietly(() => guessJoints(source, { fingerCount: 0 }));
  const H = guess.height;
  const joints = { ...guess.joints, LeftHand: guess.joints.LeftHand.map((v, i) => v + [0, 0, 0.25 * H][i]) };
  const report = {};
  await quietly(() => autoRigGLB(source, { joints, fingerCount: 0, reportSink: report }));
  assert.equal(report.verdict, 'review');
  assert.ok(report.reviewJoints.includes('LeftHand'), report.reviewJoints.join(','));
  assert.ok(report.reviewReasons.some(r => r.includes('LeftHand')), report.reviewReasons.join(' | '));
});

test('scrambled weights score worse in the stress poses than generated ones', async () => {
  const io = await createIO();
  const source = await fs.readFile(fixture);
  const guess = await quietly(() => guessJoints(source, { fingerCount: 0 }));
  const doc = await io.readBinary(await quietly(() => autoRigGLB(source, { joints: guess.joints, fingerCount: 0 })));
  const node = doc.getRoot().listNodes().find(n => n.getSkin());
  const skin = node.getSkin();
  const order = skin.listJoints().map(j => j.getName());
  const parent = j => doc.getRoot().listNodes().find(n => n.listChildren().includes(j))?.getName() || null;
  const options = { order, hierarchy: Object.fromEntries(skin.listJoints().map(j => [j.getName(), parent(j)])),
    joints: Object.fromEntries(skin.listJoints().map(j => [j.getName(), j.getWorldTranslation()])), height: guess.height };
  const parts = node.getMesh().listPrimitives().map(prim => ({ positions: prim.getAttribute('POSITION').getArray(),
    indices: prim.getIndices()?.getArray(), joints: prim.getAttribute('JOINTS_0').getArray(), weights: prim.getAttribute('WEIGHTS_0').getArray() }));
  const mean = r => { const s = Object.values(r.regions).map(x => x.score); return s.reduce((a, b) => a + b, 0) / s.length; };
  const clean = deformationStressTest({ parts, ...options });
  // Every 5th vertex follows a random bone.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const scrambled = parts.map(p => {
    const joints = p.joints.slice(), weights = p.weights.slice();
    for (let v = 0; v < joints.length / 4; v += 5) { joints[v * 4] = Math.floor(random() * order.length); weights.set([1, 0, 0, 0], v * 4); }
    return { ...p, joints, weights };
  });
  const bad = deformationStressTest({ parts: scrambled, ...options });
  assert.ok(mean(clean) > 0.85, `clean ${mean(clean)}`);
  assert.ok(mean(bad) < mean(clean) - 0.2, `scrambled ${mean(bad)} vs clean ${mean(clean)}`);
  assert.ok(Object.values(bad.regions).some(r => r.issues.length), 'issues reported');
});

test('a truncated voxel solid is reported and lowers confidence', async () => {
  const io = await createIO();
  const source = await fs.readFile(fixture);
  const doc = await io.readBinary(source);
  const mesh = doc.getRoot().listMeshes()[0];
  const body = mesh.listPrimitives()[0];
  const buffer = doc.getRoot().listBuffers()[0];
  // 4000 copies of a large torso triangle first in the mesh exhaust the
  // subdivision budget before the body itself is rasterized.
  const filler = doc.createPrimitive().setMaterial(body.getMaterial())
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([-0.15, 0.1, 0, 0.15, 0.1, 0, 0, 0.4, 0])))
    .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Uint32Array.from({ length: 4000 * 3 }, (_, i) => i % 3)));
  mesh.removePrimitive(body);
  mesh.addPrimitive(filler).addPrimitive(body);
  const truncated = await io.writeBinary(doc);
  const clean = {}, report = {};
  const guess = await quietly(() => guessJoints(source, { fingerCount: 0 }));
  await quietly(() => autoRigGLB(source, { joints: guess.joints, fingerCount: 0, reportSink: clean }));
  const truncatedGuess = await quietly(() => guessJoints(truncated, { fingerCount: 0 }));
  await quietly(() => autoRigGLB(truncated, { joints: truncatedGuess.joints, fingerCount: 0, reportSink: report }));
  assert.ok(report.notes.some(n => /Voxel budget reached/.test(n)), report.notes.join(' | '));
  assert.ok(report.notes.some(n => /Geodesic weighting disabled/.test(n)), report.notes.join(' | '));
  assert.equal(report.geodesicWeights, false);
  assert.ok(report.confidence < clean.confidence, `${report.confidence} vs ${clean.confidence}`);
  assert.ok(truncatedGuess.reviewReasons.some(r => /Voxel budget reached/.test(r)));
});

test('progress callbacks report known stages in order and never break a job', async () => {
  const source = await fs.readFile(fixture);
  for (const run of [
    onProgress => guessJoints(source, { fingerCount: 0, onProgress }),
    onProgress => autoRigGLB(source, { fingerCount: 0, onProgress }),
    onProgress => orientGLB(source, { onProgress }),
  ]) {
    clearAutoRigCache();
    const seen = [];
    await quietly(() => run((stage, fraction) => seen.push([stage, fraction])));
    assert.ok(seen.length >= 2, 'progress reported');
    for (const [stage, fraction] of seen) assert.ok(STAGES.has(stage) && fraction >= 0 && fraction <= 1, `${stage} ${fraction}`);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i][1] >= seen[i - 1][1], `monotonic at ${seen[i][0]}`);
    assert.equal(seen.at(-1)[1], 1);
    await quietly(() => run(() => { throw new Error('UI went away'); }));
  }
});

test('the analysis cache reuses guessJoints work without changing results', async () => {
  const source = await fs.readFile(fixture);
  clearAutoRigCache();
  const first = await quietly(() => guessJoints(source));
  const again = await quietly(() => guessJoints(source));
  assert.deepEqual(again, first);
  const hit = await quietly(() => autoRigGLB(source, { joints: first.joints, skinFingers: 'auto' }));
  clearAutoRigCache();
  const miss = await quietly(() => autoRigGLB(source, { joints: first.joints, skinFingers: 'auto' }));
  assert.ok(Buffer.from(hit).equals(Buffer.from(miss)), 'cached and fresh analyses rig identically');
});
