/**
 * Auto-rig ACCURACY regression test.
 *
 * Ground truth: assets/character_animated_1.glb is a clean Mixamo rig (Erika
 * Archer, T-pose, +Z facing, 67 joints). We strip its skeleton to a bare mesh,
 * run the full skinless auto-rig pipeline (guessJoints + autoRigGLB), and assert:
 *   1. every guessed joint lands within a tight tolerance of the original rig,
 *   2. the rebuilt bind is exact (W_bind·IBM = identity),
 *   3. skin weights are normalized with ≤4 influences.
 *
 * This locks in the joint-placement fixes (hip-socket height, armpit width,
 * wrist pull-back, toe offset) so the skeleton generation can never silently
 * regress.  Run with: node --test test/autorig_accuracy.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF_GLB = join(__dirname, '..', 'assets', 'character_animated_1.glb');

// Reference joint world positions read from the original Mixamo skeleton.
const REF = {
  Hips: [0, 1.042, 0.016], Spine: [0, 1.144, 0.016], Spine1: [0, 1.245, 0.007],
  Spine2: [0, 1.336, -0.006], Neck: [0, 1.503, -0.032], Head: [0, 1.599, -0.015],
  LeftShoulder: [0.046, 1.445, -0.033], LeftArm: [0.152, 1.440, -0.056],
  LeftForeArm: [0.430, 1.439, -0.056], LeftHand: [0.713, 1.440, -0.054],
  RightShoulder: [-0.046, 1.445, -0.033], RightArm: [-0.152, 1.440, -0.055],
  RightForeArm: [-0.430, 1.440, -0.054], RightHand: [-0.713, 1.440, -0.050],
  LeftUpLeg: [0.082, 0.975, 0], LeftLeg: [0.082, 0.531, 0.007],
  LeftFoot: [0.082, 0.087, -0.027], LeftToeBase: [0.083, 0, 0.079],
  RightUpLeg: [-0.082, 0.975, 0], RightLeg: [-0.082, 0.531, 0.007],
  RightFoot: [-0.082, 0.087, -0.027], RightToeBase: [-0.083, 0, 0.079],
};
const H = 1.78;

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function pmapOf(root) {
  const m = new Map();
  for (const n of root.listNodes()) for (const c of n.listChildren()) m.set(c, n);
  return m;
}
function worldOf(n, pmap, cache) {
  if (cache.has(n)) return cache.get(n);
  const l = n.getMatrix(); const p = pmap.get(n);
  const w = p ? mat4Mul(worldOf(p, pmap, cache), l) : l;
  cache.set(n, w); return w;
}

async function makeIO() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await dracoLib.createDecoderModule(),
    'draco3d.encoder': await dracoLib.createEncoderModule(),
  });
}

// Strip the existing rig to a bare, world-space mesh GLB (simulates an unrigged upload).
async function stripToSkinless(io) {
  const doc = await io.readBinary(new Uint8Array(readFileSync(REF_GLB)));
  const root = doc.getRoot();
  const pmap = pmapOf(root); const wc = new Map();
  for (const node of root.listNodes()) {
    const skin = node.getSkin(); const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices()?.getArray();
    const counts = new Map();
    for (const prim of mesh.listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
      if (!J || !W) continue;
      const ji = [0, 0, 0, 0], wi = [0, 0, 0, 0];
      for (let i = 0; i < J.getCount(); i++) {
        J.getElement(i, ji); W.getElement(i, wi);
        for (let k = 0; k < 4; k++) if (wi[k] > 0) counts.set(ji[k], (counts.get(ji[k]) || 0) + wi[k]);
      }
    }
    let ref = 0, bw = -1; for (const [idx, w] of counts) if (w > bw) { bw = w; ref = idx; }
    const W = worldOf(joints[ref], pmap, wc);
    const S = mat4Mul(W, ibm.slice(ref * 16, ref * 16 + 16));
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); const a = pos.getArray().slice();
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i], y = a[i + 1], z = a[i + 2];
        a[i] = S[0] * x + S[4] * y + S[8] * z + S[12];
        a[i + 1] = S[1] * x + S[5] * y + S[9] * z + S[13];
        a[i + 2] = S[2] * x + S[6] * y + S[10] * z + S[14];
      }
      pos.setArray(a);
      for (const sem of ['JOINTS_0', 'WEIGHTS_0']) if (prim.getAttribute(sem)) prim.setAttribute(sem, null);
    }
    node.setSkin(null); node.setTranslation([0, 0, 0]); node.setRotation([0, 0, 0, 1]); node.setScale([1, 1, 1]);
    root.listScenes()[0].addChild(node);
  }
  for (const a of root.listAnimations()) a.dispose();
  for (const s of root.listSkins()) s.dispose();
  await doc.transform(prune({ keepLeaves: true }));
  const buf = await io.writeBinary(doc);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('auto-rig accuracy vs reference Mixamo skeleton', () => {
  it('guesses every joint within tolerance of the reference rig', async () => {
    const io = await makeIO();
    const skinless = await stripToSkinless(io);
    const guess = await guessJoints(skinless);

    assert.ok(guess.humanoid, 'reference mesh must be detected as humanoid');
    assert.ok(guess.score >= 80, `confidence score too low: ${guess.score}`);

    let maxErr = 0, sumErr = 0;
    const names = Object.keys(REF);
    for (const n of names) {
      const g = guess.joints[n];
      assert.ok(g, `joint ${n} missing from guess`);
      const e = Math.hypot(g[0] - REF[n][0], g[1] - REF[n][1], g[2] - REF[n][2]) / H * 100;
      maxErr = Math.max(maxErr, e); sumErr += e;
      // Per-joint guard: nothing may drift more than 8% of body height.
      assert.ok(e <= 8.0, `joint ${n} off by ${e.toFixed(1)}% of height (>8%)`);
    }
    const avg = sumErr / names.length;
    assert.ok(avg <= 5.0, `average joint error ${avg.toFixed(1)}% > 5%`);
  });

  it('rebuilds an exact bind with normalized weights', async () => {
    const io = await makeIO();
    const skinless = await stripToSkinless(io);
    const guess = await guessJoints(skinless);
    const rigged = await autoRigGLB(skinless, { joints: guess.joints });

    const doc = await io.readBinary(rigged);
    const root = doc.getRoot();
    const pmap = pmapOf(root); const wc = new Map();
    let bindErr = 0;
    for (const skin of root.listSkins()) {
      const joints = skin.listJoints();
      const ibm = skin.getInverseBindMatrices().getArray();
      joints.forEach((j, i) => {
        const w = worldOf(j, pmap, wc);
        const prod = mat4Mul(w, ibm.slice(i * 16, i * 16 + 16));
        for (let k = 0; k < 16; k++) bindErr = Math.max(bindErr, Math.abs(prod[k] - ID[k]));
      });
    }
    assert.ok(bindErr < 1e-4, `bind W·IBM not identity: max err ${bindErr.toExponential(2)}`);

    let badSum = 0, maxInf = 0, total = 0;
    for (const mesh of root.listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const W = prim.getAttribute('WEIGHTS_0'); if (!W) continue;
        const wi = [0, 0, 0, 0];
        for (let i = 0; i < W.getCount(); i++) {
          W.getElement(i, wi);
          const s = wi[0] + wi[1] + wi[2] + wi[3]; total++;
          if (Math.abs(s - 1) > 0.02) badSum++;
          let inf = 0; for (let k = 0; k < 4; k++) if (wi[k] > 1e-4) inf++;
          maxInf = Math.max(maxInf, inf);
        }
      }
    }
    assert.equal(badSum, 0, `${badSum}/${total} vertices have non-normalized weights`);
    assert.ok(maxInf <= 4, `max influences ${maxInf} > 4`);
  });
});
