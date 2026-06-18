/**
 * Minimal integration guide for BabylonJS Character Controller V2.
 * Use this file as a template/reference to implement the character controller in your own app.
 */

// 1. Scene setup
const canvas = document.getElementById('c');
const engine = new BABYLON.Engine(canvas, true);

// ═══════════════════════════════════════════════════════════
// CHARACTER INITIALIZATION HELPER
// ═══════════════════════════════════════════════════════════
async function loadCharacter(scene, shadow, camera, usePhysics) {
  return setupCharacter(scene, camera, usePhysics, {
    shadow,
    assetsPath: 'assets/',
    // Integration Mode options:
    // Option A: Pre-merged GLB (Embedded animations, standard)
    // filename: 'character_animated_1.glb'

    // Option B: Runtime Client Retargeting (Separate mesh and animation pack)
    filename: 'character_animated_1.glb',
    animationsFilename: 'animations-pro.glb',
  });
}

async function createMinimalScene() {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.05, 0.1, 1);
  scene.collisionsEnabled = true;

  // 2. Camera setup
  const camera = new BABYLON.ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 3.5, 8, BABYLON.Vector3.Zero(), scene);
  camera.attachControl(canvas, true);

  // 3. Lighting setup
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.5;
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-1, -2, -1).normalize(), scene);
  sun.intensity = 1.0;

  // 4. Ground/Floor setup
  const ground = BABYLON.MeshBuilder.CreateBox('ground', { width: 50, height: 1, depth: 50 }, scene);
  ground.position.y = -0.5;
  ground.checkCollisions = true;

  // 5. OPTIONAL: Initialize Havok Physics
  const usePhysics = await initPhysics(scene);
  if (usePhysics) {
    // Setup ground physics
    new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
  }

  // 6. Load Character and Setup Controller
  let charHandle = await loadCharacter(scene, null, camera, usePhysics);
  const { playerCapsule, animCtrl, charCtrl } = charHandle;

  // Hook up HUD setting toggles dynamically via custom-hud.js
  if (typeof bindHUDControls === 'function') {
    bindHUDControls(charCtrl, camera, usePhysics);
  }

  // 7. OPTIONAL: Runtime character swap (no page reload). Console examples:
  //    Preset (anims embedded):  await switchCharacter({ filename: 'character_animated_2.glb' })
  //    Imported GLB as-is:       await switchCharacter({ glbUrl: URL.createObjectURL(file) })
  //    Merge anims into a mesh:  await switchCharacter({ glbUrl, animationsFilename: 'animations-basic.glb' })  // needs server
  window.switchCharacter = async (options) => {
    const merged = Object.assign({ shadow: null, assetsPath: 'assets/' }, options);
    charHandle = await loadCharacterRuntime(scene, camera, usePhysics, merged, charHandle);
    if (typeof bindHUDControls === 'function') {
      bindHUDControls(charHandle.charCtrl, camera, usePhysics);
    }
    return charHandle;
  };

  return scene;
}

// Note: setupCharacter is now loaded globally from js/character-controller.js

// Start Engine
createMinimalScene().then(scene => {
  engine.runRenderLoop(() => scene.render());

  // Hide loading screen once fully loaded
  const loader = document.getElementById('loading');
  if (loader) {
    loader.style.opacity = '0';
    setTimeout(() => loader.remove(), 700);
  }
});

window.addEventListener('resize', () => engine.resize());

