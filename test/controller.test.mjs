import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function loadController() {
  const source = await fs.readFile(new URL('../js/character-controller.js', import.meta.url), 'utf8');
  const dispatched = [];
  const sandbox = {
    console,
    BABYLON: { Vector3: class Vector3 {} },
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
  };
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
