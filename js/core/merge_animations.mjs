#!/usr/bin/env node

/**
 * Command-line wrapper around the canonical merge API.
 *
 * Keeping the implementation in merge_api.mjs ensures the desktop app,
 * development server, tests and CLI all use the same retargeting code.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeGLBs } from './merge_api.mjs';

function usage() {
  return `Usage:
  node js/core/merge_animations.mjs -c character.glb -a animations.glb -o output.glb [options]

Options:
  --scale-x N --scale-y N --scale-z N
  --pivot-x N --pivot-y N --pivot-z N
  --arm-spread N --arm-splay N --shoulder-raise N
  --leg-spread N --spine-straighten N --hips-tilt N
  --no-compress
  --replace-animations
  -h, --help`;
}

function parseFinite(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a finite number.`);
  return value;
}

function parseArgs(argv) {
  const result = { options: {} };
  const valueFlags = new Map([
    ['--scale-x', 'SCALE_X'], ['--scale-y', 'SCALE_Y'], ['--scale-z', 'SCALE_Z'],
    ['--pivot-x', 'PIVOT_X'], ['--pivot-y', 'PIVOT_Y'], ['--pivot-z', 'PIVOT_Z'],
    ['--arm-spread', 'ARM_SPREAD_ANGLE'], ['--arm-splay', 'ARM_SPLAY_ANGLE'],
    ['--shoulder-raise', 'SHOULDER_RAISE_ANGLE'], ['--leg-spread', 'LEG_SPREAD_ANGLE'],
    ['--spine-straighten', 'SPINE_STRAIGHTEN_ANGLE'], ['--hips-tilt', 'HIPS_TILT_ANGLE'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '-h' || flag === '--help') result.help = true;
    else if ((flag === '-c' || flag === '--character') && argv[i + 1]) result.character = argv[++i];
    else if ((flag === '-a' || flag === '--animations') && argv[i + 1]) result.animations = argv[++i];
    else if ((flag === '-o' || flag === '--output') && argv[i + 1]) result.output = argv[++i];
    else if (valueFlags.has(flag) && argv[i + 1]) result.options[valueFlags.get(flag)] = parseFinite(argv[++i], flag);
    else if (flag === '--no-compress') result.options.COMPRESS_OUTPUT = false;
    else if (flag === '--replace-animations') result.options.removeExistingAnimations = true;
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  return result;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }
  if (!parsed.character || !parsed.animations || !parsed.output) throw new Error(usage());

  const [character, animations] = await Promise.all([
    fs.readFile(parsed.character),
    fs.readFile(parsed.animations),
  ]);
  const merged = await mergeGLBs(character, animations, parsed.options);
  await fs.mkdir(path.dirname(path.resolve(parsed.output)), { recursive: true });
  await fs.writeFile(parsed.output, merged);

  console.log(`Merged GLB written to ${path.resolve(parsed.output)} (${(merged.length / 1024 / 1024).toFixed(2)} MB).`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
