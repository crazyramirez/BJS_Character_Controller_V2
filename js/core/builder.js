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
let animationsCleared = false; // true after "Clear All": force export to strip baked anims
let isServerAvailable = false;
let characterFilename = 'character.glb';

let animationsFilename = 'animations-basic.glb';

// Posture preview/bake state. While a posture slider is dragged the observer shows
// the EXACT live offset (matches the bake). On release we bake the pose on the
// SERVER and reload the baked GLB so the animations carry the pose in their tracks
// (no snapping between clips). Once baked the observer must stop applying posture
// (already in the GLB) — posturePreviewBaked gates it. To re-adjust we reload the
// posture-free clean buffer first so the observer layers on a clean bind, never on
// an already-baked pose. See [[posture_preview_vs_export_parity]].
let posturePreviewBaked = false;     // true while the loaded GLB already carries the pose
let _postureRebakeTimer = null;      // debounce for the on-release bake
let cleanPreviewBuffer = null;       // GLB merged with scale/anims but posture=0
let _enteringLivePreview = false;    // guard while swapping to the clean buffer
// Scale/Pivot are baked ON RELEASE into this buffer (accumulates onto the previous
// baked result), then the slider resets to 1/0 so re-touching never re-multiplies
// the same value. originalCharacterGlbBuffer stays pristine for animation imports.
let scaledCharacterBuffer = null;    // original + accumulated scale/pivot, anim-free
let _scalePivotBakeTimer = null;     // debounce for scale/pivot on-release bake

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
  CAM_TILT: false,
  CAM_TILT_AMOUNT: 0.15,
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
    description: 'Readable third-person movement for exploration, combat tests and general demos. Free camera, light dynamic FOV, no air steering.',
    tags: ['default', 'third person'],
    config: {
      GRAV: 22, JUMP_PWR: 9.5, SPD_WALK: 2.5, SPD_JOG: 3.0, SPD_SPRINT: 5.0,
      ACCEL: 14, DECEL: 16, ROT_SPD: 40, AIR_CONTROL: false,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.10, CAM_TILT: false, CAM_TILT_AMOUNT: 0.15, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 1.047, CAM_FOLLOW_DIST: 8.0, CAM_LOCK_PITCH: false, JOYSTICK_LOCK_X: false,
      DOUBLE_JUMP_ENABLED: true,
      SPEED_MULTIPLIER: 1.0
    }
  },
  {
    id: 'action',
    name: 'Action Combat',
    description: 'Tighter acceleration, shorter camera distance and heavier landings for responsive fights. Locked pitch keeps targets framed; horizontal-only joystick steering.',
    tags: ['combat', 'snappy'],
    config: {
      GRAV: 28, JUMP_PWR: 9.0, SPD_WALK: 2.7, SPD_JOG: 3.2, SPD_SPRINT: 5.8,
      ACCEL: 24, DECEL: 26, ROT_SPD: 70, AIR_CONTROL: false,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.06, CAM_TILT: true, CAM_TILT_AMOUNT: 0.22, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 0.96, CAM_FOLLOW_DIST: 6.2, CAM_LOCK_PITCH: true, JOYSTICK_LOCK_X: true,
      DOUBLE_JUMP_ENABLED: false,
      SPEED_MULTIPLIER: 1.0
    }
  },
  {
    id: 'platformer',
    name: 'Arcade Platformer',
    description: 'Higher jump, stronger air steering and brighter motion feedback for traversal-heavy games. Full air control, double jump and free camera for reading platforms below.',
    tags: ['jump', 'air control'],
    config: {
      GRAV: 24, JUMP_PWR: 13.5, SPD_WALK: 3.0, SPD_JOG: 3.8, SPD_SPRINT: 6.6,
      ACCEL: 20, DECEL: 18, ROT_SPD: 58, AIR_CONTROL: true,
      DYNAMIC_FOV: true, DYNAMIC_FOV_MAX: 0.16, CAM_TILT: true, CAM_TILT_AMOUNT: 0.25, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 1.02, CAM_FOLLOW_DIST: 7.0, CAM_LOCK_PITCH: false, JOYSTICK_LOCK_X: false,
      DOUBLE_JUMP_ENABLED: true,
      SPEED_MULTIPLIER: 1.0
    }
  },
  {
    id: 'cinematic',
    name: 'Cinematic Walkthrough',
    description: 'Slower motion, softer turns and wider camera framing for showcases and inspection. Stable locked pitch, near-flat FOV and steady framing keep shots clean.',
    tags: ['showcase', 'smooth'],
    config: {
      GRAV: 20, JUMP_PWR: 7.5, SPD_WALK: 1.6, SPD_JOG: 2.2, SPD_SPRINT: 3.8,
      ACCEL: 8, DECEL: 10, ROT_SPD: 26, AIR_CONTROL: false,
      DYNAMIC_FOV: false, DYNAMIC_FOV_MAX: 0.03, CAM_TILT: true, CAM_TILT_AMOUNT: 0.06, CAM_FOLLOW_LOCK: true,
      CAM_FOLLOW_PITCH: 1.12, CAM_FOLLOW_DIST: 9.5, CAM_LOCK_PITCH: true, JOYSTICK_LOCK_X: false,
      DOUBLE_JUMP_ENABLED: false,
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
  SHOULDER_RAISE_ANGLE: 0.0,
  LEG_SPREAD_ANGLE: 0.0,
  SPINE_STRAIGHTEN_ANGLE: 0.0,
  HIPS_TILT_ANGLE: 0.0,
  FOOT_TOE_OUT_ANGLE: 0.0,  // +deg toes-out: R about +Y, L about -Y (fixes CC supinated feet)
  HAND_RELAX_ANGLE: 0.0     // +deg opens the fingers (uncurls toward an open hand); 0 = leave as retargeted
};
const DEFAULT_CHAR_TRANSFORM = JSON.parse(JSON.stringify(charTransformConfig));

// Thumb relaxes opposite the other fingers (mirrored local frame) and by a
// smaller amount so it doesn't splay out. Shared by the live preview and merge.
const THUMB_RELAX_SCALE = 0.5;
// The thumb tip (distal, *_03) stays kinked when every joint rotates equally —
// give the last joint extra relax in the SAME direction so the tip straightens.
const THUMB_TIP_SCALE = 2.0;

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
  // Clavicle bones get their own role so Shoulder Raise can target them alone;
  // they still receive arm spread/splay (see boneOffsetObserver switch).
  shoulderL: new Set(['leftshoulder', 'leftcollar', 'claviclel', 'lclavicle', 'shoulderl', 'lshoulder', 'collarl']),
  shoulderR: new Set(['rightshoulder', 'rightcollar', 'clavicler', 'rclavicle', 'shoulderr', 'rshoulder', 'collarr']),
  armL: new Set(['leftarm', 'leftupperarm', 'upperarml', 'lupperarm', 'arml', 'larm']),
  armR: new Set(['rightarm', 'rightupperarm', 'upperarmr', 'rupperarm', 'armr', 'rarm']),
  legL: new Set(['leftupleg', 'leftupperleg', 'thighl', 'lthigh', 'upperlegl', 'leftthigh', 'hipl']),
  legR: new Set(['rightupleg', 'rightupperleg', 'thighr', 'rthigh', 'upperlegr', 'rightthigh', 'hipr']),
  footL: new Set(['leftfoot', 'footl', 'lfoot', 'leftankle', 'anklel']),
  footR: new Set(['rightfoot', 'footr', 'rfoot', 'rightankle', 'ankler']),
  spine: new Set(['spine', 'spine1', 'spine2', 'spine3', 'spine01', 'spine02', 'spine03',
    'waist', 'chest', 'upperchest', 'lowerback']),
  hips: new Set(['hips', 'hip', 'pelvis']),
};

// Finger joints (thumb/index/middle/ring/pinky segments, excluding toes) get a
// single 'finger' role driven by the Hand Relax slider. Matched by pattern, not
// a Set — there are too many (5 fingers × 3-4 joints × 2 hands) to enumerate.
function isFingerBoneName(name) {
  const n = boneRoleNorm(name);
  return /(thumb|index|middle|ring|pinky)/.test(n) && !/toe/.test(n);
}

function boneRole(name) {
  const n = boneRoleNorm(name);
  for (const [role, set] of Object.entries(BONE_ROLE_SETS)) {
    if (set.has(n)) return role;
  }
  if (isFingerBoneName(name)) return 'finger';
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
  // so the character's final world scale stays (sx, sy, sz). Scale/pivot are ALWAYS
  // a live node transform here (never baked into the preview geometry — posture
  // rebake zeroes them), so applying them on the wrapper never doubles.
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

    // Adapt camera settings dynamically to character scale
    if (ctrl._baseCamFollowDist === undefined) {
      ctrl._baseCamFollowDist = ctrl.CAM_FOLLOW_DIST / (ctrl._lastAppliedScaleY || 1.0);
    }
    ctrl.CAM_FOLLOW_DIST = ctrl._baseCamFollowDist * sy;
    if (window.physicsConfig) {
      window.physicsConfig.CAM_FOLLOW_DIST = ctrl.CAM_FOLLOW_DIST;
    }

    if (camera) {
      camera.lowerRadiusLimit = 2 * sy;
      camera.upperRadiusLimit = 20 * sy;
      camera.radius = Math.max(camera.lowerRadiusLimit, Math.min(camera.upperRadiusLimit, ctrl.CAM_FOLLOW_DIST));

      camera.wheelPrecision = 55 / sy;
      camera.pinchPrecision = 55 / sy;
      if (camera.inputs && camera.inputs.attached) {
        const mw = camera.inputs.attached.mousewheel || camera.inputs.attached.mouseWheel;
        if (mw) {
          mw.wheelPrecision = 55 / sy;
          if (mw.wheelPrecisionY !== undefined) mw.wheelPrecisionY = 55 / sy;
          if (mw.wheelPrecisionX !== undefined) mw.wheelPrecisionX = 55 / sy;
          if (mw.wheelPrecisionZ !== undefined) mw.wheelPrecisionZ = 55 / sy;
        }
        const ptrs = camera.inputs.attached.pointers || camera.inputs.attached.pointersInput;
        if (ptrs) {
          ptrs.pinchPrecision = 55 / sy;
        }
      }
      camera.panningSensibility = 1000 / sy;
      camera.angularSensibilityX = (ctrl._originalSensibilityX || 1000) / sy;
      camera.angularSensibilityY = (camera.angularSensibilityY || 1000) / sy;
    }

    // Sync camera distance HUD slider limits and value
    const distSlider = document.getElementById('slider-cam-dist');
    const distVal = document.getElementById('slider-cam-dist-val');
    if (distSlider) {
      distSlider.min = 2 * sy;
      distSlider.max = 15 * sy;
      distSlider.step = 0.1 * sy;
      distSlider.value = ctrl.CAM_FOLLOW_DIST;
    }
    if (distVal) {
      distVal.textContent = ctrl.CAM_FOLLOW_DIST.toFixed(1) + 'm';
    }

    ctrl._lastAppliedScaleY = sy;

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
  setSlider('slider-shoulder-raise', charTransformConfig.SHOULDER_RAISE_ANGLE, '°');
  setSlider('slider-leg-spread', charTransformConfig.LEG_SPREAD_ANGLE, '°');
  setSlider('slider-spine-straighten', charTransformConfig.SPINE_STRAIGHTEN_ANGLE, '°');
  setSlider('slider-hips-tilt', charTransformConfig.HIPS_TILT_ANGLE, '°');
  setSlider('slider-foot-toe-out', charTransformConfig.FOOT_TOE_OUT_ANGLE, '°');
  setSlider('slider-hand-relax', charTransformConfig.HAND_RELAX_ANGLE, '°');
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
  const shoulderR = document.getElementById('slider-shoulder-raise');
  const legS = document.getElementById('slider-leg-spread');
  const spineS = document.getElementById('slider-spine-straighten');
  const hipsT = document.getElementById('slider-hips-tilt');
  const footT = document.getElementById('slider-foot-toe-out');
  const handR = document.getElementById('slider-hand-relax');
  if (armS) { armS.min = "-10"; armS.max = "10"; }
  if (armSplay) { armSplay.min = "-30"; armSplay.max = "30"; }
  if (shoulderR) { shoulderR.min = "-15"; shoulderR.max = "15"; }
  if (legS) { legS.min = "-10"; legS.max = "10"; }
  if (spineS) { spineS.min = "-30"; spineS.max = "30"; }
  if (hipsT) { hipsT.min = "-30"; hipsT.max = "30"; }
  if (footT) { footT.min = "-45"; footT.max = "45"; }
  if (handR) { handR.min = "-30"; handR.max = "30"; }

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
  const shoulderRaiseSlider = document.getElementById('slider-shoulder-raise');
  const legSpreadSlider = document.getElementById('slider-leg-spread');
  const spineStraightenSlider = document.getElementById('slider-spine-straighten');
  const hipsTiltSlider = document.getElementById('slider-hips-tilt');
  const footToeOutSlider = document.getElementById('slider-foot-toe-out');
  const handRelaxSlider = document.getElementById('slider-hand-relax');
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
    charTransformConfig.SHOULDER_RAISE_ANGLE = shoulderRaiseSlider ? parseFloat(shoulderRaiseSlider.value) : 0.0;
    charTransformConfig.LEG_SPREAD_ANGLE = legSpreadSlider ? parseFloat(legSpreadSlider.value) : 0.0;
    charTransformConfig.SPINE_STRAIGHTEN_ANGLE = spineStraightenSlider ? parseFloat(spineStraightenSlider.value) : 0.0;
    charTransformConfig.HIPS_TILT_ANGLE = hipsTiltSlider ? parseFloat(hipsTiltSlider.value) : 0.0;
    charTransformConfig.FOOT_TOE_OUT_ANGLE = footToeOutSlider ? parseFloat(footToeOutSlider.value) : 0.0;
    charTransformConfig.HAND_RELAX_ANGLE = handRelaxSlider ? parseFloat(handRelaxSlider.value) : 0.0;

    syncCharTransformToUI();
    applyLiveTransformations();
    savePreferences();
    updateExportCode();
    // The clean preview buffer bakes scale/pivot; any transform change makes it
    // stale. Drop it so the next drag-after-bake rebuilds it.
    cleanPreviewBuffer = null;
  };

  // SCALE: live wrapper while dragging, BAKE into geometry on release + reset the
  // slider to 1 (re-touching never multiplies the same value twice).
  // PIVOT: NEVER baked — folding pivot into the geometry deforms the character.
  // It stays a live wrapper offset and is folded only at export via getMergeOptions.
  const onScalePivotInput = () => {
    if (posturePreviewBaked) {
      posturePreviewBaked = false;
      enterLivePosturePreview();
    }
    onSliderChange();
  };
  uniformToggle?.addEventListener('change', () => { onScalePivotInput(); scheduleScalePivotBake(); });
  [uniformSlider, scaleXSlider, scaleYSlider, scaleZSlider].forEach(s => {
    s?.addEventListener('input', onScalePivotInput);
    s?.addEventListener('change', scheduleScalePivotBake); // release → bake scale, reset slider
  });
  [pivotXSlider, pivotYSlider, pivotZSlider].forEach(s => {
    s?.addEventListener('input', onScalePivotInput); // live wrapper only, no bake
  });
  // Posture sliders: live exact preview while dragging (observer), bake on release.
  const postureSliders = [armSpreadSlider, armSplaySlider, shoulderRaiseSlider,
    legSpreadSlider, spineStraightenSlider, hipsTiltSlider, footToeOutSlider, handRelaxSlider];

  // First drag after a bake → swap back to the clean buffer so the observer layers
  // the live offset on a clean bind (not on the already-baked pose).
  const onPostureInput = () => {
    if (posturePreviewBaked) {
      posturePreviewBaked = false;
      enterLivePosturePreview();
    }
    onSliderChange();
  };
  postureSliders.forEach(s => {
    s?.addEventListener('input', onPostureInput);
    s?.addEventListener('change', schedulePostureRebake); // release → bake into the GLB
  });

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
  const dracoEl = document.getElementById('export-draco');
  return {
    COMPRESS_OUTPUT: dracoEl ? dracoEl.checked : true,
    SCALE_X: charTransformConfig.SCALE_X,
    SCALE_Y: charTransformConfig.SCALE_Y,
    SCALE_Z: charTransformConfig.SCALE_Z,
    PIVOT_X: charTransformConfig.PIVOT_X,
    PIVOT_Y: charTransformConfig.PIVOT_Y,
    PIVOT_Z: charTransformConfig.PIVOT_Z,
    ARM_SPREAD_ANGLE: charTransformConfig.ARM_SPREAD_ANGLE,
    ARM_SPLAY_ANGLE: charTransformConfig.ARM_SPLAY_ANGLE,
    SHOULDER_RAISE_ANGLE: charTransformConfig.SHOULDER_RAISE_ANGLE,
    LEG_SPREAD_ANGLE: charTransformConfig.LEG_SPREAD_ANGLE,
    SPINE_STRAIGHTEN_ANGLE: charTransformConfig.SPINE_STRAIGHTEN_ANGLE,
    HIPS_TILT_ANGLE: charTransformConfig.HIPS_TILT_ANGLE,
    FOOT_TOE_OUT_ANGLE: charTransformConfig.FOOT_TOE_OUT_ANGLE,
    HAND_RELAX_ANGLE: charTransformConfig.HAND_RELAX_ANGLE,
    removeExistingAnimations: true,
    ...extra
  };
}

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// SLIDER RESET — double-click or right-click resets a range
// slider to its default (HTML `value` attribute) value.
// Delegated so it covers every current and future range input.
// ═══════════════════════════════════════════════════════════
function setupSliderReset() {
  function resetSlider(slider) {
    const def = slider.defaultValue; // original HTML `value` attribute
    if (slider.value === def) return;
    slider.value = def;
    // Fire input + change so existing handlers update the value label,
    // the model transform, autorig pose, etc.
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }

  document.addEventListener('dblclick', (e) => {
    const slider = e.target.closest('input[type="range"]');
    if (slider) resetSlider(slider);
  });

  document.addEventListener('contextmenu', (e) => {
    const slider = e.target.closest('input[type="range"]');
    if (!slider) return;
    e.preventDefault(); // suppress browser context menu on the slider
    resetSlider(slider);
  });
}

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
  setupSliderReset();

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
  setSlider('slider-cam-tilt', physicsConfig.CAM_TILT_AMOUNT);

  const pitchDeg = Math.round(physicsConfig.CAM_FOLLOW_PITCH * 180 / Math.PI);
  setSlider('slider-cam-pitch', pitchDeg, '°');

  setCheckbox('toggle-cam-follow-lock', physicsConfig.CAM_FOLLOW_LOCK);
  setCheckbox('toggle-cam-lock-pitch', physicsConfig.CAM_LOCK_PITCH);
  setCheckbox('toggle-joystick-lock-x', physicsConfig.JOYSTICK_LOCK_X);
  setCheckbox('toggle-dynamic-fov', physicsConfig.DYNAMIC_FOV);
  setCheckbox('toggle-cam-tilt', physicsConfig.CAM_TILT);
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
    document.getElementById(id)?.classList.remove('dropzone-disabled');
  });

  const btnIds = ['btn-add-single-anim', 'btn-clear-all-anims'];
  btnIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('btn-disabled-offline');
    el.removeAttribute('title');
  });

  document.querySelectorAll('.btn-anim-delete').forEach(btn => {
    btn.classList.remove('btn-disabled-offline');
    btn.setAttribute('title', 'Remove this animation');
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
  camera.checkCollisions = false;
  camera.lowerRadiusLimit = 2;
  camera.upperRadiusLimit = 20;
  camera.lowerBetaLimit = 0.05;
  camera.upperBetaLimit = Math.PI / 2.05;
  camera.wheelPrecision = 55; // Comfortable, precise wheel zoom speed
  camera.pinchPrecision = 55; // Comfortable, precise pinch zoom speed
  // Camera tracks the pointer live while dragging with a soft settle on release.
  // Default 0.9 drifts too long after release; 0 is too abrupt. ~0.5 follows
  // during the drag and eases to a stop quickly.
  camera.inertia = 0.85;
  camera.panningInertia = 0.85;
  camera.attachControl(canvas, true);
  if (camera.inputs && camera.inputs.attached) {
    const mw = camera.inputs.attached.mousewheel || camera.inputs.attached.mouseWheel;
    if (mw) {
      mw.wheelPrecision = 55;
      if (mw.wheelPrecisionY !== undefined) mw.wheelPrecisionY = 55;
    }
    const ptrs = camera.inputs.attached.pointers || camera.inputs.attached.pointersInput;
    if (ptrs) {
      ptrs.pinchPrecision = 55;
    }
  }
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
    const response = await fetch('assets/character_animated_1.glb');
    if (!response.ok) throw new Error('Assets character GLB not found.');
    const buf = await response.arrayBuffer();
    setLoaderStep('read', 'completed');
    const file = new File([buf], 'character_animated_1.glb');
    await loadCharacterMeshFile(file, buf);
    animationsGlbBuffer = buf;
    cleanPreviewBuffer = null; // anims changed → posture-free preview base is stale
  } catch (e) {
    console.warn('Could not load assets/character_animated_1.glb, waiting for user import.', e);
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
    lastAppliedRig = null; // genuine new import → drop any remembered rig
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
  animationsCleared = false; // fresh load resets the cleared state
  cleanPreviewBuffer = null; // new character → rebuild the posture-free preview base
  scaledCharacterBuffer = null; // new character → drop any accumulated scale/pivot
  characterFilename = file.name;
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
    // like a mixamo.com export / t-pose) → use default animations-basic.glb
    if (!animationsGlbBuffer && detectedAnimations.length <= 1) {
      try {
        const animRes = await fetch('assets/animations-basic.glb');
        if (animRes.ok) {
          animationsGlbBuffer = await animRes.arrayBuffer();
          showToast(detectedAnimations.length === 0
            ? 'No animations in character — using default animations-basic.glb'
            : 'Only one animation in character — adding default animations-basic.glb');
        } else {
          console.warn('assets/animations-basic.glb not found, skipping default animations.');
        }
      } catch (e) {
        console.warn('Could not fetch default animations-basic.glb:', e);
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

// Build (once) the posture-free GLB — same merge as export but with every posture
// angle zeroed. Used as the live drag base so the observer layers its offset on a
// clean bind, never on top of an already-baked pose (which would double it).
async function ensureCleanPreviewBuffer() {
  if (cleanPreviewBuffer) return cleanPreviewBuffer;
  if (!isServerAvailable || !originalCharacterGlbBuffer) return null;
  const hasAnim = animationsGlbBuffer && animationsGlbBuffer.byteLength > 0;
  const opts = getMergeOptions({ removeExistingAnimations: hasAnim });
  // Zero posture AND scale/pivot: the live drag preview applies these via the
  // capsule/wrapper transform, so the base buffer must be neutral or they'd stack
  // (baked geometry × wrapper = double size/offset).
  for (const k of ['ARM_SPREAD_ANGLE', 'ARM_SPLAY_ANGLE', 'SHOULDER_RAISE_ANGLE', 'LEG_SPREAD_ANGLE',
    'SPINE_STRAIGHTEN_ANGLE', 'HIPS_TILT_ANGLE', 'FOOT_TOE_OUT_ANGLE', 'HAND_RELAX_ANGLE',
    'PIVOT_X', 'PIVOT_Y', 'PIVOT_Z']) opts[k] = 0;
  opts.SCALE_X = 1; opts.SCALE_Y = 1; opts.SCALE_Z = 1;
  const formData = new FormData();
  formData.append('character', new Blob([originalCharacterGlbBuffer], { type: 'model/gltf-binary' }), 'character.glb');
  if (hasAnim) formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations-basic.glb');
  formData.append('options', JSON.stringify(opts));
  const res = await fetch('/api/merge', { method: 'POST', body: formData });
  if (!res.ok) throw new Error('clean preview merge failed');
  cleanPreviewBuffer = await res.arrayBuffer();
  return cleanPreviewBuffer;
}

// First drag after a bake: swap the scene to the clean (posture-free) GLB so the
// live observer offset applies on a clean bind. Keeps posturePreviewBaked=false.
async function enterLivePosturePreview() {
  if (!isServerAvailable || _enteringLivePreview) return;
  _enteringLivePreview = true;
  try {
    const buf = await ensureCleanPreviewBuffer();
    if (buf) await _loadGlbIntoScene(buf, 'clean-preview.glb'); // resets posturePreviewBaked=false
  } catch (err) {
    console.warn('[posture] clean preview load failed; observer may double on baked pose:', err);
  } finally {
    _enteringLivePreview = false;
  }
}

// On slider release: bake the current posture on the server (the exact export
// pipeline) and reload, so the clips carry the pose in their tracks — no snapping.
function schedulePostureRebake() {
  if (!isServerAvailable || !originalCharacterGlbBuffer) return; // observer-only fallback (offline)
  if (_postureRebakeTimer) clearTimeout(_postureRebakeTimer);
  _postureRebakeTimer = setTimeout(() => { _postureRebakeTimer = null; rebakePosturePreview(); }, 350);
}

async function rebakePosturePreview() {
  if (!isServerAvailable || !originalCharacterGlbBuffer) return;
  const hasAnim = animationsGlbBuffer && animationsGlbBuffer.byteLength > 0;
  // After "Clear All" the character must stay animation-free. Strip baked anims
  // on every re-merge too, otherwise a posture/param change re-bakes from the
  // original (which still carries its clips) and the groups reappear.
  const stripAnims = hasAnim || animationsCleared;
  showLoading('Applying posture…');
  try {
    const formData = new FormData();
    // Bake posture from the scale-baked baseline if it exists (so accumulated
    // scale/pivot is preserved), else the CLEAN original. Posture is applied once,
    // not stacked, because the base never carries posture.
    const postureBase = scaledCharacterBuffer || originalCharacterGlbBuffer;
    formData.append('character', new Blob([postureBase], { type: 'model/gltf-binary' }), 'character.glb');
    if (hasAnim) formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations-basic.glb');
    // Bake POSTURE only — scale/pivot are already in the baseline geometry (or the
    // live wrapper applies them), so zero them here to avoid doubling.
    const opts = getMergeOptions({ removeExistingAnimations: stripAnims, keepTPose: stripAnims && !hasAnim });
    opts.SCALE_X = 1; opts.SCALE_Y = 1; opts.SCALE_Z = 1;
    opts.PIVOT_X = 0; opts.PIVOT_Y = 0; opts.PIVOT_Z = 0;
    formData.append('options', JSON.stringify(opts));

    const res = await fetch('/api/merge', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Server merge failed');
    }
    const mergedBuffer = await res.arrayBuffer();
    characterGlbBuffer = mergedBuffer;          // this is what export uses
    if (hasAnim) animationsCleared = false;     // only real new anims un-clear; cleared state persists otherwise
    await _loadGlbIntoScene(mergedBuffer, 'merged.glb'); // sets posturePreviewBaked=false
    posturePreviewBaked = true;                 // pose now lives in the GLB → observer holds at 0
    hideLoading();
  } catch (err) {
    console.error('[posture-rebake] server merge failed:', err);
    posturePreviewBaked = false;                // keep the live observer preview
    hideLoading();
  }
}

// On scale/pivot slider release: fold the current scale/pivot into the geometry
// (accumulating onto the previous baked result), reload, then reset the sliders to
// neutral so re-touching never multiplies the same value twice.
function scheduleScalePivotBake() {
  if (!isServerAvailable || !originalCharacterGlbBuffer) return; // wrapper-only fallback (offline)
  // Only SCALE is baked — nothing to do if scale is already neutral (1,1,1).
  const sx = charTransformConfig.SCALE_X, sy = charTransformConfig.SCALE_Y, sz = charTransformConfig.SCALE_Z;
  const neutral = Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6 && Math.abs(sz - 1) < 1e-6;
  if (neutral) return;
  if (_scalePivotBakeTimer) clearTimeout(_scalePivotBakeTimer);
  _scalePivotBakeTimer = setTimeout(() => { _scalePivotBakeTimer = null; bakeScalePivot(); }, 350);
}

async function bakeScalePivot() {
  if (!isServerAvailable || !originalCharacterGlbBuffer) return;
  const hasAnim = animationsGlbBuffer && animationsGlbBuffer.byteLength > 0;
  const stripAnims = hasAnim || animationsCleared;
  showLoading('Applying scale…');
  try {
    // Base = the previously scale-baked buffer (accumulate) or the pristine original.
    const base = scaledCharacterBuffer || originalCharacterGlbBuffer;
    const formData = new FormData();
    formData.append('character', new Blob([base], { type: 'model/gltf-binary' }), 'character.glb');
    if (hasAnim) formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations-basic.glb');
    // Fold the CURRENT SCALE only. Zero posture (own bake path) AND zero pivot —
    // baking pivot into the geometry deforms the character; pivot stays a live
    // wrapper offset and is folded only at final export.
    const opts = getMergeOptions({ removeExistingAnimations: stripAnims, keepTPose: stripAnims && !hasAnim });
    ['ARM_SPREAD_ANGLE', 'ARM_SPLAY_ANGLE', 'SHOULDER_RAISE_ANGLE', 'LEG_SPREAD_ANGLE',
      'SPINE_STRAIGHTEN_ANGLE', 'HIPS_TILT_ANGLE', 'FOOT_TOE_OUT_ANGLE', 'HAND_RELAX_ANGLE'].forEach(k => { opts[k] = 0; });
    opts.POSE_OFFSETS = {};
    opts.PIVOT_X = 0; opts.PIVOT_Y = 0; opts.PIVOT_Z = 0;
    formData.append('options', JSON.stringify(opts));

    const res = await fetch('/api/merge', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Server merge failed');
    }
    const merged = await res.arrayBuffer();
    scaledCharacterBuffer = merged;   // new accumulated baseline (scale in geometry)
    characterGlbBuffer = merged;      // export uses this
    if (hasAnim) animationsCleared = false;

    // Reset SCALE sliders/config to neutral — scale now lives in geometry. Pivot is
    // NOT touched (it was never baked; it stays a live wrapper offset).
    charTransformConfig.SCALE_X = 1; charTransformConfig.SCALE_Y = 1; charTransformConfig.SCALE_Z = 1;
    charTransformConfig.SCALE_UNIFORM = 1;
    cleanPreviewBuffer = null;        // stale: baseline changed
    syncCharTransformToUI();

    await _loadGlbIntoScene(merged, 'scaled.glb'); // posturePreviewBaked=false → wrapper re-applies live pivot
    savePreferences();
    updateExportCode();
    hideLoading();
  } catch (err) {
    console.error('[scale-bake] server merge failed:', err);
    hideLoading();
    showToast('Failed to apply scale: ' + err.message, true);
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
      formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations-basic.glb');

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
      animationsCleared = false;
      await _loadGlbIntoScene(mergedBuffer, 'merged.glb');
      await updateSkeletonInfoAfterMerge(mergedBuffer);
      setLoaderStep('merge', 'completed');
      hideLoading();
      showToast(`✓ Merged with preloaded animations! ${detectedAnimations.length} animations loaded.`);
    } catch (err) {
      completeMergeProgress();
      console.error('Server merge failed for preloaded animations, falling back to client-side load:', err);
      showToast('Server merge failed — falling back to client-side retargeting.', true);
      try {
        await loadAnimationsOffline(animationsGlbBuffer, 'animations-basic.glb');
      } catch (clientErr) {
        console.error('Client-side retargeting fallback failed:', clientErr);
        showToast('Client-side retargeting failed: ' + clientErr.message, true);
      }
      setLoaderStep('merge', 'completed');
      hideLoading();
    }
  } else {
    showLoading(`Retargeting preloaded animations on client…`);
    try {
      await loadAnimationsOffline(animationsGlbBuffer, 'animations-basic.glb');
      showToast(`✓ Client-side retargeted preloaded animations! ${detectedAnimations.length} animations loaded.`);
    } catch (err) {
      console.error(err);
      showToast('Client-side retargeting failed: ' + err.message, true);
    }
    setLoaderStep('merge', 'completed');
    hideLoading();
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
  cleanPreviewBuffer = null; // anims changed → posture-free preview base is stale
  animationsFilename = file.name;
  setLoaderStep('read', 'completed');
  setLoaderStep('merge', 'active');

  if (isServerAvailable) {
    showMergeProgress(true, `Merging ${file.name} on server…`);
    try {
      // Prefer the scale-baked baseline so an import keeps the applied scale/pivot;
      // fall back to the pristine original. Both are posture-free, so retarget stays clean.
      const baseBuffer = scaledCharacterBuffer || originalCharacterGlbBuffer || characterGlbBuffer;
      console.log(`[batch-import] Using ${scaledCharacterBuffer ? 'scaled' : (originalCharacterGlbBuffer ? 'original' : 'current')} character buffer (${(baseBuffer.byteLength / 1024).toFixed(0)} KB) + anim file (${(animBuffer.byteLength / 1024).toFixed(0)} KB)`);
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
      animationsCleared = false;
      await _loadGlbIntoScene(mergedBuffer, 'merged.glb');
      await updateSkeletonInfoAfterMerge(mergedBuffer);
      console.log(`[batch-import] Detected animations after load: [${detectedAnimations.join(', ')}]`);
      setLoaderStep('merge', 'completed');

      hideLoading();
      showToast(`✓ Merged! ${detectedAnimations.length} animations loaded.`);
    } catch (err) {
      completeMergeProgress();
      console.error('Server merge failed, falling back to client-side load:', err);
      showToast('Server merge failed — falling back to client-side retargeting.', true);
      try {
        await loadAnimationsOffline(animBuffer, file.name);
      } catch (clientErr) {
        console.error('Client-side retargeting fallback failed:', clientErr);
        showToast('Client-side retargeting failed: ' + clientErr.message, true);
      }
      setLoaderStep('merge', 'completed');
      hideLoading();
    }
  } else {
    // Offline fallback: load animation file directly with client retargeting
    showLoading(`Retargeting ${file.name} on client…`);
    try {
      await loadAnimationsOffline(animBuffer, file.name);
      showToast(`✓ Client-side retargeted animations! ${detectedAnimations.length} animations loaded.`);
    } catch (err) {
      console.error(err);
      showToast('Client-side retargeting failed: ' + err.message, true);
    }
    setLoaderStep('merge', 'completed');
    hideLoading();
  }
}

// ═══════════════════════════════════════════════════════════
// SINGLE ANIMATION MERGE
// ═══════════════════════════════════════════════════════════
async function addSingleAnimationFile(file) {
  await loadAnimationBatchFile(file); // same pipeline — additive merge
}

// ═══════════════════════════════════════════════════════════
// OFFLINE RUNTIME RETARGETING (Fallback via AnimatorAvatar)
// ═══════════════════════════════════════════════════════════
async function loadAnimationsOffline(arrayBuffer, filename) {
  if (!activeCharacter) {
    throw new Error('Load a character mesh first!');
  }

  const blob = new Blob([arrayBuffer]);
  const blobUrl = URL.createObjectURL(blob);
  const container = await BABYLON.SceneLoader.LoadAssetContainerAsync('', blobUrl, scene, null, '.glb');
  URL.revokeObjectURL(blobUrl);

  const sourceGroups = container.animationGroups;
  if (!sourceGroups || sourceGroups.length === 0) {
    throw new Error("No animation groups found in the animation file.");
  }

  const skeleton = scene.skeletons[0];
  const characterRoot = activeCharacter.charRoot;

  // Save and temporarily adjust Character Creator A-pose arms to T-pose for sampling rest matrices
  const lUpperArm = skeleton ? skeleton.bones.find(b => b.name.toLowerCase() === 'cc_base_l_upperarm') : null;
  const rUpperArm = skeleton ? skeleton.bones.find(b => b.name.toLowerCase() === 'cc_base_r_upperarm') : null;

  let lOrigRot = null, rOrigRot = null;
  if (lUpperArm) {
    lOrigRot = lUpperArm.rotation.clone();
    lUpperArm.rotate(BABYLON.Axis.Z, -Math.PI / 6, BABYLON.Space.LOCAL); // rotate left arm up by ~30 deg
  }
  if (rUpperArm) {
    rOrigRot = rUpperArm.rotation.clone();
    rUpperArm.rotate(BABYLON.Axis.Z, Math.PI / 6, BABYLON.Space.LOCAL); // rotate right arm up by ~30 deg
  }

  const avatar = new BABYLON.AnimatorAvatar("activeCharAvatar", characterRoot);

  // Restore original rotations
  if (lUpperArm && lOrigRot) lUpperArm.rotation.copyFrom(lOrigRot);
  if (rUpperArm && rOrigRot) rUpperArm.rotation.copyFrom(rOrigRot);

  const boneMap = new Map();
  const targetBones = skeleton ? skeleton.bones : [];
  const targetByName = new Map();
  const targetByNorm = new Map();
  targetBones.forEach(bone => {
    targetByName.set(bone.name.toLowerCase(), bone.name);
    const norm = normBone(bone.name);
    if (norm) targetByNorm.set(norm, bone.name);
  });

  const boneAliases = {
    'mixamorig:spine': 'cc_base_waist',
    'mixamorig:spine1': 'cc_base_spine01',
    'mixamorig:spine2': 'cc_base_spine02',
    'mixamorig:neck': 'cc_base_necktwist01',
    'mixamorig:neck1': 'cc_base_necktwist02',
  };

  sourceGroups.forEach(sg => {
    sg.targetedAnimations.forEach(ta => {
      const srcNode = ta.target;
      if (!srcNode || !srcNode.name) return;
      const srcName = srcNode.name;
      if (boneMap.has(srcName)) return;

      let matchedName = targetByName.get(srcName.toLowerCase());
      if (!matchedName) {
        const alias = boneAliases[srcName.toLowerCase()];
        if (alias) {
          matchedName = targetByName.get(alias);
        }
      }
      if (!matchedName) {
        const norm = normBone(srcName);
        matchedName = targetByNorm.get(norm);
      }
      if (matchedName) {
        boneMap.set(srcName, matchedName);
      }
    });
  });

  const findSourceNodeByNormalizedRole = (sg, role) => {
    const roleNorms = {
      hips: ['hips', 'pelvis', 'hip'],
      leftfoot: ['leftfoot', 'footl', 'leftankle', 'ankle_l'],
    };
    const searchList = roleNorms[role] || [];
    for (const ta of sg.targetedAnimations) {
      const node = ta.target;
      if (!node || !node.name) continue;
      const norm = normBone(node.name);
      if (searchList.some(s => norm.includes(s) || s.includes(norm))) return node.name;
    }
    return null;
  };

  const retargetedGroups = [];
  sourceGroups.forEach(sg => {
    const cleanName = cleanAnimName(sg.name);
    const srcRootName = findSourceNodeByNormalizedRole(sg, 'hips') || "Hips";
    const srcGroundName = findSourceNodeByNormalizedRole(sg, 'leftfoot') || "LeftFoot";

    const retargeted = avatar.retargetAnimationGroup(sg, {
      animationGroupName: cleanName,
      retargetAnimationKeys: true,
      fixRootPosition: true,
      fixGroundReference: true,
      rootNodeName: srcRootName,
      groundReferenceNodeName: srcGroundName,
      mapNodeNames: boneMap,
      fixGroundReferenceDynamicRefNode: true
    });

    // Filter retargeted animations in-place to prevent scaling and non-root translation deformations
    const filteredAnims = retargeted.targetedAnimations.filter(ta => {
      const targetNode = ta.target;
      if (!targetNode || !targetNode.name) return true;
      const property = ta.animation.targetProperty;

      // 1. Remove scaling tracks entirely
      if (property === 'scaling') return false;

      // 2. Remove position/translation tracks for all nodes except the root bone (Hips)
      if (property === 'position') {
        const nameLower = targetNode.name.toLowerCase();
        const isHips = nameLower.includes('hips') || nameLower.includes('pelvis') || nameLower.includes('hip');
        if (!isHips) return false;
      }

      return true;
    });
    retargeted.targetedAnimations.length = 0;
    retargeted.targetedAnimations.push(...filteredAnims);

    retargeted.stop();
    scene.addAnimationGroup(retargeted);
    retargetedGroups.push(retargeted);
  });

  // Clean up original animation groups from the loaded file
  container.dispose();

  // Update detected animations list
  const newAnimNames = retargetedGroups.map(ag => cleanAnimName(ag.name));
  detectedAnimations = [...new Set([...detectedAnimations, ...newAnimNames])];

  // Add/replace in rawAnimationGroups
  retargetedGroups.forEach(ag => {
    const cleanName = cleanAnimName(ag.name);
    const oldIdx = activeCharacter.rawAnimationGroups.findIndex(g => cleanAnimName(g.name) === cleanName);
    if (oldIdx !== -1) {
      const oldAg = activeCharacter.rawAnimationGroups[oldIdx];
      oldAg.stop();
      oldAg.dispose();
      activeCharacter.rawAnimationGroups.splice(oldIdx, 1);
    }
    activeCharacter.rawAnimationGroups.push(ag);
    // Re-map it in animCtrl
    activeCharacter.animCtrl.setAnimation(cleanName, ag);
  });
}

// ═══════════════════════════════════════════════════════════
// CORE GLB LOADER → BABYLON SCENE
// ═══════════════════════════════════════════════════════════
async function _loadGlbIntoScene(arrayBuffer, filename = 'model.glb', animOnly = false) {
  // A freshly loaded GLB carries no baked posture by default; the rebake path sets
  // this back to true after IT reloads. Default to the live observer preview.
  posturePreviewBaked = false;
  // Leave auto-rig adjust mode (restores hidden scene meshes, disposes markers/gizmo)
  // before the character the markers are parented to gets disposed.
  cancelAutoRigAdjust();

  // DEFERRED DISPOSE (anti-flicker): keep the OLD character visible while the new
  // GLB parses, then dispose old AFTER the new mesh exists — no empty-scene gap.
  // Snapshot what to tear down (old skeletons/groups), but don't dispose yet.
  const _prevCharacter = activeCharacter;
  const _prevSkeletons = scene && scene.skeletons ? [...scene.skeletons] : [];
  const _prevAnimGroups = scene && scene.animationGroups ? [...scene.animationGroups] : [];
  // Stop old groups now so they don't drive bones during the brief overlap.
  _prevAnimGroups.forEach(ag => { try { ag.stop(); } catch (e) { } });
  if (_prevCharacter) {
    // Detach observers immediately so the old controller stops updating mid-swap.
    if (_prevCharacter.boneOffsetObserver) scene.onAfterAnimationsObservable.remove(_prevCharacter.boneOffsetObserver);
    if (_prevCharacter.cameraFollowObserver) scene.unregisterBeforeRender(_prevCharacter.cameraFollowObserver);
    if (_prevCharacter.charCtrl?._updateObserver) scene.onBeforeRenderObservable.remove(_prevCharacter.charCtrl._updateObserver);
  }
  activeCharacter = null;

  const blob = new Blob([arrayBuffer]);
  const blobUrl = URL.createObjectURL(blob);

  const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', '', blobUrl, scene, null, '.glb');
  URL.revokeObjectURL(blobUrl);

  // New mesh is in the scene now — tear down the old character/skeletons/groups.
  // The new skeleton/groups are NOT in these snapshots, so they're safe.
  if (_prevCharacter) {
    try { _prevCharacter.charCtrl?.destroy(); } catch (e) { }
    try { _prevCharacter.animCtrl?.destroy(); } catch (e) { }
    try { _prevCharacter.playerCapsule?.dispose(); } catch (e) { }
  }
  _prevSkeletons.forEach(skel => { try { skel.dispose(); } catch (e) { } });
  // Dispose stale animation groups: a previous load leaves its groups in
  // scene.animationGroups; since AnimCtrl resolves clips by NAME, a stale group
  // (phantom mixamorig:* targets) can shadow the freshly-merged one and leave new
  // bones un-animated → mesh deforms.
  _prevAnimGroups.forEach(ag => { try { ag.dispose(); } catch (e) { } });

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
  if (charRoot.rotationQuaternion) {
    const euler = charRoot.rotationQuaternion.toEulerAngles();
    charRoot.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(0, euler.x, euler.z);
  } else {
    const euler = charRoot.rotation.clone();
    charRoot.rotation.set(euler.x, 0, euler.z);
  }

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
  // World axes must be the BIND-pose world rotation in SKELETON space — exactly
  // what merge_api uses (its bind world is derived from the IBMs). Earlier attempts
  // read node.absoluteRotationQuaternion or composed live node locals; both were
  // wrong because (a) they fold in the charRoot import rotation and (b) the idle
  // clip is already playing, so the live pose is animated, not bind. Result: the
  // foot axis came out ~50° off vertical ([-0.003,-0.634,0.773]) and the toe-out
  // over-rotated ~2×. The IBM is the animation-independent bind, identical to the
  // server's source — use it directly.
  const _tmpMat = new BABYLON.Matrix();
  const _tmpPos = new BABYLON.Vector3();
  const _tmpScl = new BABYLON.Vector3();
  const bindWorldRot = (bone) => {
    // Absolute inverse bind matrix (IBM); invert → absolute bind world matrix.
    const ibm = bone.getAbsoluteInverseBindMatrix
      ? bone.getAbsoluteInverseBindMatrix()
      : (bone.getInvertedAbsoluteTransform && bone.getInvertedAbsoluteTransform());
    if (!ibm) return BABYLON.Quaternion.Identity();
    ibm.invertToRef(_tmpMat);
    const q = new BABYLON.Quaternion();
    _tmpMat.decompose(_tmpScl, q, _tmpPos);
    return q;
  };
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
      // Bind world rotation from the IBM (animation-independent, = server source).
      const wq = bindWorldRot(bone);
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
        isThumb: role === 'finger' && /thumb/.test(boneRoleNorm(bone.name || node.name || '')),
        // Right thumb's Z hinge is mirrored vs left — track the side to flip sign.
        isRightThumb: role === 'finger' && /thumb/.test(boneRoleNorm(bone.name || node.name || '')) && /_r$|right|_r_/i.test(bone.name || node.name || ''),
        // Thumb distal tip (*_03) needs extra relax to straighten.
        isThumbTip: role === 'finger' && /thumb/.test(boneRoleNorm(bone.name || node.name || '')) && /(^|[^0-9])0?3([^0-9]|$)/.test(bone.name || node.name || ''),
        x: toLocal(BABYLON.Axis.X),
        y: toLocal(BABYLON.Axis.Y),
        z: toLocal(BABYLON.Axis.Z),
      });
    });
  });

  // CC/AccuRig rigs bind with supinated (toed-in) feet. Auto-apply a default
  // toe-out so they load straight; the user can still override via the slider.
  // Only seed when the value is still at rest (0) so a saved/manual value wins.
  {
    let isCC = false;
    scene.skeletons.forEach(skel => skel.bones.forEach(b => {
      if (/cc_base/i.test(b.name || '')) isCC = true;
    }));
    if (isCC && (charTransformConfig.FOOT_TOE_OUT_ANGLE || 0) === 0) {
      charTransformConfig.FOOT_TOE_OUT_ANGLE = -10;
      syncCharTransformToUI();
    }
  }

  // Set up observable to apply real-time bone rotation offsets (posture sliders)
  // Per-bone smoothing state: when a bone flips between "driven by animation"
  // and "resting at bind+offset" (clip with track ↔ clip without), the pose
  // source changes instantly and the bone snaps. Blend over a short window.
  const boneWasAnimated = new Map();   // uniqueId → bool
  const boneLastFinal = new Map();     // uniqueId → Quaternion (last applied)
  const boneBlend = new Map();         // uniqueId → { from: Quaternion, t: number }
  const BLEND_SECS = 0.18;
  activeCharacter.boneOffsetObserver = scene.onAfterAnimationsObservable.add(() => {
    if (!activeCharacter) return;
    const dt = scene.getEngine().getDeltaTime() / 1000;

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

    // Once the pose is baked into the loaded GLB, the observer must NOT re-apply it
    // (the clips already carry it) — hold all angles at 0. During a drag
    // posturePreviewBaked is false and the exact live offset returns.
    const armAngle = posturePreviewBaked ? 0 : (charTransformConfig.ARM_SPREAD_ANGLE || 0);
    const armSplay = posturePreviewBaked ? 0 : (charTransformConfig.ARM_SPLAY_ANGLE || 0);
    const shoulderRaise = posturePreviewBaked ? 0 : (charTransformConfig.SHOULDER_RAISE_ANGLE || 0);
    const legAngle = posturePreviewBaked ? 0 : (charTransformConfig.LEG_SPREAD_ANGLE || 0);
    const spineAngle = posturePreviewBaked ? 0 : (charTransformConfig.SPINE_STRAIGHTEN_ANGLE || 0);
    const hipsTilt = posturePreviewBaked ? 0 : (charTransformConfig.HIPS_TILT_ANGLE || 0);
    const toeOut = posturePreviewBaked ? 0 : (charTransformConfig.FOOT_TOE_OUT_ANGLE || 0);
    const handRelax = posturePreviewBaked ? 0 : (charTransformConfig.HAND_RELAX_ANGLE || 0);

    // 2. Loop through character bones and apply offsets about bind-world axes.
    // The character has multiple skins/skeletons that share the SAME bone
    // TransformNodes. Without de-duping, the offset was applied once PER skeleton
    // on the shared node — for an animated bone (no reset) that stacked, e.g. ×2
    // skeletons made a 20° toe-out look like 40°. Apply each node exactly once.
    const processedNodes = new Set();
    scene.skeletons.forEach(skel => {
      skel.bones.forEach(bone => {
        const node = bone.getTransformNode();
        if (!node || !node.rotationQuaternion) return;
        const axes = boneOffsetAxes.get(node.uniqueId);
        if (!axes) return;
        if (processedNodes.has(node.uniqueId)) return;
        processedNodes.add(node.uniqueId);

        const id = node.uniqueId;
        const isAnimated = animatedNodes.has(id);
        if (!isAnimated) {
          // In rig mode the Force-Pose (T/A) rotations become the base the
          // posture sliders layer on top of; otherwise reset to the bind pose.
          const base = autoRigState?.rigPoseBase?.get(id) || originalBoneRotations.get(id);
          if (base) {
            node.rotationQuaternion.copyFrom(base);
          }
        }

        const apply = (axis, deg) => {
          if (deg === 0) return;
          const q = BABYLON.Quaternion.RotationAxis(axis, deg * Math.PI / 180);
          node.rotationQuaternion.multiplyToRef(q, node.rotationQuaternion);
        };

        switch (axes.role) {
          case 'shoulderL':
            apply(axes.z, armAngle + shoulderRaise);
            apply(axes.y, -armSplay);
            break;
          case 'shoulderR':
            apply(axes.z, -(armAngle + shoulderRaise));
            apply(axes.y, armSplay);
            break;
          case 'armL':
            // counter shoulder raise: arm keeps world orientation (pure shrug)
            apply(axes.z, armAngle - shoulderRaise);
            apply(axes.y, -armSplay);
            break;
          case 'armR':
            apply(axes.z, -(armAngle - shoulderRaise));
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
          case 'footL':
            apply(axes.y, -toeOut); // toes point outward (left)
            break;
          case 'footR':
            apply(axes.y, toeOut);  // toes point outward (right)
            break;
          case 'finger':
            // Flexion is about the joint's LOCAL X (not the world-derived axes
            // the limbs use — finger frames are rolled ~90°). +relax opens the
            // hand (−X uncurls the pre-curled CC bind). The thumb's metacarpal is
            // rolled ~90° vs the other fingers, so local X is its TWIST axis —
            // rotating there spins the thumb. Its flexion hinge is local Z, so
            // relax the thumb about Z (smaller magnitude, THUMB_RELAX_SCALE).
            if (axes.isThumb) apply(BABYLON.Axis.Z, (axes.isRightThumb ? -1 : 1) * handRelax * THUMB_RELAX_SCALE * (axes.isThumbTip ? THUMB_TIP_SCALE : 1));
            else apply(BABYLON.Axis.X, -handRelax);
            break;
          case 'spine':
            apply(axes.x, spineAngle);
            if (axes.isSpineRoot) apply(axes.x, -hipsTilt); // counter: torso stays
            break;
          case 'hips':
            apply(axes.x, hipsTilt);
            break;
        }

        // Pose-source switch (animated ↔ rest) → blend instead of snapping
        const wasAnimated = boneWasAnimated.get(id);
        if (wasAnimated !== undefined && wasAnimated !== isAnimated) {
          const last = boneLastFinal.get(id);
          if (last) boneBlend.set(id, { from: last.clone(), t: 0 });
        }
        const blend = boneBlend.get(id);
        if (blend) {
          blend.t += dt;
          const k = blend.t / BLEND_SECS;
          if (k >= 1) {
            boneBlend.delete(id);
          } else {
            BABYLON.Quaternion.SlerpToRef(blend.from, node.rotationQuaternion, k, node.rotationQuaternion);
          }
        }

        boneWasAnimated.set(id, isAnimated);
        let last = boneLastFinal.get(id);
        if (!last) { last = new BABYLON.Quaternion(); boneLastFinal.set(id, last); }
        last.copyFrom(node.rotationQuaternion);
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
  const cameraFollowObserver = () => {
    if (!activeCharacter) return;
    if (autoRigState) return; // rig mode: user pans freely (right-drag), don't recenter
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const clampedDt = Math.max(0.001, Math.min(0.1, dt));
    const deflection = activeCharacter.charCtrl.visualLocalY - activeCharacter.charCtrl.targetLocalY;
    const currentScaleY = activeCharacter.playerCapsule.scaling.y;
    const tgt = activeCharacter.playerCapsule.position.add(new BABYLON.Vector3(0, (0.4 + deflection) * currentScaleY, 0));
    camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 1 - Math.exp(-15 * clampedDt));

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
  };
  scene.registerBeforeRender(cameraFollowObserver);
  activeCharacter.cameraFollowObserver = cameraFollowObserver;

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
// Exact joint world coords the user last applied (server render-world space).
// Re-entering Auto-Rig restores THESE verbatim instead of re-guessing from the
// post-merge bind pose — the default-animation merge after Apply nudges the
// bind (T-pose adjust, arm-droop), which otherwise made carefully-placed
// markers jump on re-entry. Keyed nowhere: it's the whole joint map + a token
// identifying which character buffer it belongs to.
let lastAppliedRig = null; // { joints: {name:[x,y,z]}, forBuffer: ArrayBuffer }

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

function renderAutoRigLegend(markers, gizmoManager) {
  const el = document.getElementById('autorig-legend');
  if (!el) return;

  const activeMarkers = markers || autoRigState?.markers;
  const activeGizmo = gizmoManager || autoRigState?.gizmoManager;
  if (!activeMarkers) return;

  const attachedJoint = activeGizmo?.attachedMesh?.metadata?.autorigJoint;

  el.innerHTML = `<div class="autorig-legend-title" style="margin-bottom: 8px;">Joint Markers<br>(Ctrl+Click Mesh to Place)</div>` +
    AUTORIG_JOINT_GROUPS.map(g => {
      const jointButtons = g.joints.map(j => {
        const activeClass = (j === attachedJoint) ? 'active' : '';
        const label = AUTORIG_JOINT_LABELS[j] || j;
        return `<button class="autorig-joint-btn ${activeClass}" data-joint="${j}" style="border-color:${g.color};">
          ${label}
        </button>`;
      }).join('');

      return `
        <div class="autorig-legend-group">
          <div class="autorig-legend-group-header">
            <span class="autorig-legend-dot" style="background:${g.color};color:${g.color};"></span>
            <span class="autorig-legend-group-label">${g.label}</span>
          </div>
          <div class="autorig-legend-buttons">
            ${jointButtons}
          </div>
        </div>
      `;
    }).join('');

  el.querySelectorAll('.autorig-joint-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const jointName = btn.dataset.joint;
      const m = activeMarkers.get(jointName);
      if (m && activeGizmo) {
        activeGizmo.attachToMesh(m);
        renderAutoRigLegend(activeMarkers, activeGizmo);
      }
    });
  });
}

function showAutoRigControls(show, hasExistingSkin = false) {
  const wrap = document.getElementById('autorig-controls');
  if (!wrap) return;
  wrap.style.display = (show && isServerAvailable && characterGlbBuffer) ? 'block' : 'none';
  const startBtn = document.getElementById('btn-autorig-start');
  if (startBtn) {
    startBtn.textContent = hasExistingSkin
      ? '💀 Re-Rig / Adjust Skeleton (BETA)'
      : '💀 Generate Skeleton (Auto-Rig - BETA)';
  }
  if (!show) cancelAutoRigAdjust();
}

function setupAutoRigControls() {
  document.getElementById('btn-autorig-start')?.addEventListener('click', startAutoRigAdjust);
  document.getElementById('btn-autorig-apply')?.addEventListener('click', applyAutoRig);
  document.getElementById('btn-autorig-cancel')?.addEventListener('click', cancelAutoRigAdjust);
  document.getElementById('btn-autorig-snap-body')?.addEventListener('click', snapAllMarkersToBody);
  document.getElementById('btn-autorig-apply-vp')?.addEventListener('click', applyAutoRig);
  document.getElementById('btn-autorig-cancel-vp')?.addEventListener('click', cancelAutoRigAdjust);
  document.querySelectorAll('.autorig-view-btn').forEach(btn => {
    btn.addEventListener('click', () => setRigView(btn.dataset.view));
  });
  document.getElementById('btn-autorig-rot-left')?.addEventListener('click', () => rotateRigCharacter(-Math.PI / 4));
  document.getElementById('btn-autorig-rot-right')?.addEventListener('click', () => rotateRigCharacter(Math.PI / 4));
  document.getElementById('btn-autorig-mockup-toggle')?.addEventListener('click', () => {
    const m = document.getElementById('autorig-mockup');
    if (!m) return;
    const collapsed = m.classList.toggle('collapsed');
    localStorage.setItem('builder_autorig_mockup_collapsed', collapsed ? '1' : '0');
    const btn = document.getElementById('btn-autorig-mockup-toggle');
    if (btn) btn.title = collapsed ? 'Show pose reference' : 'Hide pose reference';
  });
  document.querySelectorAll('.autorig-pose-btn').forEach(btn => {
    btn.addEventListener('click', () => forceAutoRigPose(btn.dataset.pose));
  });
  // Keyboard shortcuts: 1/2/3 views, Q/E rotate character, R/T/A poses, F focus toggle, while in rig mode
  window.addEventListener('keydown', (e) => {
    if (!autoRigState) return;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
    if (e.code === 'Digit1') setRigView('front');
    else if (e.code === 'Digit2') setRigView('side');
    else if (e.code === 'Digit3') setRigView('top');
    else if (e.code === 'KeyQ') rotateRigCharacter(-Math.PI / 4);
    else if (e.code === 'KeyE') rotateRigCharacter(Math.PI / 4);
    else if (e.code === 'KeyR') forceAutoRigPose('rest');
    else if (e.code === 'KeyT') forceAutoRigPose('t');
    else if (e.code === 'KeyA') forceAutoRigPose('a');
  });
}

// Visual-only character spin while placing rig markers. Rotating charRoot
// carries the markers along (they're parented inside it) but never touches
// the joint coordinates sent to the server — those are local to markerParent —
// and the original orientation is restored on exit, so the facing direction
// the controller relies on is untouched.
function rotateRigCharacter(deltaYaw) {
  const vm = autoRigState?.viewportMode;
  const root = activeCharacter?.charRoot;
  if (!vm || !root) return;
  autoRigState.rigYaw = (autoRigState.rigYaw || 0) + deltaYaw;
  const baseQ = vm.prevCharQuat
    ? vm.prevCharQuat
    : BABYLON.Quaternion.RotationYawPitchRoll(
      vm.prevCharEuler.y, vm.prevCharEuler.x, vm.prevCharEuler.z);
  root.rotationQuaternion = BABYLON.Quaternion
    .RotationYawPitchRoll(autoRigState.rigYaw, 0, 0)
    .multiply(baseQ);
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

  // Hide playground controls tooltip — irrelevant while rigging
  const ctrlTip = document.querySelector('.keyboard-controls-tooltip');
  const prevCtrlTipDisplay = ctrlTip ? ctrlTip.style.display : null;
  if (ctrlTip) ctrlTip.style.display = 'none';

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

  // Snapshot charRoot orientation so the rig-mode character spin (Q/E) can be
  // undone exactly — controller facing must survive the rig session.
  const charRoot = activeCharacter.charRoot;
  autoRigState.viewportMode = {
    hiddenMeshes, prevClearColor, hud, prevHudDisplay, ctrlTip, prevCtrlTipDisplay, pointerObserver,
    prevPanningSensibility, prevTarget: camera.target.clone(),
    prevCharQuat: charRoot?.rotationQuaternion ? charRoot.rotationQuaternion.clone() : null,
    prevCharEuler: charRoot ? charRoot.rotation.clone() : new BABYLON.Vector3(0, 0, 0),
  };

  // Restore persisted pose-reference mockup visibility
  const mockup = document.getElementById('autorig-mockup');
  if (mockup) {
    const collapsed = localStorage.getItem('builder_autorig_mockup_collapsed') === '1';
    mockup.classList.toggle('collapsed', collapsed);
    const mbtn = document.getElementById('btn-autorig-mockup-toggle');
    if (mbtn) mbtn.title = collapsed ? 'Show pose reference' : 'Hide pose reference';
  }

  setRigView('front');
}

function exitRigViewportMode(state) {
  const vm = state?.viewportMode;
  if (!vm) return;
  vm.hiddenMeshes.forEach(m => m.setEnabled(true));
  // Undo any rig-mode character spin: restore the exact pre-rig orientation
  const root = activeCharacter?.charRoot;
  if (root && state.rigYaw) {
    if (vm.prevCharQuat) root.rotationQuaternion = vm.prevCharQuat;
    else {
      root.rotationQuaternion = null;
      root.rotation.copyFrom(vm.prevCharEuler);
    }
  }
  if (vm.pointerObserver) scene.onPointerObservable.remove(vm.pointerObserver);
  scene.stopAnimation(camera);
  if (vm.prevPanningSensibility !== undefined) camera.panningSensibility = vm.prevPanningSensibility;
  if (vm.prevTarget) camera.target.copyFrom(vm.prevTarget); // undo any panning offset
  scene.clearColor = vm.prevClearColor;
  if (vm.hud) vm.hud.style.display = vm.prevHudDisplay || '';
  if (vm.ctrlTip) vm.ctrlTip.style.display = vm.prevCtrlTipDisplay || '';
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

  if (autoRigState) autoRigState.currentRigView = view;
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

// ── Force pose: Rest / T-Pose / A-Pose ───────────────────────────────────────
// Reposition the joint MARKERS (and their rest-space canonical coords, which is
// what the server actually rigs) into an ideal T- or A-pose layout derived from
// the character's own proportions. When the mesh already has a skeleton, also
// swing the arm bones so the mesh visibly assumes the pose and the markers,
// which follow their bound bone, stay glued to the limbs.
function setActivePoseButton(pose) {
  document.querySelectorAll('.autorig-pose-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pose === pose));
}

// Fit the affine [3×4] mapping local→server from point pairs via least squares
// (normal equations on the 4×4 Gram matrix). Handles rotation, non-uniform
// scale and mirror — enough to bridge Babylon scene space and the server's
// render-world space on flipped/scaled rigs. Returns { apply(Vector3)->[x,y,z] }
// or null when there aren't enough non-degenerate correspondences.
function fitAffine3D(pairs) {
  if (!pairs || pairs.length < 4) return null;
  // Design rows: [lx, ly, lz, 1]; solve for each server axis independently.
  // Normal matrix A (4×4) = Σ pᵀp ; rhs b_k (4) = Σ p·serverₖ
  const A = new Array(16).fill(0);
  const bx = [0, 0, 0, 0], by = [0, 0, 0, 0], bz = [0, 0, 0, 0];
  for (const { local, server } of pairs) {
    const p = [local.x, local.y, local.z, 1];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) A[r * 4 + c] += p[r] * p[c];
      bx[r] += p[r] * server[0];
      by[r] += p[r] * server[1];
      bz[r] += p[r] * server[2];
    }
  }
  const inv = invert4x4(A);
  if (!inv) return null;
  const solve = (b) => [0, 1, 2, 3].map(r =>
    inv[r * 4 + 0] * b[0] + inv[r * 4 + 1] * b[1] + inv[r * 4 + 2] * b[2] + inv[r * 4 + 3] * b[3]);
  const cx = solve(bx), cy = solve(by), cz = solve(bz); // each: [a,b,c,d] for axis
  return {
    apply: (v) => [
      cx[0] * v.x + cx[1] * v.y + cx[2] * v.z + cx[3],
      cy[0] * v.x + cy[1] * v.y + cy[2] * v.z + cy[3],
      cz[0] * v.x + cz[1] * v.y + cz[2] * v.z + cz[3],
    ],
    // Linear part only (no translation) — maps a markerParent-local DELTA into a
    // server-space delta. Exact for the rotation/scale/mirror between the spaces.
    applyDelta: (d) => [
      cx[0] * d.x + cx[1] * d.y + cx[2] * d.z,
      cy[0] * d.x + cy[1] * d.y + cy[2] * d.z,
      cz[0] * d.x + cz[1] * d.y + cz[2] * d.z,
    ],
  };
}

// General 4×4 inverse (Gauss-Jordan). Returns null if singular.
function invert4x4(m) {
  const a = m.slice(), inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r * 4 + col]) > Math.abs(a[piv * 4 + col])) piv = r;
    if (Math.abs(a[piv * 4 + col]) < 1e-12) return null;
    if (piv !== col) for (let k = 0; k < 4; k++) {
      [a[col * 4 + k], a[piv * 4 + k]] = [a[piv * 4 + k], a[col * 4 + k]];
      [inv[col * 4 + k], inv[piv * 4 + k]] = [inv[piv * 4 + k], inv[col * 4 + k]];
    }
    const d = a[col * 4 + col];
    for (let k = 0; k < 4; k++) { a[col * 4 + k] /= d; inv[col * 4 + k] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r * 4 + col];
      for (let k = 0; k < 4; k++) { a[r * 4 + k] -= f * a[col * 4 + k]; inv[r * 4 + k] -= f * inv[col * 4 + k]; }
    }
  }
  return inv;
}

function forceAutoRigPose(pose) {
  const st = autoRigState;
  if (!st) return;

  // ── Rest: undo Force-Pose bone rotations & restore the analyzed layout ──
  if (pose === 'rest') {
    st.rigPoseBase?.clear();   // posture observer falls back to the bind pose
    if (scene.skeletons?.length) scene.skeletons.forEach(sk => sk.returnToRest());
    st.appliedPose = null;
    st.restLayout.forEach((p, name) => {
      st.canonical.set(name, p.clone());
      const m = st.markers.get(name);
      // Bone-bound markers are re-placed by followObserver from canonical next
      // frame (bones now at rest ⇒ posed == canonical); place the rest directly.
      if (m) m.position.copyFrom(p);
    });
    setActivePoseButton('rest');
    showToast('Reset to rest pose.');
    return;
  }

  const skinned = !!scene.skeletons?.length && st.boneBindings.size > 0;
  if (skinned) poseSkeletonArms(pose);
  else poseMarkerLayout(pose);

  setActivePoseButton(pose);
  showToast(pose === 't' ? 'Forced T-Pose.' : 'Forced A-Pose.');
}

// Character body axes (world space). The mesh renders UPRIGHT and gravity-
// aligned in the scene, so vertical = world +Y — NOT hips→head (the head can
// jut forward, which tilted the whole pose). Lateral comes from the arm span,
// orthogonalized against world up. Returns { up, lateralL } or null.
function bodyAxesFromBones() {
  const st = autoRigState;
  const V = BABYLON.Vector3;
  const armL = st.boneBindings.get('LeftArm');
  const armR = st.boneBindings.get('RightArm');
  if (!armL || !armR) return null;
  [armL, armR].forEach(n => n.computeWorldMatrix(true));
  const up = V.Up(); // true vertical — keeps spine/legs straight, no forward lean
  const lateralL = armL.getAbsolutePosition().subtract(armR.getAbsolutePosition());
  if (lateralL.lengthSquared() < 1e-10) return null;
  up.normalize(); lateralL.normalize();
  // orthogonalize lateral against up
  lateralL.subtractInPlace(up.scale(V.Dot(lateralL, up)));
  if (lateralL.lengthSquared() < 1e-10) return null;
  lateralL.normalize();
  return { up, lateralL };
}

// Skinless mesh: no bones — lay the MARKERS out in an ideal T/A geometry.
// canonical (rest space) is what the server rigs.
function poseMarkerLayout(pose) {
  const st = autoRigState;
  const V = BABYLON.Vector3;
  const aDown = pose === 'a' ? Math.SQRT1_2 : 0;
  const aOut = pose === 'a' ? Math.SQRT1_2 : 1;
  for (const side of ['Left', 'Right']) {
    const sgn = side === 'Left' ? 1 : -1;
    const root = st.restLayout.get(side + 'Arm');
    const hand0 = st.restLayout.get(side + 'Hand');
    const fore0 = st.restLayout.get(side + 'ForeArm');
    if (!root || !hand0) continue;
    const armLen = V.Distance(root, hand0);
    const foreFrac = fore0 ? V.Distance(root, fore0) / Math.max(armLen, 1e-4) : 0.5;
    const dir = new V(sgn * aOut, -aDown, 0).normalize();
    const hand = root.add(dir.scale(armLen));
    const fore = root.add(dir.scale(armLen * foreFrac));
    st.canonical.set(side + 'Hand', hand);
    st.canonical.set(side + 'ForeArm', fore);
    st.markers.get(side + 'Hand')?.position.copyFrom(hand);
    st.markers.get(side + 'ForeArm')?.position.copyFrom(fore);
  }
}

// Skinned (re-rig) mesh: rotate the actual upper-arm bones so each arm points
// along the target direction in WORLD space, derived from the character's own
// body axes:  T → straight out laterally;  A → 45° down-and-out. Markers are
// bone-bound and follow via followObserver. canonical stays in rest space (the
// server rigs the base unposed GLB). The boneOffsetObserver is paused during
// rig mode (see startAutoRigAdjust) so these rotations are not reset each frame.
function poseSkeletonArms(pose) {
  const st = autoRigState;
  const B = (n) => st.boneBindings.get(n);
  // Clean slate so alternating presses don't compound.
  scene.skeletons.forEach(sk => sk.returnToRest());

  // Measure original foot directions at rest (bind pose)
  const footRestDirs = new Map();
  for (const side of ['Left', 'Right']) {
    const foot = B(side + 'Foot');
    const toe = B(side + 'ToeBase');
    if (foot && toe) {
      foot.computeWorldMatrix(true);
      toe.computeWorldMatrix(true);
      const v = toe.getAbsolutePosition().subtract(foot.getAbsolutePosition());
      if (v.lengthSquared() > 1e-8) {
        footRestDirs.set(side, v.normalizeToNew());
      }
    }
  }

  const axes = bodyAxesFromBones();
  if (!axes) { showToast('Could not read arm bones for posing.', true); return; }
  const up = axes.up;
  const down = up.scale(-1);
  let fwd = new BABYLON.Vector3(0, 0, 1);
  let sumFwd = new BABYLON.Vector3();
  let countFwd = 0;
  for (const side of ['Left', 'Right']) {
    const rd = footRestDirs.get(side);
    if (rd) {
      const horiz = new BABYLON.Vector3(rd.x, 0, rd.z);
      if (horiz.lengthSquared() > 1e-6) {
        sumFwd.addInPlace(horiz.normalize());
        countFwd++;
      }
    }
  }
  if (countFwd > 0) {
    fwd = sumFwd.scale(1 / countFwd).normalize();
  } else {
    const cross = BABYLON.Vector3.Cross(up, axes.lateralL).normalize();
    fwd = cross.z >= 0 ? cross : cross.scale(-1);
  }
  const aOut = pose === 'a' ? Math.SQRT1_2 : 1;
  const aDown = pose === 'a' ? Math.SQRT1_2 : 0;

  // ── Spine: straighten the column UPRIGHT (kills the arched-back look) ──────
  // Aim each segment toward its child along +up, parent→child.
  const spineChain = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'];
  for (let i = 0; i < spineChain.length - 1; i++) {
    const a = B(spineChain[i]), b = B(spineChain[i + 1]);
    if (a && b) aimBoneAlong(a, b, up);
  }

  // ── Legs: straighten DOWN (kills bent knees / crouch) ─────────────────────
  for (const side of ['Left', 'Right']) {
    const upLeg = B(side + 'UpLeg'), leg = B(side + 'Leg'), foot = B(side + 'Foot'), toe = B(side + 'ToeBase');
    if (upLeg && leg) aimBoneAlong(upLeg, leg, down);
    if (leg && foot) aimBoneAlong(leg, foot, down);

    // Align foot bone to point forward while preserving original rest pitch
    const restDir = footRestDirs.get(side);
    if (foot && toe && restDir) {
      const sin_theta = BABYLON.Vector3.Dot(restDir, up);
      const cos_theta = Math.sqrt(Math.max(0, 1 - sin_theta * sin_theta));
      const targetW = fwd.scale(cos_theta).add(up.scale(sin_theta)).normalize();
      aimBoneAlong(foot, toe, targetW);
    }
  }

  // ── Arms: T → straight out laterally;  A → 45° down-and-out ────────────────
  for (const side of ['Left', 'Right']) {
    const lateral = side === 'Left' ? axes.lateralL : axes.lateralL.scale(-1);
    const upper = B(side + 'Arm'), fore = B(side + 'ForeArm'), hand = B(side + 'Hand');
    if (!upper) continue;
    const targetW = lateral.scale(aOut).add(down.scale(aDown));
    if (targetW.lengthSquared() < 1e-10) continue;
    targetW.normalize();
    // Straight arm: aim EACH segment along targetW, parent → child, recomputing
    // world between them. Upper arm uses shoulder→elbow; forearm uses elbow→hand.
    aimBoneAlong(upper, fore || hand, targetW);
    if (fore && hand) aimBoneAlong(fore, hand, targetW);
  }

  // Capture the posed LOCAL rotation of every bound bone as the Force-Pose base
  // the posture observer resets to each frame (so sliders layer on top of the
  // pose instead of the bind). Non-role bones keep their pose untouched.
  st.rigPoseBase.clear();
  const seen = new Set();
  st.boneBindings.forEach((node) => {
    if (!node || seen.has(node.uniqueId)) return;
    seen.add(node.uniqueId);
    if (!node.rotationQuaternion) {
      node.rotationQuaternion = BABYLON.Quaternion.FromEulerVector(node.rotation);
    }
    st.rigPoseBase.set(node.uniqueId, node.rotationQuaternion.clone());
  });
  st.appliedPose = pose;
}

// Rotate `node` (a bone transform node) so the world segment node→tipNode points
// along world unit vector `targetW`. Composes the swing with the node's CURRENT
// absolute rotation, then converts back to parent-local — unambiguous ordering,
// works for any bind orientation and is exactly mirror-symmetric across sides.
function aimBoneAlong(node, tipNode, targetW) {
  const Q = BABYLON.Quaternion, V = BABYLON.Vector3;
  node.computeWorldMatrix(true);
  tipNode.computeWorldMatrix(true);
  const curW = tipNode.getAbsolutePosition().subtract(node.getAbsolutePosition());
  if (curW.lengthSquared() < 1e-10) return;
  curW.normalize();

  let axis = V.Cross(curW, targetW);
  const dot = Math.max(-1, Math.min(1, V.Dot(curW, targetW)));
  let swing;
  if (axis.lengthSquared() < 1e-12) {
    if (dot > 0) return;                       // already aligned
    axis = Math.abs(curW.x) < 0.9 ? V.Cross(curW, V.Right()) : V.Cross(curW, V.Up());
    swing = Q.RotationAxis(axis.normalize(), Math.PI);
  } else {
    swing = Q.RotationAxis(axis.normalize(), Math.acos(dot));
  }

  // World rotation after the swing: Rworld_new = swing ∘ Rworld_old
  const Rold = node.absoluteRotationQuaternion?.clone() || Q.Identity();
  const Rnew = swing.multiply(Rold);           // (this*q) applies q first, then this
  // Back to parent-local: Rlocal = Rparentⁱ ∘ Rworld_new
  const parent = node.parent;
  let Rlocal = Rnew;
  if (parent) {
    parent.computeWorldMatrix(true);
    const Rp = Q.FromRotationMatrix(parent.getWorldMatrix().getRotationMatrix());
    Rlocal = Rp.invert().multiply(Rnew);
  }
  if (!node.rotationQuaternion) node.rotationQuaternion = Q.Identity();
  node.rotationQuaternion.copyFrom(Rlocal);
  node.computeWorldMatrix(true);
}

// Left/right counterpart name, or null for center bones
function mirrorJointName(name) {
  if (name.startsWith('Left')) return 'Right' + name.slice(4);
  if (name.startsWith('Right')) return 'Left' + name.slice(5);
  return null;
}

// Map a dragged marker position to posture config angles in real-time
function mapMarkerToPosture(name, localPos) {
  const st = autoRigState;
  if (!st || !st.restLayout) return;

  const side = name.startsWith('Left') ? 'Left' : (name.startsWith('Right') ? 'Right' : null);
  const sgn = side === 'Left' ? 1 : -1;

  const axes = bodyAxesFromBones();
  if (!axes) return;
  const up = axes.up;
  const lateralL = axes.lateralL;

  // Compute fwd robustly from rest foot directions
  let fwd = new BABYLON.Vector3(0, 0, 1);
  let sumFwd = new BABYLON.Vector3();
  let countFwd = 0;
  const B = (n) => st.boneBindings.get(n);
  for (const sideName of ['Left', 'Right']) {
    const foot = B(sideName + 'Foot');
    const toe = B(sideName + 'ToeBase');
    if (foot && toe) {
      const vFoot = toe.getAbsolutePosition().subtract(foot.getAbsolutePosition());
      if (vFoot.lengthSquared() > 1e-8) {
        sumFwd.addInPlace(new BABYLON.Vector3(vFoot.x, 0, vFoot.z).normalize());
        countFwd++;
      }
    }
  }
  if (countFwd > 0) {
    fwd = sumFwd.scale(1 / countFwd).normalize();
  } else {
    const cross = BABYLON.Vector3.Cross(up, lateralL).normalize();
    fwd = cross.z >= 0 ? cross : cross.scale(-1);
  }

  const m = st.markers.get(name);
  if (!m) return;

  if (name.endsWith('Hand')) {
    const rootNode = B(side + 'Arm');
    if (rootNode) {
      const worldPos = m.getAbsolutePosition();
      const rootWorldPos = rootNode.getAbsolutePosition();
      const v = worldPos.subtract(rootWorldPos).normalize();

      const lateral = side === 'Left' ? lateralL : lateralL.scale(-1);
      const lat = BABYLON.Vector3.Dot(v, lateral);
      const vert = BABYLON.Vector3.Dot(v, up);
      const fwdComp = BABYLON.Vector3.Dot(v, fwd);

      const spread = Math.atan2(vert, lat) * 180 / Math.PI;
      const splay = Math.atan2(fwdComp, lat) * 180 / Math.PI;

      charTransformConfig.ARM_SPREAD_ANGLE = Math.max(-45, Math.min(45, spread / 2));
      charTransformConfig.ARM_SPLAY_ANGLE = Math.max(-45, Math.min(45, splay / 2));
      syncCharTransformToUI();
      applyLiveTransformations();
    }
  } else if (name.endsWith('Foot')) {
    const rootNode = B(side + 'UpLeg');
    if (rootNode) {
      const worldPos = m.getAbsolutePosition();
      const rootWorldPos = rootNode.getAbsolutePosition();
      const v = worldPos.subtract(rootWorldPos).normalize();

      const lateral = side === 'Left' ? lateralL : lateralL.scale(-1);
      const lat = BABYLON.Vector3.Dot(v, lateral);
      const vert = -BABYLON.Vector3.Dot(v, up); // down is positive

      const spread = Math.atan2(lat, vert) * 180 / Math.PI;
      charTransformConfig.LEG_SPREAD_ANGLE = Math.max(-45, Math.min(45, spread));
      syncCharTransformToUI();
      applyLiveTransformations();
    }
  } else if (name === 'Head' || name === 'Spine' || name === 'Spine1' || name === 'Spine2') {
    const rootNode = B('Hips');
    if (rootNode) {
      const worldPos = m.getAbsolutePosition();
      const rootWorldPos = rootNode.getAbsolutePosition();
      const v = worldPos.subtract(rootWorldPos).normalize();

      const vert = BABYLON.Vector3.Dot(v, up);
      const fwdComp = BABYLON.Vector3.Dot(v, fwd);

      const tilt = Math.atan2(fwdComp, vert) * 180 / Math.PI;
      charTransformConfig.SPINE_STRAIGHTEN_ANGLE = -Math.max(-45, Math.min(45, tilt / 3));
      syncCharTransformToUI();
      applyLiveTransformations();
    }
  } else if (name === 'Hips') {
    const rootNode = B('Hips');
    if (rootNode) {
      const worldPos = m.getAbsolutePosition();
      const originalHipsPos = st.restLayout.get('Hips');
      const originalHipsWorld = BABYLON.Vector3.TransformCoordinates(originalHipsPos, st.markerParent.getWorldMatrix());

      const diff = worldPos.subtract(originalHipsWorld);
      const fwdComp = BABYLON.Vector3.Dot(diff, fwd);
      const vert = Math.max(0.1, BABYLON.Vector3.Dot(worldPos, up));

      const tilt = Math.atan2(fwdComp, vert) * 180 / Math.PI;
      charTransformConfig.HIPS_TILT_ANGLE = -Math.max(-45, Math.min(45, tilt));
      syncCharTransformToUI();
      applyLiveTransformations();
    }
  }
}

// Map a rotated marker to posture config angles in real-time
function mapMarkerRotationToPosture(name, rotationQuaternion) {
  const st = autoRigState;
  if (!st) return;

  const side = name.startsWith('Left') ? 'Left' : (name.startsWith('Right') ? 'Right' : null);
  const sgn = side === 'Left' ? 1 : -1;

  const axes = bodyAxesFromBones();
  if (!axes) return;
  const up = axes.up;
  const lateralL = axes.lateralL;

  // Compute fwd robustly from rest foot directions
  let fwd = new BABYLON.Vector3(0, 0, 1);
  let sumFwd = new BABYLON.Vector3();
  let countFwd = 0;
  const B = (n) => st.boneBindings.get(n);
  for (const sideName of ['Left', 'Right']) {
    const foot = B(sideName + 'Foot');
    const toe = B(sideName + 'ToeBase');
    if (foot && toe) {
      const vFoot = toe.getAbsolutePosition().subtract(foot.getAbsolutePosition());
      if (vFoot.lengthSquared() > 1e-8) {
        sumFwd.addInPlace(new BABYLON.Vector3(vFoot.x, 0, vFoot.z).normalize());
        countFwd++;
      }
    }
  }
  if (countFwd > 0) {
    fwd = sumFwd.scale(1 / countFwd).normalize();
  } else {
    const cross = BABYLON.Vector3.Cross(up, lateralL).normalize();
    fwd = cross.z >= 0 ? cross : cross.scale(-1);
  }

  // Construct character orientation matrix and quaternion
  const mChar = BABYLON.Matrix.Identity();
  mChar.setRowFromFloats(0, lateralL.x, up.x, fwd.x, 0);
  mChar.setRowFromFloats(1, lateralL.y, up.y, fwd.y, 0);
  mChar.setRowFromFloats(2, lateralL.z, up.z, fwd.z, 0);
  const qChar = BABYLON.Quaternion.FromRotationMatrix(mChar);

  // Marker's world rotation
  const m = st.markers.get(name);
  if (!m) return;
  const mWorld = m.getWorldMatrix();
  const mScale = new BABYLON.Vector3();
  const mRot = new BABYLON.Quaternion();
  const mTrans = new BABYLON.Vector3();
  mWorld.decompose(mScale, mRot, mTrans);

  // Rotation relative to character orientation
  const qRel = qChar.clone().invert().multiply(mRot);
  const euler = qRel.toEulerAngles();

  // Compensate for local coordinate system mirroring (reflection)
  const det = st.markerParent.getWorldMatrix().determinant();
  const detSign = det >= 0 ? 1 : -1;
  euler.scaleInPlace(detSign);

  if (name.endsWith('Hand')) {
    const spread = euler.z * 180 / Math.PI * sgn;
    const splay = euler.y * 180 / Math.PI;
    charTransformConfig.ARM_SPREAD_ANGLE = Math.max(-45, Math.min(45, spread / 2));
    charTransformConfig.ARM_SPLAY_ANGLE = Math.max(-45, Math.min(45, splay / 2));
    syncCharTransformToUI();
    applyLiveTransformations();
  } else if (name.endsWith('Foot')) {
    const spread = euler.z * 180 / Math.PI * sgn;
    charTransformConfig.LEG_SPREAD_ANGLE = Math.max(-45, Math.min(45, spread));
    syncCharTransformToUI();
    applyLiveTransformations();
  } else if (name === 'Head' || name === 'Spine' || name === 'Spine1' || name === 'Spine2') {
    const tilt = euler.x * 180 / Math.PI;
    charTransformConfig.SPINE_STRAIGHTEN_ANGLE = -Math.max(-45, Math.min(45, tilt / 3));
    syncCharTransformToUI();
    applyLiveTransformations();
  } else if (name === 'Hips') {
    const tilt = euler.x * 180 / Math.PI;
    charTransformConfig.HIPS_TILT_ANGLE = -Math.max(-45, Math.min(45, tilt));
    syncCharTransformToUI();
    applyLiveTransformations();
  }
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

  // Restore the user's last applied joints verbatim (P2). The server re-guesses
  // from the post-merge bind, which drifts from what the user placed; if we have
  // an exact memory for this character, use it and skip the bone-snap re-fit so
  // markers land precisely where they were applied.
  if (lastAppliedRig?.joints) {
    guess.joints = JSON.parse(JSON.stringify(lastAppliedRig.joints));
    guess.restored = true;
    showToast('Restored your last joint positions.');
  }

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
  // Posture-offset observer stays ACTIVE during rig mode: the sliders (arm
  // spread/splay, shoulder raise, leg spread, spine straighten, hips tilt) keep
  // working and layer on top of the Force-Pose base (autoRigState.rigPoseBase).
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

  // Server joints are in glTF RENDER-WORLD space. markerParent's world matrix is
  // NOT always identity — Sketchfab/FBX exports carry an ancestor scale (e.g.
  // Sketchfab_model scale 0.3, ‑0.3 Z mirror) above the skeleton root. Setting a
  // world coord straight into m.position (local) would shrink/sink every marker
  // by that scale. Parent the marker, then place it by ABSOLUTE position so the
  // local m.position is derived correctly (world · markerParentⁱ); all the
  // canonical/follow math below uses m.position, so it stays consistent.
  markerParent.computeWorldMatrix(true);
  const mpWorld = markerParent.getWorldMatrix();
  const mpWorldInv = mpWorld.clone().invert();
  // Server joint coordinates are in glTF's character root local space.
  // Transform them to markerParent's local space.
  const toMarkerLocal = mpWorldInv.multiply(activeCharacter.charRoot.getWorldMatrix());
  // Marker size must be constant on-screen; markerParent may scale its children
  // (Sketchfab 0.3), so divide that scale out of the local sphere diameter.
  const mpScaleV = new BABYLON.Vector3();
  mpWorld.decompose(mpScaleV);
  const mpScale = Math.max(Math.abs(mpScaleV.x), 1e-4);
  const diameter = Math.max(0.03 * guess.height, 0.02) / mpScale;
  const symmetric = document.getElementById('autorig-symmetry')?.checked;
  if (symmetric && guess.joints) {
    Object.keys(guess.joints).forEach(name => {
      if (name.startsWith('Left')) {
        const leftPos = guess.joints[name];
        const rightName = 'Right' + name.slice(4);
        const rightPos = guess.joints[rightName];
        if (leftPos && rightPos) {
          const avgY = (leftPos[1] + rightPos[1]) / 2;
          const avgZ = (leftPos[2] + rightPos[2]) / 2;
          const avgAbsX = (Math.abs(leftPos[0]) + Math.abs(rightPos[0])) / 2;
          const signLeft = leftPos[0] >= 0 ? 1 : -1;
          leftPos[0] = signLeft * avgAbsX;
          leftPos[1] = avgY;
          leftPos[2] = avgZ;
          rightPos[0] = -signLeft * avgAbsX;
          rightPos[1] = avgY;
          rightPos[2] = avgZ;
        }
      }
    });
  }

  Object.entries(guess.joints).forEach(([name, pos]) => {
    const m = BABYLON.MeshBuilder.CreateSphere(`autorig_${name}`, { diameter, segments: 10 }, scene);
    m.material = matFor(name);
    m.isPickable = true;
    m.renderingGroupId = 1; // draw on top of the character mesh
    m.parent = markerParent;
    // glTF charRoot-local coord → markerParent-local
    const local = BABYLON.Vector3.TransformCoordinates(
      new BABYLON.Vector3(pos[0], pos[1], pos[2]), toMarkerLocal);
    m.position.copyFrom(local);
    m.metadata = { autorigJoint: name };
    markers.set(name, m);
  });

  // ── Marker ↔ bone follow (re-rig with live posture sliders) ───────────────
  // The posture-offset observer keeps deforming the skeleton while rig mode is
  // open, but markers live in the BASE rest space (what the server rigs). Bind
  // each marker to its nearest bone: the marker is displayed posed (follows
  // slider movement) while `canonical` keeps the rest-space coordinate that is
  // actually sent to the server. All matrices are taken relative to
  // markerParent so the rig-mode yaw spin (Q/E) cancels out.
  const boneBindings = new Map();  // joint name → transform node
  const restRel = new Map();       // node → bind matrix relative to markerParent
  const canonical = new Map();     // joint name → Vector3 (markerParent-local, rest space)
  let localToServerAffine = null;  // (Vector3 local) → [x,y,z] server space, or null
  if (scene.skeletons?.length) {
    const mpInv0 = markerParent.getWorldMatrix().clone().invert();
    const nodes = [];
    // canonical-name → bone node, so re-rig binds by NAME (robust to the server's
    // joint space differing from Babylon's scene space on flipped/mirrored rigs)
    const nodeByNorm = new Map();
    scene.skeletons.forEach(sk => sk.bones.forEach(b => {
      const n = b.getTransformNode();
      if (n && !restRel.has(n)) {
        n.computeWorldMatrix(true);
        restRel.set(n, n.getWorldMatrix().multiply(mpInv0));
        nodes.push(n);
        const norm = boneRoleNorm(b.name || n.name || '');
        if (norm && !nodeByNorm.has(norm)) nodeByNorm.set(norm, n);
      }
    }));
    markers.forEach((m, name) => {
      // 1) exact joint-name match (LeftArm → mixamorig:LeftArm_09)
      let bound = nodeByNorm.get(boneRoleNorm(name));
      // 2) fallback to nearest bone for unmatched / nonstandard names
      if (!bound) {
        m.computeWorldMatrix(true);
        const mw = m.getAbsolutePosition();
        let bestD = Infinity;
        nodes.forEach(n => {
          const d = BABYLON.Vector3.DistanceSquared(mw, n.getAbsolutePosition());
          if (d < bestD) { bestD = d; bound = n; }
        });
      }
      if (bound) boneBindings.set(name, bound);
    });

    // Re-rig GROUND TRUTH: the server's joint world coords can land in a
    // different space than Babylon's scene (FBX up-axis fixes, Sketchfab −Z
    // mirror, armature scale) — that's what put the markers upside-down/sunk.
    // For markers matched to a bone BY NAME, snap onto that bone's ACTUAL
    // in-scene position (→ markerParent-local). Nearest-bone fallbacks and
    // unmatched markers keep the server guess.
    const mpInvSnap = markerParent.getWorldMatrix().clone().invert();
    const fitPairs = []; // { local: Vector3 (markerParent-local), server: [x,y,z] }
    markers.forEach((m, name) => {
      const node = nodeByNorm.get(boneRoleNorm(name));
      if (!node) return;
      node.computeWorldMatrix(true);
      // Restored session (P2): the markers already hold the user's exact applied
      // coords — do NOT snap them to the (drifted) merged bones. Still record the
      // local↔server pair from the marker's current spot so the Apply affine
      // round-trips correctly.
      if (!guess.restored) {
        const local = BABYLON.Vector3.TransformCoordinates(node.getAbsolutePosition(), mpInvSnap);
        m.position.copyFrom(local);
      }
      const sv = guess.joints[name];
      if (sv) fitPairs.push({ local: m.position.clone(), server: sv });
    });
    // Markers are now displayed in Babylon scene space (snapped to bones), but
    // the server rigs in its own RENDER-WORLD space (guessJoints / autorig). On
    // mirrored/flipped/scaled rigs the two differ. Fit the affine that maps
    // markerParent-local → server space from the name-matched pairs so Apply
    // sends correct coordinates regardless of the model's baked transform.
    localToServerAffine = fitAffine3D(fitPairs);
  }
  markers.forEach((m, name) => canonical.set(name, m.position.clone()));

  const curRelOf = (node) => {
    node.computeWorldMatrix(true);
    return node.getWorldMatrix().multiply(markerParent.getWorldMatrix().clone().invert());
  };
  // Marker was moved by the user: re-derive its rest-space coordinate
  const updateCanonicalFromMarker = (m) => {
    const name = m.metadata?.autorigJoint;
    if (!name) return;
    const node = boneBindings.get(name);
    if (!node) { canonical.set(name, m.position.clone()); return; }
    const toRest = curRelOf(node).invert().multiply(restRel.get(node));
    canonical.set(name, BABYLON.Vector3.TransformCoordinates(m.position, toRest));
  };

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
  gizmoManager.rotationGizmoEnabled = true;
  gizmoManager.usePointerToAttachGizmos = true;
  gizmoManager.attachableMeshes = [...markers.values()];

  if (gizmoManager.gizmos.positionGizmo) {
    gizmoManager.gizmos.positionGizmo.updateGizmoRotationToMatchAttachedMesh = true;
  }
  if (gizmoManager.gizmos.rotationGizmo) {
    gizmoManager.gizmos.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = true;
  }

  // Markers are placed with the move gizmo only — translate, no rotate.
  gizmoManager.positionGizmoEnabled = true;
  gizmoManager.rotationGizmoEnabled = false;

  // Re-render legend when selection changes
  gizmoManager.onAttachedToMeshObservable.add(() => {
    renderAutoRigLegend(markers, gizmoManager);
  });

  // Tap-to-place selected marker on the model mesh with Ctrl+Click or Right-Click
  const clickObserver = scene.onPointerObservable.add((pi) => {
    if (pi.type !== BABYLON.PointerEventTypes.POINTERTAP) return;

    const isRightClick = pi.event.button === 2;
    const isCtrlClick = pi.event.ctrlKey || pi.event.metaKey;
    if (!isCtrlClick && !isRightClick) {
      // Deselect when clicking outside the markers
      if (pi.event.button === 0) {
        const pickInfo = pi.pickInfo;
        const isMarker = pickInfo && pickInfo.hit && pickInfo.pickedMesh && pickInfo.pickedMesh.metadata?.autorigJoint;
        const utilityScene = gizmoManager.utilityLayer?.utilityLayerScene;
        const hitGizmo = utilityScene && utilityScene.pick(scene.pointerX, scene.pointerY)?.hit;

        if (!isMarker && !hitGizmo) {
          gizmoManager.attachToMesh(null);
        }
      }
      return;
    }

    const activeMarker = gizmoManager.attachedMesh;
    if (!activeMarker || !activeMarker.metadata?.autorigJoint) return;

    const pickInfo = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return activeCharacter && activeCharacter.rawMeshes && activeCharacter.rawMeshes.includes(mesh);
    });

    if (pickInfo && pickInfo.hit && pickInfo.pickedPoint) {
      if (isRightClick) {
        pi.event.preventDefault();
      }

      const localPos = BABYLON.Vector3.TransformCoordinates(pickInfo.pickedPoint, mpWorldInv);
      activeMarker.position.copyFrom(localPos);

      const snap = document.getElementById('autorig-depth-snap');
      if ((!snap || snap.checked) && !document.getElementById('autorig-pose-profiling')?.checked) {
        snapMarkerToMeshDepth(activeMarker);
      }

      updateCanonicalFromMarker(activeMarker);

      if (document.getElementById('autorig-symmetry')?.checked) {
        const twinName = mirrorJointName(activeMarker.metadata.autorigJoint);
        const twin = twinName ? markers.get(twinName) : null;
        if (twin) {
          twin.position.set(-activeMarker.position.x, activeMarker.position.y, activeMarker.position.z);
          if ((!snap || snap.checked) && !document.getElementById('autorig-pose-profiling')?.checked) {
            snapMarkerToMeshDepth(twin);
          }
          updateCanonicalFromMarker(twin);
        }
      }
    }
  });

  // Call legend render immediately now that gizmoManager is set up
  renderAutoRigLegend(markers, gizmoManager);

  let isDraggingMarker = false;

  // Mirror drag onto the contralateral marker when symmetry is on
  const posGizmo = gizmoManager.gizmos.positionGizmo;
  if (posGizmo) {
    [posGizmo.xGizmo, posGizmo.yGizmo, posGizmo.zGizmo].forEach(g => {
      if (g && g.dragBehavior) {
        g.dragBehavior.onDragStartObservable.add(() => { isDraggingMarker = true; });
        g.dragBehavior.onDragEndObservable.add(() => {
          isDraggingMarker = false;
          // Auto-solve depth after a screen-plane drag so the user never has to
          // fight the third axis (toggle: #autorig-depth-snap, default on).
          const snap = document.getElementById('autorig-depth-snap');
          const attached = gizmoManager.attachedMesh;
          if ((!snap || snap.checked) && attached?.metadata?.autorigJoint &&
            !document.getElementById('autorig-pose-profiling')?.checked) {
            snapMarkerToMeshDepth(attached);
            updateCanonicalFromMarker(attached);
            if (document.getElementById('autorig-symmetry')?.checked) {
              const twin = markers.get(mirrorJointName(attached.metadata.autorigJoint) || '');
              if (twin) {
                twin.position.set(-attached.position.x, attached.position.y, attached.position.z);
                updateCanonicalFromMarker(twin);
              }
            }
          }
        });
      }
    });
    const syncMirror = () => {
      const symmetric = document.getElementById('autorig-symmetry')?.checked;
      if (!symmetric) return;
      const attached = gizmoManager.attachedMesh;
      if (!attached?.metadata?.autorigJoint) return;
      const twinName = mirrorJointName(attached.metadata.autorigJoint);
      if (!twinName) return;
      const twin = markers.get(twinName);
      if (twin) {
        twin.position.set(-attached.position.x, attached.position.y, attached.position.z);
        updateCanonicalFromMarker(twin);
      }
    };
    [posGizmo.xGizmo, posGizmo.yGizmo, posGizmo.zGizmo].forEach(g => {
      g?.dragBehavior?.onDragObservable.add(syncMirror);
    });
  }

  const rotGizmo = gizmoManager.gizmos.rotationGizmo;
  if (rotGizmo) {
    [rotGizmo.xGizmo, rotGizmo.yGizmo, rotGizmo.zGizmo].forEach(g => {
      if (g && g.dragBehavior) {
        g.dragBehavior.onDragStartObservable.add(() => { isDraggingMarker = true; });
        g.dragBehavior.onDragEndObservable.add(() => { isDraggingMarker = false; });
      }
    });
    const syncMirrorRot = () => {
      const symmetric = document.getElementById('autorig-symmetry')?.checked;
      if (!symmetric) return;
      const attached = gizmoManager.attachedMesh;
      if (!attached?.metadata?.autorigJoint) return;
      const twinName = mirrorJointName(attached.metadata.autorigJoint);
      if (!twinName) return;
      const twin = markers.get(twinName);
      if (twin) {
        if (!attached.rotationQuaternion) {
          attached.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(attached.rotation.y, attached.rotation.x, attached.rotation.z);
        }
        const q = attached.rotationQuaternion;
        if (!twin.rotationQuaternion) twin.rotationQuaternion = BABYLON.Quaternion.Identity();
        twin.rotationQuaternion.set(q.x, -q.y, -q.z, q.w);
        updateCanonicalFromMarker(twin);
      }
    };
    [rotGizmo.xGizmo, rotGizmo.yGizmo, rotGizmo.zGizmo].forEach(g => {
      g?.dragBehavior?.onDragObservable.add(syncMirrorRot);
    });
  }

  // Re-pose markers every frame from their bound bone (runs after the posture
  // offset observer, which was registered at character load). The attached
  // marker is the one the user may be dragging — treat ITS position as the
  // source of truth instead and back-derive its canonical coordinate.
  const followObserver = scene.onAfterAnimationsObservable.add(() => {
    const profiling = document.getElementById('autorig-pose-profiling')?.checked;

    // Helpers to extract pure rotation from world matrix (ignoring parent scale/mirroring)
    const getPureRelativeRot = (boneNode) => {
      const mpScale = new BABYLON.Vector3();
      const mpRot = new BABYLON.Quaternion();
      const mpTrans = new BABYLON.Vector3();
      markerParent.getWorldMatrix().decompose(mpScale, mpRot, mpTrans);

      const boneScale = new BABYLON.Vector3();
      const boneRot = new BABYLON.Quaternion();
      const boneTrans = new BABYLON.Vector3();
      boneNode.getWorldMatrix().decompose(boneScale, boneRot, boneTrans);

      return mpRot.clone().invert().multiply(boneRot);
    };

    markers.forEach((m, name) => {
      const node = boneBindings.get(name);
      if (!node) return;

      if (m === gizmoManager.attachedMesh) {
        if (isDraggingMarker) {
          if (profiling) {
            if (gizmoManager.positionGizmoEnabled) {
              mapMarkerToPosture(name, m.position);
            } else if (gizmoManager.rotationGizmoEnabled) {
              if (!m.rotationQuaternion) {
                m.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(m.rotation.y, m.rotation.x, m.rotation.z);
              }
              mapMarkerRotationToPosture(name, m.rotationQuaternion);
            }
            updateCanonicalFromMarker(m);
          } else {
            updateCanonicalFromMarker(m);
          }
          return;
        } else {
          // Attached but not actively dragging
          if (profiling) {
            const toPosed = restRel.get(node).clone().invert().multiply(curRelOf(node));
            const posed = BABYLON.Vector3.TransformCoordinates(canonical.get(name), toPosed);
            m.position.copyFrom(posed);

            const q = getPureRelativeRot(node);
            if (!m.rotationQuaternion) m.rotationQuaternion = BABYLON.Quaternion.Identity();
            m.rotationQuaternion.copyFrom(q);
          } else {
            updateCanonicalFromMarker(m);
            if (m.rotationQuaternion) m.rotationQuaternion.copyFrom(BABYLON.Quaternion.Identity());
          }
          return;
        }
      }

      const toPosed = restRel.get(node).clone().invert().multiply(curRelOf(node));
      const posed = BABYLON.Vector3.TransformCoordinates(canonical.get(name), toPosed);
      m.position.copyFrom(posed);

      if (profiling) {
        const q = getPureRelativeRot(node);
        if (!m.rotationQuaternion) m.rotationQuaternion = BABYLON.Quaternion.Identity();
        m.rotationQuaternion.copyFrom(q);
      } else {
        if (m.rotationQuaternion) m.rotationQuaternion.copyFrom(BABYLON.Quaternion.Identity());
      }
    });

    if (profiling && scene.skeletons) {
      scene.skeletons.forEach(sk => sk.prepare());
    }
  });

  autoRigState = {
    markers, gizmoManager, height: guess.height, sceneHeight,
    groupMats, hoverObserver, clickObserver, hideTip, canonical, followObserver,
    boneBindings, restRel, markerParent, localToServerAffine,
    // Server's original joint guess (its own render-world space) per name — the
    // exact ground truth for un-dragged markers on Apply.
    serverGuess: { ...guess.joints },
    // Rest-space snapshot of the initial guess — restored by the "Rest" pose button
    restLayout: new Map([...canonical].map(([n, v]) => [n, v.clone()])),
    pausedCtrlCallback: ctrlObserver?.callback || null,
    pausedCamLockCallback: camLockObserver?.callback || null,
    rigPoseBase: new Map(), // node.uniqueId → posed local quaternion (Force-Pose)
  };
  enterRigViewportMode();
  // First-time skinless guess: auto-solve marker depth against the mesh so the
  // initial layout already sits inside the body (P1). Restored sessions and
  // existing-skin re-rigs already hold exact positions — leave them.
  if (!guess.restored && !scene.skeletons?.length) {
    requestAnimationFrame(() => snapAllMarkersToBody());
  }
  // Default selection reflects the analyzed layout
  setActivePoseButton('rest');

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
    if (autoRigState.clickObserver) scene.onPointerObservable.remove(autoRigState.clickObserver);
    if (autoRigState.followObserver) scene.onAfterAnimationsObservable.remove(autoRigState.followObserver);
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
    // Clear the Force-Pose base so the (still-running) posture observer returns
    // to the bind pose, then drop to rest before idle restarts.
    autoRigState.rigPoseBase?.clear();
    if (scene.skeletons?.length) scene.skeletons.forEach(sk => sk.returnToRest());
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

// ── Depth snap: solve the view-perpendicular axis from the mesh ──────────────
// The single hardest part of 3D marker placement is the depth axis: in a front
// view the user sets X/Y by eye but Z is invisible, so markers float in front
// of or behind the body. This raycasts along the camera's forward direction
// through each marker and re-centers it to the MIDDLE of the mesh it passes
// through — so the user only ever places markers in the 2D screen plane and the
// body depth is solved automatically. Limb markers (hands/feet/toes) are left
// alone: they sit at the mesh tip, not its mid-thickness.
const DEPTH_SNAP_SKIP = new Set(['LeftHand', 'RightHand', 'LeftToeBase', 'RightToeBase']);
// Fixed front↔back (sagittal) world axis of the character, derived from its
// facing yaw — independent of the camera. This is the horizontal direction the
// FRONT view looks along, so snapping depth along it always means the same thing.
function bodyDepthAxis() {
  let rotY = 0;
  const cap = activeCharacter?.playerCapsule;
  if (cap?.rotationQuaternion) rotY = cap.rotationQuaternion.toEulerAngles().y;
  else if (cap) rotY = cap.rotation.y;
  const frontAlpha = -rotY + Math.PI / 2; // matches setRigView('front')
  // Front camera look direction (cam→target), horizontal component only.
  return new BABYLON.Vector3(-Math.cos(frontAlpha), 0, -Math.sin(frontAlpha));
}

function snapMarkerToMeshDepth(marker) {
  if (!activeCharacter?.rawMeshes?.length || !marker) return false;
  const name = marker.metadata?.autorigJoint;
  if (name && DEPTH_SNAP_SKIP.has(name)) return false;

  marker.computeWorldMatrix(true);
  const origin = marker.getAbsolutePosition();
  // Depth axis = the character's fixed sagittal (front↔back) axis, NOT the live
  // camera direction. Using the camera made the snap depend on the current view,
  // so repeated snaps from different angles dragged markers along ever-changing
  // axes and the layout drifted. A fixed body axis makes the snap idempotent:
  // it always centers depth the same way regardless of where the camera sits.
  const fwd = bodyDepthAxis();
  if (!fwd || fwd.lengthSquared() < 1e-8) return false;
  fwd.normalize();

  // The character meshes are set isPickable=false at load (so the gizmo never
  // grabs them), which makes scene.pick / multiPickWithRay skip them entirely —
  // that is why the snap reported "no mesh hit". Ray.intersectsMesh is a direct
  // geometric test and ignores the isPickable flag, so use it on each mesh.
  // We only require that the mesh has geometry (subMeshes might not be initialized yet).
  const meshes = activeCharacter.rawMeshes.filter(m => m.geometry);
  const reach = (autoRigState?.sceneHeight || 1.8) * 1.2;

  // Cast from well in front (gets the entry surface) and from well behind (gets
  // the exit surface). Per mesh, intersectsMesh returns the nearest hit along
  // the ray; combining both directions brackets the body so mid = its center.
  let near = Infinity, far = -Infinity, hitAny = false;
  for (const dir of [fwd, fwd.scale(-1)]) {
    const start = origin.subtract(dir.scale(reach));
    const ray = new BABYLON.Ray(start, dir, reach * 2);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const info = ray.intersectsMesh(m, false);
      if (!info?.hit) continue;
      // Hit point = start + dir·distance; project onto fwd from the origin.
      const hit = start.add(dir.scale(info.distance));
      const along = hit.subtract(origin).dot(fwd);
      if (along < near) near = along;
      if (along > far) far = along;
      hitAny = true;
    }
  }
  if (!hitAny || !Number.isFinite(near) || far < near) {
    if (window.AUTORIG_DEBUG_SNAP) console.log(`[snap] ${name}: NO HIT (meshes=${meshes.length}, fwd=${fwd.x.toFixed(2)},${fwd.y.toFixed(2)},${fwd.z.toFixed(2)}, reach=${reach.toFixed(2)})`);
    return false;
  }
  const mid = (near + far) / 2;
  if (window.AUTORIG_DEBUG_SNAP) console.log(`[snap] ${name}: hit near=${near.toFixed(3)} far=${far.toFixed(3)} mid=${mid.toFixed(3)}`);
  marker.position.addInPlace(
    BABYLON.Vector3.TransformNormal(fwd.scale(mid), markerParentInvRot(marker)));
  return true;
}
// Marker depth is moved in WORLD fwd but stored LOCAL — rotate the world delta
// into the marker's parent space.
function markerParentInvRot(marker) {
  const parent = marker.parent;
  if (!parent) return BABYLON.Matrix.Identity();
  const inv = parent.getWorldMatrix().clone().invert();
  // strip translation: we only rotate a direction
  inv.setRow(3, new BABYLON.Vector4(0, 0, 0, 1));
  return inv;
}

// Snap every (eligible) marker to the body mid-depth in one click.
function snapAllMarkersToBody() {
  if (!autoRigState) return;
  let n = 0;
  autoRigState.markers.forEach((m) => { if (snapMarkerToMeshDepth(m)) n++; });
  autoRigState.markers.forEach((m, name) => {
    autoRigState.canonical?.set(name, m.position.clone());
  });
  showToast(n > 0 ? `Snapped ${n} markers to body depth.` : 'No depth snap (no mesh hit).');
}

async function applyAutoRig() {
  if (!autoRigState || !characterGlbBuffer) return;

  // Collect adjusted joint positions (local to charRoot = glTF space).
  // Use the canonical (rest-space) coordinates: displayed markers may be
  // posed by the posture sliders, but the server rigs the BASE unposed GLB.
  // Markers are placed/displayed in Babylon scene space (canonical = markerParent
  // -local), but the server rigs in its own render-world space. On mirrored/
  // flipped/scaled rigs these differ. Strategy that stays EXACT for the common
  // case (markers left where the analysis put them):
  //   • un-dragged marker  → send the server's own original guess verbatim
  //   • dragged marker     → server guess + linear-mapped drag delta
  //   • no server guess    → full affine of the current local position
  // For clean rigs (no skeleton / identity space) this reduces to raw coords.
  const st = autoRigState;
  const toServer = st.localToServerAffine;
  const rest = st.restLayout;
  const guessSrv = st.serverGuess || {};
  // The rig server only repositions joints under the STATIC mesh (it doesn't
  // re-deform the geometry), so baking the Force-Pose / slider posture into the
  // joint positions would shear the skin. Force-Pose & sliders are therefore a
  // VISUAL preview only — Apply always rigs at the mesh's actual rest shape:
  //   • un-dragged marker → server's own ground-truth rest position
  //   • dragged marker    → rest position + the user's drag delta
  // `canonical` is kept in rest space (followObserver never writes it back from
  // the posed bones), so it already holds the rest anatomy + any manual drags.
  const joints = {};
  st.markers.forEach((m, name) => {
    const p = st.canonical?.get(name) || m.position;
    const r = rest?.get(name);
    const g = guessSrv[name];
    const delta = r ? p.subtract(r) : null;
    const moved = delta ? delta.lengthSquared() > 1e-8 : true;
    if (g && !moved) {
      joints[name] = [g[0], g[1], g[2]];                 // exact rest ground truth
    } else if (g && toServer && delta) {
      const d = toServer.applyDelta(delta);
      joints[name] = [g[0] + d[0], g[1] + d[1], g[2] + d[2]];
    } else if (toServer) {
      joints[name] = toServer.apply(p);
    } else {
      joints[name] = [p.x, p.y, p.z];
    }
  });

  const baseBuffer = originalCharacterGlbBuffer || characterGlbBuffer;
  // Remember exactly what the user applied so re-entering Auto-Rig restores
  // these positions verbatim (the post-Apply animation merge nudges the bind
  // pose, so re-guessing from the merged bones would move the markers). Tied to
  // the base buffer it was rigged from.
  lastAppliedRig = { joints: JSON.parse(JSON.stringify(joints)), forBuffer: baseBuffer };
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

    // New skeleton = new bind pose: stale posture offsets (arm spread/splay,
    // shoulder raise, leg spread, spine, hips tilt) no longer apply. Reset
    // them BEFORE reloading so the merge doesn't bake them into the new rig.
    charTransformConfig.ARM_SPREAD_ANGLE = 0;
    charTransformConfig.ARM_SPLAY_ANGLE = 0;
    charTransformConfig.SHOULDER_RAISE_ANGLE = 0;
    charTransformConfig.LEG_SPREAD_ANGLE = 0;
    charTransformConfig.SPINE_STRAIGHTEN_ANGLE = 0;
    charTransformConfig.HIPS_TILT_ANGLE = 0;
    syncCharTransformToUI();

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
    if (activeCharacter.charCtrl) {
      activeCharacter.charCtrl.destroy();
    }
    if (activeCharacter.boneOffsetObserver) {
      scene.onAfterAnimationsObservable.remove(activeCharacter.boneOffsetObserver);
    }
    if (activeCharacter.cameraFollowObserver) {
      scene.unregisterBeforeRender(activeCharacter.cameraFollowObserver);
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
    async () => {
      detectedAnimations = [];

      // Clear all mappings
      Object.keys(animMappings).forEach(key => {
        animMappings[key] = { animName: 'None', from: 0, to: 100 };
      });
      customAnimations = [];
      animationEvents = {};

      // Remove from BJS animCtrl
      if (activeCharacter) {
        activeCharacter.animCtrl.destroy();

        // Dispose EVERY animation group in the scene, not just the originals in
        // rawAnimationGroups. AnimCtrl.setAnimation() clones a source group when
        // the same clip drives two actions (e.g. Walk → Walk_Loop + Sprint_Loop);
        // those `__isSharedClone` groups live in scene.animationGroups but never
        // in rawAnimationGroups, so disposing only the raw list leaves the clones
        // attached to the character bones. Nuke them all (mirrors the character
        // load path at line ~1851).
        if (scene && scene.animationGroups) {
          [...scene.animationGroups].forEach(ag => { ag.stop(); ag.dispose(); });
        }
        activeCharacter.rawAnimationGroups = [];
        // Recreate a clean animCtrl with no animation groups
        activeCharacter.animCtrl = new AnimCtrl([], scene);
        activeCharacter.animCtrl.charCtrl = activeCharacter.charCtrl;
        activeCharacter.charCtrl.anim = activeCharacter.animCtrl;

        // Reset skeleton to rest pose (same as auto rig / adjust mode)
        if (scene.skeletons) {
          scene.skeletons.forEach(skel => skel.returnToRest());
        }
      }

      // Clear stored animations GLB buffer as well
      animationsGlbBuffer = null;

      // Clear All only empties the LIBRARY + the live scene/preview. It must NOT
      // strip the stored character buffers: the merge pipeline mutates bind pose/
      // skeleton, so stripping here corrupts the retarget reference and the NEXT
      // animation import comes out with wrong/missing postures. The buffers keep
      // their baked clips harmlessly — a real anim import (always merges with
      // removeExistingAnimations) replaces them cleanly, and export from runtime/
      // merged modes handles stripping at download time.
      animationsCleared = false;

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
      if (activeCharacter && activeCharacter.charCtrl) {
        activeCharacter.charCtrl[configKey] = val;
        if (configKey === 'CAM_FOLLOW_DIST') {
          const sy = charTransformConfig.SCALE_Y || 1.0;
          activeCharacter.charCtrl._baseCamFollowDist = val / sy;
        }
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
  bindSlider('slider-speed-mult', 'SPEED_MULTIPLIER', true, 'x');
  bindSlider('slider-cam-dist', 'CAM_FOLLOW_DIST', true, 'm');
  bindSlider('slider-fov-max', 'DYNAMIC_FOV_MAX');
  bindSlider('slider-cam-tilt', 'CAM_TILT_AMOUNT');

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
  bindCheckbox('toggle-cam-tilt', 'CAM_TILT');
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
      singleInput.click();
    });
    singleInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        if (!isServerAvailable && !/\.glb$/i.test(file.name)) {
          showToast('Offline mode only supports .glb files. Start the server to convert .fbx.', true);
        } else {
          addSingleAnimationFile(file);
        }
      }
      singleInput.value = '';
    });
  }

  // Clear character button
  const btnClearChar = document.getElementById('btn-clear-character');
  if (btnClearChar) btnClearChar.addEventListener('click', clearCharacter);

  // Clear all animations button
  const btnClearAllAnims = document.getElementById('btn-clear-all-anims');
  if (btnClearAllAnims) btnClearAllAnims.addEventListener('click', () => {
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

  // Export Integration Mode Toggle
  const exportMergedRadio = document.getElementById('export-mode-merged');
  const exportRuntimeRadio = document.getElementById('export-mode-runtime');
  if (exportMergedRadio && exportRuntimeRadio) {
    const runtimeBadge = document.getElementById('runtime-export-badge');
    const syncRuntimeBadge = (isRuntime) => {
      if (runtimeBadge) runtimeBadge.style.display = isRuntime ? 'block' : 'none';
    };
    const inputs = document.querySelectorAll('input[name="export-mode"]');
    inputs.forEach(input => {
      input.addEventListener('change', (e) => {
        const isRuntime = e.target.value === 'runtime';
        exportMergedRadio.classList.toggle('active', e.target.value === 'merged');
        exportRuntimeRadio.classList.toggle('active', isRuntime);
        syncRuntimeBadge(isRuntime);
        updateExportCode();
      });
    });
    // Reflect the initial/restored selection
    syncRuntimeBadge(document.querySelector('input[name="export-mode"]:checked')?.value === 'runtime');
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
  applySlider('slider-cam-tilt', 'CAM_TILT_AMOUNT');

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
  applyCheckbox('toggle-cam-tilt', 'CAM_TILT');
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
    if (!isServerAvailable && !/\.glb$/i.test(file.name)) {
      showToast('Offline mode only supports .glb files. Start the server to convert .fbx.', true);
      return;
    }
    await loadCharacterMeshFile(file);
  });

  // Animations dropzone
  setupDropzone('dropzone-animations', 'anim-file-input', async (file) => {
    if (!isServerAvailable && !/\.glb$/i.test(file.name)) {
      showToast('Offline mode only supports .glb files. Start the server to convert .fbx.', true);
      return;
    }
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

  const modeEl = document.querySelector('input[name="export-mode"]:checked');
  const exportMode = modeEl ? modeEl.value : 'merged';

  let animFileOption = '';
  if (exportMode === 'runtime') {
    const animName = animationsFilename || 'animations-basic.glb';
    animFileOption = `\n    animationsFilename: '${animName}',`;
    // Runtime mode re-merges character + animations on the server at load time.
    // Pass the posture/transform sliders so that re-merge bakes the SAME pose
    // the Builder previewed; otherwise the runtime merge ignores every slider.
    const mo = getMergeOptions({ removeExistingAnimations: true, COMPRESS_OUTPUT: false });
    delete mo.COMPRESS_OUTPUT; // controller forces this; keep config clean
    mo.PIVOT_X = 0; mo.PIVOT_Y = 0; mo.PIVOT_Z = 0; // pivot is never baked (deforms the mesh)
    animFileOption += `\n    mergeOptions: ${JSON.stringify(mo, null, 4).replace(/\n/g, '\n    ')},`;
  }

  const configCode = `// 🎮 CUSTOM SETUP CONFIGURATION FOR YOUR APP.JS\n// Copy and paste this loadCharacter function replacement in your app.js:\n\nasync function loadCharacter(scene, shadow, camera, usePhysics) {\n  return setupCharacter(scene, camera, usePhysics, {\n    shadow,\n    assetsPath: 'assets/',\n    filename: '${exportMode === 'runtime' ? (characterFilename || 'character.glb') : 'character_animated_1.glb'}',${animFileOption}\n    capsuleScale: { x: ${charTransformConfig.SCALE_X}, y: ${charTransformConfig.SCALE_Y}, z: ${charTransformConfig.SCALE_Z} },\n    keys: ${JSON.stringify(keyBindings, null, 4).replace(/\n/g, '\n    ')},\n    config: ${JSON.stringify(physicsConfig, null, 4).replace(/\n/g, '\n    ')},\n    configure: ({ animCtrl, charCtrl, filteredGroups }) => {\n${mappingsSnippet}${customsSnippet}${formatAnimationEventsForExport()}    }\n  });\n}`;

  codeBox.value = configCode;
  savePreferences();
}

// Trigger a browser download from an ArrayBuffer/Blob.
function _downloadBuffer(buffer, filename, mime = 'model/gltf-binary') {
  const blob = new Blob([buffer], { type: mime });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

async function downloadCharacterGlbFile() {
  if (!originalCharacterGlbBuffer && !characterGlbBuffer) {
    showToast('No character loaded to download!', true);
    return;
  }

  const modeEl = document.querySelector('input[name="export-mode"]:checked');
  const exportMode = modeEl ? modeEl.value : 'merged';
  const hasAnimBuffer = animationsGlbBuffer && animationsGlbBuffer.byteLength > 0;

  // ── RUNTIME RETARGETING MODE ──────────────────────────────────────────────
  // The controller re-merges character + animations on load, so the character
  // GLB must ship WITHOUT baked animation groups (only posture baked), and the
  // raw animations-basic.glb goes alongside it as a separate file. Two downloads.
  if (exportMode === 'runtime') {
    if (!isServerAvailable) {
      showToast('Server offline — runtime export needs the merge server.', true);
      return;
    }
    showLoading('Generating animation-free character GLB…');
    try {
      // Character: bake posture from the scale-baked baseline (preserves applied
      // scale/pivot) or the clean original, strip animations but KEEP the T-pose
      // clip — the controller's load-time merge needs it as the retarget alignment
      // reference for the separate animations-basic.glb.
      const baseBuffer = scaledCharacterBuffer || originalCharacterGlbBuffer || characterGlbBuffer;
      const formData = new FormData();
      formData.append('character', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');
      // Pivot is NEVER baked (it deforms the character) — zero it in the export too.
      const runtimeOpts = getMergeOptions({ removeExistingAnimations: true, keepTPose: true });
      runtimeOpts.PIVOT_X = 0; runtimeOpts.PIVOT_Y = 0; runtimeOpts.PIVOT_Z = 0;
      formData.append('options', JSON.stringify(runtimeOpts));
      const res = await fetch('/api/merge', { method: 'POST', body: formData });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Server error during GLB generation');
      }
      const charBuffer = await res.arrayBuffer();
      const charName = characterFilename || 'character.glb';
      _downloadBuffer(charBuffer, charName);

      // Animations: ship the raw (pre-merge) animations-basic.glb separately.
      if (hasAnimBuffer) {
        const animName = animationsFilename || 'animations-basic.glb';
        // Small gap so the browser registers two distinct downloads.
        setTimeout(() => _downloadBuffer(animationsGlbBuffer, animName), 600);
        hideLoading();
        showToast(`Downloaded ${charName} (no animations) + ${animName} separately.`);
      } else {
        hideLoading();
        showToast(`Downloaded ${charName} (no animations). No animations-basic.glb to export.`, true);
      }
    } catch (err) {
      console.error(err);
      hideLoading();
      showToast('Failed to export runtime files: ' + err.message, true);
    }
    return;
  }

  // ── MERGED (BAKED) MODE ───────────────────────────────────────────────────
  showLoading('Generating clean character GLB with active animations...');
  try {
    let resultBuffer = characterGlbBuffer;

    if (isServerAvailable && (originalCharacterGlbBuffer || characterGlbBuffer)) {
      // With an animations buffer: re-merge from the clean original (strip + retarget).
      // After "Clear All" (animationsCleared): export from the clean original and
      // strip any baked anims → animation-free GLB.
      // Otherwise: export the CURRENT character buffer (already holds merged
      // animations) and keep them — stripping here would produce a GLB with zero animations.
      // Prefer the scale-baked baseline (preserves applied scale/pivot) over the
      // pristine original when re-merging from a clean base.
      const stripAnims = hasAnimBuffer || animationsCleared;
      const cleanBase = scaledCharacterBuffer || originalCharacterGlbBuffer || characterGlbBuffer;
      const baseBuffer = (hasAnimBuffer || animationsCleared)
        ? cleanBase
        : (characterGlbBuffer || cleanBase);

      const formData = new FormData();
      formData.append('character', new Blob([baseBuffer], { type: 'model/gltf-binary' }), 'character.glb');

      if (hasAnimBuffer) {
        formData.append('animations', new Blob([animationsGlbBuffer], { type: 'model/gltf-binary' }), 'animations-basic.glb');
      }

      // Pivot is NEVER baked (deforms the character) — zero it in the export.
      const mergedOpts = getMergeOptions({ removeExistingAnimations: stripAnims });
      mergedOpts.PIVOT_X = 0; mergedOpts.PIVOT_Y = 0; mergedOpts.PIVOT_Z = 0;
      formData.append('options', JSON.stringify(mergedOpts));

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

    _downloadBuffer(resultBuffer, 'character_animated_1.glb');
    hideLoading();
    showToast('Downloaded character_animated_1.glb!');
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
    const response = await fetch('js/character-controller.js?t=' + Date.now());
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
      const seedBlock = `\n(function() {\n  var _sig = ${JSON.stringify(_sig)};\n  if (localStorage.getItem('bcc_cfg_sig') !== _sig) {\n    var P = DEFAULT_CHAR_CONFIG.PHYSICS;\n    localStorage.setItem('air-control-enabled', String(P.AIR_CONTROL));\n    localStorage.setItem('cam-follow-lock', String(P.CAM_FOLLOW_LOCK));\n    localStorage.setItem('dynamic-fov', String(P.DYNAMIC_FOV));\n    localStorage.setItem('cam-tilt', String(P.CAM_TILT));\n    localStorage.setItem('cam-tilt-amount', String(P.CAM_TILT_AMOUNT));\n    localStorage.setItem('play-particles', String(P.PLAY_PARTICLES));\n    localStorage.setItem('bcc_cfg_sig', _sig);\n  }\n})();`;
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
