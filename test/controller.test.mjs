import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import BABYLON from 'babylonjs';

async function loadController(babylon = { Vector3: class Vector3 {} }) {
  const source = await fs.readFile(new URL('../js/character-controller.js', import.meta.url), 'utf8');
  const dispatched = [];
  const sandbox = {
    console,
    BABYLON: babylon,
    navigator: { userAgent: '', getGamepads: () => [] },
    document: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = event => dispatched.push(event);
  vm.runInNewContext(source, sandbox, { filename: 'character-controller.js' });
  return { sandbox, dispatched };
}

function observable() {
  const observers = new Set();
  return {
    observers,
    add(callback) { observers.add(callback); return callback; },
    addOnce(callback) { observers.add(callback); return callback; },
    remove(callback) { observers.delete(callback); },
  };
}

function animationGroup(name) {
  return {
    name,
    from: 0,
    to: 20,
    speedRatio: 1,
    isPlaying: false,
    animatables: [{ masterFrame: 0, weight: 1 }],
    onAnimationGroupEndObservable: observable(),
    setWeightForAllAnimatables(weight) { this.animatables[0].weight = weight; },
    start() { this.isPlaying = true; },
    stop() { this.isPlaying = false; },
    goToFrame() {},
    clone(cloneName) { const copy = animationGroup(cloneName); copy.from = this.from; copy.to = this.to; return copy; },
    dispose() { this.disposed = true; },
  };
}

function quietConsole(sandbox) {
  const warnings = [];
  sandbox.console = { ...console, log() {}, warn: (...args) => warnings.push(args.join(' ')) };
  return warnings;
}

test('animation mapping is deterministic when clean names collide', async () => {
  const { sandbox } = await loadController();
  const first = animationGroup('Armature|Walk_Loop');
  const duplicate = animationGroup('OtherRig|Walk_Loop');
  const beforeRender = observable();
  const ctrl = new sandbox.AnimCtrl([first, duplicate], { onBeforeRenderObservable: beforeRender });
  assert.equal(ctrl.g.get('Walk_Loop'), first);
  ctrl.dispose();
  assert.equal(beforeRender.observers.size, 0);
});

test('animation events fire when reverse playback crosses a frame and wraps', async () => {
  const { sandbox, dispatched } = await loadController();
  const reverse = animationGroup('Reverse_Action');
  reverse.speedRatio = -1;
  const ctrl = new sandbox.AnimCtrl([reverse], { onBeforeRenderObservable: observable() });
  ctrl.cur = reverse;
  ctrl.curName = 'Reverse_Action';
  ctrl.animationEvents = {
    Reverse_Action: [
      { type: 'hit', frame: 9 },
      { type: 'sound', frame: 18 },
    ],
  };
  const fired = [];
  ctrl.onAnimationEvent = event => fired.push(event.frame);

  reverse.animatables[0].masterFrame = 10;
  ctrl._updateAnimationEvents();
  reverse.animatables[0].masterFrame = 8;
  ctrl._updateAnimationEvents();
  reverse.animatables[0].masterFrame = 16; // reverse loop wrap
  ctrl._updateAnimationEvents();

  assert.deepEqual(fired, [9, 18]);
  assert.deepEqual(dispatched.map(event => event.detail.frame), [9, 18]);
  ctrl.dispose();
});

test('bone role normalization keeps left and right aliases distinct', async () => {
  const { sandbox } = await loadController();
  assert.equal(sandbox.normBone('mixamorig:LeftUpperArm'), 'leftarm');
  assert.equal(sandbox.normBone('upperarm_r'), 'rightarm');
  assert.notEqual(sandbox.normBone('CC_Base_L_Hand'), sandbox.normBone('CC_Base_R_Hand'));
  assert.equal(sandbox.cleanAnimName('Armature|Locomotion|Walk_Loop'), 'Walk_Loop');
});

test('standard slots fall back to Builder keywords without double-mapping locomotion clips', async () => {
  const { sandbox } = await loadController();
  const warnings = quietConsole(sandbox);
  const names = ['Armature|Walk_And_Run', 'Armature|Walk', 'Idle_Breathing', 'Crouch_Walk', 'Jump_Start', 'Roll_Dodge', 'Wave'];
  const groups = names.map(animationGroup);
  const ctrl = new sandbox.AnimCtrl(groups, { onBeforeRenderObservable: observable() }, { warnMissing: false });
  const byName = name => groups[names.indexOf(name)];
  // Walk_Loop prefers the plain Walk over the longer clip listed first; that clip
  // stays free for Sprint_Loop instead of being shared by two locomotion slots.
  assert.equal(ctrl.g.get('Walk_Loop'), byName('Armature|Walk'));
  assert.equal(ctrl.g.get('Sprint_Loop'), byName('Armature|Walk_And_Run'));
  assert.equal(ctrl.g.get('Idle_Loop'), byName('Idle_Breathing'));
  assert.equal(ctrl.g.get('Crouch_Fwd_Loop'), byName('Crouch_Walk'));
  assert.equal(ctrl.g.get('Roll'), byName('Roll_Dodge'));
  assert.equal(ctrl.g.get('Jump_Start'), byName('Jump_Start'));
  const report = ctrl.mappingReport;
  assert.deepEqual([...report.exact], ['Jump_Start']);
  assert.deepEqual([...report.keyword].map(k => `${k.slot}=${k.clip}`), [
    'Idle_Loop=Idle_Breathing', 'Walk_Loop=Walk', 'Sprint_Loop=Walk_And_Run', 'Crouch_Fwd_Loop=Crouch_Walk', 'Roll=Roll_Dodge',
  ]);
  assert.ok(report.missing.includes('Punch') && !report.missing.includes('Walk_Loop'));
  assert.equal(sandbox.STANDARD_ANIM_SLOTS.length, 16);
  assert.equal(warnings.length, 0);
  ctrl.dispose();
});

test('a clip is only shared by two locomotion slots when nothing better exists, and missing core slots warn once', async () => {
  const { sandbox } = await loadController();
  const warnings = quietConsole(sandbox);
  const only = animationGroup('Walk_Run_Cycle');
  const ctrl = new sandbox.AnimCtrl([only], { onBeforeRenderObservable: observable() }, { warnMissing: false });
  assert.equal(ctrl.g.get('Walk_Loop'), only);
  const sprint = ctrl.g.get('Sprint_Loop');
  assert.notEqual(sprint, only, 'second locomotion slot plays an independent clone');
  assert.equal(sprint.__isSharedClone, true);
  assert.deepEqual({ ...ctrl.mappingReport.keyword[1] }, { slot: 'Sprint_Loop', clip: 'Walk_Run_Cycle', sharedWith: 'Walk_Loop' });
  assert.deepEqual([...ctrl._warnMissingCoreSlots()], ['Idle_Loop']);
  ctrl._warnMissingCoreSlots();
  assert.equal(warnings.filter(w => w.includes('No clip for Idle_Loop')).length, 1);
  ctrl.dispose();
});

function presetHarness(sandbox, names) {
  const groups = names.map(animationGroup);
  const anim = new sandbox.AnimCtrl(groups, { onBeforeRenderObservable: observable() }, { warnMissing: false });
  const configs = [];
  const charCtrl = {
    anim, keyBindings: { JUMP: ['Space'] },
    setConfig(partial) { configs.push(partial); return partial; },
  };
  return { groups, anim, charCtrl, configs };
}

test('applyCharacterPreset maps slots, clears null slots and reports missing clips once', async () => {
  const { sandbox } = await loadController();
  const warnings = quietConsole(sandbox);
  const { groups, anim, charCtrl, configs } = presetHarness(sandbox, ['Armature|Walking', 'Roll', 'Dance', 'Idle_Loop']);
  const result = sandbox.applyCharacterPreset(charCtrl, anim, groups, {
    schema: 'bjs-character-preset/v1',
    keys: { JUMP: ['KeyK'], TAUNT: 'KeyT' },
    config: { SPD_WALK: 3 },
    animations: {
      Walk_Loop: { clip: 'Walking', from: 2, to: 18 },
      Roll: null,
      Sprint_Loop: { clip: 'Sprinting' },
      Idle_Loop: 'Idle_Loop',
    },
    customActions: [{ name: 'TAUNT', clip: 'Dance', keys: ['KeyT', 'KeyY'] }, { name: 'WAVE', clip: 'Wave' }],
    animationEvents: { Walk_Loop: [{ type: 'footstep', frame: '5', label: 'L' }] },
  });
  const walk = anim.g.get('Walk_Loop');
  assert.equal(walk.name, 'Armature|Walking__Walk_Loop', 'remap clones like setAnimation does');
  assert.equal(walk.from, 2);
  assert.equal(walk.to, 18);
  assert.equal(anim.g.has('Roll'), false, 'null clears the slot');
  assert.equal(groups[1].isPlaying, false);
  assert.equal(anim.g.get('Idle_Loop'), groups[3], 'already exclusive mapping is kept as is');
  assert.equal(anim.g.get('TAUNT').name, 'Dance__TAUNT');
  assert.deepEqual([...charCtrl.keyBindings.TAUNT], ['KeyT', 'KeyY']);
  assert.deepEqual([...charCtrl.keyBindings.JUMP], ['KeyK']);
  assert.deepEqual({ ...configs[0] }, { SPD_WALK: 3 });
  assert.equal(anim.animationEvents.Walk_Loop[0].frame, 5);
  assert.deepEqual([...result.missing].map(m => `${m.slot}:${m.clip}`), ['Sprint_Loop:Sprinting', 'WAVE:Wave']);
  assert.ok(result.applied.includes('animations.Walk_Loop'));
  assert.ok(result.applied.includes('animations.Roll=none'));
  assert.ok(result.applied.includes('customActions.TAUNT'));
  assert.ok(result.applied.includes('keys') && result.applied.includes('config') && result.applied.includes('animationEvents'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Sprint_Loop ← "Sprinting", WAVE ← "Wave"/);
  anim.dispose();
});

test('Builder builder-config.json files are accepted as presets', async () => {
  const { sandbox } = await loadController();
  quietConsole(sandbox);
  const preset = sandbox.normalizeCharacterPreset({
    schema: 'bjs-character-controller-builder/v2',
    keys: { JUMP: ['KeyK'] },
    physics: { SPD_WALK: 3 },
    transforms: { SCALE_X: 1, SCALE_Y: 2, SCALE_Z: 1 },
    rigging: { boneMapOverrides: { pelvis: 'Hips' } },
    animations: {
      standardMappings: {
        Walk_Loop: { animName: 'Walking', from: 0, to: 30 },
        Roll: { animName: 'None', autoMapped: false },
        Punch: { animName: 'None', autoMapped: true },
      },
      customActions: [{ name: 'TAUNT', animName: 'Dance', keyTrigger: ['KeyT'] }, { name: 'X', animName: 'None', keyTrigger: [] }],
      events: { Walk_Loop: [{ type: 'footstep', frame: 3 }] },
    },
  });
  assert.equal(preset.schema, 'bjs-character-preset/v1');
  assert.deepEqual({ ...preset.animations.Walk_Loop }, { clip: 'Walking', from: 0, to: 30 });
  assert.equal(preset.animations.Roll, null);
  assert.equal('Punch' in preset.animations, false, 'automatic None leaves the runtime auto-map alone');
  assert.deepEqual([...preset.customActions].map(a => a.name), ['TAUNT']);
  assert.equal(preset.character.capsuleScale.y, 2);
  assert.equal(preset.mergeOptions.boneMapOverrides.pelvis, 'Hips');
  assert.equal(sandbox.normalizeCharacterPreset(null), null);
});

async function dustController(t) {
  const engine = new BABYLON.NullEngine();
  const scene = new BABYLON.Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const { sandbox } = await loadController({ ...BABYLON,
    Texture: class { constructor(_url, targetScene) {
      return BABYLON.RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, targetScene, false, false);
    } },
  });
  const root = BABYLON.MeshBuilder.CreateBox('playerCapsule', {}, scene);
  root.ellipsoid.set(0.46, 0.96, 0.46);
  root.position.set(0, 0.96, 0);
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 100, height: 100 }, scene);
  ground.checkCollisions = true;
  ground.computeWorldMatrix(true);
  const ctrl = Object.create(sandbox.CharCtrl.prototype);
  Object.assign(ctrl, { root, scene, visualMesh: root, usePhysics: false, PLAY_PARTICLES: true,
    state: sandbox.S.WALK, onScalable: false, _wasOnScalable: false, crouching: false });
  ctrl._setupDustParticles();
  return ctrl;
}

test('dust stays above ground through live uniform scale changes and landing bursts', async t => {
  const ctrl = await dustController(t);
  for (const scale of [1, 0.5, 0.25, 0.1, 0.01, 2, 1]) {
    ctrl._capScaleY = ctrl._capScaleW = scale;
    ctrl.root.scaling.setAll(scale);
    ctrl.root.ellipsoid.set(0.46 * scale, 0.96 * scale, 0.46 * scale);
    ctrl.root.position.set(3, 0.96 * scale, -2);
    ctrl._emitLandingDust();
    const ps = ctrl.dustPS;
    assert.equal(ps.isStarted(), true);
    assert.equal(ps.manualEmitCount, 30);
    assert.ok(Math.abs(ps.emitter.y - 0.01 * scale) < 1e-8, `emitter at scale ${scale}`);
    assert.equal(ps.emitter.x, 3);
    assert.equal(ps.emitter.z, -2);
    assert.ok(Math.abs(ps.minSize / scale - 0.16) < 1e-8);
    assert.ok(Math.abs(ps.maxSize / scale - 0.45) < 1e-8);
    // Exercise Babylon's actual box emitter: every new particle starts above
    // the ground, including after shrinking an already-running system.
    const world = BABYLON.Matrix.Translation(ps.emitter.x, ps.emitter.y, ps.emitter.z);
    for (let i = 0; i < 50; i++) {
      const position = new BABYLON.Vector3();
      ps.particleEmitterType.startPositionFunction(world, position, null, false);
      assert.ok(position.y > 0, `underground particle at scale ${scale}`);
    }
    assert.equal(ctrl._checkGrounded(), true, `ground detection at scale ${scale}`);
  }
});

test('dust follows live crouch offsets and Havok capsule dimensions', async t => {
  const ctrl = await dustController(t);
  ctrl._capScaleY = 0.25;
  ctrl._capScaleW = 0.5;
  ctrl.root.position.set(0, 0.96 * 0.25, 0);
  for (const blend of [0, 0.3, 0.7, 1]) {
    ctrl.root.ellipsoid.y = (0.96 - 0.41 * blend) * 0.25;
    ctrl.root.ellipsoidOffset.set(0.03, -0.41 * blend * 0.25, -0.02);
    ctrl._syncDustEmitter();
    assert.ok(Math.abs(ctrl.dustPS.emitter.y - 0.0025) < 1e-8);
    assert.equal(ctrl.dustPS.emitter.x, 0.03);
    assert.equal(ctrl.dustPS.emitter.z, -0.02);
  }
  ctrl.usePhysics = true;
  ctrl.root.position.set(0, 0.55 * 0.25 + 0.46 * 0.5, 0);
  ctrl._emitLandingDust();
  assert.ok(Math.abs(ctrl.dustPS.emitter.y - 0.0025) < 1e-8);
  assert.equal(ctrl.dustPS.emitter.x, 0);
  assert.equal(ctrl.dustPS.emitter.z, 0);
  ctrl.PLAY_PARTICLES = false;
  ctrl.dustPS.stop();
  ctrl.dustPS.manualEmitCount = 0;
  ctrl._emitLandingDust();
  assert.equal(ctrl.dustPS.manualEmitCount, 0);
});
