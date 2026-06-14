/**
 * Compare Crouch_Idle_Loop frame-0 pose metrics between:
 *  A) reference Mixamo char (character_animated.glb) + animations.glb
 *  B) synthetic CC/AccuRig A-pose rig + animations.glb
 * Torso lean and hip drop should match closely if retargeting is correct.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFileSync } from 'fs';
import { mergeGLBs } from '../js/core/merge_api.mjs';

const draco3d = (await import('draco3dgltf')).default ?? (await import('draco3dgltf'));
const dracoLib = draco3d.createDecoderModule ? draco3d : draco3d.default;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
});

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const rotV = (v, q) => {
  const u = [q[0], q[1], q[2]], w = q[3];
  const uv = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const uuv = [u[1] * uv[2] - u[2] * uv[1], u[2] * uv[0] - u[0] * uv[2], u[0] * uv[1] - u[1] * uv[0]];
  return [v[0] + 2 * (w * uv[0] + uuv[0]), v[1] + 2 * (w * uv[1] + uuv[1]), v[2] + 2 * (w * uv[2] + uuv[2])];
};

function metricsOf(mdoc, names /* {hip, head, foot} substr matchers */) {
  const anims = mdoc.getRoot().listAnimations();
  const clip = anims.find(a => /crouch_idle_loop/i.test(a.getName() || ''));
  if (!clip) throw new Error('no crouch clip');
  const rotAt0 = new Map(), trsAt0 = new Map();
  for (const ch of clip.listChannels()) {
    const node = ch.getTargetNode();
    const out = ch.getSampler()?.getOutput()?.getArray();
    if (!node || !out) continue;
    if (ch.getTargetPath() === 'rotation') rotAt0.set(node, [out[0], out[1], out[2], out[3]]);
    if (ch.getTargetPath() === 'translation') trsAt0.set(node, [out[0], out[1], out[2]]);
  }
  const parentOf = new Map();
  for (const n of mdoc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  const memo = new Map();
  function worldAt0(node) {
    if (memo.has(node)) return memo.get(node);
    const lr = rotAt0.get(node) || node.getRotation() || [0, 0, 0, 1];
    const lp = trsAt0.get(node) || node.getTranslation() || [0, 0, 0];
    const parent = parentOf.get(node);
    const res = !parent
      ? { p: lp, q: lr }
      : (() => { const pw = worldAt0(parent); return { p: rotV(lp, pw.q).map((v, i) => v + pw.p[i]), q: qMul(pw.q, lr) }; })();
    memo.set(node, res);
    return res;
  }
  const find = (sub) => mdoc.getRoot().listNodes().find(n => (n.getName() || '').toLowerCase().includes(sub));
  const hip = worldAt0(find(names.hip)).p;
  const head = worldAt0(find(names.head)).p;
  const lfoot = worldAt0(find(names.foot)).p;
  // bind hip height for drop ratio
  const memo2 = new Map();
  function bindWorld(node) {
    if (memo2.has(node)) return memo2.get(node);
    const parent = parentOf.get(node);
    const lr = node.getRotation() || [0, 0, 0, 1];
    const lp = node.getTranslation() || [0, 0, 0];
    const res = !parent ? { p: lp, q: lr }
      : (() => { const pw = bindWorld(parent); return { p: rotV(lp, pw.q).map((v, i) => v + pw.p[i]), q: qMul(pw.q, lr) }; })();
    memo2.set(node, res);
    return res;
  }
  const hipBind = bindWorld(find(names.hip)).p;
  const torso = [head[0] - hip[0], head[1] - hip[1], head[2] - hip[2]];
  const tlen = Math.hypot(...torso);
  return {
    clip: clip.getName(),
    upY: torso[1] / tlen,
    lean: Math.abs(torso[2]) / tlen,
    hipY: hip[1],
    hipBindY: hipBind[1],
    hipDrop: hipBind[1] - hip[1],
    footY: lfoot[1],
  };
}

const animBuf = readFileSync(new URL('../assets/animations.glb', import.meta.url));

// A) Reference Mixamo char
const refBuf = readFileSync(new URL('../assets/character_animated.glb', import.meta.url));
const refMerged = await mergeGLBs(refBuf, animBuf, { removeExistingAnimations: true });
const refM = metricsOf(await io.readBinary(new Uint8Array(refMerged)), { hip: 'hips', head: 'head', foot: 'leftfoot' });

// B) Synthetic CC A-pose rig
const { buildSyntheticCC } = await import('./lib_synthetic_cc.mjs');
const ccGlb = await buildSyntheticCC({ apose: true });
const ccMerged = await mergeGLBs(ccGlb, animBuf, { removeExistingAnimations: true });
const ccM = metricsOf(await io.readBinary(new Uint8Array(ccMerged)), { hip: 'cc_base_hip', head: 'cc_base_head', foot: 'cc_base_l_foot' });

console.log('REF  :', JSON.stringify(refM));
console.log('CC   :', JSON.stringify(ccM));
const close = (a, b, tol) => Math.abs(a - b) <= tol;
let fail = 0;
const check = (label, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${extra})`); if (!ok) fail++; };
check('torso upY matches ref', close(refM.upY, ccM.upY, 0.12), `ref=${refM.upY.toFixed(2)} cc=${ccM.upY.toFixed(2)}`);
check('lean matches ref', close(refM.lean, ccM.lean, 0.15), `ref=${refM.lean.toFixed(2)} cc=${ccM.lean.toFixed(2)}`);
check('hip drop ratio matches ref', close(refM.hipDrop / refM.hipBindY, ccM.hipDrop / ccM.hipBindY, 0.15),
  `ref=${(refM.hipDrop / refM.hipBindY).toFixed(2)} cc=${(ccM.hipDrop / ccM.hipBindY).toFixed(2)}`);

// Finger mapping: CC short names (L_Mid1, L_Index1) must receive Mixamo
// LeftHandMiddle1 / LeftHandIndex1 channels.
const ccDoc = await io.readBinary(new Uint8Array(ccMerged));
const ccClip = ccDoc.getRoot().listAnimations().find(a => /crouch_idle_loop/i.test(a.getName() || ''));
const ccTargets = new Set(ccClip.listChannels().map(ch => ch.getTargetNode()?.getName()).filter(Boolean));
check('CC_Base_L_Mid1 driven (middle finger)', ccTargets.has('CC_Base_L_Mid1'), [...ccTargets].filter(n => /mid|index/i.test(n)).join(','));
check('CC_Base_R_Mid1 driven', ccTargets.has('CC_Base_R_Mid1'), '');
check('CC_Base_L_Index1 driven', ccTargets.has('CC_Base_L_Index1'), '');

// ── Fingertip curl: CC index chain (per-phalanx joint orients) must curl the
// same amount as the reference Mixamo index finger — chain-error shows here.
const qInvQ = (q) => [-q[0], -q[1], -q[2], q[3]];
function curlOf(mdoc, handName, p1Name, tipName) {
  const anims2 = mdoc.getRoot().listAnimations();
  const clip2 = anims2.find(a => /crouch_idle_loop/i.test(a.getName() || ''));
  const rotAt0 = new Map(), trsAt0 = new Map();
  for (const ch of clip2.listChannels()) {
    const node = ch.getTargetNode();
    const out = ch.getSampler()?.getOutput()?.getArray();
    if (!node || !out) continue;
    if (ch.getTargetPath() === 'rotation') rotAt0.set(node, [out[0], out[1], out[2], out[3]]);
    if (ch.getTargetPath() === 'translation') trsAt0.set(node, [out[0], out[1], out[2]]);
  }
  const parentOf = new Map();
  for (const n of mdoc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  function world(node, animated) {
    const lr = (animated && rotAt0.get(node)) || node.getRotation() || [0, 0, 0, 1];
    const lp = (animated && trsAt0.get(node)) || node.getTranslation() || [0, 0, 0];
    const parent = parentOf.get(node);
    if (!parent) return { p: lp, q: lr };
    const pw = world(parent, animated);
    return { p: rotV(lp, pw.q).map((v, i) => v + pw.p[i]), q: qMul(pw.q, lr) };
  }
  const find = (sub) => mdoc.getRoot().listNodes().find(n => (n.getName() || '').toLowerCase() === sub.toLowerCase())
    || mdoc.getRoot().listNodes().find(n => (n.getName() || '').toLowerCase().includes(sub.toLowerCase()));
  const dirInHand = (animated) => {
    const hand = world(find(handName), animated);
    const a = world(find(p1Name), animated).p;
    const b = world(find(tipName), animated).p;
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...v) || 1;
    return rotV(v.map(x => x / l), qInvQ(hand.q));
  };
  const vb = dirInHand(false), vf = dirInHand(true);
  const dot = Math.max(-1, Math.min(1, vb[0] * vf[0] + vb[1] * vf[1] + vb[2] * vf[2]));
  return (Math.acos(dot) * 180) / Math.PI; // curl change from bind, degrees
}
const refDoc = await io.readBinary(new Uint8Array(refMerged));
const curlRef = curlOf(refDoc, 'lefthand', 'lefthandindex1', 'lefthandindex3');
const curlCC = curlOf(ccDoc, 'cc_base_l_hand', 'cc_base_l_index1', 'cc_base_l_index3');
check('index curl matches ref (±12°)', Math.abs(curlRef - curlCC) <= 12,
  `ref=${curlRef.toFixed(1)}° cc=${curlCC.toFixed(1)}°`);
check('Index2/3 driven', ccTargets.has('CC_Base_L_Index2') && ccTargets.has('CC_Base_L_Index3'), '');
process.exit(fail ? 1 : 0);
