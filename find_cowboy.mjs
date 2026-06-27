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
        const root = doc.getRoot();
        const nodes = root.listNodes();
        const matches = nodes.filter(n => {
          const name = n.getName().toLowerCase();
          return name.includes('hat') || name.includes('cowboy') || name.includes('jacket') || name.includes('coat') || name.includes('skirt') || name.includes('cloth');
        });
        if (matches.length > 0) {
          console.log(`File: ${path} has matching nodes:`, matches.map(m => m.getName()));
        }
      } catch (e) {
        // ignore
      }
    }
  }
}

main().catch(console.error);
