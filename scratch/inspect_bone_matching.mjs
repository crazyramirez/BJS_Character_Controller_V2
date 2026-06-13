import { NodeIO } from '@gltf-transform/core';

// Replicate the exact normBone function from character-controller.js
function normBone(name) {
  if (!name) return '';
  let n = name.toLowerCase();
  
  // 1. Determine side (left / right)
  let side = '';
  if (n.includes('left') || n.match(/\b_l\b/) || n.match(/_l_/) || n.startsWith('l_') || n.match(/[^a-z]l[a-z]/) || n.includes('lhand') || n.includes('lfoot') || n.includes('lthigh') || n.includes('lcalf') || n.includes('larm') || n.includes('lforearm') || n.includes('lclavicle')) {
    side = 'left';
  } else if (n.includes('right') || n.match(/\b_r\b/) || n.match(/_r_/) || n.startsWith('r_') || n.match(/[^a-z]r[a-z]/) || n.includes('rhand') || n.includes('rfoot') || n.includes('rthigh') || n.includes('rcalf') || n.includes('rarm') || n.includes('rforearm') || n.includes('rclavicle')) {
    side = 'right';
  }
  
  // Clean prefixes and punctuation
  n = n.replace(/^(mixamorig\d*|armature|cc_base)[:_ ]/i, '')
       .replace(/[:_ \-]/g, '');
       
  // 2. Normalize synonyms
  if (n.includes('thigh')) n = n.replace('thigh', 'upleg');
  if (n.includes('calf')) n = n.replace('calf', 'leg');
  if (n.includes('upperarm')) n = n.replace('upperarm', 'arm');
  if (n.includes('clavicle')) n = n.replace('clavicle', 'shoulder');
  if (n.includes('pelvis')) n = n.replace('pelvis', 'hips');
  if (n.includes('hip')) n = n.replace('hip', 'hips');
  if (n.includes('hand')) n = n.replace('hand', '');
  if (n.includes('middle')) n = n.replace('middle', 'mid');
  
  // If we found a side, prepend it to ensure left/right are distinct
  if (side) {
    n = n.replace(/^(left|right|l|r)/, '');
    n = side + n;
  }
  
  return n;
}

const boneAliases = {
  'mixamorig:spine': 'cc_base_waist',
  'mixamorig:spine1': 'cc_base_spine01',
  'mixamorig:spine2': 'cc_base_spine02',
  'mixamorig:neck': 'cc_base_necktwist01',
  'mixamorig:neck1': 'cc_base_necktwist02',
};

const io = new NodeIO();

async function main() {
  const charDoc = await io.read('assets/pete_base.glb');
  const animDoc = await io.read('assets/animations.glb');
  
  // Extract target bones (joints)
  const targetBones = [];
  for (const skin of charDoc.getRoot().listSkins()) {
    skin.listJoints().forEach(j => {
      if (!targetBones.includes(j.getName())) {
        targetBones.push(j.getName());
      }
    });
  }
  
  // Extract animation source nodes
  const srcNodes = [];
  for (const anim of animDoc.getRoot().listAnimations()) {
    anim.listChannels().forEach(chan => {
      const node = chan.getTargetNode();
      if (node && node.getName() && !srcNodes.includes(node.getName())) {
        srcNodes.push(node.getName());
      }
    });
  }
  
  // Build lookup maps
  const targetByName = new Map();
  const targetByNorm = new Map();
  targetBones.forEach(name => {
    targetByName.set(name.toLowerCase(), name);
    const norm = normBone(name);
    if (norm) targetByNorm.set(norm, name);
  });
  
  console.log(`Loaded ${targetBones.length} target bones, ${srcNodes.length} animation source nodes.`);
  
  // Perform mapping
  const boneMap = new Map();
  const unmapped = [];
  
  srcNodes.forEach(srcName => {
    let matchedName = targetByName.get(srcName.toLowerCase());
    if (!matchedName) {
      const alias = boneAliases[srcName.toLowerCase()];
      if (alias) {
        matchedName = targetByName.get(alias);
      }
    }
    if (!matchedName) {
      const norm = normBone(srcName);
      matchedName = targetByNorm.get(norm);
    }
    
    if (matchedName) {
      boneMap.set(srcName, matchedName);
    } else {
      unmapped.push(srcName);
    }
  });
  
  console.log(`\n--- Mapped Bones (${boneMap.size}) ---`);
  boneMap.forEach((tgt, src) => {
    console.log(`  "${src}" -> "${tgt}" (norms: src="${normBone(src)}", tgt="${normBone(tgt)}")`);
  });
  
  console.log(`\n--- Unmapped Nodes (${unmapped.length}) ---`);
  unmapped.forEach(src => {
    console.log(`  "${src}" (norm: "${normBone(src)}")`);
  });
}

main();
