import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { mergeGLBs } from '../js/core/merge_api.mjs';
import { createIO, parentMap } from './helpers.mjs';

// Synthetic humanoid (Y-up, metres, identity joint orientations). `legScale`
// stretches thigh/calf/foot so the rigs differ only in leg proportions.
const MIXAMO = {
  hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', spine1: 'mixamorig:Spine1', spine2: 'mixamorig:Spine2',
  neck: 'mixamorig:Neck', head: 'mixamorig:Head',
  clavicle_l: 'mixamorig:LeftShoulder', upperarm_l: 'mixamorig:LeftArm', lowerarm_l: 'mixamorig:LeftForeArm', hand_l: 'mixamorig:LeftHand',
  clavicle_r: 'mixamorig:RightShoulder', upperarm_r: 'mixamorig:RightArm', lowerarm_r: 'mixamorig:RightForeArm', hand_r: 'mixamorig:RightHand',
  thigh_l: 'mixamorig:LeftUpLeg', calf_l: 'mixamorig:LeftLeg', foot_l: 'mixamorig:LeftFoot', toe_l: 'mixamorig:LeftToeBase',
  thigh_r: 'mixamorig:RightUpLeg', calf_r: 'mixamorig:RightLeg', foot_r: 'mixamorig:RightFoot', toe_r: 'mixamorig:RightToeBase',
  index1_l: 'mixamorig:LeftHandIndex1', index2_l: 'mixamorig:LeftHandIndex2', index3_l: 'mixamorig:LeftHandIndex3',
};

function skeletonSpec(legScale) {
  const s = legScale;
  return [
    ['hips', null, [0, 0.04 + 0.92 * s, 0]],
    ['spine', 'hips', [0, 0.10, 0]], ['spine1', 'spine', [0, 0.12, 0]], ['spine2', 'spine1', [0, 0.12, 0]],
    ['neck', 'spine2', [0, 0.15, 0]], ['head', 'neck', [0, 0.10, 0]],
    ['clavicle_l', 'spine2', [0.03, 0.12, 0]], ['upperarm_l', 'clavicle_l', [0.14, 0, 0]],
    ['lowerarm_l', 'upperarm_l', [0.27, 0, 0]], ['hand_l', 'lowerarm_l', [0.26, 0, 0]],
    ['clavicle_r', 'spine2', [-0.03, 0.12, 0]], ['upperarm_r', 'clavicle_r', [-0.14, 0, 0]],
    ['lowerarm_r', 'upperarm_r', [-0.27, 0, 0]], ['hand_r', 'lowerarm_r', [-0.26, 0, 0]],
    ['thigh_l', 'hips', [0.09, -0.04, 0]], ['calf_l', 'thigh_l', [0, -0.42 * s, 0]],
    ['foot_l', 'calf_l', [0, -0.43 * s, 0]], ['toe_l', 'foot_l', [0, -0.07 * s, 0.13 * s]],
    ['thigh_r', 'hips', [-0.09, -0.04, 0]], ['calf_r', 'thigh_r', [0, -0.42 * s, 0]],
    ['foot_r', 'calf_r', [0, -0.43 * s, 0]], ['toe_r', 'foot_r', [0, -0.07 * s, 0.13 * s]],
    ['index1_l', 'hand_l', [0.08, 0, 0]], ['index2_l', 'index1_l', [0.04, 0, 0]], ['index3_l', 'index2_l', [0.03, 0, 0]],
  ];
}

function buildSkeleton(doc, { legScale = 1, names = MIXAMO, unitScale = 1, parent = null } = {}) {
  const nodes = {};
  const world = {};
  for (const [key, parentKey, t] of skeletonSpec(legScale)) {
    const node = doc.createNode(names[key]).setTranslation(t.map(v => v / unitScale));
    nodes[key] = node;
    world[key] = parentKey ? world[parentKey].map((v, i) => v + t[i]) : t.slice();
    if (parentKey) nodes[parentKey].addChild(node);
    else if (parent) parent.addChild(node);
  }
  return { nodes, world };
}

function addSkin(doc, buffer, scene, { nodes, world }) {
  const keys = Object.keys(nodes);
  const positions = new Float32Array(keys.length * 9);
  const joints = new Uint16Array(keys.length * 3 * 4);
  const weights = new Float32Array(keys.length * 3 * 4);
  keys.forEach((key, i) => {
    const [x, y, z] = world[key];
    positions.set([x, y, z, x + 0.02, y, z, x, y + 0.02, z], i * 9);
    for (let v = 0; v < 3; v++) { joints[(i * 3 + v) * 4] = i; weights[(i * 3 + v) * 4] = 1; }
  });
  const ibm = new Float32Array(keys.length * 16);
  keys.forEach((key, i) => {
    const [x, y, z] = world[key];
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], i * 16);
  });
  const skin = doc.createSkin('Skin').setSkeleton(nodes.hips)
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  keys.forEach(key => skin.addJoint(nodes[key]));
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer));
  const bodyNode = doc.createNode('Body').setMesh(doc.createMesh('Body').addPrimitive(prim)).setSkin(skin);
  scene.addChild(bodyNode);
  return bodyNode;
}

async function character({ legScale = 1, extra } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const rig = buildSkeleton(doc, { legScale });
  scene.addChild(rig.nodes.hips);
  addSkin(doc, buffer, scene, rig);
  extra?.(doc, buffer, scene, rig);
  return (await createIO()).writeBinary(doc);
}

function track(doc, buffer, anim, node, path, times, values) {
  const sampler = doc.createAnimationSampler().setInterpolation('LINEAR')
    .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer))
    .setOutput(doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3')
      .setArray(new Float32Array(values.flat())).setBuffer(buffer));
  anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
}

/** Animation library: each clip = hips height offset (constant) over 4 keys. */
async function animationLibrary({ legScale = 1, unitScale = 1, clips = {}, build } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const armature = unitScale !== 1 ? doc.createNode('Armature').setScale([unitScale, unitScale, unitScale]) : null;
  if (armature) scene.addChild(armature);
  const rig = buildSkeleton(doc, { legScale, unitScale, parent: armature });
  if (!armature) scene.addChild(rig.nodes.hips);
  const times = [0, 1 / 30, 2 / 30, 3 / 30];
  const rest = rig.nodes.hips.getTranslation();
  for (const [name, offsets] of Object.entries(clips)) {
    const anim = doc.createAnimation(name);
    track(doc, buffer, anim, rig.nodes.hips, 'translation', times,
      offsets.map(dy => [rest[0], rest[1] + dy / unitScale, rest[2]]));
    track(doc, buffer, anim, rig.nodes.spine, 'rotation', times, times.map(() => [0, 0, 0, 1]));
  }
  build?.(doc, buffer, rig, times);
  return (await createIO()).writeBinary(doc);
}

async function mergedTracks(charBuffer, animBuffer, options = {}) {
  const report = {};
  const output = await mergeGLBs(charBuffer, animBuffer, {
    COMPRESS_OUTPUT: false, removeExistingAnimations: true, reportSink: report, ...options,
  });
  const doc = await (await createIO()).readBinary(output);
  const clips = new Map();
  for (const anim of doc.getRoot().listAnimations()) {
    const channels = anim.listChannels().map(ch => ({
      node: ch.getTargetNode(), path: ch.getTargetPath(),
      times: Array.from(ch.getSampler().getInput().getArray()),
      values: Array.from(ch.getSampler().getOutput().getArray()),
    }));
    clips.set(anim.getName(), channels);
  }
  return { doc, clips, report };
}

const hipsY = (clips, clip) => {
  const ch = clips.get(clip).find(c => /hips$/i.test(c.node.getName()) && c.path === 'translation');
  return ch.values.filter((_, i) => i % 3 === 1);
};

test('root translation is scaled by the leg-length ratio (fixRootPosition)', async () => {
  const anim = await animationLibrary({ clips: { Jump: [0, 0.3, 0.3, 0] } });
  const shortChar = await character({ legScale: 0.5 });
  const { clips, report } = await mergedTracks(shortChar, anim, { FIX_GROUND_REFERENCE: false });
  const legLength = s => Math.hypot(0.09, 0.04 + 0.85 * s);
  const ratio = legLength(0.5) / legLength(1);
  assert.ok(Math.abs(report.rootMotionScale - ratio) < 1e-3, `ratio ${report.rootMotionScale} vs ${ratio}`);
  const y = hipsY(clips, 'Jump');
  assert.ok(Math.abs((y[1] - y[0]) - 0.3 * ratio) < 1e-4, `hips rise ${y[1] - y[0]} expected ${0.3 * ratio}`);

  const off = await mergedTracks(shortChar, anim, { FIX_GROUND_REFERENCE: false, FIX_ROOT_POSITION: false });
  const raw = hipsY(off.clips, 'Jump');
  assert.ok(Math.abs((raw[1] - raw[0]) - 0.3) < 1e-4, 'FIX_ROOT_POSITION: false keeps source units');
});

test('scaled source armatures contribute their unit scale to root motion', async () => {
  const char = await character();
  const metres = await animationLibrary({ clips: { Jump: [0, 0.3, 0.3, 0] } });
  const centimetres = await animationLibrary({ unitScale: 0.01, clips: { Jump: [0, 0.3, 0.3, 0] } });
  const a = hipsY((await mergedTracks(char, metres)).clips, 'Jump');
  const b = hipsY((await mergedTracks(char, centimetres)).clips, 'Jump');
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < 1e-4, `key ${i}: ${value} vs ${b[i]}`));
});

test('ground reference grounds hovering contact clips and keeps airborne/in-place clearance', async () => {
  const anim = await animationLibrary({
    clips: {
      Crouch_Hover: [0.05, 0.05, 0.05, 0.05], // source floats 5 cm: library defect
      Jump_Loop: [-0.06, -0.06, -0.06, -0.06], // in-place loop hangs the feet below the capsule
      Swim: [0.5, 0.5, 0.5, 0.5], // clearly airborne
    },
  });
  const char = await character({ legScale: 0.8 });
  const { clips, report } = await mergedTracks(char, anim);
  const rest = 0.04 + 0.92 * 0.8;
  const legV = (s) => 0.04 + 0.92 * s - 0.01 * s; // hips → lowest foot joint (foot or toe)
  const lowest = (y) => y - rest; // identity leg rotations: feet move with the hips
  assert.ok(Math.abs(lowest(hipsY(clips, 'Crouch_Hover')[0])) < 1e-4, 'hovering clip lands on the ground');
  const jump = lowest(hipsY(clips, 'Jump_Loop')[0]);
  assert.ok(jump < -0.03 && jump > -0.06, `in-place jump keeps a proportional drop (${jump})`);
  const swim = lowest(hipsY(clips, 'Swim')[0]);
  assert.ok(Math.abs(swim - 0.5 * legV(0.8) / legV(1)) < 0.02, `airborne clearance ${swim}`);
  assert.ok(report.groundCorrections.some(c => c.clip === 'Crouch_Hover'));
});

test('re-merging a ground-corrected library changes nothing (clip and frame modes)', async () => {
  const anim = await animationLibrary({ clips: { Crouch_Hover: [0.05, 0.04, 0.05, 0.03], Hop: [0, 0.2, 0.25, 0] } });
  const char = await character({ legScale: 0.7 });
  for (const mode of [true, 'frame']) {
    const first = await mergeGLBs(char, anim, { COMPRESS_OUTPUT: false, removeExistingAnimations: true, FIX_GROUND_REFERENCE: mode });
    const again = await mergedTracks(char, first, { FIX_GROUND_REFERENCE: mode });
    const before = await mergedTracks(char, anim, { FIX_GROUND_REFERENCE: mode });
    for (const clip of ['Crouch_Hover', 'Hop']) {
      const a = hipsY(before.clips, clip), b = hipsY(again.clips, clip);
      assert.equal(a.length, b.length, `${mode}/${clip}: key count`);
      a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < 1e-4, `${mode}/${clip} key ${i}: ${value} vs ${b[i]}`));
    }
    assert.equal(again.report.groundCorrections.length, 0, `${mode}: nothing left to correct`);
  }
});

test('UE5 root + pelvis produce one hips channel per path, driven by pelvis', async () => {
  const UE5 = { ...MIXAMO, hips: 'pelvis', thigh_l: 'thigh_l', calf_l: 'calf_l', foot_l: 'foot_l', toe_l: 'ball_l',
    thigh_r: 'thigh_r', calf_r: 'calf_r', foot_r: 'foot_r', toe_r: 'ball_r' };
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const root = doc.createNode('root');
  scene.addChild(root);
  const rig = buildSkeleton(doc, { names: UE5, parent: root });
  const anim = doc.createAnimation('Walk');
  const times = [0, 1 / 30, 2 / 30, 3 / 30];
  track(doc, buffer, anim, root, 'translation', times, times.map(() => [0, 0, 0]));
  const rest = rig.nodes.hips.getTranslation();
  track(doc, buffer, anim, rig.nodes.hips, 'translation', times, [0, 0.02, 0.04, 0.02].map(d => [rest[0], rest[1] + d, rest[2]]));
  const animBuffer = await (await createIO()).writeBinary(doc);
  const { clips, report } = await mergedTracks(await character(), animBuffer, { FIX_GROUND_REFERENCE: false });
  const hipsChannels = clips.get('Walk').filter(c => c.node.getName() === 'mixamorig:Hips' && c.path === 'translation');
  assert.equal(hipsChannels.length, 1);
  const y = hipsChannels[0].values.filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs((y[2] - y[0]) - 0.04) < 1e-4, 'pelvis motion survives, static root is dropped');
  assert.equal(report.duplicateTracksDropped, 1);
});

test('morph weights follow mesh + morph target names, never a joint', async () => {
  const addFace = (doc, buffer, scene, names) => {
    const positions = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([0, 1.6, 0, 0.1, 1.6, 0, 0, 1.7, 0]));
    const prim = doc.createPrimitive().setAttribute('POSITION', positions);
    for (let i = 0; i < names.length; i++) {
      prim.addTarget(doc.createPrimitiveTarget(names[i]).setAttribute('POSITION',
        doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(9))));
    }
    const mesh = doc.createMesh('Face').addPrimitive(prim).setWeights(names.map(() => 0)).setExtras({ targetNames: names });
    const node = doc.createNode('Head').setMesh(mesh); // same name as a humanoid joint on purpose
    scene.addChild(node);
    return node;
  };
  const char = await character({ extra: (doc, buffer, scene) => addFace(doc, buffer, scene, ['blink', 'smile', 'look']) });
  const anim = await animationLibrary({
    clips: { Blink: [0, 0, 0, 0] },
    build: (doc, buffer, rig, times) => {
      const scene = doc.getRoot().listScenes()[0];
      const face = addFace(doc, buffer, scene, ['look', 'blink']);
      const clip = doc.getRoot().listAnimations()[0];
      const sampler = doc.createAnimationSampler().setInterpolation('LINEAR')
        .setInput(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Float32Array(times)))
        .setOutput(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
          .setArray(new Float32Array([0.1, 0, 0.2, 1, 0.3, 0, 0.4, 1])));
      clip.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(face).setTargetPath('weights').setSampler(sampler));
    },
  });
  const { clips, report } = await mergedTracks(char, anim);
  const weights = clips.get('Blink').find(c => c.path === 'weights');
  assert.ok(weights.node.getMesh(), 'weights channel targets a mesh node');
  assert.deepEqual(weights.values.map(v => Number(v.toFixed(3))),
    [0, 0, 0.1, 1, 0, 0.2, 0, 0, 0.3, 1, 0, 0.4], 'reordered by name, unmatched targets keep defaults');
  assert.equal(report.morph.retargeted, 1);
});

test('rotation tracks are hemisphere-continuous and orthogonal glitches are repaired', async () => {
  const s = Math.SQRT1_2;
  const anim = await animationLibrary({
    clips: { Idle: [0, 0, 0, 0] },
    build: (doc, buffer, rig, times) => {
      const clip = doc.getRoot().listAnimations()[0];
      const t5 = [...times, 4 / 30];
      track(doc, buffer, clip, rig.nodes.neck, 'rotation', t5,
        [[0, 0, 0, 1], [0, 0, 0, -1], [1, 0, 0, 0], [0, 0, s * 0.1, -1], [0, 0, 0, 1]]);
    },
  });
  const { clips, report } = await mergedTracks(await character(), anim);
  const neck = clips.get('Idle').find(c => c.node.getName() === 'mixamorig:Neck' && c.path === 'rotation');
  for (let i = 4; i < neck.values.length; i += 4) {
    const dot = [0, 1, 2, 3].reduce((sum, k) => sum + neck.values[i + k] * neck.values[i - 4 + k], 0);
    assert.ok(dot > 0.9, `key ${i / 4} continuous with its predecessor (dot ${dot})`);
  }
  assert.equal(report.quaternionRepairs, 1);
});

test('merge report lists skeleton hierarchy differences', async () => {
  const anim = await animationLibrary({
    clips: { Idle: [0, 0, 0, 0] },
    build: (doc, buffer, rig) => {
      // Forearm re-parented under the chest: structurally different chain.
      rig.nodes.upperarm_l.removeChild(rig.nodes.lowerarm_l);
      rig.nodes.spine2.addChild(rig.nodes.lowerarm_l);
    },
  });
  const { report, doc } = await mergedTracks(await character(), anim);
  assert.ok(report.hierarchyMismatches.some(m => m.startsWith('mixamorig:LeftForeArm')), JSON.stringify(report.hierarchyMismatches));
  // The character's own hierarchy is untouched.
  const forearm = doc.getRoot().listNodes().find(n => n.getName() === 'mixamorig:LeftForeArm');
  assert.equal(parentMap(doc).get(forearm).getName(), 'mixamorig:LeftArm');
});

// ── Auto-rig bone orientation + canonical roles ──────────────────────────────

function sampleChannel(channel, time) {
  const input = channel.getSampler().getInput().getArray();
  const output = channel.getSampler().getOutput().getArray();
  const size = output.length / input.length;
  let k = 0;
  while (k < input.length - 1 && input[k + 1] <= time) k++;
  return Array.from(output.slice(k * size, k * size + size));
}

function worldPositions(doc, animationName, time) {
  const anim = doc.getRoot().listAnimations().find(a => a.getName() === animationName);
  const overrides = new Map();
  for (const ch of anim.listChannels()) {
    const o = overrides.get(ch.getTargetNode()) || {};
    o[ch.getTargetPath()] = sampleChannel(ch, time);
    overrides.set(ch.getTargetNode(), o);
  }
  const parents = parentMap(doc);
  const cache = new Map();
  const compose = (node) => {
    if (cache.has(node)) return cache.get(node);
    const o = overrides.get(node) || {};
    const t = o.translation || node.getTranslation(), r = o.rotation || node.getRotation(), s = o.scale || node.getScale();
    const [x, y, z, w] = r;
    const local = [
      (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
      2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
      2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
      t[0], t[1], t[2], 1];
    const parent = parents.get(node);
    let world = local;
    if (parent) {
      const p = compose(parent);
      world = new Array(16);
      for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += p[k * 4 + r2] * local[c * 4 + k];
        world[c * 4 + r2] = sum;
      }
    }
    cache.set(node, world);
    return world;
  };
  const out = new Map();
  for (const joint of doc.getRoot().listSkins()[0].listJoints()) {
    out.set(joint.getExtras().bjsCanonical || joint.getName(), compose(joint).slice(12, 15));
  }
  return out;
}

test('bone-aligned auto-rig frames retarget to the same world pose as world-aligned binds', async () => {
  const { autoRigGLB } = await import('../js/core/autorig_api.mjs');
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../assets/female_character_simple.glb', import.meta.url));
  const animations = await fs.readFile(new URL('../assets/animations.glb', import.meta.url));
  const io = await createIO();
  const poses = {};
  for (const boneOrientation of ['world', 'aligned']) {
    const rigged = await autoRigGLB(source, { boneOrientation });
    const riggedDoc = await io.readBinary(rigged);
    const joints = riggedDoc.getRoot().listSkins()[0].listJoints();
    assert.ok(joints.every(j => j.getExtras().bjsCanonical), 'every joint records its canonical role');
    if (boneOrientation === 'aligned') {
      const arm = joints.find(j => j.getExtras().bjsCanonical === 'LeftForeArm');
      assert.ok(Math.abs(arm.getRotation()[3]) < 0.9999 || joints.some(j => Math.abs(j.getRotation()[3]) < 0.99),
        'aligned binds carry non-identity joint rotations');
    }
    const merged = await io.readBinary(await mergeGLBs(rigged, animations, { COMPRESS_OUTPUT: false, removeExistingAnimations: true }));
    poses[boneOrientation] = [0.2, 0.6].map(time => worldPositions(merged, 'Walk_Loop', time));
  }
  poses.world.forEach((frame, f) => {
    for (const [name, p] of frame) {
      const q = poses.aligned[f].get(name);
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      // Body bones use the per-bone change of basis, exact for any bind frame.
      // Measured finger chains bend away from the hand, so aligned finger frames
      // can cross merge_api's hand-space gate (FINGER_FRAME_DIVERGE_DEG) while
      // world frames do not: both are valid transfers, a few mm apart.
      const limit = /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name) ? 1e-2 : 2e-3;
      assert.ok(d < limit, `frame ${f} ${name}: world ${p} vs aligned ${q}`);
    }
  });
});

test('blender-named auto-rigs keep spine and finger animation via canonical roles', async () => {
  const { autoRigGLB } = await import('../js/core/autorig_api.mjs');
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../assets/female_character_simple.glb', import.meta.url));
  const animations = await fs.readFile(new URL('../assets/animations.glb', import.meta.url));
  const rigged = await autoRigGLB(source, { skeletonPreset: 'blender' });
  const merged = await (await createIO()).readBinary(await mergeGLBs(rigged, animations, { COMPRESS_OUTPUT: false, removeExistingAnimations: true }));
  const walk = merged.getRoot().listAnimations().find(a => a.getName() === 'Walk_Loop');
  const animated = new Set(walk.listChannels().map(ch => ch.getTargetNode().getName()));
  for (const name of ['spine.001', 'spine.002', 'f_index.01.L', 'f_pinky.03.R']) assert.ok(animated.has(name), `${name} animated`);
});

test('cross-convention finger frames use the bone change-of-basis (12° gate)', async () => {
  const roll = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // UE-style: finger bind rolled 90° about the finger axis
  const curlLocal = [0, 0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)]; // 60° about the (rolled) local Z
  const qMul = ([x1, y1, z1, w1], [x2, y2, z2, w2]) => [
    x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2, y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
    z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2];
  const anim = await animationLibrary({
    clips: { Curl: [0, 0, 0, 0] },
    build: (doc, buffer, rig, times) => {
      rig.nodes.index1_l.setRotation(roll);
      const clip = doc.getRoot().listAnimations()[0];
      track(doc, buffer, clip, rig.nodes.index1_l, 'rotation', times, times.map(() => qMul(roll, curlLocal)));
    },
  });
  const { doc } = await mergedTracks(await character(), anim, { FIX_GROUND_REFERENCE: false });
  const pose = worldPositions(doc, 'Curl', 0);
  const hand = pose.get('mixamorig:LeftHand'), tip = pose.get('mixamorig:LeftHandIndex3');
  // Animation world motion: curl about world -Y (the rolled local Z) → finger swings in the XZ plane.
  // Hand-space C would curl about the character's local Z instead (vertical plane).
  const expectedDir = [Math.cos(Math.PI / 3), 0, Math.sin(Math.PI / 3)]; // X rotated -60° about +Y
  const rel = tip.map((v, i) => v - hand[i] - [0.08, 0, 0][i]);
  const len = Math.hypot(...rel);
  const dir = rel.map(v => v / len);
  assert.ok(Math.abs(dir[1]) < 1e-3, `finger stays in the horizontal plane (dir ${dir})`);
  assert.ok(Math.hypot(dir[0] - expectedDir[0], dir[2] - expectedDir[2]) < 1e-3, `dir ${dir} vs ${expectedDir}`);
});
