import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convertFBXToGLB, resolveFBXConverterPath } from '../js/core/fbx_api.mjs';
import { runProcessingJob } from '../js/core/processing_jobs.mjs';

const source = Buffer.from([0, 255, 128, 1, 2, 3, 0, 42]);
const padded = Buffer.concat([Buffer.from('prefix'), source, Buffer.from('suffix')]);
const slice = padded.subarray(6, 6 + source.length);
const inputs = {
  ArrayBuffer: source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
  Buffer: slice,
  Uint8Array: new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength),
  DataView: new DataView(slice.buffer, slice.byteOffset, slice.byteLength),
};

test('packaged FBX converter resolves to the executable outside app.asar', () => {
  const resources = path.resolve('Program Files', 'BJS Character Controller Builder', 'resources');
  const entry = path.join(resources, 'app.asar', 'node_modules', 'fbx2gltf', 'index.js');
  assert.equal(resolveFBXConverterPath(entry, 'Windows_NT'),
    path.join(resources, 'app.asar.unpacked', 'node_modules', 'fbx2gltf', 'bin', 'Windows_NT', 'FBX2glTF.exe'));
  const unpacked = entry.replace('app.asar', 'app.asar.unpacked');
  assert.equal(resolveFBXConverterPath(unpacked, 'Windows_NT'), resolveFBXConverterPath(entry, 'Windows_NT'));
});

test('development FBX converter paths remain unchanged on supported platforms', () => {
  const directory = path.resolve('project with spaces', 'node_modules', 'fbx2gltf');
  for (const platform of ['Windows_NT', 'Darwin', 'Linux']) {
    assert.equal(resolveFBXConverterPath(path.join(directory, 'index.js'), platform),
      path.join(directory, 'bin', platform, `FBX2glTF${platform === 'Windows_NT' ? '.exe' : ''}`));
  }
});

for (const [type, input] of Object.entries(inputs)) {
  test(`FBX temporary file preserves the exact bytes of ${type} input`, async t => {
    const writeFileSync = fs.writeFileSync;
    const stopBeforeConverter = new Error('Stop after verifying the temporary FBX file.');
    let written;
    let temporaryPath;
    t.mock.method(fs, 'writeFileSync', (filename, bytes) => {
      writeFileSync(filename, bytes);
      temporaryPath = filename;
      written = fs.readFileSync(filename);
      throw stopBeforeConverter;
    });
    await assert.rejects(convertFBXToGLB(input, 'test.fbx'), error => error === stopBeforeConverter);
    assert.deepEqual(written, source);
    assert.equal(fs.existsSync(temporaryPath), false);
  });
}

test('worker FBX payload reaches native format parsing instead of failing in fs.writeFileSync', async () => {
  await assert.rejects(runProcessingJob('convertFBX', {
    file: Buffer.from('invalid FBX data'), name: 'invalid.fbx', options: {},
  }), error => /Converter output/.test(error.message) && !/data.*argument.*ArrayBuffer/.test(error.message));
});
