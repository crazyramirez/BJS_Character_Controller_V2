import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { encodeAutoRigReport, startServer } from '../server.mjs';
import { createIO } from './helpers.mjs';

test('server exposes only public assets and sends security headers', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const builder = await fetch(`${base}/builder.html`);
  assert.equal(builder.status, 200);
  assert.match(builder.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(builder.headers.get('content-security-policy'), /connect-src 'self' blob:/);
  assert.equal(builder.headers.get('x-content-type-options'), 'nosniff');
  const dracoWasm = await fetch(`${base}/vendor/draco_decoder_gltf.wasm`);
  assert.equal(dracoWasm.status, 200);
  assert.equal(dracoWasm.headers.get('content-type'), 'application/wasm');
  assert.ok((await dracoWasm.arrayBuffer()).byteLength > 100_000);
  assert.equal((await fetch(`${base}/js/draco-config.js`)).status, 200);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/test/autorig.test.mjs`)).status, 404);
});

test('server rejects malformed GLB and cross-origin processing requests', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const form = new FormData();
  form.append('file', new Blob(['not-a-glb']), 'bad.glb');
  const malformed = await fetch(`${base}/api/analyze`, { method: 'POST', body: form });
  assert.equal(malformed.status, 400);

  const crossOrigin = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
    body: new FormData(),
  });
  assert.equal(crossOrigin.status, 403);
});

test('same-origin analysis runs in the processing worker', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const source = await fs.readFile(new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url));
  const form = new FormData();
  form.append('file', new Blob([source], { type: 'model/gltf-binary' }), 'prisioner_hostage.glb');
  const response = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { Origin: base },
    body: form,
  });
  assert.equal(response.status, 200);
  const analysis = await response.json();
  assert.equal(analysis.hasSkin, true);
  assert.ok(analysis.health.score >= 0 && analysis.health.score <= 100);
});

test('auto-rig response supports Unicode mesh names and returns a usable skin', async (t) => {
  const io = await createIO();
  const source = await fs.readFile(new URL('../assets/female_character_simple.glb', import.meta.url));
  const sourceDocument = await io.readBinary(source);
  sourceDocument.getRoot().listMeshes()[0].setName('Cuerpo_ñ_🧍');
  const unicodeSource = await io.writeBinary(sourceDocument);

  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const form = new FormData();
  form.append('file', new Blob([unicodeSource], { type: 'model/gltf-binary' }), 'unicode.glb');
  const response = await fetch(`http://127.0.0.1:${port}/api/autorig`, { method: 'POST', body: form });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-autorig-report-encoding'), 'base64url');
  const report = JSON.parse(Buffer.from(response.headers.get('x-autorig-report'), 'base64url').toString('utf8'));
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.equal(report.restValidation.passed, true);
  assert.ok(report.restValidation.maxPositionError <= report.restValidation.tolerance);
  assert.ok(['ready', 'review'].includes(report.diagnostics.status));
  assert.match(report.scoreScope, /not a measure of anatomical accuracy/);
  const riggedDocument = await io.readBinary(new Uint8Array(await response.arrayBuffer()));
  assert.ok(riggedDocument.getRoot().listSkins().length > 0);
  assert.ok(riggedDocument.getRoot().listSkins()[0].listJoints().length >= 20);
});

test('auto-rig report encoding preserves non-ASCII fallback diagnostics', () => {
  const encoded = encodeAutoRigReport({
    score: 100,
    notes: ['Geodesic weighting unavailable — euclidean fallback used.', 'Malla: Cuerpo_ñ_🧍'],
    meshSelection: { mode: 'automatic', meshes: [{ name: 'Cuerpo_ñ_🧍', selected: true }] },
  });
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.deepEqual(decoded.notes, [
    'Geodesic weighting unavailable — euclidean fallback used.',
    'Malla: Cuerpo_ñ_🧍',
  ]);
  assert.deepEqual(decoded.meshSelection, { mode: 'automatic', total: 1, selected: 1 });
});

test('existing-rig adjustment reports reach the client without a fabricated skin quality score', () => {
  const encoded = encodeAutoRigReport({ mode: 'adjust', adjustedJoints: 2, notes: ['Unmapped markers: Head.'] });
  const report = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(report.mode, 'adjust');
  assert.equal(report.adjustedJoints, 2);
  assert.equal(report.score, undefined);
  assert.deepEqual(report.notes, ['Unmapped markers: Head.']);
});

test('server rejects an occupied port without dereferencing a null address', async (t) => {
  const first = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => first.close(resolve)));
  const { port } = first.address();
  await assert.rejects(
    startServer({ port, host: '127.0.0.1' }),
    error => error?.code === 'EADDRINUSE',
  );
});
