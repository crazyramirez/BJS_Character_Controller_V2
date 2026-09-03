// Run with Electron so ASAR resolution and worker behavior match the desktop app.
// npm run test:packaged-fbx -- dist/win-unpacked/resources/app.asar path/to/model.fbx
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

function materialSummary(data) {
  const bytes = Buffer.from(data);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  return (json.materials || []).map(material => {
    const pbr = material.pbrMetallicRoughness || {};
    const result = {
      name: material.name, metallic: pbr.metallicFactor ?? 1, roughness: pbr.roughnessFactor ?? 1,
      specular: material.extensions?.KHR_materials_specular?.specularFactor ?? 1,
      roughnessSource: material.extras?.fromFBX?.roughnessSource,
      baseColorTexture: !!pbr.baseColorTexture, normalTexture: !!material.normalTexture,
      metallicRoughnessTexture: !!pbr.metallicRoughnessTexture,
    };
    if (result.roughnessSource === 'disabled-specular') {
      assert.equal(result.metallic, 0, 'disabled legacy specular must not become metal');
      assert.equal(result.roughness, 1, 'unused legacy shininess must not create a polished surface');
      assert.equal(result.specular, 0, 'disabled specular must survive GLB export');
    }
    return result;
  }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const [archiveArg, fbxArg] = process.argv.slice(2);
  if (!archiveArg || !fbxArg) throw new Error('Usage: electron scripts/check-packaged-fbx.cjs <app.asar> <model.fbx>');
  const archive = path.resolve(archiveArg);
  const fbx = path.resolve(fbxArg);
  const { runProcessingJob } = await import(pathToFileURL(path.join(archive, 'js/core/processing_jobs.mjs')).href);
  const { resolveFBXConverterPath } = await import(pathToFileURL(path.join(archive, 'js/core/fbx_api.mjs')).href);
  const executable = resolveFBXConverterPath();
  assert.ok(executable.includes('app.asar.unpacked'), 'native converter must live outside the archive');
  await fs.access(executable);

  const converted = await runProcessingJob('convertFBX', {
    file: await fs.readFile(fbx), name: path.basename(fbx), options: {},
  });
  const materials = materialSummary(converted.data);
  const before = (await runProcessingJob('analyze', { file: converted.data })).data;
  assert.ok(before.hasSkin, 'test model must contain a skeleton');
  assert.ok(before.health.metrics.vertexCount > 0, 'converted model must contain geometry');
  const merged = await runProcessingJob('merge', {
    character: converted.data,
    animations: await fs.readFile(path.join(archive, 'assets/animations.glb')),
    options: { COMPRESS_OUTPUT: false, removeExistingAnimations: true },
  });
  const after = (await runProcessingJob('analyze', { file: merged.data })).data;
  assert.deepEqual(materialSummary(merged.data), materials, 'animation merge must preserve material factors and maps');
  assert.ok(after.health.metrics.animationCount > 0, 'packaged animations must be assigned');
  assert.equal(after.health.metrics.vertexCount, before.health.metrics.vertexCount);
  const heightRatio = after.health.metrics.height / before.health.metrics.height;
  assert.ok(heightRatio > 0.995 && heightRatio < 1.005, 'animation merge must preserve upright rendered height');
  console.log(JSON.stringify({
    archive, executable, model: path.basename(fbx),
    convertedBytes: converted.data.byteLength,
    bones: after.boneCount, animations: after.health.metrics.animationCount,
    heightBefore: before.health.metrics.height, heightAfter: after.health.metrics.height,
    materials,
    status: 'passed',
  }, null, 2));
  app.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  app.exit(1);
});
