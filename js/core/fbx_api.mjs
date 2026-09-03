/**
 * fbx_api.mjs — FBX → GLB conversion using fbx2gltf
 *
 * Converts an FBX buffer to a GLB buffer, then normalizes the result:
 *  - Restores material factors the legacy FBX converter loses
 *  - Optionally repairs PBR material factors when explicitly requested
 *  - Flattens the fbx2gltf "RootNode" wrapper (cm→m scale + axis rotation)
 *    by baking its transform into each child, matching convert.js behavior.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFBXMaterials, restoreFBXMaterialFactors } from './fbx_materials.mjs';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

export function resolveFBXConverterPath(packageEntry = require.resolve('fbx2gltf'), platformType = os.type()) {
    // asarUnpack puts native executables on disk, but require.resolve still
    // returns their virtual app.asar location. Processes need the physical path.
    const packageDirectory = path.dirname(packageEntry).replace(/\.asar([\\/]|$)/g, '.asar.unpacked$1');
    return path.join(packageDirectory, 'bin', platformType, `FBX2glTF${platformType === 'Windows_NT' ? '.exe' : ''}`);
}

async function convertFile(fbxPath, glbPath) {
    const executable = resolveFBXConverterPath();
    if (!fs.existsSync(executable)) {
        throw new Error(`FBX converter is missing from this installation: ${executable}`);
    }
    try {
        await execFileAsync(executable, ['--binary', '--input', fbxPath, '--output', glbPath.slice(0, -4)], {
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch (error) {
        const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`Converter output:\n${output || error.message}`, { cause: error });
    }
}

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
export async function normalizeConvertedGLB(glbBuffer, options = {}, sourceMaterials = []) {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readBinary(new Uint8Array(glbBuffer));

    restoreFBXMaterialFactors(doc, sourceMaterials);

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

async function fixGLB(glbPath, options, sourceMaterials) {
    return normalizeConvertedGLB(await fs.promises.readFile(glbPath), options, sourceMaterials);
}

/**
 * Convert an FBX file buffer to a normalized GLB buffer.
 * @param {Buffer|ArrayBuffer|ArrayBufferView} fbxBuffer  Raw FBX file contents
 * @param {string} [name]     Original filename (for logging only)
 * @returns {Promise<Buffer>} GLB binary
 */
export async function convertFBXToGLB(fbxBuffer, name = 'model.fbx', options = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbx2gltf-'));
    const id = crypto.randomBytes(6).toString('hex');
    const fbxPath = path.join(tmpDir, `${id}.fbx`);
    const glbPath = path.join(tmpDir, `${id}.glb`);

    try {
        // Workers transfer file payloads as ArrayBuffer, which fs cannot write
        // directly. Leave existing views intact to preserve their byte range.
        const bytes = fbxBuffer instanceof ArrayBuffer ? new Uint8Array(fbxBuffer) : fbxBuffer;
        fs.writeFileSync(fbxPath, bytes);
        await convertFile(fbxPath, glbPath);
        let sourceMaterials = [];
        try {
            sourceMaterials = readFBXMaterials(bytes);
        } catch (error) {
            // Metadata inspection is supplemental: an unusual exporter must
            // not prevent importing geometry the native SDK can already read.
            console.warn(`[FBX] Could not inspect material factors: ${error.message}`);
        }
        return await fixGLB(glbPath, options, sourceMaterials);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
