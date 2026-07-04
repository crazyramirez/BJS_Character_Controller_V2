/**
 * Auto-rig input validation tests: client-controlled options must be rejected
 * loudly instead of flowing into the skeleton math and producing a silently
 * corrupt GLB (NaN inverse bind matrices, HTTP 200, crash at load time).
 *
 * Run with: node --test test/autorig_validation.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { autoRigGLB } from '../js/core/autorig_api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');
const load = (file) => readFileSync(join(assetsDir, file));

describe('auto-rig option validation', () => {
  it('rejects NaN joint coordinates', async () => {
    await assert.rejects(
      () => autoRigGLB(load('character_animated_1.glb'), {
        forceRebuild: true,
        joints: { Hips: [NaN, 1, 0] },
      }),
      /finite numbers/,
    );
  });

  it('rejects non-numeric joint coordinates', async () => {
    await assert.rejects(
      () => autoRigGLB(load('character_animated_1.glb'), {
        forceRebuild: true,
        joints: { Head: ['a', 'b', 'c'] },
      }),
      /finite numbers/,
    );
  });

  it('rejects a non-object joints payload', async () => {
    await assert.rejects(
      () => autoRigGLB(load('character_animated_1.glb'), {
        forceRebuild: true,
        joints: [[0, 1, 2]],
      }),
      /must be an object/,
    );
  });

  it('ignores unknown joint names and clamps fingerCount, still producing a valid rig', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), {
      forceRebuild: true,
      fingerCount: '99', // → clamped to 5
      joints: { NotARealJoint: [0, 0, 0] },
    });
    const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await dracoLib.createDecoderModule(),
        'draco3d.encoder': await dracoLib.createEncoderModule(),
      });
    const doc = await io.readBinary(new Uint8Array(buffer));
    const skin = doc.getRoot().listSkins()[0];
    assert.ok(skin, 'skin exists');
    assert.ok(!skin.listJoints().some(j => j.getName() === 'NotARealJoint'), 'unknown joint name ignored');
    // Every IBM value must be finite (NaN here is the failure mode this suite guards).
    const ibm = skin.getInverseBindMatrices().getArray();
    for (let i = 0; i < ibm.length; i++) {
      assert.ok(Number.isFinite(ibm[i]), `IBM[${i}] finite`);
    }
  });

  it('weights stay normalized across every primitive of the unified graph', async () => {
    const buffer = await autoRigGLB(load('character_animated_1.glb'), { forceRebuild: true });
    const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await dracoLib.createDecoderModule(),
        'draco3d.encoder': await dracoLib.createEncoderModule(),
      });
    const doc = await io.readBinary(new Uint8Array(buffer));
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const w = prim.getAttribute('WEIGHTS_0')?.getArray();
        if (!w) continue;
        for (let v = 0; v < w.length; v += 4) {
          const sum = w[v] + w[v + 1] + w[v + 2] + w[v + 3];
          assert.ok(Math.abs(sum - 1) < 1e-3, `vertex ${v / 4} weight sum ${sum}`);
        }
      }
    }
  });
});
