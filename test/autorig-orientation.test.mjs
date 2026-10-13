import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { autoRigGLB, guessJoints, orientGLB } from '../js/core/autorig_api.mjs';
import { createIO } from './helpers.mjs';

// Skinless reference body: Y-up, arms along X, facing +Z.
const fixture = new URL('../assets/female_character_simple.glb', import.meta.url);

// Same mesh turned about Y, the way generators (Tripo, Meshy) and scans ship
// characters facing ±X or an arbitrary yaw.
async function turned(degrees) {
  const io = await createIO();
  const doc = await io.readBinary(await fs.readFile(fixture));
  const a = degrees * Math.PI / 180;
  const turn = doc.createNode('Turn').setRotation([0, Math.sin(a / 2), 0, Math.cos(a / 2)]);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const child of scene.listChildren()) { scene.removeChild(child); turn.addChild(child); }
  scene.addChild(turn);
  return io.writeBinary(doc);
}

function rotateY([x, y, z], degrees) {
  const a = degrees * Math.PI / 180;
  return [Math.cos(a) * x + Math.sin(a) * z, y, -Math.sin(a) * x + Math.cos(a) * z];
}

test('markers follow a body turned to face ±X or an arbitrary yaw', async () => {
  const reference = await guessJoints(await fs.readFile(fixture), { fingerCount: 0 });
  assert.equal(reference.orientation.applied, false, 'a +Z body is left untouched');
  const H = reference.height;
  for (const [degrees, facing] of [[90, '+X'], [-90, '-X'], [35, null]]) {
    const guess = await guessJoints(await turned(degrees), { fingerCount: 0 });
    assert.equal(guess.orientation.applied, true, `${degrees}°: facing corrected`);
    if (facing) assert.equal(guess.orientation.facing, facing);
    assert.ok(Math.abs(guess.orientation.yawDegrees + degrees) < 1.5, `${degrees}°: yaw ${guess.orientation.yawDegrees}`);
    let worst = 0, worstName = '';
    for (const [name, p] of Object.entries(reference.joints)) {
      const expected = rotateY(p, degrees);
      const error = Math.hypot(...guess.joints[name].map((v, i) => v - expected[i])) / H;
      if (error > worst) { worst = error; worstName = name; }
    }
    assert.ok(worst < 0.03, `${degrees}°: ${worstName} off by ${(worst * 100).toFixed(1)}% of height`);
  }
});

// Same mesh under an arbitrary root rotation (axis-angle, degrees).
async function rotated(axis, degrees) {
  const io = await createIO();
  const doc = await io.readBinary(await fs.readFile(fixture));
  const a = degrees * Math.PI / 360;
  const turn = doc.createNode('Turn').setRotation([axis[0] * Math.sin(a), axis[1] * Math.sin(a), axis[2] * Math.sin(a), Math.cos(a)]);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const child of scene.listChildren()) { scene.removeChild(child); turn.addChild(child); }
  scene.addChild(turn);
  return { buffer: await io.writeBinary(doc), rotate: p => {
    const [x, y, z, w] = turn.getRotation();
    const m = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
    return m.map(r => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  } };
}

test('bodies lying on their back, front or side, or upside down, are stood up', async () => {
  const reference = await guessJoints(await fs.readFile(fixture), { fingerCount: 0 });
  for (const [axis, degrees, up] of [[[1, 0, 0], 90, '+Z'], [[1, 0, 0], -90, '-Z'], [[0, 0, 1], -90, '+X'], [[1, 0, 0], 180, '-Y']]) {
    const { buffer, rotate } = await rotated(axis, degrees);
    const guess = await guessJoints(buffer, { fingerCount: 0 });
    assert.equal(guess.orientation.applied, true, `${up}: orientation corrected`);
    assert.equal(guess.orientation.upAxis, up);
    for (const [name, p] of Object.entries(reference.joints)) {
      const expected = rotate(p);
      const error = Math.hypot(...guess.joints[name].map((v, i) => v - expected[i])) / reference.height;
      assert.ok(error < 0.01, `${up}: ${name} off by ${(error * 100).toFixed(2)}% of height`);
    }
  }
});

test('a body facing -Z keeps its existing handling', async () => {
  const guess = await guessJoints(await turned(180), { fingerCount: 0 });
  assert.equal(guess.orientation.applied, false);
});

test('a turned body is rigged facing +Z with anatomical sides intact', async () => {
  const io = await createIO();
  const source = await turned(90);
  const guess = await guessJoints(source, { fingerCount: 0 });
  const report = {};
  const output = await io.readBinary(await autoRigGLB(source, {
    joints: guess.joints, fingerCount: 0, geodesicWeights: false, reportSink: report,
  }));
  assert.equal(report.orientation.applied, true);
  const world = name => output.getRoot().listNodes().find(n => n.getName() === name).getWorldTranslation();
  // Facing +Z: the character's left is +X and the toes point to +Z.
  assert.ok(world('LeftArm')[0] - world('RightArm')[0] > 0.1 * guess.height, 'left arm on +X');
  assert.ok(world('LeftToeBase')[2] > world('LeftFoot')[2], 'toes forward (+Z)');
  assert.ok(Math.abs(world('LeftArm')[2] - world('RightArm')[2]) < 0.03 * guess.height, 'arms span X, not Z');
});

test('import pre-flight stands meshes up facing +Z with the feet on the ground at the origin', async () => {
  // The fixture faces +Z but its origin is mid-body: only the placement changes.
  const placed = await orientGLB(await fs.readFile(fixture));
  assert.equal(placed.orientation.applied, false);
  assert.equal(placed.placement.applied, true);
  assert.equal((await orientGLB(placed.buffer)).buffer, null, 'placement is idempotent');
  const reference = await guessJoints(placed.buffer, { fingerCount: 0 });
  const H = reference.height;
  assert.ok(Math.abs(reference.bounds.min[1]) < 1e-3 * H, 'feet on y = 0');
  assert.ok(Math.abs(reference.joints.Hips[0]) < 0.01 * H && Math.abs(reference.joints.Hips[2]) < 0.05 * H, 'body over the origin');
  for (const side of ['Left', 'Right']) assert.ok(reference.joints[`${side}Foot`][1] > 0 && reference.joints[`${side}Foot`][1] < 0.1 * H);

  // A turned, lying or off-centre export ends up in the same place.
  for (const source of [await turned(-90), (await rotated([1, 0, 0], 90)).buffer]) {
    const result = await orientGLB(source);
    assert.ok(result.buffer && result.orientation.applied, 'rewritten upright');
    const again = await guessJoints(result.buffer, { fingerCount: 0 });
    assert.equal(again.orientation.applied, false, 'output is canonical');
    for (const name of ['Hips', 'Head', 'LeftHand', 'RightFoot']) {
      const error = Math.hypot(...again.joints[name].map((v, i) => v - reference.joints[name][i])) / H;
      assert.ok(error < 0.01, `${name} off by ${(error * 100).toFixed(2)}%`);
    }
  }
});
