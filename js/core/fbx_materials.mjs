import { KHRMaterialsSpecular } from '@gltf-transform/extensions';

// Read only material metadata. Geometry, animation arrays and embedded images
// are skipped, so inspecting a large FBX does not decompress a second copy.
const binaryHeader = 'Kaydara FBX Binary  \0\x1a\0';
const key = value => String(value).toLowerCase().replace(/[ _-]/g, '');
const clamp = value => Math.max(0, Math.min(1, value));

function wanted(parent, name, values) {
    if (!parent) return ['Objects', 'Definitions', 'Connections'].includes(name);
    if (parent === 'Objects') return name === 'Material';
    if (parent === 'Definitions') return name === 'ObjectType' && values[0] === 'Material';
    if (parent === 'ObjectType') return name === 'PropertyTemplate';
    if (parent === 'Material' || parent === 'PropertyTemplate') {
        return ['Properties70', 'Properties60', 'ShadingModel'].includes(name);
    }
    if (parent === 'Properties70') return name === 'P';
    if (parent === 'Properties60') return name === 'Property';
    return parent === 'Connections' && name === 'C';
}

function readBinary(bytes) {
    const wide = bytes.readUInt32LE(23) >= 7500;
    const headerSize = wide ? 25 : 13;
    let position = 27;
    let count = 0;
    function check(end, limit = bytes.length) {
        if (!Number.isSafeInteger(end) || end < position || end > limit) throw new Error('Invalid FBX metadata offset');
    }
    function integer() {
        const value = wide ? Number(bytes.readBigUInt64LE(position)) : bytes.readUInt32LE(position);
        position += wide ? 8 : 4;
        return value;
    }
    function property(limit) {
        check(position + 1, limit);
        const type = String.fromCharCode(bytes[position++]);
        const scalar = { Y: ['readInt16LE', 2], C: ['readUInt8', 1], I: ['readInt32LE', 4],
            F: ['readFloatLE', 4], D: ['readDoubleLE', 8], L: ['readBigInt64LE', 8] }[type];
        if (scalar) {
            check(position + scalar[1], limit);
            const value = bytes[scalar[0]](position);
            position += scalar[1];
            return typeof value === 'bigint' ? String(value) : value;
        }
        if (type === 'S' || type === 'R') {
            check(position + 4, limit);
            const length = bytes.readUInt32LE(position);
            position += 4;
            check(position + length, limit);
            const value = type === 'S' ? bytes.toString('utf8', position, position + length) : null;
            position += length;
            return value;
        }
        if ('fdlibc'.includes(type)) {
            check(position + 12, limit);
            const length = bytes.readUInt32LE(position + 8);
            check(position + 12 + length, limit);
            position += 12 + length;
            return null;
        }
        throw new Error('Unsupported FBX metadata property');
    }
    function nodes(parent = '', limit = bytes.length, depth = 0) {
        if (depth > 8) throw new Error('Invalid FBX metadata nesting');
        const result = [];
        while (position + headerSize <= limit) {
            if (++count > 500000) throw new Error('Too many FBX metadata nodes');
            const end = integer();
            const propertyCount = integer();
            const propertyBytes = integer();
            const nameLength = bytes[position++];
            if (end === 0) break;
            check(end, limit);
            check(position + nameLength, end);
            const name = bytes.toString('utf8', position, position + nameLength);
            position += nameLength;
            const propertyEnd = position + propertyBytes;
            check(propertyEnd, end);
            // Only ObjectType needs its value before deciding whether to enter.
            if (name !== 'ObjectType' && !wanted(parent, name, [])) { position = end; continue; }
            if (propertyCount > 64) throw new Error('Too many FBX material properties');
            const values = [];
            for (let i = 0; i < propertyCount; i++) values.push(property(propertyEnd));
            position = propertyEnd;
            if (wanted(parent, name, values)) result.push({ name, values, children: nodes(name, end, depth + 1) });
            position = end;
        }
        return result;
    }
    return nodes();
}

function readASCII(text) {
    // Quoted strings and comments are single tokens: braces in names/paths do
    // not change nesting. Unneeded blocks are scanned without building arrays.
    const tokens = /"(?:\\.|[^"\\])*"|;[^\r\n]*|\r?\n|[{}:,]|[^\s{}:,;]+/g;
    let pending;
    let count = 0;
    function next() {
        if (pending !== undefined) { const value = pending; pending = undefined; return value; }
        let match;
        while ((match = tokens.exec(text))) if (!match[0].startsWith(';')) return match[0].replace(/^\r\n$/, '\n');
        return null;
    }
    function value(token) {
        if (token.startsWith('"')) return token.slice(1, -1).replace(/\\(["\\])/g, '$1');
        // Keep IDs as strings instead of losing precision above 2^53.
        if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return token;
        return Number.isFinite(Number(token)) ? Number(token) : token;
    }
    function skipBlock() {
        let depth = 1;
        let token;
        while (depth && (token = next()) !== null) {
            if (token === '{') depth++;
            else if (token === '}') depth--;
        }
        if (depth) throw new Error('Unterminated ASCII FBX block');
    }
    function nodes(parent = '', depth = 0) {
        if (depth > 64) throw new Error('Invalid ASCII FBX nesting');
        const result = [];
        let token;
        while ((token = next()) !== null) {
            if (token === '}') return result;
            if (token === '\n' || token === ',') continue;
            const name = token;
            if (next() !== ':') throw new Error('Invalid ASCII FBX node');
            if (++count > 500000) throw new Error('Too many ASCII FBX nodes');
            const values = [];
            while ((token = next()) !== null && !['{', '}', '\n'].includes(token)) {
                if (token !== ',') {
                    // Array nodes belong to skipped blocks, never metadata.
                    if (values.length >= 64) throw new Error('Too many ASCII FBX material properties');
                    values.push(value(token));
                }
            }
            while (token === '\n') token = next();
            const include = wanted(parent, name, values);
            let children = [];
            if (token === '{') {
                if (include) children = nodes(name, depth + 1);
                else skipBlock();
            }
            if (token !== '{') pending = token;
            if (include) result.push({ name, values, children });
        }
        return result;
    }
    return nodes();
}

function properties(node) {
    const result = new Map();
    for (const group of node.children.filter(child => /^Properties[67]0$/.test(child.name))) {
        for (const prop of group.children) {
            const values = prop.values.slice(group.name === 'Properties70' ? 4 : 3);
            result.set(key(prop.values[0]), values.length === 1 ? values[0] : values);
        }
    }
    return result;
}

export function readFBXMaterials(input) {
    const bytes = input instanceof ArrayBuffer ? Buffer.from(input)
        : ArrayBuffer.isView(input) ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : Buffer.from(input);
    const tree = bytes.toString('latin1', 0, 23) === binaryHeader ? readBinary(bytes) : readASCII(bytes.toString('utf8'));
    const defaults = new Map();
    for (const objectType of tree.find(node => node.name === 'Definitions')?.children || []) {
        for (const template of objectType.children) defaults.set(key(template.values[0]), properties(template));
    }
    const connections = tree.find(node => node.name === 'Connections')?.children || [];
    return (tree.find(node => node.name === 'Objects')?.children || []).map(node => {
        const shading = key(node.children.find(child => child.name === 'ShadingModel')?.values[0] || '');
        const props = new Map([...(defaults.get(`fbxsurface${shading}`) || []), ...properties(node)]);
        return {
            name: String(node.values[1] || '').split('\0')[0].replace(/^Material::/, ''),
            shading, properties: props,
            mappedProperties: new Set(connections.filter(connection => connection.values[0] === 'OP'
                && String(connection.values[2]) === String(node.values[0])).map(connection => key(connection.values[3]))),
        };
    });
}

function number(props, names) {
    for (const name of names) {
        const value = props.get(key(name));
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

export function restoreFBXMaterialFactors(doc, sources) {
    for (const material of doc.getRoot().listMaterials()) {
        const origin = material.getExtras().fromFBX;
        // The native converter already packs supported PBR values into textures.
        // Reapplying those factors would multiply them twice.
        if (origin?.isTruePBR !== false) continue;
        const matches = sources.filter(source => source.name === material.getName());
        if (matches.length !== 1) continue; // Never guess with duplicate names.
        const { properties: props, mappedProperties: maps, shading } = matches[0];
        const roughness = number(props, ['Roughness', 'RoughnessFactor']);
        const glossiness = number(props, ['Glossiness', 'GlossinessFactor', 'Smoothness']);
        const metallic = number(props, ['Metalness', 'Metallic', 'MetallicFactor', 'MetalnessFactor']);
        const hasPBR = roughness !== undefined || glossiness !== undefined || metallic !== undefined;
        const legacy = ['phong', 'blinn', 'lambert'].includes(shading);
        if (!hasPBR && !legacy) continue;

        // Phong/Blinn is not evidence of metal. FBX2glTF 0.9.7 hardcodes 0.4
        // (0.2 for Lambert); zero also masks that value in packed textures.
        if (metallic !== undefined && !material.getMetallicRoughnessTexture()) material.setMetallicFactor(clamp(metallic));
        else if (metallic === undefined) material.setMetallicFactor(0);

        let roughnessSource;
        if (!material.getMetallicRoughnessTexture()) {
            if (roughness !== undefined && !maps.has('roughness') && !maps.has('roughnessfactor')) {
                material.setRoughnessFactor(clamp(roughness));
                roughnessSource = 'roughness';
            } else if (glossiness !== undefined && !['glossiness', 'glossinessfactor', 'smoothness'].some(name => maps.has(name))) {
                material.setRoughnessFactor(1 - clamp(glossiness));
                roughnessSource = 'glossiness';
            }
        }

        // A legacy material with disabled specular has no highlight, regardless
        // of its (often default/exporter-generated) Shininess=100. Preserve that
        // intent instead of turning it into a polished metal during conversion.
        const specular = number(props, ['SpecularFactor']);
        const color = props.get('specularcolor') ?? props.get('specular');
        const blackSpecular = Array.isArray(color) && color.length === 3 && color.every(value => value === 0);
        const specularMapped = ['specular', 'specularcolor', 'specularfactor'].some(name => maps.has(name));
        if (!hasPBR && legacy && !specularMapped && (specular === 0 || blackSpecular || shading === 'lambert')) {
            const extension = doc.createExtension(KHRMaterialsSpecular);
            material.setExtension('KHR_materials_specular', extension.createSpecular().setSpecularFactor(0));
            if (!material.getMetallicRoughnessTexture()) {
                material.setRoughnessFactor(1);
                roughnessSource = 'disabled-specular';
            }
        }
        material.setExtras({ ...material.getExtras(), fromFBX: { ...origin,
            materialFactorsRestored: true, ...(roughnessSource ? { roughnessSource } : {}) } });
    }
}
