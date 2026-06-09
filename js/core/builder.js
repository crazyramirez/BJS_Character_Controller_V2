'use strict';

// ═══════════════════════════════════════════════════════════
// GLOBAL STATE & CONSTANTS
// ═══════════════════════════════════════════════════════════
let engine, scene, camera, shadowGenerator;
let activeCharacter = null; // { playerCapsule, animCtrl, charCtrl, rawAnimationGroups, rawMeshes, charRoot }

// Animation library: array of string names currently loaded in the scene
let detectedAnimations = [];

// Server-side pipeline state
let characterGlbBuffer = null; // ArrayBuffer of the loaded character GLB
let originalCharacterGlbBuffer = null; // Clean original character GLB
let animationsGlbBuffer = null; // ArrayBuffer of the preloaded animations GLB
let isServerAvailable = false;

// Skeleton info
let skeletonInfo = null; // { bones, rootBones, hasSkin, boneCount } from /api/analyze

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
  { key: 'Punch', label: 'Punch', defaultKeyword: /^(?!.*jab)(?!.*cross).*punch/i },
  { key: 'Punch_Jab', label: 'Punch Jab', defaultKeyword: /jab/i },
  { key: 'Punch_Cross', label: 'Punch Cross', defaultKeyword: /cross/i },
  { key: 'Spell_Simple_Enter', label: 'Spell Enter', defaultKeyword: /spell.*enter/i },
  { key: 'Spell_Simple_Shoot', label: 'Spell Shoot / Cast', defaultKeyword: /spell.*(shoot|cast)/i },
  { key: 'Spell_Simple_Exit', label: 'Spell Exit', defaultKeyword: /spell.*exit/i },
  { key: 'Interact', label: 'Interact / Pick up', defaultKeyword: /interact/i },
];

let animMappings = {};

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
  INTERACT: ['KeyF'],
};

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
  CAM_FOLLOW_LOCK: true,
  CAM_FOLLOW_PITCH: 1.047,
  CAM_FOLLOW_DIST: 8.0,
  CAM_LOCK_PITCH: false,
  JOYSTICK_LOCK_X: false,
  DOUBLE_JUMP_ENABLED: true,
  SPEED_MULTIPLIER: 1.0,
  PLAY_PARTICLES: true,
};

let customAnimations = [];

const DEFAULT_KEY_BINDINGS = JSON.parse(JSON.stringify(keyBindings));
const DEFAULT_PHYSICS_CONFIG = JSON.parse(JSON.stringify(physicsConfig));
let savedAnimMappings = null;

let charTransformConfig = {
  SCALE_X: 1.0,
  SCALE_Y: 1.0,
  SCALE_Z: 1.0,
  PIVOT_X: 0.0,
  PIVOT_Y: 0.0,
  PIVOT_Z: 0.0,
  UNIFORM_SCALE: true,
  SCALE_UNIFORM: 1.0,
  ARM_SPREAD_ANGLE: 0.0,
  LEG_SPREAD_ANGLE: 0.0
};
const DEFAULT_CHAR_TRANSFORM = JSON.parse(JSON.stringify(charTransformConfig));

// ═══════════════════════════════════════════════════════════
// PREFERENCES
// ═══════════════════════════════════════════════════════════
function loadPreferences() {
  try {
    const mappings = localStorage.getItem('builder_anim_mappings');
    if (mappings) savedAnimMappings = JSON.parse(mappings);
    const keys = localStorage.getItem('builder_key_bindings');
    if (keys) keyBindings = Object.assign({}, DEFAULT_KEY_BINDINGS, JSON.parse(keys));
    const physics = localStorage.getItem('builder_physics_config');
    if (physics) physicsConfig = Object.assign({}, DEFAULT_PHYSICS_CONFIG, JSON.parse(physics));
    const customs = localStorage.getItem('builder_custom_animations');
    if (customs) customAnimations = JSON.parse(customs);

    const savedPlayParticles = localStorage.getItem('play-particles');
    if (savedPlayParticles !== null) {
      physicsConfig.PLAY_PARTICLES = savedPlayParticles === 'true';
    }
  } catch (e) { console.error('Failed to load preferences', e); }
}

function savePreferences() {
  try {
    localStorage.setItem('builder_anim_mappings', JSON.stringify(animMappings));
    localStorage.setItem('builder_key_bindings', JSON.stringify(keyBindings));
    localStorage.setItem('builder_physics_config', JSON.stringify(physicsConfig));
    localStorage.setItem('builder_custom_animations', JSON.stringify(customAnimations));
  } catch (e) { console.error('Failed to save preferences', e); }
}

// ═══════════════════════════════════════════════════════════
// CHARACTER TRANSFORMS (SCALE & PIVOT)
// ═══════════════════════════════════════════════════════════
function applyLiveTransformations() {
  if (!activeCharacter || !activeCharacter.charTransformWrapper) return;

  const sx = charTransformConfig.SCALE_X;
  const sy = charTransformConfig.SCALE_Y;
  const sz = charTransformConfig.SCALE_Z;

  const px = charTransformConfig.PIVOT_X;
  const py = charTransformConfig.PIVOT_Y;
  const pz = charTransformConfig.PIVOT_Z;

  // Apply scale to wrapper
  activeCharacter.charTransformWrapper.scaling.set(sx, sy, sz);

  // Apply visual root offset (feet position relative to capsule center, shifting opposite of pivot, accounting for scaling and baseline capsule height)
  activeCharacter.charTransformWrapper.position.set(-px * sx, -0.97 * (1 - sy) - py * sy, -pz * sz);
}

function syncCharTransformToUI() {
  const setSlider = (id, val, suffix = '') => {
    const el = document.getElementById(id);
    const valEl = document.getElementById('val-' + id.substring(7));
    if (el) {
      const min = parseFloat(el.min);
      const max = parseFloat(el.max);
      if (val < min) el.min = (Math.floor(val * 2) / 2).toString();
      if (val > max) el.max = (Math.ceil(val * 2) / 2).toString();
      el.value = val;
    }
    if (valEl) {
      valEl.textContent = suffix === '°' ? val.toFixed(1) + suffix : val.toFixed(2) + suffix;
    }
  };

  const uniformToggle = document.getElementById('toggle-uniform-scale');
  if (uniformToggle) uniformToggle.checked = charTransformConfig.UNIFORM_SCALE;

  const groupUniform = document.getElementById('group-scale-uniform');
  const groupXyz = document.getElementById('group-scale-xyz');

  if (charTransformConfig.UNIFORM_SCALE) {
    if (groupUniform) groupUniform.style.display = 'block';
    if (groupXyz) groupXyz.style.display = 'none';
  } else {
    if (groupUniform) groupUniform.style.display = 'none';
    if (groupXyz) groupXyz.style.display = 'block';
  }

  setSlider('slider-scale-uniform', charTransformConfig.SCALE_UNIFORM, 'x');
  setSlider('slider-scale-x', charTransformConfig.SCALE_X, 'x');
  setSlider('slider-scale-y', charTransformConfig.SCALE_Y, 'x');
  setSlider('slider-scale-z', charTransformConfig.SCALE_Z, 'x');
  setSlider('slider-pivot-x', charTransformConfig.PIVOT_X, 'm');
  setSlider('slider-pivot-y', charTransformConfig.PIVOT_Y, 'm');
  setSlider('slider-pivot-z', charTransformConfig.PIVOT_Z, 'm');
  setSlider('slider-arm-spread', charTransformConfig.ARM_SPREAD_ANGLE, '°');
  setSlider('slider-leg-spread', charTransformConfig.LEG_SPREAD_ANGLE, '°');
}

function resetCharacterTransform() {
  charTransformConfig = JSON.parse(JSON.stringify(DEFAULT_CHAR_TRANSFORM));
  
  // Reset slider min/max ranges to default
  const sU = document.getElementById('slider-scale-uniform');
  const sX = document.getElementById('slider-scale-x');
  const sY = document.getElementById('slider-scale-y');
  const sZ = document.getElementById('slider-scale-z');
  if (sU) { sU.min = "0.1"; sU.max = "5.0"; }
  if (sX) { sX.min = "0.1"; sX.max = "5.0"; }
  if (sY) { sY.min = "0.1"; sY.max = "5.0"; }
  if (sZ) { sZ.min = "0.1"; sZ.max = "5.0"; }

  const pX = document.getElementById('slider-pivot-x');
  const pY = document.getElementById('slider-pivot-y');
  const pZ = document.getElementById('slider-pivot-z');
  if (pX) { pX.min = "-2.0"; pX.max = "2.0"; }
  if (pY) { pY.min = "-2.0"; pY.max = "2.0"; }
  if (pZ) { pZ.min = "-2.0"; pZ.max = "2.0"; }

  const armS = document.getElementById('slider-arm-spread');
  const legS = document.getElementById('slider-leg-spread');
  if (armS) { armS.min = "-10"; armS.max = "10"; }
  if (legS) { legS.min = "-10"; legS.max = "10"; }

  syncCharTransformToUI();
  applyLiveTransformations();
  savePreferences();
  updateExportCode();
}

function setupCharTransformControls() {
  const uniformToggle = document.getElementById('toggle-uniform-scale');
  const uniformSlider = document.getElementById('slider-scale-uniform');
  const scaleXSlider = document.getElementById('slider-scale-x');
  const scaleYSlider = document.getElementById('slider-scale-y');
  const scaleZSlider = document.getElementById('slider-scale-z');
  const pivotXSlider = document.getElementById('slider-pivot-x');
  const pivotYSlider = document.getElementById('slider-pivot-y');
  const pivotZSlider = document.getElementById('slider-pivot-z');
  const armSpreadSlider = document.getElementById('slider-arm-spread');
  const legSpreadSlider = document.getElementById('slider-leg-spread');
  const resetBtn = document.getElementById('btn-reset-transform');
  const pivotGroundBtn = document.getElementById('btn-pivot-ground');

  const onSliderChange = () => {
    charTransformConfig.UNIFORM_SCALE = uniformToggle ? uniformToggle.checked : true;
    charTransformConfig.SCALE_UNIFORM = uniformSlider ? parseFloat(uniformSlider.value) : 1.0;
    
    if (charTransformConfig.UNIFORM_SCALE) {
      charTransformConfig.SCALE_X = charTransformConfig.SCALE_UNIFORM;
      charTransformConfig.SCALE_Y = charTransformConfig.SCALE_UNIFORM;
      charTransformConfig.SCALE_Z = charTransformConfig.SCALE_UNIFORM;
      
      // Sync XYZ sliders internally
      if (scaleXSlider) scaleXSlider.value = charTransformConfig.SCALE_UNIFORM;
      if (scaleYSlider) scaleYSlider.value = charTransformConfig.SCALE_UNIFORM;
      if (scaleZSlider) scaleZSlider.value = charTransformConfig.SCALE_UNIFORM;
    } else {
      charTransformConfig.SCALE_X = scaleXSlider ? parseFloat(scaleXSlider.value) : 1.0;
      charTransformConfig.SCALE_Y = scaleYSlider ? parseFloat(scaleYSlider.value) : 1.0;
      charTransformConfig.SCALE_Z = scaleZSlider ? parseFloat(scaleZSlider.value) : 1.0;
    }

    charTransformConfig.PIVOT_X = pivotXSlider ? parseFloat(pivotXSlider.value) : 0.0;
    charTransformConfig.PIVOT_Y = pivotYSlider ? parseFloat(pivotYSlider.value) : 0.0;
    charTransformConfig.PIVOT_Z = pivotZSlider ? parseFloat(pivotZSlider.value) : 0.0;
    charTransformConfig.ARM_SPREAD_ANGLE = armSpreadSlider ? parseFloat(armSpreadSlider.value) : 0.0;
    charTransformConfig.LEG_SPREAD_ANGLE = legSpreadSlider ? parseFloat(legSpreadSlider.value) : 0.0;

    syncCharTransformToUI();
    applyLiveTransformations();
    savePreferences();
    updateExportCode();
  };

  uniformToggle?.addEventListener('change', onSliderChange);
  uniformSlider?.addEventListener('input', onSliderChange);
  scaleXSlider?.addEventListener('input', onSliderChange);
  scaleYSlider?.addEventListener('input', onSliderChange);
  scaleZSlider?.addEventListener('input', onSliderChange);
  pivotXSlider?.addEventListener('input', onSliderChange);
  pivotYSlider?.addEventListener('input', onSliderChange);
  pivotZSlider?.addEventListener('input', onSliderChange);
  armSpreadSlider?.addEventListener('input', onSliderChange);
  legSpreadSlider?.addEventListener('input', onSliderChange);

  resetBtn?.addEventListener('click', () => {
    resetCharacterTransform();
  });

  pivotGroundBtn?.addEventListener('click', () => {
    if (!activeCharacter || !activeCharacter.charRoot) {
      showToast('No character loaded!', true);
      return;
    }

    // Prefer toebase bone world Y as ground reference so toes land flat at y=0.
    // Fallback to bounding box minimum (heel) if no toe bones found.
    let groundY = null;
    if (scene.skeletons && scene.skeletons.length) {
      scene.skeletons.forEach(skel => {
        skel.bones.forEach(bone => {
          const name = (bone.name || '').toLowerCase();
          if (!name.includes('toe')) return;
          const node = bone.getTransformNode();
          if (!node) return;
          node.computeWorldMatrix(true);
          const wp = BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.Zero(), node.getWorldMatrix());
          if (groundY === null || wp.y < groundY) groundY = wp.y;
        });
      });
    }

    if (groundY === null) {
      activeCharacter.rawMeshes.forEach(mesh => {
        if (mesh.name === 'playerCapsuleBuilder') return;
        if (!mesh.getBoundingInfo || !mesh.geometry) return;
        mesh.computeWorldMatrix(true);
        const worldMin = mesh.getBoundingInfo().boundingBox.minimumWorld;
        if (groundY === null || worldMin.y < groundY) groundY = worldMin.y;
      });
    }

    if (groundY === null) {
      showToast('Could not calculate ground level.', true);
      return;
    }

    // Shift wrapper.y up by -groundY to land reference point at y=0
    // wrapper.y = -0.97*(1-sy) - py*sy → changing py by delta shifts wrapper by -delta*sy
    // Need wrapper to increase by -groundY → delta = groundY / sy
    const sy = charTransformConfig.SCALE_Y;
    charTransformConfig.PIVOT_Y = charTransformConfig.PIVOT_Y + groundY / sy;
    charTransformConfig.PIVOT_X = 0;
    charTransformConfig.PIVOT_Z = 0;

    syncCharTransformToUI();
    applyLiveTransformations();
    savePreferences();
    updateExportCode();

    showToast(`Pivot adjusted — feet at ground level.`);
  });
}

function getMergeOptions(extra = {}) {
  return {
    SCALE_X: charTransformConfig.SCALE_X,
    SCALE_Y: charTransformConfig.SCALE_Y,
    SCALE_Z: charTransformConfig.SCALE_Z,
    PIVOT_X: charTransformConfig.PIVOT_X,
    PIVOT_Y: charTransformConfig.PIVOT_Y,
    PIVOT_Z: charTransformConfig.PIVOT_Z,
    ARM_SPREAD_ANGLE: charTransformConfig.ARM_SPREAD_ANGLE,
    LEG_SPREAD_ANGLE: charTransformConfig.LEG_SPREAD_ANGLE,
    removeExistingAnimations: true,
    ...extra
  };
}

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  loadPreferences();
  setupTabs();
  setupCollapsibles();

  // Show initial loader status
  showLoading('Initializing Babylon.js scene…');
  setLoaderStep('init', 'active');

  initBabylonScene();
  setLoaderStep('init', 'completed');

  setupSidebarControls();
  syncPhysicsConfigToUI();
  setupCharTransformControls();
  syncCharTransformToUI();
  setupDragAndDrop();

  // Await server ping BEFORE loading default character so isServerAvailable is set
  await pingServer();

  // Patch CharCtrl to support custom triggers and prevent input while typing
  if (typeof CharCtrl !== 'undefined') {
    const originalIsPressed = CharCtrl.prototype._isPressed;
    CharCtrl.prototype._isPressed = function (action) {
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA'
      );
      if (isTyping || activeCatcherAction !== null) return false;
      return originalIsPressed.call(this, action);
    };

    const originalKeyDown = CharCtrl.prototype._keyDown;
    CharCtrl.prototype._keyDown = function (code) {
      this._previewAnim = null; // Clear active animation preview
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA'
      );
      if (isTyping || activeCatcherAction !== null) { this.keys = {}; return; }

      const inAction = window.ACTION_STATES && window.ACTION_STATES.has(this.state);
      if (!inAction && !this.sitting) {
        for (let cust of customAnimations) {
          if (cust.name && cust.animName !== 'None' && this._matchesAction && this._matchesAction(code, cust.name)) {
            this._setState(cust.name);
            this.anim.play(cust.name, false, 0.25, () => {
              this._setState(window.S ? window.S.IDLE : 'IDLE');
              this._returnToLoco && this._returnToLoco();
            }, 1.0);
            return;
          }
        }
      }
      originalKeyDown.call(this, code);
    };

    const originalUpdateLocoAnim = CharCtrl.prototype._updateLocoAnim;
    CharCtrl.prototype._updateLocoAnim = function (hasMove, sprint, backward, blend = 0.35) {
      if (hasMove) {
        this._previewAnim = null;
      }
      if (this._previewAnim) {
        this.anim.play(this._previewAnim, true, 0.15);
        return;
      }
      originalUpdateLocoAnim.call(this, hasMove, sprint, backward, blend);
    };
  }

  loadDefaultCharacter();
});

// ── Tab management ────────────────────────────────────────
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`panel-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });
}

// ── Collapsible sections ──────────────────────────────────
function setupCollapsibles() {
  document.querySelectorAll('.collapsible-header').forEach(header => {
    if (header._hasCollapsibleListener) return;
    header._hasCollapsibleListener = true;
    header.addEventListener('click', () => {
      const targetId = header.dataset.target;
      const content = document.getElementById(targetId);
      const chevron = header.querySelector('.chevron');
      if (!content) return;
      const isOpen = content.classList.toggle('collapsed');
      if (chevron) chevron.textContent = isOpen ? '▸' : '▾';
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
  setCheckbox('toggle-particles', physicsConfig.PLAY_PARTICLES);
}

// ═══════════════════════════════════════════════════════════
// SERVER HEALTH CHECK
// ═══════════════════════════════════════════════════════════
async function pingServer() {
  const badge = document.getElementById('server-badge');
  const badgeLabel = document.getElementById('server-badge-label');
  const offlineWarn = document.getElementById('server-offline-warn');

  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      isServerAvailable = true;
      badge.className = 'server-badge online';
      badgeLabel.textContent = 'Server ✓';
      if (offlineWarn) offlineWarn.style.display = 'none';
      const offlineBanner = document.getElementById('server-offline-banner');
      if (offlineBanner) offlineBanner.style.display = 'none';
      syncOfflineUI(true);
      return;
    }
  } catch (_) { }

  isServerAvailable = false;
  badge.className = 'server-badge offline';
  badgeLabel.textContent = 'Offline';
  if (offlineWarn) offlineWarn.style.display = 'inline';
  const offlineBanner = document.getElementById('server-offline-banner');
  if (offlineBanner) offlineBanner.style.display = 'flex';
  syncOfflineUI(false);
}

function syncOfflineUI(online) {
  const ids = ['dropzone-character', 'dropzone-animations'];
  ids.forEach(id => {
    document.getElementById(id)?.classList.toggle('dropzone-disabled', !online);
  });

  const btnIds = ['btn-add-single-anim', 'btn-clear-all-anims'];
  btnIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('btn-disabled-offline', !online);
    if (!online) el.setAttribute('title', 'Server offline');
    else el.removeAttribute('title');
  });

  document.querySelectorAll('.btn-anim-delete').forEach(btn => {
    btn.classList.toggle('btn-disabled-offline', !online);
    if (!online) btn.setAttribute('title', 'Server offline');
    else btn.setAttribute('title', 'Remove this animation');
  });

  const viewportNotice = document.getElementById('viewport-offline-notice');
  if (viewportNotice) viewportNotice.style.display = online ? 'none' : 'flex';

  const particlesCb = document.getElementById('toggle-particles');
  if (particlesCb) {
    if (!online) {
      particlesCb.checked = false;
      particlesCb.disabled = true;
      particlesCb.closest('label')?.classList.add('btn-disabled-offline');
      physicsConfig.PLAY_PARTICLES = false;
      activeCharacter?.charCtrl?.playParticles(false);
    } else {
      particlesCb.disabled = false;
      particlesCb.closest('label')?.classList.remove('btn-disabled-offline');
    }
  }
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

  camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3.5, 8, new BABYLON.Vector3(0, 1.2, 0), scene);
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 20;
  camera.lowerBetaLimit = 0.05;
  camera.upperBetaLimit = Math.PI / 2.05;
  camera.wheelPrecision = 55; // Comfortable, precise wheel zoom speed
  camera.pinchPrecision = 55; // Comfortable, precise pinch zoom speed
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

  const envTex = BABYLON.CubeTexture.CreateFromPrefilteredData('assets/environment_2.env', scene);
  scene.environmentTexture = envTex;
  scene.environmentIntensity = 1.0;
  const skybox = scene.createDefaultSkybox(envTex, true, 1000, 0.7);
  if (skybox && skybox.material) skybox.material.fogEnabled = false;

  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.2;
  hemi.groundColor = new BABYLON.Color3(0.08, 0.08, 0.15);

  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-1, -2, -1).normalize(), scene);
  sun.position = new BABYLON.Vector3(15, 25, 15);
  sun.intensity = 0.8;

  shadowGenerator = new BABYLON.ShadowGenerator(1024, sun);
  shadowGenerator.usePercentageCloserFiltering = true;
  shadowGenerator.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;

  const ground = BABYLON.MeshBuilder.CreateBox('ground', { width: 50, height: 1.0, depth: 50 }, scene);
  ground.position.y = -0.5;
  ground.receiveShadows = true;
  ground.checkCollisions = true;
  const gndMat = new BABYLON.PBRMaterial('gndMat', scene);
  gndMat.albedoColor = new BABYLON.Color3(0.12, 0.12, 0.18);
  gndMat.roughness = 0.9;
  gndMat.metallic = 0.1;
  ground.material = gndMat;

  const propMat = new BABYLON.PBRMaterial('propMat', scene);
  propMat.albedoColor = new BABYLON.Color3(0.25, 0.2, 0.35);
  propMat.roughness = 0.7;

  const platform = BABYLON.MeshBuilder.CreateCylinder('platform', { diameter: 6, height: 0.5 }, scene);
  platform.position.set(5, 0.25, 5);
  platform.checkCollisions = true;
  platform.material = propMat;
  shadowGenerator.addShadowCaster(platform);

  const ramp = BABYLON.MeshBuilder.CreateBox('ramp', { width: 3, height: 0.3, depth: 6 }, scene);
  ramp.position.set(-6, 0.5, 4);
  ramp.rotation.x = Math.PI / 10;
  ramp.checkCollisions = true;
  ramp.material = propMat;
  shadowGenerator.addShadowCaster(ramp);

  for (let i = 0; i < 5; i++) {
    const step = BABYLON.MeshBuilder.CreateBox(`step_${i}`, { width: 3, height: 0.2, depth: 0.5 }, scene);
    step.position.set(0, 0.1 + 0.2 * i, -5 + 0.4 * i);
    step.checkCollisions = true;
    step.material = propMat;
    shadowGenerator.addShadowCaster(step);
  }

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
}

// ═══════════════════════════════════════════════════════════
// UI UTILITIES
// ═══════════════════════════════════════════════════════════
function showLoading(msg) {
  const el = document.getElementById('loading-overlay');
  const txt = document.getElementById('loading-status-text');
  if (txt) txt.textContent = msg;
  el.classList.add('visible');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('visible');
  setTimeout(resetLoaderSteps, 400);
}
function setLoaderStep(stepId, status) {
  const stepEl = document.getElementById(`step-${stepId}`);
  if (!stepEl) return;

  stepEl.classList.remove('active', 'completed');
  if (status === 'active') {
    stepEl.classList.add('active');
    const iconEl = document.querySelector('.spinner-icon');
    if (iconEl) {
      if (stepId === 'init') iconEl.textContent = '🌐';
      else if (stepId === 'read') iconEl.textContent = '📂';
      else if (stepId === 'import') iconEl.textContent = '📦';
      else if (stepId === 'analyze') iconEl.textContent = '💀';
      else if (stepId === 'merge') iconEl.textContent = '⚡';
    }
  } else if (status === 'completed') {
    stepEl.classList.add('completed');
  }
}
function resetLoaderSteps() {
  ['init', 'read', 'import', 'analyze', 'merge'].forEach(id => {
    const el = document.getElementById(`step-${id}`);
    if (el) el.className = 'loader-step';
  });
  const iconEl = document.querySelector('.spinner-icon');
  if (iconEl) iconEl.textContent = '🎮';
}
function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast';
  if (isError) toast.classList.add('error');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function showMergeProgress(show, label = 'Merging on server…') {
  const wrap = document.getElementById('merge-progress-wrap');
  const lbl = document.getElementById('merge-progress-label');
  const fill = document.getElementById('merge-progress-fill');
  if (!wrap) return;
  wrap.style.display = show ? 'block' : 'none';
  if (lbl) lbl.textContent = label;
  if (fill) {
    fill.style.transition = show ? 'width 2s ease' : 'none';
    fill.style.width = show ? '85%' : '0%';
  }
}
function completeMergeProgress() {
  const fill = document.getElementById('merge-progress-fill');
  if (fill) { fill.style.transition = 'width 0.3s ease'; fill.style.width = '100%'; }
  setTimeout(() => showMergeProgress(false), 600);
}

// ═══════════════════════════════════════════════════════════
// DEFAULT CHARACTER LOAD
// ═══════════════════════════════════════════════════════════
async function loadDefaultCharacter() {
  resetLoaderSteps();
  setLoaderStep('init', 'completed');
  setLoaderStep('read', 'active');
  showLoading('Loading default character…');
  try {
    const response = await fetch('assets/character_animated.glb');
    if (!response.ok) throw new Error('Assets character GLB not found.');
    const buf = await response.arrayBuffer();
    setLoaderStep('read', 'completed');
    const file = new File([buf], 'character_animated.glb');
    await loadCharacterMeshFile(file, buf);
    animationsGlbBuffer = buf;
  } catch (e) {
    console.warn('Could not load assets/character_animated.glb, waiting for user import.', e);
    hideLoading();
  }
}

// ═══════════════════════════════════════════════════════════
// CHARACTER MESH LOADER (primary import)
// ═══════════════════════════════════════════════════════════
async function loadCharacterMeshFile(file, preloadedBuffer = null) {
  if (!preloadedBuffer) {
    resetCharacterTransform();
  }
  const readStep = document.getElementById('step-read');
  if (readStep && !readStep.classList.contains('completed')) {
    resetLoaderSteps();
    setLoaderStep('init', 'completed');
    setLoaderStep('read', 'active');
  }
  showLoading(`Importing ${file.name}…`);

  const arrayBuffer = preloadedBuffer || await file.arrayBuffer();
  characterGlbBuffer = arrayBuffer;
  originalCharacterGlbBuffer = arrayBuffer;
  setLoaderStep('read', 'completed');
  setLoaderStep('import', 'active');

  try {
    await _loadGlbIntoScene(arrayBuffer, file.name);
    setLoaderStep('import', 'completed');
    setLoaderStep('analyze', 'active');

    // Run skeleton/animation analysis via server if available
    if (isServerAvailable) {
      try {
        const formData = new FormData();
        formData.append('file', new Blob([arrayBuffer], { type: 'model/gltf-binary' }), file.name);
        const res = await fetch('/api/analyze', { method: 'POST', body: formData });
        if (res.ok) {
          skeletonInfo = await res.json();
          renderSkeletonSection(skeletonInfo);
        }
      } catch (e) {
        console.warn('Server analyze failed, using BJS-detected info.', e);
        renderSkeletonSectionFromBJS();
      }
    } else {
      renderSkeletonSectionFromBJS();
    }
    setLoaderStep('analyze', 'completed');

    updateCharStatusBar(file.name);

    if (animationsGlbBuffer) {
      await applyPreloadedAnimations();
    } else {
      hideLoading();
      showToast(`✓ ${file.name} loaded!`);
    }
  } catch (err) {
    console.error(err);
    characterGlbBuffer = null;
    originalCharacterGlbBuffer = null;
    hideLoading();
    showToast('Failed to load character: ' + err.message, true);
  }
}

async function updateSkeletonInfoAfterMerge(mergedBuffer) {
  if (!isServerAvailable) return;
  try {
    const formData = new FormData();
    formData.append('file', new Blob([mergedBuffer], { type: 'model/gltf-binary' }), 'merged.glb');
    const res = await fetch('/api/analyze', { method: 'POST', body: formData });
    if (res.ok) {
      skeletonInfo = await res.json();
      renderSkeletonSection(skeletonInfo);
    }
  } catch (e) {
    console.warn('Post-merge skeleton analysis failed:', e);
  }
}

async function applyPreloadedAnimations() {
  if (!characterGlbBuffer || !animationsGlbBuffer) return;

  setLoaderStep('merge', 'active');
  if (isServerAvailable) {
    showMergeProgress(true, `Merging preloaded animations on server…`);
    try {
      const formData = new FormData();
      formData.append('character', new Blob([characterGlbBuffer], { type: 'model/gltf-binary' }), 'character.glb');
      formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations.glb');

      formData.append('options', JSON.stringify(getMergeOptions()));

      const res = await fetch('/api/merge', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Server merge failed');
      }

      completeMergeProgress();
      showLoading('Loading merged character…');

      const mergedBuffer = await res.arrayBuffer();
      characterGlbBuffer = mergedBuffer;
      await _loadGlbIntoScene(mergedBuffer, 'merged.glb');
      await updateSkeletonInfoAfterMerge(mergedBuffer);
      setLoaderStep('merge', 'completed');
      hideLoading();
      showToast(`✓ Merged with preloaded animations! ${detectedAnimations.length} animations loaded.`);
    } catch (err) {
      completeMergeProgress();
      console.error('Server merge failed for preloaded animations, falling back to client-side load:', err);
      showToast('Server merge failed — loading animations as-is.', true);
      await _loadGlbIntoScene(animationsGlbBuffer, 'animations.glb', true);
      setLoaderStep('merge', 'completed');
      hideLoading();
    }
  } else {
    showLoading(`Loading preloaded animations (no server retargeting)…`);
    await _loadGlbIntoScene(animationsGlbBuffer, 'animations.glb', true);
    setLoaderStep('merge', 'completed');
    hideLoading();
    showToast(`Loaded preloaded animations (offline, no retargeting).`);
  }
}

// ═══════════════════════════════════════════════════════════
// ANIMATION BATCH LOADER (merge via server)
// ═══════════════════════════════════════════════════════════
//
async function loadAnimationBatchFile(file) {
  if (!characterGlbBuffer) {
    showToast('Load a character mesh first!', true);
    return;
  }

  resetLoaderSteps();
  setLoaderStep('init', 'completed');
  setLoaderStep('read', 'active');
  showLoading(`Reading ${file.name}…`);

  const animBuffer = await file.arrayBuffer();
  animationsGlbBuffer = animBuffer;
  setLoaderStep('read', 'completed');
  setLoaderStep('merge', 'active');

  if (isServerAvailable) {
    showMergeProgress(true, `Merging ${file.name} on server…`);
    try {
      const baseBuffer = originalCharacterGlbBuffer || characterGlbBuffer;
      console.log(`[batch-import] Using ${originalCharacterGlbBuffer ? 'original' : 'current'} character buffer (${(baseBuffer.byteLength / 1024).toFixed(0)} KB) + anim file (${(animBuffer.byteLength / 1024).toFixed(0)} KB)`);
      const formData = new FormData();
      formData.append('character', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');
      formData.append('animations', new Blob([animBuffer], { type: 'model/gltf-binary' }), file.name);

      formData.append('options', JSON.stringify(getMergeOptions()));

      const res = await fetch('/api/merge', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Server merge failed');
      }

      completeMergeProgress();
      showLoading('Loading merged character…');

      const mergedBuffer = await res.arrayBuffer();
      console.log(`[batch-import] Merged result: ${(mergedBuffer.byteLength / 1024).toFixed(0)} KB`);
      characterGlbBuffer = mergedBuffer; // update stored char buffer to the merged one
      await _loadGlbIntoScene(mergedBuffer, 'merged.glb');
      await updateSkeletonInfoAfterMerge(mergedBuffer);
      console.log(`[batch-import] Detected animations after load: [${detectedAnimations.join(', ')}]`);
      setLoaderStep('merge', 'completed');

      hideLoading();
      showToast(`✓ Merged! ${detectedAnimations.length} animations loaded.`);
    } catch (err) {
      completeMergeProgress();
      console.error('Server merge failed, falling back to client-side load:', err);
      showToast('Server merge failed — loading animations as-is.', true);
      await _loadGlbIntoScene(animBuffer, file.name, true /* animOnly */);
      setLoaderStep('merge', 'completed');
      hideLoading();
    }
  } else {
    // Offline fallback: load animation file directly without retargeting
    showLoading(`Loading ${file.name} (no server retargeting)…`);
    await _loadGlbIntoScene(animBuffer, file.name, true /* animOnly */);
    setLoaderStep('merge', 'completed');
    hideLoading();
    showToast(`Loaded animations (offline, no retargeting).`);
  }
}

// ═══════════════════════════════════════════════════════════
// SINGLE ANIMATION MERGE
// ═══════════════════════════════════════════════════════════
async function addSingleAnimationFile(file) {
  await loadAnimationBatchFile(file); // same pipeline — additive merge
}

// ═══════════════════════════════════════════════════════════
// CORE GLB LOADER → BABYLON SCENE
// ═══════════════════════════════════════════════════════════
async function _loadGlbIntoScene(arrayBuffer, filename = 'model.glb', animOnly = false) {
  // Dispose existing character
  if (activeCharacter) {
    if (activeCharacter.charCtrl._updateObserver) {
      scene.onBeforeRenderObservable.remove(activeCharacter.charCtrl._updateObserver);
    }
    if (activeCharacter.charCtrl._cameraLockObserver) {
      scene.onBeforeCameraRenderObservable.remove(activeCharacter.charCtrl._cameraLockObserver);
    }
    if (activeCharacter.boneOffsetObserver) {
      scene.onAfterAnimationsObservable.remove(activeCharacter.boneOffsetObserver);
    }
    activeCharacter.playerCapsule.dispose();
    activeCharacter.animCtrl.destroy();
    activeCharacter = null;
  }

  // Dispose all existing skeletons in the scene to prevent duplicates and memory leaks
  if (scene && scene.skeletons) {
    [...scene.skeletons].forEach(skel => skel.dispose());
  }

  const blob = new Blob([arrayBuffer]);
  const blobUrl = URL.createObjectURL(blob);

  const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', '', blobUrl, scene, null, '.glb');
  URL.revokeObjectURL(blobUrl);

  const charRoot = charRes.meshes[0];
  charRoot.name = 'Character_Visual_builder';

  charRes.meshes.forEach(m => {
    shadowGenerator.addShadowCaster(m, true);
    m.receiveShadows = true;
    m.isPickable = false;
  });

  charRes.animationGroups.forEach(ag => ag.stop());

  // Filter T-pose
  charRes.animationGroups
    .filter(ag => /t[\-_]?pose/i.test(ag.name))
    .forEach(ag => ag.dispose());

  const filteredGroups = charRes.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

  const newAnimNames = filteredGroups.map(ag => {
    const parts = ag.name.split('|');
    return parts[parts.length - 1].trim();
  });
  // Full character load resets the list; animation-only imports merge additively
  detectedAnimations = animOnly
    ? [...new Set([...detectedAnimations, ...newAnimNames])]
    : newAnimNames;

  // Capsule
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsuleBuilder', { radius: 0.4, height: 1.8 }, scene);
  playerCapsule.position.set(0, 2, 0);
  playerCapsule.visibility = 0;
  playerCapsule.isPickable = false;
  playerCapsule.checkCollisions = true;
  playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);

  const charTransformWrapper = new BABYLON.TransformNode('charTransformWrapperBuilder', scene);
  charTransformWrapper.setParent(playerCapsule);
  charTransformWrapper.position.set(0, 0, 0);
  charTransformWrapper.rotation.set(0, 0, 0);

  charRoot.setParent(charTransformWrapper);
  charRoot.position.set(0, -0.97, 0);
  charRoot.rotation.set(0, 0, 0);

  const animCtrl = new AnimCtrl(filteredGroups, scene);
  const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, {
    usePhysics: false,
    keys: keyBindings,
    config: physicsConfig,
  });

  // Force builder's saved physicsConfig settings onto the controller to override any standalone localStorage keys
  Object.keys(physicsConfig).forEach(key => {
    if (key === 'PLAY_PARTICLES') {
      charCtrl.playParticles(physicsConfig.PLAY_PARTICLES);
    } else {
      charCtrl[key] = physicsConfig[key];
    }
  });

  activeCharacter = { playerCapsule, animCtrl, charCtrl, rawAnimationGroups: filteredGroups, rawMeshes: charRes.meshes, charRoot, charTransformWrapper };

  // Cache original bone rotations for manual posture adjustment (arm/leg spread offsets)
  const originalBoneRotations = new Map();
  scene.skeletons.forEach(skel => {
    skel.bones.forEach(bone => {
      const node = bone.getTransformNode();
      if (node) {
        if (!node.rotationQuaternion) {
          node.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(node.rotation.y, node.rotation.x, node.rotation.z);
        }
        originalBoneRotations.set(node.uniqueId, node.rotationQuaternion.clone());
      }
    });
  });
  activeCharacter.originalBoneRotations = originalBoneRotations;

  // Set up observable to apply real-time bone rotation offsets (arm & leg spread angles)
  activeCharacter.boneOffsetObserver = scene.onAfterAnimationsObservable.add(() => {
    if (!activeCharacter) return;

    // 1. Gather all unique node IDs that are currently animated by any playing animation group
    const animatedNodes = new Set();
    scene.animationGroups.forEach(ag => {
      if (ag.isPlaying) {
        ag.targetedAnimations.forEach(ta => {
          if (ta.target) {
            animatedNodes.add(ta.target.uniqueId);
          }
        });
      }
    });

    const armAngle = charTransformConfig.ARM_SPREAD_ANGLE || 0;
    const legAngle = charTransformConfig.LEG_SPREAD_ANGLE || 0;

    // 2. Loop through character bones and apply offsets (only if the bone matches arm/leg names)
    scene.skeletons.forEach(skel => {
      skel.bones.forEach(bone => {
        const node = bone.getTransformNode();
        if (!node) return;

        const name = (bone.name || node.name || '').toLowerCase();
        let isArm = false;
        let isLeg = false;
        let isLeft = false;
        let isRight = false;

        if (name.includes('leftshoulder') || name.includes('leftarm')) {
          isArm = true;
          isLeft = true;
        } else if (name.includes('rightshoulder') || name.includes('rightarm')) {
          isArm = true;
          isRight = true;
        } else if (name.includes('leftupleg') || name.includes('leftthigh')) {
          isLeg = true;
          isLeft = true;
        } else if (name.includes('rightupleg') || name.includes('rightthigh')) {
          isLeg = true;
          isRight = true;
        }

        if (isArm || isLeg) {
          // If the bone is not actively animated in the current frame, reset it to its rest pose rotation
          if (!animatedNodes.has(node.uniqueId)) {
            const origRot = originalBoneRotations.get(node.uniqueId);
            if (origRot) {
              node.rotationQuaternion.copyFrom(origRot);
            }
          }

          // Compute custom offset (Roll/Z-axis for both arms and legs)
          let angleDeg = 0;
          if (isArm) {
            angleDeg = isLeft ? armAngle : -armAngle;
          } else {
            angleDeg = isLeft ? -legAngle : legAngle;
          }

          if (angleDeg !== 0) {
            const angleRad = angleDeg * Math.PI / 180;
            const offsetQuat = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, angleRad);
            node.rotationQuaternion.multiplyToRef(offsetQuat, node.rotationQuaternion);
          }
        }
      });
    });
  });

  // Apply live transformations immediately
  applyLiveTransformations();

  // Apply mappings immediately so standard keys (Roll, Jump_Loop, etc.) are in animCtrl.g
  // before the first render frame ticks. autoMapAnimations() later will re-run but this
  // prevents the one-frame window where play('Roll') fires before setAnimation('Roll', ...).
  applyAnimationsToController();

  // Camera follow
  let hasMadeInitialWalk = false;
  scene.registerBeforeRender(() => {
    if (!activeCharacter) return;
    const tgt = activeCharacter.playerCapsule.position.add(new BABYLON.Vector3(0, 0.4, 0));
    camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 0.1);

    if (activeCharacter.charCtrl.grounded && !hasMadeInitialWalk) {
      hasMadeInitialWalk = true;
      setTimeout(() => {
        if (activeCharacter && activeCharacter.charCtrl) {
          activeCharacter.charCtrl.keys['KeyW'] = true;
          setTimeout(() => {
            if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl.keys['KeyW'] = false;
          }, 100);
        }
      }, 150);
    }
  });

  charCtrl.callbacks.onStateChange = (state) => {
    const el = document.getElementById('hud-state');
    if (el) el.textContent = state;
  };
  charCtrl.callbacks.onSpeedChange = (spd) => {
    const el = document.getElementById('hud-speed');
    if (el) el.textContent = spd.toFixed(2) + ' m/s';
  };

  // Refresh UI
  autoMapAnimations();
  savedAnimMappings = null; // consumed — don't let stale saved None values block future loads
  renderAnimationsMappingTab();
  renderCustomAnimationsTab();
  renderAnimationLibrary();
  updateExportCode();
}

// ═══════════════════════════════════════════════════════════
// ANIMATION DELETE
// ═══════════════════════════════════════════════════════════
function deleteAnimation(animName) {
  detectedAnimations = detectedAnimations.filter(n => n !== animName);

  // Clear any mappings pointing to this animation
  Object.keys(animMappings).forEach(key => {
    if (animMappings[key] && animMappings[key].animName === animName) {
      animMappings[key] = { animName: 'None', from: 0, to: 100 };
    }
  });
  customAnimations.forEach(cust => {
    if (cust.animName === animName) cust.animName = 'None';
  });

  // Remove from BJS animCtrl if loaded
  if (activeCharacter && activeCharacter.rawAnimationGroups) {
    const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === animName);
    if (group) {
      group.stop();
      group.dispose();
      activeCharacter.rawAnimationGroups = activeCharacter.rawAnimationGroups.filter(g => cleanAnimName(g.name) !== animName);
    }
  }

  renderAnimationLibrary();
  renderAnimationsMappingTab();
  renderCustomAnimationsTab();
  updateExportCode();
  showToast(`Removed animation: ${animName}`);
}

// ═══════════════════════════════════════════════════════════
// SKELETON UI
// ═══════════════════════════════════════════════════════════
function renderSkeletonSection(info) {
  const section = document.getElementById('section-skeleton');
  if (section) section.style.display = 'block';

  const noticEl = document.getElementById('skeleton-notice');
  const treeEl = document.getElementById('skeleton-tree');
  const countBadge = document.getElementById('bone-count-badge');
  const typeBadge = document.getElementById('skeleton-type-badge');
  const poseBadge = document.getElementById('skeleton-pose-badge');
  if (!treeEl) return;

  treeEl.innerHTML = '';
  if (countBadge) countBadge.textContent = `${info.boneCount} bone${info.boneCount !== 1 ? 's' : ''}`;

  if (typeBadge) {
    if (info.skeletonType && info.skeletonType.label) {
      typeBadge.textContent = info.skeletonType.label;
      typeBadge.style.display = 'inline-block';
      typeBadge.style.backgroundColor = (info.skeletonType.color || '#6b7280') + '24';
      typeBadge.style.borderColor = info.skeletonType.color || '#6b7280';
      typeBadge.style.color = info.skeletonType.color || '#6b7280';
    } else {
      typeBadge.style.display = 'none';
    }
  }

  if (poseBadge) {
    if (info.poseStyle && info.poseStyle !== 'UNKNOWN') {
      poseBadge.textContent = info.poseStyle;
      poseBadge.style.display = 'inline-block';
      if (info.poseStyle === 'T-POSE') {
        poseBadge.style.backgroundColor = 'rgba(16, 185, 129, 0.12)';
        poseBadge.style.borderColor = 'rgba(16, 185, 129, 0.45)';
        poseBadge.style.color = '#34d399';
      } else {
        poseBadge.style.backgroundColor = 'rgba(245, 158, 11, 0.12)';
        poseBadge.style.borderColor = 'rgba(245, 158, 11, 0.45)';
        poseBadge.style.color = '#fbbf24';
      }
    } else {
      poseBadge.style.display = 'none';
    }
  }

  if (!info.hasSkin || info.boneCount === 0) {
    if (noticEl) noticEl.style.display = 'flex';
    return;
  }
  if (noticEl) noticEl.style.display = 'none';

  // Build tree sorted by depth
  const sorted = [...info.bones].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  sorted.forEach(bone => {
    const row = document.createElement('div');
    row.className = 'skeleton-bone';
    row.style.paddingLeft = `${12 + bone.depth * 16}px`;

    const isLeaf = bone.children.length === 0;
    row.innerHTML = `
      <span class="bone-icon">${isLeaf ? '◦' : '▸'}</span>
      <span class="bone-name">${bone.name}</span>
      ${bone.children.length > 0 ? `<span class="bone-children-count">${bone.children.length}</span>` : ''}
    `;
    treeEl.appendChild(row);
  });
}

function renderSkeletonSectionFromBJS() {
  if (!activeCharacter) return;
  const skeletons = scene.skeletons;
  const section = document.getElementById('section-skeleton');
  if (section) section.style.display = 'block';

  const noticEl = document.getElementById('skeleton-notice');
  const treeEl = document.getElementById('skeleton-tree');
  const countBadge = document.getElementById('bone-count-badge');
  const typeBadge = document.getElementById('skeleton-type-badge');
  const poseBadge = document.getElementById('skeleton-pose-badge');
  if (typeBadge) typeBadge.style.display = 'none';
  if (poseBadge) poseBadge.style.display = 'none';
  if (!treeEl) return;

  treeEl.innerHTML = '';

  if (!skeletons || skeletons.length === 0) {
    if (noticEl) noticEl.style.display = 'flex';
    if (countBadge) countBadge.textContent = '0 bones';
    return;
  }

  if (noticEl) noticEl.style.display = 'none';

  let totalBones = 0;
  skeletons.forEach((skel, si) => {
    if (skeletons.length > 1) {
      const hdr = document.createElement('div');
      hdr.className = 'bone-skeleton-label';
      hdr.textContent = skel.name || `Skeleton ${si + 1}`;
      treeEl.appendChild(hdr);
    }

    const bones = skel.bones;
    totalBones += bones.length;
    bones.forEach(bone => {
      const depth = (function getDepth(b) {
        let d = 0; let p = b.getParent();
        while (p) { d++; p = p.getParent(); }
        return d;
      })(bone);

      const isLeaf = bone.children.length === 0;
      const row = document.createElement('div');
      row.className = 'skeleton-bone';
      row.style.paddingLeft = `${12 + depth * 16}px`;
      row.innerHTML = `
        <span class="bone-icon">${isLeaf ? '◦' : '▸'}</span>
        <span class="bone-name">${bone.name}</span>
        ${bone.children.length > 0 ? `<span class="bone-children-count">${bone.children.length}</span>` : ''}
      `;
      treeEl.appendChild(row);
    });
  });

  if (countBadge) countBadge.textContent = `${totalBones} bone${totalBones !== 1 ? 's' : ''}`;
}

// ═══════════════════════════════════════════════════════════
// CHARACTER STATUS BAR
// ═══════════════════════════════════════════════════════════
function updateCharStatusBar(filename) {
  const bar = document.getElementById('char-status');
  const text = document.getElementById('char-status-text');
  if (bar) bar.style.display = 'flex';
  if (text) text.textContent = filename;

  const ctrl = document.getElementById('char-transform-controls');
  if (ctrl) ctrl.style.display = 'block';
}

function clearCharacter() {
  const bar = document.getElementById('char-status');
  if (bar) bar.style.display = 'none';

  const ctrl = document.getElementById('char-transform-controls');
  if (ctrl) ctrl.style.display = 'none';

  if (activeCharacter) {
    if (activeCharacter.charCtrl._updateObserver) {
      scene.onBeforeRenderObservable.remove(activeCharacter.charCtrl._updateObserver);
    }
    if (activeCharacter.charCtrl._cameraLockObserver) {
      scene.onBeforeCameraRenderObservable.remove(activeCharacter.charCtrl._cameraLockObserver);
    }
    if (activeCharacter.boneOffsetObserver) {
      scene.onAfterAnimationsObservable.remove(activeCharacter.boneOffsetObserver);
    }
    activeCharacter.playerCapsule.dispose();
    activeCharacter.animCtrl.destroy();
    activeCharacter = null;
  }

  characterGlbBuffer = null;
  originalCharacterGlbBuffer = null;
  animationsGlbBuffer = null;
  detectedAnimations = [];
  skeletonInfo = null;

  const section = document.getElementById('section-skeleton');
  if (section) section.style.display = 'none';
  const libSection = document.getElementById('section-anim-library');
  if (libSection) libSection.style.display = 'none';

  renderAnimationLibrary();
  renderAnimationsMappingTab();
  renderCustomAnimationsTab();
  updateExportCode();
}

// ═══════════════════════════════════════════════════════════
// ANIMATION LIBRARY UI
// ═══════════════════════════════════════════════════════════
function renderAnimationLibrary() {
  const libSection = document.getElementById('section-anim-library');
  const container = document.getElementById('anim-library');
  const badge = document.getElementById('anim-count-badge');

  if (!container) return;

  if (detectedAnimations.length === 0) {
    if (libSection) libSection.style.display = 'none';
    return;
  }

  if (libSection) libSection.style.display = 'block';
  if (badge) badge.textContent = `${detectedAnimations.length} animation${detectedAnimations.length !== 1 ? 's' : ''}`;

  container.innerHTML = '';
  detectedAnimations.forEach(animName => {
    const row = document.createElement('div');
    row.className = 'anim-entry';
    row.setAttribute('data-anim', animName);
    row.innerHTML = `
      <span class="anim-icon">▶</span>
      <span class="anim-entry-name">${animName}</span>
      <button class="btn-anim-delete" title="Remove this animation" data-anim="${animName}">✕</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.anim-entry').forEach(row => {
    row.addEventListener('click', (e) => {
      // If clicking the delete button, ignore play trigger
      if (e.target.closest('.btn-anim-delete')) return;

      const animName = row.dataset.anim;
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl.state = window.S ? window.S.IDLE : 'IDLE';
        activeCharacter.charCtrl._previewAnim = animName;
        showToast(`Playing animation: ${animName}`);
      }
    });
  });

  container.querySelectorAll('.btn-anim-delete').forEach(btn => {
    if (!isServerAvailable) {
      btn.classList.add('btn-disabled-offline');
      btn.setAttribute('title', 'Server offline');
    }
    btn.addEventListener('click', (e) => {
      if (!isServerAvailable) { showToast('Server offline. Start the server first (npm start).', true); return; }
      deleteAnimation(btn.dataset.anim);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// AUTO-MAP & APPLY ANIMATIONS
// ═══════════════════════════════════════════════════════════
function cleanAnimName(name) {
  const parts = name.split('|');
  return parts[parts.length - 1].trim();
}

function autoMapAnimations() {
  const previousMappings = savedAnimMappings || animMappings || {};
  animMappings = {};
  STANDARD_ANIM_KEYS.forEach(stdKey => {
    // Only restore a saved mapping if it actually points to an animation present in the model.
    // Never restore 'None' from a previous session — let the keyword matcher retry.
    if (previousMappings[stdKey.key] &&
      previousMappings[stdKey.key].animName !== 'None' &&
      detectedAnimations.includes(previousMappings[stdKey.key].animName)) {
      animMappings[stdKey.key] = { ...previousMappings[stdKey.key] };
      return;
    }

    let bestMatch = 'None', from = 0, to = 100;
    for (let detName of detectedAnimations) {
      if (stdKey.defaultKeyword.test(detName)) {
        bestMatch = detName;
        const group = activeCharacter && activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === detName);
        if (group) { from = Math.round(group.from || 0); to = Math.round(group.to || 100); }
        break;
      }
    }
    // Note: if no keyword match is found, bestMatch stays 'None'.
    // The user can manually assign the animation in the Animations tab.
    animMappings[stdKey.key] = { animName: bestMatch, from, to };
  });

  applyAnimationsToController();
}


function applyAnimationsToController() {
  if (!activeCharacter) return;

  STANDARD_ANIM_KEYS.forEach(stdKey => {
    const mapping = animMappings[stdKey.key];
    if (mapping && mapping.animName !== 'None') {
      const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === mapping.animName);
      if (group) {
        activeCharacter.animCtrl.setAnimation(stdKey.key, group);
        activeCharacter.animCtrl.setAnimationRanges(stdKey.key, mapping.from, mapping.to);
      }
    } else {
      activeCharacter.animCtrl.g.delete(stdKey.key);
    }
  });

  customAnimations.forEach(cust => {
    if (cust.animName !== 'None' && cust.name) {
      const group = activeCharacter.rawAnimationGroups.find(g => cleanAnimName(g.name) === cust.animName);
      if (group) {
        activeCharacter.animCtrl.setAnimation(cust.name, group);
        if (cust.keyTrigger.length > 0) activeCharacter.charCtrl.keyBindings[cust.name] = cust.keyTrigger;
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
// ANIMATIONS MAPPING TAB
// ═══════════════════════════════════════════════════════════
function renderAnimationsMappingTab() {
  const container = document.getElementById('animations-mapping-list');
  container.innerHTML = '';

  if (detectedAnimations.length === 0) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:20px;">No animations found. Please load a character first.</p>`;
    return;
  }

  STANDARD_ANIM_KEYS.forEach(stdKey => {
    const mapping = animMappings[stdKey.key] || { animName: 'None', from: 0, to: 100 };

    const row = document.createElement('div');
    row.className = 'mapping-row';

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
        <input type="number" class="frame-input frame-to"   data-key="${stdKey.key}" placeholder="To"   value="${mapping.to}">
      </div>
    `;

    container.appendChild(row);
  });

  container.querySelectorAll('.mapping-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      const animName = e.target.value;
      animMappings[key].animName = animName;
      if (animName !== 'None') {
        const group = activeCharacter && activeCharacter.rawAnimationGroups.find(g => g.name.endsWith(animName) || g.name === animName);
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
      if (e.target.classList.contains('frame-from')) animMappings[key].from = val;
      else animMappings[key].to = val;
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
  let bestMatch = 'None', from = 0, to = 100;
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

// ═══════════════════════════════════════════════════════════
// CUSTOM ANIMATIONS TAB
// ═══════════════════════════════════════════════════════════
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
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
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

  container.querySelectorAll('.custom-name-input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations[index].name = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
      e.target.value = customAnimations[index].name;
      applyAnimationsToController(); updateExportCode();
    });
  });
  container.querySelectorAll('.custom-select-anim').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations[index].animName = e.target.value;
      applyAnimationsToController(); updateExportCode();
    });
  });
  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations.splice(index, 1);
      renderCustomAnimationsTab(); applyAnimationsToController(); updateExportCode();
    });
  });

  bindKeyCatcherEvents();
}

/**
 * Shows a custom confirm modal with Cinema Dark styling
 * @param {string} title
 * @param {string} message
 * @param {Function} onConfirm
 */
function showConfirm(title, message, onConfirm) {
  const overlay = document.getElementById('custom-confirm-modal');
  if (!overlay) return;

  const titleEl = overlay.querySelector('#custom-confirm-title');
  const messageEl = overlay.querySelector('#custom-confirm-message');
  const btnCancel = overlay.querySelector('#custom-confirm-btn-cancel');
  const btnOk = overlay.querySelector('#custom-confirm-btn-ok');

  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;

  // Show the modal
  overlay.classList.add('active');

  // Cleanup to avoid multiple listeners stacking
  const cleanup = () => {
    overlay.classList.remove('active');
    btnCancel.replaceWith(btnCancel.cloneNode(true));
    btnOk.replaceWith(btnOk.cloneNode(true));
  };

  // Bind fresh events
  const newCancel = overlay.querySelector('#custom-confirm-btn-cancel');
  const newOk = overlay.querySelector('#custom-confirm-btn-ok');

  newCancel.addEventListener('click', cleanup);
  newOk.addEventListener('click', () => {
    cleanup();
    if (typeof onConfirm === 'function') {
      onConfirm();
    }
  });
}

function clearAllAnimations() {
  if (detectedAnimations.length === 0) return;

  showConfirm(
    'Clear All Animations',
    'Are you sure you want to clear all animations from the library? This cannot be undone.',
    () => {
      detectedAnimations = [];

      // Clear all mappings
      Object.keys(animMappings).forEach(key => {
        animMappings[key] = { animName: 'None', from: 0, to: 100 };
      });
      customAnimations = [];

      // Remove from BJS animCtrl
      if (activeCharacter) {
        if (activeCharacter.rawAnimationGroups) {
          activeCharacter.rawAnimationGroups.forEach(group => {
            group.stop();
            group.dispose();
          });
          activeCharacter.rawAnimationGroups = [];
        }
        activeCharacter.animCtrl.destroy();
        // Recreate a clean animCtrl with no animation groups
        activeCharacter.animCtrl = new AnimCtrl([], scene);
        activeCharacter.animCtrl.charCtrl = activeCharacter.charCtrl;
        activeCharacter.charCtrl.anim = activeCharacter.animCtrl;
      }

      // Clear stored animations GLB buffer as well
      animationsGlbBuffer = null;

      renderAnimationLibrary();
      renderAnimationsMappingTab();
      renderCustomAnimationsTab();
      applyAnimationsToController();
      updateExportCode();
      showToast('All animations cleared.');
    }
  );
}
// ═══════════════════════════════════════════════════════════
// SIDEBAR CONTROLS SETUP
// ═══════════════════════════════════════════════════════════
function setupSidebarControls() {
  const bindSlider = (id, configKey, isFloat = true, suffix = '') => {
    const slider = document.getElementById(id);
    const valSpan = document.getElementById(`${id}-val`);
    if (!slider) return;
    slider.addEventListener('input', (e) => {
      let val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value);
      if (isFloat) {
        val = Math.round(val * 100) / 100; // Limit decimal noise
      }
      physicsConfig[configKey] = val;
      if (valSpan) {
        valSpan.textContent = (isFloat ? val.toFixed(configKey === 'CAM_FOLLOW_DIST' || configKey === 'SPEED_MULTIPLIER' ? 1 : 2) : val) + suffix;
      }
      if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl[configKey] = val;
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
  bindSlider('slider-speed-mult', 'SPEED_MULTIPLIER', true, 'x');
  bindSlider('slider-cam-dist', 'CAM_FOLLOW_DIST', true, 'm');
  bindSlider('slider-fov-max', 'DYNAMIC_FOV_MAX');

  const camPitchSlider = document.getElementById('slider-cam-pitch');
  const camPitchVal = document.getElementById('slider-cam-pitch-val');
  if (camPitchSlider) {
    camPitchSlider.addEventListener('input', (e) => {
      const deg = Math.round(parseFloat(e.target.value));
      const rad = deg * Math.PI / 180;
      physicsConfig.CAM_FOLLOW_PITCH = rad;
      if (camPitchVal) camPitchVal.textContent = deg + '°';
      if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl.CAM_FOLLOW_PITCH = rad;
      updateExportCode();
    });
  }

  const bindCheckbox = (id, configKey) => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.addEventListener('change', (e) => {
      physicsConfig[configKey] = e.target.checked;
      if (activeCharacter && activeCharacter.charCtrl) {
        if (configKey === 'PLAY_PARTICLES') {
          activeCharacter.charCtrl.playParticles(e.target.checked);
        } else {
          activeCharacter.charCtrl[configKey] = e.target.checked;
        }
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
  const particlesEl = document.getElementById('toggle-particles');
  if (particlesEl) {
    particlesEl.addEventListener('change', (e) => {
      if (!isServerAvailable) { e.target.checked = false; return; }
      physicsConfig.PLAY_PARTICLES = e.target.checked;
      activeCharacter?.charCtrl?.playParticles(e.target.checked);
      updateExportCode();
    });
  }

  // Add custom animation
  document.getElementById('btn-add-custom-anim').addEventListener('click', () => {
    customAnimations.push({ name: 'CUSTOM_ACTION_' + (customAnimations.length + 1), animName: detectedAnimations[0] || 'None', keyTrigger: [] });
    renderCustomAnimationsTab();
  });

  // Single animation add button
  const btnAddSingle = document.getElementById('btn-add-single-anim');
  const singleInput = document.getElementById('single-anim-file-input');
  if (btnAddSingle && singleInput) {
    btnAddSingle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isServerAvailable) { showToast('Server offline. Start the server first (npm start).', true); return; }
      singleInput.click();
    });
    singleInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) addSingleAnimationFile(file);
      singleInput.value = '';
    });
  }

  // Clear character button
  const btnClearChar = document.getElementById('btn-clear-character');
  if (btnClearChar) btnClearChar.addEventListener('click', clearCharacter);

  // Clear all animations button
  const btnClearAllAnims = document.getElementById('btn-clear-all-anims');
  if (btnClearAllAnims) btnClearAllAnims.addEventListener('click', () => {
    if (!isServerAvailable) { showToast('Server offline. Start the server first (npm start).', true); return; }
    clearAllAnimations();
  });

  // Download
  document.getElementById('btn-download').addEventListener('click', downloadControllerFile);

  // Download GLB
  const btnDownloadGlb = document.getElementById('btn-download-glb');
  if (btnDownloadGlb) btnDownloadGlb.addEventListener('click', downloadCharacterGlbFile);

  // Copy Code
  const btnCopy = document.getElementById('btn-copy-code');
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      const codeBox = document.getElementById('export-code');
      if (codeBox) {
        navigator.clipboard.writeText(codeBox.value).then(() => {
          showToast('Code configuration copied to clipboard!');
        }).catch(() => showToast('Failed to copy code.', true));
      }
    });
  }

  // Reset All
  const btnReset = document.getElementById('btn-reset-all');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      localStorage.removeItem('builder_anim_mappings');
      localStorage.removeItem('builder_key_bindings');
      localStorage.removeItem('builder_physics_config');
      localStorage.removeItem('builder_custom_animations');
      
      savedAnimMappings = null;
      keyBindings = JSON.parse(JSON.stringify(DEFAULT_KEY_BINDINGS));
      physicsConfig = JSON.parse(JSON.stringify(DEFAULT_PHYSICS_CONFIG));
      customAnimations = [];

      resetCharacterTransform();

      autoMapAnimations();
      renderAnimationsMappingTab();
      renderCustomAnimationsTab();
      renderKeyBindingsUI();
      syncPhysicsConfigToUI();

      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl.keyBindings = keyBindings;
        Object.keys(physicsConfig).forEach(key => { activeCharacter.charCtrl[key] = physicsConfig[key]; });
      }
      showToast('All configurations reset to defaults!');
    });
  }

  renderKeyBindingsUI();
  injectPhysicsResetButtons();
}

// ═══════════════════════════════════════════════════════════
// PHYSICS RESET BUTTONS
// ═══════════════════════════════════════════════════════════
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

  applySlider('slider-grav', 'GRAV');
  applySlider('slider-jump-pwr', 'JUMP_PWR');
  applySlider('slider-speed-walk', 'SPD_WALK');
  applySlider('slider-speed-sprint', 'SPD_SPRINT');
  applySlider('slider-accel', 'ACCEL');
  applySlider('slider-decel', 'DECEL');
  applySlider('slider-rot', 'ROT_SPD');
  applySlider('slider-speed-mult', 'SPEED_MULTIPLIER', 'x');
  applySlider('slider-cam-dist', 'CAM_FOLLOW_DIST', 'm');
  applySlider('slider-fov-max', 'DYNAMIC_FOV_MAX');

  const camPitchSlider = document.getElementById('slider-cam-pitch');
  const camPitchVal = document.getElementById('slider-cam-pitch-val');
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
      if (activeCharacter && activeCharacter.charCtrl) {
        if (key === 'PLAY_PARTICLES') {
          activeCharacter.charCtrl.playParticles(def);
        } else {
          activeCharacter.charCtrl[key] = def;
        }
      }
      updateExportCode();
    }));
  };

  applyCheckbox('toggle-cam-follow-lock', 'CAM_FOLLOW_LOCK');
  applyCheckbox('toggle-cam-lock-pitch', 'CAM_LOCK_PITCH');
  applyCheckbox('toggle-joystick-lock-x', 'JOYSTICK_LOCK_X');
  applyCheckbox('toggle-dynamic-fov', 'DYNAMIC_FOV');
  applyCheckbox('toggle-double-jump', 'DOUBLE_JUMP_ENABLED');
  applyCheckbox('toggle-air-control', 'AIR_CONTROL');
  applyCheckbox('toggle-particles', 'PLAY_PARTICLES');
}

// ═══════════════════════════════════════════════════════════
// KEY BINDINGS UI
// ═══════════════════════════════════════════════════════════
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
      if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl.keyBindings = keyBindings;
      renderKeyBindingsUI();
      updateExportCode();
    });
  });

  bindKeyCatcherEvents();
}

// Key catcher
let activeCatcherAction = null;

function bindKeyCatcherEvents() {
  const catchers = document.querySelectorAll('.key-catcher');
  catchers.forEach(catcher => {
    catcher.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-key')) {
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
        if (activeCharacter && activeCharacter.charCtrl) activeCharacter.charCtrl.keyBindings = keyBindings;
        updateExportCode();
        return;
      }
      if (activeCatcherAction) document.querySelectorAll('.key-catcher').forEach(c => c.classList.remove('capturing'));
      activeCatcherAction = catcher.dataset.action;
      catcher.classList.add('capturing');
    });
  });
}

window.addEventListener('keydown', (e) => {
  if (!activeCatcherAction) return;
  e.preventDefault();
  const key = e.code;

  if (activeCatcherAction.startsWith('CUSTOM_')) {
    const index = parseInt(activeCatcherAction.split('_')[1]);
    if (!customAnimations[index].keyTrigger.includes(key)) customAnimations[index].keyTrigger.push(key);
    renderCustomAnimationsTab();
  } else {
    if (!keyBindings[activeCatcherAction].includes(key)) keyBindings[activeCatcherAction].push(key);
    renderKeyBindingsUI();
  }

  if (activeCharacter && activeCharacter.charCtrl) {
    activeCharacter.charCtrl.keyBindings = keyBindings;
    applyAnimationsToController();
  }

  document.querySelectorAll('.key-catcher').forEach(c => c.classList.remove('capturing'));
  activeCatcherAction = null;
  updateExportCode();
});

// ═══════════════════════════════════════════════════════════
// DRAG AND DROP
// ═══════════════════════════════════════════════════════════
function setupDragAndDrop() {
  // Character dropzone
  setupDropzone('dropzone-character', 'char-file-input', async (file) => {
    if (!isServerAvailable) { showToast('Server offline. Start the server first (npm start).', true); return; }
    await loadCharacterMeshFile(file);
  });

  // Animations dropzone
  setupDropzone('dropzone-animations', 'anim-file-input', async (file) => {
    if (!isServerAvailable) { showToast('Server offline. Start the server first (npm start).', true); return; }
    await loadAnimationBatchFile(file);
  });
}

function setupDropzone(zoneId, inputId, onFile) {
  const zone = document.getElementById(zoneId);
  const fileInput = document.getElementById(inputId);
  if (!zone || !fileInput) return;

  zone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) onFile(file);
    fileInput.value = '';
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.glb')) {
      onFile(file);
    } else {
      showToast('Please import a valid .glb file', true);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// CODE GENERATOR & EXPORTER
// ═══════════════════════════════════════════════════════════
function updateExportCode() {
  const codeBox = document.getElementById('export-code');
  if (!codeBox) return;

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

  let customsSnippet = '';
  customAnimations.forEach(cust => {
    if (cust.animName !== 'None') {
      customsSnippet += `      // Register custom action: ${cust.name}\n`;
      customsSnippet += `      const anim_${cust.name} = filteredGroups.find(g => cleanAnimName(g.name) === '${cust.animName}');\n`;
      customsSnippet += `      if (anim_${cust.name}) {\n`;
      customsSnippet += `        animCtrl.setAnimation('${cust.name}', anim_${cust.name});\n`;
      customsSnippet += `      }\n`;
      if (cust.keyTrigger.length > 0) {
        customsSnippet += `      charCtrl.keyBindings['${cust.name}'] = ${JSON.stringify(cust.keyTrigger)};\n`;
      }
      customsSnippet += `\n`;
    }
  });

  const configCode = `// 🎮 CUSTOM SETUP CONFIGURATION FOR YOUR APP.JS\n// Copy and paste this loadCharacter function replacement in your app.js:\n\nasync function loadCharacter(scene, shadow, camera, usePhysics) {\n  return setupCharacter(scene, camera, usePhysics, {\n    shadow,\n    assetsPath: 'assets/',\n    filename: 'character_animated.glb',\n    keys: ${JSON.stringify(keyBindings, null, 4).replace(/\n/g, '\n    ')},\n    config: ${JSON.stringify(physicsConfig, null, 4).replace(/\n/g, '\n    ')},\n    configure: ({ animCtrl, charCtrl, filteredGroups }) => {\n${mappingsSnippet}${customsSnippet}    }\n  });\n}`;

  codeBox.value = configCode;
  savePreferences();
}

async function downloadCharacterGlbFile() {
  if (!originalCharacterGlbBuffer && !characterGlbBuffer) {
    showToast('No character loaded to download!', true);
    return;
  }

  showLoading('Generating clean character GLB with active animations...');
  try {
    let resultBuffer = characterGlbBuffer;

    if (isServerAvailable && (originalCharacterGlbBuffer || characterGlbBuffer)) {
      const baseBuffer = originalCharacterGlbBuffer || characterGlbBuffer;
      const formData = new FormData();
      formData.append('character', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');

      if (animationsGlbBuffer && animationsGlbBuffer.byteLength > 0) {
        formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations.glb');
      }

      formData.append('options', JSON.stringify(getMergeOptions({ removeExistingAnimations: true })));

      const res = await fetch('/api/merge', {
        method: 'POST',
        body: formData
      });

      if (res.ok) {
        resultBuffer = await res.arrayBuffer();
      } else {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Server error during GLB generation');
      }
    }

    const blob = new Blob([resultBuffer], { type: 'model/gltf-binary' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'character_animated.glb';
    link.click();
    hideLoading();
    showToast('Downloaded character_animated.glb!');
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast('Failed to download character GLB: ' + err.message, true);
  }
}

async function downloadControllerFile() {
  showLoading('Generating custom character-controller.js…');
  try {
    const response = await fetch('js/character-controller.js');
    if (!response.ok) throw new Error('Could not load original character-controller.js base.');
    let sourceText = await response.text();

    const configMatch = sourceText.match(/const DEFAULT_CHAR_CONFIG = \{[\s\S]*?\};/);
    if (configMatch) {
      const newConfigBlock = `const DEFAULT_CHAR_CONFIG = {
  KEYS: ${JSON.stringify(keyBindings, null, 4).replace(/\n/g, '\n  ')},
  PHYSICS: ${JSON.stringify(physicsConfig, null, 4).replace(/\n/g, '\n  ')},
  TOUCH: {
    zoneId: 'joystick-zone', ringId: 'joystick-ring', knobId: 'joystick-knob',
    buttons: { 'btn-sprint': 'ShiftLeft', 'btn-jump': 'Space', 'btn-roll': 'KeyR', 'btn-crouch': 'ControlLeft', 'btn-act': 'KeyF', 'btn-spell': 'KeyE' }
  }
};`;
      const _sig = JSON.stringify(physicsConfig);
      const seedBlock = `\n(function() {\n  var _sig = ${JSON.stringify(_sig)};\n  if (localStorage.getItem('bcc_cfg_sig') !== _sig) {\n    var P = DEFAULT_CHAR_CONFIG.PHYSICS;\n    localStorage.setItem('air-control-enabled', String(P.AIR_CONTROL));\n    localStorage.setItem('cam-follow-lock', String(P.CAM_FOLLOW_LOCK));\n    localStorage.setItem('dynamic-fov', String(P.DYNAMIC_FOV));\n    localStorage.setItem('play-particles', String(P.PLAY_PARTICLES));\n    localStorage.setItem('bcc_cfg_sig', _sig);\n  }\n})();`;
      sourceText = sourceText.replace(configMatch[0], newConfigBlock + seedBlock);
    }

    const setupHookMatch = sourceText.match(/\/\/ Allow custom remapping of animations\/controls or extra setup from app/);
    if (setupHookMatch) {
      let mappingInjection = `// Custom Exporter Animations Remappings\n`;
      Object.keys(animMappings).forEach(key => {
        const m = animMappings[key];
        if (m && m.animName !== 'None') {
          mappingInjection += `  const anim_${key} = filteredGroups.find(g => cleanAnimName(g.name) === '${m.animName}');\n`;
          mappingInjection += `  if (anim_${key}) { animCtrl.setAnimation('${key}', anim_${key}); animCtrl.setAnimationRanges('${key}', ${m.from}, ${m.to}); }\n`;
        }
      });
      customAnimations.forEach(cust => {
        if (cust.animName !== 'None') {
          mappingInjection += `  const anim_${cust.name} = filteredGroups.find(g => cleanAnimName(g.name) === '${cust.animName}');\n`;
          mappingInjection += `  if (anim_${cust.name}) { animCtrl.setAnimation('${cust.name}', anim_${cust.name}); }\n`;
          if (cust.keyTrigger.length > 0) mappingInjection += `  charCtrl.keyBindings['${cust.name}'] = ${JSON.stringify(cust.keyTrigger)};\n`;
        }
      });
      sourceText = sourceText.replace(setupHookMatch[0], mappingInjection + `\n  ` + setupHookMatch[0]);
    }

    const blob = new Blob([sourceText], { type: 'application/javascript' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'custom-character-controller.js';
    link.click();

    hideLoading();
    showToast('Downloaded custom-character-controller.js!');
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast('Failed to generate custom controller file: ' + err.message, true);
  }
}
