/** Measure ONLY the character mesh (CHAR_Cooper) orientation per stage. */
import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mergeGLBs } from '../js/core/merge_api.mjs';
import { guessJoints, autoRigGLB } from '../js/core/autorig_api.mjs';

const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
  'draco3d.encoder': await dracoLib.createEncoderModule(),
});
const cooper = readFileSync(new URL('../assets/cooper.glb', import.meta.url));
const anims = readFileSync(new URL('../assets/animations.glb', import.meta.url));

async function charExtents(buf, label, nameRe = /cooper/i) {
  const doc = await io.readBinary(new Uint8Array(buf));
  const parentOf = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  const mul = (a, b) => {
    const o = new Array(16);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      o[col * 4 + row] = s;
    }
    return o;
  };
  const min = [1 / 0, 1 / 0, 1 / 0], max = [-1 / 0, -1 / 0, -1 / 0];
  let found = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !nameRe.test(node.getName() || '')) continue;
    found = true;
    let world = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const stack = [];
    for (let c = node; c; c = parentOf.get(c)) stack.push(c);
    while (stack.length) world = mul(world, stack.pop().getMatrix());
    const skinned = !!node.getSkin();
    for (const p of mesh.listPrimitives()) {
      const a = p.getAttribute('POSITION')?.getArray();
      if (!a) continue;
      for (let i = 0; i < a.length; i += 3) {
        let x = a[i], y = a[i + 1], z = a[i + 2];
        if (!skinned) {
          const nx = world[0] * x + world[4] * y + world[8] * z + world[12];
          const ny = world[1] * x + world[5] * y + world[9] * z + world[13];
          const nz = world[2] * x + world[6] * y + world[10] * z + world[14];
          x = nx; y = ny; z = nz;
        }
        min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
        min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
        min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
      }
    }
  }
  if (!found) { console.log(`${label}: char mesh not found by name`); return false; }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const upright = ext[1] > ext[0] && ext[1] > ext[2];
  console.log(`${label}: ext=${ext.map(v => v.toFixed(2))} minY=${min[1].toFixed(2)} upright=${upright}`);
  return upright;
}

let fails = 0;
const expect = (ok, msg) => { if (!ok) { console.error('FAIL:', msg); fails++; } };

expect(await charExtents(cooper, 'original         '), 'original char not upright');
const merged = await mergeGLBs(cooper, anims, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
expect(await charExtents(merged, 'merged static    '), 'merged static char not upright');

const guess = await guessJoints(cooper);
console.log('guess height:', guess.height.toFixed(2), 'Hips:', guess.joints.Hips.map(v => v.toFixed(2)).join(','), 'Head:', guess.joints.Head.map(v => v.toFixed(2)).join(','));
expect(Math.abs(guess.height - 1.89) < 0.1, `bounds contaminated by ground (height ${guess.height.toFixed(2)})`);
expect(guess.joints.Hips[1] > 0.6 && guess.joints.Hips[1] < 1.2, `Hips at odd height ${guess.joints.Hips[1].toFixed(2)}`);
expect(guess.joints.Head[1] > 1.5, `Head too low ${guess.joints.Head[1].toFixed(2)}`);

const rigged = await autoRigGLB(cooper, { joints: guess.joints });
expect(await charExtents(rigged, 'autorigged       '), 'rigged char not upright');

// Ground must NOT be skinned to the skeleton
{
  const doc = await io.readBinary(new Uint8Array(rigged));
  for (const node of doc.getRoot().listNodes()) {
    if (/ground/i.test(node.getName() || '') && node.getMesh()) {
      expect(!node.getSkin(), 'ground mesh got skinned to the skeleton');
      const arr = node.getMesh().listPrimitives()[0]?.getAttribute('JOINTS_0');
      expect(!arr, 'ground mesh has skin weights');
    }
  }
}

const merged2 = await mergeGLBs(rigged, anims, { removeExistingAnimations: true, COMPRESS_OUTPUT: false });
expect(await charExtents(merged2, 'autorig + merge  '), 'final char not upright');
const { writeFileSync } = await import('fs');
writeFileSync(new URL('./out_cooper_rigged_merged.glb', import.meta.url), merged2);
console.log('wrote scratch/out_cooper_rigged_merged.glb — inspect in the builder/sandbox');
console.log(fails === 0 ? 'ALL OK' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
