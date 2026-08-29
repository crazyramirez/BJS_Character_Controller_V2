import { Worker } from 'node:worker_threads';

const workerURL = new URL('./processing_worker.mjs', import.meta.url);

function exactArrayBuffer(buffer) {
  if (!buffer) return null;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function runProcessingJob(type, payload, { signal, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    // Processing is self-contained and needs no parent Node/V8 flags. An empty
    // list avoids forwarding eval-only or host-managed flags that a file-backed
    // Worker is not allowed to accept.
    const worker = new Worker(workerURL, { type: 'module', execArgv: [] });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      callback(value);
    };
    const abort = () => finish(reject, Object.assign(new Error('Processing cancelled.'), { statusCode: 499 }));
    const timeout = setTimeout(() => finish(reject,
      Object.assign(new Error('Processing timed out.'), { statusCode: 504 })), timeoutMs);

    worker.once('error', error => finish(reject, error));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(reject, new Error(`Processing worker exited with code ${code}.`));
    });
    worker.once('message', message => {
      if (!message.ok) {
        const error = new Error(message.error?.message || 'Processing failed.');
        error.stack = message.error?.stack || error.stack;
        finish(reject, error);
      } else {
        finish(resolve, message);
      }
    });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });

    const cloned = { ...payload };
    const transfer = [];
    for (const key of ['file', 'character', 'animations']) {
      if (!cloned[key]) continue;
      cloned[key] = exactArrayBuffer(cloned[key]);
      transfer.push(cloned[key]);
    }
    worker.postMessage({ type, payload: cloned }, transfer);
  });
}
