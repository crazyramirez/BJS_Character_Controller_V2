/**
 * server.mjs — BJS Character Controller Builder Dev Server
 * 
 * Express server that:
 *  - Serves static files (builder.html, assets, js, css)
 *  - POST /api/merge   → merges two GLB files using merge_api.mjs
 *  - POST /api/analyze → analyzes a GLB and returns skeleton + animation metadata
 *  - GET  /api/health  → liveness check
 */

import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// multer is CommonJS — use createRequire to load it in ESM context
const require = createRequire(import.meta.url);
const multer = require('multer');

import { runProcessingJob } from './js/core/processing_jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.BCC_HOST || '127.0.0.1';
const MAX_UPLOAD_MB = Math.max(1, Math.min(256, Number(process.env.BCC_MAX_UPLOAD_MB) || 96));
const MAX_CONCURRENT_JOBS = Math.max(1, Math.min(8, Number(process.env.BCC_MAX_JOBS) || 2));
let activeJobs = 0;

// ── Multer: in-memory storage ────────────────────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2, fields: 8, fieldSize: 1024 * 1024 },
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  req.setTimeout(120_000);
  res.setTimeout(120_000);
  next();
});

// Reject browser requests originating outside this loopback app. CLI requests
// without Origin remain supported for automation and tests.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const url = new URL(origin);
    const requestPort = String(req.socket.localPort || PORT);
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === requestPort) return next();
  } catch (_) { /* handled below */ }
  return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
});

const heavyJob = (req, res, next) => {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    res.setHeader('Retry-After', '2');
    return res.status(429).json({ error: 'The processing queue is full. Please retry shortly.' });
  }
  activeJobs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeJobs = Math.max(0, activeJobs - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
};

function assertGLB(file, label = 'file') {
  const b = file?.buffer;
  if (!b || b.length < 12 || b.toString('ascii', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2) {
    throw Object.assign(new Error(`${label} is not a valid binary glTF 2.0 file.`), { statusCode: 400 });
  }
  const declaredLength = b.readUInt32LE(8);
  if (declaredLength !== b.length) {
    throw Object.assign(new Error(`${label} has an invalid GLB length header.`), { statusCode: 400 });
  }
}

function assertFBX(file) {
  const b = file?.buffer;
  const binary = b?.subarray(0, 23).toString('ascii').startsWith('Kaydara FBX Binary');
  const ascii = b?.subarray(0, 256).toString('utf8').includes('FBXHeaderExtension');
  if (!binary && !ascii) throw Object.assign(new Error('The uploaded file is not a recognizable FBX file.'), { statusCode: 400 });
}

function parseOptions(raw) {
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Options must be a JSON object.');
  const visit = (item, depth = 0) => {
    if (depth > 5) throw new Error('Options are nested too deeply.');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Options contain a non-finite number.');
    if (typeof item === 'string' && item.length > 512) throw new Error('Options contain an oversized string.');
    if (Array.isArray(item)) {
      if (item.length > 256) throw new Error('Options contain an oversized array.');
      item.forEach(child => visit(child, depth + 1));
    } else if (item && typeof item === 'object') {
      const keys = Object.keys(item);
      if (keys.length > 256 || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) {
        throw new Error('Options contain unsupported keys.');
      }
      keys.forEach(key => visit(item[key], depth + 1));
    }
  };
  visit(value);
  return value;
}

// HTTP response headers are byte-oriented and reject arbitrary Unicode. Keep
// the auto-rig report compact, explicitly whitelist its public fields, and
// encode the UTF-8 JSON as base64url before exposing it to the Builder.
export function encodeAutoRigReport(report) {
  if (!report || !Number.isFinite(report.score)) return null;
  const meshes = Array.isArray(report.meshSelection?.meshes) ? report.meshSelection.meshes : [];
  const compact = {
    score: report.score,
    vertices: report.vertices,
    crossSidePct: report.crossSidePct,
    distantInfluencePct: report.distantInfluencePct,
    geodesicWeights: report.geodesicWeights === true,
    symmetrized: report.symmetrized === true,
    twistBones: report.twistBones === true,
    propsAttached: report.propsAttached,
    guessMethod: report.guessMethod,
    skeletonPreset: report.skeletonPreset,
    presetCompatibility: report.presetCompatibility,
    meshSelection: report.meshSelection ? {
      mode: report.meshSelection.mode,
      total: meshes.length,
      selected: meshes.filter(mesh => mesh.selected).length,
    } : undefined,
    notes: Array.isArray(report.notes)
      ? report.notes.slice(0, 8).map(note => String(note).slice(0, 512))
      : [],
  };
  return Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
}

function processingSignal(req) {
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  return controller.signal;
}

// ── Static files: explicit public allowlist ──────────────────────────────────
for (const folder of ['css', 'js', 'assets', 'vendor']) {
  app.use(`/${folder}`, express.static(path.join(__dirname, folder), { dotfiles: 'deny', index: false }));
}
app.get(['/', '/builder', '/builder.html'], (_req, res) => res.sendFile(path.join(__dirname, 'builder.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '2.4.1', ts: Date.now() });
});

// ── Analyze a single GLB ─────────────────────────────────────────────────────
// POST /api/analyze
// Body: multipart with field "file" (single GLB)
// Response: JSON { bones, rootBones, animations, hasSkin, boneCount }
app.post('/api/analyze', heavyJob, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field: file)' });
    assertGLB(req.file);
    console.log(`[analyze] ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB)`);
    const result = await runProcessingJob('analyze', { file: req.file.buffer }, { signal: processingSignal(req) });
    res.json(result.data);
  } catch (err) {
    console.error('[analyze] Error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Merge character + animations GLBs ────────────────────────────────────────
// POST /api/merge
// Body: multipart with fields "character" and "animations"
// Optional JSON body param "options" (stringify) for merge overrides
// Response: binary .glb
app.post('/api/merge', heavyJob, upload.fields([
  { name: 'character', maxCount: 1 },
  { name: 'animations', maxCount: 1 },
]), async (req, res) => {
  try {
    const charFile = req.files?.character?.[0];
    const animFile = req.files?.animations?.[0];

    if (!charFile) return res.status(400).json({ error: 'Missing "character" file field' });
    assertGLB(charFile, 'character');
    if (animFile) assertGLB(animFile, 'animations');

    const animBuffer = animFile ? animFile.buffer : null;

    let options = {};
    if (req.body?.options) {
      try { options = parseOptions(req.body.options); }
      catch (_) { return res.status(400).json({ error: 'Invalid JSON in options.' }); }
    }

    console.log(`[merge] char=${charFile.originalname} (${(charFile.size / 1024 / 1024).toFixed(2)} MB)`);
    if (animFile) {
      console.log(`[merge] anim=${animFile.originalname} (${(animFile.size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      console.log(`[merge] anim=none (clean animations mode)`);
    }

    const job = await runProcessingJob('merge', {
      character: charFile.buffer,
      animations: animBuffer,
      options,
    }, { signal: processingSignal(req) });
    const merged = Buffer.from(job.data);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', 'attachment; filename="merged.glb"');
    res.setHeader('Content-Length', merged.length);
    res.end(merged);

    console.log(`[merge] Done. Output: ${(merged.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error('[merge] Error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Convert FBX → GLB ────────────────────────────────────────────────────────
// POST /api/convert-fbx
// Body: multipart with field "file" (single FBX)
// Response: binary .glb (materials fixed + RootNode transform flattened)
app.post('/api/convert-fbx', heavyJob, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field: file)' });
    assertFBX(req.file);
    console.log(`[convert-fbx] ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

    const job = await runProcessingJob('convertFBX', {
      file: req.file.buffer,
      name: req.file.originalname,
      options: { repairMaterials: false },
    }, { signal: processingSignal(req) });
    const glb = Buffer.from(job.data);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', 'attachment; filename="converted.glb"');
    res.setHeader('Content-Length', glb.length);
    res.end(glb);
    console.log(`[convert-fbx] Done. Output: ${(glb.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error('[convert-fbx] Error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Auto-rig: propose default joint positions ───────────────────────────────
// POST /api/autorig-joints
// Body: multipart with field "file" (skinless GLB)
// Optional "options" (JSON string): { bodyPlan: 'humanoid'|'quadruped', fingerCount: 0|2|3|4|5 }
// Response: JSON { joints: {Hips:[x,y,z], ...}, height, bounds, bodyPlan, fingerCount }
app.post('/api/autorig-joints', heavyJob, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field: file)' });
    assertGLB(req.file);
    let options = {};
    if (req.body?.options) {
      try { options = parseOptions(req.body.options); }
      catch (_) { return res.status(400).json({ error: 'Invalid JSON in options.' }); }
    }
    console.log(`[autorig-joints] ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB) plan=${options.bodyPlan || 'humanoid'} fingers=${options.fingerCount ?? 5}`);
    const result = await runProcessingJob('guessJoints', { file: req.file.buffer, options }, { signal: processingSignal(req) });
    res.json(result.data);
  } catch (err) {
    console.error('[autorig-joints] Error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Auto-rig: generate skeleton + skin weights ───────────────────────────────
// POST /api/autorig
// Body: multipart with field "file" (skinless GLB)
// Optional "options" (JSON string): { joints: {Hips:[x,y,z], ...} } world-space overrides
// Response: binary rigged .glb
app.post('/api/autorig', heavyJob, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field: file)' });
    assertGLB(req.file);

    let options = {};
    if (req.body?.options) {
      try { options = parseOptions(req.body.options); }
      catch (_) { return res.status(400).json({ error: 'Invalid JSON in options.' }); }
    }

    console.log(`[autorig] ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB), custom joints: ${options.joints ? Object.keys(options.joints).length : 0}`);
    const job = await runProcessingJob('autorig', { file: req.file.buffer, options }, { signal: processingSignal(req) });
    const rigged = Buffer.from(job.data);
    const reportSink = job.report || {};

    const reportHeader = encodeAutoRigReport(reportSink);
    if (reportHeader) {
      res.setHeader('X-Autorig-Report', reportHeader);
      res.setHeader('X-Autorig-Report-Encoding', 'base64url');
    }
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', 'attachment; filename="rigged.glb"');
    res.setHeader('Content-Length', rigged.length);
    res.end(rigged);
    console.log(`[autorig] Done. Output: ${(rigged.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.error('[autorig] Error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  const status = err.statusCode || (err.code?.startsWith('LIMIT_') ? 413 : 500);
  if (status >= 500) console.error('[server] Unhandled error:', err);
  if (!res.headersSent) res.status(status).json({ error: err.message || 'Request failed.' });
});

export function startServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (error) => {
      // Express 5 forwards listen errors to the callback. Do not inspect
      // server.address() when binding failed (it is null in that state).
      if (error) return reject(error);
      const address = server.address();
      if (!address) return reject(new Error(`Server failed to bind to ${host}:${port}.`));
      const actualPort = typeof address === 'object' ? address.port : port;
      console.log('\n  BJS Character Controller Builder');
      console.log(`  → http://${host}:${actualPort}/builder.html\n`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

export { app };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await startServer();
  } catch (error) {
    console.error(`[server] Could not start on ${HOST}:${PORT}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
