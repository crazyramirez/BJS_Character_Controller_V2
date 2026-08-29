import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');

const files = [
  ['node_modules/babylonjs/babylon.js', 'babylon.js'],
  ['node_modules/babylonjs-loaders/babylonjs.loaders.min.js', 'babylonjs.loaders.min.js'],
  ['node_modules/babylonjs-materials/babylonjs.materials.min.js', 'babylonjs.materials.min.js'],
  ['node_modules/@babylonjs/havok/lib/umd/HavokPhysics_umd.js', 'HavokPhysics_umd.js'],
  ['node_modules/@babylonjs/havok/lib/umd/HavokPhysics.wasm', 'HavokPhysics.wasm'],
  ['node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js', 'draco_wasm_wrapper_gltf.js'],
  ['node_modules/draco3dgltf/draco_decoder_gltf.wasm', 'draco_decoder_gltf.wasm'],
];

await fs.mkdir(vendor, { recursive: true });
for (const [source, destination] of files) {
  await fs.copyFile(path.join(root, source), path.join(vendor, destination));
}
console.log(`[vendor] Synced ${files.length} pinned runtime assets.`);
