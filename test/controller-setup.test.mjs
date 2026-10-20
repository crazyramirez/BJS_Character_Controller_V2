// setupCharacter / createCharacter / CharCtrl public API in a vm sandbox with
// real BabylonJS 9 (NullEngine) and mocked loaders, fetch and DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import BABYLON from 'babylonjs';

const SOURCE_URL = new URL('../js/character-controller.js', import.meta.url);

function fakeDocument() {
  const elements = new Map();
  const calls = [];
  const element = () => ({ textContent: '', style: {}, value: '', classList: { add() {}, remove() {}, contains: () => false } });
  return {
    elements, calls, element,
    activeElement: null,
    body: { classList: { add() {}, remove() {} } },
    getElementById(id) { calls.push(id); return elements.get(id) || null; },
    addEventListener() { calls.push('document.addEventListener'); },
    removeEventListener() {},
  };
}

function fakeGroup(name) {
  const group = {
    name, from: 0, to: 30, speedRatio: 1, isPlaying: false, stops: 0,
    animatables: [{ masterFrame: 0, weight: 0 }],
    onAnimationGroupEndObservable: new BABYLON.Observable(),
    setWeightForAllAnimatables(weight) { this.animatables[0].weight = weight; return this; },
    start() { this.isPlaying = true; return this; },
    stop() { this.isPlaying = false; this.stops++; return this; },
    goToFrame() {},
    clone(cloneName) { const copy = fakeGroup(cloneName); copy.from = this.from; copy.to = this.to; return copy; },
    dispose() { this.disposed = true; },
  };
  return group;
}

/** Character "GLB": a root + body mesh and fake animation groups. */
function fakeImport(scene, clips) {
  const root = new BABYLON.Mesh('__root__', scene);
  const body = new BABYLON.Mesh('Body', scene);
  body.parent = root;
  return { meshes: [root, body], animationGroups: clips.map(fakeGroup), skeletons: [], transformNodes: [] };
}

async function runtime(t, { source, clips = ['Idle_Loop', 'Walk_Loop', 'Sprint_Loop', 'Walking', 'Roll', 'Dance'], server = false } = {}) {
  const engine = new BABYLON.NullEngine();
  const scene = new BABYLON.Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const imports = [];
  const fetches = [];
  const windowListeners = [];
  const warnings = [];
  const document = fakeDocument();
  const babylon = {
    ...BABYLON,
    Texture: class { constructor(_url, targetScene) {
      return BABYLON.RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, targetScene, false, false);
    } },
    SceneLoader: {
      ImportMeshAsync: async (...args) => { imports.push(args.slice(0, 3).concat(args.slice(4))); return fakeImport(args[3], clips); },
    },
  };
  const fetch = async (url, init) => {
    fetches.push({ url, method: init?.method || 'GET' });
    if (url.endsWith('/api/health')) return { ok: server };
    if (url.endsWith('/api/merge')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(32) };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({}) };
  };
  const sandbox = {
    console: { ...console, log() {}, warn: (...args) => warnings.push(args.join(' ')) },
    BABYLON: babylon, document, fetch, Blob, FormData, TextDecoder,
    URL: { createObjectURL: () => 'blob:merged', revokeObjectURL() {} },
    navigator: { userAgent: '', maxTouchPoints: 0, getGamepads: () => [] },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type) => windowListeners.push(type),
    removeEventListener() {},
    dispatchEvent: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source ?? await fs.readFile(SOURCE_URL, 'utf8'), sandbox, { filename: 'character-controller.js' });
  const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 1.1, 8, BABYLON.Vector3.Zero(), scene);
  return { sandbox, scene, engine, camera, imports, fetches, windowListeners, warnings, document };
}

const PRESET = {
  schema: 'bjs-character-preset/v1',
  keys: { JUMP: ['KeyK'] },
  config: { SPD_SPRINT: 7 },
  animations: { Walk_Loop: { clip: 'Walking', from: 3, to: 21 }, Roll: null },
  customActions: [{ name: 'TAUNT', clip: 'Dance', keys: ['KeyT'] }],
  animationEvents: { Walk_Loop: [{ type: 'footstep', frame: 5, label: 'L' }] },
};

function assertPresetApplied(result) {
  const { animCtrl, charCtrl } = result;
  const walk = animCtrl.g.get('Walk_Loop');
  assert.equal(walk.name, 'Walking__Walk_Loop');
  assert.equal(walk.from, 3);
  assert.equal(walk.to, 21);
  assert.equal(animCtrl.g.has('Roll'), false);
  assert.equal(animCtrl.g.get('TAUNT').name, 'Dance__TAUNT');
  assert.deepEqual([...charCtrl.keyBindings.TAUNT], ['KeyT']);
  assert.deepEqual([...charCtrl.keyBindings.JUMP], ['KeyK']);
  assert.equal(charCtrl.SPD_SPRINT, 7);
  assert.equal(charCtrl.animationEvents.Walk_Loop[0].type, 'footstep');
}

const SHAPE = ['animCtrl', 'charCtrl', 'charRoot', 'playerCapsule', 'report', 'scene'];

test('single-GLB path applies options.preset before configure and returns the full shape', async t => {
  const env = await runtime(t);
  const seen = [];
  const result = await env.sandbox.setupCharacter(env.scene, env.camera, false, {
    preset: PRESET, hud: false,
    configure: ({ animCtrl, charRoot, report }) => seen.push(animCtrl.g.get('Walk_Loop').name, charRoot.name, report.mode),
  });
  assert.deepEqual(Object.keys(result).sort(), SHAPE);
  assert.deepEqual(env.imports[0], ['', 'assets/', 'character_animated.glb']);
  assert.deepEqual(seen, ['Walking__Walk_Loop', 'Character_Visual', 'single']);
  assertPresetApplied(result);
  assert.equal(result.report.mode, 'single');
  assert.equal(result.report.preset, 'options');
  assert.deepEqual([...result.report.missing], []);
  assert.ok(result.report.applied.includes('keys') && result.report.applied.includes('animations.Walk_Loop'));
  assert.equal(result.playerCapsule.name, 'playerCapsule');
  assert.equal(result.playerCapsule.metadata.bjsCharacter, true);
  result.charCtrl.destroy();
});

test('server-merge path applies the same preset (and configure) and returns the same shape', async t => {
  const env = await runtime(t, { server: true });
  let configured = 0;
  const result = await env.sandbox.setupCharacter(env.scene, env.camera, false, {
    preset: PRESET, hud: false, filename: 'hero.glb', animationsFilename: 'anims.glb', serverUrl: 'http://merge.local/',
    configure: ({ animCtrl }) => { configured++; assert.equal(animCtrl.g.get('Walk_Loop').name, 'Walking__Walk_Loop'); },
  });
  assert.deepEqual(Object.keys(result).sort(), SHAPE);
  assert.equal(result.report.mode, 'server');
  assert.equal(configured, 1);
  assert.deepEqual(env.fetches.map(f => f.url), [
    'http://merge.local/api/health', 'assets/hero.glb', 'assets/anims.glb', 'http://merge.local/api/merge',
  ]);
  assert.deepEqual(env.imports[0], ['', '', 'blob:merged', null, '.glb']);
  assertPresetApplied(result);
  result.charCtrl.destroy();
});

test('BAKED_PRESET is applied when no preset option is given; preset:false opts out', async t => {
  const baked = (await fs.readFile(SOURCE_URL, 'utf8'))
    .replace(/^const BAKED_PRESET = null;.*$/m, () => `const BAKED_PRESET = ${JSON.stringify(PRESET)};`);
  assert.notEqual(baked, await fs.readFile(SOURCE_URL, 'utf8'), 'BAKED_PRESET line is replaceable');
  const env = await runtime(t, { source: baked, server: true });
  const viaServer = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false, animationsFilename: 'anims.glb', filename: 'hero.glb' });
  assert.equal(viaServer.report.preset, 'baked');
  assert.equal(viaServer.report.mode, 'server');
  assertPresetApplied(viaServer);
  viaServer.charCtrl.destroy();

  const single = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false, name: 'two' });
  assertPresetApplied(single);
  single.charCtrl.destroy();

  const optedOut = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false, preset: false, name: 'three' });
  assert.equal(optedOut.report.preset, null);
  assert.equal(optedOut.animCtrl.g.has('Roll'), true);
  assert.deepEqual([...optedOut.charCtrl.keyBindings.JUMP], ['Space']);
  optedOut.charCtrl.destroy();
});

test('client path (serverMerge:false) fetches URL presets, reports progress and returns the same shape', async t => {
  const env = await runtime(t, { server: true });
  env.sandbox.fetch = async (url) => {
    env.fetches.push({ url });
    if (url === 'presets/hero.json') return { ok: true, json: async () => PRESET };
    throw new Error(`unexpected fetch ${url}`);
  };
  const sources = [];
  env.sandbox.loadRetargetSource = async (_scene, source) => { sources.push(source); return { container: { dispose() {} }, json: null }; };
  env.sandbox.retargetAnimationGroupsClient = () => ({
    groups: ['Idle_Loop', 'Walk_Loop', 'Sprint_Loop', 'Walking', 'Dance'].map(fakeGroup), report: { mapped: 20 },
  });
  const progress = [];
  const result = await env.sandbox.setupCharacter(env.scene, env.camera, false, {
    preset: 'presets/hero.json', onProgress: pct => progress.push(pct), filename: 'hero.glb', animationsFilename: 'anims.glb', serverMerge: false,
  });
  assert.deepEqual(Object.keys(result).sort(), SHAPE);
  assert.deepEqual(env.fetches.map(f => f.url), ['presets/hero.json'], 'serverMerge:false never calls the server');
  assert.deepEqual(sources, ['assets/anims.glb']);
  assert.equal(result.report.mode, 'client');
  assert.equal(result.report.retarget.mapped, 20);
  assert.equal(result.report.preset, 'options');
  assertPresetApplied(result);
  assert.equal(env.document.calls.filter(id => id === 'bar' || id === 'bar-label').length, 0);
  assert.equal(progress[0], 10);
  assert.equal(progress[progress.length - 1], 100);
  result.charCtrl.destroy();
});

test('explicit options win over preset keys/config; preset character fields are defaults', async t => {
  const env = await runtime(t);
  const result = await env.sandbox.setupCharacter(env.scene, env.camera, false, {
    hud: false,
    preset: { ...PRESET, character: { filename: 'from-preset.glb', assetsPath: 'models/', capsuleScale: 2 } },
    keys: { JUMP: ['KeyJ'], TAUNT: ['KeyU'] },
    config: { SPD_SPRINT: 9 },
  });
  assert.deepEqual(env.imports[0], ['', 'models/', 'from-preset.glb']);
  assert.deepEqual([...result.charCtrl.keyBindings.JUMP], ['KeyJ']);
  assert.deepEqual([...result.charCtrl.keyBindings.TAUNT], ['KeyU']);
  assert.equal(result.charCtrl.SPD_SPRINT, 9);
  assert.ok(Math.abs(result.playerCapsule.ellipsoid.y - 0.96 * 2) < 1e-9);
  result.charCtrl.destroy();
});

test('setupCharacter stops only its own animation groups', async t => {
  const env = await runtime(t);
  const level = new BABYLON.AnimationGroup('Level_Door_Loop', env.scene);
  let levelStops = 0;
  level.stop = () => { levelStops++; return level; };
  const result = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false });
  assert.equal(levelStops, 0);
  const dance = result.animCtrl.g.get('Dance');
  assert.ok(dance.stops >= 1, 'the character file\'s own clips are stopped');
  result.charCtrl.destroy();
});

test('input:"none" NPCs add no window listeners and are driven by setMoveInput / pressAction', async t => {
  const env = await runtime(t);
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, env.scene);
  ground.checkCollisions = true;
  const npc = await env.sandbox.setupCharacter(env.scene, null, false, {
    input: 'none', name: 'npc', spawnPosition: new BABYLON.Vector3(0, 0.97, 0),
  });
  const { charCtrl, playerCapsule, charRoot } = npc;
  assert.deepEqual(env.windowListeners, []);
  assert.equal(env.document.calls.length, 0, 'NPCs default to hud:false');
  assert.equal(charCtrl.camera, null);
  assert.equal(charCtrl.CAM_FOLLOW_LOCK, false);
  assert.equal(playerCapsule.name, 'npc_capsule');
  assert.equal(charRoot.name, 'npc_visual');
  const states = [];
  charCtrl.onStateChangedObservable.add(info => states.push(`${info.character}:${info.state}`));
  const step = (n) => { for (let i = 0; i < n; i++) charCtrl._simulate(1 / 60); };
  step(40);
  assert.equal(charCtrl.grounded, true);
  const startZ = playerCapsule.position.z;
  charCtrl.setMoveInput(0, 1);
  step(60);
  assert.equal(charCtrl.state, 'WALK');
  assert.ok(playerCapsule.position.z - startZ > 1, 'moves world-forward (+Z) without a camera');
  charCtrl.pressAction('SPRINT');
  assert.equal(charCtrl.sprinting, true);
  charCtrl.releaseAction('SPRINT');
  step(30);
  assert.equal(charCtrl.state, 'SPRINT');
  charCtrl.pressAction('JUMP');
  assert.equal(charCtrl.state, 'JUMP_START');
  assert.equal(charCtrl.releaseAction('JUMP'), true);
  assert.ok(states.includes('npc:WALK') && states.includes('npc:JUMP_START'));
  charCtrl.setMoveInput(0, 0);
  charCtrl.destroy();
});

test('hud:false never calls document.getElementById; hud "auto" keeps the legacy DOM ids', async t => {
  const env = await runtime(t);
  const quiet = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false });
  const ctrl = quiet.charCtrl;
  ctrl._setState('WALK');
  ctrl._showCombo('JAB');
  ctrl._hideCombo();
  ctrl._simulate(1 / 60);
  ctrl._updateCameraLock();
  quiet.animCtrl.play('Roll', false);
  assert.equal(env.document.calls.length, 0);
  ctrl.destroy();

  const hudState = env.document.element();
  const combo = env.document.element();
  env.document.elements.set('hud-state', hudState);
  env.document.elements.set('combo', combo);
  const loud = await env.sandbox.setupCharacter(env.scene, env.camera, false, { name: 'loud' });
  loud.charCtrl._setState('CROUCH_IDLE');
  loud.charCtrl._showCombo('CROSS!');
  assert.equal(hudState.textContent, 'CROUCH_IDLE');
  assert.equal(combo.textContent, 'CROSS!');
  loud.charCtrl.destroy();
});

test('observables fire whatever the HUD mode; animation events carry the character name', async t => {
  const env = await runtime(t);
  const { charCtrl, animCtrl } = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false, name: 'hero' });
  const got = [];
  charCtrl.onComboObservable.add(e => got.push(`combo:${e.text}:${e.visible}`));
  charCtrl.onSpeedChangedObservable.add(e => got.push(`speed:${e.character}`));
  charCtrl.onAnimationEventObservable.add(e => got.push(`event:${e.type}:${e.animName}:${e.character}`));
  animCtrl.onAnimationChangedObservable.add(e => got.push(`anim:${e.name}`));
  charCtrl._showCombo('JAB');
  charCtrl._hideCombo();
  charCtrl.speed = 2;
  charCtrl._lastNotifiedSpeed = 0;
  charCtrl._simulate(1 / 60);
  animCtrl.play('Dance', false);
  animCtrl._fireAnimationEvent({ type: 'hit', frame: 3 }, 'Dance');
  assert.ok(got.includes('combo:JAB:true') && got.includes('combo::false'));
  assert.ok(got.includes('speed:hero'));
  assert.ok(got.includes('anim:Dance'));
  assert.ok(got.includes('event:hit:Dance:hero'));
  charCtrl.destroy();
});

test('setConfig validates keys and types, getConfig lists every config key', async t => {
  const env = await runtime(t);
  const { charCtrl } = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false, config: { NOT_A_KEY: 1 } });
  assert.ok(env.warnings.some(w => w.includes('unknown key "NOT_A_KEY"')), 'constructor warns about unknown keys');
  const changes = [];
  charCtrl.onConfigChangedObservable.add(e => changes.push(e));
  const applied = charCtrl.setConfig({ SPD_WALK: 3.5, JUMP_CUT: false, GRAV: 'heavy', BOGUS: true, STRIDE_MATCHING: 'full' });
  assert.deepEqual({ ...applied }, { SPD_WALK: 3.5, JUMP_CUT: false, STRIDE_MATCHING: 'full' });
  assert.equal(charCtrl.SPD_WALK, 3.5);
  assert.equal(charCtrl.GRAV, 22);
  charCtrl.setConfig({ BOGUS: false });
  assert.equal(env.warnings.filter(w => w.includes('unknown key "BOGUS"')).length, 1, 'warns once per key');
  assert.equal(env.warnings.filter(w => w.includes('"GRAV" has an invalid value')).length, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].source, 'setConfig');
  const config = charCtrl.getConfig();
  assert.equal(Object.keys(config).length, Object.keys(env.sandbox.DEFAULT_CHAR_CONFIG.PHYSICS).length);
  assert.equal(config.SPD_WALK, 3.5);
  assert.equal(config.STRIDE_MATCHING, 'full');
  charCtrl.setConfig({ PLAY_PARTICLES: false });
  assert.equal(charCtrl.PLAY_PARTICLES, false);
  charCtrl.destroy();
});

test('ground rays skip other characters by flag, not by mesh name', async t => {
  const env = await runtime(t);
  const a = await env.sandbox.setupCharacter(env.scene, env.camera, false, { hud: false, name: 'a' });
  const b = await env.sandbox.setupCharacter(env.scene, null, false, { input: 'none', name: 'b' });
  const floor = BABYLON.MeshBuilder.CreateBox('character_select_floor', {}, env.scene);
  assert.equal(a.charCtrl._isMeshCharacter(b.playerCapsule), true, 'another controller capsule');
  assert.equal(a.charCtrl._isMeshCharacter(b.charRoot.getChildMeshes()[0]), true);
  assert.equal(a.charCtrl._isMeshCharacter(floor), false, 'level mesh named "character…" is walkable');
  floor.metadata = { bjsCharacter: true };
  assert.equal(a.charCtrl._isMeshCharacter(floor), true);
  a.charCtrl.destroy();
  b.charCtrl.destroy();
});

test('createCharacter builds camera + kinematic controller in one call and dispose() cleans up', async t => {
  const env = await runtime(t);
  const before = { meshes: env.scene.meshes.length, cameras: env.scene.cameras.length };
  const player = await env.sandbox.createCharacter(env.scene, {
    model: 'models/hero.glb', physics: false, spawn: [1, 3, 2], preset: PRESET, hud: false,
  });
  assert.deepEqual(env.imports[0], ['', 'models/', 'hero.glb']);
  assert.equal(player.usePhysics, false);
  assert.equal(env.scene.activeCamera, player.camera);
  assert.equal(player.charCtrl.camera, player.camera);
  assert.deepEqual([player.playerCapsule.position.x, player.playerCapsule.position.y, player.playerCapsule.position.z], [1, 3, 2]);
  assertPresetApplied(player);
  const walkClone = player.animCtrl.g.get('Walk_Loop');
  player.dispose();
  player.dispose();
  assert.equal(walkClone.disposed, true);
  assert.equal(env.scene.meshes.length, before.meshes);
  assert.equal(env.scene.cameras.length, before.cameras);
  assert.equal(player.charCtrl._destroyed, true);

  const npc = await env.sandbox.createCharacter(env.scene, { model: 'npc.glb', input: 'none', physics: false, name: 'npc' });
  assert.deepEqual(env.imports[1], ['', 'assets/', 'npc.glb']);
  assert.equal(npc.camera, null);
  npc.dispose();
});
