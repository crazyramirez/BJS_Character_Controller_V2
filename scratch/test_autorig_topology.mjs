/** Smoke-test the pose-independent topology pass on a real mesh. */
import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { guessJointsFromTopology } from '../js/core/autorig_api.mjs';

const buf = readFileSync(new URL('../assets/character_animated.glb', import.meta.url));
const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
  'draco3d.encoder': await dracoLib.createEncoderModule(),
});
const doc = await io.readBinary(new Uint8Array(buf));

const skinnedMeshes = new Map(); // mesh → skin-space xform
for (const node of doc.getRoot().listNodes()) {
  if (node.getSkin() && node.getMesh()) skinnedMeshes.set(node.getMesh(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
// world bounds (same logic as autorig: skinned verts live in skin space)
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    const arr = prim.getAttribute('POSITION')?.getArray();
    if (!arr) continue;
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (arr[i + k] < min[k]) min[k] = arr[i + k];
        if (arr[i + k] > max[k]) max[k] = arr[i + k];
      }
    }
  }
}

const t0 = Date.now();
const guess = guessJointsFromTopology(doc, skinnedMeshes, { min, max }, 1);
console.log(`topology pass: ${Date.now() - t0}ms`);
if (!guess) { console.error('FAIL: topology returned null'); process.exit(1); }

console.log('confidence:', guess.confidence.toFixed(2), '| method:', guess.method);
const J = guess.joints;
const fmt = (p) => p.map(v => v.toFixed(2)).join(',');
for (const n of ['Hips', 'Head', 'Neck', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftLeg', 'LeftForeArm']) {
  console.log(`  ${n.padEnd(12)} ${fmt(J[n])}`);
}

// Sanity assertions (T-pose mesh: up = +Y)
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
if (!(J.Head[1] > J.Hips[1])) fail('Head not above Hips');
if (!(J.Hips[1] > J.LeftFoot[1] && J.Hips[1] > J.RightFoot[1])) fail('Feet not below Hips');
if (!(J.LeftHand[0] > J.RightHand[0])) fail('Left/Right hands not separated correctly');
if (!(J.LeftFoot[0] > J.RightFoot[0])) fail('Left/Right feet not separated correctly');
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
if (dist(J.LeftHand, J.RightHand) < 0.3 * guess.height) fail('Hands suspiciously close');
console.log('ALL OK');
