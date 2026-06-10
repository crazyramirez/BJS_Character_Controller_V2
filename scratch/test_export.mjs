import { readFileSync, writeFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const ROOT = 'd:/DEV/BJS Character Controller V2';
const charBuf = readFileSync(`${ROOT}/assets/characters_test/business_man.glb`);
const animBuf = readFileSync(`${ROOT}/assets/character_animated.glb`);

// Exact export path: COMPRESS_OUTPUT default (true) + removeExistingAnimations
const merged = await mergeGLBs(charBuf, animBuf, { removeExistingAnimations: true });
writeFileSync(`${ROOT}/scratch/export_test.glb`, merged);
console.log(`merged size: ${merged.length}`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.readBinary(new Uint8Array(merged));
const anims = doc.getRoot().listAnimations();
console.log(`animations in output: ${anims.length}`);
console.log(anims.slice(0, 10).map(a => `${a.getName()}(${a.listChannels().length}ch)`).join(', '));
