import { parentPort } from 'node:worker_threads';
import { analyzeGLB, mergeGLBs } from './merge_api.mjs';
import { autoRigGLB, guessJoints } from './autorig_api.mjs';
import { convertFBXToGLB } from './fbx_api.mjs';

function binaryResult(value, extra = {}) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { message: { kind: 'binary', data, ...extra }, transfer: [data] };
}

parentPort.on('message', async ({ type, payload }) => {
  try {
    let result;
    if (type === 'analyze') {
      result = { message: { kind: 'json', data: await analyzeGLB(payload.file) }, transfer: [] };
    } else if (type === 'merge') {
      result = binaryResult(await mergeGLBs(payload.character, payload.animations, payload.options));
    } else if (type === 'guessJoints') {
      result = { message: { kind: 'json', data: await guessJoints(payload.file, payload.options) }, transfer: [] };
    } else if (type === 'autorig') {
      const report = {};
      result = binaryResult(await autoRigGLB(payload.file, { ...payload.options, reportSink: report }), { report });
    } else if (type === 'convertFBX') {
      result = binaryResult(await convertFBXToGLB(payload.file, payload.name, payload.options));
    } else {
      throw new Error(`Unknown processing job: ${type}`);
    }
    parentPort.postMessage({ ok: true, ...result.message }, result.transfer);
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: { message: error?.message || String(error), stack: error?.stack || '' },
    });
  }
});
