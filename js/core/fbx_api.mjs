/**
 * fbx_api.mjs — FBX → GLB conversion using fbx2gltf
 *
 * Converts an FBX buffer to a GLB buffer, then normalizes the result:
 *  - Resets PBR material factors (FBX exports often come out fully metallic/black)
 *  - Flattens the fbx2gltf "RootNode" wrapper (cm→m scale + axis rotation)
 *    by baking its transform into each child, matching convert.js behavior.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const require = createRequire(import.meta.url);
const convert = require('fbx2gltf');

function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
    return [
        x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2,
        y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
        z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    ];
}

async function fixGLB(glbPath) {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.read(glbPath);

    for (const mat of doc.getRoot().listMaterials()) {
        mat.setMetallicFactor(0);
        mat.setRoughnessFactor(0.5);
    }

    // Flatten RootNode: absorb its transform into each child, then remove it
    for (const scene of doc.getRoot().listScenes()) {
        for (const rootNode of scene.listChildren()) {
            if (rootNode.getName() !== 'RootNode') continue;

            const pScale = rootNode.getScale();     // e.g. [100,100,100]
            const pRot = rootNode.getRotation();    // e.g. [-0.707,0,0,0.707]

            for (const child of rootNode.listChildren()) {
                const cScale = child.getScale();
                const cRot = child.getRotation();
                const cTrans = child.getTranslation();

                child.setScale([cScale[0] * pScale[0], cScale[1] * pScale[1], cScale[2] * pScale[2]]);
                child.setRotation(qMul(pRot, cRot));
                child.setTranslation([cTrans[0] * pScale[0], cTrans[1] * pScale[1], cTrans[2] * pScale[2]]);

                scene.addChild(child);
            }

            rootNode.dispose();
        }
    }

    return Buffer.from(await io.writeBinary(doc));
}

/**
 * Convert an FBX file buffer to a normalized GLB buffer.
 * @param {Buffer} fbxBuffer  Raw FBX file contents
 * @param {string} [name]     Original filename (for logging only)
 * @returns {Promise<Buffer>} GLB binary
 */
export async function convertFBXToGLB(fbxBuffer, name = 'model.fbx') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbx2gltf-'));
    const id = crypto.randomBytes(6).toString('hex');
    const fbxPath = path.join(tmpDir, `${id}.fbx`);
    const glbPath = path.join(tmpDir, `${id}.glb`);

    try {
        fs.writeFileSync(fbxPath, fbxBuffer);
        await convert(fbxPath, glbPath, []);
        return await fixGLB(glbPath);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
