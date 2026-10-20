import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { mergeGLBs } from '../js/core/merge_api.mjs';
import { encodeAutoRigReport, startServer } from '../server.mjs';
import { runProcessingJob } from '../js/core/processing_jobs.mjs';
import { createIO } from './helpers.mjs';

const source = await fs.readFile(new URL('../js/core/builder.js', import.meta.url), 'utf8');

function builder({ fetch = async () => { throw new Error('Unexpected request'); }, controllerDefaults = null } = {}) {
  const events = [];
  const context = vm.createContext({
    AbortController, Blob, File, FormData, URL, TextEncoder, TextDecoder, fetch, events,
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {} },
    document: { getElementById() { return null; }, createElement() { return { click() { events.push('download'); } }; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout, clearTimeout,
  });
  if (controllerDefaults) vm.runInContext(`const DEFAULT_CHAR_CONFIG = ${JSON.stringify(controllerDefaults)};`, context);
  vm.runInContext(source, context);
  vm.runInContext(`
    for (const name of ['showLoading', 'hideLoading', 'showMergeProgress', 'completeMergeProgress']) globalThis[name] = () => {};
    showToast = (message) => events.push(message);
  `, context);
  return { events, run: code => vm.runInContext(code, context) };
}

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    entries.push({ name, crc, data });
    offset += 30 + nameLength + size;
  }
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  assert.equal(view.getUint16(end + 10, true), entries.length);
  assert.equal(view.getUint32(end + 16, true), offset, 'central directory follows the entries');
  return entries;
}

test('the character preset carries mappings, explicit none, actions, events and the full physics config', () => {
  const { run } = builder({ controllerDefaults: { PHYSICS: { GRAV: 22, COYOTE_TIME: 0.12, MANTLE_ENABLED: true } } });
  run(`
    detectedAnimations = ['Idle', 'Walk', 'Wave'];
    animMappings.Idle_Loop = { animName: 'Idle', from: 0, to: 60 };
    animMappings.Walk_Loop = { animName: 'Walk', from: 5, to: 40 };
    animMappings.Roll = { animName: 'None', from: 0, to: 100 };
    customAnimations = [{ name: 'WAVE', animName: 'Wave', keyTrigger: ['KeyT'] }, { name: 'UNUSED', animName: 'None', keyTrigger: [] }];
    animationEvents = { Walk_Loop: [{ type: 'footstep', frame: 7, label: '' }], Roll: [{ type: 'hit', frame: 2, label: '' }] };
    physicsConfig.GRAV = 30;
    characterFilename = 'hero.fbx';
  `);
  const merged = JSON.parse(run('JSON.stringify(buildCharacterPreset("merged"))'));
  assert.equal(merged.schema, 'bjs-character-preset/v1');
  assert.equal(merged.character.filename, 'character_animated.glb');
  assert.equal(merged.character.animationsFilename, undefined);
  assert.deepEqual(merged.animations.Walk_Loop, { clip: 'Walk', from: 5, to: 40 });
  assert.equal(merged.animations.Roll, null, 'explicit None travels as null');
  assert.deepEqual(merged.customActions, [{ name: 'WAVE', clip: 'Wave', keys: ['KeyT'] }]);
  assert.deepEqual(Object.keys(merged.animationEvents), ['Walk_Loop'], 'events of unmapped slots are dropped');
  assert.equal(merged.config.GRAV, 30, 'builder values win');
  assert.equal(merged.config.COYOTE_TIME, 0.12, 'controller-only keys are kept');
  assert.equal(merged.config.MANTLE_ENABLED, true);

  const runtime = JSON.parse(run('JSON.stringify(buildCharacterPreset("runtime"))'));
  assert.equal(runtime.character.filename, 'hero.glb');
  assert.equal(runtime.character.animationsFilename, 'animations.glb');
});

test('the baked controller fills BAKED_PRESET and keeps every default key', async () => {
  const controller = `'use strict';
const DEFAULT_CHAR_CONFIG = {
  KEYS: { JUMP: ['Space'] },
  PHYSICS: {
    GRAV: 22,
    COYOTE_TIME: 0.12,
  },
  TOUCH: { zoneId: 'joystick-zone' }
};
const BAKED_PRESET = null; // replaced by Builder "Download controller"
function setupCharacter() {}
`;
  const { run } = builder({
    controllerDefaults: { PHYSICS: { GRAV: 22, COYOTE_TIME: 0.12 } },
    fetch: async url => {
      assert.match(url, /^js\/character-controller\.js/);
      return { ok: true, text: async () => controller };
    },
  });
  run(`detectedAnimations = ['Idle']; animMappings.Idle_Loop = { animName: 'Idle', from: 0, to: 30 }; physicsConfig.GRAV = 9;`);
  const baked = await run('buildBakedControllerSource()');
  assert.doesNotMatch(baked, /const BAKED_PRESET = null;/);
  const sandbox = {};
  vm.runInNewContext(`${baked}\nthis.preset = JSON.stringify(BAKED_PRESET); this.config = DEFAULT_CHAR_CONFIG;`, sandbox);
  const preset = JSON.parse(sandbox.preset);
  assert.equal(preset.schema, 'bjs-character-preset/v1');
  assert.deepEqual(preset.animations.Idle_Loop, { clip: 'Idle', from: 0, to: 30 });
  assert.equal(sandbox.config.PHYSICS.GRAV, 9);
  assert.equal(sandbox.config.PHYSICS.COYOTE_TIME, 0.12, 'keys the builder does not tune survive the bake');
});

test('baking the real controller produces a valid script whose setup applies the preset', async () => {
  const controller = await fs.readFile(new URL('../js/character-controller.js', import.meta.url), 'utf8');
  assert.match(controller, /^const BAKED_PRESET = null;/m, 'runtime keeps the line the Builder replaces');
  const { run } = builder({ fetch: async () => ({ ok: true, text: async () => controller }) });
  run(`detectedAnimations = ['Idle']; animMappings.Idle_Loop = { animName: 'Idle', from: 0, to: 30 };`);
  const baked = await run('buildBakedControllerSource()');
  assert.doesNotThrow(() => new vm.Script(baked, { filename: 'custom-character-controller.js' }));
  assert.match(baked, /const BAKED_PRESET = \{/);
  assert.match(baked, /"clip": "Idle"/);
  assert.match(baked, /function applyCharacterPreset/);
  assert.match(baked, /function createCharacter/);
});

test('the export zip holds every file intact with valid CRCs', async () => {
  const { run } = builder();
  const blob = run(`createZipBlob([
    { name: 'assets/character_animated.glb', data: new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0]).buffer },
    { name: 'README.txt', data: 'hola ñ' },
    { name: 'js/custom-character-controller.js', data: 'const x = 1;' },
  ], new Date(2026, 9, 20, 12, 30, 10))`);
  const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(entries.map(e => e.name), ['assets/character_animated.glb', 'README.txt', 'js/custom-character-controller.js']);
  for (const entry of entries) assert.equal(entry.crc, zlib.crc32(entry.data), entry.name);
  assert.equal(new TextDecoder().decode(entries[1].data), 'hola ñ');
});

test('deleted clips are excluded from later merges until they are imported again', () => {
  const { run } = builder();
  run(`
    activeCharacter = null;
    detectedAnimations = ['Idle', 'Walk'];
    renderAnimationLibrary = renderAnimationsMappingTab = renderCustomAnimationsTab = () => {};
    deleteAnimation('Walk');
  `);
  assert.deepEqual(JSON.parse(run('JSON.stringify(getMergeOptions().excludeAnimationNames)')), ['Walk']);
  run(`glbAnimationNames = () => ['Walk']; deletedAnimationNames.delete('Walk');`);
  assert.equal(run('getMergeOptions().excludeAnimationNames'), undefined);
});

test('offline GLB export refuses browser-only retargeted clips instead of exporting without them', async () => {
  const { run, events } = builder();
  run(`isServerAvailable = false; characterGlbBuffer = new ArrayBuffer(4); clientRetargetedAnimations = true;`);
  await run('downloadCharacterGlbFile()');
  assert.ok(!events.includes('download'));
  assert.ok(events.some(message => /Runtime Retargeting/.test(message)));
  run('clientRetargetedAnimations = false;');
  await run('downloadCharacterGlbFile()');
  assert.ok(events.includes('download'), 'models without browser-only clips still export offline');
});

test('excluded animation names are removed from the merged GLB', async () => {
  const io = await createIO();
  const sourceBuffer = await fs.readFile(new URL('../assets/character_animated.glb', import.meta.url));
  const before = (await io.readBinary(new Uint8Array(sourceBuffer))).getRoot().listAnimations()
    .map(anim => anim.getName().split('|').pop().trim());
  const victim = before.find(name => !/t[_-]?pose/i.test(name));
  assert.ok(victim, 'fixture has animations');
  const output = await mergeGLBs(sourceBuffer, null, { COMPRESS_OUTPUT: false, excludeAnimationNames: [victim] });
  const after = (await io.readBinary(new Uint8Array(output))).getRoot().listAnimations()
    .map(anim => anim.getName().split('|').pop().trim());
  assert.ok(!after.includes(victim));
  assert.equal(after.length, before.length - before.filter(name => name === victim).length);
});

test('processing jobs stream worker stages to onProgress', async () => {
  const stages = [];
  const file = await fs.readFile(new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url));
  await runProcessingJob('analyze', { file }, { onProgress: progress => stages.push(progress.stage) });
  assert.ok(stages.includes('analyze'));
});

test('tagged jobs are visible on /api/progress while they run and after they finish', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/progress/unknown-job-1`)).status, 404);
  assert.equal((await fetch(`${base}/api/progress/bad`)).status, 404);
  const file = await fs.readFile(new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url));
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'model/gltf-binary' }), 'prisioner_hostage.glb');
  const response = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'X-Job-Id': 'test-job-0001' }, body: form });
  assert.equal(response.status, 200);
  const progress = await (await fetch(`${base}/api/progress/test-job-0001`)).json();
  assert.equal(progress.kind, 'analyze');
  assert.equal(progress.done, true);
  assert.equal(progress.fraction, 1);
  assert.ok(progress.elapsedMs >= 0);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.progress, true);
  assert.match(health.version, /^\d+\.\d+\.\d+/);
});

test('auto-rig report header carries the verdict, review joints and a compact deformation summary', () => {
  const encoded = encodeAutoRigReport({
    score: 91, verdict: 'review', confidence: 0.62,
    reviewJoints: ['LeftForeArm', 'LeftHand'], reviewReasons: ['Left elbow bends unevenly in the stress poses.'],
    deformation: {
      score: 0.8, poses: [{ name: 'squat', huge: new Array(1000).fill(1) }],
      worst: { pose: 'arms-up', stretch: 1.9, nested: { dropped: true } },
      regions: { LeftForeArm: { score0to1: 0.41, issues: ['candy-wrapper at 90° twist'] } },
    },
  });
  const report = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(report.verdict, 'review');
  assert.equal(report.confidence, 0.62);
  assert.deepEqual(report.reviewJoints, ['LeftForeArm', 'LeftHand']);
  assert.equal(report.deformation.regions.LeftForeArm.score, 0.41);
  assert.deepEqual(report.deformation.worst, { pose: 'arms-up', stretch: 1.9 });
  assert.equal(report.deformation.poses, undefined, 'per-pose arrays stay out of the header');
});
