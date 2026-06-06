'use strict';

// ═══════════════════════════════════════════════════════════
// GLOBAL STATE & CONSTANTS
// ═══════════════════════════════════════════════════════════
let engine, scene, camera, shadowGenerator;
let activeCharacter = null; // { playerCapsule, animCtrl, charCtrl, rawAnimationGroups, rawMeshes, charRoot }
let detectedAnimations = []; // List of string names
let isPhysicsEnabled = true;

// Standard anim controller keys
const STANDARD_ANIM_KEYS = [
  { key: 'Idle_Loop', label: 'Idle Loop', defaultKeyword: /^(?!.*crouch).*idle/i },
  { key: 'Walk_Loop', label: 'Walk Loop', defaultKeyword: /^(?!.*crouch)(?!.*formal).*walk/i },
  { key: 'Sprint_Loop', label: 'Sprint / Run Loop', defaultKeyword: /^(?!.*crouch).*(sprint|run)/i },
  { key: 'Crouch_Idle_Loop', label: 'Crouch Idle Loop', defaultKeyword: /crouch.*idle/i },
  { key: 'Crouch_Fwd_Loop', label: 'Crouch Forward Loop', defaultKeyword: /crouch.*(walk|fwd)/i },
  { key: 'Jump_Start', label: 'Jump Takeoff', defaultKeyword: /jump.*(start|takeoff|up)/i },
  { key: 'Jump_Loop', label: 'Jump Mid-Air Loop', defaultKeyword: /jump.*(loop|mid|air)/i },
  { key: 'Jump_Land', label: 'Jump Land', defaultKeyword: /jump.*(land|ground)/i },
  { key: 'Roll', label: 'Dodge Roll', defaultKeyword: /roll/i },
  { key: 'Punch_Jab', label: 'Punch Jab', defaultKeyword: /jab/i },
  { key: 'Punch_Cross', label: 'Punch Cross', defaultKeyword: /cross/i },
  { key: 'Spell_Simple_Enter', label: 'Spell Enter', defaultKeyword: /spell.*enter/i },
  { key: 'Spell_Simple_Shoot', label: 'Spell Shoot / Cast', defaultKeyword: /spell.*(shoot|cast)/i },
  { key: 'Spell_Simple_Exit', label: 'Spell Exit', defaultKeyword: /spell.*exit/i },
  { key: 'Interact', label: 'Interact / Pick up', defaultKeyword: /interact/i }
];

// Current remappings: key -> { animName: string, from: number, to: number }
let animMappings = {};

// Key Bindings state
let keyBindings = {
  MOVE_FORWARD: ['KeyW', 'ArrowUp'],
  MOVE_BACKWARD: ['KeyS', 'ArrowDown'],
  MOVE_LEFT: ['KeyA', 'ArrowLeft'],
  MOVE_RIGHT: ['KeyD', 'ArrowRight'],
  SPRINT: ['ShiftLeft', 'ShiftRight'],
  CROUCH: ['ControlLeft', 'ControlRight', 'KeyC'],
  JUMP: ['Space'],
  ROLL: ['KeyR'],
  PUNCH: ['KeyQ'],
  SPELL: ['KeyE'],
  INTERACT: ['KeyF']
};

// Physics config state
let physicsConfig = {
  GRAV: 22,
  JUMP_PWR: 9.5,
  SPD_WALK: 2.5,
  SPD_JOG: 3.0,
  SPD_SPRINT: 5.0,
  SPD_CROUCH: 2.0,
  SPD_CROUCH_RUN: 3.2,
  ACCEL: 14,
  DECEL: 16,
  ROT_SPD: 40,
  AIR_CONTROL: false,
  DYNAMIC_FOV: true,
  DYNAMIC_FOV_MAX: 0.10,
  CAM_FOLLOW_LOCK: false,
  CAM_FOLLOW_PITCH: 1.047,
  CAM_FOLLOW_DIST: 8.0,
  CAM_LOCK_PITCH: false,
  JOYSTICK_LOCK_X: false,
  DOUBLE_JUMP_ENABLED: true,
  SPEED_MULTIPLIER: 1.0
};

let customAnimations = []; // array of { name: string, animName: string, keyTrigger: string[] }

// Backups of original defaults for resetting
const DEFAULT_KEY_BINDINGS = JSON.parse(JSON.stringify(keyBindings));
const DEFAULT_PHYSICS_CONFIG = JSON.parse(JSON.stringify(physicsConfig));

let savedAnimMappings = null;

function loadPreferences() {
  try {
    const mappings = localStorage.getItem('builder_anim_mappings');
    if (mappings) savedAnimMappings = JSON.parse(mappings);

    const keys = localStorage.getItem('builder_key_bindings');
    if (keys) keyBindings = JSON.parse(keys);

    const physics = localStorage.getItem('builder_physics_config');
    if (physics) physicsConfig = JSON.parse(physics);

    const customs = localStorage.getItem('builder_custom_animations');
    if (customs) customAnimations = JSON.parse(customs);
  } catch (e) {
    console.error("Failed to load preferences from localStorage", e);
  }
}

function savePreferences() {
  try {
    localStorage.setItem('builder_anim_mappings', JSON.stringify(animMappings));
    localStorage.setItem('builder_key_bindings', JSON.stringify(keyBindings));
    localStorage.setItem('builder_physics_config', JSON.stringify(physicsConfig));
    localStorage.setItem('builder_custom_animations', JSON.stringify(customAnimations));
  } catch (e) {
    console.error("Failed to save preferences to localStorage", e);
  }
}

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  loadPreferences();
  setupTabs();
  initBabylonScene();
  setupSidebarControls();
  syncPhysicsConfigToUI();
  setupDragAndDrop();

  // Patch CharCtrl to support custom triggers in preview sandbox
  if (typeof CharCtrl !== 'undefined') {
    // Prevent character movement and actions while typing in dashboard inputs
    const originalIsPressed = CharCtrl.prototype._isPressed;
    CharCtrl.prototype._isPressed = function (action) {
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.tagName === 'TEXTAREA'
      );
      if (isTyping || activeCatcherAction !== null) {
        return false;
      }
      return originalIsPressed.call(this, action);
    };

    const originalKeyDown = CharCtrl.prototype._keyDown;
    CharCtrl.prototype._keyDown = function (code) {
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.tagName === 'TEXTAREA'
      );
      if (isTyping || activeCatcherAction !== null) {
        this.keys = {}; // Clear keys to prevent character sliding
        return;
      }

      const inAction = window.ACTION_STATES.has(this.state);
      if (!inAction && !this.sitting) {
        // Search custom actions
        for (let cust of customAnimations) {
          if (cust.name && cust.animName !== 'None' && this._matchesAction(code, cust.name)) {
            this._setState(cust.name);
            this.anim.play(cust.name, false, 0.25, () => {
              this._setState(window.S.IDLE);
              this._returnToLoco();
            }, 1.0);
            return;
          }
        }
      }
      originalKeyDown.call(this, code);
    };
  }

  // Load default character from assets on startup
  loadDefaultCharacter();
});

// Tab management
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPanel = document.getElementById(`panel-${tab.dataset.tab}`);
      if (targetPanel) targetPanel.classList.add('active');
    });
  });
}

function syncPhysicsConfigToUI() {
  const setSlider = (id, val, suffix = '') => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    if (el) el.value = val;
    if (valEl) valEl.textContent = val + suffix;
  };
  const setCheckbox = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  };

  setSlider('slider-grav', physicsConfig.GRAV);
  setSlider('slider-jump-pwr', physicsConfig.JUMP_PWR);
  setSlider('slider-speed-walk', physicsConfig.SPD_WALK);
  setSlider('slider-speed-sprint', physicsConfig.SPD_SPRINT);
  setSlider('slider-accel', physicsConfig.ACCEL);
  setSlider('slider-decel', physicsConfig.DECEL);
  setSlider('slider-rot', physicsConfig.ROT_SPD);
  setSlider('slider-speed-mult', physicsConfig.SPEED_MULTIPLIER, 'x');
  setSlider('slider-cam-dist', physicsConfig.CAM_FOLLOW_DIST, 'm');
  setSlider('slider-fov-max', physicsConfig.DYNAMIC_FOV_MAX);

  const pitchDeg = Math.round(physicsConfig.CAM_FOLLOW_PITCH * 180 / Math.PI);
  setSlider('slider-cam-pitch', pitchDeg, '°');

  setCheckbox('toggle-cam-follow-lock', physicsConfig.CAM_FOLLOW_LOCK);
  setCheckbox('toggle-cam-lock-pitch', physicsConfig.CAM_LOCK_PITCH);
  setCheckbox('toggle-joystick-lock-x', physicsConfig.JOYSTICK_LOCK_X);
  setCheckbox('toggle-dynamic-fov', physicsConfig.DYNAMIC_FOV);
  setCheckbox('toggle-double-jump', physicsConfig.DOUBLE_JUMP_ENABLED);
  setCheckbox('toggle-air-control', physicsConfig.AIR_CONTROL);
}

// ═══════════════════════════════════════════════════════════
// BABYLON SCENE SETUP
// ═══════════════════════════════════════════════════════════
async function initBabylonScene() {
  const canvas = document.getElementById('c');
  engine = new BABYLON.Engine(canvas, true);

  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.04, 0.09, 1);
  scene.gravity = new BABYLON.Vector3(0, -9.8, 0);
  scene.collisionsEnabled = true;

  // Camera
  camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3.5, 8, new BABYLON.Vector3(0, 1.2, 0), scene);
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 20;
  camera.lowerBetaLimit = 0.05;
  camera.upperBetaLimit = Math.PI / 2.05;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

  // Lighting & Environment
  const envTex = BABYLON.CubeTexture.CreateFromPrefilteredData("assets/environment_2.env", scene);
  scene.environmentTexture = envTex;
  scene.environmentIntensity = 1.0;

  // Skybox for premium depth and lighting
  const skybox = scene.createDefaultSkybox(envTex, true, 1000, 0.7);
  if (skybox && skybox.material) {
    skybox.material.fogEnabled = false;
  }

  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.2;
  hemi.groundColor = new BABYLON.Color3(0.08, 0.08, 0.15);

  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-1, -2, -1).normalize(), scene);
  sun.position = new BABYLON.Vector3(15, 25, 15);
  sun.intensity = 0.8;

  shadowGenerator = new BABYLON.ShadowGenerator(1024, sun);
  shadowGenerator.usePercentageCloserFiltering = true;
  shadowGenerator.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;

  // Ground
  const ground = BABYLON.MeshBuilder.CreateBox('ground', { width: 50, height: 1.0, depth: 50 }, scene);
  ground.position.y = -0.5;
  ground.receiveShadows = true;
  ground.checkCollisions = true;
  const gndMat = new BABYLON.PBRMaterial('gndMat', scene);
  gndMat.albedoColor = new BABYLON.Color3(0.12, 0.12, 0.18);
  gndMat.roughness = 0.9;
  gndMat.metallic = 0.1;
  ground.material = gndMat;

  // Test props
  const propMat = new BABYLON.PBRMaterial('propMat', scene);
  propMat.albedoColor = new BABYLON.Color3(0.25, 0.2, 0.35);
  propMat.roughness = 0.7;

  // Platform
  const platform = BABYLON.MeshBuilder.CreateCylinder('platform', { diameter: 6, height: 0.5 }, scene);
  platform.position.set(5, 0.25, 5);
  platform.checkCollisions = true;
  platform.material = propMat;
  shadowGenerator.addShadowCaster(platform);

  // Ramp
  const ramp = BABYLON.MeshBuilder.CreateBox('ramp', { width: 3, height: 0.3, depth: 6 }, scene);
  ramp.position.set(-6, 0.5, 4);
  ramp.rotation.x = Math.PI / 10;
  ramp.checkCollisions = true;
  ramp.material = propMat;
  shadowGenerator.addShadowCaster(ramp);

  // Stairs
  for (let i = 0; i < 5; i++) {
    const step = BABYLON.MeshBuilder.CreateBox(`step_${i}`, { width: 3, height: 0.2, depth: 0.5 }, scene);
    step.position.set(0, 0.1 + 0.2 * i, -5 + 0.4 * i);
    step.checkCollisions = true;
    step.material = propMat;
    shadowGenerator.addShadowCaster(step);
  }

  // Render loop
  engine.runRenderLoop(() => {
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());
}

// ═══════════════════════════════════════════════════════════
// FILE LOADING & RETARGETING
// ═══════════════════════════════════════════════════════════
function showLoading(msg) {
  const el = document.getElementById('loading-overlay');
  const txt = el.querySelector('.loading-text');
  txt.textContent = msg;
  el.classList.add('visible');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('visible');
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast';
  if (isError) toast.classList.add('error');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// Default Character from local directory assets/character_animated.glb
async function loadDefaultCharacter() {
  showLoading("Loading default character...");
  try {
    const response = await fetch('assets/character_animated.glb');
    if (!response.ok) throw new Error("Assets character GLB not found.");
    const blob = await response.blob();
    const file = new File([blob], "character_animated.glb");
    await loadGlbFile(file);
  } catch (e) {
    console.warn("Could not load assets/character_animated.glb, waiting for user import.", e);
    hideLoading();
  }
}

async function loadGlbFile(file) {
  showLoading(`Importing ${file.name}...`);

  try {
    const reader = new FileReader();
    reader.onload = async function (event) {
      const arrayBuffer = event.target.result;
      const blob = new Blob([arrayBuffer]);
      const blobUrl = URL.createObjectURL(blob);

      // Clean up existing character
      if (activeCharacter) {
        if (activeCharacter.charCtrl._updateObserver) {
          scene.onBeforeRenderObservable.remove(activeCharacter.charCtrl._updateObserver);
        }
        if (activeCharacter.charCtrl._cameraLockObserver) {
          scene.onBeforeCameraRenderObservable.remove(activeCharacter.charCtrl._cameraLockObserver);
        }
        activeCharacter.playerCapsule.dispose();
        activeCharacter.animCtrl.destroy();
      }

      // Load model
      const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', '', blobUrl, scene, null, '.glb');
      const charRoot = charRes.meshes[0];
      charRoot.name = 'Character_Visual_builder';

      charRes.meshes.forEach(m => {
        shadowGenerator.addShadowCaster(m, true);
        m.receiveShadows = true;
        m.isPickable = false;
      });

      // Stop automatic animations
      charRes.animationGroups.forEach(ag => ag.stop());

      // Filter animation groups (excluding T-Pose)
      charRes.animationGroups
        .filter(ag => /t[\-_]?pose/i.test(ag.name))
        .forEach(ag => ag.dispose());

      const filteredGroups = charRes.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

      // Save detected animations list
      detectedAnimations = filteredGroups.map(ag => {
        // clean up name armature|name -> name
        const parts = ag.name.split('|');
        return parts[parts.length - 1].trim();
      });

      // Capsule Collider
      const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsulebuilder', { radius: 0.4, height: 1.8 }, scene);
      playerCapsule.position.set(0, 4, 0);
      playerCapsule.visibility = 0;
      playerCapsule.isPickable = false;
      playerCapsule.checkCollisions = true;
      playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);

      charRoot.setParent(playerCapsule);
      charRoot.position.set(0, -0.97, 0);
      charRoot.rotation.set(0, 0, 0);

      // Instantiating controller structures
      const animCtrl = new AnimCtrl(filteredGroups, scene);
      const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, {
        usePhysics: false, // Kinematic for testing stability in preview
        keys: keyBindings,
        config: physicsConfig
      });

      activeCharacter = {
        playerCapsule,
        animCtrl,
        charCtrl,
        rawAnimationGroups: filteredGroups,
        rawMeshes: charRes.meshes,
        charRoot
      };

      // Set camera follow focus and trigger initial step upon landing
      let hasMadeInitialWalk = false;
      scene.registerBeforeRender(() => {
        if (!activeCharacter) return;
        const tgt = activeCharacter.playerCapsule.position.add(new BABYLON.Vector3(0, 0.4, 0));
        camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 0.1);

        // Simulated steps once the character falls and touches the ground
        if (activeCharacter.charCtrl.grounded && !hasMadeInitialWalk) {
          hasMadeInitialWalk = true;
          setTimeout(() => {
            if (activeCharacter && activeCharacter.charCtrl) {
              activeCharacter.charCtrl.keys['KeyW'] = true;
              setTimeout(() => {
                if (activeCharacter && activeCharacter.charCtrl) {
                  activeCharacter.charCtrl.keys['KeyW'] = false;
                }
              }, 100);
            }
          }, 150);
        }
      });

      // Set HUD state observers
      charCtrl.callbacks.onStateChange = (state) => {
        document.getElementById('hud-state').textContent = state;
      };
      charCtrl.callbacks.onSpeedChange = (spd) => {
        document.getElementById('hud-speed').textContent = spd.toFixed(2) + ' m/s';
      };

      // Update UI panels with detected animations
      autoMapAnimations();
      renderAnimationsMappingTab();
      renderCustomAnimationsTab();
      updateExportCode();

      hideLoading();
      showToast("Model imported and set up successfully!");
    };

    reader.readAsArrayBuffer(file);
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast("Failed to load model: " + err.message, true);
  }
}

// Auto map animations matching keywords
function autoMapAnimations() {
  const previousMappings = savedAnimMappings || animMappings || {};
  animMappings = {};
  STANDARD_ANIM_KEYS.forEach(stdKey => {
    // If there is a saved mapping and the target animation name exists in the model, keep it
    if (previousMappings[stdKey.key] && 
        (previousMappings[stdKey.key].animName === 'None' || detectedAnimations.includes(previousMappings[stdKey.key].animName))) {
      animMappings[stdKey.key] = { ...previousMappings[stdKey.key] };
      return;
    }

    let bestMatch = 'None';
    let from = 0;
    let to = 100;

    // Check if we can auto-match by name
    for (let detName of detectedAnimations) {
      if (stdKey.defaultKeyword.test(detName)) {
        bestMatch = detName;
        // Find corresponding group to fetch frames
        const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === detName);
        if (group) {
          from = Math.round(group.from || 0);
          to = Math.round(group.to || 100);
        }
        break;
      }
    }

    // If not found, use first animation if available
    if (bestMatch === 'None' && detectedAnimations.length > 0) {
      bestMatch = detectedAnimations[0];
      const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === bestMatch);
      if (group) {
        from = Math.round(group.from || 0);
        to = Math.round(group.to || 100);
      }
    }

    animMappings[stdKey.key] = { animName: bestMatch, from, to };
  });

  console.log("Detected Animations:", detectedAnimations);
  console.log("Anim Mappings:", JSON.stringify(animMappings, null, 2));

  applyAnimationsToController();
}

function applyAnimationsToController() {
  if (!activeCharacter) return;

  // Apply mappings to AnimCtrl
  STANDARD_ANIM_KEYS.forEach(stdKey => {
    const mapping = animMappings[stdKey.key];
    if (mapping && mapping.animName !== 'None') {
      const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === mapping.animName);
      if (group) {
        activeCharacter.animCtrl.setAnimation(stdKey.key, group);
        activeCharacter.animCtrl.setAnimationRanges(stdKey.key, mapping.from, mapping.to);
      }
    }
  });

  // Apply custom animations
  customAnimations.forEach(cust => {
    if (cust.animName !== 'None' && cust.name) {
      const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === cust.animName);
      if (group) {
        // Register in AnimCtrl
        activeCharacter.animCtrl.setAnimation(cust.name, group);

        // Register key bindings in CharCtrl
        if (cust.keyTrigger.length > 0) {
          activeCharacter.charCtrl.keyBindings[cust.name] = cust.keyTrigger;
        }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
// UI RENDERING & MAPPING HANDLERS
// ═══════════════════════════════════════════════════════════
function renderAnimationsMappingTab() {
  const container = document.getElementById('animations-mapping-list');
  container.innerHTML = '';

  if (detectedAnimations.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 20px;">No animations found. Please load a character first.</p>`;
    return;
  }

  STANDARD_ANIM_KEYS.forEach(stdKey => {
    const mapping = animMappings[stdKey.key] || { animName: 'None', from: 0, to: 100 };

    const row = document.createElement('div');
    row.className = 'mapping-row';

    // Dropdown options
    let optionsHtml = `<option value="None">None</option>`;
    detectedAnimations.forEach(det => {
      const selected = det === mapping.animName ? 'selected' : '';
      optionsHtml += `<option value="${det}" ${selected}>${det}</option>`;
    });

    row.innerHTML = `
      <div class="mapping-row-header">
        <span class="mapping-label">${stdKey.label}</span>
        <button class="btn-reset-single" data-anim-key="${stdKey.key}" title="Auto-map default">↺</button>
      </div>
      <div class="mapping-fields">
        <select data-key="${stdKey.key}" class="mapping-select">
          ${optionsHtml}
        </select>
        <input type="number" class="frame-input frame-from" data-key="${stdKey.key}" placeholder="From" value="${mapping.from}">
        <input type="number" class="frame-input frame-to" data-key="${stdKey.key}" placeholder="To" value="${mapping.to}">
      </div>
    `;

    container.appendChild(row);
  });

  // Bind events
  container.querySelectorAll('.mapping-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      const animName = e.target.value;
      animMappings[key].animName = animName;

      // Auto populate frames from selection
      if (animName !== 'None') {
        const group = activeCharacter.rawAnimationGroups.find(g => g.name.endsWith(animName) || g.name === animName);
        if (group) {
          animMappings[key].from = Math.round(group.from);
          animMappings[key].to = Math.round(group.to);

          const row = e.target.closest('.mapping-row');
          row.querySelector('.frame-from').value = animMappings[key].from;
          row.querySelector('.frame-to').value = animMappings[key].to;
        }
      }
      applyAnimationsToController();
      updateExportCode();
    });
  });

  container.querySelectorAll('.frame-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      const val = parseInt(e.target.value) || 0;
      if (e.target.classList.contains('frame-from')) {
        animMappings[key].from = val;
      } else {
        animMappings[key].to = val;
      }
      applyAnimationsToController();
      updateExportCode();
    });
  });

  container.querySelectorAll('.btn-reset-single[data-anim-key]').forEach(btn => {
    btn.addEventListener('click', () => resetSingleAnimMapping(btn.dataset.animKey));
  });
}

function resetSingleAnimMapping(key) {
  if (!activeCharacter) return;
  const stdKey = STANDARD_ANIM_KEYS.find(s => s.key === key);
  if (!stdKey) return;

  let bestMatch = 'None';
  let from = 0, to = 100;
  for (const detName of detectedAnimations) {
    if (stdKey.defaultKeyword.test(detName)) {
      bestMatch = detName;
      const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === detName);
      if (group) { from = Math.round(group.from || 0); to = Math.round(group.to || 100); }
      break;
    }
  }
  animMappings[key] = { animName: bestMatch, from, to };
  applyAnimationsToController();
  renderAnimationsMappingTab();
  updateExportCode();
}

function renderCustomAnimationsTab() {
  const container = document.getElementById('custom-animations-list');
  container.innerHTML = '';

  customAnimations.forEach((cust, index) => {
    const row = document.createElement('div');
    row.className = 'mapping-row custom-anim-row';

    let optionsHtml = `<option value="None">None</option>`;
    detectedAnimations.forEach(det => {
      const selected = det === cust.animName ? 'selected' : '';
      optionsHtml += `<option value="${det}" ${selected}>${det}</option>`;
    });

    row.innerHTML = `
      <div class="mapping-row-header">
        <input type="text" class="custom-name-input" data-index="${index}" value="${cust.name}" placeholder="Action Name (e.g. WAVE)">
        <button class="btn-delete" data-index="${index}">Delete</button>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        <select class="custom-select-anim" data-index="${index}">
          ${optionsHtml}
        </select>
        <div class="key-catcher" data-action="CUSTOM_${index}">
          <div class="key-tags">
            ${cust.keyTrigger.map(k => `<span class="key-tag">${k}<span class="remove-key" data-key="${k}" data-action="CUSTOM_${index}">×</span></span>`).join('')}
            ${cust.keyTrigger.length === 0 ? `<span class="key-catcher-placeholder">Assign Trigger Key</span>` : ''}
          </div>
          <span class="key-catcher-status">Press any key...</span>
        </div>
      </div>
    `;

    container.appendChild(row);
  });

  // Bind custom events
  container.querySelectorAll('.custom-name-input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations[index].name = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
      e.target.value = customAnimations[index].name;
      applyAnimationsToController();
      updateExportCode();
    });
  });

  container.querySelectorAll('.custom-select-anim').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations[index].animName = e.target.value;
      applyAnimationsToController();
      updateExportCode();
    });
  });

  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations.splice(index, 1);
      renderCustomAnimationsTab();
      applyAnimationsToController();
      updateExportCode();
    });
  });

  bindKeyCatcherEvents();
}

function setupSidebarControls() {
  // Bind Physics Sliders
  const bindSlider = (id, configKey, isFloat = true) => {
    const slider = document.getElementById(id);
    const valSpan = document.getElementById(`${id}-val`);
    if (!slider) return;

    slider.addEventListener('input', (e) => {
      const val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value);
      physicsConfig[configKey] = val;
      if (valSpan) valSpan.textContent = val;

      // Apply to running controller dynamically
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl[configKey] = val;
      }
      updateExportCode();
    });
  };

  bindSlider('slider-grav', 'GRAV');
  bindSlider('slider-jump-pwr', 'JUMP_PWR');
  bindSlider('slider-speed-walk', 'SPD_WALK');
  bindSlider('slider-speed-sprint', 'SPD_SPRINT');
  bindSlider('slider-accel', 'ACCEL');
  bindSlider('slider-decel', 'DECEL');
  bindSlider('slider-rot', 'ROT_SPD');
  bindSlider('slider-speed-mult', 'SPEED_MULTIPLIER');
  bindSlider('slider-cam-dist', 'CAM_FOLLOW_DIST');
  bindSlider('slider-fov-max', 'DYNAMIC_FOV_MAX');

  const camPitchSlider = document.getElementById('slider-cam-pitch');
  const camPitchVal = document.getElementById('slider-cam-pitch-val');
  if (camPitchSlider) {
    camPitchSlider.addEventListener('input', (e) => {
      const deg = parseInt(e.target.value);
      const rad = deg * Math.PI / 180;
      physicsConfig.CAM_FOLLOW_PITCH = rad;
      if (camPitchVal) camPitchVal.textContent = deg + '°';
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl.CAM_FOLLOW_PITCH = rad;
      }
      updateExportCode();
    });
  }

  const bindCheckbox = (id, configKey) => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.addEventListener('change', (e) => {
      const val = e.target.checked;
      physicsConfig[configKey] = val;
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl[configKey] = val;
      }
      updateExportCode();
    });
  };

  bindCheckbox('toggle-cam-follow-lock', 'CAM_FOLLOW_LOCK');
  bindCheckbox('toggle-cam-lock-pitch', 'CAM_LOCK_PITCH');
  bindCheckbox('toggle-joystick-lock-x', 'JOYSTICK_LOCK_X');
  bindCheckbox('toggle-dynamic-fov', 'DYNAMIC_FOV');
  bindCheckbox('toggle-double-jump', 'DOUBLE_JUMP_ENABLED');
  bindCheckbox('toggle-air-control', 'AIR_CONTROL');

  // Bind add custom animation
  document.getElementById('btn-add-custom-anim').addEventListener('click', () => {
    customAnimations.push({
      name: 'CUSTOM_ACTION_' + (customAnimations.length + 1),
      animName: detectedAnimations[0] || 'None',
      keyTrigger: []
    });
    renderCustomAnimationsTab();
  });

  // Bind Download Button
  document.getElementById('btn-download').addEventListener('click', downloadControllerFile);

  // Bind Copy Code Button
  const btnCopy = document.getElementById('btn-copy-code');
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      const codeBox = document.getElementById('export-code');
      if (codeBox) {
        codeBox.select();
        codeBox.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(codeBox.value).then(() => {
          showToast("Code configuration copied to clipboard!");
        }).catch(err => {
          console.error("Could not copy text: ", err);
          showToast("Failed to copy code.", true);
        });
      }
    });
  }

  // Bind Reset All Button
  const btnReset = document.getElementById('btn-reset-all');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      // Clear localStorage
      localStorage.removeItem('builder_anim_mappings');
      localStorage.removeItem('builder_key_bindings');
      localStorage.removeItem('builder_physics_config');
      localStorage.removeItem('builder_custom_animations');

      // Reset state
      savedAnimMappings = null;
      keyBindings = JSON.parse(JSON.stringify(DEFAULT_KEY_BINDINGS));
      physicsConfig = JSON.parse(JSON.stringify(DEFAULT_PHYSICS_CONFIG));
      customAnimations = [];

      // Re-apply mappings and controls
      autoMapAnimations();
      renderAnimationsMappingTab();
      renderCustomAnimationsTab();
      renderKeyBindingsUI();
      syncPhysicsConfigToUI();

      // Apply to running controller dynamically
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl.keyBindings = keyBindings;
        Object.keys(physicsConfig).forEach(key => {
          activeCharacter.charCtrl[key] = physicsConfig[key];
        });
      }

      updateExportCode();
      showToast("All configurations reset to defaults!");
    });
  }

  // Bind key catch events for standard keys
  renderKeyBindingsUI();

  injectPhysicsResetButtons();
}

function injectPhysicsResetButtons() {
  const makeBtn = (onClick) => {
    const btn = document.createElement('button');
    btn.className = 'btn-reset-single';
    btn.title = 'Reset to default';
    btn.textContent = '↺';
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  };

  const wrapWithReset = (valSpan, btn) => {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
    valSpan.replaceWith(wrap);
    wrap.appendChild(valSpan);
    wrap.appendChild(btn);
  };

  const applySlider = (id, key, suffix = '') => {
    const slider = document.getElementById(id);
    const valSpan = document.getElementById(id + '-val');
    if (!slider || !valSpan) return;
    wrapWithReset(valSpan, makeBtn(() => {
      const def = DEFAULT_PHYSICS_CONFIG[key];
      physicsConfig[key] = def;
      slider.value = def;
      valSpan.textContent = def + suffix;
      if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl[key] = def;
      updateExportCode();
    }));
  };

  applySlider('slider-grav',        'GRAV');
  applySlider('slider-jump-pwr',    'JUMP_PWR');
  applySlider('slider-speed-walk',  'SPD_WALK');
  applySlider('slider-speed-sprint','SPD_SPRINT');
  applySlider('slider-accel',       'ACCEL');
  applySlider('slider-decel',       'DECEL');
  applySlider('slider-rot',         'ROT_SPD');
  applySlider('slider-speed-mult',  'SPEED_MULTIPLIER', 'x');
  applySlider('slider-cam-dist',    'CAM_FOLLOW_DIST', 'm');
  applySlider('slider-fov-max',     'DYNAMIC_FOV_MAX');

  // cam-pitch: radians stored, degrees displayed
  const camPitchSlider = document.getElementById('slider-cam-pitch');
  const camPitchVal    = document.getElementById('slider-cam-pitch-val');
  if (camPitchSlider && camPitchVal) {
    wrapWithReset(camPitchVal, makeBtn(() => {
      const defRad = DEFAULT_PHYSICS_CONFIG.CAM_FOLLOW_PITCH;
      physicsConfig.CAM_FOLLOW_PITCH = defRad;
      const deg = Math.round(defRad * 180 / Math.PI);
      camPitchSlider.value = deg;
      camPitchVal.textContent = deg + '°';
      if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl.CAM_FOLLOW_PITCH = defRad;
      updateExportCode();
    }));
  }

  const applyCheckbox = (id, key) => {
    const cb = document.getElementById(id);
    if (!cb) return;
    const switchLabel = cb.closest('label');
    if (!switchLabel) return;
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
    switchLabel.replaceWith(wrap);
    wrap.appendChild(switchLabel);
    wrap.appendChild(makeBtn(() => {
      const def = DEFAULT_PHYSICS_CONFIG[key];
      physicsConfig[key] = def;
      cb.checked = def;
      if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl[key] = def;
      updateExportCode();
    }));
  };

  applyCheckbox('toggle-cam-follow-lock', 'CAM_FOLLOW_LOCK');
  applyCheckbox('toggle-cam-lock-pitch',  'CAM_LOCK_PITCH');
  applyCheckbox('toggle-joystick-lock-x', 'JOYSTICK_LOCK_X');
  applyCheckbox('toggle-dynamic-fov',     'DYNAMIC_FOV');
  applyCheckbox('toggle-double-jump',     'DOUBLE_JUMP_ENABLED');
  applyCheckbox('toggle-air-control',     'AIR_CONTROL');
}

function renderKeyBindingsUI() {
  const container = document.getElementById('keybindings-list');
  container.innerHTML = '';

  Object.keys(keyBindings).forEach(action => {
    const keys = keyBindings[action];
    const item = document.createElement('div');
    item.className = 'control-group';
    item.innerHTML = `
      <div class="control-label">
        <span>${action.replace(/_/g, ' ')}</span>
        <button class="btn-reset-single" title="Reset to default">↺</button>
      </div>
      <div class="key-catcher" data-action="${action}">
        <div class="key-tags">
          ${keys.map(k => `<span class="key-tag">${k}<span class="remove-key" data-key="${k}" data-action="${action}">×</span></span>`).join('')}
          ${keys.length === 0 ? `<span class="key-catcher-placeholder">Assign keys</span>` : ''}
        </div>
        <span class="key-catcher-status">Press any key...</span>
      </div>
    `;
    container.appendChild(item);

    item.querySelector('.btn-reset-single').addEventListener('click', (e) => {
      e.stopPropagation();
      keyBindings[action] = [...DEFAULT_KEY_BINDINGS[action]];
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl.keyBindings = keyBindings;
      }
      renderKeyBindingsUI();
      updateExportCode();
    });
  });

  bindKeyCatcherEvents();
}

// Key catcher capture listener
let activeCatcherAction = null;

function bindKeyCatcherEvents() {
  const catchers = document.querySelectorAll('.key-catcher');

  catchers.forEach(catcher => {
    catcher.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-key')) {
        // Handle removal
        const action = e.target.dataset.action;
        const key = e.target.dataset.key;

        if (action.startsWith('CUSTOM_')) {
          const index = parseInt(action.split('_')[1]);
          customAnimations[index].keyTrigger = customAnimations[index].keyTrigger.filter(k => k !== key);
          renderCustomAnimationsTab();
        } else {
          keyBindings[action] = keyBindings[action].filter(k => k !== key);
          renderKeyBindingsUI();
        }

        if (activeCharacter && activeCharacter.charCtrl) {
          activeCharacter.charCtrl.keyBindings = keyBindings;
        }
        updateExportCode();
        return;
      }

      // Toggle capture mode
      if (activeCatcherAction) {
        document.querySelectorAll('.key-catcher').forEach(c => c.classList.remove('capturing'));
      }

      activeCatcherAction = catcher.dataset.action;
      catcher.classList.add('capturing');
    });
  });
}

// Global key catcher event listener
window.addEventListener('keydown', (e) => {
  if (!activeCatcherAction) return;

  e.preventDefault();
  const key = e.code;

  if (activeCatcherAction.startsWith('CUSTOM_')) {
    const index = parseInt(activeCatcherAction.split('_')[1]);
    if (!customAnimations[index].keyTrigger.includes(key)) {
      customAnimations[index].keyTrigger.push(key);
    }
    renderCustomAnimationsTab();
  } else {
    if (!keyBindings[activeCatcherAction].includes(key)) {
      keyBindings[activeCatcherAction].push(key);
    }
    renderKeyBindingsUI();
  }

  if (activeCharacter && activeCharacter.charCtrl) {
    activeCharacter.charCtrl.keyBindings = keyBindings;
    applyAnimationsToController();
  }

  // Deactivate capture
  document.querySelectorAll('.key-catcher').forEach(c => c.classList.remove('capturing'));
  activeCatcherAction = null;
  updateExportCode();
});

// Drag and drop GLB support
function setupDragAndDrop() {
  const zone = document.getElementById('dropzone');
  const fileInput = document.getElementById('glb-file-input');

  zone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadGlbFile(file);
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.glb')) {
      loadGlbFile(file);
    } else {
      showToast("Please import a valid .glb file", true);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// CODE GENERATOR & EXPORTER
// ═══════════════════════════════════════════════════════════
function updateExportCode() {
  const codeBox = document.getElementById('export-code');
  if (!codeBox) return;

  // Build remapping config blocks
  let mappingsSnippet = '';
  Object.keys(animMappings).forEach(key => {
    const m = animMappings[key];
    if (m && m.animName !== 'None') {
      mappingsSnippet += `      // Remap ${key}\n`;
      mappingsSnippet += `      const anim_${key} = filteredGroups.find(g => cleanAnimName(g.name) === '${m.animName}');\n`;
      mappingsSnippet += `      if (anim_${key}) {\n`;
      mappingsSnippet += `        animCtrl.setAnimation('${key}', anim_${key});\n`;
      mappingsSnippet += `        animCtrl.setAnimationRanges('${key}', ${m.from}, ${m.to});\n`;
      mappingsSnippet += `      }\n\n`;
    }
  });

  // Custom Animations snippet
  let customsSnippet = '';
  customAnimations.forEach(cust => {
    if (cust.animName !== 'None') {
      customsSnippet += `      // Register custom action: ${cust.name}\n`;
      customsSnippet += `      const anim_${cust.name} = filteredGroups.find(g => cleanAnimName(g.name) === '${cust.animName}');\n`;
      customsSnippet += `      if (anim_${cust.name}) {\n`;
      customsSnippet += `        animCtrl.setAnimation('${cust.name}', anim_${cust.name});\n`;
      customsSnippet += `      }\n`;
      if (cust.keyTrigger.length > 0) {
        customsSnippet += `      // Bind custom keys for ${cust.name}\n`;
        customsSnippet += `      charCtrl.keyBindings['${cust.name}'] = ${JSON.stringify(cust.keyTrigger)};\n`;
      }
      customsSnippet += `\n`;
    }
  });

  const configCode = `// 🎮 CUSTOM SETUP CONFIGURATION FOR YOUR APP.JS
// Copy and paste this loadCharacter function replacement in your app.js:

async function loadCharacter(scene, shadow, camera, usePhysics) {
  return setupCharacter(scene, camera, usePhysics, {
    shadow,
    assetsPath: 'assets/',
    filename: 'character_animated.glb',
    keys: ${JSON.stringify(keyBindings, null, 4).replace(/\n/g, '\n    ')},
    config: ${JSON.stringify(physicsConfig, null, 4).replace(/\n/g, '\n    ')},
    configure: ({ animCtrl, charCtrl, filteredGroups }) => {
${mappingsSnippet}${customsSnippet}    }
  });
}`;

  codeBox.value = configCode;
  savePreferences();
}

// Download the fully tailored character-controller.js
async function downloadControllerFile() {
  showLoading("Generating custom character-controller.js...");
  try {
    const response = await fetch('js/character-controller.js');
    if (!response.ok) throw new Error("Could not load original character-controller.js base.");
    let sourceText = await response.text();

    // Inject custom Key bindings and Physics default variables in source
    const configMatch = sourceText.match(/const DEFAULT_CHAR_CONFIG = \{[\s\S]*?\};/);
    if (configMatch) {
      const newConfigBlock = `const DEFAULT_CHAR_CONFIG = {
  // Custom Key Bindings
  KEYS: ${JSON.stringify(keyBindings, null, 4).replace(/\n/g, '\n  ')},

  // Custom Physics & Speeds Config
  PHYSICS: ${JSON.stringify(physicsConfig, null, 4).replace(/\n/g, '\n  ')},

  // Mobile / Touch controls configuration
  TOUCH: {
    zoneId: 'joystick-zone',
    ringId: 'joystick-ring',
    knobId: 'joystick-knob',
    buttons: {
      'btn-sprint': 'ShiftLeft',
      'btn-jump': 'Space',
      'btn-roll': 'KeyR',
      'btn-crouch': 'ControlLeft',
      'btn-act': 'KeyF',
      'btn-spell': 'KeyE'
    }
  }
};`;
      // Seed localStorage with baked-in custom values on first load with this specific config.
      // Uses a JSON signature as a cache key — if the user later re-exports with different values,
      // the signature changes and localStorage is re-seeded, overriding any prior HUD overrides.
      const _sig = JSON.stringify(physicsConfig);
      const seedBlock = `
// Auto-seed: write baked-in custom config to localStorage on first load with this config version.
// Subsequent loads keep any HUD-driven overrides the user made.
(function() {
  var _sig = ${JSON.stringify(_sig)};
  if (localStorage.getItem('bcc_cfg_sig') !== _sig) {
    var P = DEFAULT_CHAR_CONFIG.PHYSICS;
    localStorage.setItem('air-control-enabled',   String(P.AIR_CONTROL));
    localStorage.setItem('cam-follow-lock',        String(P.CAM_FOLLOW_LOCK));
    localStorage.setItem('dynamic-fov',            String(P.DYNAMIC_FOV));
    localStorage.setItem('dynamic-fov-max',        String(P.DYNAMIC_FOV_MAX));
    localStorage.setItem('cam-follow-pitch',       String(P.CAM_FOLLOW_PITCH));
    localStorage.setItem('cam-follow-dist',        String(P.CAM_FOLLOW_DIST));
    localStorage.setItem('cam-lock-pitch',         String(P.CAM_LOCK_PITCH));
    localStorage.setItem('joystick-lock-x',        String(P.JOYSTICK_LOCK_X));
    localStorage.setItem('double-jump-enabled',    String(P.DOUBLE_JUMP_ENABLED));
    localStorage.setItem('speed-multiplier',       String(P.SPEED_MULTIPLIER));
    localStorage.setItem('bcc_cfg_sig', _sig);

    // Sync HUD DOM elements if already rendered (defensive update)
    function _syncHUD() {
      var $ = function(id) { return document.getElementById(id); };
      var cb = function(id, v) { var e = $(id); if (e) e.checked = v; };
      var sl = function(id, v) { var e = $(id); if (e) e.value = v; };
      var tx = function(id, t) { var e = $(id); if (e) e.textContent = t; };
      cb('toggle-cam-lock',        P.CAM_FOLLOW_LOCK);
      cb('toggle-dynamic-fov',     P.DYNAMIC_FOV);
      cb('toggle-double-jump',     P.DOUBLE_JUMP_ENABLED);
      cb('toggle-air-control',     P.AIR_CONTROL);
      cb('toggle-cam-lock-pitch',  P.CAM_LOCK_PITCH);
      cb('toggle-joystick-lock-x', P.JOYSTICK_LOCK_X);
      sl('slider-fov-max',         P.DYNAMIC_FOV_MAX);
      tx('fov-max-val',            P.DYNAMIC_FOV_MAX.toFixed(2));
      sl('slider-speed-mult',      P.SPEED_MULTIPLIER);
      tx('speed-mult-val',         P.SPEED_MULTIPLIER.toFixed(1) + 'x');
      var _deg = Math.round(P.CAM_FOLLOW_PITCH * 180 / Math.PI);
      sl('slider-cam-pitch',       _deg);
      tx('cam-pitch-val',          _deg + '\\u00b0');
      sl('slider-cam-dist',        P.CAM_FOLLOW_DIST);
      tx('cam-dist-val',           P.CAM_FOLLOW_DIST.toFixed(1) + 'm');
      // Also update charCtrl live properties if exposed on window
      var ctrl = window._charCtrl || (window.activeCharacter && window.activeCharacter.charCtrl);
      if (ctrl) {
        ctrl.AIR_CONTROL = P.AIR_CONTROL; ctrl.CAM_FOLLOW_LOCK = P.CAM_FOLLOW_LOCK;
        ctrl.DYNAMIC_FOV = P.DYNAMIC_FOV; ctrl.DYNAMIC_FOV_MAX = P.DYNAMIC_FOV_MAX;
        ctrl.CAM_FOLLOW_PITCH = P.CAM_FOLLOW_PITCH; ctrl.CAM_FOLLOW_DIST = P.CAM_FOLLOW_DIST;
        ctrl.CAM_LOCK_PITCH = P.CAM_LOCK_PITCH; ctrl.JOYSTICK_LOCK_X = P.JOYSTICK_LOCK_X;
        ctrl.DOUBLE_JUMP_ENABLED = P.DOUBLE_JUMP_ENABLED; ctrl.SPEED_MULTIPLIER = P.SPEED_MULTIPLIER;
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _syncHUD);
    } else {
      _syncHUD();
    }
  }
})();`;

      sourceText = sourceText.replace(configMatch[0], newConfigBlock + seedBlock);
    }

    // Inject animation mappings directly in setupCharacter in character-controller.js
    const setupHookMatch = sourceText.match(/\/\/ Allow custom remapping of animations\/controls or extra setup from app/);
    if (setupHookMatch) {
      let mappingInjection = `// Custom Exporter Animations Remappings\n`;
      Object.keys(animMappings).forEach(key => {
        const m = animMappings[key];
        if (m && m.animName !== 'None') {
          mappingInjection += `  const anim_${key} = filteredGroups.find(g => cleanAnimName(g.name) === '${m.animName}');\n`;
          mappingInjection += `  if (anim_${key}) {\n`;
          mappingInjection += `    animCtrl.setAnimation('${key}', anim_${key});\n`;
          mappingInjection += `    animCtrl.setAnimationRanges('${key}', ${m.from}, ${m.to});\n`;
          mappingInjection += `  }\n`;
        }
      });

      customAnimations.forEach(cust => {
        if (cust.animName !== 'None') {
          mappingInjection += `  const anim_${cust.name} = filteredGroups.find(g => cleanAnimName(g.name) === '${cust.animName}');\n`;
          mappingInjection += `  if (anim_${cust.name}) {\n`;
          mappingInjection += `    animCtrl.setAnimation('${cust.name}', anim_${cust.name});\n`;
          mappingInjection += `  }\n`;
          if (cust.keyTrigger.length > 0) {
            mappingInjection += `  charCtrl.keyBindings['${cust.name}'] = ${JSON.stringify(cust.keyTrigger)};\n`;
          }
        }
      });

      sourceText = sourceText.replace(setupHookMatch[0], mappingInjection + `\n  ` + setupHookMatch[0]);
    }

    // Create Blob and Trigger Download
    const blob = new Blob([sourceText], { type: 'application/javascript' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'custom-character-controller.js';
    link.click();

    hideLoading();
    showToast("Downloaded custom-character-controller.js successfully!");
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast("Failed to generate custom controller file: " + err.message, true);
  }
}
