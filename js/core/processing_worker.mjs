import { parentPort } from 'node:worker_threads';
import { analyzeGLB, mergeGLBs } from './merge_api.mjs';
import { autoRigGLB, guessJoints, orientGLB } from './autorig_api.mjs';
import { convertFBXToGLB } from './fbx_api.mjs';

function binaryResult(value, extra = {}) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { message: { kind: 'binary', data, ...extra }, transfer: [data] };
}

// Stage callbacks for the long jobs, posted as { progress } messages that
// processing_jobs forwards to the server's per-request progress record.
function reportProgress(stage, fraction = 0) {
  parentPort.postMessage({ progress: { stage: String(stage).slice(0, 40), fraction: Number.isFinite(fraction) ? fraction : 0 } });
}

function withProgress(options = {}) {
  return { ...options, onProgress: reportProgress };
}

parentPort.on('message', async ({ type, payload }) => {
  try {
    reportProgress(type, 0);
    let result;
    if (type === 'analyze') {
      result = { message: { kind: 'json', data: await analyzeGLB(payload.file) }, transfer: [] };
    } else if (type === 'merge') {
      const report = {};
      result = binaryResult(await mergeGLBs(payload.character, payload.animations,
        { ...payload.options, reportSink: report }), { report });
    } else if (type === 'guessJoints') {
      result = { message: { kind: 'json', data: await guessJoints(payload.file, withProgress(payload.options)) }, transfer: [] };
    } else if (type === 'orient') {
      const { buffer, orientation, placement } = await orientGLB(payload.file, withProgress(payload.options));
      result = buffer ? binaryResult(buffer, { orientation, placement })
        : { message: { kind: 'json', data: { orientation, placement } }, transfer: [] };
    } else if (type === 'autorig') {
      const report = {};
      result = binaryResult(await autoRigGLB(payload.file, { ...withProgress(payload.options), reportSink: report }), { report });
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
