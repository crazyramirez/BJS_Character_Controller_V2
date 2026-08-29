import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

let ioPromise;

export async function createIO() {
  if (!ioPromise) {
    ioPromise = (async () => {
      const lib = draco3d.createDecoderModule ? draco3d : draco3d.default;
      return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        'draco3d.decoder': await lib.createDecoderModule(),
        'draco3d.encoder': await lib.createEncoderModule(),
      });
    })();
  }
  return ioPromise;
}

export function parentMap(document) {
  const result = new Map();
  for (const node of document.getRoot().listNodes()) {
    for (const child of node.listChildren()) result.set(child, node);
  }
  return result;
}

export function approx(actual, expected, epsilon = 1e-5, message = '') {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message} expected ${expected}, received ${actual}`.trim());
  }
}
