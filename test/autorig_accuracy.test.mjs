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
import { guessJoints, autoRigGLB, analyzeRig } from '../js/core/autorig_api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF_GLB = join(__dirname, '..', 'assets', 'character_animated_1.glb');
const BOY_GLB = join(__dirname, '..', 'assets', '3d_character_young_boy.glb');

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

describe('regenerate-skeleton flow (re-rig with existing skin)', () => {
  it('seeds every joint exactly from the existing skeleton', async () => {
    const buf = readFileSync(REF_GLB);
    const guess = await guessJoints(buf, { fingerCount: 5, forceRebuild: true });
    assert.ok(guess.reRig, 'existing skin must be detected as re-rig');
    for (const n of Object.keys(REF)) {
      const g = guess.joints[n];
      assert.ok(g, `joint ${n} missing`);
      const e = Math.hypot(g[0] - REF[n][0], g[1] - REF[n][1], g[2] - REF[n][2]) / H * 100;
      assert.ok(e <= 0.5, `seeded joint ${n} off by ${e.toFixed(2)}% of height (seeds must be exact)`);
    }
  });

  it('a stale flipFacing flag cannot mirror a correctly-seeded rig', async () => {
    // Regression: the "faces backward" checkbox persisting from a previous
    // character used to swap Left/Right labels and 180°-flip the bind on a
    // perfectly seeded skeleton (crossed arms, mirrored fingers). The toe
    // markers are the facing ground truth and must win over the override.
    const io = await makeIO();
    const buf = readFileSync(REF_GLB);
    const guess = await guessJoints(buf, { fingerCount: 5, forceRebuild: true, flipFacing: true });
    // Seeded joints keep their true sides regardless of the flag.
    assert.ok(guess.joints.LeftArm[0] > 0, 'LeftArm must stay at +X (seeded truth)');
    const rigged = await autoRigGLB(buf, { joints: guess.joints, fingerCount: 5, forceRebuild: true, flipFacing: true });
    const doc = await io.readBinary(rigged);
    const pmap = pmapOf(doc.getRoot()); const wc = new Map();
    for (const skin of doc.getRoot().listSkins()) {
      const joints = skin.listJoints();
      const ibm = skin.getInverseBindMatrices().getArray();
      joints.forEach((j, i) => {
        // Bind must stay exact (W·IBM = identity)…
        const prod = mat4Mul(worldOf(j, pmap, wc), ibm.slice(i * 16, i * 16 + 16));
        for (let k = 0; k < 16; k++) {
          assert.ok(Math.abs(prod[k] - ID[k]) < 1e-4, `bind not identity at ${j.getName()}`);
        }
        // …and named joints must stay on their anatomical side (no mirror).
        const ref = REF[j.getName()];
        if (!ref || Math.abs(ref[0]) < 0.02) return;
        const w = worldOf(j, pmap, wc);
        assert.ok(Math.sign(w[12]) === Math.sign(ref[0]),
          `${j.getName()} mirrored to x=${w[12].toFixed(3)} (expected side of ${ref[0]})`);
      });
    }
  });
});

// Byte-signature of the first skinned primitive's weights — proves whether a
// re-rig KEPT the artist weights (identical) or re-skinned them (changed).
function weightSig(root) {
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const W = p.getAttribute('WEIGHTS_0'); if (!W) continue;
    const a = W.getArray(); let s = 0;
    for (let i = 0; i < Math.min(a.length, 8000); i++) s = (s + Math.round(a[i] * 1000)) % 1e9;
    return `${W.getCount()}:${s}`;
  }
  return null;
}

// Skinned rest-pose bounding box of hand/finger vertices — compares a rig before
// and after a re-rig to catch mesh skew that the bind-identity check alone misses.
function fingerRestBBox(root) {
  const pmap = pmapOf(root); const wc = new Map();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(), skin = node.getSkin();
    if (!mesh || !skin) continue;
    const joints = skin.listJoints();
    const isFinger = joints.map(j => /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(j.getName()));
    const ibm = skin.getInverseBindMatrices().getArray();
    const SM = joints.map((j, i) => mat4Mul(worldOf(j, pmap, wc), ibm.slice(i * 16, i * 16 + 16)));
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION'), J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
      if (!P || !J || !W) continue;
      const pos = [0, 0, 0], ji = [0, 0, 0, 0], wi = [0, 0, 0, 0];
      for (let v = 0; v < P.getCount(); v++) {
        P.getElement(v, pos); J.getElement(v, ji); W.getElement(v, wi);
        let fw = 0; for (let k = 0; k < 4; k++) if (isFinger[ji[k]]) fw += wi[k];
        if (fw < 0.5) continue;
        const o = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          if (wi[k] <= 0) continue; const M = SM[ji[k]];
          o[0] += wi[k] * (M[0] * pos[0] + M[4] * pos[1] + M[8] * pos[2] + M[12]);
          o[1] += wi[k] * (M[1] * pos[0] + M[5] * pos[1] + M[9] * pos[2] + M[13]);
          o[2] += wi[k] * (M[2] * pos[0] + M[6] * pos[1] + M[10] * pos[2] + M[14]);
        }
        for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], o[a]); mx[a] = Math.max(mx[a], o[a]); }
      }
    }
  }
  return { mn, mx };
}
function fingerRestDrift(a, b) {
  const A = fingerRestBBox(a), B = fingerRestBBox(b);
  let d = 0;
  for (let i = 0; i < 3; i++) d = Math.max(d, Math.abs(A.mn[i] - B.mn[i]), Math.abs(A.mx[i] - B.mx[i]));
  return d;
}

// A Regenerate on a character that ALREADY has a valid, named humanoid rig must
// be non-destructive: it moves joints to the markers but keeps the original
// artist skin weights, so thighs/hips/fingers cannot deform from a re-skin.
// This is the direct regression guard for the reported deformation bug.
describe('regenerate preserves artist weights on already-valid rigs', () => {
  for (const [label, GLB, H2] of [['character_animated_1', REF_GLB, 1.78], ['3d_character_young_boy', BOY_GLB, 1.865]]) {
    it(`${label}: analyzeRig reports the rig preservable`, async () => {
      const info = await analyzeRig(readFileSync(GLB));
      assert.ok(info.hasSkin, 'has skin');
      assert.ok(info.preservable, `rig must be preservable (mappable=${info.mappableCount}, sane=${info.sane})`);
      assert.ok(info.mappableCount >= 20, `expected a full humanoid core, got ${info.mappableCount}`);
    });

    it(`${label}: default regenerate keeps weights byte-identical`, async () => {
      const io = await makeIO();
      const buf = readFileSync(GLB);
      const origSig = weightSig((await io.readBinary(new Uint8Array(buf))).getRoot());
      const guess = await guessJoints(buf, { fingerCount: 5 });
      // No forceRebuild → preserve path.
      const rigged = await autoRigGLB(buf, { joints: guess.joints, fingerCount: 5, preserveWeights: true });
      const root = (await io.readBinary(rigged)).getRoot();
      assert.equal(weightSig(root), origSig, 'artist weights must be preserved (no re-skin)');
    });

    it(`${label}: forceRebuild DOES re-skin (control)`, async () => {
      const io = await makeIO();
      const buf = readFileSync(GLB);
      const origSig = weightSig((await io.readBinary(new Uint8Array(buf))).getRoot());
      const guess = await guessJoints(buf, { fingerCount: 5, forceRebuild: true });
      const rigged = await autoRigGLB(buf, { joints: guess.joints, fingerCount: 5, forceRebuild: true });
      const root = (await io.readBinary(rigged)).getRoot();
      assert.notEqual(weightSig(root), origSig, 'explicit rebuild must re-skin');
    });

    it(`${label}: a no-edit re-rig leaves the finger mesh in place`, async () => {
      const io = await makeIO();
      const buf = readFileSync(GLB);
      const guess = await guessJoints(buf, { fingerCount: 5 });
      // Same joints back (no drag) → must not skew the skinned mesh at rest.
      const rigged = await autoRigGLB(buf, { joints: guess.joints, fingerCount: 5, preserveWeights: true });
      const drift = fingerRestDrift(
        (await io.readBinary(new Uint8Array(buf))).getRoot(),
        (await io.readBinary(rigged)).getRoot(),
      );
      // 1mm tolerance absorbs draco re-encode; a real skew (the bug) was ~7mm.
      assert.ok(drift < 0.001 * H2 + 0.0015, `finger rest mesh drifted ${(drift * 1000).toFixed(2)}mm on a no-edit re-rig`);
    });

    it(`${label}: preserved rig has a valid rest bind (passes the safety gate)`, async () => {
      const io = await makeIO();
      const buf = readFileSync(GLB);
      const guess = await guessJoints(buf, { fingerCount: 5 });
      // Would throw inside autoRigGLB if the gate tripped; also verify here.
      const rigged = await autoRigGLB(buf, { joints: guess.joints, fingerCount: 5, preserveWeights: true });
      const root = (await io.readBinary(rigged)).getRoot();
      const pmap = pmapOf(root); const wc = new Map();
      let maxErr = 0;
      for (const skin of root.listSkins()) {
        const joints = skin.listJoints();
        const ibm = skin.getInverseBindMatrices().getArray();
        joints.forEach((j, i) => {
          const prod = mat4Mul(worldOf(j, pmap, wc), ibm.slice(i * 16, i * 16 + 16));
          for (let k = 0; k < 16; k++) maxErr = Math.max(maxErr, Math.abs(prod[k] - ID[k]));
        });
      }
      assert.ok(maxErr < 0.05, `rest bind must be near-identity, got ${maxErr.toExponential(2)}`);
    });
  }
});

// Skinned rest-pose bbox of a horizontal Y-band of the body. Draco re-encode
// permutes vertex order, so per-index comparisons are meaningless — band bboxes
// are permutation-proof and still catch region-level skew.
function bandRestBBox(root, y0, y1) {
  const pmap = pmapOf(root); const wc = new Map();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(), skin = node.getSkin();
    if (!mesh || !skin) continue;
    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices().getArray();
    const SM = joints.map((j, i) => mat4Mul(worldOf(j, pmap, wc), ibm.slice(i * 16, i * 16 + 16)));
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION'), J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
      if (!P || !J || !W) continue;
      const pos = [0, 0, 0], ji = [0, 0, 0, 0], wi = [0, 0, 0, 0];
      for (let v = 0; v < P.getCount(); v++) {
        P.getElement(v, pos); J.getElement(v, ji); W.getElement(v, wi);
        const o = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          if (wi[k] <= 0) continue; const M = SM[ji[k]];
          o[0] += wi[k] * (M[0] * pos[0] + M[4] * pos[1] + M[8] * pos[2] + M[12]);
          o[1] += wi[k] * (M[1] * pos[0] + M[5] * pos[1] + M[9] * pos[2] + M[13]);
          o[2] += wi[k] * (M[2] * pos[0] + M[6] * pos[1] + M[10] * pos[2] + M[14]);
        }
        if (o[1] < y0 || o[1] > y1) continue;
        for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], o[a]); mx[a] = Math.max(mx[a], o[a]); }
      }
    }
  }
  return { mn, mx };
}
function bandDrift(rootA, rootB, y0, y1) {
  const A = bandRestBBox(rootA, y0, y1), B = bandRestBBox(rootB, y0, y1);
  let d = 0;
  for (let i = 0; i < 3; i++) d = Math.max(d, Math.abs(A.mn[i] - B.mn[i]), Math.abs(A.mx[i] - B.mx[i]));
  return d;
}

// A marker edit during re-rig must only perturb the subtree it touches.
// Regression: composing bind-parent rotations with rest-pose local rotations
// accumulated rest-vs-bind mismatch down long chains — ANY marker edit skewed
// the hands/head by ~0.5% of body height on character_animated_1.
describe('re-rig marker edits stay local to the edited limb', () => {
  for (const [label, GLB, H2] of [['character_animated_1', REF_GLB, 1.78], ['3d_character_young_boy', BOY_GLB, 1.865]]) {
    it(`${label}: raising LeftHand 3cm leaves legs and head untouched`, async () => {
      const io = await makeIO();
      const buf = readFileSync(GLB);
      const guess = await guessJoints(buf, { fingerCount: 5 });
      const joints = JSON.parse(JSON.stringify(guess.joints));
      joints.LeftHand = [joints.LeftHand[0], joints.LeftHand[1] + 0.03, joints.LeftHand[2]];
      const rigged = await autoRigGLB(buf, { joints, fingerCount: 5, preserveWeights: true });
      const before = (await io.readBinary(new Uint8Array(buf))).getRoot();
      const after = (await io.readBinary(rigged)).getRoot();
      // Legs/feet band (below the knee) and head band must not move.
      const legs = bandDrift(before, after, -Infinity, 0.45);
      const head = bandDrift(before, after, 0.88 * H2, Infinity);
      assert.ok(legs < 0.002, `legs skewed ${(legs * 1000).toFixed(2)}mm by a hand marker edit`);
      assert.ok(head < 0.002, `head skewed ${(head * 1000).toFixed(2)}mm by a hand marker edit`);
    });
  }
});

// forceRebuild WITHOUT client markers must still inherit joint positions and
// facing from a sane stripped rig. Regression: the post-strip mesh guess ran
// blind — on 3d_character_young_boy it flipped the facing and mirrored
// Left/Right (mean joint error 35% of body height, mirrored animations).
describe('forceRebuild inherits seeds from a sane stripped rig', () => {
  it('3d_character_young_boy: rebuild without markers keeps sides and positions', async () => {
    const io = await makeIO();
    const buf = readFileSync(BOY_GLB);
    const seeds = (await guessJoints(buf, { fingerCount: 5 })).joints; // seeded truth
    const rigged = await autoRigGLB(buf, { fingerCount: 5, forceRebuild: true }); // NO joints passed
    const root = (await io.readBinary(rigged)).getRoot();
    const pmap = pmapOf(root); const wc = new Map();
    const H2 = 1.865;
    for (const skin of root.listSkins()) {
      for (const j of skin.listJoints()) {
        const s = seeds[j.getName()];
        if (!s) continue;
        const w = worldOf(j, pmap, wc);
        const e = Math.hypot(w[12] - s[0], w[13] - s[1], w[14] - s[2]) / H2 * 100;
        assert.ok(e <= 1.0, `${j.getName()} rebuilt ${e.toFixed(1)}% of height away from the sane rig it replaced`);
        // Explicit anti-mirror guard on lateral joints.
        if (Math.abs(s[0]) > 0.05) {
          assert.equal(Math.sign(w[12]), Math.sign(s[0]), `${j.getName()} mirrored across the midline`);
        }
      }
    }
  });
});

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
