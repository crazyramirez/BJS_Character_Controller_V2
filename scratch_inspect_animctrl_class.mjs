import fs from 'fs';

const content = fs.readFileSync('d:\\DEV\\BJS Character Controller V2\\js\\character-controller.js', 'utf8');

const lines = content.split('\n');
console.log('--- AnimCtrl class in character-controller.js ---');
lines.forEach((line, idx) => {
  if (line.includes('class AnimCtrl') || line.includes('class BlendTree') || (idx > 100 && idx < 500 && line.includes('class '))) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
