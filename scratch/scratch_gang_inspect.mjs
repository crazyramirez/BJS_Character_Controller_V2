import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

async function main() {
  const dracoLib = draco3d.createDecoderModule ? draco3d : (draco3d.default || draco3d);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await dracoLib.createDecoderModule(),
      'draco3d.encoder': await dracoLib.createEncoderModule(),
    });

  const file = 'd:\\DEV\\BJS Character Controller V2\\assets\\characters_test\\gang.glb';
  const doc = await io.readBinary(fs.readFileSync(file));

  const parentMap = new Map();
  for (const node of doc.getRoot().listNodes()) {
    for (const child of node.listChildren()) parentMap.set(child, node);
  }

  function getDepth(node) {
    let depth = 0;
    let cur = node;
    while (parentMap.has(cur)) { cur = parentMap.get(cur); depth++; }
    return depth;
  }

  console.log('\n=== SCENE HIERARCHY (top 3 levels) ===');
  for (const scene of doc.getRoot().listScenes()) {
    console.log(`Scene: "${scene.getName()}"`);
    for (const child of scene.listChildren()) {
      const t = child.getTranslation() || [0,0,0];
      const s = child.getScale() || [1,1,1];
      console.log(`  Node: "${child.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}] scale=[${s.map(v=>v.toFixed(4)).join(', ')}]`);
      for (const gc of child.listChildren()) {
        const t2 = gc.getTranslation() || [0,0,0];
        const s2 = gc.getScale() || [1,1,1];
        console.log(`    Node: "${gc.getName()}" trans=[${t2.map(v=>v.toFixed(4)).join(', ')}] scale=[${s2.map(v=>v.toFixed(4)).join(', ')}]`);
        for (const ggc of gc.listChildren()) {
          const t3 = ggc.getTranslation() || [0,0,0];
          console.log(`      Node: "${ggc.getName()}" trans=[${t3.map(v=>v.toFixed(4)).join(', ')}]`);
          for (const gggc of ggc.listChildren()) {
            const t4 = gggc.getTranslation() || [0,0,0];
            console.log(`        Node: "${gggc.getName()}" trans=[${t4.map(v=>v.toFixed(4)).join(', ')}]`);
          }
        }
      }
    }
  }

  console.log('\n=== SKINS ===');
  for (const skin of doc.getRoot().listSkins()) {
    console.log(`Skin: "${skin.getName()}" joints: ${skin.listJoints().length}`);
    const joints = skin.listJoints();
    for (let i = 0; i < Math.min(5, joints.length); i++) {
      const j = joints[i];
      const t = j.getTranslation() || [0,0,0];
      const p = parentMap.get(j);
      console.log(`  [${i}] "${j.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}] parent="${p?.getName()||'ROOT'}"`);
    }
  }

  // Find hips/pelvis
  console.log('\n=== HIP/PELVIS BONES ===');
  for (const node of doc.getRoot().listNodes()) {
    const n = (node.getName() || '').toLowerCase();
    if (n.includes('hip') || n.includes('pelvis') || n.includes('root') || n.includes('hips')) {
      const t = node.getTranslation() || [0,0,0];
      const p = parentMap.get(node);
      const pp = p ? parentMap.get(p) : null;
      console.log(`  "${node.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}] parent="${p?.getName()||'ROOT'}" grandparent="${pp?.getName()||'-'}"`);
    }
  }

  // Find foot bones
  console.log('\n=== FOOT BONES ===');
  for (const node of doc.getRoot().listNodes()) {
    const n = (node.getName() || '').toLowerCase();
    if (n.includes('foot') || n.includes('ankle') || n.includes('toe')) {
      const t = node.getTranslation() || [0,0,0];
      console.log(`  "${node.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}]`);
    }
  }

  // Compute world positions
  console.log('\n=== WORLD POSITIONS (hips & feet) ===');
  const worldPos = new Map();
  const worldRot = new Map();
  function computeWorld(node) {
    if (worldPos.has(node)) return;
    const localT = node.getTranslation() || [0,0,0];
    const parent = parentMap.get(node);
    if (parent) {
      computeWorld(parent);
      const [px,py,pz] = worldPos.get(parent);
      worldPos.set(node, [px + localT[0], py + localT[1], pz + localT[2]]);
    } else {
      worldPos.set(node, [...localT]);
    }
  }
  for (const node of doc.getRoot().listNodes()) computeWorld(node);

  for (const node of doc.getRoot().listNodes()) {
    const n = (node.getName() || '').toLowerCase();
    if (n.includes('hip') || n.includes('pelvis') || n.includes('foot') || n.includes('toe') || n.includes('ankle')) {
      const wp = worldPos.get(node) || [0,0,0];
      console.log(`  "${node.getName()}" worldY=${wp[1].toFixed(4)}`);
    }
  }

  // Compare with character_animated.glb
  console.log('\n\n=== character_animated.glb COMPARISON ===');
  const animFile = 'd:\\DEV\\BJS Character Controller V2\\assets\\character_animated.glb';
  const doc2 = await io.readBinary(fs.readFileSync(animFile));
  const parentMap2 = new Map();
  for (const node of doc2.getRoot().listNodes()) {
    for (const child of node.listChildren()) parentMap2.set(child, node);
  }

  const worldPos2 = new Map();
  function computeWorld2(node) {
    if (worldPos2.has(node)) return;
    const localT = node.getTranslation() || [0,0,0];
    const parent = parentMap2.get(node);
    if (parent) {
      computeWorld2(parent);
      const [px,py,pz] = worldPos2.get(parent);
      worldPos2.set(node, [px + localT[0], py + localT[1], pz + localT[2]]);
    } else {
      worldPos2.set(node, [...localT]);
    }
  }
  for (const node of doc2.getRoot().listNodes()) computeWorld2(node);

  for (const node of doc2.getRoot().listNodes()) {
    const n = (node.getName() || '').toLowerCase();
    if (n.includes('hip') || n.includes('pelvis') || n.includes('foot') || n.includes('toe') || n.includes('ankle')) {
      const wp = worldPos2.get(node) || [0,0,0];
      const localT = node.getTranslation() || [0,0,0];
      const p = parentMap2.get(node);
      console.log(`  "${node.getName()}" worldY=${wp[1].toFixed(4)} localY=${localT[1].toFixed(4)} parent="${p?.getName()||'ROOT'}"`);
    }
  }

  // Also show root-level nodes in char_animated
  console.log('\n=== character_animated.glb SCENE HIERARCHY ===');
  for (const scene of doc2.getRoot().listScenes()) {
    for (const child of scene.listChildren()) {
      const t = child.getTranslation() || [0,0,0];
      const s = child.getScale() || [1,1,1];
      console.log(`  Node: "${child.getName()}" trans=[${t.map(v=>v.toFixed(4)).join(', ')}] scale=[${s.map(v=>v.toFixed(4)).join(', ')}]`);
      for (const gc of child.listChildren()) {
        const t2 = gc.getTranslation() || [0,0,0];
        console.log(`    Node: "${gc.getName()}" trans=[${t2.map(v=>v.toFixed(4)).join(', ')}]`);
        for (const ggc of gc.listChildren()) {
          const t3 = ggc.getTranslation() || [0,0,0];
          console.log(`      Node: "${ggc.getName()}" trans=[${t3.map(v=>v.toFixed(4)).join(', ')}]`);
        }
      }
    }
  }
}

main().catch(console.error);
