import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const ROOT = 'd:/DEV/BJS Character Controller V2';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const count = async (buf, label) => {
  const doc = await io.readBinary(new Uint8Array(buf));
  console.log(`${label}: ${doc.getRoot().listAnimations().length} anims, ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
};

// Already-merged GLB (output of previous export test) = characterGlbBuffer state
const mergedBuf = readFileSync(`${ROOT}/scratch/export_test.glb`);

// CURRENT export behavior when animationsGlbBuffer is null:
const bad = await mergeGLBs(mergedBuf, null, { removeExistingAnimations: true });
await count(bad, 'current behavior (strip, no anims appended)');

// PROPOSED: keep existing animations when no anim buffer
const good = await mergeGLBs(mergedBuf, null, { removeExistingAnimations: false });
await count(good, 'proposed (keep existing)');
