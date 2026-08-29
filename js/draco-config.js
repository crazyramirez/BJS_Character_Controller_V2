'use strict';

// Keep Draco decoding offline, deterministic and compatible with the strict
// local Content Security Policy. Babylon defaults to its public CDN otherwise.
(function configureLocalDraco() {
  if (typeof BABYLON === 'undefined') return;
  const config = {
    wasmUrl: 'vendor/draco_wasm_wrapper_gltf.js',
    wasmBinaryUrl: 'vendor/draco_decoder_gltf.wasm',
    fallbackUrl: 'vendor/draco_wasm_wrapper_gltf.js',
  };
  if (BABYLON.DracoDecoder) BABYLON.DracoDecoder.DefaultConfiguration = { ...config };
  if (BABYLON.DracoCompression) BABYLON.DracoCompression.Configuration = { decoder: { ...config } };
})();
