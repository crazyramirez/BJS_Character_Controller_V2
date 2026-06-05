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
  setLoad(60, 'Loading character...');
  charRes = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'character_animated.glb', scene);
  setLoad(85, 'Retargeting bones...');

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
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.4, height: 1.8 }, scene);
  playerCapsule.position.set(0, 3, 0); // Spawn slightly elevated to fall onto backyard ground safely
  playerCapsule.visibility = 0;
  playerCapsule.isPickable = false;

  playerCapsule.checkCollisions = !usePhysics;
  playerCapsule.ellipsoid = new BABYLON.Vector3(0.75, 0.96, 0.75);
  playerCapsule.ellipsoidOffset = new BABYLON.Vector3(0, 0, 0);

  // Parent the visual mesh to the capsule, offset Y so feet touch bottom (adjusted for collision padding)
  charRoot.setParent(playerCapsule);
  charRoot.position.set(0, usePhysics ? -0.90 : -0.97, 0);
  charRoot.rotation.set(0, 0, 0);

  setLoad(95, 'Building controllers...');

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
  const isMobileDev = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cameraYOffset = isMobileDev ? -0.25 : 0.4;

  scene.registerBeforeRender(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const clampedDt = Math.max(0.001, Math.min(0.1, dt));
    const tgt = playerCapsule.position.add(V3(0, cameraYOffset, 0));
    // Frame-rate independent exponential interpolation (tracking rate of 15 for highly responsive follow)
    camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 1 - Math.exp(-15 * clampedDt));
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

  // Physics mode: HUD/localStorage override takes priority.
  const physicsOverride = localStorage.getItem('use-physics');
  let usePhysics = false;

  if (physicsOverride === 'false') {
    usePhysics = false;
  } else if (physicsOverride === 'true') {
    try {
      const havokInstance = await HavokPhysics();
      const hk = new BABYLON.HavokPlugin(true, havokInstance);
      scene.enablePhysics(new BABYLON.Vector3(0, -22, 0), hk);
      usePhysics = true;
    } catch (e) {
      console.warn('[Physics] Havok forced but failed to load — falling back to kinematic.', e);
      localStorage.removeItem('use-physics');
      usePhysics = false;
    }
  } else {
    try {
      const havokInstance = await HavokPhysics();
      const hk = new BABYLON.HavokPlugin(true, havokInstance);
      scene.enablePhysics(new BABYLON.Vector3(0, -22, 0), hk);
      usePhysics = true;
    } catch (e) {
      console.info('[Physics] Havok unavailable — using kinematic mode.', e);
      usePhysics = false;
    }
  }

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
  const { playerCapsule, animCtrl, charCtrl } = await loadCharacter(scene, shadow, camera, usePhysics);

  // Hook up HUD setting toggles dynamically
  const togglePhysics = $('toggle-physics');
  if (togglePhysics) {
    togglePhysics.checked = usePhysics;
    togglePhysics.addEventListener('change', (e) => {
      localStorage.setItem('use-physics', e.target.checked);
      window.location.reload();
    });
  }

  const toggleCamLock = $('toggle-cam-lock');
  if (toggleCamLock) {
    toggleCamLock.checked = charCtrl.CAM_FOLLOW_LOCK;
    toggleCamLock.addEventListener('change', (e) => {
      charCtrl.CAM_FOLLOW_LOCK = e.target.checked;
      localStorage.setItem('cam-follow-lock', e.target.checked);
    });
  }

  const toggleDynamicFov = $('toggle-dynamic-fov');
  const sliderFovMax = $('slider-fov-max');
  const fovMaxVal = $('fov-max-val');

  if (toggleDynamicFov) {
    toggleDynamicFov.checked = charCtrl.DYNAMIC_FOV;
    toggleDynamicFov.addEventListener('change', (e) => {
      charCtrl.DYNAMIC_FOV = e.target.checked;
      localStorage.setItem('dynamic-fov', e.target.checked);
    });
  }

  const toggleDoubleJump = $('toggle-double-jump');
  if (toggleDoubleJump) {
    toggleDoubleJump.checked = charCtrl.DOUBLE_JUMP_ENABLED;
    toggleDoubleJump.addEventListener('change', (e) => {
      charCtrl.DOUBLE_JUMP_ENABLED = e.target.checked;
      localStorage.setItem('double-jump-enabled', e.target.checked);
    });
  }

  const toggleAirControl = $('toggle-air-control');
  if (toggleAirControl) {
    toggleAirControl.checked = charCtrl.AIR_CONTROL;
    toggleAirControl.addEventListener('change', (e) => {
      charCtrl.AIR_CONTROL = e.target.checked;
      localStorage.setItem('air-control-enabled', e.target.checked);
    });
  }

  const toggleCamLockPitch = $('toggle-cam-lock-pitch');
  if (toggleCamLockPitch) {
    toggleCamLockPitch.checked = charCtrl.CAM_LOCK_PITCH;
    toggleCamLockPitch.addEventListener('change', (e) => {
      charCtrl.CAM_LOCK_PITCH = e.target.checked;
      localStorage.setItem('cam-lock-pitch', e.target.checked);
    });
  }

  const toggleJoystickLockX = $('toggle-joystick-lock-x');
  if (toggleJoystickLockX) {
    toggleJoystickLockX.checked = charCtrl.JOYSTICK_LOCK_X;
    toggleJoystickLockX.addEventListener('change', (e) => {
      charCtrl.JOYSTICK_LOCK_X = e.target.checked;
      localStorage.setItem('joystick-lock-x', e.target.checked);
    });
  }

  if (sliderFovMax && fovMaxVal) {
    sliderFovMax.value = charCtrl.DYNAMIC_FOV_MAX;
    fovMaxVal.textContent = charCtrl.DYNAMIC_FOV_MAX.toFixed(2);
    sliderFovMax.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      charCtrl.DYNAMIC_FOV_MAX = val;
      fovMaxVal.textContent = val.toFixed(2);
      localStorage.setItem('dynamic-fov-max', val);
    });
  }

  const sliderCamPitch = $('slider-cam-pitch');
  const camPitchVal = $('cam-pitch-val');
  if (sliderCamPitch && camPitchVal) {
    const initialDeg = Math.round(charCtrl.CAM_FOLLOW_PITCH * 180 / Math.PI);
    sliderCamPitch.value = initialDeg;
    camPitchVal.textContent = initialDeg + '°';
    sliderCamPitch.addEventListener('input', (e) => {
      const deg = parseInt(e.target.value);
      const rad = deg * Math.PI / 180;
      charCtrl.CAM_FOLLOW_PITCH = rad;
      camPitchVal.textContent = deg + '°';
      localStorage.setItem('cam-follow-pitch', rad);
    });
  }

  const sliderCamDist = $('slider-cam-dist');
  const camDistVal = $('cam-dist-val');
  if (sliderCamDist && camDistVal) {
    sliderCamDist.value = charCtrl.CAM_FOLLOW_DIST;
    camDistVal.textContent = charCtrl.CAM_FOLLOW_DIST.toFixed(1) + 'm';
    sliderCamDist.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      charCtrl.CAM_FOLLOW_DIST = val;
      camDistVal.textContent = val.toFixed(1) + 'm';
      localStorage.setItem('cam-follow-dist', val);
      if (charCtrl.CAM_FOLLOW_LOCK) {
        camera.radius = val;
      }
    });
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

// ── HUD COLLAPSE CONTROLLER ──────────────────────────────
const hud = $('hud');
const toggle = $('hud-toggle');
if (toggle && hud) {
  const isCollapsed = localStorage.getItem('hud-collapsed') === 'true';
  if (isCollapsed) {
    hud.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    hud.classList.toggle('collapsed');
    localStorage.setItem('hud-collapsed', hud.classList.contains('collapsed'));
  });
}

window.addEventListener('resize', () => engine.resize());

// ── HUD FOCUS RELEASE (BLUR) CONTROLLER ──────────────────
const interactiveElements = document.querySelectorAll('#hud input, #hud button, #hud-toggle, #hud a');
interactiveElements.forEach(el => {
  const releaseFocus = () => {
    el.blur();
    const canvasEl = $('c');
    if (canvasEl) canvasEl.focus();
  };
  el.addEventListener('click', releaseFocus);
  el.addEventListener('change', releaseFocus);
  el.addEventListener('input', releaseFocus);
});
