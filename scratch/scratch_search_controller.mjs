import fs from 'fs';

const content = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\js\\character-controller.js', 'utf8');

const lines = content.split('\n');
console.log('--- Matches for scaling/hips/RootNode in character-controller.js ---');
lines.forEach((line, idx) => {
  const l = line.toLowerCase();
  if (l.includes('scale') || l.includes('hips') || l.includes('rootnode') || l.includes('pivot') || l.includes('skeleton')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
