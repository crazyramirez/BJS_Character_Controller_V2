import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const dirs = ['.', './assets'];
  for (const dir of dirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.glb'));
    for (const file of files) {
      const path = join(dir, file);
      try {
        const buffer = readFileSync(path);
        const doc = await io.readBinary(new Uint8Array(buffer));
        const skins = doc.getRoot().listSkins();
        if (skins.length > 0) {
          console.log(`\n=== File: ${path} has ${skins.length} skin(s) ===`);
          for (const [idx, skin] of skins.entries()) {
            const joints = skin.listJoints();
            console.log(`  Skin ${idx} ("${skin.getName()}"): ${joints.length} joints`);
            console.log(`    First 10 joints:`, joints.slice(0, 10).map(j => j.getName()));
          }
        } else {
          console.log(`\n=== File: ${path} has NO skin ===`);
        }
      } catch (e) {
        console.error(`Error on ${path}:`, e.message);
      }
    }
  }
}

main().catch(console.error);
