// npm package build (scripts/build-lib.mjs): the generated ES module imports in
// Node without a DOM or a global BABYLON and exposes the public API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLib, ESM_EXPORTS } from '../scripts/build-lib.mjs';

test('build:lib writes an importable ES module, the UMD copy, types and package.json', async t => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bjs-cc-lib-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  await buildLib({ outDir });

  const pkg = JSON.parse(await fs.readFile(path.join(outDir, 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'bjs-character-controller');
  assert.equal(pkg.version, rootPkg.version);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.exports['.'], { types: './character-controller.d.ts', import: './character-controller.mjs' });
  assert.equal(pkg.exports['./umd'], './character-controller.js');
  assert.equal(pkg.peerDependencies.babylonjs, '>=9');

  const umd = await fs.readFile(path.join(outDir, 'character-controller.js'), 'utf8');
  assert.equal(umd, await fs.readFile(new URL('../js/character-controller.js', import.meta.url), 'utf8'));
  const types = await fs.readFile(path.join(outDir, 'character-controller.d.ts'), 'utf8');
  for (const name of ['createCharacter', 'setupCharacter', 'applyCharacterPreset', 'CharacterPreset', 'useBabylon', 'onStateChangedObservable', 'setMoveInput']) {
    assert.ok(types.includes(name), `types declare ${name}`);
  }
  assert.match(await fs.readFile(path.join(outDir, 'README.md'), 'utf8'), /useBabylon\(BABYLON\)/);

  assert.equal(globalThis.BABYLON, undefined);
  const mod = await import(pathToFileURL(path.join(outDir, 'character-controller.mjs')).href);
  assert.equal(typeof globalThis.window, 'undefined', 'importing in Node touches no window');
  for (const name of [...ESM_EXPORTS, 'useBabylon', 'getBabylon', 'loadCharacter', 'retargetAnimationGroups']) {
    assert.ok(name in mod, `exports ${name}`);
  }
  assert.equal(mod.loadCharacter, mod.setupCharacter);
  assert.equal(mod.BAKED_PRESET, null);
  assert.equal(mod.STANDARD_ANIM_SLOTS.length, 16);
  assert.equal(mod.DEFAULT_CHAR_CONFIG.PHYSICS.GRAV, 22);
  assert.equal(mod.normalizeCharacterPreset({ schema: 'bjs-character-preset/v1' }).schema, 'bjs-character-preset/v1');

  // A minimal fake namespace is enough for the non-rendering parts.
  class Vector3 { constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); } }
  const enabled = [];
  class HavokPlugin { constructor(_useDelta, instance) { this.instance = instance; } }
  const fake = { Vector3, HavokPlugin };
  assert.equal(mod.useBabylon(fake), fake);
  assert.equal(mod.getBabylon(), fake);
  const scene = { enablePhysics: (gravity, plugin) => enabled.push({ gravity, plugin }), onBeforeRenderObservable: { add: () => ({}), remove() {} } };
  assert.equal(await mod.initPhysics(scene), false, 'no Havok available → kinematic');
  assert.equal(await mod.initPhysics(scene, { havok: async () => ({ id: 'hk' }) }), true);
  assert.equal(enabled[0].gravity.y, -22);
  assert.equal(enabled[0].plugin.instance.id, 'hk');
  mod.useBabylon(fake, { havok: { id: 'instance' } });
  assert.equal(await mod.initPhysics(scene), true);
  assert.equal(enabled[1].plugin.instance.id, 'instance');

  const anim = new mod.AnimCtrl([], scene);
  assert.ok(anim.onAnimationChangedObservable, 'observables fall back without BABYLON.Observable');
  anim.dispose();
});
