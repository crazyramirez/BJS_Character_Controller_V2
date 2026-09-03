import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../js/core/builder.js', import.meta.url), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function editor(fetch) {
  const events = [];
  const context = vm.createContext({
    AbortController, Blob, File, FormData, fetch,
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {} },
    document: { getElementById() { return null; } },
    localStorage: { getItem() { return null; } },
    setTimeout, clearTimeout, events,
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    showLoading = () => {};
    hideLoading = () => {};
    showMergeProgress = () => {};
    completeMergeProgress = () => {};
    showToast = (message) => events.push(message);
    exitRigViewportMode = () => {};
    syncCharTransformToUI = () => {};
    readAutoRigReport = () => ({});
    loadCharacterMeshFile = async () => events.push('reload');
    scene = {};
    isServerAvailable = true;
    activeCharacter = {};
    characterGlbBuffer = new ArrayBuffer(8);
    originalCharacterGlbBuffer = characterGlbBuffer;
    const fixtureState = {
      sourceBuffer: characterGlbBuffer,
      layoutOptions: { bodyPlan: 'humanoid', fingerCount: 5 },
      markers: new Map([['Hips', { position: { x: 0, y: 1, z: 0 }, dispose() {} }]]),
      serverGuess: { Hips: [0, 1, 0] },
    };
    autoRigState = fixtureState;
    lastAppliedRig = { previous: true };
  `, context);
  return { context, events, run: code => vm.runInContext(code, context) };
}

test('server errors preserve editor markers and allow retry without committing a layout', async () => {
  const { run, events } = editor(async () => ({ ok: false, json: async () => ({ error: 'Collapsed joint' }) }));
  await run('applyAutoRig()');
  assert.equal(run('autoRigState === fixtureState'), true);
  assert.equal(run('autoRigRequest'), null);
  assert.equal(run('lastAppliedRig.previous'), true);
  assert.ok(events.some(message => message.includes('Collapsed joint')));
  assert.ok(!events.includes('reload'));
});

test('double Apply submits once; cancelling ignores a late successful response', async () => {
  const pending = deferred();
  let requests = 0;
  let signal;
  const { run, events } = editor(async (_url, options) => {
    requests++;
    signal = options.signal;
    return pending.promise;
  });
  const first = run('applyAutoRig()');
  await run('applyAutoRig()');
  assert.equal(requests, 1);
  run('cancelAutoRigAdjust()');
  assert.equal(signal.aborted, true);
  pending.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(12) });
  await first;
  assert.ok(!events.includes('reload'));
  assert.equal(run('lastAppliedRig.previous'), true);
});

test('outdated analyses never replace the current editor or show stale errors', async () => {
  const pending = [deferred(), deferred()];
  let requests = 0;
  const signals = [];
  const { run, events } = editor(async (_url, options) => {
    signals.push(options.signal);
    return pending[requests++].promise;
  });
  const first = run('startAutoRigAdjust()');
  const second = run('startAutoRigAdjust()');
  assert.equal(signals[0].aborted, true);
  pending[0].resolve({ ok: false, json: async () => ({ error: 'Stale error' }) });
  await first;
  assert.equal(run('autoRigState === fixtureState'), true);
  assert.equal(run('autoRigRequest.kind'), 'analyze');
  run('cancelAutoRigAdjust()');
  pending[1].resolve({ ok: true, json: async () => ({ joints: {} }) });
  await second;
  assert.equal(run('autoRigState'), null);
  assert.ok(!events.some(message => message.includes('Stale error')));
});

test('changing the mesh selection requires analysis before Apply', async () => {
  let requests = 0;
  const { run } = editor(async () => { requests++; });
  run("autoRigBodyMeshIds = ['mesh-2']");
  await run('applyAutoRig()');
  assert.equal(requests, 0);
  assert.equal(run('autoRigState === fixtureState'), true);
});

test('successful Apply commits layout only after the model reload succeeds', async () => {
  const reload = deferred();
  const { run, context } = editor(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(12) }));
  context.reload = reload.promise;
  run('loadCharacterMeshFile = async () => { await reload; }');
  const applying = run('applyAutoRig()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('lastAppliedRig.previous'), true);
  reload.resolve();
  await applying;
  assert.equal(run('lastAppliedRig.joints.Hips[1]'), 1);
  assert.equal(run('autoRigRequest'), null);
});
