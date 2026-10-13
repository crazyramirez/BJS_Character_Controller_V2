import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { guessJoints } from '../js/core/autorig_api.mjs';
import { createIO } from './helpers.mjs';

// Ground truth: artist/Mixamo-rigged characters. Each is reduced to its bare
// bind-pose mesh (skin, joints and animation removed), auto-rigged blind, and
// compared with the original bind joint positions.
const REFERENCES = [
  'character_animated.glb',             // T-pose, split eyes/lashes skins
  'character_animated_2.glb',           // flared garment
  'low_poly.glb',                       // 8-vertex finger tubes
  'characters_test/business_man.glb',
  'characters_test/gang.glb',           // Body/Bottoms/Shoes meshes, fingerless gloves, held crowbar
  'characters_test/medieval_character_sample.glb', // armour split into Tops/Bottoms
  'characters_test/pepe.glb',           // cartoon proportions
  'characters_test/prisioner_hostage.glb', // two fingers fused: review, markers still placed
  'characters_test/talking_male.glb',   // arms down
];
const FUSED_FINGERS = new Set(['characters_test/prisioner_hostage.glb']);
const BODY = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm',
  'LeftHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightArm', 'RightUpLeg', 'RightFoot'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

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

async function bareBindMesh(path) {
  const io = await createIO();
  const doc = await io.readBinary(await fs.readFile(new URL(`../assets/${path}`, import.meta.url)));
  const truth = {};
  for (const skin of doc.getRoot().listSkins()) {
    const S = mul(skin.listJoints()[0].getWorldMatrix(), skin.getInverseBindMatrices().getElement(0, []));
    skin.listJoints().forEach((joint, i) => {
      const bind = mul(S, invertAffine(skin.getInverseBindMatrices().getElement(i, [])));
      truth[canonical(joint.getName())] ??= [bind[12], bind[13], bind[14]];
    });
  }
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin(), mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const S = mul(skin.listJoints()[0].getWorldMatrix(), skin.getInverseBindMatrices().getElement(0, []));
    node.setSkin(null).setMatrix(Array.from(S));
    node.getParentNode()?.removeChild(node);
    scene.addChild(node);
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) if (/^(JOINTS|WEIGHTS)_/.test(semantic)) prim.setAttribute(semantic, null);
    }
  }
  for (const skin of doc.getRoot().listSkins()) skin.dispose();
  for (const animation of doc.getRoot().listAnimations()) animation.dispose();
  return { buffer: await io.writeBinary(doc), truth };
}

for (const path of REFERENCES) {
  test(`blind auto-rig lands on the artist joints: ${path}`, async () => {
    const quiet = console.log; console.log = () => {};
    let guess, truth;
    try {
      const bare = await bareBindMesh(path);
      truth = bare.truth;
      guess = await guessJoints(bare.buffer);
    } finally { console.log = quiet; }
    const error = name => Math.hypot(...guess.joints[name].map((v, k) => v - truth[name][k])) / guess.height;
    const body = BODY.map(name => [name, error(name)]);
    const mean = body.reduce((s, [, e]) => s + e, 0) / body.length;
    const [worst, worstError] = body.reduce((a, b) => (b[1] > a[1] ? b : a));
    assert.ok(mean < 0.03, `${path}: mean body error ${(mean * 100).toFixed(2)}% of height`);
    assert.ok(worstError < 0.065, `${path}: ${worst} off by ${(worstError * 100).toFixed(2)}% of height`);
    // Anatomical sides follow the facing the mesh was authored with.
    assert.ok(Math.sign(truth.LeftArm[0] - truth.RightArm[0]) === Math.sign(guess.joints.LeftArm[0] - guess.joints.RightArm[0]), 'left/right sides');
    for (const side of ['Left', 'Right']) {
      assert.equal(guess.fingerDetection[side].status, FUSED_FINGERS.has(path) ? 'review' : 'detected',
        `${side} hand: ${guess.fingerDetection[side].reason}`);
      for (const finger of FINGERS) for (let i = 1; i <= 3; i++) {
        const name = `${side}Hand${finger}${i}`;
        if (!truth[name]) continue; // rig without this digit
        assert.ok(error(name) < 0.03, `${path}: ${name} off by ${(error(name) * 100).toFixed(2)}% of height`);
      }
    }
  });
}
