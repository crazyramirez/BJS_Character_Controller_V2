import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHandFingers } from '../js/core/autorig_hands.mjs';
import { Document } from '@gltf-transform/core';
import BABYLON from 'babylonjs';
import { autoRigGLB, guessJointsFromBounds } from '../js/core/autorig_api.mjs';
import { createIO } from './helpers.mjs';

const names = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
function handFixture(count = 5, { fused = false, ambiguous = false, transform = p => p } = {}) {
  const positions = [], indices = [];
  const lengths = [0.115, 0.18, 0.19, 0.175, 0.155];
  const lateral = [-0.054, -0.02, 0, 0.02, 0.04];
  for (let f = 0; f < count; f++) {
    for (let ring = 0; ring <= 12; ring++) {
      const x = 0.02 + ((ambiguous ? 0.18 : lengths[f]) - 0.02) * ring / 12;
      for (let k = 0; k < 8; k++) {
        positions.push(...transform([x, (ambiguous ? f * 0.02 - 0.04 : lateral[f]) + Math.cos(k * Math.PI / 4) * 0.005,
          Math.sin(k * Math.PI / 4) * 0.005]));
        if (ring > 0) {
          const a = f * 104 + (ring - 1) * 8 + k, b = f * 104 + (ring - 1) * 8 + (k + 1) % 8;
          indices.push(a, b, a + 8, b, b + 8, a + 8);
        }
      }
    }
    if (f > 0) for (let ring = 0; ring < (fused ? 12 : 2); ring++) {
      const a = (f - 1) * 104 + ring * 8, b = f * 104 + ring * 8;
      indices.push(a, b, a + 8, b, b + 8, a + 8);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices),
    wrist: transform([0, 0, 0]), forearm: transform([-0.2, 0, 0]), tip: transform([0.19, 0, 0]) };
}
function detect(fixture, count = 5, scale = 1) {
  return detectHandFingers([fixture], fixture.wrist, fixture.forearm, { height: 1.8 * scale, fingers: names.slice(0, count), tip: fixture.tip });
}

for (const count of [2, 3, 4, 5]) test(`connected hand resolves ${count} real finger branches`, () => {
  const hand = handFixture(count), result = detect(hand, count);
  assert.equal(result.status, 'detected', result.reason);
  assert.equal(result.detectedCount, count);
  for (const finger of names.slice(0, count)) {
    assert.equal(result.joints[finger].length, 3);
    const chain = result.joints[finger];
    assert.ok(chain[0][0] < chain[1][0] && chain[1][0] < chain[2][0], finger);
  }
  assert.ok(result.tips.Thumb[1] < result.tips.Index[1], 'thumb has the correct anatomical label');
});

for (const scale of [0.001, 1, 1000]) test(`hand detection survives rotation, mirroring and scale ${scale}`, () => {
  const transform = ([x, y, z]) => [scale * (1 - z), scale * (2 - x), scale * (3 + y)];
  const base = detect(handFixture()), rotated = detect(handFixture(5, { transform }), 5, scale);
  assert.equal(rotated.status, 'detected', rotated.reason);
  for (const finger of names) for (let i = 0; i < 3; i++) {
    const expected = transform(base.joints[finger][i]);
    rotated.joints[finger][i].forEach((v, axis) => assert.ok(Math.abs(v - expected[axis]) < scale * 1e-6));
  }
});

test('a fused mitten does not fabricate five detected fingers', () => {
  const result = detect(handFixture(5, { fused: true }));
  assert.equal(result.status, 'review');
  assert.equal(result.joints, undefined);
});

test('ambiguous thumb and wrong finger count require review', () => {
  assert.equal(detect(handFixture(5, { ambiguous: true })).status, 'review');
  assert.equal(detect(handFixture(3), 5).status, 'review');
});

test('empty hand geometry and disabled fingers return explicit diagnostics', () => {
  const hand = { positions: new Float64Array(), wrist: [0, 0, 0], forearm: [-1, 0, 0], tip: [0.2, 0, 0] };
  assert.equal(detect(hand).status, 'review');
  assert.equal(detect(hand, 0).status, 'disabled');
});

test('bending the index finger leaves the adjacent fingertips in place', async () => {
  const io = await createIO(), doc = new Document(), buffer = doc.createBuffer();
  const scene = doc.createScene();
  const offset = ([x, y, z]) => [x + 0.6, y + 1.3, z];
  const hand = handFixture(5, { transform: offset });
  const detected = detectHandFingers([hand], hand.wrist, hand.forearm, { height: 2, fingers: names, tip: hand.tip });
  assert.equal(detected.status, 'detected');
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const body = doc.createPrimitive().setAttribute('POSITION', accessor('VEC3', new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 2, 0])));
  const fingers = doc.createPrimitive().setAttribute('POSITION', accessor('VEC3', new Float32Array(hand.positions)))
    .setIndices(accessor('SCALAR', hand.indices));
  scene.addChild(doc.createNode('Body').setMesh(doc.createMesh('Body').addPrimitive(body).addPrimitive(fingers)));
  const { joints } = guessJointsFromBounds({ min: [-0.8, 0, -0.1], max: [0.8, 2, 0.1] });
  for (const side of ['Left', 'Right']) {
    const mirror = p => [p[0] * (side === 'Left' ? 1 : -1), p[1], p[2]];
    joints[`${side}Arm`] = mirror([0.2, 1.3, 0]);
    joints[`${side}ForeArm`] = mirror(hand.forearm);
    joints[`${side}Hand`] = mirror(hand.wrist);
    for (const name of names) detected.joints[name].forEach((p, i) => { joints[`${side}Hand${name}${i + 1}`] = mirror(p); });
  }
  const output = await io.readBinary(await autoRigGLB(await io.writeBinary(doc), { joints, skinFingers: true, geodesicWeights: false }));
  const skin = output.getRoot().listSkins()[0];
  const primitive = output.getRoot().listNodes().find(n => n.getSkin()).getMesh().listPrimitives()[1];
  const render = v => {
    const p = BABYLON.Vector3.FromArray(primitive.getAttribute('POSITION').getElement(v, []));
    const j = primitive.getAttribute('JOINTS_0').getElement(v, []), w = primitive.getAttribute('WEIGHTS_0').getElement(v, []);
    return j.reduce((point, index, k) => {
      const matrix = BABYLON.Matrix.FromArray(skin.getInverseBindMatrices().getElement(index, []))
        .multiply(BABYLON.Matrix.FromArray(skin.listJoints()[index].getWorldMatrix()));
      return point.add(BABYLON.Vector3.TransformCoordinates(p, matrix).scale(w[k]));
    }, BABYLON.Vector3.Zero());
  };
  const tipVertices = names.map((_, f) => f * 104 + 96);
  const before = tipVertices.map(render);
  skin.listJoints().find(j => j.getName() === 'LeftHandIndex1').setRotation([0, 0, Math.sin(0.3), Math.cos(0.3)]);
  tipVertices.forEach((v, f) => {
    const displacement = BABYLON.Vector3.Distance(before[f], render(v));
    if (names[f] === 'Index') assert.ok(displacement > 0.01, 'the index finger bends');
    else assert.ok(displacement < 1e-5, `${names[f]} should not follow the index (${displacement})`);
  });
});
