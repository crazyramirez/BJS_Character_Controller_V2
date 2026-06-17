'use strict';

// ═══════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const V3 = (x = 0, y = 0, z = 0) => new BABYLON.Vector3(x, y, z);
const C3 = (r, g, b) => new BABYLON.Color3(r, g, b);
var charRoot, charRes;

function setLoad(pct, label) {
  const bar = $('bar');
  const lbl = $('bar-label');
  if (bar) bar.style.width = pct + '%';
  if (label && lbl) lbl.textContent = label;
}
function hideLoad() {
  const el = $('loading');
  if (el) {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 700);
  }
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
    // Integration Mode options:
    // Option A: Pre-merged GLB (Embedded animations, standard)
    filename: 'character_animated_1.glb',

    // Option B: Runtime Client Retargeting (Separate mesh and animation pack)
    // filename: 'character.glb',
    // animationsFilename: 'animations.glb',

    spawnPosition: new BABYLON.Vector3(0, 3, 0),
    ellipsoid: new BABYLON.Vector3(0.75, 0.96, 0.75)
  });
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

  // Physics mode: HUD/localStorage override takes priority.
  const usePhysics = await initPhysics(scene);

  // Enable Collisions
  scene.collisionsEnabled = true;

  // ── CAMERA ─────────────────────────────────────────────
  const isMobileCam = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const initialRadius = isMobileCam ? 5.2 : 8;
  const initialBeta = isMobileCam ? Math.PI / 3.0 : Math.PI / 3.5;

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

  const skybox = scene.createDefaultSkybox(envTex, true, 2000, 0.9);
  if (skybox && skybox.material) {
    skybox.material.fogEnabled = false;
  }

  // ── LIGHTS ─────────────────────────────────────────────
  const hemi = new BABYLON.HemisphericLight('hemi', V3(0, 1, 0), scene);
  hemi.intensity = 0.2;
  hemi.groundColor = C3(0.08, 0.08, 0.15);
  hemi.diffuse = C3(0.9, 0.95, 1.0);

  const sun = new BABYLON.DirectionalLight('sun', V3(-1, -2, -1).normalize(), scene);
  sun.position = V3(15, 25, 15);
  sun.intensity = 1.2;
  sun.diffuse = C3(1, 0.97, 0.9);
  sun.specular = C3(0.5, 0.5, 0.4);
  sun.autoCalcShadowZBounds = false;
  sun.autoUpdateExtends = false;
  sun.shadowMinZ = 5;
  sun.shadowMaxZ = 60;
  sun.shadowOrthoScale = 1.2;

  const fill = new BABYLON.PointLight('fill', V3(-8, 4, -4), scene);
  fill.intensity = 0.1;
  fill.diffuse = C3(0.4, 0.5, 1.0);

  // ── SHADOWS ────────────────────────────────────────────
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const shadowSize = 2048;
  const shadow = new BABYLON.ShadowGenerator(shadowSize, sun);

  if (isMobile) {
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
    shadow.bias = 0.005;
    shadow.normalBias = 0.001;
  } else {
    shadow.usePercentageCloserFiltering = true;
    shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_HIGH;
    shadow.bias = 0.01;
    shadow.normalBias = 0.002;
  }

  // ── LOAD BACKYARD SCENERY MODEL ────────────────────────
  setLoad(15, 'Loading backyard scenery...');
  const backyardRes = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'backyard_demo.glb', scene);

  // Set up collisions and physics aggregates for each static mesh in the GLB
  backyardRes.meshes.forEach(m => {
    if (m && m.getTotalVertices() > 0) {
      const name = m.name.toLowerCase();

      // Skip collisions and physics setup for small/decorative elements (foliage, small props, etc.)
      const isDecorative = /leaf|leaves|grass|flower|shrub|bush|detail|clutter|particle|light|camera|vegetation|flora|decor/i.test(name);

      m.receiveShadows = true;
      shadow.addShadowCaster(m);

      if (isDecorative) {
        m.checkCollisions = false;
        m.isPickable = false;
        return; // Skip physics aggregates and scalable marking for decorative items
      }

      m.checkCollisions = true;
      m.meshType = 'scalable';

      if (usePhysics) {
        // Create static mesh shape for Havok physics so the player can walk on custom scenery geometry
        new BABYLON.PhysicsAggregate(m, BABYLON.PhysicsShapeType.MESH, { mass: 0, friction: 0.1, restitution: 0.1 }, scene);
      }
    }
  });

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
  let charHandle = await loadCharacter(scene, shadow, camera, usePhysics);
  const { playerCapsule, animCtrl, charCtrl } = charHandle;

  // Hook up HUD setting toggles dynamically via custom-hud.js
  if (typeof bindHUDControls === 'function') {
    bindHUDControls(charCtrl, camera, usePhysics);
  }

  // ── RUNTIME CHARACTER SWAP ─────────────────────────────
  // Loads a different model (preset or external GLB) without reloading the page.
  async function switchCharacter(options) {
    if (typeof setLoad === 'function') setLoad(5, 'Loading character…');
    const merged = Object.assign({ shadow, assetsPath: 'assets/' }, options);
    charHandle = await loadCharacterRuntime(scene, camera, usePhysics, merged, charHandle);
    if (typeof bindHUDControls === 'function') {
      bindHUDControls(charHandle.charCtrl, camera, usePhysics);
    }
    if (typeof setLoad === 'function') setLoad(100, 'Ready!');
    return charHandle;
  }
  window.switchCharacter = switchCharacter;
  if (typeof bindCharacterSwapUI === 'function') {
    bindCharacterSwapUI(switchCharacter);
  }

  setLoad(100, 'Ready!');
  setTimeout(hideLoad, 550);

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

// ═══════════════════════════════════════════════════════════
// CHARACTER SWAP UI
// ═══════════════════════════════════════════════════════════
// Wires the #char-swap panel (preset dropdown + GLB import) to the
// switchCharacter() runtime loader created in the scene factory.
function bindCharacterSwapUI(switchCharacter) {
  const select = $('char-preset');
  const importBtn = $('char-import-btn');
  const fileInput = $('char-import-file');
  let busy = false;

  const run = async (fn) => {
    if (busy) return;
    busy = true;
    try { await fn(); }
    catch (e) { console.error('Character swap failed:', e); }
    finally { busy = false; }
  };

  select?.addEventListener('change', () => {
    run(() => switchCharacter({ assetsPath: 'assets/', filename: select.value }));
  });

  importBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    run(async () => {
      try { await switchCharacter({ glbUrl: url }); }
      finally { URL.revokeObjectURL(url); fileInput.value = ''; }
    });
  });
}
