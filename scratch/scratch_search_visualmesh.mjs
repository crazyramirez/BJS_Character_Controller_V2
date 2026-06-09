import fs from 'fs';

const content = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\js\\character-controller.js', 'utf8');

const lines = content.split('\n');
console.log('--- Matches for visualMesh in character-controller.js ---');
lines.forEach((line, idx) => {
  if (line.includes('visualMesh')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
