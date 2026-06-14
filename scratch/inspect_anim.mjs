import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.readBinary(new Uint8Array(readFileSync('d:/DEV/BJS Character Controller V2/assets/character_animated.glb')));

const nodeNames = new Set();
for (const n of doc.getRoot().listNodes()) nodeNames.add(n.getName());
console.log('NODES:', [...nodeNames].join(', '));

const anim = doc.getRoot().listAnimations().find(a => /crouch_idle/i.test(a.getName() || ''));
const targets = new Map();
for (const ch of anim.listChannels()) {
  const n = ch.getTargetNode()?.getName() || '?';
  targets.set(n, (targets.get(n) || '') + ch.getTargetPath()[0]);
}
console.log(`\nANIM '${anim.getName()}' targets (${targets.size}):`);
for (const [n, p] of targets) console.log(`  ${n} [${p}]`);
