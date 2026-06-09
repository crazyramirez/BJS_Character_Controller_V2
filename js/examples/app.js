'use strict';

// ═══════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const V3 = (x = 0, y = 0, z = 0) => new BABYLON.Vector3(x, y, z);
const C3 = (r, g, b) => new BABYLON.Color3(r, g, b);
var charRoot, charRes;

function setLoad(pct, label) {
  $('bar').style.width = pct + '%';
  if (label) $('bar-label').textContent = label;
}
function hideLoad() {
  const el = $('loading');
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 700);
}


// ═══════════════════════════════════════════════════════════
// SCENE BOOTSTRAP
// ═══════════════════════════════════════════════════════════
const canvas = $('c');
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: true, stencil: true, antialias: true
});

// ═══════════════════════════════════════════════════════════
// CHARACTER INITIALIZATION HELPER
// ═══════════════════════════════════════════════════════════
async function loadCharacter(scene, shadow, camera, usePhysics) {
  return setupCharacter(scene, camera, usePhysics, {
    shadow,
    assetsPath: 'assets/',
    filename: 'character_animated.glb'
  });
}

// Setup Character with custom controls and animations
// async function loadCharacter(scene, shadow, camera, usePhysics) {
//   return setupCharacter(scene, camera, usePhysics, {
//     // Optional: Set your shadow generator
//     shadow: shadow,
//     // Optional: Remap controls directly
//     keys: {
//       JUMP: ['KeyK'],
//       ROLL: ['KeyF']
//     },
//     // Optional: Remap animations and ranges using the configure callback
//     configure: ({ animCtrl, filteredGroups }) => {
//       // Change the walking animation to another one from the GLB
//       animCtrl.setWalkAnim(filteredGroups[2]);
//       // Change the frame ranges for an animation
//       animCtrl.setAnimationRanges('Walk_Loop', 0, 50);
//     }
//   });
// }


// ═══════════════════════════════════════════════════════════
// CREATE SCENE
// ═══════════════════════════════════════════════════════════
async function createDemoScene() {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.04, 0.09, 1);
  scene.gravity = V3(0, -9.8, 0);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.008;
  scene.fogColor = C3(0.04, 0.04, 0.09);

  // Physics mode: HUD/localStorage override takes priority.
  const usePhysics = await initPhysics(scene);

  // Enable Collisions
  scene.collisionsEnabled = true;

  // ── CAMERA ─────────────────────────────────────────────
  const isMobileCam = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const initialRadius = isMobileCam ? 5.2 : 8; // Zoom in closer on mobile for high detail
  const initialBeta = isMobileCam ? Math.PI / 3.0 : Math.PI / 3.5; // Slightly lower perspective on mobile (dramatic hero angle)

  const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, initialBeta, initialRadius, V3(0, 1.2, 0), scene);
  camera.lowerRadiusLimit = 1.2;
  camera.upperRadiusLimit = 18;
  camera.lowerBetaLimit = 0.05;
  camera.upperBetaLimit = Math.PI / 2.05;
  camera.wheelPrecision = 60;
  camera.panningSensibility = 0;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

  // ── SKYBOX & ENVIRONMENT IBL ───────────────────────────
  const envTex = BABYLON.CubeTexture.CreateFromPrefilteredData("assets/environment_2.env", scene);
  scene.environmentTexture = envTex;
  scene.environmentIntensity = 1.0;

  // Create a beautifully blurred skybox for a premium depth-of-field effect
  const skybox = scene.createDefaultSkybox(envTex, true, 2000, 0.9);
  if (skybox && skybox.material) {
    skybox.material.fogEnabled = false;
  }

  // ── LIGHTS ─────────────────────────────────────────────
  // Lower fill and hemi intensities as the IBL provides the main ambient lighting
  const hemi = new BABYLON.HemisphericLight('hemi', V3(0, 1, 0), scene);
  hemi.intensity = 0.2;
  hemi.groundColor = C3(0.08, 0.08, 0.15);
  hemi.diffuse = C3(0.9, 0.95, 1.0);

  const sun = new BABYLON.DirectionalLight('sun', V3(-1, -2, -1).normalize(), scene);
  sun.position = V3(15, 25, 15);
  sun.intensity = 1.2; // Balanced for shadow contrast with IBL
  sun.diffuse = C3(1, 0.97, 0.9);
  sun.specular = C3(0.5, 0.5, 0.4);
  sun.autoCalcShadowZBounds = false; // Disable automatic Z-bounds calculation
  sun.autoUpdateExtends = false;     // Disable automatic extends calculation
  sun.shadowMinZ = 5;               // Shadow near plane set to 10
  sun.shadowMaxZ = 60;               // Shadow far plane set to 80
  sun.shadowOrthoScale = 1.2;

  const fill = new BABYLON.PointLight('fill', V3(-8, 4, -4), scene);
  fill.intensity = 0.1;
  fill.diffuse = C3(0.4, 0.5, 1.0);

  // ── SHADOWS ────────────────────────────────────────────
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Use 2048 for high-definition, sharp shadow maps on all modern screens
  const shadowSize = 2048;
  const shadow = new BABYLON.ShadowGenerator(shadowSize, sun);

  if (isMobile) {
    // Mobile (iOS & Android): Use PCF with Medium quality (3x3 kernel).
    // This provides beautiful, anti-aliased soft shadows without any pixelation or noise,
    // utilizing hardware PCF filtering natively supported on WebGL 2.
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
    shadow.bias = 0.005;
    shadow.normalBias = 0.001;
  } else {
    // Desktop: premium PCF High quality (5x5 kernel)
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_HIGH;
    shadow.bias = 0.01;
    shadow.normalBias = 0.002;
  }

  const colorBase = C3(0.57, 0.59, 0.52);
  // ── GROUND ─────────────────────────────────────────────
  const ground = BABYLON.MeshBuilder.CreateBox('gnd', { width: 80, height: 1.0, depth: 80 }, scene);
  ground.position.y = -0.5;
  ground.receiveShadows = true;
  ground.checkCollisions = true;

  // Try GridMaterial, fallback to PBR
  let gndMat;
  gndMat = new BABYLON.PBRMaterial('gndMat', scene);
  gndMat.albedoColor = colorBase
  gndMat.roughness = 0.95;
  gndMat.metallic = 0;
  ground.material = gndMat;
  ground.receiveShadows = true;

  if (usePhysics) {
    new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0.1 }, scene);
  }

  const rough = 0.7;

  // ── ENVIRONMENT PROPS ──────────────────────────────────
  const propData = [
    [5, 0, -5, 1, 1, 1, 0.4, 0.2, 0.2],
    [-5, 0, 5, 1, 1, 1, 0.2, 0.2, 0.4],
    [8, 0, 2, 0.8, 2, 0.8, 0.3, 0.3, 0.2],
    [-7, 0, -3, 1.2, 0.6, 1.2, 0.2, 0.3, 0.2],
    [0, 0, 9, 2, 0.5, 2, 0.25, 0.2, 0.15],
  ];
  propData.forEach(([x, _y, z, sx, sy, sz, r, g, b], i) => {
    const box = BABYLON.MeshBuilder.CreateBox(`prop${i}`, { width: sx, height: sy, depth: sz }, scene);
    box.position.set(x, sy / 2, z);
    box.receiveShadows = true;
    box.checkCollisions = true;
    box.isPickable = true;
    shadow.addShadowCaster(box);
    const m = new BABYLON.PBRMaterial(`pm${i}`, scene);
    m.albedoColor = colorBase; // Use colorful custom values from propData
    m.roughness = rough;
    box.material = m;

    if (usePhysics) {
      new BABYLON.PhysicsAggregate(box, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.6, restitution: 0.1 }, scene);
    }
  });

  // Platform (stage)
  const platform = BABYLON.MeshBuilder.CreateCylinder('platform', {
    diameter: 10, height: 0.12, tessellation: 32
  }, scene);
  platform.position.y = 0.06; // Adjusted so top surface matches ground height or is slightly above
  platform.receiveShadows = true;
  platform.checkCollisions = true;
  platform.isPickable = true;
  const platM = new BABYLON.PBRMaterial('platM', scene);
  platM.albedoColor = colorBase;
  platM.roughness = rough;
  platform.material = platM;

  if (usePhysics) {
    new BABYLON.PhysicsAggregate(platform, BABYLON.PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.8, restitution: 0.1 }, scene);
  }

  // ── EXTRA ENVIRONMENT PROPS (RAMP & STAIRS) ───────────
  // 1. Curved Slope / Ramp
  const ramp = BABYLON.MeshBuilder.CreateBox("ramp", { width: 4, height: 0.5, depth: 7 }, scene);
  ramp.position.set(10, 0.9, 6);
  ramp.rotation.x = Math.PI / 8; // ~22.5 degree slope
  ramp.checkCollisions = true;
  ramp.isPickable = true;
  ramp.receiveShadows = true;
  ramp.meshType = 'scalable';
  shadow.addShadowCaster(ramp);
  const rampM = new BABYLON.PBRMaterial("rampM", scene);
  rampM.albedoColor = colorBase;
  rampM.roughness = rough;
  ramp.material = rampM;

  if (usePhysics) {
    new BABYLON.PhysicsAggregate(ramp, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.6, restitution: 0.1 }, scene);
  }

  // 2. Flight of stairs — individual boxes with collision so visual matches physics exactly
  const stairM = new BABYLON.PBRMaterial("stairM", scene);
  stairM.albedoColor = colorBase;
  stairM.roughness = rough;
  const numSteps = 8;
  for (let i = 0; i < numSteps; i++) {
    // Made steps wider (5.5m), thicker/higher (0.4m), and deeper (0.8m)
    const step = BABYLON.MeshBuilder.CreateBox(`step_${i}`, { width: 5.5, height: 0.4, depth: 0.8 }, scene);
    step.position.set(-10, 0.2 + 0.2 * i, 5 + 0.6 * i);
    step.checkCollisions = true;
    step.isPickable = true;
    step.receiveShadows = true;
    step.meshType = 'scalable';
    step.material = stairM;
    shadow.addShadowCaster(step);

    if (usePhysics) {
      new BABYLON.PhysicsAggregate(step, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.7, restitution: 0.1 }, scene);
    }
  }

  // ── POST PROCESSING ────────────────────────────────────
  const pp = new BABYLON.DefaultRenderingPipeline('pp', true, scene, [camera]);
  pp.fxaaEnabled = true;
  pp.imageProcessingEnabled = true;
  pp.imageProcessing.toneMappingEnabled = true;
  pp.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  pp.imageProcessing.contrast = 1.02;
  pp.imageProcessing.exposure = 0.98;
  pp.imageProcessing.vignetteEnabled = true;
  pp.imageProcessing.vignetteWeight = 2.5;
  pp.sharpenEnabled = true;
  pp.sharpenAmount = 0.02;
  pp.imageProcessing.vignetteColor = new BABYLON.Color4(0, 0, 0, 0);

  // ── LOAD CHARACTER ─────────────────────────────────────
  const { playerCapsule, animCtrl, charCtrl } = await loadCharacter(scene, shadow, camera, usePhysics);

  // Hook up HUD setting toggles dynamically via custom-hud.js
  if (typeof bindHUDControls === 'function') {
    bindHUDControls(charCtrl, camera, usePhysics);
  }

  setLoad(100, 'Ready!');
  setTimeout(hideLoad, 550);

  // babylon debug layer
  // scene.debugLayer.show().then(() => {
  //   const explorer = document.getElementById("scene-explorer-host");
  //   const inspector = document.getElementById("inspector-host");
  //   if (explorer) {
  //     explorer.style.zIndex = "9999";
  //     explorer.style.position = "fixed";
  //   }
  //   if (inspector) {
  //     inspector.style.zIndex = "9999";
  //     inspector.style.position = "fixed";
  //   }
  // });

  return scene;
}

// ═══════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════
createDemoScene()
  .then(scene => {
    engine.runRenderLoop(() => scene.render());
  })
  .catch(err => {
    console.error(err);
    $('bar-label').textContent = 'ERROR: ' + err.message;
    $('bar').style.background = '#f44';
  });

// ── WINDOW RESIZE CONTROLLER ──────────────────────────────
window.addEventListener('resize', () => engine.resize());
