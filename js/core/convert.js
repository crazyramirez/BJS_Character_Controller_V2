#!/usr/bin/env node

/** Legacy batch-FBX CLI backed by the canonical fbx_api.mjs implementation. */

const fs = require('node:fs/promises');
const path = require('node:path');

async function collectFBX(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFBX(fullPath));
    else if (entry.isFile() && /\.fbx$/i.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function main() {
  const input = path.resolve(process.argv[2] || '_input');
  const output = path.resolve(process.argv[3] || '_output');
  const { convertFBXToGLB } = await import('./fbx_api.mjs');
  const files = await collectFBX(input);
  if (!files.length) throw new Error(`No FBX files found under ${input}.`);

  for (const file of files) {
    const relative = path.relative(input, file).replace(/\.fbx$/i, '.glb');
    const destination = path.join(output, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const converted = await convertFBXToGLB(await fs.readFile(file), path.basename(file));
    await fs.writeFile(destination, converted);
    console.log(`Converted ${file} -> ${destination}`);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
