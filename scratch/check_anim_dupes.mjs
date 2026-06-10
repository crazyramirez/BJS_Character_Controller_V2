/** animations.glb: duplicate bone-node names? differing rest rotations per instance? */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync } from 'fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const doc = await io.readBinary(new Uint8Array(readFileSync(new URL('../assets/animations.glb', import.meta.url))));
const root = doc.getRoot();

const byName = new Map();
for (const n of root.listNodes()) {
  const nm = n.getName() || '(unnamed)';
  if (!byName.has(nm)) byName.set(nm, []);
  byName.get(nm).push(n);
}
const dupes = [...byName.entries()].filter(([, list]) => list.length > 1);
console.log('total nodes:', root.listNodes().length, '| unique names:', byName.size, '| duplicated names:', dupes.length);
for (const [nm, list] of dupes.slice(0, 8)) {
  const rots = list.map(n => (n.getRotation() || [0,0,0,1]).map(v => v.toFixed(3)).join(','));
  const uniq = new Set(rots);
  console.log(`  ${nm}: ×${list.length}, distinct rest rotations: ${uniq.size}${uniq.size>1 ? '  ← DIVERGENT' : ''}`);
}

// Which skeleton instance do Punch_Cross vs Crouch_Idle channels target?
for (const an of ['Punch_Cross', 'Crouch_Idle_Loop', 'Driving_Loop', 'T_Pose']) {
  const anim = root.listAnimations().find(a => a.getName() === an);
  if (!anim) { console.log(an, 'not found'); continue; }
  const targets = new Set();
  for (const ch of anim.listChannels()) {
    const n = ch.getTargetNode();
    if (!n) continue;
    const nm = n.getName();
    const idx = byName.get(nm)?.indexOf(n);
    targets.add(idx);
  }
  console.log(`${an}: targets instance index(es): [${[...targets].join(',')}]`);
}
console.log('animations count:', root.listAnimations().length);
console.log('skins:', root.listSkins().length, '| scenes nodes:', (root.getDefaultScene()||root.listScenes()[0]).listChildren().map(n=>n.getName()).join(', ').slice(0,200));
