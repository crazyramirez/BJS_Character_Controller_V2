/**
 * Auto-rig API tests — Iteration 1: humanoid validation + confidence scoring.
 *
 * Run with: node --test test/autorig.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');

function load(file) {
  return readFileSync(join(assetsDir, file));
}

async function inspectRig(buffer) {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });
  const doc = await io.readBinary(new Uint8Array(buffer));
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const jointWorld = {};
  const jointIndex = {};
  joints.forEach((j, i) => {
    jointWorld[j.getName()] = j.getWorldTranslation();
    jointIndex[j.getName()] = i;
  });
  const meshes = doc.getRoot().listMeshes();
  const prims = [];
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const jnts = prim.getAttribute('JOINTS_0');
      const wghts = prim.getAttribute('WEIGHTS_0');
      if (!pos || !jnts || !wghts) continue;
      const p = pos.getArray();
      const j = jnts.getArray();
      const w = wghts.getArray();
      prims.push({ positions: p, joints: j, weights: w, count: pos.getCount() });
    }
  }
  // Approximate character height from the rigged mesh bounding box.
  let minY = Infinity, maxY = -Infinity;
  for (const prim of prims) {
    for (let v = 0; v < prim.count; v++) {
      const y = prim.positions[v * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const height = maxY - minY;
  return { prims, jointWorld, jointIndex, height };
}

describe('guessJoints humanoid validation', () => {
  it('detects a standard humanoid character as humanoid with high confidence', async () => {
    const result = await guessJoints(load('character_animated_1.glb'));
    assert.strictEqual(result.humanoid, true, 'expected humanoid=true');
    assert.ok(result.score >= 70, `expected score >= 70, got ${result.score}`);
    assert.ok(result.fwdCertainty >= 0.5, `expected fwd certainty >= 0.5, got ${result.fwdCertainty}`);
    assert.ok(result.joints.Hips, 'expected Hips joint');
    assert.ok(result.joints.LeftHand, 'expected LeftHand joint');
    assert.ok(result.joints.RightFoot, 'expected RightFoot joint');
  });

  it('detects a low-poly humanoid character as humanoid', async () => {
    const result = await guessJoints(load('low_poly.glb'));
    assert.strictEqual(result.humanoid, true, 'expected humanoid=true');
    assert.ok(result.score >= 60, `expected score >= 60, got ${result.score}`);
  });

  it('rejects a simple cube as non-humanoid', async () => {
    const cube = readFileSync(join(__dirname, '..', 'scratch', 'test_cube.glb'));
    const result = await guessJoints(cube);
    assert.strictEqual(result.humanoid, false, 'expected humanoid=false for cube');
    assert.ok(result.score < 50, `expected score < 50 for cube, got ${result.score}`);
  });

  it('reports scale unit for meter-sized characters', async () => {
    const result = await guessJoints(load('character_animated_1.glb'));
    assert.strictEqual(result.scaleInfo.unit, 'm');
    assert.ok(result.scaleInfo.height >= 1.5 && result.scaleInfo.height <= 2.2,
      `expected height ~1.5-2.2m, got ${result.scaleInfo.height}`);
  });
});

describe('autoRigGLB skin weights', () => {
  it('produces normalized weights that sum to 1 on every vertex', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims } = await inspectRig(buffer);
    assert.ok(prims.length > 0, 'expected at least one skinned primitive');
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += prim.weights[v * 4 + k];
        assert.ok(Math.abs(sum - 1) < 1e-3, `vertex ${v} weights sum to ${sum}`);
      }
    }
  });

  it('assigns dominant Head weight to the upper skull', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex, height } = await inspectRig(buffer);
    const head = jointWorld.Head;
    const H = height;
    const headBone = jointIndex.Head;
    const headY = head[1];
    let checked = 0;
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        const x = prim.positions[v * 3];
        const y = prim.positions[v * 3 + 1];
        const z = prim.positions[v * 3 + 2];
        const dHead = Math.hypot(x - head[0], y - head[1], z - head[2]);
        if (y < headY + 0.02 * H || dHead > 0.15 * H) continue;
        let headW = 0;
        for (let k = 0; k < 4; k++) {
          if (prim.joints[v * 4 + k] === headBone) headW += prim.weights[v * 4 + k];
        }
        assert.ok(headW >= 0.70, `upper skull vertex at y=${y} has Head weight ${headW}`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'expected upper skull vertices to check');
  });

  it('assigns dominant Hand weight to hand vertices', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex, height } = await inspectRig(buffer);
    const lHand = jointWorld.LeftHand;
    const rHand = jointWorld.RightHand;
    const H = height;
    const leftHandBone = jointIndex.LeftHand;
    const rightHandBone = jointIndex.RightHand;
    let checked = 0;
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        const x = prim.positions[v * 3];
        const y = prim.positions[v * 3 + 1];
        const z = prim.positions[v * 3 + 2];
        const dL = Math.hypot(x - lHand[0], y - lHand[1], z - lHand[2]);
        const dR = Math.hypot(x - rHand[0], y - rHand[1], z - rHand[2]);
        if (Math.min(dL, dR) > 0.03 * H) continue;
        const targetBone = dL < dR ? leftHandBone : rightHandBone;
        let handW = 0;
        for (let k = 0; k < 4; k++) {
          if (prim.joints[v * 4 + k] === targetBone) handW += prim.weights[v * 4 + k];
        }
        assert.ok(handW >= 0.50, `hand vertex has hand bone weight ${handW}`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'expected hand vertices to check');
  });

  it('keeps LeftArm influence low on the right side of the body', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex } = await inspectRig(buffer);
    const centerX = jointWorld.Hips[0];
    const leftArmBone = jointIndex.LeftArm;
    let checked = 0;
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        const x = prim.positions[v * 3];
        if (x >= centerX - 0.02) continue; // only right side
        let leftArmW = 0;
        for (let k = 0; k < 4; k++) {
          if (prim.joints[v * 4 + k] === leftArmBone) leftArmW += prim.weights[v * 4 + k];
        }
        assert.ok(leftArmW < 0.15, `right-side vertex has LeftArm weight ${leftArmW}`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'expected right-side vertices to check');
  });

  it('creates the full set of Mixamo-style finger joints', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { jointWorld, jointIndex } = await inspectRig(buffer);
    for (const side of ['Left', 'Right']) {
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
        for (let i = 1; i <= 3; i++) {
          const name = `${side}Hand${finger}${i}`;
          assert.ok(jointIndex[name] != null, `expected ${name}`);
          const p = jointWorld[name];
          assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]), `${name} has finite position`);
        }
      }
    }
    // Fingers should extend away from the hand: distal joint is farther from
    // the wrist than the proximal joint.
    const hand = jointWorld.LeftHand;
    const prox = jointWorld.LeftHandIndex1;
    const dist = jointWorld.LeftHandIndex3;
    const dProx = Math.hypot(prox[0] - hand[0], prox[1] - hand[1], prox[2] - hand[2]);
    const dDist = Math.hypot(dist[0] - hand[0], dist[1] - hand[1], dist[2] - hand[2]);
    assert.ok(dDist > dProx, 'expected index fingertip to be farther from hand than knuckle');
  });

  it('creates twist bones and assigns them weight in the limb mid-section', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex } = await inspectRig(buffer);
    for (const name of ['LeftArmTwist', 'LeftForeArmTwist', 'RightArmTwist', 'RightForeArmTwist',
                         'LeftUpLegTwist', 'LeftLegTwist', 'RightUpLegTwist', 'RightLegTwist']) {
      assert.ok(jointIndex[name] != null, `expected ${name}`);
      const p = jointWorld[name];
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]), `${name} has finite position`);
    }

    // Check that some vertices around the middle of the left upper arm carry
    // LeftArmTwist weight.
    const arm = jointWorld.LeftArm;
    const forearm = jointWorld.LeftForeArm;
    const mid = [
      (arm[0] + forearm[0]) * 0.5,
      (arm[1] + forearm[1]) * 0.5,
      (arm[2] + forearm[2]) * 0.5,
    ];
    const H = jointWorld.Head[1] * 1.15;
    const twistIdx = jointIndex.LeftArmTwist;
    let checked = 0, good = 0;
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        const p = [prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]];
        const d = Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]);
        if (d > 0.04 * H) continue;
        let w = 0;
        for (let k = 0; k < 4; k++) {
          if (prim.joints[v * 4 + k] === twistIdx) w += prim.weights[v * 4 + k];
        }
        checked++;
        if (w >= 0.15) good++;
      }
    }
    assert.ok(checked > 0, 'expected mid-upper-arm vertices to check');
    assert.ok(good >= checked * 0.3, `only ${good}/${checked} mid-upper-arm vertices have meaningful LeftArmTwist weight`);
  });
});
