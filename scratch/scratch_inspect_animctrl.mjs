import fs from 'fs';

const content = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\js\\character-controller.js', 'utf8');

const lines = content.split('\n');
console.log('--- Matches in character-controller.js (AnimCtrl or Bone related) ---');
lines.forEach((line, idx) => {
  const l = line.toLowerCase();
  if (idx > 2780 && idx < 2930) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
