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

  const joints0 = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('JOINTS_0');
  
  console.log('Accessor methods:');
  const proto = Object.getPrototypeOf(joints0);
  const methods = Object.getOwnPropertyNames(proto).filter(name => typeof proto[name] === 'function');
  console.log(methods);
}

main().catch(console.error);
