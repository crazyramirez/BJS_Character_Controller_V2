'use strict';

// ═══════════════════════════════════════════════════════════
// GLOBAL STATE & CONSTANTS
// ═══════════════════════════════════════════════════════════
let engine, scene, camera, shadowGenerator;
let activeCharacter = null; // { playerCapsule, animCtrl, charCtrl, rawAnimationGroups, rawMeshes, charRoot }
let testLabObserver = null;
let activeTestScenario = 'studio';

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
let animationEvents = {};

const DEFAULT_KEY_BINDINGS = JSON.parse(JSON.stringify(keyBindings));
const DEFAULT_PHYSICS_CONFIG = JSON.parse(JSON.stringify(physicsConfig));
let savedAnimMappings = null;
let activeControllerPreset = localStorage.getItem('builder_controller_preset') || 'balanced';

const CONTROLLER_PRESETS = [
  {
    id: 'balanced',
    name: 'Balanced Adventure',
    description: 'Readable third-person movement for exploration, combat tests and general demos.',
    tags: ['default', 'third person'],
    config: {
      GRAV: 22, JUMP_PWR: 9.5, SPD_WALK: 2.5, SPD_JOG: 3.0, SPD_SPRINT: 5.0,
      ACCEL: 14, DECEL: 16, ROT_SPD: 40, AIR_CONTROL: false,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.10, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 1.047, CAM_FOLLOW_DIST: 8.0, DOUBLE_JUMP_ENABLED: true,
      SPEED_MULTIPLIER: 1.0
    }
  },
  {
    id: 'action',
    name: 'Action Combat',
    description: 'Tighter acceleration, shorter camera distance and heavier landings for responsive fights.',
    tags: ['combat', 'snappy'],
    config: {
      GRAV: 28, JUMP_PWR: 9.0, SPD_WALK: 2.7, SPD_JOG: 3.2, SPD_SPRINT: 5.8,
      ACCEL: 24, DECEL: 26, ROT_SPD: 70, AIR_CONTROL: false,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.08, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 0.96, CAM_FOLLOW_DIST: 6.2, DOUBLE_JUMP_ENABLED: false,
      SPEED_MULTIPLIER: 1.0
    }
  },
  {
    id: 'platformer',
    name: 'Arcade Platformer',
    description: 'Higher jump, stronger air steering and brighter motion feedback for traversal-heavy games.',
    tags: ['jump', 'air control'],
    config: {
      GRAV: 24, JUMP_PWR: 13.5, SPD_WALK: 3.0, SPD_JOG: 3.8, SPD_SPRINT: 6.6,
      ACCEL: 20, DECEL: 18, ROT_SPD: 58, AIR_CONTROL: true,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.16, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 1.02, CAM_FOLLOW_DIST: 7.0, DOUBLE_JUMP_ENABLED: true,
      SPEED_MULTIPLIER: 1.0
    }
  },
  {
    id: 'cinematic',
    name: 'Cinematic Walkthrough',
    description: 'Slower motion, softer turns and wider camera framing for showcases and inspection.',
    tags: ['showcase', 'smooth'],
    config: {
      GRAV: 20, JUMP_PWR: 7.5, SPD_WALK: 1.6, SPD_JOG: 2.2, SPD_SPRINT: 3.8,
      ACCEL: 8, DECEL: 10, ROT_SPD: 26, AIR_CONTROL: false,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.04, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 1.12, CAM_FOLLOW_DIST: 9.5, DOUBLE_JUMP_ENABLED: false,
      SPEED_MULTIPLIER: 1.0
    }
  }
];

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
  ARM_SPLAY_ANGLE: 0.0,
  LEG_SPREAD_ANGLE: 0.0,
  SPINE_STRAIGHTEN_ANGLE: 0.0,
  HIPS_TILT_ANGLE: 0.0
};
const DEFAULT_CHAR_TRANSFORM = JSON.parse(JSON.stringify(charTransformConfig));

// ── Bone role classification (posture/spread sliders) ───────────────────────
// Normalized like merge_api's aliasNorm so CC/AccuRig, UE, Unity, Biped and
// Rigify names classify the same as Mixamo ones.
function boneRoleNorm(name) {
  let n = (name || '').toLowerCase();
  if (n.includes(':')) n = n.split(':').pop();
  n = n.replace(/_\d+$/, ''); // BJS numeric suffix (Hips_66) + spine_01 → spine (covered by sets)
  n = n.replace(/^j_?bip_?c_?/, '').replace(/^j_?bip_?([lr])_?/, '$1_');
  n = n.replace(/^(valvebiped\.?bip\d+|cc_base|mixamorig\d*|armature|bip\d+|biped|def|root|gltf_created_\d+)[:_\-. ]+/, '');
  n = n.replace(/^mixamorig\d*/, '');
  n = n.replace(/\.([lr])$/, '$1');
  return n.replace(/[:_\-.\s]/g, '');
}

const BONE_ROLE_SETS = {
  armL: new Set(['leftshoulder', 'leftcollar', 'claviclel', 'lclavicle', 'shoulderl', 'lshoulder', 'collarl',
    'leftarm', 'leftupperarm', 'upperarml', 'lupperarm', 'arml', 'larm']),
  armR: new Set(['rightshoulder', 'rightcollar', 'clavicler', 'rclavicle', 'shoulderr', 'rshoulder', 'collarr',
    'rightarm', 'rightupperarm', 'upperarmr', 'rupperarm', 'armr', 'rarm']),
  legL: new Set(['leftupleg', 'leftupperleg', 'thighl', 'lthigh', 'upperlegl', 'leftthigh', 'hipl']),
  legR: new Set(['rightupleg', 'rightupperleg', 'thighr', 'rthigh', 'upperlegr', 'rightthigh', 'hipr']),
  spine: new Set(['spine', 'spine1', 'spine2', 'spine3', 'spine01', 'spine02', 'spine03',
    'waist', 'chest', 'upperchest', 'lowerback']),
  hips: new Set(['hips', 'hip', 'pelvis']),
};

function boneRole(name) {
  const n = boneRoleNorm(name);
  for (const [role, set] of Object.entries(BONE_ROLE_SETS)) {
    if (set.has(n)) return role;
  }
  return null;
}

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
    const events = localStorage.getItem('builder_animation_events');
    if (events) animationEvents = JSON.parse(events);

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
    localStorage.setItem('builder_animation_events', JSON.stringify(animationEvents));
    localStorage.setItem('builder_controller_preset', activeControllerPreset);
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

  // Scale the capsule mesh itself; the wrapper (child of the capsule) is counter-scaled
  // so the character's final world scale stays (sx, sy, sz)
  const capsule = activeCharacter.playerCapsule;
  const widthScale = Math.max(sx, sz);
  capsule.scaling.set(widthScale, sy, widthScale);

  activeCharacter.charTransformWrapper.scaling.set(sx / widthScale, 1, sz / widthScale);

  // Visual root offset in capsule-local space (capsule scaling multiplies it back to world units)
  activeCharacter.charTransformWrapper.position.set(-px * sx / widthScale, -py, -pz * sz / widthScale);

  // Collision ellipsoid is in absolute units — not affected by mesh scaling, set explicitly
  if (capsule.ellipsoid) {
    capsule.ellipsoid.set(0.35 * widthScale, 0.96 * sy, 0.35 * widthScale);
  }
  // Keep controller stand/crouch heights in sync so its per-frame ellipsoid lerp targets the scaled size
  const ctrl = activeCharacter.charCtrl;
  if (ctrl) {
    ctrl._standEllipsoidY = 0.96 * sy;
    ctrl._standEllipsoidWidth = 0.35 * widthScale;
    ctrl._crouchEllipsoidY = 0.55 * sy;
    ctrl._capScaleY = sy;
    ctrl._capScaleW = widthScale;

    // Update Havok physics shapes dynamically if enabled
    if (ctrl.usePhysics && ctrl.physicsBody) {
      if (ctrl._standShape) ctrl._standShape.dispose();
      if (ctrl._crouchShape) ctrl._crouchShape.dispose();

      const physScaleY = sy;
      const physScaleW = widthScale;

      const standStart = new BABYLON.Vector3(0, -0.55 * physScaleY, 0);
      const standEnd = new BABYLON.Vector3(0, 0.55 * physScaleY, 0);
      ctrl._standShape = new BABYLON.PhysicsShapeCapsule(standStart, standEnd, 0.35 * physScaleW, scene);

      const crouchStart = new BABYLON.Vector3(0, -0.55 * physScaleY, 0);
      const crouchEnd = new BABYLON.Vector3(0, -0.15 * physScaleY, 0);
      ctrl._crouchShape = new BABYLON.PhysicsShapeCapsule(crouchStart, crouchEnd, 0.35 * physScaleW, scene);

      ctrl._standShape.material = { friction: 0, restitution: 0 };
      ctrl._crouchShape.material = { friction: 0, restitution: 0 };

      const isTempStandingAction = ctrl._isInAction() && (ctrl.state === 'SPELL_ENTER' || ctrl.state === 'SPELL_SHOOT' || ctrl.state === 'SPELL_EXIT' || ctrl.state === 'INTERACT');
      const useCrouchHeight = (ctrl.crouching && !isTempStandingAction) || ctrl.state === 'ROLL';
      ctrl.physicsBody.shape = useCrouchHeight ? ctrl._crouchShape : ctrl._standShape;

      ctrl.physicsBody.setMassProperties({
        mass: 1,
        inertia: new BABYLON.Vector3(0, 0, 0)
      });
    }
  }
}

function syncCharTransformToUI() {
  const setSlider = (id, val, suffix = '') => {
    const el = document.getElementById(id);
    const valEl = document.getElementById('val-' + id.substring(7));
    if (el) {
      const min = parseFloat(el.min);
      const max = parseFloat(el.max);
      if (val < min) {
        el.min = id.includes('scale')
          ? Math.max(0.001, Math.floor(val * 1000) / 1000).toString()
          : (Math.floor(val * 2) / 2).toString();
      }
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
  setSlider('slider-arm-splay', charTransformConfig.ARM_SPLAY_ANGLE, '°');
  setSlider('slider-leg-spread', charTransformConfig.LEG_SPREAD_ANGLE, '°');
  setSlider('slider-spine-straighten', charTransformConfig.SPINE_STRAIGHTEN_ANGLE, '°');
  setSlider('slider-hips-tilt', charTransformConfig.HIPS_TILT_ANGLE, '°');
}

function resetCharacterTransform() {
  charTransformConfig = JSON.parse(JSON.stringify(DEFAULT_CHAR_TRANSFORM));

  // Reset slider min/max ranges to default
  const sU = document.getElementById('slider-scale-uniform');
  const sX = document.getElementById('slider-scale-x');
  const sY = document.getElementById('slider-scale-y');
  const sZ = document.getElementById('slider-scale-z');
  if (sU) { sU.min = "0.01"; sU.max = "5.0"; }
  if (sX) { sX.min = "0.01"; sX.max = "5.0"; }
  if (sY) { sY.min = "0.01"; sY.max = "5.0"; }
  if (sZ) { sZ.min = "0.01"; sZ.max = "5.0"; }

  const pX = document.getElementById('slider-pivot-x');
  const pY = document.getElementById('slider-pivot-y');
  const pZ = document.getElementById('slider-pivot-z');
  if (pX) { pX.min = "-2.0"; pX.max = "2.0"; }
  if (pY) { pY.min = "-2.0"; pY.max = "2.0"; }
  if (pZ) { pZ.min = "-2.0"; pZ.max = "2.0"; }

  const armS = document.getElementById('slider-arm-spread');
  const armSplay = document.getElementById('slider-arm-splay');
  const legS = document.getElementById('slider-leg-spread');
  const spineS = document.getElementById('slider-spine-straighten');
  const hipsT = document.getElementById('slider-hips-tilt');
  if (armS) { armS.min = "-10"; armS.max = "10"; }
  if (armSplay) { armSplay.min = "-30"; armSplay.max = "30"; }
  if (legS) { legS.min = "-10"; legS.max = "10"; }
  if (spineS) { spineS.min = "-30"; spineS.max = "30"; }
  if (hipsT) { hipsT.min = "-30"; hipsT.max = "30"; }

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
  const armSplaySlider = document.getElementById('slider-arm-splay');
  const legSpreadSlider = document.getElementById('slider-leg-spread');
  const spineStraightenSlider = document.getElementById('slider-spine-straighten');
  const hipsTiltSlider = document.getElementById('slider-hips-tilt');
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
    charTransformConfig.ARM_SPLAY_ANGLE = armSplaySlider ? parseFloat(armSplaySlider.value) : 0.0;
    charTransformConfig.LEG_SPREAD_ANGLE = legSpreadSlider ? parseFloat(legSpreadSlider.value) : 0.0;
    charTransformConfig.SPINE_STRAIGHTEN_ANGLE = spineStraightenSlider ? parseFloat(spineStraightenSlider.value) : 0.0;
    charTransformConfig.HIPS_TILT_ANGLE = hipsTiltSlider ? parseFloat(hipsTiltSlider.value) : 0.0;

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
  armSplaySlider?.addEventListener('input', onSliderChange);
  legSpreadSlider?.addEventListener('input', onSliderChange);
  spineStraightenSlider?.addEventListener('input', onSliderChange);
  hipsTiltSlider?.addEventListener('input', onSliderChange);

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
    ARM_SPLAY_ANGLE: charTransformConfig.ARM_SPLAY_ANGLE,
    LEG_SPREAD_ANGLE: charTransformConfig.LEG_SPREAD_ANGLE,
    SPINE_STRAIGHTEN_ANGLE: charTransformConfig.SPINE_STRAIGHTEN_ANGLE,
    HIPS_TILT_ANGLE: charTransformConfig.HIPS_TILT_ANGLE,
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
  setupAutoRigControls();
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
      if (isTyping || activeCatcherAction !== null || autoRigState) return false;
      return originalIsPressed.call(this, action);
    };

    const originalKeyDown = CharCtrl.prototype._keyDown;
    CharCtrl.prototype._keyDown = function (code) {
      this._previewAnim = null; // Clear active animation preview
      this._previewLocoSpeed = null;
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA'
      );
      // Rig adjust mode: ignore all controller keys — skeleton must stay in T-pose
      if (isTyping || activeCatcherAction !== null || autoRigState) { this.keys = {}; return; }

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
        this._previewLocoSpeed = null;
      }
      // Locomotion preview (test lab Idle/Walk/Sprint): drive the real blend
      // tree with a pinned speed. Playing the loop clips directly while the
      // blend tree also weights them double-drives the skeleton and deforms it.
      if (this._previewLocoSpeed != null) {
        this.anim.play('Locomotion', true, 0.25);
        this.anim.g.get('Locomotion')?.updateSpeed(this._previewLocoSpeed);
        return;
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
function applyPhysicsConfigToActiveController() {
  if (!activeCharacter?.charCtrl) return;
  Object.keys(physicsConfig).forEach(key => {
    if (key === 'PLAY_PARTICLES') activeCharacter.charCtrl.playParticles(physicsConfig.PLAY_PARTICLES);
    else activeCharacter.charCtrl[key] = physicsConfig[key];
  });
}

function renderControllerPresets() {
  const grid = document.getElementById('controller-presets');
  if (!grid) return;
  grid.innerHTML = CONTROLLER_PRESETS.map(preset => `
    <button class="preset-card ${preset.id === activeControllerPreset ? 'active' : ''}" data-preset="${escapeHtml(preset.id)}">
      <strong>${escapeHtml(preset.name)}</strong>
      <p>${escapeHtml(preset.description)}</p>
      <span class="preset-tags">
        ${preset.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}
      </span>
    </button>
  `).join('');

  grid.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => applyControllerPreset(card.dataset.preset));
  });
}

function applyControllerPreset(presetId) {
  const preset = CONTROLLER_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  physicsConfig = { ...physicsConfig, ...preset.config };
  activeControllerPreset = preset.id;
  syncPhysicsConfigToUI();
  applyPhysicsConfigToActiveController();
  renderControllerPresets();
  updateExportCode();
  updateTestLabMetrics();
  showToast(`Applied preset: ${preset.name}`);
}

function activateBuilderTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

function previewMappedAnimation(key, fallbackState = null) {
  if (!activeCharacter?.charCtrl) {
    showToast('Load a character first.', true);
    return;
  }
  const mapping = animMappings[key];
  const ctrl = activeCharacter.charCtrl;
  if (mapping?.animName && mapping.animName !== 'None') {
    ctrl.state = fallbackState || (window.S ? window.S.IDLE : 'IDLE');
    ctrl._previewLocoSpeed = null;
    // Play the mapped KEY (its own clone with the mapped frame range), not the
    // raw clip — the raw group can be shared with the blend tree loops.
    ctrl._previewAnim = ctrl.anim?.has(key) ? key : mapping.animName;
    showToast(`Preview: ${key}`);
    return;
  }
  if (fallbackState && ctrl._setState) {
    ctrl._previewAnim = null;
    ctrl._previewLocoSpeed = null;
    ctrl._setState(fallbackState);
    showToast(`Preview state: ${fallbackState}`);
  } else {
    showToast(`No mapped animation for ${key}.`, true);
  }
}

function runControllerTestAction(action) {
  if (!activeCharacter?.charCtrl) {
    showToast('Load a character first.', true);
    return;
  }
  const ctrl = activeCharacter.charCtrl;
  const Sx = window.S || {};
  ctrl._previewAnim = null;
  ctrl._previewLocoSpeed = null;

  // Idle/Walk/Sprint drive the real Locomotion blend tree with a pinned speed
  // (exactly what the game does) instead of playing the loop clips directly.
  if (action === 'idle') {
    ctrl.speed = 0;
    ctrl.crouching = false;
    ctrl._previewLocoSpeed = 0;
    ctrl._setState?.(Sx.IDLE || 'IDLE');
    showToast('Preview: Idle (blend tree)');
  } else if (action === 'walk') {
    ctrl.crouching = false;
    ctrl._previewLocoSpeed = ctrl.SPD_WALK || physicsConfig.SPD_WALK;
    ctrl._setState?.(Sx.WALK || 'WALK');
    showToast('Preview: Walk (blend tree)');
  } else if (action === 'sprint') {
    ctrl.crouching = false;
    ctrl._previewLocoSpeed = ctrl.SPD_SPRINT || physicsConfig.SPD_SPRINT;
    ctrl._setState?.(Sx.SPRINT || 'SPRINT');
    showToast('Preview: Sprint (blend tree)');
  } else if (action === 'jump') {
    if (typeof ctrl._jump === 'function') ctrl._jump();
    else previewMappedAnimation('Jump_Start', Sx.JUMP_START || 'JUMP_START');
  } else if (action === 'roll') {
    if (typeof ctrl._roll === 'function') ctrl._roll();
    else previewMappedAnimation('Roll', Sx.ROLL || 'ROLL');
  } else if (action === 'crouch') {
    ctrl.crouching = !ctrl.crouching;
    previewMappedAnimation(ctrl.crouching ? 'Crouch_Idle_Loop' : 'Idle_Loop', ctrl.crouching ? (Sx.CROUCH_IDLE || 'CROUCH_IDLE') : (Sx.IDLE || 'IDLE'));
  }
  updateTestLabMetrics();
}

function applyTestScenario(scenario) {
  activeTestScenario = scenario;
  document.querySelectorAll('.scenario-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.testScenario === scenario);
  });

  const ctrl = activeCharacter?.charCtrl;
  if (!camera) {
    updateTestLabMetrics();
    return;
  }

  if (scenario === 'studio') {
    if (ctrl) ctrl.CAM_FOLLOW_DIST = physicsConfig.CAM_FOLLOW_DIST;
    camera.radius = 6.5;
    camera.beta = 1.25;
    camera.alpha = -Math.PI / 2;
    runControllerTestAction('idle');
  } else if (scenario === 'motion') {
    if (ctrl) ctrl.CAM_FOLLOW_DIST = 7.5;
    camera.radius = 7.5;
    camera.beta = 1.08;
    runControllerTestAction('sprint');
  } else if (scenario === 'air') {
    if (ctrl) ctrl.CAM_FOLLOW_DIST = 7.0;
    camera.radius = 7.0;
    camera.beta = 1.15;
    runControllerTestAction('jump');
  } else if (scenario === 'close') {
    if (ctrl) ctrl.CAM_FOLLOW_DIST = 3.4;
    camera.radius = 3.4;
    camera.beta = 1.18;
    runControllerTestAction('idle');
  }
  updateTestLabMetrics();
}

function updateTestLabMetrics() {
  const ctrl = activeCharacter?.charCtrl;
  const stateEl = document.getElementById('metric-state');
  const speedEl = document.getElementById('metric-speed');
  const groundedEl = document.getElementById('metric-grounded');
  const presetEl = document.getElementById('metric-preset');
  const animEl = document.getElementById('metric-animation');
  const crouchEl = document.getElementById('metric-crouch');
  const rollEl = document.getElementById('metric-roll');
  const cameraEl = document.getElementById('metric-camera');
  if (stateEl) stateEl.textContent = ctrl?.state || '-';
  if (speedEl) speedEl.textContent = Number(ctrl?.speed || 0).toFixed(2);
  if (groundedEl) groundedEl.textContent = ctrl ? (ctrl.grounded ? 'yes' : 'no') : '-';
  if (presetEl) {
    const preset = CONTROLLER_PRESETS.find(p => p.id === activeControllerPreset);
    presetEl.textContent = preset?.name || activeControllerPreset || '-';
  }
  if (animEl) animEl.textContent = activeCharacter?.animCtrl?.curName || ctrl?._previewAnim || '-';
  if (crouchEl) crouchEl.textContent = ctrl ? (ctrl.crouching ? 'on' : 'off') : '-';
  if (rollEl) rollEl.textContent = ctrl ? (ctrl._rollActive ? 'active' : 'ready') : '-';
  if (cameraEl) cameraEl.textContent = camera ? `${camera.radius.toFixed(1)}m / ${Math.round(camera.beta * 180 / Math.PI)}deg` : '-';
}

function startTestLabMetrics() {
  if (!scene || testLabObserver) return;
  testLabObserver = scene.onBeforeRenderObservable.add(updateTestLabMetrics);
}

function autoFitCharacterScaleFromHealth() {
  const height = Number(skeletonInfo?.health?.metrics?.height);
  if (!Number.isFinite(height) || height <= 0) {
    showToast('No reliable height metric available.', true);
    return;
  }
  const targetHeight = 1.8;
  const scale = Math.max(0.001, Math.min(20, targetHeight / height));
  charTransformConfig.UNIFORM_SCALE = true;
  charTransformConfig.SCALE_UNIFORM = scale;
  charTransformConfig.SCALE_X = scale;
  charTransformConfig.SCALE_Y = scale;
  charTransformConfig.SCALE_Z = scale;
  syncCharTransformToUI();
  applyLiveTransformations();
  updateExportCode();
  showToast(`Visual scale fitted to ${targetHeight.toFixed(1)} units.`);
}

function handleHealthAction(action) {
  if (action === 'autorig') startAutoRigAdjust();
  else if (action === 'animations') activateBuilderTab('animations');
  else if (action === 'physics') activateBuilderTab('physics');
  else if (action === 'scale') {
    activateBuilderTab('model');
    autoFitCharacterScaleFromHealth();
  }
}

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
  platform.position.set(7, 0.25, 5);
  platform.checkCollisions = true;
  platform.material = propMat;
  platform.receiveShadows = true;
  shadowGenerator.addShadowCaster(platform);

  const ramp = BABYLON.MeshBuilder.CreateBox('ramp', { width: 6, height: 0.3, depth: 6 }, scene);
  ramp.position.set(-6, 0.5, 4);
  ramp.rotation.x = Math.PI / 10;
  ramp.checkCollisions = true;
  ramp.material = propMat;
  ramp.receiveShadows = true;
  shadowGenerator.addShadowCaster(ramp);

  for (let i = 0; i < 15; i++) {
    const step = BABYLON.MeshBuilder.CreateBox(`step_${i}`, { width: 7, height: 0.2, depth: 0.5 }, scene);
    step.position.set(0, 0.1 + 0.2 * i, 8 + 0.4 * i);
    step.checkCollisions = true;
    step.material = propMat;
    step.receiveShadows = true;
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
// FBX → GLB CONVERSION (server-side via fbx2gltf)
// ═══════════════════════════════════════════════════════════
function isFbxFile(file) {
  return /\.fbx$/i.test(file.name);
}

// Converts an FBX File to a GLB File via /api/convert-fbx.
// Returns the original file untouched if it isn't FBX.
async function maybeConvertFbxFile(file) {
  if (!isFbxFile(file)) return file;
  if (!isServerAvailable) {
    throw new Error('FBX import requires the server. Start it first (npm start).');
  }
  showLoading(`Converting ${file.name} to GLB…`);
  const formData = new FormData();
  formData.append('file', file, file.name);
  const res = await fetch('/api/convert-fbx', { method: 'POST', body: formData });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(errJson.error || 'FBX conversion failed on server');
  }
  const glbBuffer = await res.arrayBuffer();
  return new File([glbBuffer], file.name.replace(/\.fbx$/i, '.glb'), { type: 'model/gltf-binary' });
}

// ═══════════════════════════════════════════════════════════
// CHARACTER MESH LOADER (primary import)
// ═══════════════════════════════════════════════════════════
async function loadCharacterMeshFile(file, preloadedBuffer = null) {
  if (!preloadedBuffer && isFbxFile(file)) {
    try {
      file = await maybeConvertFbxFile(file);
    } catch (err) {
      hideLoading();
      showToast(err.message, true);
      return;
    }
  }
  if (!preloadedBuffer) {
    resetCharacterTransform();
    animationsGlbBuffer = null;
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

    // No usable animation set in imported character (none, or a single clip
    // like a mixamo.com export / t-pose) → use default animations.glb
    if (!animationsGlbBuffer && detectedAnimations.length <= 1) {
      try {
        const animRes = await fetch('assets/animations.glb');
        if (animRes.ok) {
          animationsGlbBuffer = await animRes.arrayBuffer();
          showToast(detectedAnimations.length === 0
            ? 'No animations in character — using default animations.glb'
            : 'Only one animation in character — adding default animations.glb');
        } else {
          console.warn('assets/animations.glb not found, skipping default animations.');
        }
      } catch (e) {
        console.warn('Could not fetch default animations.glb:', e);
      }
    }

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

  if (isFbxFile(file)) {
    try {
      file = await maybeConvertFbxFile(file);
    } catch (err) {
      hideLoading();
      showToast(err.message, true);
      return;
    }
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
  // Leave auto-rig adjust mode (restores hidden scene meshes, disposes markers/gizmo)
  // before the character the markers are parented to gets disposed.
  cancelAutoRigAdjust();

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
    m.checkCollisions = false; // Prevent self-collision with the player capsule which causes jitter
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

  // Bind-pose local axes per posture-relevant bone. Offsets must rotate about
  // WORLD axes (X = pitch, Y = splay, Z = spread). Mixamo binds are
  // identity-ish (local ≈ world), but CC/AccuRig/UE/Unity rigs carry joint
  // orients — the world axis has to be converted into each bone's frame.
  const boneOffsetAxes = new Map(); // node.uniqueId → { role, x, y, z }
  scene.skeletons.forEach(skel => {
    skel.bones.forEach(bone => {
      const node = bone.getTransformNode();
      if (!node) return;
      const role = boneRole(bone.name || node.name || '');
      if (!role || boneOffsetAxes.has(node.uniqueId)) return;
      // CC rigs have Hip (root) AND Pelvis (child): tilt only the root,
      // otherwise the offset doubles down the chain.
      if (role === 'hips' && boneRole(node.parent?.name || '') === 'hips') return;
      node.computeWorldMatrix(true);
      const wq = node.absoluteRotationQuaternion?.clone() || BABYLON.Quaternion.Identity();
      const inv = BABYLON.Quaternion.Inverse(wq);
      const toLocal = (axis) => {
        const out = new BABYLON.Vector3();
        axis.rotateByQuaternionToRef(inv, out);
        return out.normalize();
      };
      // Spine root (first spine bone above the hips) counters the hips tilt
      let ancestorRole = null;
      for (let p = node.parent; p; p = p.parent) {
        ancestorRole = boneRole(p.name || '');
        if (ancestorRole) break;
      }
      boneOffsetAxes.set(node.uniqueId, {
        role,
        isSpineRoot: role === 'spine' && ancestorRole === 'hips',
        x: toLocal(BABYLON.Axis.X),
        y: toLocal(BABYLON.Axis.Y),
        z: toLocal(BABYLON.Axis.Z),
      });
    });
  });

  // Set up observable to apply real-time bone rotation offsets (posture sliders)
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
    const armSplay = charTransformConfig.ARM_SPLAY_ANGLE || 0;
    const legAngle = charTransformConfig.LEG_SPREAD_ANGLE || 0;
    const spineAngle = charTransformConfig.SPINE_STRAIGHTEN_ANGLE || 0;
    const hipsTilt = charTransformConfig.HIPS_TILT_ANGLE || 0;

    // 2. Loop through character bones and apply offsets about bind-world axes
    scene.skeletons.forEach(skel => {
      skel.bones.forEach(bone => {
        const node = bone.getTransformNode();
        if (!node || !node.rotationQuaternion) return;
        const axes = boneOffsetAxes.get(node.uniqueId);
        if (!axes) return;

        if (!animatedNodes.has(node.uniqueId)) {
          const origRot = originalBoneRotations.get(node.uniqueId);
          if (origRot) {
            node.rotationQuaternion.copyFrom(origRot);
          }
        }

        const apply = (axis, deg) => {
          if (deg === 0) return;
          const q = BABYLON.Quaternion.RotationAxis(axis, deg * Math.PI / 180);
          node.rotationQuaternion.multiplyToRef(q, node.rotationQuaternion);
        };

        switch (axes.role) {
          case 'armL':
            apply(axes.z, armAngle);
            apply(axes.y, -armSplay);
            break;
          case 'armR':
            apply(axes.z, -armAngle);
            apply(axes.y, armSplay);
            break;
          case 'legL':
            apply(axes.z, -legAngle);
            apply(axes.x, -hipsTilt); // counter: feet keep world orientation
            break;
          case 'legR':
            apply(axes.z, legAngle);
            apply(axes.x, -hipsTilt);
            break;
          case 'spine':
            apply(axes.x, spineAngle);
            if (axes.isSpineRoot) apply(axes.x, -hipsTilt); // counter: torso stays
            break;
          case 'hips':
            apply(axes.x, hipsTilt);
            break;
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
    if (autoRigState) return; // rig mode: user pans freely (right-drag), don't recenter
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
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSkeletonHealth(health) {
  const el = document.getElementById('skeleton-health');
  if (!el) return;
  if (!health) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const labels = {
    excellent: 'Excellent',
    good: 'Good',
    'needs-review': 'Needs Review',
    blocked: 'Blocked'
  };
  const m = health.metrics || {};
  const height = Number.isFinite(Number(m.height)) ? Number(m.height).toFixed(2) : 'n/a';
  const bounds = Array.isArray(m.boundsSize)
    ? m.boundsSize.map(v => Number(v).toFixed(2)).join(' x ')
    : 'n/a';
  const checks = (health.checks || []).slice(0, 6);
  const issueCount = (health.checks || []).filter(c => c.severity === 'warn' || c.severity === 'error').length;
  const summary = issueCount
    ? `${issueCount} issue${issueCount !== 1 ? 's' : ''} found. Review the notes before exporting or retargeting.`
    : 'Ready for controller mapping, retargeting and export.';
  const actions = [];
  if (!skeletonInfo?.hasSkin || (health.missingBones || []).some(b => b.critical)) {
    actions.push({ action: 'autorig', label: skeletonInfo?.hasSkin ? 'Adjust Rig' : 'Start Auto-Rig' });
  }
  if (Number(m.height) > 5 || (Number(m.height) > 0 && Number(m.height) < 0.5)) {
    actions.push({ action: 'scale', label: 'Auto-Fit Scale' });
  }
  if (!m.animationCount) actions.push({ action: 'animations', label: 'Map Animations' });
  actions.push({ action: 'physics', label: 'Tune Controller' });

  el.innerHTML = `
    <div class="health-head">
      <div class="health-score ${escapeHtml(health.status)}">${Math.round(health.score || 0)}</div>
      <div>
        <div class="health-title">
          <strong>Rig Health Check</strong>
          <span class="health-status">${escapeHtml(labels[health.status] || health.status || 'Unknown')}</span>
        </div>
        <div class="health-summary">${escapeHtml(summary)} Humanoid coverage: ${Math.round(health.coverage || 0)}%.</div>
      </div>
    </div>
    <div class="health-metrics">
      <div class="health-metric"><span>Height</span><strong>${escapeHtml(height)} u</strong></div>
      <div class="health-metric"><span>Bounds</span><strong>${escapeHtml(bounds)}</strong></div>
      <div class="health-metric"><span>Geometry</span><strong>${escapeHtml(m.meshCount || 0)} mesh / ${escapeHtml(m.vertexCount || 0)} verts</strong></div>
      <div class="health-metric"><span>Animations</span><strong>${escapeHtml(m.animationCount || 0)} clips</strong></div>
    </div>
    <div class="health-checks">
      ${checks.map(check => `
        <div class="health-check ${escapeHtml(check.severity)}">
          <span class="health-dot"></span>
          <div>
            <strong>${escapeHtml(check.title)}</strong>
            <p>${escapeHtml(check.detail)}</p>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="health-actions">
      ${actions.map(item => `<button class="health-action" data-health-action="${escapeHtml(item.action)}">${escapeHtml(item.label)}</button>`).join('')}
    </div>
  `;
  el.style.display = 'block';
}

function expandCollapsible(targetId) {
  const content = document.getElementById(targetId);
  if (!content) return;
  content.classList.remove('collapsed');
  const header = document.querySelector(`[data-target="${targetId}"]`);
  const chevron = header?.querySelector('.chevron');
  if (chevron) chevron.textContent = 'â–¾';
}

function renderSkeletonSection(info) {
  const section = document.getElementById('section-skeleton');
  if (section) section.style.display = 'block';
  expandCollapsible('skeleton-content');

  const noticEl = document.getElementById('skeleton-notice');
  const treeEl = document.getElementById('skeleton-tree');
  const countBadge = document.getElementById('bone-count-badge');
  const typeBadge = document.getElementById('skeleton-type-badge');
  const poseBadge = document.getElementById('skeleton-pose-badge');
  if (!treeEl) return;

  treeEl.innerHTML = '';
  renderSkeletonHealth(info.health);
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
    showAutoRigControls(true, false);
    return;
  }
  if (noticEl) noticEl.style.display = 'none';
  showAutoRigControls(true, true); // allow re-rigging an existing skeleton

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
  expandCollapsible('skeleton-content');

  const noticEl = document.getElementById('skeleton-notice');
  const treeEl = document.getElementById('skeleton-tree');
  const countBadge = document.getElementById('bone-count-badge');
  const typeBadge = document.getElementById('skeleton-type-badge');
  const poseBadge = document.getElementById('skeleton-pose-badge');
  renderSkeletonHealth(null);
  if (typeBadge) typeBadge.style.display = 'none';
  if (poseBadge) poseBadge.style.display = 'none';
  if (!treeEl) return;

  treeEl.innerHTML = '';

  if (!skeletons || skeletons.length === 0) {
    if (noticEl) noticEl.style.display = 'flex';
    if (countBadge) countBadge.textContent = '0 bones';
    showAutoRigControls(true, false);
    return;
  }

  if (noticEl) noticEl.style.display = 'none';
  showAutoRigControls(true, true); // allow re-rigging an existing skeleton

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
// AUTO-RIG (skeleton generation for skinless meshes)
// ═══════════════════════════════════════════════════════════
let autoRigState = null; // { markers: Map<name, mesh>, gizmoManager, height }

// Marker color groups (Mixamo-style legend: each anatomical group gets a color)
const AUTORIG_JOINT_GROUPS = [
  { id: 'head', label: 'Head / Neck', color: '#22d3ee', joints: ['Head', 'Neck'] },
  { id: 'spine', label: 'Spine', color: '#a78bfa', joints: ['Spine', 'Spine1', 'Spine2'] },
  { id: 'shoulder', label: 'Shoulders', color: '#60a5fa', joints: ['LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'] },
  { id: 'elbow', label: 'Elbows', color: '#fde047', joints: ['LeftForeArm', 'RightForeArm'] },
  { id: 'wrist', label: 'Wrists', color: '#4ade80', joints: ['LeftHand', 'RightHand'] },
  { id: 'groin', label: 'Hips / Groin', color: '#f472b6', joints: ['Hips', 'LeftUpLeg', 'RightUpLeg'] },
  { id: 'knee', label: 'Knees', color: '#fb923c', joints: ['LeftLeg', 'RightLeg'] },
  { id: 'foot', label: 'Feet / Toes', color: '#f87171', joints: ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'] },
];

// Friendly anatomical names shown in the hover tooltip
const AUTORIG_JOINT_LABELS = {
  Hips: 'Hips', Spine: 'Lower Spine', Spine1: 'Mid Spine', Spine2: 'Chest',
  Neck: 'Neck', Head: 'Head',
  LeftShoulder: 'Left Clavicle', LeftArm: 'Left Shoulder', LeftForeArm: 'Left Elbow', LeftHand: 'Left Wrist',
  RightShoulder: 'Right Clavicle', RightArm: 'Right Shoulder', RightForeArm: 'Right Elbow', RightHand: 'Right Wrist',
  LeftUpLeg: 'Left Hip (Groin)', LeftLeg: 'Left Knee', LeftFoot: 'Left Ankle', LeftToeBase: 'Left Toes',
  RightUpLeg: 'Right Hip (Groin)', RightLeg: 'Right Knee', RightFoot: 'Right Ankle', RightToeBase: 'Right Toes',
};

function autoRigGroupOf(jointName) {
  return AUTORIG_JOINT_GROUPS.find(g => g.joints.includes(jointName)) || null;
}

function renderAutoRigLegend() {
  const el = document.getElementById('autorig-legend');
  if (!el) return;
  el.innerHTML = `<div class="autorig-legend-title">Joint markers</div>` +
    AUTORIG_JOINT_GROUPS.map(g =>
      `<div class="autorig-legend-row">
        <span class="autorig-legend-dot" style="background:${g.color};color:${g.color};"></span>
        <span>${g.label}</span>
      </div>`).join('');
}

function showAutoRigControls(show, hasExistingSkin = false) {
  const wrap = document.getElementById('autorig-controls');
  if (!wrap) return;
  wrap.style.display = (show && isServerAvailable && characterGlbBuffer) ? 'block' : 'none';
  const startBtn = document.getElementById('btn-autorig-start');
  if (startBtn) {
    startBtn.textContent = hasExistingSkin
      ? '💀 Re-Rig / Adjust Skeleton'
      : '💀 Generate Skeleton (Auto-Rig)';
  }
  if (!show) cancelAutoRigAdjust();
}

function setupAutoRigControls() {
  document.getElementById('btn-autorig-start')?.addEventListener('click', startAutoRigAdjust);
  document.getElementById('btn-autorig-apply')?.addEventListener('click', applyAutoRig);
  document.getElementById('btn-autorig-cancel')?.addEventListener('click', cancelAutoRigAdjust);
  document.getElementById('btn-autorig-apply-vp')?.addEventListener('click', applyAutoRig);
  document.getElementById('btn-autorig-cancel-vp')?.addEventListener('click', cancelAutoRigAdjust);
  document.querySelectorAll('.autorig-view-btn').forEach(btn => {
    btn.addEventListener('click', () => setRigView(btn.dataset.view));
  });
  // Keyboard shortcuts 1/2/3 for views while in rig mode
  window.addEventListener('keydown', (e) => {
    if (!autoRigState) return;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
    if (e.code === 'Digit1') setRigView('front');
    else if (e.code === 'Digit2') setRigView('side');
    else if (e.code === 'Digit3') setRigView('top');
  });
}

// ── Rig viewport mode: isolate the character, studio backdrop, camera presets ─
function enterRigViewportMode() {
  if (!activeCharacter || !autoRigState) return;

  const charMeshSet = new Set(activeCharacter.rawMeshes);
  const hiddenMeshes = [];
  scene.meshes.forEach(m => {
    if (charMeshSet.has(m)) return;
    if (m === activeCharacter.playerCapsule) return;
    if (m.name.startsWith('autorig_')) return;
    if (m.isEnabled()) {
      hiddenMeshes.push(m);
      m.setEnabled(false);
    }
  });

  const prevClearColor = scene.clearColor.clone();
  scene.clearColor = new BABYLON.Color4(0.025, 0.025, 0.05, 1);

  const hud = document.querySelector('.hud-overlay');
  const prevHudDisplay = hud ? hud.style.display : null;
  if (hud) hud.style.display = 'none';

  const ui = document.getElementById('autorig-viewport-ui');
  if (ui) ui.style.display = 'flex';

  // Hand camera control back to the user the moment they grab the viewport
  const pointerObserver = scene.onPointerObservable.add((pi) => {
    if (pi.type === BABYLON.PointerEventTypes.POINTERDOWN) scene.stopAnimation(camera);
  });

  // Right-drag panning: scale sensibility to character size (higher = slower)
  const prevPanningSensibility = camera.panningSensibility;
  const h = autoRigState.sceneHeight || 1.8;
  camera.panningSensibility = Math.max(150, 1000 * (1.8 / h));

  autoRigState.viewportMode = {
    hiddenMeshes, prevClearColor, hud, prevHudDisplay, pointerObserver,
    prevPanningSensibility, prevTarget: camera.target.clone(),
  };
  setRigView('front');
}

function exitRigViewportMode(state) {
  const vm = state?.viewportMode;
  if (!vm) return;
  vm.hiddenMeshes.forEach(m => m.setEnabled(true));
  if (vm.pointerObserver) scene.onPointerObservable.remove(vm.pointerObserver);
  scene.stopAnimation(camera);
  if (vm.prevPanningSensibility !== undefined) camera.panningSensibility = vm.prevPanningSensibility;
  if (vm.prevTarget) camera.target.copyFrom(vm.prevTarget); // undo any panning offset
  scene.clearColor = vm.prevClearColor;
  if (vm.hud) vm.hud.style.display = vm.prevHudDisplay || '';
  const ui = document.getElementById('autorig-viewport-ui');
  if (ui) ui.style.display = 'none';
}

function setRigView(view) {
  if (!autoRigState) return;
  const h = autoRigState.sceneHeight || 1.8; // scene units, not GLB units
  const radius = Math.min(Math.max(h * 2.1, 2.5), 18);

  // Presets are relative to the character's facing, not world axes — the capsule
  // yaw is arbitrary (the controller rotates it during the load-time walk).
  // Controller convention: camera-behind alpha = -rotY - PI/2, so the camera
  // that FACES the character (front view) sits at -rotY + PI/2.
  let rotY = 0;
  const cap = activeCharacter?.playerCapsule;
  if (cap?.rotationQuaternion) rotY = cap.rotationQuaternion.toEulerAngles().y;
  else if (cap) rotY = cap.rotation.y;
  const frontAlpha = -rotY + Math.PI / 2;

  let alpha, beta;
  if (view === 'side') { alpha = frontAlpha + Math.PI / 2; beta = 1.42; }
  else if (view === 'top') { alpha = frontAlpha; beta = 0.06; }
  else { alpha = frontAlpha; beta = 1.42; } // front

  // Shortest rotation path — avoid full spins
  alpha += Math.round((camera.alpha - alpha) / (2 * Math.PI)) * 2 * Math.PI;

  document.querySelectorAll('.autorig-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));

  // Direct snap — no Animation objects. Animated transitions kept re-looping
  // and fought camera inertia, so the camera never settled.
  scene.stopAnimation(camera);
  camera.inertialAlphaOffset = 0;
  camera.inertialBetaOffset = 0;
  camera.inertialRadiusOffset = 0;
  camera.inertialPanningX = 0;
  camera.inertialPanningY = 0;
  // Recenter on the character (undoes any right-drag panning offset).
  // Use the world bounding center of the visible meshes — the capsule position
  // can be offset from where the frozen bind-pose mesh actually renders.
  let cx = NaN, cy = NaN, cz = NaN;
  if (activeCharacter?.rawMeshes?.length) {
    const min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
    const max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
    activeCharacter.rawMeshes.forEach(m => {
      if (!m.getBoundingInfo || !m.geometry) return;
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min.minimizeInPlace(bb.minimumWorld);
      max.maximizeInPlace(bb.maximumWorld);
    });
    if (Number.isFinite(max.x - min.x)) {
      cx = (min.x + max.x) / 2; cy = (min.y + max.y) / 2; cz = (min.z + max.z) / 2;
    }
  }
  if (Number.isFinite(cx)) {
    camera.target.set(cx, cy, cz);
  } else if (activeCharacter?.playerCapsule) {
    const p = activeCharacter.playerCapsule.position;
    camera.target.set(p.x, p.y, p.z);
  }
  camera.alpha = alpha;
  camera.beta = beta;
  camera.radius = radius;
}

// Left/right counterpart name, or null for center bones
function mirrorJointName(name) {
  if (name.startsWith('Left')) return 'Right' + name.slice(4);
  if (name.startsWith('Right')) return 'Left' + name.slice(5);
  return null;
}

async function startAutoRigAdjust() {
  if (!characterGlbBuffer || !activeCharacter) {
    showToast('Load a character mesh first!', true);
    return;
  }
  if (!isServerAvailable) {
    showToast('Server offline — auto-rig unavailable.', true);
    return;
  }

  const baseBuffer = originalCharacterGlbBuffer || characterGlbBuffer;
  showLoading('Analyzing mesh proportions…');
  let guess;
  try {
    const formData = new FormData();
    formData.append('file', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');
    const res = await fetch('/api/autorig-joints', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Joint analysis failed');
    }
    guess = await res.json();
  } catch (err) {
    hideLoading();
    showToast('Auto-rig failed: ' + err.message, true);
    return;
  }
  hideLoading();

  cancelAutoRigAdjust();

  // Freeze character in bind pose (T-pose) so markers line up with the mesh:
  // pause the controller update loop, stop animations, return skeleton to rest.
  const ctrlObserver = activeCharacter.charCtrl?._updateObserver;
  if (ctrlObserver) {
    scene.onBeforeRenderObservable.remove(ctrlObserver);
  }
  // Camera follow-lock observer forces pitch/yaw every frame (CAM_FOLLOW_LOCK)
  // and would override the Front/Side/Top presets — pause it too.
  const camLockObserver = activeCharacter.charCtrl?._cameraLockObserver;
  if (camLockObserver) {
    scene.onBeforeCameraRenderObservable.remove(camLockObserver);
  }
  scene.animationGroups.forEach(ag => ag.stop());
  scene.skeletons.forEach(skel => skel.returnToRest());

  // Marker parent must be the node whose LOCAL space matches the server's joint
  // space. For skinned characters that is the skeleton root's parent (it carries
  // any armature scale, e.g. ×100 cm exports); for static meshes, charRoot.
  let markerParent = activeCharacter.charRoot;
  if (scene.skeletons && scene.skeletons.length > 0) {
    const rootBone = scene.skeletons[0].bones.find(b => !b.getParent());
    const rootNode = rootBone?.getTransformNode();
    if (rootNode?.parent) markerParent = rootNode.parent;
  }

  // Scene-space character height (for camera framing — guess.height is in the
  // GLB's own units and can be ×100 off)
  let sceneMinY = Infinity, sceneMaxY = -Infinity;
  activeCharacter.rawMeshes.forEach(m => {
    if (!m.getBoundingInfo || !m.geometry) return;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    sceneMinY = Math.min(sceneMinY, bb.minimumWorld.y);
    sceneMaxY = Math.max(sceneMaxY, bb.maximumWorld.y);
  });
  const sceneHeight = (Number.isFinite(sceneMaxY - sceneMinY) && sceneMaxY - sceneMinY > 0.01)
    ? sceneMaxY - sceneMinY
    : 1.8;

  const markers = new Map();
  // One emissive material per anatomical group (Mixamo-style color coding)
  const groupMats = new Map();
  const matFor = (jointName) => {
    const group = autoRigGroupOf(jointName);
    const key = group?.id || 'default';
    if (!groupMats.has(key)) {
      const mat = new BABYLON.StandardMaterial(`autorigMarkerMat_${key}`, scene);
      mat.emissiveColor = group
        ? BABYLON.Color3.FromHexString(group.color)
        : new BABYLON.Color3(1, 0.85, 0.1);
      mat.disableLighting = true;
      groupMats.set(key, mat);
    }
    return groupMats.get(key);
  };

  const diameter = Math.max(0.03 * guess.height, 0.02);
  Object.entries(guess.joints).forEach(([name, pos]) => {
    const m = BABYLON.MeshBuilder.CreateSphere(`autorig_${name}`, { diameter, segments: 10 }, scene);
    m.material = matFor(name);
    m.isPickable = true;
    m.renderingGroupId = 1; // draw on top of the character mesh
    m.parent = markerParent;
    m.position.set(pos[0], pos[1], pos[2]);
    m.metadata = { autorigJoint: name };
    markers.set(name, m);
  });
  renderAutoRigLegend();

  // Hover/selection tooltip with the anatomical joint name
  const tipEl = document.getElementById('autorig-joint-tip');
  const showTip = (jointName, x, y) => {
    if (!tipEl) return;
    const group = autoRigGroupOf(jointName);
    tipEl.textContent = AUTORIG_JOINT_LABELS[jointName] || jointName;
    tipEl.style.borderColor = group?.color || 'rgba(255,255,255,0.18)';
    tipEl.style.left = `${x}px`;
    tipEl.style.top = `${y}px`;
    tipEl.style.display = 'block';
  };
  const hideTip = () => { if (tipEl) tipEl.style.display = 'none'; };
  const hoverObserver = scene.onPointerObservable.add((pi) => {
    if (pi.type !== BABYLON.PointerEventTypes.POINTERMOVE) return;
    // While dragging a marker keep its label pinned to the gizmo-attached mesh
    const dragging = gizmoManager.attachedMesh?.metadata?.autorigJoint &&
      pi.event.buttons > 0;
    const mesh = dragging
      ? gizmoManager.attachedMesh
      : scene.pick(scene.pointerX, scene.pointerY, (m) => !!m.metadata?.autorigJoint)?.pickedMesh;
    if (mesh?.metadata?.autorigJoint) {
      showTip(mesh.metadata.autorigJoint, scene.pointerX, scene.pointerY);
    } else {
      hideTip();
    }
  });

  const gizmoManager = new BABYLON.GizmoManager(scene);
  gizmoManager.positionGizmoEnabled = true;
  gizmoManager.usePointerToAttachGizmos = true;
  gizmoManager.attachableMeshes = [...markers.values()];

  // Mirror drag onto the contralateral marker when symmetry is on
  const posGizmo = gizmoManager.gizmos.positionGizmo;
  if (posGizmo) {
    const syncMirror = () => {
      const symmetric = document.getElementById('autorig-symmetry')?.checked;
      if (!symmetric) return;
      const attached = gizmoManager.attachedMesh;
      if (!attached?.metadata?.autorigJoint) return;
      const twinName = mirrorJointName(attached.metadata.autorigJoint);
      if (!twinName) return;
      const twin = markers.get(twinName);
      if (twin) twin.position.set(-attached.position.x, attached.position.y, attached.position.z);
    };
    [posGizmo.xGizmo, posGizmo.yGizmo, posGizmo.zGizmo].forEach(g => {
      g?.dragBehavior?.onDragObservable.add(syncMirror);
    });
  }

  autoRigState = {
    markers, gizmoManager, height: guess.height, sceneHeight,
    groupMats, hoverObserver, hideTip,
    pausedCtrlCallback: ctrlObserver?.callback || null,
    pausedCamLockCallback: camLockObserver?.callback || null,
  };
  enterRigViewportMode();

  const startBtn = document.getElementById('btn-autorig-start');
  const adjustPanel = document.getElementById('autorig-adjust');
  const hint = document.getElementById('autorig-adjust-hint');
  if (startBtn) startBtn.style.display = 'none';
  if (adjustPanel) adjustPanel.style.display = 'block';
  if (hint) {
    hint.textContent = guess.reRig
      ? 'Markers placed from the current skeleton bind pose. Drag them to correct joint placement — applying will REPLACE the existing skeleton and skin weights, and animations will be re-merged.'
      : "Drag the yellow joint markers in the viewport to match your character's anatomy (click a marker to attach the move gizmo), then apply.";
  }

  showToast('Adjust the joint markers, then Apply Rig.');
}

function cancelAutoRigAdjust() {
  if (autoRigState) {
    exitRigViewportMode(autoRigState);
    if (autoRigState.hoverObserver) scene.onPointerObservable.remove(autoRigState.hoverObserver);
    autoRigState.hideTip?.();
    autoRigState.gizmoManager?.dispose();
    autoRigState.markers.forEach(m => m.dispose());
    autoRigState.groupMats?.forEach(mat => mat.dispose());
    // Resume the paused controller update loop (no-op after apply: reload replaces it)
    if (autoRigState.pausedCtrlCallback && activeCharacter?.charCtrl) {
      activeCharacter.charCtrl._updateObserver =
        scene.onBeforeRenderObservable.add(autoRigState.pausedCtrlCallback);
    }
    if (autoRigState.pausedCamLockCallback && activeCharacter?.charCtrl) {
      activeCharacter.charCtrl._cameraLockObserver =
        scene.onBeforeCameraRenderObservable.add(autoRigState.pausedCamLockCallback);
    }
    // Restart idle: rig mode stopped every animation group and froze the
    // skeleton in rest pose. AnimCtrl.play() short-circuits when the requested
    // group is already `cur` (it only re-weights, never restarts a stopped
    // group), so clear `cur` first to force a real transition/start.
    if (activeCharacter?.charCtrl) {
      const ctrl = activeCharacter.charCtrl;
      const anim = activeCharacter.animCtrl;
      ctrl._previewAnim = null;
      ctrl._previewLocoSpeed = null;
      if (anim) {
        anim.cur = null;
        anim.curName = '';
        anim.activeTransitions = [];
      }
      ctrl._setState?.(window.S ? window.S.IDLE : 'IDLE');
      if (ctrl._returnToLoco) ctrl._returnToLoco(0.2);
      else anim?.play('Idle_Loop', true, 0.2);
    }
    autoRigState = null;
  }
  const startBtn = document.getElementById('btn-autorig-start');
  const adjustPanel = document.getElementById('autorig-adjust');
  if (startBtn) startBtn.style.display = '';
  if (adjustPanel) adjustPanel.style.display = 'none';
}

async function applyAutoRig() {
  if (!autoRigState || !characterGlbBuffer) return;

  // Collect adjusted joint positions (local to charRoot = glTF space)
  const joints = {};
  autoRigState.markers.forEach((m, name) => {
    joints[name] = [m.position.x, m.position.y, m.position.z];
  });

  const baseBuffer = originalCharacterGlbBuffer || characterGlbBuffer;
  cancelAutoRigAdjust();

  showLoading('Generating skeleton & skin weights…');
  showMergeProgress(true, 'Auto-rigging on server…');
  try {
    const formData = new FormData();
    formData.append('file', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');
    formData.append('options', JSON.stringify({ joints }));

    const res = await fetch('/api/autorig', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Auto-rig failed');
    }
    const riggedBuffer = await res.arrayBuffer();
    completeMergeProgress();

    // Reload through the normal character pipeline: re-analyze, then merge
    // default/preloaded animations against the freshly rigged skeleton.
    const file = new File([riggedBuffer], 'rigged.glb');
    await loadCharacterMeshFile(file, riggedBuffer);
    showToast('✓ Skeleton generated and assigned!');
  } catch (err) {
    completeMergeProgress();
    hideLoading();
    console.error('[autorig] failed:', err);
    showToast('Auto-rig failed: ' + err.message, true);
  }
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
  cancelAutoRigAdjust();

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
  // animationEvents intentionally kept: markers survive character swaps and are
  // re-attached when the same clips get mapped again (see pruneAnimationEvents).
  updateTestLabMetrics();

  const section = document.getElementById('section-skeleton');
  if (section) section.style.display = 'none';
  const libSection = document.getElementById('section-anim-library');
  if (libSection) libSection.style.display = 'none';

  renderAnimationLibrary();
  renderAnimationsMappingTab();
  renderCustomAnimationsTab();
  renderAnimationEventsTab();
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

      if (autoRigState) {
        showToast('Finish rig adjustment first — character is locked in T-pose.', true);
        return;
      }
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
      const oldAg = activeCharacter.animCtrl.g.get(stdKey.key);
      if (oldAg && oldAg.__isSharedClone) { oldAg.stop(); oldAg.dispose(); }
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
  renderAnimationEventsTab();
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
  renderAnimationEventsTab();
  updateExportCode();
}

// ═══════════════════════════════════════════════════════════
// CUSTOM ANIMATIONS TAB
// ═══════════════════════════════════════════════════════════
function getAnimationEventTargets() {
  const standardTargets = STANDARD_ANIM_KEYS
    .map(stdKey => {
      const mapping = animMappings[stdKey.key];
      if (!mapping || mapping.animName === 'None') return null;
      return {
        key: stdKey.key,
        label: stdKey.label,
        animName: mapping.animName,
        from: Number(mapping.from || 0),
        to: Number(mapping.to || 100),
      };
    })
    .filter(Boolean);

  const customTargets = customAnimations
    .filter(cust => cust.name && cust.animName && cust.animName !== 'None')
    .map(cust => ({
      key: cust.name,
      label: cust.name,
      animName: cust.animName,
      from: 0,
      to: 100,
    }));

  return [...standardTargets, ...customTargets];
}

// Markers are never dropped just because a key is currently unmapped (e.g.
// while a new character loads) — they stay stored and reappear when the same
// clip is mapped again. A marker is only removed when its key gets mapped to a
// DIFFERENT clip than the one it was authored for (evt.anim).
function pruneAnimationEvents() {
  const mappedAnim = new Map(getAnimationEventTargets().map(t => [t.key, t.animName]));
  Object.keys(animationEvents).forEach(key => {
    const mapped = mappedAnim.get(key);
    const list = (animationEvents[key] || []).filter(evt =>
      evt && Number.isFinite(Number(evt.frame)) &&
      (!evt.anim || !mapped || evt.anim === mapped));
    if (list.length) animationEvents[key] = list;
    else delete animationEvents[key];
  });
}

function addAnimationEvent() {
  const targetEl = document.getElementById('event-target-select');
  const typeEl = document.getElementById('event-type-select');
  const frameEl = document.getElementById('event-frame-input');
  const labelEl = document.getElementById('event-label-input');
  if (!targetEl || !typeEl || !frameEl) return;

  const key = targetEl.value;
  if (!key) {
    showToast('Map an animation before adding events.', true);
    return;
  }
  const target = getAnimationEventTargets().find(t => t.key === key);
  const fallbackFrame = target ? Math.round((target.from + target.to) / 2) : 0;
  const parsedFrame = parseInt(frameEl.value, 10);
  const evt = {
    type: typeEl.value,
    frame: Number.isFinite(parsedFrame) ? parsedFrame : fallbackFrame,
    label: (labelEl?.value || '').trim(),
    anim: target?.animName, // clip this marker was authored for (survives remaps)
  };
  if (!animationEvents[key]) animationEvents[key] = [];
  animationEvents[key].push(evt);
  animationEvents[key].sort((a, b) => a.frame - b.frame);
  if (labelEl) labelEl.value = '';
  renderAnimationEventsTab();
  savePreferences();
  updateExportCode();
  showToast(`Added ${evt.type} marker to ${key}.`);
}

function deleteAnimationEvent(key, index) {
  if (!animationEvents[key]) return;
  animationEvents[key].splice(index, 1);
  if (animationEvents[key].length === 0) delete animationEvents[key];
  renderAnimationEventsTab();
  savePreferences();
  updateExportCode();
}

function clearAllAnimationEvents() {
  const total = Object.values(animationEvents).reduce((n, l) => n + (l?.length || 0), 0);
  if (total === 0) { showToast('No animation events to clear.'); return; }
  showConfirm(
    'Clear Animation Events',
    `Delete all ${total} animation event marker${total !== 1 ? 's' : ''}? This cannot be undone.`,
    () => {
      animationEvents = {};
      renderAnimationEventsTab();
      savePreferences();
      updateExportCode();
      showToast('All animation events cleared.');
    }
  );
}

// Push the editor's markers into the live controller so they fire in the
// viewport while testing (toast + console). Export emits the same object.
function syncAnimationEventsToController() {
  const ctrl = activeCharacter?.charCtrl;
  if (!ctrl) return;
  ctrl.animationEvents = animationEvents;
  ctrl.onAnimationEvent = (evt, animName) => {
    showToast(`🎯 ${evt.type}${evt.label ? ' · ' + evt.label : ''} — ${animName} f${evt.frame}`);
    console.log('[anim-event]', animName, evt);
  };
}

function renderAnimationEventsTab() {
  const container = document.getElementById('animation-events-editor');
  if (!container) return;
  pruneAnimationEvents();
  syncAnimationEventsToController();
  const targets = getAnimationEventTargets();

  if (targets.length === 0) {
    container.innerHTML = `<div class="events-empty">Map at least one animation to add gameplay markers.</div>`;
    return;
  }

  const first = targets[0];
  const currentTarget = targets.find(t => animationEvents[t.key]?.length) || first;
  const defaultFrame = Math.round((currentTarget.from + currentTarget.to) / 2);
  const eventTypes = ['footstep', 'hit', 'cast', 'sound', 'particle', 'camera', 'custom'];

  container.innerHTML = `
    <div class="event-composer">
      <select id="event-target-select">
        ${targets.map(t => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)} · ${escapeHtml(t.animName)}</option>`).join('')}
      </select>
      <select id="event-type-select">
        ${eventTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
      </select>
      <input id="event-frame-input" type="number" min="0" step="1" value="${defaultFrame}" aria-label="Event frame">
      <input id="event-label-input" type="text" placeholder="Label / payload">
      <button id="btn-add-animation-event" class="btn-add-event">Add Marker</button>
      <button id="btn-clear-animation-events" class="btn-clear-events" title="Delete all markers">Clear All</button>
    </div>
    <div class="event-targets">
      ${targets.map(target => {
    const events = animationEvents[target.key] || [];
    return `
          <div class="event-target-card">
            <div class="event-target-head">
              <strong>${escapeHtml(target.label)}</strong>
              <span>${escapeHtml(target.from)}-${escapeHtml(target.to)}f</span>
            </div>
            ${events.length ? `
              <div class="event-marker-list">
                ${events.map((evt, index) => `
                  <div class="event-marker">
                    <span class="event-marker-type">${escapeHtml(evt.type)}</span>
                    <span class="event-marker-frame">f${escapeHtml(evt.frame)}</span>
                    <span class="event-marker-label">${escapeHtml(evt.label || target.animName)}</span>
                    <button class="btn-event-delete" data-event-key="${escapeHtml(target.key)}" data-event-index="${index}" title="Remove marker">×</button>
                  </div>
                `).join('')}
              </div>
            ` : `<div class="event-marker-empty">No markers yet</div>`}
          </div>
        `;
  }).join('')}
    </div>
  `;

  const targetSelect = document.getElementById('event-target-select');
  const frameInput = document.getElementById('event-frame-input');
  targetSelect?.addEventListener('change', () => {
    const target = targets.find(t => t.key === targetSelect.value);
    if (target && frameInput) frameInput.value = Math.round((target.from + target.to) / 2);
  });
  document.getElementById('btn-add-animation-event')?.addEventListener('click', addAnimationEvent);
  document.getElementById('btn-clear-animation-events')?.addEventListener('click', clearAllAnimationEvents);
  container.querySelectorAll('.btn-event-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteAnimationEvent(btn.dataset.eventKey, parseInt(btn.dataset.eventIndex, 10)));
  });
}

function formatAnimationEventsForExport(indent = '      ') {
  const mapped = new Set(getAnimationEventTargets().map(t => t.key));
  const activeEvents = Object.fromEntries(
    Object.entries(animationEvents)
      .filter(([key, events]) => mapped.has(key) && Array.isArray(events) && events.length > 0)
      .map(([key, events]) => [key, events.map(({ type, frame, label }) => ({ type, frame, label }))])
  );
  if (Object.keys(activeEvents).length === 0) return '';
  return `${indent}// Gameplay animation markers exported from Builder\n` +
    `${indent}charCtrl.animationEvents = ${JSON.stringify(activeEvents, null, 8).replace(/\n/g, '\n' + indent)};\n\n`;
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
      renderAnimationEventsTab(); applyAnimationsToController(); updateExportCode();
    });
  });
  container.querySelectorAll('.custom-select-anim').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations[index].animName = e.target.value;
      renderAnimationEventsTab(); applyAnimationsToController(); updateExportCode();
    });
  });
  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.target.dataset.index);
      customAnimations.splice(index, 1);
      renderCustomAnimationsTab(); renderAnimationEventsTab(); applyAnimationsToController(); updateExportCode();
    });
  });

  bindKeyCatcherEvents();
  renderAnimationEventsTab();
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
      animationEvents = {};

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
      renderAnimationEventsTab();
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
    renderAnimationEventsTab();
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

  document.querySelectorAll('.test-action[data-test-action]').forEach(btn => {
    btn.addEventListener('click', () => runControllerTestAction(btn.dataset.testAction));
  });
  document.querySelectorAll('.scenario-chip[data-test-scenario]').forEach(btn => {
    btn.addEventListener('click', () => applyTestScenario(btn.dataset.testScenario));
  });
  startTestLabMetrics();

  const healthPanel = document.getElementById('skeleton-health');
  if (healthPanel) {
    healthPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-health-action]');
      if (!btn) return;
      handleHealthAction(btn.dataset.healthAction);
    });
  }

  // Download
  document.getElementById('btn-download').addEventListener('click', downloadControllerFile);

  // Download GLB
  const btnDownloadGlb = document.getElementById('btn-download-glb');
  if (btnDownloadGlb) btnDownloadGlb.addEventListener('click', downloadCharacterGlbFile);

  const btnDownloadConfig = document.getElementById('btn-download-config');
  if (btnDownloadConfig) btnDownloadConfig.addEventListener('click', downloadBuilderConfigFile);
  const btnImportConfig = document.getElementById('btn-import-config');
  const configInput = document.getElementById('builder-config-input');
  if (btnImportConfig && configInput) {
    btnImportConfig.addEventListener('click', () => configInput.click());
    configInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await importBuilderConfigFile(file);
      configInput.value = '';
    });
  }

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
      localStorage.removeItem('builder_animation_events');
      localStorage.removeItem('builder_controller_preset');

      savedAnimMappings = null;
      activeControllerPreset = 'balanced';
      keyBindings = JSON.parse(JSON.stringify(DEFAULT_KEY_BINDINGS));
      physicsConfig = JSON.parse(JSON.stringify(DEFAULT_PHYSICS_CONFIG));
      customAnimations = [];
      animationEvents = {};

      resetCharacterTransform();

      autoMapAnimations();
      renderAnimationsMappingTab();
      renderCustomAnimationsTab();
      renderAnimationEventsTab();
      renderKeyBindingsUI();
      syncPhysicsConfigToUI();
      renderControllerPresets();

      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl.keyBindings = keyBindings;
        Object.keys(physicsConfig).forEach(key => { activeCharacter.charCtrl[key] = physicsConfig[key]; });
      }
      showToast('All configurations reset to defaults!');
    });
  }

  renderKeyBindingsUI();
  renderControllerPresets();
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
    if (file && /\.(glb|fbx)$/i.test(file.name)) {
      onFile(file);
    } else {
      showToast('Please import a valid .glb or .fbx file', true);
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

  const configCode = `// 🎮 CUSTOM SETUP CONFIGURATION FOR YOUR APP.JS\n// Copy and paste this loadCharacter function replacement in your app.js:\n\nasync function loadCharacter(scene, shadow, camera, usePhysics) {\n  return setupCharacter(scene, camera, usePhysics, {\n    shadow,\n    assetsPath: 'assets/',\n    filename: 'character_animated.glb',\n    capsuleScale: { x: ${charTransformConfig.SCALE_X}, y: ${charTransformConfig.SCALE_Y}, z: ${charTransformConfig.SCALE_Z} },\n    keys: ${JSON.stringify(keyBindings, null, 4).replace(/\n/g, '\n    ')},\n    config: ${JSON.stringify(physicsConfig, null, 4).replace(/\n/g, '\n    ')},\n    configure: ({ animCtrl, charCtrl, filteredGroups }) => {\n${mappingsSnippet}${customsSnippet}${formatAnimationEventsForExport()}    }\n  });\n}`;

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
      const hasAnimBuffer = animationsGlbBuffer && animationsGlbBuffer.byteLength > 0;

      // With an animations buffer: re-merge from the clean original (strip + retarget).
      // Without one: export the CURRENT character buffer (already holds merged
      // animations) and keep them — stripping here would produce a GLB with zero animations.
      const baseBuffer = hasAnimBuffer
        ? (originalCharacterGlbBuffer || characterGlbBuffer)
        : (characterGlbBuffer || originalCharacterGlbBuffer);

      const formData = new FormData();
      formData.append('character', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');

      if (hasAnimBuffer) {
        formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations.glb');
      }

      formData.append('options', JSON.stringify(getMergeOptions({ removeExistingAnimations: hasAnimBuffer })));

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

function downloadBuilderConfigFile() {
  const config = {
    schema: 'bjs-character-controller-builder/v1',
    exportedAt: new Date().toISOString(),
    controllerPreset: activeControllerPreset,
    character: {
      hasCharacter: !!characterGlbBuffer,
      skeleton: skeletonInfo ? {
        hasSkin: skeletonInfo.hasSkin,
        boneCount: skeletonInfo.boneCount,
        rootBones: skeletonInfo.rootBones,
        skeletonType: skeletonInfo.skeletonType,
        poseStyle: skeletonInfo.poseStyle,
        health: skeletonInfo.health ? {
          score: skeletonInfo.health.score,
          status: skeletonInfo.health.status,
          coverage: skeletonInfo.health.coverage,
          metrics: skeletonInfo.health.metrics,
          missingBones: skeletonInfo.health.missingBones,
        } : null,
      } : null,
    },
    transforms: charTransformConfig,
    keys: keyBindings,
    physics: physicsConfig,
    animations: {
      detected: detectedAnimations,
      standardMappings: animMappings,
      customActions: customAnimations,
      events: animationEvents,
    },
  };

  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'builder-config.json';
  link.click();
  showToast('Downloaded builder-config.json!');
}

function normalizeImportedAnimationMappings(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  STANDARD_ANIM_KEYS.forEach(stdKey => {
    const incoming = value[stdKey.key];
    const animName = incoming?.animName && (incoming.animName === 'None' || detectedAnimations.length === 0 || detectedAnimations.includes(incoming.animName))
      ? incoming.animName
      : 'None';
    result[stdKey.key] = {
      animName,
      from: Number.isFinite(Number(incoming?.from)) ? Number(incoming.from) : 0,
      to: Number.isFinite(Number(incoming?.to)) ? Number(incoming.to) : 100,
    };
  });
  return result;
}

function normalizeImportedCustomActions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      name: String(item.name || `CUSTOM_ACTION_${index + 1}`).toUpperCase().replace(/[^A-Z0-9_]/g, ''),
      animName: item.animName && (item.animName === 'None' || detectedAnimations.length === 0 || detectedAnimations.includes(item.animName)) ? item.animName : 'None',
      keyTrigger: Array.isArray(item.keyTrigger) ? item.keyTrigger.map(String) : [],
    }));
}

function normalizeImportedAnimationEvents(value) {
  if (!value || typeof value !== 'object') return {};
  const validKeys = new Set([
    ...STANDARD_ANIM_KEYS.map(k => k.key),
    ...customAnimations.map(c => c.name),
  ]);
  const result = {};
  Object.entries(value).forEach(([key, events]) => {
    if (!validKeys.has(key) || !Array.isArray(events)) return;
    const cleaned = events
      .filter(evt => evt && typeof evt === 'object' && Number.isFinite(Number(evt.frame)))
      .map(evt => ({
        type: String(evt.type || 'custom'),
        frame: Number(evt.frame),
        label: String(evt.label || ''),
      }))
      .sort((a, b) => a.frame - b.frame);
    if (cleaned.length) result[key] = cleaned;
  });
  return result;
}

function refreshBuilderAfterConfigImport() {
  syncCharTransformToUI();
  applyLiveTransformations();
  syncPhysicsConfigToUI();
  applyPhysicsConfigToActiveController();
  renderControllerPresets();
  renderAnimationsMappingTab();
  renderCustomAnimationsTab();
  renderAnimationEventsTab();
  renderKeyBindingsUI();
  applyAnimationsToController();
  updateExportCode();
}

async function importBuilderConfigFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON object.');
    if (parsed.schema && parsed.schema !== 'bjs-character-controller-builder/v1') {
      throw new Error(`Unsupported config schema: ${parsed.schema}`);
    }

    if (parsed.controllerPreset && CONTROLLER_PRESETS.some(p => p.id === parsed.controllerPreset)) {
      activeControllerPreset = parsed.controllerPreset;
    }
    if (parsed.physics && typeof parsed.physics === 'object') {
      physicsConfig = { ...DEFAULT_PHYSICS_CONFIG, ...parsed.physics };
    }
    if (parsed.keys && typeof parsed.keys === 'object') {
      keyBindings = { ...DEFAULT_KEY_BINDINGS, ...parsed.keys };
    }
    if (parsed.transforms && typeof parsed.transforms === 'object') {
      charTransformConfig = { ...DEFAULT_CHAR_TRANSFORM, ...parsed.transforms };
    }

    const importedAnimations = parsed.animations || {};
    animMappings = normalizeImportedAnimationMappings(importedAnimations.standardMappings);
    savedAnimMappings = animMappings;
    customAnimations = normalizeImportedCustomActions(importedAnimations.customActions);
    animationEvents = normalizeImportedAnimationEvents(importedAnimations.events);

    refreshBuilderAfterConfigImport();
    showToast(`Imported ${file.name}`);
  } catch (err) {
    console.error('[builder-config] import failed:', err);
    showToast('Config import failed: ' + err.message, true);
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
      mappingInjection += formatAnimationEventsForExport('  ');
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
