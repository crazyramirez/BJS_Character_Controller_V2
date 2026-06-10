import { readFileSync } from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await dracoLib.createDecoderModule(),
  'draco3d.encoder': await dracoLib.createEncoderModule(),
});
const doc = await io.readBinary(new Uint8Array(readFileSync(new URL('../assets/cooper.glb', import.meta.url))));

const fmtV = (v, n = 2) => v.map(x => x.toFixed(n)).join(',');
const dump = (n, ind) => {
  const t = n.getTranslation(), r = n.getRotation(), s = n.getScale();
  const flags = (n.getMesh() ? ' [MESH]' : '') + (n.getSkin() ? ' [SKIN]' : '');
  console.log(`${ind}${n.getName() || '?'}${flags} t=${fmtV(t)} r=${fmtV(r, 3)} s=${fmtV(s)}`);
  n.listChildren().forEach(c => dump(c, ind + '  '));
};
for (const sc of doc.getRoot().listScenes()) sc.listChildren().forEach(n => dump(n, ''));

console.log('skins:', doc.getRoot().listSkins().length, '| anims:', doc.getRoot().listAnimations().length);
const min = [1 / 0, 1 / 0, 1 / 0], max = [-1 / 0, -1 / 0, -1 / 0];
for (const me of doc.getRoot().listMeshes()) for (const p of me.listPrimitives()) {
  const a = p.getAttribute('POSITION')?.getArray();
  if (!a) continue;
  for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], a[i + k]); max[k] = Math.max(max[k], a[i + k]);
  }
}
console.log('raw vertex bounds  min', fmtV(min), ' max', fmtV(max));
