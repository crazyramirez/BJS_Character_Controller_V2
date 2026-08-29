import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';
import { createIO } from './helpers.mjs';

const animationFixture = new URL('../assets/animations.glb', import.meta.url);
const corpus = [
  new URL('../assets/characters_test/prisioner_hostage.glb', import.meta.url),
  new URL('../assets/characters_test/medieval_character_sample.glb', import.meta.url),
  new URL('../assets/characters_test/gang.glb', import.meta.url),
  new URL('../assets/characters_test/business_man.glb', import.meta.url),
  new URL('../assets/characters_test/talking_male.glb', import.meta.url),
  new URL('../assets/low_poly.glb', import.meta.url),
];

for (const fixture of corpus) {
  const filename = decodeURIComponent(fixture.pathname.split('/').pop());
  test(`retarget corpus remains structurally valid: ${filename}`, async () => {
    const [character, animations, io] = await Promise.all([
      fs.readFile(fixture),
      fs.readFile(animationFixture),
      createIO(),
    ]);
    const before = await analyzeGLB(character);
    assert.equal(before.hasSkin, true, `${filename}: source skin`);
    assert.ok(before.mapping?.entries?.length > 0, `${filename}: canonical mapping report`);

    const output = await mergeGLBs(character, animations, {
      COMPRESS_OUTPUT: false,
      removeExistingAnimations: true,
    });
    const [after, document] = await Promise.all([analyzeGLB(output), io.readBinary(output)]);
    assert.equal(after.health.metrics.vertexCount, before.health.metrics.vertexCount, `${filename}: vertex count`);
    const heightRatio = after.health.metrics.height / before.health.metrics.height;
    assert.ok(heightRatio > 0.995 && heightRatio < 1.005,
      `${filename}: rendered height ratio ${heightRatio}`);

    const clips = document.getRoot().listAnimations();
    assert.ok(clips.length > 0, `${filename}: merged animations`);
    let rotationSamples = 0;
    for (const clip of clips) {
      assert.ok(clip.listChannels().length > 0, `${filename}: nonempty ${clip.getName()}`);
      for (const channel of clip.listChannels()) {
        const values = channel.getSampler().getOutput().getArray();
        for (const value of values) assert.ok(Number.isFinite(value), `${filename}: finite animation sample`);
        if (channel.getTargetPath() !== 'rotation') continue;
        rotationSamples += values.length / 4;
        for (let i = 0; i < values.length; i += 4) {
          const norm = Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3]);
          assert.ok(norm > 0.98 && norm < 1.02, `${filename}: normalized quaternion ${norm}`);
        }
      }
    }
    assert.ok(rotationSamples > 0, `${filename}: rotation channels`);
  });
}
