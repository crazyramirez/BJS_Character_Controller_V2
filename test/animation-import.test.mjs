import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Document } from '@gltf-transform/core';
import { mergeGLBs } from '../js/core/merge_api.mjs';
import { createIO } from './helpers.mjs';

const source = await fs.readFile(new URL('../js/core/builder.js', import.meta.url), 'utf8');

function editor(fetch = async () => { throw new Error('Unexpected request'); }) {
  const events = [];
  const dialog = new EventTarget();
  dialog.showModal = () => events.push('dialog');
  const message = {};
  const context = vm.createContext({
    Blob, File, FormData, URL, fetch, events,
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {} },
    document: {
      getElementById(id) { return id === 'animation-import-dialog' ? dialog : message; },
      createElement() { return { click() { events.push('download'); } }; },
    },
    localStorage: { getItem() { return null; } },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(`
    for (const name of ['showLoading', 'hideLoading', 'resetLoaderSteps', 'setLoaderStep',
      'showMergeProgress', 'completeMergeProgress', 'renderAnimationLibrary',
      'renderAnimationsMappingTab', 'renderCustomAnimationsTab', 'renderAnimationEventsTab',
      'updateExportCode', 'autoMapAnimations', 'updateSkeletonInfoAfterMerge']) {
      globalThis[name] = () => events.push(name);
    }
    showToast = message => events.push(message);
    characterGlbBuffer = new Uint8Array([1]).buffer;
    originalCharacterGlbBuffer = new Uint8Array([2]).buffer;
    animationsGlbBuffer = new Uint8Array([3]).buffer;
    detectedAnimations = ['Idle', 'Walk'];
    _loadGlbIntoScene = async () => { detectedAnimations = ['Idle', 'Walk', 'Jump']; };
    isServerAvailable = true;
  `);
  return {
    run, events, message,
    choose(value) { dialog.returnValue = value; dialog.dispatchEvent(new Event('close')); },
  };
}

test('import waits for a choice; cancel preserves state and permits reopening', async () => {
  const { run, events, choose, message } = editor();
  run(`maybeConvertFbxFile = async () => { throw new Error('Should not convert on cancel'); };`);
  const first = run(`loadAnimationBatchFile(new File(['x'], 'walk.fbx'))`);
  assert.match(message.textContent, /walk.fbx/);
  assert.equal(run('animationImportInProgress'), true);
  await run(`addSingleAnimationFile(new File(['x'], 'jump.glb'))`);
  assert.deepEqual(events, ['dialog']);
  choose('cancel');
  await first;
  assert.equal(run('animationImportInProgress'), false);
  assert.equal(run('new Uint8Array(animationsGlbBuffer)[0]'), 3);
  assert.equal(run('detectedAnimations.join()'), 'Idle,Walk');
  const second = run(`addSingleAnimationFile(new File(['x'], 'jump.glb'))`);
  choose(''); // Escape closes with no import choice.
  await second;
  assert.equal(run('animationImportInProgress'), false);
  assert.equal(events.filter(event => event === 'dialog').length, 2);
});

for (const mode of ['replace', 'merge']) {
  test(`${mode} selects the correct source and keeps the full result for export`, async () => {
    const requests = [];
    const { run, choose } = editor(async (_url, { body }) => {
      requests.push({
        character: new Uint8Array(await body.get('character').arrayBuffer())[0],
        animations: new Uint8Array(await body.get('animations').arrayBuffer())[0],
        options: JSON.parse(body.get('options')),
      });
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
    });
    const pending = run(`loadAnimationBatchFile(new File([new Uint8Array([4])], 'jump.glb'))`);
    choose(mode);
    await pending;
    assert.equal(requests[0].character, mode === 'replace' ? 2 : 1);
    assert.equal(requests[0].options.removeExistingAnimations, mode === 'replace');
    assert.deepEqual(requests[0].options.existingAnimationNames, ['Idle', 'Walk']);
    assert.equal(run('characterGlbBuffer === animationsGlbBuffer'), true);
    await run('downloadCharacterGlbFile()');
    assert.equal(requests[1].animations, 9, 'export must include the complete imported library');
  });
}

test('an empty library imports directly, removing animations hidden in the original GLB', async () => {
  let options;
  const { run, events } = editor(async (_url, { body }) => {
    options = JSON.parse(body.get('options'));
    return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer };
  });
  run('detectedAnimations = [];');
  await run(`loadAnimationBatchFile(new File(['x'], 'jump.glb'))`);
  assert.ok(!events.includes('dialog'));
  assert.equal(options.removeExistingAnimations, true);
});

function offlineEditor() {
  const result = editor();
  result.run(`
    function group(name) {
      return { name, targetedAnimations: [{ target: { name: 'Hips' }, animation: { targetProperty: 'rotationQuaternion' } }],
        stop() {}, dispose() { this.disposed = true; } };
    }
    const oldIdle = group('Idle'), oldWalk = group('Walk');
    const container = { animationGroups: [group('New|Walk'), group('Jump')], dispose() {} };
    scene = { skeletons: [] };
    globalThis.normBone = name => name.toLowerCase();
    globalThis.AnimCtrl = class {
      constructor(groups) { this.g = new Map(groups.map(g => [g.name, g])); }
      destroy() { this.destroyed = true; }
    };
    activeCharacter = { rawAnimationGroups: [oldIdle, oldWalk],
      animCtrl: new AnimCtrl([oldIdle, oldWalk]), charCtrl: {}, charRoot: {} };
    // character-controller.js provides the shared client retargeter.
    globalThis.loadRetargetSource = async () => ({ container, json: null });
    globalThis.retargetAnimationGroupsClient = (_scene, _root, source) => ({
      groups: source.animationGroups.map(g => group(g.name.split('|').pop())),
      report: { skipped: [] },
    });
  `);
  return result;
}

for (const replace of [true, false]) {
  test(`offline ${replace ? 'replace' : 'merge'} updates clips and controller references`, async () => {
    const { run, events } = offlineEditor();
    await run(`loadAnimationsOffline(new ArrayBuffer(1), 'jump.glb', ${replace})`);
    assert.equal(run('detectedAnimations.join()'), replace ? 'Walk,Jump' : 'Idle,Walk,Jump');
    assert.equal(run('!!oldIdle.disposed'), replace);
    assert.equal(run('oldWalk.disposed'), true);
    assert.equal(run('activeCharacter.charCtrl.anim === activeCharacter.animCtrl'), true);
    assert.ok(events.includes('renderAnimationLibrary'));
  });
}

test('a failed offline replacement leaves existing clips intact', async () => {
  const { run } = offlineEditor();
  run('container.animationGroups = [];');
  await assert.rejects(run(`loadAnimationsOffline(new ArrayBuffer(1), 'empty.glb', true)`), /No animation groups/);
  assert.equal(run('!!oldIdle.disposed || !!oldWalk.disposed'), false);
  assert.equal(run('detectedAnimations.join()'), 'Idle,Walk');
});

test('server fallback uses the chosen mode and failed imports retain the previous source', async () => {
  const { run, choose } = editor(async () => ({ ok: false, json: async () => ({ error: 'Unavailable' }) }));
  run(`loadAnimationsOffline = async (_buffer, _name, replace) => {
    events.push(replace ? 'replace' : 'merge');
    throw new Error('Invalid animation file');
  };`);
  const pending = run(`loadAnimationBatchFile(new File(['x'], 'jump.glb'))`);
  choose('replace');
  await pending;
  assert.equal(run(`events.includes('replace')`), true);
  assert.equal(run('new Uint8Array(animationsGlbBuffer)[0]'), 3);
});

async function clips(names) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const hips = doc.createNode('Hips');
  doc.createScene().addChild(hips);
  for (const [name, duration] of names) {
    const input = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Float32Array([0, duration]));
    const output = doc.createAccessor().setType('VEC4').setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]));
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
    doc.createAnimation(name).addSampler(sampler).addChannel(doc.createAnimationChannel()
      .setTargetNode(hips).setTargetPath('rotation').setSampler(sampler));
  }
  return (await createIO()).writeBinary(doc);
}

test('GLB merging preserves clips across imports, replaces duplicate names and honors replacement', async () => {
  const io = await createIO();
  const base = await clips([['Idle', 1], ['Old|Walk', 1], ['Deleted', 1]]);
  const incoming = await clips([['New|Walk', 3], ['Jump', 2]]);
  const options = { COMPRESS_OUTPUT: false, removeExistingAnimations: false, requireAnimations: true };
  const merged = await mergeGLBs(base, incoming, { ...options, existingAnimationNames: ['Idle', 'Walk'] });
  const doc = await io.readBinary(merged);
  assert.deepEqual(doc.getRoot().listAnimations().map(ag => ag.getName()), ['Idle', 'New|Walk', 'Jump']);
  const walk = doc.getRoot().listAnimations()[1];
  assert.equal(walk.listSamplers()[0].getInput().getArray().at(-1), 3);
  const next = await mergeGLBs(merged, await clips([['Run', 2]]), options);
  const nextDoc = await io.readBinary(next);
  assert.deepEqual(nextDoc.getRoot().listAnimations().map(ag => ag.getName()), ['Idle', 'New|Walk', 'Jump', 'Run']);
  const replaced = await mergeGLBs(next, incoming, { ...options, removeExistingAnimations: true });
  assert.deepEqual((await io.readBinary(replaced)).getRoot().listAnimations().map(ag => ag.getName()), ['New|Walk', 'Jump']);
  await assert.rejects(mergeGLBs(base, await clips([]), options), /No usable animations/);
});
