import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { normalizeConvertedGLB } from '../js/core/fbx_api.mjs';
import { readFBXMaterials } from '../js/core/fbx_materials.mjs';
import { approx, createIO } from './helpers.mjs';

const node = (name, values = [], children = []) => ({ name, values, children });
const p = (name, value) => node('P', [name, 'double', 'Number', '', value]);

// Small genuine FBX node records exercise both offset widths, not a JSON mock
// of the reader. No geometry/FBX SDK is needed to inspect material metadata.
function binaryFBX(version, tree) {
    const wide = version >= 7500;
    const headerSize = wide ? 25 : 13;
    function encode(entry, offset) {
        const name = Buffer.from(entry.name);
        const props = Buffer.concat(entry.values.map(value => {
            if (typeof value === 'string') {
                const text = Buffer.from(value);
                const header = Buffer.alloc(5);
                header[0] = 83;
                header.writeUInt32LE(text.length, 1);
                return Buffer.concat([header, text]);
            }
            const bytes = Buffer.alloc(9);
            bytes[0] = typeof value === 'bigint' ? 76 : 68;
            if (typeof value === 'bigint') bytes.writeBigInt64LE(value, 1);
            else bytes.writeDoubleLE(value, 1);
            return bytes;
        }));
        let cursor = offset + headerSize + name.length + props.length;
        const children = entry.children.map(child => {
            const bytes = encode(child, cursor);
            cursor += bytes.length;
            return bytes;
        });
        const header = Buffer.alloc(headerSize);
        for (const [index, value] of [cursor + headerSize, entry.values.length, props.length].entries()) {
            if (wide) header.writeBigUInt64LE(BigInt(value), index * 8);
            else header.writeUInt32LE(value, index * 4);
        }
        header[headerSize - 1] = name.length;
        return Buffer.concat([header, name, props, ...children, Buffer.alloc(headerSize)]);
    }
    const header = Buffer.alloc(27);
    header.write('Kaydara FBX Binary  \0\x1a\0', 'latin1');
    header.writeUInt32LE(version, 23);
    let cursor = 27;
    return Buffer.concat([header, ...tree.map(entry => {
        const bytes = encode(entry, cursor);
        cursor += bytes.length;
        return bytes;
    }), Buffer.alloc(headerSize)]);
}

for (const version of [7400, 7500]) {
    test(`reads FBX ${version} material values, inherited defaults and exact connection IDs`, () => {
        const id = 9007199254740993n;
        const bytes = binaryFBX(version, [
            node('Definitions', [], [node('ObjectType', ['Material'], [node('PropertyTemplate', ['FbxSurfacePhong'], [
                node('Properties70', [], [p('Roughness', 0.8), p('SpecularFactor', 1)]),
            ])])]),
            node('Objects', [], [
                node('Geometry', [2n, 'Ignore'], [node('Vertices', [])]),
                node('Material', [id, 'Skin\0\x01Material', ''], [node('ShadingModel', ['phong']),
                    node('Properties70', [], [p('Roughness', 0), p('Metallic', 0.3)])]),
            ]),
            node('Connections', [], [node('C', ['OP', 12n, id, 'Roughness'])]),
        ]);
        const storage = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
        const material = readFBXMaterials(new DataView(storage.buffer, storage.byteOffset + 6, bytes.length))[0];
        assert.equal(material.name, 'Skin');
        assert.equal(material.properties.get('roughness'), 0);
        assert.equal(material.properties.get('metallic'), 0.3);
        assert.equal(material.properties.get('specularfactor'), 1);
        assert.deepEqual([...material.mappedProperties], ['roughness']);
    });
}

test('ASCII reader skips geometry arrays and braces in strings/comments', () => {
    const material = readFBXMaterials(Buffer.from(`; FBX 7.4.0
Objects: {
    Geometry: 2, "Geometry::body { test }", "Mesh" {
        Vertices: *9 {
            a: 0,0,0,
               1,0,0,0,1,0
        }
    }
    Material: 9007199254740993, "Material::Skin { test }", "" {
        ShadingModel: "phong"
        Properties70: { ; this } is a comment
            P: "Glossiness", "double", "Number", "A", 8e-1
            P: "SpecularFactor", "double", "Number", "", 0
        }
    }
}
Connections: {
    C: "OP", 8, 9007199254740993, "SpecularColor"
}
`))[0];
    assert.equal(material.name, 'Skin { test }');
    approx(material.properties.get('glossiness'), 0.8);
    assert.equal(material.properties.get('specularfactor'), 0);
    assert.ok(material.mappedProperties.has('specularcolor'));
});

test('reader rejects invalid binary offsets and truncated scalar data', () => {
    const bytes = binaryFBX(7400, [node('Objects', [], [node('Material', [1n, 'Skin', ''])])]);
    assert.throws(() => readFBXMaterials(bytes.subarray(0, 65)), /offset|bounds|range/i);
    const bad = Buffer.from(bytes);
    bad.writeUInt32LE(bytes.length + 100, 27);
    assert.throws(() => readFBXMaterials(bad), /offset/i);
});

async function converted(properties, { truePBR = false, packed = false, maps = [], duplicates = false, shading = 'phong' } = {}) {
    const doc = new Document();
    doc.createBuffer();
    doc.createScene();
    const material = doc.createMaterial('Skin').setMetallicFactor(0.4).setRoughnessFactor(0.14)
        .setExtras({ fromFBX: { isTruePBR: truePBR, shadingModel: shading } });
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
    const base = doc.createTexture('Color').setMimeType('image/png').setImage(image);
    material.setBaseColorTexture(base).setNormalTexture(base);
    if (packed) material.setMetallicRoughnessTexture(doc.createTexture('ORM').setMimeType('image/png').setImage(image))
        .setMetallicFactor(1).setRoughnessFactor(1);
    const sources = [{ name: 'Skin', shading, properties: new Map(Object.entries(properties)), mappedProperties: new Set(maps) }];
    if (duplicates) sources.push(sources[0]);
    const io = await createIO();
    const result = await io.readBinary(await normalizeConvertedGLB(await io.writeBinary(doc), {}, sources));
    const output = result.getRoot().listMaterials()[0];
    assert.deepEqual(output.getBaseColorTexture().getImage(), image);
    assert.deepEqual(output.getNormalTexture().getImage(), image);
    if (packed) assert.deepEqual(output.getMetallicRoughnessTexture().getImage(), image);
    return output;
}

test('Bianca-style disabled specular is not turned into polished metal', async () => {
    const material = await converted({ specularfactor: 0, shininess: 100, shininessexponent: 100 });
    assert.equal(material.getMetallicFactor(), 0);
    assert.equal(material.getRoughnessFactor(), 1);
    assert.equal(material.getExtension('KHR_materials_specular').getSpecularFactor(), 0);
});

test('explicit roughness takes precedence over shininess and legacy specular', async () => {
    for (const roughness of [0, 0.35, 1]) {
        const material = await converted({ roughness, shininess: 100, specularfactor: 0, metallic: 0.7 });
        approx(material.getRoughnessFactor(), roughness);
        approx(material.getMetallicFactor(), 0.7);
        assert.equal(material.getExtension('KHR_materials_specular'), null);
    }
});

test('glossiness and smoothness use inverse roughness, including zero', async () => {
    for (const name of ['glossiness', 'glossinessfactor', 'smoothness']) {
        for (const value of [0, 0.8, 1]) approx((await converted({ [name]: value })).getRoughnessFactor(), 1 - value);
    }
});

test('existing PBR packed textures and factors are not applied twice', async () => {
    const material = await converted({ roughness: 0.2, metallic: 0.8, specularfactor: 0 }, { truePBR: true, packed: true });
    assert.equal(material.getMetallicFactor(), 1);
    assert.equal(material.getRoughnessFactor(), 1);
    assert.equal(material.getExtension('KHR_materials_specular'), null);
});

test('legacy packed shininess map keeps its roughness channel and loses invented metal', async () => {
    const material = await converted({ shininess: 100 }, { packed: true });
    assert.equal(material.getMetallicFactor(), 0);
    assert.equal(material.getRoughnessFactor(), 1);
});

test('shiny legacy materials retain converted roughness and specular textures are respected', async () => {
    approx((await converted({ shininess: 100, specularfactor: 1 })).getRoughnessFactor(), 0.14);
    const mapped = await converted({ specularfactor: 0 }, { maps: ['specularfactor'] });
    approx(mapped.getRoughnessFactor(), 0.14);
    assert.equal(mapped.getExtension('KHR_materials_specular'), null);
});

test('duplicate material names and unknown shaders are not guessed', async () => {
    for (const options of [{ duplicates: true }, { shading: 'custom' }]) {
        const material = await converted({ specularfactor: 0 }, options);
        approx(material.getMetallicFactor(), 0.4);
        approx(material.getRoughnessFactor(), 0.14);
    }
});
