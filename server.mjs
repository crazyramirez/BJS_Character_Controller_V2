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
import { Readable } from 'stream';

// multer is CommonJS — use createRequire to load it in ESM context
const require = createRequire(import.meta.url);
const multer = require('multer');

import { mergeGLBs, analyzeGLB } from './js/core/merge_api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── Multer: in-memory storage ────────────────────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 256 * 1024 * 1024 } }); // 256 MB max

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(__dirname));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '2.0', ts: Date.now() });
});

// ── Analyze a single GLB ─────────────────────────────────────────────────────
// POST /api/analyze
// Body: multipart with field "file" (single GLB)
// Response: JSON { bones, rootBones, animations, hasSkin, boneCount }
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field: file)' });
    console.log(`[analyze] ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB)`);
    const result = await analyzeGLB(req.file.buffer);
    res.json(result);
  } catch (err) {
    console.error('[analyze] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Merge character + animations GLBs ────────────────────────────────────────
// POST /api/merge
// Body: multipart with fields "character" and "animations"
// Optional JSON body param "options" (stringify) for merge overrides
// Response: binary .glb
app.post('/api/merge', upload.fields([
  { name: 'character', maxCount: 1 },
  { name: 'animations', maxCount: 1 },
]), async (req, res) => {
  try {
    const charFile = req.files?.character?.[0];
    const animFile = req.files?.animations?.[0];

    if (!charFile) return res.status(400).json({ error: 'Missing "character" file field' });

    const animBuffer = animFile ? animFile.buffer : null;

    let options = {};
    if (req.body?.options) {
      try { options = JSON.parse(req.body.options); } catch (_) { /* ignore */ }
    }

    console.log(`[merge] char=${charFile.originalname} (${(charFile.size / 1024 / 1024).toFixed(2)} MB)`);
    if (animFile) {
      console.log(`[merge] anim=${animFile.originalname} (${(animFile.size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      console.log(`[merge] anim=none (clean animations mode)`);
    }

    const merged = await mergeGLBs(charFile.buffer, animBuffer, options);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', 'attachment; filename="merged.glb"');
    res.setHeader('Content-Length', merged.length);
    res.end(merged);

    console.log(`[merge] Done. Output: ${(merged.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error('[merge] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/builder', (req, res) => {
  res.sendFile(__dirname + '/builder.html');
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  BJS Character Controller Builder');
  console.log(`  → http://localhost:${PORT}/builder.html\n`);
});
