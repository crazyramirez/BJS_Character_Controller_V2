import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../js/core/builder.js', import.meta.url), 'utf8');

function editor(storage = new Map()) {
  const snapshots = [];
  const requests = [];
  const context = vm.createContext({
    AbortController, Blob, File, FormData, snapshots,
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {} },
    document: { getElementById() { return null; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    fetch: async url => {
      requests.push(url);
      if (url === '/api/analyze') return { ok: true, json: async () => ({}) };
      if (url === '/api/autorig') return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      if (url === '/api/merge') return { ok: true, arrayBuffer: async () => new Uint8Array([2]).buffer };
      throw new Error(`Unexpected request: ${url}`);
    },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(`
    const renderActualMappings = renderAnimationsMappingTab;
    for (const name of ['showLoading', 'hideLoading', 'resetLoaderSteps', 'setLoaderStep',
      'showMergeProgress', 'completeMergeProgress', 'showToast', 'exitRigViewportMode',
      'syncCharTransformToUI', 'renderSkeletonSection', 'renderAnimationsMappingTab',
      'renderAnimationLibrary', 'renderCustomAnimationsTab', 'renderAnimationEventsTab']) {
      globalThis[name] = () => {};
    }
    readAutoRigReport = () => ({ mode: 'adjust', adjustedJoints: 1 });
    scene = { skeletons: [] };
    isServerAvailable = true;
    characterGlbBuffer = new ArrayBuffer(8);
    originalCharacterGlbBuffer = characterGlbBuffer;
    animationsGlbBuffer = new ArrayBuffer(8);
    function loadClips(names) {
      detectedAnimations = names;
      activeCharacter = {
        rawAnimationGroups: names.map(name => ({ name: 'Rig|' + name, from: 0, to: 120,
          stop() {}, setWeightForAllAnimatables() {} })),
        animCtrl: {
          g: new Map(),
          play() {},
          setAnimation(key, group) { this.g.set(key, { ...group }); },
          setAnimationRanges(key, from, to) { Object.assign(this.g.get(key), { from, to }); },
        },
        charCtrl: { keyBindings: {} },
      };
      autoMapAnimations();
      updateExportCode();
    }
    _loadGlbIntoScene = async buffer => {
      // Apply Rig loads a bare rig, then reloads the merged animation library.
      loadClips(new Uint8Array(buffer)[0] === 1 ? [] : ['Idle', 'Walk', 'Sprint', 'Take 001']);
      snapshots.push(JSON.parse(JSON.stringify(animMappings)));
    };
    function prepareRigEdit() {
      autoRigState = {
        sourceBuffer: characterGlbBuffer,
        layoutOptions: { bodyPlan: 'humanoid', fingerCount: 5 },
        markers: new Map([['Hips', { position: { x: 0, y: 1, z: 0 }, dispose() {} }]]),
        serverGuess: { Hips: [0, 1, 0] },
      };
    }
  `);
  return { run, context, storage, snapshots, requests };
}

test('Apply Rig preserves edited standard clips, frame ranges and disabled actions through both reloads', async () => {
  const { run, snapshots, requests } = editor();
  run(`
    loadClips(['Idle', 'Walk', 'Sprint', 'Take 001']);
    animMappings.Walk_Loop = { animName: 'Take 001', from: 17, to: 43 };
    animMappings.Sprint_Loop = { animName: 'Take 001', from: 52, to: 89 };
    animMappings.Idle_Loop = { animName: 'None', from: 0, to: 100 };
    prepareRigEdit();
  `);
  await run('applyAutoRig()');
  assert.deepEqual(requests, ['/api/autorig', '/api/analyze', '/api/merge', '/api/analyze']);
  assert.equal(snapshots.length, 2);
  for (const state of snapshots) {
    assert.equal(state.Walk_Loop.animName, 'Take 001');
    assert.equal(state.Walk_Loop.from, 17);
    assert.equal(state.Walk_Loop.to, 43);
    assert.equal(state.Sprint_Loop.from, 52);
    assert.equal(state.Sprint_Loop.to, 89);
    assert.equal(state.Idle_Loop.animName, 'None');
  }
  assert.equal(run("activeCharacter.animCtrl.g.get('Walk_Loop').from"), 17);
  assert.equal(run("activeCharacter.animCtrl.g.get('Sprint_Loop').to"), 89);
  assert.equal(run("activeCharacter.animCtrl.g.has('Idle_Loop')"), false);
});

test('automatic empty mappings can still discover clips when animations arrive', () => {
  const { run } = editor();
  run(`loadClips([]); loadClips(['Idle', 'Walk', 'Sprint']);`);
  assert.equal(run('animMappings.Walk_Loop.animName'), 'Walk');
  assert.equal(run('animMappings.Walk_Loop.to'), 120);
});

test('saved edits survive starting with an empty scene and are persisted without an export preview', () => {
  const storage = new Map([['builder_anim_mappings', JSON.stringify({
    Walk_Loop: { animName: 'Take 001', from: 18, to: 49 },
    Sprint_Loop: { animName: 'None', from: 0, to: 100 },
  })]]);
  const first = editor(storage);
  first.run(`loadPreferences(); loadClips([]);`);
  assert.equal(JSON.parse(storage.get('builder_anim_mappings')).Walk_Loop.from, 18);
  first.run(`animMappings.Walk_Loop.from = 19; updateExportCode();`);
  assert.equal(JSON.parse(storage.get('builder_anim_mappings')).Walk_Loop.from, 19);
  const reopened = editor(storage);
  reopened.run(`loadPreferences(); loadClips(['Idle', 'Walk', 'Sprint', 'Take 001']);`);
  assert.equal(reopened.run('animMappings.Walk_Loop.animName'), 'Take 001');
  assert.equal(reopened.run('animMappings.Walk_Loop.from'), 19);
  assert.equal(reopened.run('animMappings.Walk_Loop.to'), 49);
  assert.equal(reopened.run('animMappings.Sprint_Loop.animName'), 'None');
  assert.equal(reopened.run('animMappings.Idle_Loop.animName'), 'Idle');
});

test('imported config retains mappings to clips not loaded yet', () => {
  const { run } = editor();
  run(`
    loadClips(['Idle', 'Walk']);
    animMappings = normalizeImportedAnimationMappings({
      Walk_Loop: { animName: 'Take 001', from: 10, to: 60 },
      Sprint_Loop: { animName: 'None', from: 0, to: 100 },
    });
    autoMapAnimations();
  `);
  assert.equal(run('animMappings.Walk_Loop.animName'), 'Take 001');
  assert.equal(run("activeCharacter.animCtrl.g.has('Walk_Loop')"), false, 'missing clips must not leave stale aliases playing');
  run(`loadClips(['Idle', 'Walk', 'Sprint', 'Take 001']);`);
  assert.equal(run("activeCharacter.animCtrl.g.get('Walk_Loop').from"), 10);
  assert.equal(run('animMappings.Sprint_Loop.animName'), 'None');
});

// Minimal DOM surface for invoking the real mapping tab's change handlers.
function mappingControls({ context, run }) {
  const rows = [];
  const container = {
    set innerHTML(_value) { rows.length = 0; },
    appendChild(row) { rows.push(row); },
    querySelectorAll(selector) { return rows.flatMap(row => row.controls[selector] || []); },
  };
  context.document.getElementById = id => id === 'animations-mapping-list' ? container : null;
  context.document.createElement = () => ({
    controls: {},
    set innerHTML(html) {
      this.html = html;
      this.key = html.match(/data-key="([^"]+)"/)[1];
      const control = className => ({
        dataset: { key: this.key },
        classList: { contains: name => name === className },
        addEventListener(type, listener) { this[type] = listener; },
        closest: () => this,
      });
      this.controls['.mapping-select'] = [control('mapping-select')];
      this.controls['.frame-input'] = [control('frame-from'), control('frame-to')];
    },
    querySelector(selector) { return this.controls['.frame-input'][selector === '.frame-from' ? 0 : 1]; },
  });
  run('renderActualMappings();');
  return {
    rows,
    change(key, selector, value) {
      const row = rows.find(row => row.key === key);
      const input = selector === '.mapping-select' ? row.controls[selector][0] : row.querySelector(selector);
      input.value = value;
      input.change({ target: input });
    },
  };
}

test('editing the mapping controls persists manual ranges and None through subsequent reloads', () => {
  const state = editor();
  const { run, storage } = state;
  run(`loadClips(['Idle', 'Walk', 'Sprint', 'Take 001']);`);
  const controls = mappingControls(state);
  controls.change('Walk_Loop', '.mapping-select', 'Take 001');
  controls.change('Walk_Loop', '.frame-from', '22');
  controls.change('Walk_Loop', '.frame-to', '73');
  controls.change('Sprint_Loop', '.frame-to', '87'); // Editing only the range must count as manual.
  controls.change('Idle_Loop', '.mapping-select', 'None');
  assert.equal(JSON.parse(storage.get('builder_anim_mappings')).Walk_Loop.to, 73);
  run(`loadClips([]); loadClips(['Idle', 'Walk', 'Sprint', 'Take 001']);`);
  assert.equal(run('animMappings.Walk_Loop.animName'), 'Take 001');
  assert.equal(run('animMappings.Walk_Loop.from'), 22);
  assert.equal(run('animMappings.Walk_Loop.to'), 73);
  assert.equal(run('animMappings.Sprint_Loop.to'), 87);
  assert.equal(run('animMappings.Idle_Loop.animName'), 'None');
});

test('temporarily missing clips stay visible with their saved ranges; reset opts back into auto-mapping', () => {
  const state = editor();
  const { run } = state;
  run(`
    animMappings.Walk_Loop = { animName: 'Take "A"', from: 14, to: 48 };
    loadClips([]);
  `);
  const { rows } = mappingControls(state);
  const html = rows.find(row => row.key === 'Walk_Loop').html;
  assert.match(html, /selected>Take &quot;A&quot; \(not loaded\)/);
  assert.match(html, /value="14"/);
  assert.match(html, /value="48"/);
  run(`resetSingleAnimMapping('Walk_Loop'); loadClips(['New Walk']);`);
  assert.equal(run('animMappings.Walk_Loop.animName'), 'New Walk');
  assert.equal(run('animMappings.Walk_Loop.from'), 0);
  assert.equal(run('animMappings.Walk_Loop.to'), 120);
});

test('saving other settings before initial loading does not erase pending animation preferences', () => {
  const storage = new Map([['builder_anim_mappings', JSON.stringify({
    Walk_Loop: { animName: 'Take 001', from: 18, to: 49 },
  })]]);
  const { run } = editor(storage);
  run('loadPreferences(); updateExportCode();');
  assert.equal(JSON.parse(storage.get('builder_anim_mappings')).Walk_Loop.from, 18);
});
