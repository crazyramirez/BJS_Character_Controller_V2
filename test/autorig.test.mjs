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
import { guessJoints, autoRigGLB, guessJointsAuto } from '../js/core/autorig_api.mjs';

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

  it('rejects an anatomically insane topology skeleton and falls back to slicing', async () => {
    const mockSliced = {
      method: 'slicing',
      height: 1.8,
      joints: {
        Head: [0, 1.8, 0],
        Neck: [0, 1.6, 0],
        Spine2: [0, 1.4, 0],
        Spine1: [0, 1.2, 0],
        Spine: [0, 1.0, 0],
        Hips: [0, 0.9, 0],
        LeftUpLeg: [0.1, 0.8, 0],
        LeftLeg: [0.1, 0.4, 0],
        LeftFoot: [0.1, 0.05, 0],
        RightUpLeg: [-0.1, 0.8, 0],
        RightLeg: [-0.1, 0.4, 0],
        RightFoot: [-0.1, 0.05, 0]
      }
    };
    const mockInsaneTopo = {
      confidence: 0.9,
      joints: {
        Hips: [0, 1.5, 0],
        Spine: [0, 1.4, 0],
        Spine1: [0, 1.3, 0],
        Spine2: [0, 1.2, 0],
        Neck: [0, 1.1, 0],
        Head: [0, 1.0, 0], // Inverted! Head is below Neck and Hips
        LeftUpLeg: [0.1, 0.8, 0],
        LeftLeg: [0.1, 0.4, 0],
        LeftFoot: [0.1, 0.05, 0],
        RightUpLeg: [-0.1, 0.8, 0],
        RightLeg: [-0.1, 0.4, 0],
        RightFoot: [-0.1, 0.05, 0]
      }
    };

    const result = guessJointsAuto(
      null,
      null,
      { min: [-0.5, 0, -0.5], max: [0.5, 1.8, 0.5] },
      1,
      null,
      {
        verts: [],
        sliced: mockSliced,
        topo: mockInsaneTopo
      }
    );

    assert.strictEqual(result.method, 'slicing');
    assert.deepStrictEqual(result.joints, mockSliced.joints);
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

  it('assigns dominant Hand-chain weight to hand vertices', async () => {
    // Radius 0.02·H, not 0.03·H: at 0.03·H the band reaches ~15% up the distal
    // forearm, where even the reference artist rig gives ForeArm dominance
    // (fore t=0.90 is ForeArm 65% / Hand 34% on the Mixamo reference). The old
    // 0.03·H expectation only passed because the hand rigid zone incorrectly
    // swallowed half the forearm — the exact "forearm moves as a rigid stick"
    // defect this suite now guards against. Weight is counted for the whole
    // hand CHAIN (Hand + finger bones): palm vertices legitimately split
    // between Hand and finger roots.
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex, height } = await inspectRig(buffer);
    const lHand = jointWorld.LeftHand;
    const rHand = jointWorld.RightHand;
    const H = height;
    const handChain = { Left: new Set(), Right: new Set() };
    for (const [name, idx] of Object.entries(jointIndex)) {
      for (const side of ['Left', 'Right']) {
        if (name === side + 'Hand' || name.startsWith(side + 'Hand')) handChain[side].add(idx);
      }
    }
    let checked = 0;
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        const x = prim.positions[v * 3];
        const y = prim.positions[v * 3 + 1];
        const z = prim.positions[v * 3 + 2];
        const dL = Math.hypot(x - lHand[0], y - lHand[1], z - lHand[2]);
        const dR = Math.hypot(x - rHand[0], y - rHand[1], z - rHand[2]);
        if (Math.min(dL, dR) > 0.02 * H) continue;
        const chain = handChain[dL < dR ? 'Left' : 'Right'];
        let handW = 0;
        for (let k = 0; k < 4; k++) {
          if (chain.has(prim.joints[v * 4 + k])) handW += prim.weights[v * 4 + k];
        }
        assert.ok(handW >= 0.50, `hand vertex has hand-chain weight ${handW}`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'expected hand vertices to check');
  });

  it('keeps biceps and forearm owned by their own bone family (no shoulder/hand bleed)', async () => {
    // Regression: mid-biceps vertices were 21–26% LeftShoulder (clavicle's big
    // collar radius pinned sources down the arm) and mid-forearm vertices were
    // 49–83% LeftHand (hand rigid zone compared against the elbow joint only).
    // Both anchored the limb to near-static/wrong bones → arms visibly
    // squashed at the biceps and the forearm moved as a rigid stick with the
    // wrist. Reference artist rig: mid-biceps 100% Arm, mid-forearm ~100%
    // ForeArm (twist bones count toward their parent's family).
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex, height } = await inspectRig(buffer);
    const H = height;
    const family = (side, names) => new Set(names.map(n => jointIndex[side + n]).filter(i => i != null));
    const stationCheck = (P0, P1, t, own, foreign, minOwn, maxForeign, label) => {
      const C = [P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t, P0[2] + (P1[2] - P0[2]) * t];
      const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]);
      let ownW = 0, foreignW = 0, n = 0;
      for (const prim of prims) {
        for (let v = 0; v < prim.count; v++) {
          const dx = prim.positions[v * 3] - C[0];
          const dy = prim.positions[v * 3 + 1] - C[1];
          const dz = prim.positions[v * 3 + 2] - C[2];
          if (dx * dx + dy * dy + dz * dz > (0.18 * L) * (0.18 * L)) continue;
          n++;
          for (let k = 0; k < 4; k++) {
            const b = prim.joints[v * 4 + k], w = prim.weights[v * 4 + k];
            if (own.has(b)) ownW += w;
            else if (foreign.has(b)) foreignW += w;
          }
        }
      }
      assert.ok(n > 0, `${label}: no vertices sampled`);
      ownW /= n; foreignW /= n;
      assert.ok(ownW >= minOwn, `${label}: own-family weight ${ownW.toFixed(2)} < ${minOwn}`);
      assert.ok(foreignW <= maxForeign, `${label}: foreign weight ${foreignW.toFixed(2)} > ${maxForeign}`);
    };
    for (const side of ['Left', 'Right']) {
      const arm = jointWorld[side + 'Arm'], fore = jointWorld[side + 'ForeArm'], hand = jointWorld[side + 'Hand'];
      const armFam = family(side, ['Arm', 'ArmTwist']);
      const foreFam = family(side, ['ForeArm', 'ForeArmTwist']);
      const shoulder = family(side, ['Shoulder']);
      const handSet = family(side, ['Hand']);
      // Mid-biceps: own ≥ 0.85, Shoulder ≤ 0.05
      stationCheck(arm, fore, 0.55, armFam, shoulder, 0.85, 0.05, `${side} mid-biceps`);
      // Mid-forearm: own ≥ 0.85, Hand ≤ 0.10
      stationCheck(fore, hand, 0.45, foreFam, handSet, 0.85, 0.10, `${side} mid-forearm`);
    }
  });

  it('keeps the upper thigh / buttock owned by the leg, not the spine', async () => {
    // Regression: the buttock / upper-thigh mass just above the hip socket was
    // ~32% Spine (the lower-spine heat source bled down across the continuous
    // pelvis mesh) while the artist rig keeps it ~95% Hips/UpLeg — the thigh
    // visibly stretched away from the pelvis on any hip motion. The pelvis band
    // must belong to Hips+leg, with negligible Spine influence.
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex, height } = await inspectRig(buffer);
    const H = height;
    for (const side of ['Left', 'Right']) {
      const up = jointWorld[side + 'UpLeg'], leg = jointWorld[side + 'Leg'];
      const legFam = new Set([jointIndex[side + 'UpLeg'], jointIndex[side + 'UpLegTwist']].filter(i => i != null));
      const hipsIdx = jointIndex.Hips;
      const spineFam = new Set(['Spine', 'Spine1', 'Spine2'].map(n => jointIndex[n]).filter(i => i != null));
      // Station just ABOVE the hip socket (t=-0.15 along UpLeg→Leg): the buttock.
      const t = -0.15;
      const C = [up[0] + (leg[0] - up[0]) * t, up[1] + (leg[1] - up[1]) * t, up[2] + (leg[2] - up[2]) * t];
      let pelvisW = 0, spineW = 0, n = 0;
      for (const prim of prims) {
        for (let v = 0; v < prim.count; v++) {
          const dx = prim.positions[v * 3] - C[0], dy = prim.positions[v * 3 + 1] - C[1], dz = prim.positions[v * 3 + 2] - C[2];
          if (dx * dx + dy * dy + dz * dz > (0.05 * H) * (0.05 * H)) continue;
          n++;
          for (let k = 0; k < 4; k++) {
            const b = prim.joints[v * 4 + k], w = prim.weights[v * 4 + k];
            if (b === hipsIdx || legFam.has(b)) pelvisW += w;
            else if (spineFam.has(b)) spineW += w;
          }
        }
      }
      if (n === 0) continue; // some meshes have no verts sampled there
      spineW /= n; pelvisW /= n;
      // Pre-fix this band was ~32% Spine / ~63% pelvis; guard the corrected
      // regime with margin (Spine ≤ 0.20, pelvis ≥ 0.65).
      assert.ok(spineW <= 0.20, `${side} buttock: Spine weight ${spineW.toFixed(2)} > 0.20`);
      assert.ok(pelvisW >= 0.65, `${side} buttock: Hips+leg weight ${pelvisW.toFixed(2)} < 0.65`);
    }
  });

  it('gives finger geometry real weight on its own phalanges (hand can curl)', async () => {
    // Regression: the Hand rigid zone was a flat 0.06·H sphere around the wrist,
    // swallowing the whole palm+digits into Hand at ~1.0 and starving every
    // finger bone (~9% each). A fist-closing idle then barely curled the
    // fingers. Each finger's own geometry must carry dominant finger-chain
    // weight so animated curls read on the mesh.
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex, height } = await inspectRig(buffer);
    const H = height;
    // All finger-chain bone indices (any finger), and the two Hand indices.
    const allFingerBones = new Set();
    for (const [name, idx] of Object.entries(jointIndex)) {
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)\d+$/.test(name)) allFingerBones.add(idx);
    }
    let fingersChecked = 0;
    for (const side of ['Left', 'Right']) {
      const handIdx = jointIndex[side + 'Hand'];
      for (const finger of ['Index', 'Middle', 'Ring', 'Pinky']) {
        // Sample around the middle phalanx (joint 2) — clearly finger, not palm.
        const j2 = jointWorld[`${side}Hand${finger}2`];
        if (!j2) continue;
        // What must be true for a readable curl: the FINGER bones (any finger,
        // since a mid phalanx shares with its immediate neighbours) dominate
        // this geometry, and the near-static Hand/wrist does NOT. Pre-fix Hand
        // was ~55% here and the finger chain ~9%.
        let fingerW = 0, handW = 0, n = 0;
        for (const prim of prims) {
          for (let v = 0; v < prim.count; v++) {
            const dx = prim.positions[v * 3] - j2[0], dy = prim.positions[v * 3 + 1] - j2[1], dz = prim.positions[v * 3 + 2] - j2[2];
            if (dx * dx + dy * dy + dz * dz > (0.02 * H) * (0.02 * H)) continue;
            n++;
            for (let k = 0; k < 4; k++) {
              const b = prim.joints[v * 4 + k], w = prim.weights[v * 4 + k];
              if (allFingerBones.has(b)) fingerW += w;
              else if (b === handIdx) handW += w;
            }
          }
        }
        if (n < 3) continue; // low-poly finger: skip
        fingerW /= n; handW /= n;
        assert.ok(fingerW >= 0.55, `${side}${finger} mid-phalanx: finger-chain weight ${fingerW.toFixed(2)} < 0.55`);
        assert.ok(handW <= 0.30, `${side}${finger} mid-phalanx: Hand weight ${handW.toFixed(2)} > 0.30`);
        fingersChecked++;
      }
    }
    assert.ok(fingersChecked > 0, 'expected to check at least one finger');
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

  it('respects fingerCount option (e.g. 3 fingers)', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true, fingerCount: 3 });
    const { jointIndex } = await inspectRig(buffer);
    for (const side of ['Left', 'Right']) {
      for (const finger of ['Thumb', 'Index', 'Middle']) {
        for (let i = 1; i <= 3; i++) {
          const name = `${side}Hand${finger}${i}`;
          assert.ok(jointIndex[name] != null, `expected active ${name}`);
        }
      }
      for (const finger of ['Ring', 'Pinky']) {
        for (let i = 1; i <= 3; i++) {
          const name = `${side}Hand${finger}${i}`;
          assert.ok(jointIndex[name] == null, `expected inactive ${name} to be absent`);
        }
      }
    }
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

  it('does not drift joint positions when rigging multiple times', async () => {
    // Helper to normalize names
    const getNormName = (name) => {
      if (!name) return '';
      let n = name.toLowerCase();
      if (n.includes(':')) n = n.split(':').pop();
      n = n.replace(/^(valvebiped\.?bip\d+|cc_base|mixamorig\d*|armature|bip\d+|biped|def|root|gltf_created_\d+)[:_\-. ]+/, '');
      n = n.replace(/^mixamorig\d*/, '');
      n = n.replace(/\.([lr])$/, '$1');
      n = n.replace(/_(\d+)$/, '');
      return n.replace(/[:_\-\.\s]/g, '');
    };

    // 1. Guess joints on the original model
    const guess1 = await guessJoints(load('character_animated_1.glb'));
    const joints1 = guess1.joints;
    
    // 2. Rig the model once
    const riggedBuffer1 = await autoRigGLB(load('character_animated_1.glb'), { joints: joints1 });
    
    // 3. Inspect rigged 1 to get joint positions
    const rig1 = await inspectRig(riggedBuffer1);
    
    // 4. Rig the model again, feeding the rigged GLB as input
    const riggedBuffer2 = await autoRigGLB(riggedBuffer1, { joints: joints1 });
    
    // 5. Inspect rigged 2 to check joint positions
    const rig2 = await inspectRig(riggedBuffer2);
    
    // Assert that the joint positions are identical between the two rig runs
    for (const name of Object.keys(joints1)) {
      const normCanon = getNormName(name);
      const key1 = Object.keys(rig1.jointWorld).find(k => getNormName(k) === normCanon);
      const key2 = Object.keys(rig2.jointWorld).find(k => getNormName(k) === normCanon);
      
      if (!key1 || !key2) continue;
      
      const p1 = rig1.jointWorld[key1];
      const p2 = rig2.jointWorld[key2];
      const dist = Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]);
      assert.ok(dist < 1e-4, `joint ${key1} drifted by ${dist} between rig runs (p1=[${p1}], p2=[${p2}])`);
    }
  });

  it('assigns twist weights uniformly across the entire cross-section of the limb (no radius gate)', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const { prims, jointWorld, jointIndex } = await inspectRig(buffer);
    
    const arm = jointWorld.LeftArm;
    const forearm = jointWorld.LeftForeArm;
    const mid = [
      (arm[0] + forearm[0]) * 0.5,
      (arm[1] + forearm[1]) * 0.5,
      (arm[2] + forearm[2]) * 0.5,
    ];
    const H = jointWorld.Head[1] * 1.15;
    const twistIdx = jointIndex.LeftArmTwist;
    
    // Check that vertices FARTHER from the bone axis (outer shell: 0.04 * H < d < 0.08 * H)
    // still receive twist weights.
    let checked = 0, good = 0;
    for (const prim of prims) {
      for (let v = 0; v < prim.count; v++) {
        const p = [prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]];
        const d = Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]);
        if (d <= 0.04 * H || d > 0.08 * H) continue;
        
        let w = 0;
        for (let k = 0; k < 4; k++) {
          if (prim.joints[v * 4 + k] === twistIdx) w += prim.weights[v * 4 + k];
        }
        checked++;
        if (w >= 0.05) good++;
      }
    }
    assert.ok(checked > 0, 'expected outer upper-arm vertices to check');
    assert.ok(good >= checked * 0.3, `outer upper-arm vertices should have twist weights, only got ${good}/${checked}`);
  });
});
