import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { BONE_MAP, canonicalBoneRole, mergeGLBs } from '../js/core/merge_api.mjs';

// Real BabylonJS 9 (NullEngine) — the client retargeter runs exactly as in the
// browser, including AnimatorAvatar and the glTF loader.
const require = createRequire(import.meta.url);
const BABYLON = require('babylonjs');
globalThis.BABYLON = BABYLON;
require('babylonjs-loaders');
BABYLON.Logger.LogLevels = BABYLON.Logger.ErrorLogLevel;

const asset = (path) => fs.readFile(new URL(`../assets/${path}`, import.meta.url));

async function loadController() {
  const source = await fs.readFile(new URL('../js/character-controller.js', import.meta.url), 'utf8');
  const sandbox = {
    console: { log() {}, warn() {}, error: console.error }, BABYLON, TextDecoder, fetch,
    navigator: { userAgent: '', getGamepads: () => [] }, document: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'character-controller.js' });
  return sandbox;
}

function newScene() {
  const engine = new BABYLON.NullEngine();
  return new BABYLON.Scene(engine);
}

async function importCharacter(scene, bytes) {
  const result = await BABYLON.SceneLoader.ImportMeshAsync('', '', new Uint8Array(bytes), scene, null, '.glb');
  result.animationGroups.forEach(g => g.stop());
  return result;
}

/** Joint positions relative to the character root for a clip at `frame`. */
function clipPose(ctrl, group, root, skeleton, frame) {
  const pose = ctrl.evaluateGroupPose(group, frame);
  const restOf = (node) => {
    const bone = skeleton.bones.find(b => b.getTransformNode() === node);
    if (!bone) return ctrl.staticRestOf(node);
    const s = new BABYLON.Vector3(), q = new BABYLON.Quaternion(), p = new BABYLON.Vector3();
    bone.getRestMatrix().decompose(s, q, p);
    return { position: p, rotationQuaternion: q, scaling: s };
  };
  const out = new Map();
  for (const bone of skeleton.bones) {
    const node = bone.getTransformNode();
    if (node) out.set(node.name, ctrl.posePosition(node, root, pose, restOf));
  }
  return out;
}

test('client bone roles mirror the server BONE_MAP exactly', async () => {
  const ctrl = await loadController();
  const names = new Set();
  for (const [key, aliases] of Object.entries(BONE_MAP)) {
    names.add(key);
    aliases.forEach(alias => names.add(alias));
    aliases.forEach(alias => names.add(alias.replace(/^mixamorig:/, 'mixamorig:').toUpperCase()));
  }
  for (const extra of ['mixamorig:Neck_00', 'CC_Base_L_Upperarm', 'J_Bip_L_UpperArm', 'upper_arm.L', 'Bip001 L Thigh', 'spine_01', 'ball_r']) names.add(extra);
  for (const name of names) {
    assert.equal(ctrl.canonicalBoneRole(name), canonicalBoneRole(name), name);
  }
});

test('offline retarget onto a Mixamo character matches the server merge', async () => {
  const ctrl = await loadController();
  const characterBytes = await asset('characters_test/prisioner_hostage.glb');
  const animationBytes = await asset('animations.glb');

  const clientScene = newScene();
  const character = await importCharacter(clientScene, characterBytes);
  const { container, json } = await ctrl.loadRetargetSource(clientScene, new Uint8Array(animationBytes));
  const { groups, report } = ctrl.retargetAnimationGroupsClient(clientScene, character.meshes[0], container, { json });
  container.dispose();
  assert.ok(groups.length >= 40, `${groups.length} clips`);
  assert.ok(report.mapped >= 45, `mapped ${report.mapped}`);
  assert.ok(report.restAligned >= 2, 'A-posed rest arms were aligned to the T-pose library');
  for (const group of groups) {
    const positions = group.targetedAnimations.filter(ta => ta.animation.targetProperty === 'position');
    assert.ok(positions.every(ta => /hips/i.test(ta.target.name)), `${group.name}: only root translation`);
    assert.ok(!group.targetedAnimations.some(ta => ta.animation.targetProperty === 'scaling'), `${group.name}: no scaling`);
  }

  const serverScene = newScene();
  const merged = await importCharacter(serverScene, await mergeGLBs(characterBytes, animationBytes,
    { COMPRESS_OUTPUT: false, removeExistingAnimations: true }));
  const clientSkeleton = character.skeletons[0], serverSkeleton = merged.skeletons[0];
  for (const clip of ['Walk_Loop', 'Punch_Cross', 'Crouch_Idle_Loop']) {
    const client = groups.find(g => g.name === clip);
    const server = merged.animationGroups.find(g => g.name === clip);
    for (const frame of [client.from, (client.from + client.to) / 2]) {
      const a = clipPose(ctrl, client, character.meshes[0], clientSkeleton, frame);
      const b = clipPose(ctrl, server, merged.meshes[0], serverSkeleton, frame);
      const find = (pose, joint) => [...pose].find(([n]) => n.replace(/_\d+$/, '') === `mixamorig:${joint}`)?.[1];
      for (const joint of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head']) {
        const pa = find(a, joint), pb = find(b, joint);
        assert.ok(pa && pb, `${clip}: ${joint} present`);
        // The server's virtual T-pose also straightens the legs; the client keeps
        // the authored leg rest, so feet get a slightly wider tolerance.
        const d = BABYLON.Vector3.Distance(pa, pb);
        const limit = /Foot/.test(joint) ? 0.07 : 0.035;
        assert.ok(d < limit, `${clip}@${frame} ${joint}: client/server differ by ${d.toFixed(3)} m`);
      }
    }
  }
});

test('offline retarget aligns an A-posed auto-rig and reuses a merged library reference pose', async () => {
  const ctrl = await loadController();
  const { autoRigGLB } = await import('../js/core/autorig_api.mjs');
  const quiet = console.log; console.log = () => {};
  const rigged = await autoRigGLB(await asset('female_character_simple.glb'), {});
  const library = await mergeGLBs(await asset('characters_test/prisioner_hostage.glb'), await asset('animations.glb'),
    { COMPRESS_OUTPUT: false, removeExistingAnimations: true });
  const merged = await mergeGLBs(rigged, library, { COMPRESS_OUTPUT: false, removeExistingAnimations: true });
  console.log = quiet;

  const scene = newScene();
  const character = await importCharacter(scene, rigged);
  const { container, json } = await ctrl.loadRetargetSource(scene, new Uint8Array(library));
  assert.ok(json.extras.bjsRetargetPoses, 'merged libraries carry their reference pose');
  const { groups } = ctrl.retargetAnimationGroupsClient(scene, character.meshes[0], container, { json });
  container.dispose();

  const serverScene = newScene();
  const server = await importCharacter(serverScene, merged);
  const skeleton = character.skeletons[0];
  for (const clip of ['Idle_Loop', 'Walk_Loop']) {
    const a = clipPose(ctrl, groups.find(g => g.name === clip), character.meshes[0], skeleton, 10);
    const b = clipPose(ctrl, server.animationGroups.find(g => g.name === clip), server.meshes[0], server.skeletons[0], 10);
    for (const joint of ['LeftHand', 'RightHand', 'LeftFoot', 'Head']) {
      const d = BABYLON.Vector3.Distance(a.get(joint), b.get(joint));
      // Auto-rig legs lean like real ones (ankle behind the hip socket); the
      // server's virtual T-pose straightens them, the client keeps the rest.
      const limit = /Foot/.test(joint) ? 0.07 : 0.025;
      assert.ok(d < limit, `${clip} ${joint}: client/server differ by ${d.toFixed(3)} m`);
    }
  }
});

// ── Runtime animation features on a real BabylonJS scene ─────────────────────

async function runtimeFixture() {
  const ctrl = await loadController();
  const scene = newScene();
  new BABYLON.FreeCamera('camera', new BABYLON.Vector3(0, 1, -5), scene);
  const character = await importCharacter(scene, await asset('characters_test/prisioner_hostage.glb'));
  const root = character.meshes[0];
  const anim = new ctrl.AnimCtrl([], scene);
  anim.onAnimationChange = () => {};
  const charStub = { scene, visualMesh: root, anim, SPEED_MULTIPLIER: 1 };
  anim.charCtrl = charStub;
  const { added, report } = await ctrl.CharCtrl.prototype.loadAnimations.call(charStub, new Uint8Array(await asset('animations.glb')));
  return { ctrl, scene, root, anim, added, report };
}

test('CharCtrl.loadAnimations retargets a pack at runtime and registers it', async () => {
  const { anim, added } = await runtimeFixture();
  for (const name of ['Idle_Loop', 'Walk_Loop', 'Sprint_Loop', 'Punch_Cross']) {
    assert.ok(added.includes(name), `${name} registered`);
    assert.ok(anim.g.get(name).targetedAnimations.length > 20);
  }
  anim.dispose();
});

test('locomotion clips report a measured stride speed for foot-locked playback', async () => {
  const { ctrl, root, anim } = await runtimeFixture();
  const walk = ctrl.measureLocomotionClip(anim.g.get('Walk_Loop'), root);
  const sprint = ctrl.measureLocomotionClip(anim.g.get('Sprint_Loop'), root);
  assert.ok(walk && sprint, 'both loops measurable');
  assert.ok(walk.speed > 0.6 && walk.speed < 2.5, `walk ${walk.speed.toFixed(2)} m/s`);
  assert.ok(sprint.speed > walk.speed * 1.6, `sprint ${sprint.speed.toFixed(2)} m/s vs walk ${walk.speed.toFixed(2)}`);
  assert.ok(walk.leftStrike >= 0 && walk.leftStrike < 1);

  const loco = anim.locoGroup;
  const walkGroup = anim.g.get('Walk_Loop'), sprintGroup = anim.g.get('Sprint_Loop');
  const base = { SPD_WALK: 2.5, SPD_SPRINT: 5, SPEED_MULTIPLIER: 1, visualMesh: root };
  // 'full': feet locked to the ground speed.
  const full = { ...base, STRIDE_MATCHING: 'full' };
  const atWalk = loco._strideRatios(full, walkGroup, sprintGroup, 2.5);
  assert.ok(Math.abs(atWalk.walk - Math.min(2.5, 2.5 / walk.speed)) < 1e-6, 'walk plays at ground speed / clip speed');
  // default: the tuned legacy rates, scaled by the rig's leg length vs the stock rig.
  const scaled = { ...base, STRIDE_MATCHING: true };
  const legacyWalk = 2.5 * (1.5 / 2.4);
  const atWalkScaled = loco._strideRatios(scaled, walkGroup, sprintGroup, 2.5);
  assert.ok(Math.abs(atWalkScaled.walk - legacyWalk * (1.04 / walk.leg)) < 1e-6, `size-compensated walk rate ${atWalkScaled.walk}`);
  assert.ok(walk.leg > 0.9 && walk.leg < 1.2, `leg ${walk.leg}`);
  for (const char of [full, scaled]) {
    const mid = loco._strideRatios(char, walkGroup, sprintGroup, 3.75);
    const fps = walkGroup.targetedAnimations[0].animation.framePerSecond;
    const periodWalk = (walkGroup.to - walkGroup.from) / fps / mid.walk;
    const periodSprint = (sprintGroup.to - sprintGroup.from) / fps / mid.sprint;
    assert.ok(Math.abs(periodWalk - periodSprint) < 1e-9, 'blended loops share one cycle period');
  }
  const char = base;
  assert.equal(loco._strideRatios({ ...char, STRIDE_MATCHING: false }, walkGroup, sprintGroup, 3), null);
  anim.dispose();
});

test('upper-body layer masks the action onto the spine chain and hands it the weight', async () => {
  const { scene, anim } = await runtimeFixture();
  anim.play('Walk_Loop', true, 0);
  assert.ok(anim.playUpperBody('Punch_Cross', { blend: 0 }));
  scene.onBeforeRenderObservable.notifyObservers(scene);
  const upper = anim._upperBodyTargets();
  assert.ok(upper.size > 20, `${upper.size} upper-body nodes`);
  assert.ok(![...upper].some(n => /UpLeg|Foot/.test(n.name)), 'legs stay out of the layer');
  const layer = anim._upperLayer.group;
  assert.ok(layer.animatables.length > 0);
  for (const a of layer.animatables) {
    assert.ok(upper.has(a.target), `layer animates only the upper body (${a.target.name})`);
    assert.equal(a.weight, 1);
  }
  const walk = anim.g.get('Walk_Loop');
  for (const a of walk.animatables) {
    const expected = upper.has(a.target) ? 0 : 1;
    assert.equal(a.weight, expected, `${a.target.name} walk weight`);
  }
  anim.stopUpperBody(0);
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(anim._upperLayer, null);
  assert.ok(walk.animatables.every(a => a.weight === 1), 'walk regains the upper body');
  anim.dispose();
});

test('additive layers are built with MakeAnimationAdditive and play additively', async () => {
  const { anim } = await runtimeFixture();
  assert.ok(anim.playAdditive('Idle_Loop', { weight: 0.5 }));
  const additive = anim._additiveLayers.get('Idle_Loop');
  assert.ok(additive.isPlaying);
  assert.ok(additive.animatables.every(a => a.isAdditive), 'animatables are additive');
  assert.ok(additive.animatables.every(a => a.weight === 0.5));
  anim.stopAdditive('Idle_Loop');
  assert.equal(additive.isPlaying, false);
  anim.dispose();
});
