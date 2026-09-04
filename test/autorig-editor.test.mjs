import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../js/core/builder.js', import.meta.url), 'utf8');

test('marker binding uses the imported bone identity after FBX suffix removal', () => {
  const { run } = editor(async () => {});
  assert.equal(run(`(() => {
    const lower = {}, middle = {}, leg = {}, finger = {};
    const names = new Map([['spine1', lower], ['spine2', middle], ['l leg', leg], ['r index3', finger], ['LeftHandIndex3', finger]]);
    const norms = new Map([...names].map(([name, node]) => [boneRoleNorm(name), node]));
    const sources = { Spine: 'spine1_01', Spine1: 'spine2_02', LeftUpLeg: 'l leg_047', RightHandIndex3: 'r index3_017' };
    return resolveAutoRigBone('Spine', sources, names, norms) === lower
      && resolveAutoRigBone('Spine1', sources, names, norms) === middle
      && resolveAutoRigBone('LeftUpLeg', sources, names, norms) === leg
      && resolveAutoRigBone('RightHandIndex3', sources, names, norms) === finger
      && resolveAutoRigBone('LeftHandIndex3', { LeftHandIndex3: '65_065' }, names, norms) === finger;
  })()`), true);
});
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

for (const [mode, expected] of [['auto', 'auto'], ['off', false], ['manual', true]]) {
  test(`finger skinning mode ${mode} reaches the server`, async () => {
    let submitted;
    const { run } = editor(async (_url, options) => {
      submitted = JSON.parse(options.body.get('options'));
      return { ok: false, json: async () => ({ error: 'Stop after inspecting options' }) };
    });
    run(`document.getElementById = id => id === 'autorig-skin-fingers' ? { value: '${mode}' } : null`);
    await run('applyAutoRig()');
    assert.equal(submitted.skinFingers, expected);
  });
}

test('T/A pose on an unskinned mesh leaves the rest markers unchanged', () => {
  const { run, events } = editor(async () => {});
  run('scene.skeletons = []; poseMarkerLayout = () => { throw new Error("Moved markers without moving mesh"); };');
  run('forceAutoRigPose("t"); forceAutoRigPose("a");');
  assert.equal(run('autoRigState === fixtureState'), true);
  assert.equal(run('autoRigState.markers.get("Hips").position.y'), 1);
  assert.ok(events.some(message => message.includes('current mesh pose')));
});

test('placement diagnostics escape geometry-derived text and show each hand status', () => {
  const { run } = editor(async () => {});
  run(`const diagnosticsPanel = { innerHTML: '', dataset: {}, style: {}, querySelectorAll: () => [] };
    document.getElementById = () => diagnosticsPanel;
    renderAutoRigDiagnostics({ diagnostics: { status: 'review', issues: ['<img src=x onerror=alert(1)>'] },
      fingerDetection: { Left: { status: 'detected' }, Right: { status: 'review' } } });`);
  assert.equal(run('diagnosticsPanel.dataset.status'), 'review');
  assert.equal(run('diagnosticsPanel.innerHTML.includes("<img")'), false);
  assert.equal(run('diagnosticsPanel.innerHTML.includes("Digits detected")'), true);
  assert.equal(run('diagnosticsPanel.innerHTML.includes("Review needed")'), true);
});
