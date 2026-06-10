/**
 * Skeleton robustness harness.
 * 1. analyzeGLB on every test character — detection + bone coverage.
 * 2. mergeGLBs with character_animated.glb — validate output:
 *    - no NaN/inf in animation outputs
 *    - key humanoid bones matched & retargeted
 *    - bone lengths preserved when sampling animation frame 0
 *    - hips above feet, head above hips (upright sanity)
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { analyzeGLB, mergeGLBs } from '../js/core/merge_api.mjs';

const ROOT = 'd:/DEV/BJS Character Controller V2';
const ANIM = join(ROOT, 'assets/character_animated.glb');
const TEST_DIR = join(ROOT, 'assets/characters_test');

const KEY_BONES = ['pelvis', 'spine_01', 'head', 'upperarm_l', 'lowerarm_l', 'hand_l',
  'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l',
  'thigh_r', 'calf_r', 'foot_r'];

let io;
async function getIO() {
  if (io) return io;
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });
  return io;
}

function buildParentMap(doc) {
  const map = new Map();
  for (const node of doc.getRoot().listNodes())
    for (const child of node.listChildren()) map.set(child, node);
  return map;
}

function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
  return [
    x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2,
    y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
    z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}
function rotateVec3([x, y, z], [qx, qy, qz, qw]) {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/** Sample animation at time t: returns map node -> {rot, trans} override */
function sampleAnim(anim, t) {
  const overrides = new Map();
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode();
    if (!node) continue;
    const path = ch.getTargetPath();
    const sampler = ch.getSampler();
    const input = sampler?.getInput()?.getArray();
    const output = sampler?.getOutput()?.getArray();
    if (!input || !output) continue;
    // find keyframe index nearest t
    let i = 0;
    while (i < input.length - 1 && input[i + 1] <= t) i++;
    const comp = path === 'rotation' ? 4 : 3;
    const val = Array.from(output.slice(i * comp, i * comp + comp));
    if (!overrides.has(node)) overrides.set(node, {});
    overrides.get(node)[path] = val;
  }
  return overrides;
}

/** Compute world positions of all nodes given sampled overrides */
function worldPositions(doc, overrides) {
  const parentMap = buildParentMap(doc);
  const wpos = new Map(), wrot = new Map(), wscale = new Map();
  function get(node) {
    if (wpos.has(node)) return;
    const ov = overrides.get(node) || {};
    const lr = ov.rotation || node.getRotation() || [0, 0, 0, 1];
    const lt = ov.translation || node.getTranslation() || [0, 0, 0];
    const ls = node.getScale() || [1, 1, 1];
    const parent = parentMap.get(node);
    if (parent) {
      get(parent);
      const pr = wrot.get(parent), pp = wpos.get(parent), ps = wscale.get(parent);
      const scaled = [lt[0] * ps[0], lt[1] * ps[1], lt[2] * ps[2]];
      const rotated = rotateVec3(scaled, pr);
      wpos.set(node, [pp[0] + rotated[0], pp[1] + rotated[1], pp[2] + rotated[2]]);
      wrot.set(node, qMul(pr, lr));
      wscale.set(node, [ps[0] * ls[0], ps[1] * ls[1], ps[2] * ls[2]]);
    } else {
      wpos.set(node, lt); wrot.set(node, lr); wscale.set(node, ls);
    }
  }
  for (const node of doc.getRoot().listNodes()) get(node);
  return wpos;
}

function findBone(doc, patterns) {
  for (const node of doc.getRoot().listNodes()) {
    const n = (node.getName() || '').toLowerCase().replace(/[:_\-\.\s]/g, '');
    for (const p of patterns) if (n.endsWith(p) || n === p) return node;
  }
  return null;
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function validateMerged(buf, label) {
  const issues = [];
  const _io = await getIO();
  const doc = await _io.readBinary(new Uint8Array(buf));

  // 1. NaN check on all animation outputs
  let nanCount = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const arr = ch.getSampler()?.getOutput()?.getArray();
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) { nanCount++; break; }
      }
    }
  }
  if (nanCount > 0) issues.push(`NaN/inf in ${nanCount} channels`);

  const anims = doc.getRoot().listAnimations();
  if (anims.length === 0) { issues.push('NO animations in output'); return { issues }; }

  // 2. Pick a walk/idle anim
  const testAnim = anims.find(a => /idle|walk/i.test(a.getName() || '')) || anims[0];

  // 3. Bone-length preservation: rest vs animated frame 0
  const hips = findBone(doc, ['hips', 'pelvis']);
  const head = findBone(doc, ['head']);
  const footL = findBone(doc, ['leftfoot', 'footl', 'lfoot', 'leftankle']);
  const handL = findBone(doc, ['lefthand', 'handl', 'lhand']);

  const restPos = worldPositions(doc, new Map());
  const animPos = worldPositions(doc, sampleAnim(testAnim, 0));

  if (hips && head) {
    const restLen = dist(restPos.get(hips), restPos.get(head));
    const animLen = dist(animPos.get(hips), animPos.get(head));
    const ratio = animLen / restLen;
    if (ratio < 0.7 || ratio > 1.3) issues.push(`hips→head distance ratio ${ratio.toFixed(2)} (rest ${restLen.toFixed(3)}, anim ${animLen.toFixed(3)}) — pose distorted`);
    // upright check
    const h = animPos.get(head), p = animPos.get(hips);
    if (h[1] <= p[1]) issues.push(`head NOT above hips in '${testAnim.getName()}' frame 0 (head.y=${h[1].toFixed(2)}, hips.y=${p[1].toFixed(2)}) — wrong orientation`);
  } else {
    issues.push(`missing key bones: hips=${!!hips} head=${!!head}`);
  }
  if (hips && footL) {
    const p = animPos.get(hips), f = animPos.get(footL);
    if (f[1] >= p[1]) issues.push(`left foot NOT below hips (foot.y=${f[1].toFixed(2)}, hips.y=${p[1].toFixed(2)})`);
  }

  // 4. Channel retarget coverage on test anim
  const rotTargets = new Set();
  const transTargets = new Set();
  for (const ch of testAnim.listChannels()) {
    const n = ch.getTargetNode()?.getName();
    if (!n) continue;
    if (ch.getTargetPath() === 'rotation') rotTargets.add(n.toLowerCase());
    if (ch.getTargetPath() === 'translation') transTargets.add(n.toLowerCase());
  }

  // 5. KEY bone coverage: each key bone must exist AND be rotation-animated
  const COVERAGE = {
    hips: ['hips', 'pelvis'],
    head: ['head'],
    upperarm_l: ['leftarm', 'leftupperarm', 'upperarml', 'lupperarm'],
    upperarm_r: ['rightarm', 'rightupperarm', 'upperarmr', 'rupperarm'],
    lowerarm_l: ['leftforearm', 'leftlowerarm', 'lowerarml', 'forearml', 'lforearm', 'llowerarm'],
    lowerarm_r: ['rightforearm', 'rightlowerarm', 'lowerarmr', 'forearmr', 'rforearm', 'rlowerarm'],
    thigh_l: ['leftupleg', 'leftupperleg', 'thighl', 'lthigh', 'lupperleg'],
    thigh_r: ['rightupleg', 'rightupperleg', 'thighr', 'rthigh', 'rupperleg'],
    calf_l: ['leftleg', 'leftlowerleg', 'calfl', 'lcalf', 'shinl', 'llowerleg'],
    calf_r: ['rightleg', 'rightlowerleg', 'calfr', 'rcalf', 'shinr', 'rlowerleg'],
    foot_l: ['leftfoot', 'footl', 'lfoot'],
    foot_r: ['rightfoot', 'footr', 'rfoot'],
  };
  const missingCoverage = [];
  for (const [key, patterns] of Object.entries(COVERAGE)) {
    const node = findBone(doc, patterns);
    if (!node) { missingCoverage.push(`${key} (bone not found)`); continue; }
    if (!rotTargets.has(node.getName().toLowerCase())) missingCoverage.push(`${key} (no rotation channel)`);
  }
  if (missingCoverage.length) issues.push(`key bones NOT animated: ${missingCoverage.join(', ')}`);

  // Diagnostic: char skin joints with no rotation channel
  const unanimated = [];
  for (const skin of doc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) {
      const n = joint.getName();
      if (n && !rotTargets.has(n.toLowerCase())) unanimated.push(n);
    }
  }
  if (unanimated.length) console.log(`  [diag] joints w/o rotation channel: ${unanimated.join(', ')}`);
  // hips must have root-motion translation
  if (hips && !transTargets.has(hips.getName().toLowerCase())) issues.push('hips has NO translation channel (root motion lost)');

  return { issues, animCount: anims.length, testAnim: testAnim.getName(), channelCount: rotTargets.size, restPos, animPos, hips, head, footL, handL };
}

const dir = process.argv[2] === 'syn' ? join(ROOT, 'scratch/synthetic') : TEST_DIR;
const files = readdirSync(dir).filter(f => f.endsWith('.glb'));
const animBuf = readFileSync(ANIM);
let failCount = 0;

for (const f of files) {
  const buf = readFileSync(join(dir, f));
  console.log(`\n========== ${f} ==========`);
  try {
    const analysis = await analyzeGLB(buf);
    console.log(`type=${analysis.skeletonType.label}  pose=${analysis.poseStyle}  bones=${analysis.boneCount}  skin=${analysis.hasSkin}`);
    console.log(`roots=${JSON.stringify(analysis.rootBones)}`);
    console.log(`sample bones: ${analysis.bones.slice(0, 12).map(b => b.cleanName).join(', ')}`);
  } catch (e) {
    console.log(`ANALYZE FAILED: ${e.message}`);
    continue;
  }
  try {
    const merged = await mergeGLBs(buf, animBuf, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
    const v = await validateMerged(merged, f);
    console.log(`merged OK: ${merged.length} bytes, ${v.animCount} anims, testAnim='${v.testAnim}' targets=${v.channelCount}`);
    if (v.issues.length) { failCount++; console.log(`ISSUES:\n  - ${v.issues.join('\n  - ')}`); }
    else console.log('VALIDATION PASS');
  } catch (e) {
    failCount++;
    console.log(`MERGE FAILED: ${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}`);
  }
}
console.log(`\n=== TOTAL: ${files.length} files, ${failCount} failed ===`);
