import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../js/core/builder.js', import.meta.url), 'utf8');

// rig-on-import with scripted server answers: each /api/autorig-joints call
// pops the next guess; /api/autorig returns a 1-byte "rigged" GLB.
function importFlow(guesses, { report = { score: 95, verdict: 'ok', confidence: 0.93 } } = {}) {
  const events = [];
  const requests = [];
  const context = vm.createContext({
    AbortController, Blob, File, FormData, URL, events,
    fetch: async (url, init) => {
      const options = init?.body?.get ? JSON.parse(init.body.get('options') || '{}') : {};
      requests.push({ url, options });
      if (url === '/api/autorig-joints') {
        const guess = guesses.shift();
        return { ok: true, json: async () => guess };
      }
      if (url === '/api/autorig') return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      throw new Error(`Unexpected request: ${url}`);
    },
    console: { log() {}, warn() {}, error() {} },
    window: { addEventListener() {} },
    document: { getElementById() { return null; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    for (const name of ['showLoading', 'hideLoading', 'setLoaderStep', 'showMergeProgress', 'completeMergeProgress',
      'syncCharTransformToUI']) globalThis[name] = () => {};
    showToast = (message, isError, opts) => events.push({ message, isError: !!isError, action: opts?.action?.label });
    readAutoRigReport = () => (${JSON.stringify(report)});
    loadCharacterMeshFile = async () => events.push('reload');
    scene = { skeletons: [] };
    isServerAvailable = true;
    characterGlbBuffer = new ArrayBuffer(8);
    originalCharacterGlbBuffer = characterGlbBuffer;
    autoRigSourceGlbBuffer = characterGlbBuffer;
    characterFilename = 'tripo.glb';
  `, context);
  return { events, requests, run: code => vm.runInContext(code, context) };
}

const humanoidGuess = (extra = {}) => ({ joints: { Hips: [0, 1, 0] }, bodyPlan: 'humanoid', fingerCount: 5, verdict: 'ok', ...extra });

test('a confident analysis rigs on import and offers Undo', async () => {
  const { run, requests, events } = importFlow([humanoidGuess({ suggestedFingerCount: 5 })]);
  assert.equal(await run(`autoRigImportedMesh('tripo.glb')`), 'rigged');
  assert.deepEqual(requests.map(r => r.url), ['/api/autorig-joints', '/api/autorig']);
  assert.equal(requests[1].options.twistBones, false, 'UI defaults come from the (absent) controls');
  assert.ok(events.includes('reload'));
  const done = events.find(e => typeof e === 'object' && /rigged/.test(e.message));
  assert.equal(done.action, 'Undo');
  assert.equal(run('rigUndoSnapshot.wasStatic'), true);
});

test('an unsure analysis never rigs blindly: it asks for review and the editor reuses the guess', async () => {
  const guess = humanoidGuess({ verdict: 'review', reviewJoints: ['LeftHand'], reviewReasons: ['Left hand is fused with the hip.'] });
  const { run, requests, events } = importFlow([guess]);
  assert.equal(await run(`autoRigImportedMesh('tripo.glb')`), 'review');
  assert.deepEqual(requests.map(r => r.url), ['/api/autorig-joints']);
  assert.ok(events.some(e => typeof e === 'object' && /Left hand is fused/.test(e.message)));
  assert.equal(run('pendingAutoRigGuess.guess.reviewJoints[0]'), 'LeftHand');
});

test('Automatic body plan re-analyses once as a quadruped and rigs with that layout', async () => {
  const { run, requests } = importFlow([
    humanoidGuess({ suggestedBodyPlan: 'quadruped' }),
    { joints: { Hips: [0, 0.6, 0] }, bodyPlan: 'quadruped', fingerCount: 0, verdict: 'ok', suggestedBodyPlan: 'quadruped' },
  ]);
  assert.equal(await run(`autoRigImportedMesh('dog.glb')`), 'rigged');
  assert.deepEqual(requests.map(r => r.url), ['/api/autorig-joints', '/api/autorig-joints', '/api/autorig']);
  assert.equal(requests[0].options.bodyPlan, 'humanoid');
  assert.equal(requests[1].options.bodyPlan, 'quadruped');
  assert.equal(requests[2].options.bodyPlan, 'quadruped');
});

test('Automatic finger count adopts the detected digits', async () => {
  const { run, requests } = importFlow([humanoidGuess({ suggestedFingerCount: 4 }), humanoidGuess({ fingerCount: 4, suggestedFingerCount: 4 })]);
  assert.equal(await run(`autoRigImportedMesh('toon.glb')`), 'rigged');
  assert.equal(requests[1].options.fingerCount, 4);
  assert.equal(requests[2].options.fingerCount, 4);
});

test('a rig the stress test flags is applied but offers Review joints', async () => {
  const { run, events } = importFlow([humanoidGuess()], {
    report: { score: 88, verdict: 'review', confidence: 0.55, reviewJoints: ['LeftForeArm'], reviewReasons: ['Left forearm collapses at 90° twist.'] },
  });
  assert.equal(await run(`autoRigImportedMesh('tripo.glb')`), 'rigged');
  const toast = events.find(e => typeof e === 'object' && /forearm/i.test(e.message));
  assert.equal(toast.action, 'Review joints');
});

test('Cancel during the rig keeps the static mesh and reports it as cancelled', async () => {
  const { run } = importFlow([humanoidGuess()]);
  run(`fetch = async (url, init) => {
    if (url === '/api/autorig-joints') return { ok: true, json: async () => ({ joints: { Hips: [0, 1, 0] }, verdict: 'ok' }) };
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };`);
  const pending = run(`autoRigImportedMesh('slow.glb')`);
  await new Promise(resolve => setTimeout(resolve, 10));
  run('cancelActiveServerJob()');
  assert.equal(await pending, 'cancelled');
});
