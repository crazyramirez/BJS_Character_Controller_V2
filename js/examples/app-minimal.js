/**
 * Minimal integration guide for BabylonJS Character Controller V2.
 * Use this file as a template/reference to implement the character controller in your own app.
 *
 * Page setup: <canvas id="c">, then babylon.js, babylonjs.loaders, (optional)
 * HavokPhysics_umd.js and js/character-controller.js as classic <script>s.
 */

// 1. Engine
const canvas = document.getElementById('c');
const engine = new BABYLON.Engine(canvas, true);

async function createMinimalScene() {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.05, 0.1, 1);
  scene.collisionsEnabled = true;

  // 2. Lighting
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.5;
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-1, -2, -1).normalize(), scene);
  sun.intensity = 1.0;

  // 3. Ground: kinematic collisions use checkCollisions, Havok uses the aggregate
  const ground = BABYLON.MeshBuilder.CreateBox('ground', { width: 50, height: 1, depth: 50 }, scene);
  ground.position.y = -0.5;
  ground.checkCollisions = true;
  const usePhysics = await initPhysics(scene, { persistPreferences: true }); // Havok, or kinematic fallback
  if (usePhysics) {
    new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
  }

  // 4. Character: one call creates the follow camera, capsule, animation and character controllers
  const player = await createCharacter(scene, {
    // Option A: pre-merged GLB (embedded animations, standard)
    model: 'assets/character_animated.glb',
    // Option B: separate mesh + animation pack (server merge, else client retargeting)
    // model: 'assets/character.glb',
    // animations: 'assets/animations.glb',
    physics: usePhysics,          // true | false | 'auto'
    persistPreferences: true,     // HUD toggles are remembered (opt-in)
    // preset: 'character.preset.json', // Builder export: keys, physics, animation mapping, events
    onProgress: (pct, label) => {
      const bar = document.getElementById('bar');
      const barLabel = document.getElementById('bar-label');
      if (bar) bar.style.width = pct + '%';
      if (barLabel && label) barLabel.textContent = label;
    },
  });

  // Optional: gameplay events (Observables fire for every character, whatever the HUD mode)
  player.charCtrl.onStateChangedObservable.add(({ state }) => {
    const el = document.getElementById('hud-state');
    if (el) el.textContent = state;
  });

  // Hook up HUD setting toggles dynamically via custom-hud.js
  if (typeof bindHUDControls === 'function') {
    bindHUDControls(player.charCtrl, player.camera, player.usePhysics);
  }

  return scene;
}

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
