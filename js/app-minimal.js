/**
 * Minimal integration guide for BabylonJS Character Controller V2.
 * Use this file as a template/reference to implement the character controller in your own app.
 */

// 1. Scene setup
const canvas = document.getElementById('c');
const engine = new BABYLON.Engine(canvas, true);

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
  let usePhysics = false;
  try {
    const havokInstance = await HavokPhysics();
    const hk = new BABYLON.HavokPlugin(true, havokInstance);
    scene.enablePhysics(new BABYLON.Vector3(0, -22, 0), hk);

    // Setup ground physics
    new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
    usePhysics = true;
    console.log("Havok Physics initialized successfully.");
  } catch (e) {
    console.warn("Havok Physics failed to load, falling back to Kinematic collisions.", e);
  }

  // 6. Load Character and Setup Controller
  await setupCharacter(scene, camera, usePhysics);

  return scene;
}

async function setupCharacter(scene, camera, usePhysics) {
  // Load GLB file containing character mesh and animations
  const result = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'character_animated.glb', scene);

  const charVisual = result.meshes[0];
  charVisual.name = 'Character_Visual';

  // Disable pickability on character meshes so they don't block raycasts
  result.meshes.forEach(m => {
    m.isPickable = false;
  });

  // Stop auto-playing animations
  result.animationGroups.forEach(ag => ag.stop());

  // 7. Create parent Capsule Collider
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.4, height: 1.8 }, scene);
  playerCapsule.position.set(0, 2, 0); // Spawn slightly above ground
  playerCapsule.visibility = 0;       // Hide the collision shape
  playerCapsule.isPickable = false;

  // Kinematic ellipsoid settings (only if physics is disabled)
  playerCapsule.checkCollisions = !usePhysics;
  playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);
  playerCapsule.ellipsoidOffset = new BABYLON.Vector3(0, 0, 0);

  // 8. Parent the visual mesh to the capsule collider
  charVisual.setParent(playerCapsule);

  // Set Y offsets so the feet touch the ground (Havok uses capsule center, kinematic is slightly different)
  charVisual.position.set(0, usePhysics ? -0.90 : -0.97, 0);
  charVisual.rotation.set(0, 0, 0);

  // 9. Prepare animation groups (Filter out T-Pose)
  const filteredGroups = result.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

  // 10. Instantiate controllers
  const animCtrl = new AnimCtrl(filteredGroups, scene);

  // Setup options for CharCtrl
  const charOptions = {
    usePhysics: usePhysics,
    // Add custom keyboard configuration if needed:
    // keys: { MOVE_FORWARD: ['KeyW'], ... }
  };
  const charCtrl = new CharCtrl(playerCapsule, charVisual, camera, animCtrl, scene, charOptions);

  // 11. Make Camera follow the player capsule target
  scene.registerBeforeRender(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const clampedDt = Math.max(0.001, Math.min(0.1, dt));

    // Interpolate camera target to character position (with height offset)
    const targetPosition = playerCapsule.position.add(new BABYLON.Vector3(0, 0.4, 0));
    camera.target = BABYLON.Vector3.Lerp(camera.target, targetPosition, 1 - Math.exp(-15 * clampedDt));
  });
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

