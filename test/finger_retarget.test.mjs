/**
 * Finger retargeting integration test — Iteration 4.
 *
 * Verifies that a Mixamo/UE5-style animation with finger tracks can be
 * retargeted onto the auto-rigged character skeleton and that every finger
 * joint ends up with an animation channel.
 *
 * Run with: node --test test/finger_retarget.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { autoRigGLB } from '../js/core/autorig_api.mjs';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');

async function readGLB(buffer) {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  return io.readBinary(new Uint8Array(buffer));
}

describe('Finger retargeting', () => {
  it('retargets all 30 finger animation channels onto the auto-rig', async () => {
    const charBuffer = await autoRigGLB(readFileSync(join(assetsDir, 'character_animated_1.glb')), { forceRebuild: true });
    const animBuffer = readFileSync(join(assetsDir, 'animations-pro.glb'));
    const merged = await mergeGLBs(charBuffer, animBuffer, { COMPRESS_OUTPUT: false });
    const doc = await readGLB(merged);

    const animated = new Set();
    for (const anim of doc.getRoot().listAnimations()) {
      for (const ch of anim.listChannels()) {
        const node = ch.getTargetNode();
        if (node) animated.add(node.getName());
      }
    }

    const missing = [];
    for (const side of ['Left', 'Right']) {
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
        for (let i = 1; i <= 3; i++) {
          const name = `${side}Hand${finger}${i}`;
          if (!animated.has(name)) missing.push(name);
        }
      }
    }
    assert.strictEqual(missing.length, 0, `missing finger animation channels: ${missing.join(', ')}`);
  });
});
