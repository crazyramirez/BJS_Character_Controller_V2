import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { autoRigGLB, guessJoints } from '../js/core/autorig_api.mjs';
import { createIO } from './helpers.mjs';

const fixture = new URL('../assets/female_character_simple.glb', import.meta.url);

// Split the single body primitive at the thighs into an upper and a lower part,
// each with its own vertex copies: vertices on the cut exist in both parts at
// the same position (the Body/Tops/Bottoms split of Fuse/CC exports).
async function splitAtThighs(separateMeshes) {
  const io = await createIO();
  const doc = await io.readBinary(await fs.readFile(fixture));
  const node = doc.getRoot().listNodes().find(n => n.getMesh());
  const source = node.getMesh().listPrimitives()[0];
  const world = node.getWorldMatrix();
  const pos = source.getAttribute('POSITION').getArray();
  const index = source.getIndices().getArray();
  let minY = Infinity, maxY = -Infinity;
  const worldY = v => world[1] * pos[v * 3] + world[5] * pos[v * 3 + 1] + world[9] * pos[v * 3 + 2] + world[13];
  for (let v = 0; v < pos.length / 3; v++) { minY = Math.min(minY, worldY(v)); maxY = Math.max(maxY, worldY(v)); }
  const cut = minY + 0.35 * (maxY - minY); // below the hands: legs only
  const groups = [[], []];
  for (let t = 0; t < index.length; t += 3) {
    const y = (worldY(index[t]) + worldY(index[t + 1]) + worldY(index[t + 2])) / 3;
    groups[y > cut ? 0 : 1].push(index[t], index[t + 1], index[t + 2]);
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const parts = groups.map(tris => {
    const remap = new Map(), out = [];
    for (const v of tris) if (!remap.has(v)) { remap.set(v, out.length / 3); out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
    return doc.createPrimitive().setMaterial(source.getMaterial())
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(out)))
      .setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(Uint32Array.from(tris, v => remap.get(v))));
  });
  const mesh = node.getMesh();
  mesh.removePrimitive(source);
  mesh.addPrimitive(parts[0]);
  if (separateMeshes) {
    // Sibling node: the Sketchfab ancestry carries a mirror that TRS cannot hold.
    const parent = doc.getRoot().listNodes().find(n => n.listChildren().includes(node));
    parent.addChild(doc.createNode('Lower').setMatrix(node.getMatrix()).setMesh(doc.createMesh('Lower').addPrimitive(parts[1])));
  } else mesh.addPrimitive(parts[1]);
  return io.writeBinary(doc);
}

function influences(prim, v, names) {
  const j = prim.getAttribute('JOINTS_0').getElement(v, []), w = prim.getAttribute('WEIGHTS_0').getElement(v, []);
  const out = {};
  for (let k = 0; k < 4; k++) if (w[k] > 0) out[names[j[k]]] = (out[names[j[k]]] || 0) + w[k];
  return out;
}

for (const separateMeshes of [false, true]) {
  test(`coincident seam vertices share weights across ${separateMeshes ? 'meshes' : 'primitives'}`, async () => {
    const io = await createIO();
    const source = await splitAtThighs(separateMeshes);
    const guess = await guessJoints(source, { fingerCount: 0 });
    const doc = await io.readBinary(await autoRigGLB(source, { joints: guess.joints, fingerCount: 0 }));
    const skinned = doc.getRoot().listNodes().filter(n => n.getSkin() && n.getMesh());
    const names = skinned[0].getSkin().listJoints().map(j => j.getName());
    const prims = skinned.flatMap(n => n.getMesh().listPrimitives());
    assert.equal(prims.length, 2, 'both halves are skinned');
    const key = (arr, v) => `${arr[v * 3].toFixed(6)},${arr[v * 3 + 1].toFixed(6)},${arr[v * 3 + 2].toFixed(6)}`;
    const upper = prims[0].getAttribute('POSITION').getArray(), lower = prims[1].getAttribute('POSITION').getArray();
    const byKey = new Map();
    for (let v = 0; v < upper.length / 3; v++) byKey.set(key(upper, v), v);
    let seam = 0, worst = 0;
    for (let v = 0; v < lower.length / 3; v++) {
      const u = byKey.get(key(lower, v));
      if (u === undefined) continue;
      seam++;
      const a = influences(prims[0], u, names), b = influences(prims[1], v, names);
      for (const bone of new Set([...Object.keys(a), ...Object.keys(b)])) {
        worst = Math.max(worst, Math.abs((a[bone] || 0) - (b[bone] || 0)));
      }
    }
    assert.ok(seam > 20, `seam has ${seam} shared vertices`);
    assert.ok(worst < 1e-6, `seam weight mismatch ${worst}`);
  });
}
