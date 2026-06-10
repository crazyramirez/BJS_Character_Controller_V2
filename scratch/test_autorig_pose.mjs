/**
 * Non-standard pose test: a SITTING mannequin (legs forward, arms hanging).
 * The slicing detector must fail its flags and guessJointsAuto must switch to
 * the topology pass, classifying limbs correctly despite the pose.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { guessJoints } from '../js/core/autorig_api.mjs';

// Triangulated tubes around limb segments (proper closed surface per tube —
// sequential indices over raw points would create false bridges between limbs)
const pts = [];
const indices = [];
function tube(a, b, r, rings = 40, around = 18) {
  const base = pts.length / 3;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d);
  const dir = d.map(v => v / len);
  // two perpendiculars
  const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [
    dir[1] * ref[2] - dir[2] * ref[1],
    dir[2] * ref[0] - dir[0] * ref[2],
    dir[0] * ref[1] - dir[1] * ref[0],
  ];
  const ul = Math.hypot(...u); u.forEach((v, i) => u[i] = v / ul);
  const w = [
    dir[1] * u[2] - dir[2] * u[1],
    dir[2] * u[0] - dir[0] * u[2],
    dir[0] * u[1] - dir[1] * u[0],
  ];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const c = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
    for (let k = 0; k < around; k++) {
      const ang = (k / around) * Math.PI * 2;
      const co = Math.cos(ang) * r, si = Math.sin(ang) * r;
      pts.push(c[0] + u[0] * co + w[0] * si, c[1] + u[1] * co + w[1] * si, c[2] + u[2] * co + w[2] * si);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < around; k++) {
      const k2 = (k + 1) % around;
      const a0 = base + i * around + k, a1 = base + i * around + k2;
      const b0 = base + (i + 1) * around + k, b1 = base + (i + 1) * around + k2;
      indices.push(a0, a1, b0, a1, b1, b0);
    }
  }
  // End caps (real meshes are closed — open tubes leak the interior fill)
  const capA = pts.length / 3; pts.push(a[0], a[1], a[2]);
  const capB = pts.length / 3; pts.push(b[0], b[1], b[2]);
  for (let k = 0; k < around; k++) {
    const k2 = (k + 1) % around;
    indices.push(capA, base + k2, base + k);
    indices.push(capB, base + rings * around + k, base + rings * around + k2);
  }
}

// Sitting pose: torso upright, legs bent forward (+Z), arms hanging down
tube([0, 0.60, 0], [0, 1.10, 0], 0.13);          // torso
tube([0, 1.10, 0], [0, 1.20, 0], 0.05);          // neck
tube([0, 1.22, 0], [0, 1.40, 0], 0.11, 20);      // head
for (const s of [1, -1]) {
  tube([s * 0.12, 0.62, 0.02], [s * 0.12, 0.60, 0.45], 0.07);   // thigh forward
  tube([s * 0.12, 0.60, 0.45], [s * 0.12, 0.12, 0.48], 0.06);   // shin down
  tube([s * 0.12, 0.12, 0.48], [s * 0.12, 0.06, 0.66], 0.05);   // foot forward
  tube([s * 0.08, 1.04, 0], [s * 0.26, 0.78, -0.04], 0.05);     // upper arm down (rooted inside torso)
  tube([s * 0.26, 0.78, -0.04], [s * 0.33, 0.50, -0.08], 0.045); // forearm down, clear of the thigh
}

const doc = new Document();
const buffer = doc.createBuffer();
const posArr = new Float32Array(pts);
const pos = doc.createAccessor().setType('VEC3').setArray(posArr).setBuffer(buffer);
const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer);
const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);
doc.createScene('s').addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
const glb = await new NodeIO().writeBinary(doc);

const guess = await guessJoints(glb);
const J = guess.joints;
console.log('method:', guess.method, '| confidence:', guess.confidence?.toFixed(2) ?? '-');
for (const n of ['Hips', 'Head', 'Neck', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftLeg', 'LeftArm']) {
  console.log(`  ${n.padEnd(10)} ${J[n].map(v => v.toFixed(2)).join(',')}`);
}

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
if (guess.method !== 'topology') fail(`expected topology method, got ${guess.method}`);
if (!(J.Head[1] > 1.1)) fail('Head not at the top');
if (!(J.LeftFoot[2] > 0.3 && J.RightFoot[2] > 0.3)) fail('Feet not forward (+Z) — legs misclassified');
if (!(J.LeftFoot[1] < 0.3 && J.RightFoot[1] < 0.3)) fail('Feet not low');
if (!(J.LeftHand[1] < 0.9 && J.RightHand[1] < 0.9)) fail('Hands not hanging down — arms misclassified');
if (!(J.LeftHand[2] < 0.25 && J.RightHand[2] < 0.25)) fail('Hands forward — confused with legs');
if (!(J.LeftHand[0] > J.RightHand[0])) fail('Left/Right hands swapped');
if (!(J.LeftFoot[0] > J.RightFoot[0])) fail('Left/Right feet swapped');
if (!(J.Hips[1] > 0.35 && J.Hips[1] < 0.9)) fail(`Hips at odd height ${J.Hips[1].toFixed(2)}`);
console.log('ALL OK');
