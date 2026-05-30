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
async function loadCharacter(scene, shadow, camera) {
  setLoad(10, 'Loading character...');
  charRes = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'character_animated.glb', scene);
  setLoad(75, 'Retargeting bones...');

  // CHARACTER MESH SETUP
  charRoot = charRes.meshes[0];
  charRoot.name = 'Character_Visual';

  charRes.meshes.forEach(m => {
    shadow.addShadowCaster(m, true);
    m.receiveShadows = true;
    m.isPickable = false; // Disable pickability to avoid blocking raycasts
  });

  // Stop any auto-playing animations from character.glb
  charRes.animationGroups.forEach(ag => ag.stop());
  scene.animationGroups.forEach(ag => ag.stop());

  // ── CAPSULE COLLIDER STRUCTURE ─────────────────────────
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.35, height: 1.8 }, scene);
  playerCapsule.position.set(0, 4, 0); // Spawn slightly elevated
  playerCapsule.visibility = 0;
  playerCapsule.isPickable = false;
  playerCapsule.checkCollisions = true;
  playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);
  playerCapsule.ellipsoidOffset = new BABYLON.Vector3(0, 0, 0);

  // Parent the visual mesh to the capsule, offset Y so feet touch bottom (adjusted for collision padding)
  charRoot.setParent(playerCapsule);
  charRoot.position.set(0, -0.98, 0);
  charRoot.rotation.set(0, 0, 0);

  setLoad(90, 'Building controllers...');

  // ── CONTROLLERS ───────────────────────────────────────
  // Remove T-Pose animation group before building controller
  charRes.animationGroups
    .filter(ag => /t[\-_]?pose/i.test(ag.name))
    .forEach(ag => ag.dispose());
  const filteredGroups = charRes.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

  // Instantiate the controllers (using the clean Babylon AnimationGroup array directly!)
  const animCtrl = new AnimCtrl(filteredGroups, scene);
  const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene);


  // ── CAMERA FOLLOW ─────────────────────────────────────
  scene.registerBeforeRender(() => {
    const tgt = playerCapsule.position.add(V3(0, 0.4, 0)); // Capsule center + 0.4m offset = chest height (1.3m relative to feet)
    camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 0.12);
  });

  return { playerCapsule, animCtrl, charCtrl };
}

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

  // Enable Collisions
  scene.collisionsEnabled = true;

  // ── CAMERA ─────────────────────────────────────────────
  const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3.5, 8, V3(0, 1.2, 0), scene);
  camera.lowerRadiusLimit = 1.5;
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
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Optimize shadow map size for mobile devices
  const shadowSize = isMobile ? 512 : 1024;
  const shadow = new BABYLON.ShadowGenerator(shadowSize, sun);

  if (isIOS) {
    // iOS WebGL precision limits (mediump) cause severe shadow acne / striping with PCF.
    // Blurred Exponential Shadow Maps (ESM) provide beautiful soft shadows and are immune to precision-based acne.
    shadow.useBlurExponentialShadowMap = true;
    shadow.useKernelBlur = true;
    shadow.blurKernel = 16;
    shadow.blurScale = 2;
    shadow.depthScale = 25; // Controls the softness edge transition
    shadow.bias = 0.005;
  } else if (isMobile) {
    // Android/other mobile: use optimized medium quality PCF
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
    shadow.bias = 0.015;
    shadow.normalBias = 0.005;
  } else {
    // Desktop: high quality PCF
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_HIGH;
    shadow.bias = 0.01;
    shadow.normalBias = 0.002;
  }

  const colorBase = C3(0.57, 0.59, 0.52);
  // ── GROUND ─────────────────────────────────────────────
  const ground = BABYLON.MeshBuilder.CreateGround('gnd', { width: 80, height: 80, subdivisions: 4 }, scene);
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
  });

  // Platform (stage)
  const platform = BABYLON.MeshBuilder.CreateCylinder('platform', {
    diameter: 10, height: 0.12, tessellation: 32
  }, scene);
  platform.position.y = 0.01;
  platform.receiveShadows = true;
  platform.checkCollisions = true;
  platform.isPickable = true;
  const platM = new BABYLON.PBRMaterial('platM', scene);
  platM.albedoColor = colorBase;
  platM.roughness = rough;
  platform.material = platM;

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

  // 2. Flight of stairs — individual boxes with collision so visual matches physics exactly
  const stairM = new BABYLON.PBRMaterial("stairM", scene);
  stairM.albedoColor = colorBase;
  stairM.roughness = rough;
  const numSteps = 8;
  for (let i = 0; i < numSteps; i++) {
    const step = BABYLON.MeshBuilder.CreateBox(`step_${i}`, { width: 4, height: 0.2, depth: 0.45 }, scene);
    step.position.set(-10, 0.1 + 0.2 * i, 5 + 0.4 * i);
    step.checkCollisions = true;
    step.isPickable = true;
    step.receiveShadows = true;
    step.meshType = 'scalable';
    step.material = stairM;
    shadow.addShadowCaster(step);
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
  pp.sharpenAmount = 0.1;
  pp.imageProcessing.vignetteColor = new BABYLON.Color4(0, 0, 0, 0);

  // ── LOAD CHARACTER ─────────────────────────────────────
  const { playerCapsule, animCtrl, charCtrl } = await loadCharacter(scene, shadow, camera);

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

window.addEventListener('resize', () => engine.resize());
