/**
 * fbx_api.mjs — FBX → GLB conversion using fbx2gltf
 *
 * Converts an FBX buffer to a GLB buffer, then normalizes the result:
 *  - Optionally repairs PBR material factors when explicitly requested
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

function mat4Mul(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
        }
    }
    return out;
}

/**
 * Normalize an fbx2gltf GLB without changing authored appearance.
 * Matrix multiplication is used instead of hand-composed TRS so parent
 * translation, rotation, non-uniform scale and any resulting shear survive.
 */
export async function normalizeConvertedGLB(glbBuffer, options = {}) {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readBinary(new Uint8Array(glbBuffer));

    if (options.repairMaterials === true) {
        for (const mat of doc.getRoot().listMaterials()) {
            mat.setMetallicFactor(0);
            mat.setRoughnessFactor(0.5);
        }
    }

    // Flatten RootNode: absorb its transform into each child, then remove it
    for (const scene of doc.getRoot().listScenes()) {
        for (const rootNode of scene.listChildren()) {
            if (rootNode.getName() !== 'RootNode') continue;

            const parentMatrix = rootNode.getMatrix();

            for (const child of [...rootNode.listChildren()]) {
                child.setMatrix(mat4Mul(parentMatrix, child.getMatrix()));
                scene.addChild(child);
            }

            rootNode.dispose();
        }
    }

    return Buffer.from(await io.writeBinary(doc));
}

async function fixGLB(glbPath, options) {
    return normalizeConvertedGLB(await fs.promises.readFile(glbPath), options);
}

/**
 * Convert an FBX file buffer to a normalized GLB buffer.
 * @param {Buffer} fbxBuffer  Raw FBX file contents
 * @param {string} [name]     Original filename (for logging only)
 * @returns {Promise<Buffer>} GLB binary
 */
export async function convertFBXToGLB(fbxBuffer, name = 'model.fbx', options = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbx2gltf-'));
    const id = crypto.randomBytes(6).toString('hex');
    const fbxPath = path.join(tmpDir, `${id}.fbx`);
    const glbPath = path.join(tmpDir, `${id}.glb`);

    try {
        fs.writeFileSync(fbxPath, fbxBuffer);
        await convert(fbxPath, glbPath, []);
        return await fixGLB(glbPath, options);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
