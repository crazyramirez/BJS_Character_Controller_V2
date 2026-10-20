import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { autoRigGLB, deformationStressTest } from '../js/core/autorig_api.mjs';
import { createIO } from './helpers.mjs';

// Skin-weight quality against artist rigs. Each Mixamo-named character is
// reduced to its bare bind mesh and rigged from its OWN bind joints (so the
// numbers measure weights, not joint placement); the generated weights are
// then compared per vertex with the artist's. Bones one side lacks merge into
// their nearest ancestor present on both sides, and finger bones into the hand
// (finger skinning has its own tests).
//   error     = ½·Σ|w_artist − w_auto| per vertex, averaged (0 = identical)
//   dominant  = share of vertices whose strongest bone differs
// Baseline before the 2026-10 weighting pass (d^-4, 5 smoothing passes,
// per-primitive smoothing): mean error 23.06%, dominant 15.18%
//   character_animated 30.19/10.57  character_animated_2 24.20/14.69
//   low_poly 23.87/27.39  business_man 23.50/8.53  gang 19.55/11.51
//   medieval 19.91/10.34  pepe 18.97/16.16  prisioner 23.43/20.69
//   talking_male 23.88/16.76
// After (d^-6, 2 passes, rigid skull, joint-centred blends, pelvis/chest
// bars, light clavicles): mean error 11.65%, dominant 10.44%
//   character_animated 8.39/7.24  character_animated_2 14.95/12.63
//   low_poly 19.85/22.71  business_man 9.36/5.47  gang 10.59/5.59
//   medieval 9.18/4.80  pepe 9.97/13.51  prisioner 11.69/10.63
//   talking_male 10.88/11.38
// Third column: mean region score of the deformation stress test (0..1) on the
// generated skin; before → after 0.998/0.998/0.925/0.920/0.969/0.906/0.992/
// 0.823/0.981 (mean 0.946) → values below (mean 0.954). The artist skins score
// 0.987/1.000/0.955/0.994/1.000/0.867/1.000/0.957/0.972 in the same poses.
const REFERENCES = {
  'character_animated.glb': [8.39, 7.24, 0.986],
  'character_animated_2.glb': [14.95, 12.63, 0.998],
  'low_poly.glb': [19.85, 22.71, 0.945],
  'characters_test/business_man.glb': [9.36, 5.47, 0.878],
  'characters_test/gang.glb': [10.59, 5.59, 1.000],
  'characters_test/medieval_character_sample.glb': [9.18, 4.80, 0.961],
  'characters_test/pepe.glb': [9.97, 13.51, 0.998],
  'characters_test/prisioner_hostage.glb': [11.69, 10.63, 0.836],
  'characters_test/talking_male.glb': [10.88, 11.38, 0.987],
};
const MEAN_ERROR_LIMIT = 12.5, MEAN_DOMINANT_LIMIT = 11.5; // % (measured 11.65 / 10.44)
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const BODY = {
  Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};

const mul = (a, b) => {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
};
const invertAffine = a => {
  const r = [[a[0], a[4], a[8]], [a[1], a[5], a[9]], [a[2], a[6], a[10]]];
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  const cof = (i, j) => {
    const m = r.filter((_, k) => k !== i).map(row => row.filter((_, l) => l !== j));
    return ((i + j) % 2 ? -1 : 1) * (m[0][0] * m[1][1] - m[0][1] * m[1][0]);
  };
  const out = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[j * 4 + i] = cof(j, i) / det;
  for (let i = 0; i < 3; i++) out[12 + i] = -(out[i] * a[12] + out[4 + i] * a[13] + out[8 + i] * a[14]);
  out[15] = 1;
  return out;
};
const canonical = name => name.replace(/^mixamorig\d*:?/, '').replace(/_\d+$/, '');
const fingerSide = name => name.match(/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)\d$/)?.[1];

// Per vertex: Map(bone → normalized weight), bones renamed through `rename`.
function readWeights(prim, jointNames, rename) {
  const sets = prim.listSemantics().filter(s => /^JOINTS_\d+$/.test(s))
    .map(s => [prim.getAttribute(s), prim.getAttribute(s.replace('JOINTS', 'WEIGHTS'))]);
  return Array.from({ length: prim.getAttribute('POSITION').getCount() }, (_, v) => {
    const m = new Map();
    let total = 0;
    for (const [j, w] of sets) {
      const jj = j.getElement(v, []), ww = w.getElement(v, []);
      for (let k = 0; k < 4; k++) if (ww[k] > 0) {
        const bone = rename(jointNames[jj[k]]);
        m.set(bone, (m.get(bone) || 0) + ww[k]);
        total += ww[k];
      }
    }
    for (const [b, w] of m) m.set(b, w / total);
    return m;
  });
}

async function measure(path) {
  const io = await createIO();
  const doc = await io.readBinary(await fs.readFile(new URL(`../assets/${path}`, import.meta.url)));
  const root = doc.getRoot();
  const truth = {}, parentOf = {};
  for (const skin of root.listSkins()) {
    const S = mul(skin.listJoints()[0].getWorldMatrix(), skin.getInverseBindMatrices().getElement(0, []));
    const members = new Set(skin.listJoints());
    skin.listJoints().forEach((joint, i) => {
      const name = canonical(joint.getName());
      const bind = mul(S, invertAffine(skin.getInverseBindMatrices().getElement(i, [])));
      truth[name] ??= [bind[12], bind[13], bind[14]];
      const parent = root.listNodes().find(n => n.listChildren().includes(joint));
      if (parent && members.has(parent)) parentOf[name] ??= canonical(parent.getName());
    });
  }
  const fingerCount = FINGERS.every(f => [1, 2, 3].every(i => truth[`LeftHand${f}${i}`] && truth[`RightHand${f}${i}`])) ? 5 : 0;
  const ancestorIn = (name, keep) => {
    for (let n = name, guard = 0; n && guard < 64; n = parentOf[n], guard++) if (keep(n)) return n;
    return 'Hips';
  };
  const merged = name => fingerSide(name) ? `${fingerSide(name)}Hand` : ancestorIn(name, n => n in BODY);
  const full = name => ancestorIn(name, n => n in BODY || (fingerCount > 0 && !!fingerSide(n)));
  const artist = new Map();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  let id = 0;
  for (const node of root.listNodes()) {
    const skin = node.getSkin(), mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const names = skin.listJoints().map(j => canonical(j.getName()));
    for (const prim of mesh.listPrimitives()) {
      prim.setExtras({ ...prim.getExtras(), weightRef: ++id });
      artist.set(id, { merged: readWeights(prim, names, merged), full: readWeights(prim, names, full) });
      // The rigged output compacts vertex buffers (unused vertices dropped,
      // order changed): carry each source index through as an attribute.
      const count = prim.getAttribute('POSITION').getCount();
      prim.setAttribute('_SOURCE_INDEX', doc.createAccessor().setType('SCALAR').setBuffer(root.listBuffers()[0])
        .setArray(Float32Array.from({ length: count }, (_, i) => i)));
      for (const semantic of prim.listSemantics()) if (/^(JOINTS|WEIGHTS)_/.test(semantic)) prim.setAttribute(semantic, null);
    }
    const S = mul(skin.listJoints()[0].getWorldMatrix(), skin.getInverseBindMatrices().getElement(0, []));
    node.setSkin(null).setMatrix(Array.from(S));
    node.getParentNode?.()?.removeChild(node);
    scene.addChild(node);
  }
  for (const skin of root.listSkins()) skin.dispose();
  for (const animation of root.listAnimations()) animation.dispose();
  // Uncompressed: Draco would re-encode (quantize, reorder) the source indices.
  root.listExtensionsUsed().find(e => e.extensionName === 'KHR_draco_mesh_compression')?.dispose();
  const names = [...Object.keys(BODY), ...(fingerCount ? ['Left', 'Right'].flatMap(s => FINGERS.flatMap(f => [1, 2, 3].map(i => `${s}Hand${f}${i}`))) : [])];
  const reportSink = {};
  const rigged = await io.readBinary(await autoRigGLB(await io.writeBinary(doc), {
    joints: Object.fromEntries(names.map(n => [n, truth[n]])), fingerCount, skinFingers: fingerCount > 0, reportSink,
  }));

  let vertices = 0, error = 0, dominant = 0;
  const ours = [], reference = [];
  let order, hierarchy, joints;
  for (const node of rigged.getRoot().listNodes()) {
    const skin = node.getSkin(), mesh = node.getMesh();
    if (!skin || !mesh) continue;
    order = skin.listJoints().map(j => j.getExtras()?.bjsCanonical || j.getName());
    joints = Object.fromEntries(skin.listJoints().map((j, i) => [order[i], j.getWorldTranslation()]));
    hierarchy = Object.fromEntries(skin.listJoints().map((j, i) => [order[i],
      rigged.getRoot().listNodes().find(n => n.listChildren().includes(j))?.getExtras()?.bjsCanonical || null]));
    for (const prim of mesh.listPrimitives()) {
      const ref = artist.get(prim.getExtras()?.weightRef);
      if (!ref) continue;
      const source = prim.getAttribute('_SOURCE_INDEX').getArray();
      const mine = readWeights(prim, order, name => fingerSide(name) ? `${fingerSide(name)}Hand` : name);
      for (let v = 0; v < mine.length; v++) {
        const a = ref.merged[source[v]], b = mine[v];
        let e = 0, aBone = null, aMax = -1, bBone = null, bMax = -1;
        for (const [k, w] of a) { e += Math.abs(w - (b.get(k) || 0)); if (w > aMax) { aMax = w; aBone = k; } }
        for (const [k, w] of b) { if (!a.has(k)) e += w; if (w > bMax) { bMax = w; bBone = k; } }
        vertices++; error += e / 2; if (aBone !== bBone) dominant++;
      }
      // Same stress poses on the artist weights (strongest first) for scale.
      const positions = prim.getAttribute('POSITION').getArray(), indices = prim.getIndices()?.getArray();
      ours.push({ positions, indices, joints: prim.getAttribute('JOINTS_0').getArray(), weights: prim.getAttribute('WEIGHTS_0').getArray() });
      const J = new Uint16Array(source.length * 4), W = new Float32Array(source.length * 4);
      for (let v = 0; v < source.length; v++) {
        const top = [...ref.full[source[v]]].sort((x, y) => y[1] - x[1]).slice(0, 4);
        const sum = top.reduce((s, x) => s + x[1], 0);
        top.forEach(([k, w], i) => { J[v * 4 + i] = Math.max(0, order.indexOf(k)); W[v * 4 + i] = w / sum; });
      }
      reference.push({ positions, indices, joints: J, weights: W });
    }
  }
  const options = { order, hierarchy, joints, height: reportSink.restValidation.tolerance / 2e-5,
    forward: [0, 0, Math.sign(joints.LeftToeBase[2] - joints.LeftFoot[2]) || 1],
    left: joints.LeftArm.map((v, i) => v - joints.RightArm[i]), fingerSides: fingerCount ? ['Left', 'Right'] : [] };
  const meanScore = r => { const s = Object.values(r.regions).map(x => x.score); return s.reduce((a, b) => a + b, 0) / s.length; };
  return {
    vertices, error: 100 * error / vertices, dominant: 100 * dominant / vertices, report: reportSink,
    deformation: { ours: meanScore(deformationStressTest({ parts: ours, ...options })),
      artist: meanScore(deformationStressTest({ parts: reference, ...options })) },
  };
}

const results = {};
for (const [path, [error, dominant, deformation]] of Object.entries(REFERENCES)) {
  test(`auto weights stay close to the artist's: ${path}`, async () => {
    const quiet = console.log; console.log = () => {};
    let r;
    try { r = await measure(path); } finally { console.log = quiet; }
    results[path] = r;
    assert.ok(r.vertices > 1000, `${path}: ${r.vertices} vertices compared`);
    assert.ok(r.error < error * 1.1 + 0.5, `${path}: weight error ${r.error.toFixed(2)}% (recorded ${error}%)`);
    assert.ok(r.dominant < dominant * 1.1 + 0.5, `${path}: dominant-bone mismatch ${r.dominant.toFixed(2)}% (recorded ${dominant}%)`);
    // Stress poses: no deformation regression (the artist score is printed for scale).
    assert.ok(r.deformation.ours > deformation - 0.05, `${path}: deformation ${r.deformation.ours.toFixed(3)} (recorded ${deformation}, artist ${r.deformation.artist.toFixed(3)})`);
  });
}

test('mean weight error over the artist rigs', () => {
  const rows = Object.entries(results);
  assert.equal(rows.length, Object.keys(REFERENCES).length, 'every reference measured');
  console.log('asset'.padEnd(46), 'verts'.padStart(7), 'error%'.padStart(8), 'dominant%'.padStart(10), 'deform ours/artist');
  for (const [path, r] of rows) {
    console.log(path.padEnd(46), String(r.vertices).padStart(7), r.error.toFixed(2).padStart(8), r.dominant.toFixed(2).padStart(10),
      `${r.deformation.ours.toFixed(3)}/${r.deformation.artist.toFixed(3)}`);
  }
  const mean = key => rows.reduce((s, [, r]) => s + r[key], 0) / rows.length;
  console.log('MEAN'.padEnd(54), mean('error').toFixed(2).padStart(8), mean('dominant').toFixed(2).padStart(10));
  assert.ok(mean('error') < MEAN_ERROR_LIMIT, `mean weight error ${mean('error').toFixed(2)}%`);
  assert.ok(mean('dominant') < MEAN_DOMINANT_LIMIT, `mean dominant-bone mismatch ${mean('dominant').toFixed(2)}%`);
});
