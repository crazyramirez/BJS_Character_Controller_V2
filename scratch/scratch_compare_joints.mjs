import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const ibmAcc = skin.getInverseBindMatrices();
  const ibmArr = ibmAcc ? ibmAcc.getArray() : null;

  console.log(`=== original skin joints count: ${joints.length} ===`);
  for (let i = 0; i < Math.min(5, joints.length); i++) {
    const j = joints[i];
    const t = j.getTranslation() || [0, 0, 0];
    const r = j.getRotation() || [0, 0, 0, 1];
    const s = j.getScale() || [1, 1, 1];
    console.log(`Joint [${i}]: "${j.getName()}"`);
    console.log(`  Local T: ${t.map(v => v.toFixed(6))}`);
    console.log(`  Local R: ${r.map(v => v.toFixed(6))}`);
    console.log(`  Local S: ${s.map(v => v.toFixed(6))}`);
    if (ibmArr) {
      const idx = i * 16;
      const mat = ibmArr.slice(idx, idx + 16);
      console.log(`  IBM: [${Array.from(mat).map(v => v.toFixed(6)).join(', ')}]`);
    }
  }
}

main().catch(console.error);
