'use strict';

// ═══════════════════════════════════════════════════════════
// HOW TO REASSIGN ANIMATIONS AT RUNTIME:
// ═══════════════════════════════════════════════════════════
// You can dynamically change any animation on the character controller
// using the AnnimCtrel instance (usually accessed via `animCtrl.anim`):
//
// 1. Reassigning walk/run/idle/etc. animations:
//    animCtrl.setWalkAnim(newWalkAnimGroup);
//    animCtrl.setRunAnim(newRunAnimGroup);
//    animCtrl.setIdleAnim(newIdleAnimGroup);
//
// 2. Reassigning actions or combat animations:
//    animCtrl.setJumpStartAnim(newJumpStart);
//    animCtrl.setRollAnim(newRoll);
//    animCtrl.setPunchJabAnim(newPunchJab);
//
// 3. Setting play ranges (keyframes) on any animation:
//    animCtrl.setAnimationRanges('Walk_Loop', startFrame, endFrame);
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// CONFIGURABLE CHARACTER VARIABLES & SETTINGS
// ═══════════════════════════════════════════════════════════
const DEFAULT_CHAR_CONFIG = {
  // Key Bindings
  KEYS: {
    MOVE_FORWARD: ['KeyW', 'ArrowUp'],      // Move forward
    MOVE_BACKWARD: ['KeyS', 'ArrowDown'],   // Move backward
    MOVE_LEFT: ['KeyA', 'ArrowLeft'],       // Move left
    MOVE_RIGHT: ['KeyD', 'ArrowRight'],     // Move right
    SPRINT: ['ShiftLeft', 'ShiftRight'],    // Run / Sprint
    CROUCH: ['ControlLeft', 'ControlRight', 'KeyC'],// Crouch
    JUMP: ['Space'],                        // Jump / Double jump (in mid-air)
    ROLL: ['KeyR'],                         // Roll / Dodge
    PUNCH: ['KeyQ'],                        // Punch combo (Jab & Cross)
    SPELL: ['KeyE'],                        // Cast spell
    INTERACT: ['KeyF'],                     // Interact / Pick up items
  },

  // Physics & Speeds Config
  PHYSICS: {
    GRAV: 22,             // Gravity force pulling the character down
    JUMP_PWR: 9.5,        // Vertical takeoff impulse force for jumping
    SPD_WALK: 2.5,        // Maximum physical walking speed
    SPD_JOG: 3,           // Maximum physical jogging speed (blend speed threshold)
    SPD_SPRINT: 5,        // Maximum physical sprinting speed
    SPD_CROUCH: 2,        // Maximum physical crouching walk speed
    SPD_CROUCH_RUN: 3.2,  // Maximum physical crouching run speed
    ACCEL: 14,            // Movement acceleration rate (speed-up responsiveness)
    DECEL: 16,            // Movement deceleration rate (braking/stopping responsiveness)
    ROT_SPD: 40,          // Character yaw rotation speed responsiveness
    AIR_CONTROL: false,   // Steering control in mid-air (true = full control, false = no control)
    DYNAMIC_FOV: true,    // Dynamically adjust camera Field of View based on movement speed
    DYNAMIC_FOV_MAX: 0.10, // Maximum camera FOV expansion amount added at full sprint speed
    CAM_FOLLOW_LOCK: true, // If true, the camera is locked behind the character's facing direction
    CAM_FOLLOW_PITCH: 1.047, // Camera follow lock pitch (beta angle in radians, approx 60 degrees)
    CAM_FOLLOW_DIST: 8.0, // Camera follow lock distance (radius in meters)
    CAM_LOCK_PITCH: false,   // If true, drag input only rotates camera horizontally (locks vertical/pitch axis)
    JOYSTICK_LOCK_X: false,  // If true, joystick input is locked to vertical axis only (no strafing/turning)
    DOUBLE_JUMP_ENABLED: true, // If true, the character can perform a double jump in mid-air
    SPEED_MULTIPLIER: 1.0,     // Speed multiplier for walking and running
    PLAY_PARTICLES: true      // Play particles/dust under the character's feet
  },

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
};


// ═══════════════════════════════════════════════════════════
// STATES
// ═══════════════════════════════════════════════════════════
const S = {
  IDLE: 'IDLE', WALK: 'WALK', JOG: 'JOG', SPRINT: 'SPRINT',
  WALK_FORMAL: 'WALK_FORMAL',
  CROUCH_IDLE: 'CROUCH_IDLE', CROUCH_WALK: 'CROUCH_WALK', CROUCH_RUN: 'CROUCH_RUN',
  JUMP_START: 'JUMP_START', JUMP_LOOP: 'JUMP_LOOP', JUMP_LAND: 'JUMP_LAND',
  ROLL: 'ROLL',
  PUNCH: 'PUNCH', PUNCH_JAB: 'PUNCH_JAB', PUNCH_CROSS: 'PUNCH_CROSS',
  SPELL_ENTER: 'SPELL_ENTER', SPELL_SHOOT: 'SPELL_SHOOT', SPELL_EXIT: 'SPELL_EXIT',
  INTERACT: 'INTERACT', PICKUP: 'PICKUP',
};

const ACTION_STATES = new Set([
  S.JUMP_START, S.JUMP_LOOP, S.JUMP_LAND, S.ROLL,
  S.PUNCH, S.PUNCH_JAB, S.PUNCH_CROSS,
  S.SPELL_ENTER, S.SPELL_SHOOT, S.SPELL_EXIT,
  S.INTERACT, S.PICKUP,
]);

const KEYS = DEFAULT_CHAR_CONFIG.KEYS;

// ═══════════════════════════════════════════════════════════
// UTILS & MATH HELPERS
// ═══════════════════════════════════════════════════════════
function lerp(a, b, t) {
  return a + (b - a) * Math.min(1, t);
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * Math.min(1, t);
}

function normBone(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/^(mixamorig\d*|armature)[:_ ]/i, '')
    .replace(/[:_ \-]/g, '');
}

function cleanAnimName(raw) {
  // "Armature|Walk_Loop" → "Walk_Loop"
  const parts = raw.split('|');
  return parts[parts.length - 1].trim();
}


// ═══════════════════════════════════════════════════════════
// LOCOMOTION BLEND TREE
// ═══════════════════════════════════════════════════════════
class LocoBlendGroup {
  constructor(animCtrl) {
    this.anim = animCtrl;
    this.weight = 0.0;
    this.speed = 0.0;
    this.animatables = [];
    this.isPlaying = false;
  }

  start(loop = true, speedRatio = 1.0, from, to, falseArg = false) {
    this.isPlaying = true;
    const idle = this.anim.g.get('Idle_Loop');
    const walk = this.anim.g.get('Walk_Loop');
    const sprint = this.anim.g.get('Sprint_Loop');

    const char = this.anim.charCtrl;
    const spdWalk = char ? char.SPD_WALK : 2.4;
    const spdSprint = char ? char.SPD_SPRINT : 6.0;
    const multiplier = char ? char.SPEED_MULTIPLIER : 1.0;

    const walkRatio = spdWalk * (1.5 / 2.4) * multiplier;
    const sprintRatio = spdSprint * (1.1 / 6.0) * multiplier;

    if (idle && !idle.isPlaying) idle.start(true, 1.0, idle.from, idle.to, false);
    if (walk && !walk.isPlaying) walk.start(true, walkRatio, walk.from, walk.to, false);
    if (sprint && !sprint.isPlaying) sprint.start(true, sprintRatio, sprint.from, sprint.to, false);

    this.updateWeights();
  }

  stop() {
    this.isPlaying = false;
    const idle = this.anim.g.get('Idle_Loop');
    const walk = this.anim.g.get('Walk_Loop');
    const sprint = this.anim.g.get('Sprint_Loop');

    if (idle) idle.stop();
    if (walk) walk.stop();
    if (sprint) sprint.stop();
  }

  setWeightForAllAnimatables(w) {
    this.weight = w;
    this.updateWeights();
  }

  updateSpeed(speed) {
    const dt = this.anim.scene.getEngine().getDeltaTime() / 1000;
    if (dt > 0 && dt < 0.1) {
      // Smoothly interpolate the blend tree speed for svelte, fluid transitions
      this.speed = lerp(this.speed, speed, 1 - Math.exp(-8 * dt));
    } else {
      this.speed = speed;
    }

    // Dynamically adjust Walk_Loop and Sprint_Loop speedRatio
    const walk = this.anim.g.get('Walk_Loop');
    const sprint = this.anim.g.get('Sprint_Loop');
    const char = this.anim.charCtrl;

    if (char) {
      const backward = char._isPressed('MOVE_BACKWARD') || (char.isTouch && char.touchVector.y < -0.2);
      const sign = (char.CAM_FOLLOW_LOCK && backward) ? -1 : 1;

      if (walk) {
        if (char.CAM_FOLLOW_LOCK && char.state === S.WALK && char.speed < 0.1) {
          // Turning in place shuffle speed
          walk.speedRatio = 2.2;
        } else {
          // Normal walking speed ratio (scaled by speed multiplier)
          const spdWalk = char.SPD_WALK;
          walk.speedRatio = sign * spdWalk * (1.5 / 2.4) * char.SPEED_MULTIPLIER;
        }
      }

      if (sprint) {
        // Normal sprinting speed ratio (scaled by speed multiplier)
        const spdSprint = char.SPD_SPRINT;
        sprint.speedRatio = sign * spdSprint * (1.1 / 6.0) * char.SPEED_MULTIPLIER;
      }
    }

    this.updateWeights();
  }

  updateWeights() {
    const idle = this.anim.g.get('Idle_Loop');
    const walk = this.anim.g.get('Walk_Loop');
    const sprint = this.anim.g.get('Sprint_Loop');

    if (!idle || !walk || !sprint) return;

    let wIdle = 0, wWalk = 0, wSprint = 0;
    const v = this.speed;

    const char = this.anim.charCtrl;
    const spdWalk = char ? char.SPD_WALK * char.SPEED_MULTIPLIER : 2.4;
    const spdSprint = char ? char.SPD_SPRINT * char.SPEED_MULTIPLIER : 6.0;

    if (v <= 0) {
      wIdle = 1.0;
    } else if (v <= spdWalk) {
      const t = v / spdWalk;
      wIdle = 1.0 - t;
      wWalk = t;
    } else if (v <= spdSprint) {
      const t = (v - spdWalk) / (spdSprint - spdWalk);
      wWalk = 1.0 - t;
      wSprint = t;
    } else {
      wSprint = 1.0;
    }

    idle.setWeightForAllAnimatables(wIdle * this.weight);
    walk.setWeightForAllAnimatables(wWalk * this.weight);
    sprint.setWeightForAllAnimatables(wSprint * this.weight);
  }
}

// ═══════════════════════════════════════════════════════════
// ANIMATION CONTROLLER
// ═══════════════════════════════════════════════════════════
class AnimCtrl {
  constructor(groups, scene) {
    this.scene = scene;
    this.cur = null;
    this.curName = '';
    this.activeTransitions = [];
    this.activeWeight = 1.0;
    this.customWeights = new Map(); // Store specific defaults here
    this.onAnimationChange = null;  // Callback for decoupling UI
    this._warnedMissing = new Set();

    // Support both pre-populated Map or a simple Array of AnimationGroups
    if (groups instanceof Map) {
      this.g = groups;
    } else if (Array.isArray(groups)) {
      this.g = new Map();
      groups.forEach(ag => {
        const cleanName = cleanAnimName(ag.name);
        this.g.set(cleanName, ag);
      });
    } else {
      this.g = new Map();
    }

    // console.log('[AnimCtrl] loaded:', [...this.g.keys()].sort().join(', '));

    // Register Locomotion Blend Tree as a virtual animation group
    this.locoGroup = new LocoBlendGroup(this);
    this.g.set('Locomotion', this.locoGroup);

    this.resetInactiveWeights();
  }

  resetInactiveWeights() {
    const activeNames = new Set();
    if (this.cur) {
      activeNames.add(this.curName);
      if (this.curName === 'Locomotion') {
        activeNames.add('Idle_Loop');
        activeNames.add('Walk_Loop');
        activeNames.add('Sprint_Loop');
      }
    }
    this.activeTransitions.forEach(t => {
      for (const [name, group] of this.g.entries()) {
        if (group === t.incoming || group === t.outgoing) {
          activeNames.add(name);
          if (name === 'Locomotion') {
            activeNames.add('Idle_Loop');
            activeNames.add('Walk_Loop');
            activeNames.add('Sprint_Loop');
          }
        }
      }
    });

    // Resolve active Names into actual AnimationGroup objects
    const activeGroups = new Set();
    activeNames.forEach(name => {
      const group = this.g.get(name);
      if (group) {
        activeGroups.add(group);
      }
    });

    // Stop and zero weight only for groups that are NOT active in any mapped name
    for (const [name, group] of this.g.entries()) {
      if (!activeGroups.has(group)) {
        group.setWeightForAllAnimatables(0);
        group.stop();
      }
    }
  }

  setWeight(w) {
    this.activeWeight = w;
    if (this.cur && this.activeTransitions.length === 0) {
      this.cur.setWeightForAllAnimatables(w);
    }
  }

  setCustomWeight(name, w) {
    this.customWeights.set(name, w);
  }

  _warnMissing(name) {
    if (this._warnedMissing.has(name)) return;
    this._warnedMissing.add(name);
    console.warn('[AnimCtrl] missing:', name);
  }

  play(name, loop = false, blendDuration = 0.25, onEnd = null, speedRatio = 1.0, weightParam = null) {
    const ag = this.g.get(name);
    if (!ag) { this._warnMissing(name); return false; }

    // Apply speed multiplier to all animations except Locomotion and Jump states (which require fixed timing)
    let finalSpeedRatio = speedRatio;
    if (name !== 'Locomotion' && !name.startsWith('Jump_') && this.charCtrl) {
      finalSpeedRatio *= this.charCtrl.SPEED_MULTIPLIER;
    }

    // Resolve target weight:
    // 1. Explicit argument in play()
    // 2. Pre-configured custom weight for this animation
    // 3. Fallback to global active weight slider
    let targetWeight = this.activeWeight;
    if (weightParam !== null) {
      targetWeight = weightParam;
    } else if (this.customWeights.has(name)) {
      targetWeight = this.customWeights.get(name);
    }

    if (this.cur === ag) {
      this.cur.setWeightForAllAnimatables(targetWeight);
      this.cur.speedRatio = finalSpeedRatio;
      if (!loop) {
        if (this.cur.onAnimationGroupEndObservable) {
          this.cur.onAnimationGroupEndObservable.clear();
        }
        this.cur.start(loop, finalSpeedRatio, this.cur.from, this.cur.to, false);
        if (onEnd) {
          this.cur.onAnimationGroupEndObservable.addOnce(() => onEnd());
        }
      }
      return true;
    }

    const outgoing = this.cur;
    const incoming = ag;

    // Cancel any active transitions for incoming/outgoing to avoid conflicts
    if (this.activeTransitions) {
      this.activeTransitions = this.activeTransitions.filter(t => {
        if (t.incoming === incoming || t.outgoing === incoming || t.incoming === outgoing || t.outgoing === outgoing) {
          if (t.observer) this.scene.onBeforeRenderObservable.remove(t.observer);
          return false;
        }
        return true;
      });
    }

    // Start incoming animation group
    incoming.start(loop, finalSpeedRatio, incoming.from, incoming.to, false);
    incoming.setWeightForAllAnimatables(outgoing ? 0 : targetWeight);

    if (outgoing) {
      if (outgoing.onAnimationGroupEndObservable) {
        outgoing.onAnimationGroupEndObservable.clear();
      }
      let elapsed = 0;
      const outgoingStartWeight = outgoing.animatables[0] ? outgoing.animatables[0].weight : targetWeight;
      const transition = {
        incoming,
        outgoing,
        observer: null
      };
      transition.observer = this.scene.onBeforeRenderObservable.add(() => {
        const dt = this.scene.getEngine().getDeltaTime() / 1000;
        elapsed += dt;
        const t = Math.min(1.0, elapsed / blendDuration);

        // Smooth step weight blending
        const smoothT = t * t * (3 - 2 * t);

        let currentTarget = this.activeWeight;
        if (weightParam !== null) {
          currentTarget = weightParam;
        } else if (this.customWeights.has(name)) {
          currentTarget = this.customWeights.get(name);
        }

        incoming.setWeightForAllAnimatables(smoothT * currentTarget);
        outgoing.setWeightForAllAnimatables((1.0 - smoothT) * outgoingStartWeight);

        if (t >= 1.0) {
          // Transition complete
          outgoing.setWeightForAllAnimatables(0);
          outgoing.stop();
          this.scene.onBeforeRenderObservable.remove(transition.observer);
          if (this.activeTransitions) {
            this.activeTransitions = this.activeTransitions.filter(item => item !== transition);
          }
          this.resetInactiveWeights();
        }
      });
      this.activeTransitions.push(transition);
    }

    this.cur = incoming;
    this.curName = name;

    if (this.onAnimationChange) {
      this.onAnimationChange(name);
    } else {
      const hudAnim = document.getElementById('hud-anim');
      if (hudAnim) {
        hudAnim.textContent = name;
      }
    }

    if (onEnd && !loop) {
      incoming.onAnimationGroupEndObservable.addOnce(() => onEnd());
    }

    this.resetInactiveWeights();
    return true;
  }

  stop() {
    if (this.cur) {
      this.cur.setWeightForAllAnimatables(0);
      this.cur.stop();
      this.cur = null;
      this.curName = '';
    }
    this.resetInactiveWeights();
  }

  forceStop() {
    this.activeTransitions.forEach(t => {
      t.incoming.setWeightForAllAnimatables(0);
      t.incoming.stop();
      t.outgoing.setWeightForAllAnimatables(0);
      t.outgoing.stop();
      if (t.observer) this.scene.onBeforeRenderObservable.remove(t.observer);
    });
    this.activeTransitions = [];
    this.stop();
  }

  has(name) { return this.g.has(name); }

  setAnimation(name, animationGroup) {
    const oldAg = this.g.get(name);
    let wasPlaying = false;
    let speedRatio = 1.0;
    let loop = false;

    if (oldAg) {
      wasPlaying = oldAg.isPlaying;
      speedRatio = oldAg.speedRatio;
      loop = oldAg.loop;
      oldAg.stop();
      oldAg.setWeightForAllAnimatables(0);
    }

    this.g.set(name, animationGroup);

    // If the locomotion blend tree is active and we replaced one of its components
    if (this.locoGroup && this.locoGroup.isPlaying && ['Idle_Loop', 'Walk_Loop', 'Sprint_Loop'].includes(name)) {
      this.locoGroup.start();
    } else if (wasPlaying || this.curName === name) {
      // Start the new animation group with previous settings if it was active
      animationGroup.start(loop, speedRatio, animationGroup.from, animationGroup.to, false);
      if (this.cur === oldAg) {
        this.cur = animationGroup;
      }
    }

    this.resetInactiveWeights();
    return true;
  }

  setWalkAnim(animationGroup) {
    return this.setAnimation('Walk_Loop', animationGroup);
  }

  setRunAnim(animationGroup) {
    return this.setAnimation('Sprint_Loop', animationGroup);
  }

  setIdleAnim(animationGroup) {
    return this.setAnimation('Idle_Loop', animationGroup);
  }

  setCrouchIdleAnim(animationGroup) {
    return this.setAnimation('Crouch_Idle_Loop', animationGroup);
  }

  setCrouchFwdAnim(animationGroup) {
    return this.setAnimation('Crouch_Fwd_Loop', animationGroup);
  }

  setJumpStartAnim(animationGroup) {
    return this.setAnimation('Jump_Start', animationGroup);
  }

  setJumpLoopAnim(animationGroup) {
    return this.setAnimation('Jump_Loop', animationGroup);
  }

  setJumpLandAnim(animationGroup) {
    return this.setAnimation('Jump_Land', animationGroup);
  }

  setRollAnim(animationGroup) {
    return this.setAnimation('Roll', animationGroup);
  }

  setPunchAnim(animationGroup) {
    return this.setAnimation('Punch', animationGroup);
  }

  setPunchJabAnim(animationGroup) {
    return this.setAnimation('Punch_Jab', animationGroup);
  }

  setPunchCrossAnim(animationGroup) {
    return this.setAnimation('Punch_Cross', animationGroup);
  }

  setSpellEnterAnim(animationGroup) {
    return this.setAnimation('Spell_Simple_Enter', animationGroup);
  }

  setSpellShootAnim(animationGroup) {
    return this.setAnimation('Spell_Simple_Shoot', animationGroup);
  }

  setSpellExitAnim(animationGroup) {
    return this.setAnimation('Spell_Simple_Exit', animationGroup);
  }

  setInteractAnim(animationGroup) {
    return this.setAnimation('Interact', animationGroup);
  }

  setAnimationRanges(name, fromFrame, toFrame) {
    const ag = this.g.get(name);
    if (ag) {
      ag.from = fromFrame;
      ag.to = toFrame;
      if (ag.isPlaying) {
        ag.start(ag.loop, ag.speedRatio, fromFrame, toFrame, false);
      }
      return true;
    }
    return false;
  }

  destroy() {
    this.forceStop();
  }
}

// ═══════════════════════════════════════════════════════════
// CHARACTER CONTROLLER
// ═══════════════════════════════════════════════════════════
class CharCtrl {
  constructor(root, visualMesh, camera, anim, scene, options = {}) {
    this.root = root; // Capsule collider parent mesh
    this.visualMesh = visualMesh; // Visual character mesh
    this.camera = camera;
    this.anim = anim;
    anim.charCtrl = this;
    this.scene = scene;

    // Key Bindings
    this.keyBindings = Object.assign({}, KEYS, options.keys || {});

    // Callbacks & Custom UI configuration
    this.callbacks = Object.assign({
      onStateChange: null,
      onSpeedChange: null,
      onCombo: null
    }, options.callbacks || {});

    // Physics & Speeds Config
    const config = Object.assign({}, DEFAULT_CHAR_CONFIG.PHYSICS, options.config || {});

    // Use physics parameter
    this.usePhysics = options.usePhysics !== undefined ? options.usePhysics : (localStorage.getItem('use-physics') !== 'false');

    this.GRAV = config.GRAV;
    this.JUMP_PWR = config.JUMP_PWR;
    this.SPD_WALK = config.SPD_WALK;
    this.SPD_JOG = config.SPD_JOG;
    this.SPD_SPRINT = config.SPD_SPRINT;
    this.SPD_CROUCH = config.SPD_CROUCH;
    this.SPD_CROUCH_RUN = config.SPD_CROUCH_RUN;
    this.ACCEL = config.ACCEL;
    this.DECEL = config.DECEL;
    this.ROT_SPD = config.ROT_SPD;
    const savedAirControl = localStorage.getItem('air-control-enabled');
    this.AIR_CONTROL = savedAirControl !== null ? (savedAirControl === 'true') : (config.AIR_CONTROL !== undefined ? config.AIR_CONTROL : false);
    // Load configurable states from localStorage, falling back to configuration block defaults
    const savedCamFollowLock = localStorage.getItem('cam-follow-lock');
    this.CAM_FOLLOW_LOCK = savedCamFollowLock !== null ? (savedCamFollowLock === 'true') : config.CAM_FOLLOW_LOCK;

    const savedDynamicFov = localStorage.getItem('dynamic-fov');
    this.DYNAMIC_FOV = savedDynamicFov !== null ? (savedDynamicFov === 'true') : config.DYNAMIC_FOV;

    const savedDynamicFovMax = localStorage.getItem('dynamic-fov-max');
    this.DYNAMIC_FOV_MAX = savedDynamicFovMax !== null ? parseFloat(savedDynamicFovMax) : config.DYNAMIC_FOV_MAX;

    const savedCamFollowPitch = localStorage.getItem('cam-follow-pitch');
    this.CAM_FOLLOW_PITCH = savedCamFollowPitch !== null ? parseFloat(savedCamFollowPitch) : (config.CAM_FOLLOW_PITCH !== undefined ? config.CAM_FOLLOW_PITCH : Math.PI / 3.0);

    const savedCamFollowDist = localStorage.getItem('cam-follow-dist');
    this.CAM_FOLLOW_DIST = savedCamFollowDist !== null ? parseFloat(savedCamFollowDist) : (config.CAM_FOLLOW_DIST !== undefined ? config.CAM_FOLLOW_DIST : this.camera.radius);

    const savedCamLockPitch = localStorage.getItem('cam-lock-pitch');
    this.CAM_LOCK_PITCH = savedCamLockPitch !== null ? (savedCamLockPitch === 'true') : (config.CAM_LOCK_PITCH !== undefined ? config.CAM_LOCK_PITCH : false);

    const savedJoystickLockX = localStorage.getItem('joystick-lock-x');
    this.JOYSTICK_LOCK_X = savedJoystickLockX !== null ? (savedJoystickLockX === 'true') : (config.JOYSTICK_LOCK_X !== undefined ? config.JOYSTICK_LOCK_X : false);

    const savedDoubleJump = localStorage.getItem('double-jump-enabled');
    this.DOUBLE_JUMP_ENABLED = savedDoubleJump !== null ? (savedDoubleJump === 'true') : (config.DOUBLE_JUMP_ENABLED !== undefined ? config.DOUBLE_JUMP_ENABLED : true);

    const savedSpeedMultiplier = localStorage.getItem('speed-multiplier');
    this.SPEED_MULTIPLIER = savedSpeedMultiplier !== null ? parseFloat(savedSpeedMultiplier) : (config.SPEED_MULTIPLIER !== undefined ? config.SPEED_MULTIPLIER : 1.0);

    const savedShowCombo = localStorage.getItem('show-combo');
    this.SHOW_COMBO = savedShowCombo !== null ? (savedShowCombo === 'true') : true;

    const savedPlayParticles = localStorage.getItem('play-particles');
    this.PLAY_PARTICLES = savedPlayParticles !== null ? (savedPlayParticles === 'true') : (config.PLAY_PARTICLES !== undefined ? config.PLAY_PARTICLES : true);

    this._originalSensibilityX = this.camera.angularSensibilityX;
    this._originalRadius = this.camera.radius;
    // console.log("[CharCtrl] Config loaded: FOLLOW_LOCK =", this.CAM_FOLLOW_LOCK, " | DYNAMIC_FOV =", this.DYNAMIC_FOV, " | FOV_MAX =", this.DYNAMIC_FOV_MAX, " | FOLLOW_PITCH =", this.CAM_FOLLOW_PITCH, " | FOLLOW_DIST =", this.CAM_FOLLOW_DIST);

    // Apply Hide Cursor state if persisted in localStorage
    if (localStorage.getItem('hide-cursor') === 'true') {
      document.body.classList.add('cursor-hidden');
    }

    // Mobile / Touch controls configuration
    this.touchConfig = Object.assign({}, DEFAULT_CHAR_CONFIG.TOUCH, options.touch || {});

    // Initialize Havok Physics Body if enabled
    if (this.usePhysics) {
      const startPoint = new BABYLON.Vector3(0, -0.55, 0);
      const endPoint = new BABYLON.Vector3(0, 0.55, 0);
      this._standShape = new BABYLON.PhysicsShapeCapsule(startPoint, endPoint, 0.35, scene);
      this._crouchShape = new BABYLON.PhysicsShapeCapsule(new BABYLON.Vector3(0, -0.55, 0), new BABYLON.Vector3(0, 0.35, 0), 0.35, scene);

      this._standShape.material = { friction: 0, restitution: 0 };
      this._crouchShape.material = { friction: 0, restitution: 0 };

      this.physicsBody = new BABYLON.PhysicsBody(this.root, BABYLON.PhysicsMotionType.DYNAMIC, false, scene);
      this.physicsBody.shape = this._standShape;
      this.physicsBody.disablePreStep = false;
      this.physicsBody.setMassProperties({
        mass: 1,
        inertia: new BABYLON.Vector3(0, 0, 0)
      });
    }

    // Physics running state
    this.speed = 0;
    this.rotY = 0;
    this.jumpVel = 0;
    this.grounded = false;
    this.onScalable = false;
    this._wasOnScalable = false;
    this.onStairs = false;
    this._airborneTime = 0;
    this._lastGroundedFrame = 0;
    this._rollOnLand = false;
    this._rollActive = false;
    this._lastRollTime = 0;
    this._rollTimeoutId = null;
    this._wasClimbingStep = false;

    // State
    this.state = S.IDLE;
    this.stateT = 0;
    this.crouching = false;
    this._forcedCrouchFromRoll = false;
    this._hasDoubleJumped = false;
    this.sprinting = false;
    this.sitting = false;
    this.weapon = null; // null | 'spell'
    this.comboIdx = 0;
    this.comboT = 0;
    this.moveDir = new BABYLON.Vector3(0, 0, 0);

    this.keys = {};
    this.touchVector = { x: 0, y: 0 };
    this.isTouch = false;
    this._touchListeners = [];

    this._setupInput();

    // Setup procedural dust particles
    this._setupDustParticles();

    // Touch device setup
    // Windows Chrome reports maxTouchPoints=10 on non-touch desktops — can't use API alone.
    // iPad OS 13+ spoofs a Mac UA — can't rely on UA alone.
    // Strategy: combine UA check + coarse-pointer media query.
    // Real touch devices (phones/tablets) have coarse pointer; desktop mice are fine.
    const hasTouchAPI = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);
    const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    // iPad OS 13+ spoofs Mac UA but still has coarse pointer
    const hasTouch = hasTouchAPI && (hasCoarsePointer || isMobileUA);
    this.isTouch = hasTouch;
    if (this.isTouch) {
      document.body.classList.add('touch-device');
      // Wait slightly for DOM loading
      setTimeout(() => this._setupTouchHUD(), 200);
    }

    // Capture initial dimensions for automatic crouch scaling
    this._standEllipsoidY = this.root.ellipsoid ? this.root.ellipsoid.y : 0.96;
    this._standEllipsoidWidth = this.root.ellipsoid ? this.root.ellipsoid.x : 0.35;
    this._standMeshY = this.visualMesh.position.y;
    this._crouchEllipsoidY = 0.75;
    this._lastY = this.root.position.y;
    this._highestAirborneY = this.root.position.y;

    // Perfect controller procedural & suspension variables
    this.targetLocalY = this._standMeshY;
    this.visualLocalY = this._standMeshY;
    this.tiltPitch = 0;
    this.tiltRoll = 0;
    this.targetScale = new BABYLON.Vector3(1, 1, 1);
    this._lastRotY = this.rotY;
    this._lastSpeed = this.speed;
    this._camShake = 0;
    this._bobTime = 0;
    this._initialCameraFOV = this.camera.fov || 0.8;
    this._timeSinceSpawn = 0;

    // Cache initial visual mesh yaw rotation to preserve imports & orientations
    if (this.visualMesh.rotationQuaternion) {
      const euler = this.visualMesh.rotationQuaternion.toEulerAngles();
      this._initialVisualYaw = euler.y;
    } else {
      this._initialVisualYaw = this.visualMesh.rotation.y;
    }

    this._updateObserver = scene.onBeforeRenderObservable.add(() => this._update());

    // Track last known alpha/beta/radius to compute mouse/zoom deltas each frame
    this._lastCameraAlpha = this.camera.alpha;
    this._lastCameraBeta = this.camera.beta;
    this._lastCameraRadius = this.camera.radius;

    this._cameraLockObserver = scene.onBeforeCameraRenderObservable.add(() => {
      // Sync camera radius zoom updates (wheel, trackpad, pinch) back to CAM_FOLLOW_DIST and HUD
      const now = performance.now();
      const isWheelZooming = (now - (this._lastWheelTime || 0)) < 250;
      const isTouchPinchZooming = (this._touchCount !== undefined && this._touchCount >= 2);
      const isUserZooming = isWheelZooming || isTouchPinchZooming;

      const radiusDelta = this.camera.radius - this._lastCameraRadius;
      if (isUserZooming && Math.abs(radiusDelta) > 0.0001) {
        const slider = document.getElementById('slider-cam-dist');
        const minVal = slider ? parseFloat(slider.min) : 2;
        const maxVal = slider ? parseFloat(slider.max) : 15;
        this.CAM_FOLLOW_DIST = Math.max(minVal, Math.min(maxVal, this.camera.radius));
        localStorage.setItem('cam-follow-dist', this.CAM_FOLLOW_DIST);

        const label = document.getElementById('cam-dist-val');
        if (slider) {
          slider.value = this.CAM_FOLLOW_DIST;
        }
        if (window.physicsConfig) {
          window.physicsConfig.CAM_FOLLOW_DIST = this.CAM_FOLLOW_DIST;
        }
        if (typeof window.updateExportCode === 'function') {
          window.updateExportCode();
        }
        if (label) {
          label.textContent = this.CAM_FOLLOW_DIST.toFixed(1) + 'm';
        }
      }

      // Sync manual camera pitch drag back to CAM_FOLLOW_PITCH and sync HUD in both modes!
      const betaDelta = this.camera.beta - this._lastCameraBeta;
      if (this._pointerDragging && Math.abs(betaDelta) > 0.0001) {
        // Block pitch if CAM_LOCK_PITCH is enabled (horizontal-only drag)
        if (this.CAM_LOCK_PITCH) {
          this.camera.beta = this._lastCameraBeta;
        } else if (!this.grounded && !this.AIR_CONTROL) {
          // Block manual camera pitch in the air if air control is disabled
          this.camera.beta = this._lastCameraBeta;
        } else {
          const lo = this.camera.lowerBetaLimit || 0.05;
          const hi = this.camera.upperBetaLimit || (Math.PI / 2.05);
          this.CAM_FOLLOW_PITCH = Math.max(lo, Math.min(hi, this.camera.beta));
          localStorage.setItem('cam-follow-pitch', this.CAM_FOLLOW_PITCH);
          // Sync HUD slider and label
          const slider = document.getElementById('slider-cam-pitch');
          const label = document.getElementById('cam-pitch-val');
          if (slider) {
            const deg = Math.round(this.CAM_FOLLOW_PITCH * 180 / Math.PI);
            slider.value = deg;
          }
          if (window.physicsConfig) {
            window.physicsConfig.CAM_FOLLOW_PITCH = this.CAM_FOLLOW_PITCH;
          }
          if (typeof window.updateExportCode === 'function') {
            window.updateExportCode();
          }
          if (label) {
            const deg = Math.round(this.CAM_FOLLOW_PITCH * 180 / Math.PI);
            label.textContent = deg + '°';
          }
        }
      }

      // Enforce configured radius and pitch in all modes when not dragging to maintain consistency and prevent drifting
      this.camera.radius = this.CAM_FOLLOW_DIST;
      if (!this._pointerDragging) {
        this.camera.beta = this.CAM_FOLLOW_PITCH;
      }

      if (this.CAM_FOLLOW_LOCK) {
        // Restore full mouse sensitivity
        this.camera.angularSensibilityX = this._originalSensibilityX || 1000;

        // Apply mouse yaw delta to rotY (alpha = -rotY - PI/2, so delta inverts)
        const alphaDelta = this.camera.alpha - this._lastCameraAlpha;
        if (Math.abs(alphaDelta) > 0.0001) {
          // Block manual rotation in the air if air control is disabled
          if (!this.grounded && !this.AIR_CONTROL) {
            this.camera.alpha = this._lastCameraAlpha;
          } else {
            this.rotY -= alphaDelta * this.SPEED_MULTIPLIER;
            if (this.usePhysics) {
              this.root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(this.rotY, 0, 0);
            } else {
              this.root.rotation.y = this.rotY;
            }
            this._lastYawTurnTime = performance.now();
          }
        }

        // Push camera alpha to match rotY (single source of truth)
        const dt = this.scene.getEngine().getDeltaTime() / 1000;
        if (dt > 0 && dt < 0.1) {
          const targetAlpha = -this.rotY - Math.PI / 2;
          const rate = (this.speed < 0.1) ? 38 : 16; // Much more responsive (snappy) when stopped, smooth when moving
          this.camera.alpha = lerpAngle(this.camera.alpha, targetAlpha, 1 - Math.exp(-rate * dt));
        }
        this._lastCameraAlpha = this.camera.alpha;
        this._lastCameraBeta = this.camera.beta;
      } else {
        // Under standard camera mode, if air control is false and they are in mid-air, lock camera alpha/beta!
        if (!this.grounded && !this.AIR_CONTROL) {
          this.camera.alpha = this._lastCameraAlpha;
          this.camera.beta = this._lastCameraBeta;
        } else {
          this._lastCameraAlpha = this.camera.alpha;
          this._lastCameraBeta = this.camera.beta;
        }
      }

      this._lastCameraRadius = this.camera.radius;
    });

    // Start idle
    this._idle();
  }

  // ── DUST PARTICLE SYSTEM ─────────────────────────────
  _setupDustParticles() {
    const smokeTex = new BABYLON.Texture("assets/smoke.png", this.scene);

    // Instantiate Particle System
    this.dustPS = new BABYLON.ParticleSystem("dustParticles", 300, this.scene);
    this.dustPS.particleTexture = smokeTex;
    this.dustPS.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;

    // Emitter is placed at the player's feet
    const initialFeetPos = this.root.position.add(new BABYLON.Vector3(0, -0.95, 0));
    this.dustPS.emitter = initialFeetPos;
    this.dustPS.minEmitBox = new BABYLON.Vector3(-0.25, -0.05, -0.25);
    this.dustPS.maxEmitBox = new BABYLON.Vector3(0.25, 0.05, 0.25);

    this.dustPS.color1 = new BABYLON.Color4(0.7, 0.7, 0.7, 0.45);
    this.dustPS.color2 = new BABYLON.Color4(0.55, 0.52, 0.48, 0.22);
    this.dustPS.colorDead = new BABYLON.Color4(0, 0, 0, 0);

    this.dustPS.minSize = 0.16;
    this.dustPS.maxSize = 0.45;
    this.dustPS.minLifeTime = 0.2;
    this.dustPS.maxLifeTime = 0.45;
    this.dustPS.emitRate = 0; // Starts stopped, we emit manually or update emitRate

    this.dustPS.gravity = new BABYLON.Vector3(0, 1.2, 0); // dust rises slightly
    this.dustPS.direction1 = new BABYLON.Vector3(-0.5, 0.2, -0.5);
    this.dustPS.direction2 = new BABYLON.Vector3(0.5, 0.4, 0.5);

    this.dustPS.minEmitPower = 0.2;
    this.dustPS.maxEmitPower = 0.6;
    this.dustPS.updateSpeed = 0.016;

    this.dustPS.start();
  }

  _emitLandingDust() {
    if (this.PLAY_PARTICLES && this.dustPS) {
      this.dustPS.manualEmitCount = 30; // Emit 30 particles instantly
      this.dustPS.start();              // Force restart to process manual emission
    }
  }

  _isPressed(action) {
    const keysForAction = this.keyBindings[action];
    if (!keysForAction) return false;
    if (Array.isArray(keysForAction)) {
      return keysForAction.some(k => this.keys[k]);
    }
    return !!this.keys[keysForAction];
  }

  _matchesAction(code, action) {
    const keysForAction = this.keyBindings[action];
    if (!keysForAction) return false;
    if (Array.isArray(keysForAction)) {
      return keysForAction.includes(code);
    }
    return keysForAction === code;
  }

  // ── INPUT ──────────────────────────────────────────────
  _setupInput() {
    this._boundKeyDown = e => {
      const modal = document.getElementById('info-panel-modal');
      if (modal && modal.classList.contains('open')) {
        return;
      }
      this.keys[e.code] = true;
      if (!e.repeat) this._keyDown(e.code);
    };
    this._boundKeyUp = e => { this.keys[e.code] = false; };
    this._boundReset = () => this._resetInputState();

    window.addEventListener('keydown', this._boundKeyDown);
    window.addEventListener('keyup', this._boundKeyUp);
    window.addEventListener('focus', this._boundReset);
    window.addEventListener('blur', this._boundReset);

    const canvasEl = this.scene.getEngine().getRenderingCanvas();
    if (canvasEl) {
      // Double click to recenter camera
      this._boundDblClick = () => { this._recenterCamera(); };
      canvasEl.addEventListener('dblclick', this._boundDblClick);

      // Track pointer drag state to distinguish intentional pitch input from camera drift
      this._activePointers = new Set();
      this._lastWheelTime = 0;
      this._pointerDragging = false;
      this._boundPointerDown = (e) => {
        this._activePointers.add(e.pointerId);
        this._pointerDragging = true;
      };
      this._boundPointerUp = (e) => {
        this._activePointers.delete(e.pointerId);
        if (this._activePointers.size === 0) {
          this._pointerDragging = false;
        }
      };
      canvasEl.addEventListener('pointerdown', this._boundPointerDown);
      canvasEl.addEventListener('pointerup', this._boundPointerUp);
      canvasEl.addEventListener('pointercancel', this._boundPointerUp);

      // Track scroll wheel activity
      this._boundWheel = () => {
        this._lastWheelTime = performance.now();
      };
      canvasEl.addEventListener('wheel', this._boundWheel, { passive: true });

      // Track touchscreen touches to detect multitouch/pinches reliably
      this._touchCount = 0;
      this._boundTouchStart = (e) => { this._touchCount = e.touches.length; };
      this._boundTouchEnd = (e) => { this._touchCount = e.touches.length; };
      canvasEl.addEventListener('touchstart', this._boundTouchStart, { passive: true });
      canvasEl.addEventListener('touchmove', this._boundTouchStart, { passive: true });
      canvasEl.addEventListener('touchend', this._boundTouchEnd, { passive: true });
      canvasEl.addEventListener('touchcancel', this._boundTouchEnd, { passive: true });
    }
  }

  _resetInputState() {
    this.keys = {};
    this.touchVector = { x: 0, y: 0 };
    if (this.joystickKnob) {
      this.joystickKnob.style.transform = 'translate(0px, 0px)';
    }
    if (this.joystickRing) {
      this.joystickRing.classList.remove('active');
    }
    this._idle();
  }

  _setupTouchHUD() {
    const zone = document.getElementById(this.touchConfig.zoneId);
    const ring = document.getElementById(this.touchConfig.ringId);
    const knob = document.getElementById(this.touchConfig.knobId);

    if (!zone || !ring || !knob) {
      // console.log('[CharCtrl] Mobile joystick elements not found in DOM, skipping joystick initialization');
      return;
    }

    this.joystickRing = ring;
    this.joystickKnob = knob;

    let activePointerId = null;
    const maxDist = 50; // max drag radius in pixels

    const onPointerDown = (e) => {
      if (activePointerId !== null) return;
      activePointerId = e.pointerId;
      ring.classList.add('active');
      zone.setPointerCapture(e.pointerId);
      updateJoystick(e);
    };

    const onPointerMove = (e) => {
      if (activePointerId !== e.pointerId) return;
      updateJoystick(e);
    };

    const onPointerUp = (e) => {
      if (activePointerId !== e.pointerId) return;
      activePointerId = null;
      ring.classList.remove('active');
      zone.releasePointerCapture(e.pointerId);

      knob.style.transform = 'translate(0px, 0px)';
      this.touchVector = { x: 0, y: 0 };
    };

    const updateJoystick = (e) => {
      const ringBounds = ring.getBoundingClientRect();
      const centerX = ringBounds.left + ringBounds.width / 2;
      const centerY = ringBounds.top + ringBounds.height / 2;

      let dx = e.clientX - centerX;
      let dy = e.clientY - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > maxDist) {
        dx = (dx / dist) * maxDist;
        dy = (dy / dist) * maxDist;
      }

      // When JOYSTICK_LOCK_X is enabled, constrain knob and input to vertical axis only
      if (this.JOYSTICK_LOCK_X) dx = 0;

      knob.style.transform = `translate(${dx}px, ${dy}px)`;

      // Normalize vector to [-1, 1] range
      // Swap Y because screen down is positive, but we want forward (W) to be positive, backward (S) negative
      this.touchVector.x = this.JOYSTICK_LOCK_X ? 0 : dx / maxDist;
      this.touchVector.y = -dy / maxDist;
    };

    const addListener = (element, type, listener) => {
      element.addEventListener(type, listener);
      this._touchListeners.push({ element, type, listener });
    };

    addListener(zone, 'pointerdown', onPointerDown);
    addListener(zone, 'pointermove', onPointerMove);
    addListener(zone, 'pointerup', onPointerUp);
    addListener(zone, 'pointercancel', onPointerUp);

    // Action Buttons Pointer Events based on touchConfig
    if (this.touchConfig.buttons) {
      Object.entries(this.touchConfig.buttons).forEach(([btnId, keyCode]) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        const onBtnDown = (e) => {
          e.preventDefault();
          this.keys[keyCode] = true;
          this._keyDown(keyCode);
        };

        const onBtnUp = (e) => {
          e.preventDefault();
          this.keys[keyCode] = false;
        };

        addListener(btn, 'pointerdown', onBtnDown);
        addListener(btn, 'pointerup', onBtnUp);
        addListener(btn, 'pointercancel', onBtnUp);
      });
    }

    // Double tap on canvas to recenter camera
    let lastTap = 0;
    const canvasEl = this.scene.getEngine().getRenderingCanvas();
    if (canvasEl) {
      const onCanvasTap = (e) => {
        if (e.pointerType !== 'touch') return;

        // Ignore taps near joystick or action buttons to prevent accidental triggers
        const isNearJoystick = e.clientX < 180 && e.clientY > (window.innerHeight - 180);
        const isNearButtons = e.clientX > (window.innerWidth - 220) && e.clientY > (window.innerHeight - 220);
        if (isNearJoystick || isNearButtons) return;

        const now = performance.now();
        if (now - lastTap < 300) {
          this._recenterCamera();
        }
        lastTap = now;
      };
      addListener(canvasEl, 'pointerdown', onCanvasTap);
    }

    // Prevent browser double-tap zoom and pinch gestures on game interface
    let lastTouchEnd = 0;
    const onTouchEnd = (e) => {
      const target = e.target;
      if (target.closest('#mobile-ctrls') || target.closest('#joystick-zone') || target.id === 'c') {
        const now = performance.now();
        if (now - lastTouchEnd <= 300) {
          e.preventDefault();
        }
        lastTouchEnd = now;
      }
    };
    const onGestureStart = (e) => {
      e.preventDefault();
    };

    document.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('gesturestart', onGestureStart, { passive: false });
    this._touchListeners.push({ element: document, type: 'touchend', listener: onTouchEnd });
    this._touchListeners.push({ element: document, type: 'gesturestart', listener: onGestureStart });
  }

  destroy() {
    // 1. Remove window keyboard and focus/blur event listeners
    if (this._boundKeyDown) window.removeEventListener('keydown', this._boundKeyDown);
    if (this._boundKeyUp) window.removeEventListener('keyup', this._boundKeyUp);
    if (this._boundReset) {
      window.removeEventListener('focus', this._boundReset);
      window.removeEventListener('blur', this._boundReset);
    }

    // 2. Remove update and camera lock observers from scene
    if (this._updateObserver) {
      this.scene.onBeforeRenderObservable.remove(this._updateObserver);
    }
    if (this._cameraLockObserver) {
      this.scene.onBeforeCameraRenderObservable.remove(this._cameraLockObserver);
    }

    // 3. Remove touch and button event listeners
    if (this._touchListeners) {
      this._touchListeners.forEach(({ element, type, listener }) => {
        element.removeEventListener(type, listener);
      });
      this._touchListeners = [];
    }

    // 4. Dispose particle system
    if (this.dustPS) {
      this.dustPS.stop();
      this.dustPS.dispose();
    }

    // 5. Remove canvas listeners
    const canvasEl = this.scene.getEngine().getRenderingCanvas();
    if (canvasEl) {
      if (this._boundDblClick) canvasEl.removeEventListener('dblclick', this._boundDblClick);
      if (this._boundWheel) canvasEl.removeEventListener('wheel', this._boundWheel);
      if (this._boundPointerDown) canvasEl.removeEventListener('pointerdown', this._boundPointerDown);
      if (this._boundPointerUp) {
        canvasEl.removeEventListener('pointerup', this._boundPointerUp);
        canvasEl.removeEventListener('pointercancel', this._boundPointerUp);
      }
      if (this._boundTouchStart) {
        canvasEl.removeEventListener('touchstart', this._boundTouchStart);
        canvasEl.removeEventListener('touchmove', this._boundTouchStart);
      }
      if (this._boundTouchEnd) {
        canvasEl.removeEventListener('touchend', this._boundTouchEnd);
        canvasEl.removeEventListener('touchcancel', this._boundTouchEnd);
      }
    }

    // 6. Dispose physics components
    if (this.usePhysics) {
      if (this.physicsBody) {
        this.physicsBody.dispose();
      }
      if (this._standShape) {
        this._standShape.dispose();
      }
      if (this._crouchShape) {
        this._crouchShape.dispose();
      }
    }
  }

  playParticles(enable) {
    this.PLAY_PARTICLES = !!enable;
    localStorage.setItem('play-particles', this.PLAY_PARTICLES);
    if (!this.PLAY_PARTICLES && this.dustPS) {
      this.dustPS.emitRate = 0;
      this.dustPS.stop();
    }
  }

  _keyDown(code) {
    const inAction = this._isInAction();

    if (this._matchesAction(code, 'CROUCH')) {
      if (this.grounded && !inAction && !this.sitting) {
        if (this.crouching) {
          if (this._canUncrouch()) {
            this.crouching = false;
            this._forcedCrouchFromRoll = false;
            this._returnToLoco();
          } else {
            this._showCombo('CEILING BLOCKED');
            setTimeout(() => this._hideCombo(), 1200);
          }
        } else {
          this.crouching = true;
          this._forcedCrouchFromRoll = false;
          this._returnToLoco();
        }
      }
    } else if (this._matchesAction(code, 'SPRINT')) {
      if (this.grounded && !inAction && !this.sitting) {
        if (this.sprinting) {
          this.sprinting = false;
          this._returnToLoco();
        } else {
          this.sprinting = true;
          this._returnToLoco();
        }
      }
    } else if (this._matchesAction(code, 'JUMP')) {
      if (this.grounded && !inAction && !this.sitting) {
        if (this._isCeilingBlocked()) {
          this._showCombo('CEILING BLOCKED');
          setTimeout(() => this._hideCombo(), 1200);
        } else if (this.crouching) {
          if (this._canUncrouch()) {
            this.crouching = false;
            this._forcedCrouchFromRoll = false;
            this._jump();
          }
        } else {
          this._jump();
        }
      } else if (!this.grounded && (this.state === S.JUMP_START || this.state === S.JUMP_LOOP)) {
        if (this.DOUBLE_JUMP_ENABLED && !this._hasDoubleJumped) {
          this._doubleJump();
        } else {
          this._rollOnLand = true;
          this._showCombo('ROLL QUEUED');
          setTimeout(() => this._hideCombo(), 1200);
        }
      }
    } else if (this._matchesAction(code, 'ROLL')) {
      const now = performance.now();
      if (this._rollActive) return;
      if (now - this._lastRollTime < 1100) {
        this._showCombo('DODGE COOLDOWN');
        setTimeout(() => this._hideCombo(), 800);
        return;
      }
      if (!this.sitting) {
        if (!this.grounded) {
          if (!this.DOUBLE_JUMP_ENABLED) {
            return;
          }
        }
        if (this.grounded && this.crouching && this._isCeilingBlocked()) {
          this._showCombo('NO SPACE TO ROLL');
          setTimeout(() => this._hideCombo(), 1200);
          return;
        }
        if (!this.grounded) {
          this._showCombo('AIR DASH');
          setTimeout(() => this._hideCombo(), 800);
        }
        this._roll();
      }
    } else if (this._matchesAction(code, 'PUNCH')) {
      const isPunching = this.state === S.PUNCH || this.state === S.PUNCH_JAB || this.state === S.PUNCH_CROSS;
      if (this.grounded && (!inAction || isPunching) && !this.weapon && !this.sitting)
        this._punch();
    } else if (this._matchesAction(code, 'SPELL')) {
      if (!inAction && !this.sitting)
        this._spellCast();
    } else if (this._matchesAction(code, 'INTERACT')) {
      if (inAction) return;
      if (!this.sitting) this._interact();
    }
  }

  // ── ACTIONS ────────────────────────────────────────────
  _jump() {
    this.jumpVel = this.JUMP_PWR;
    this.grounded = false;
    this._setState(S.JUMP_START);
    // Dynamic takeoff squash
    this.targetScale.set(1.05, 0.92, 1.05);
    setTimeout(() => {
      if (!this.grounded) {
        this.targetScale.set(0.97, 1.05, 0.97);
      }
    }, 100);
    this.anim.play('Jump_Start', false, 0.2, () => {
      if (this.state === S.JUMP_START && !this.grounded) {
        this._setState(S.JUMP_LOOP);
        this.anim.play('Jump_Loop', true, 0.25);
      }
    });
  }

  _doubleJump() {
    this._hasDoubleJumped = true;
    this.jumpVel = this.JUMP_PWR * 1.0;
    this._setState(S.JUMP_START);

    // Update takeoff momentum (moveDir) at the moment of double jump to respect new input direction!
    let inputX = 0, inputZ = 0;
    if (this._isPressed('MOVE_FORWARD')) inputZ += 1;
    if (this._isPressed('MOVE_BACKWARD')) inputZ -= 1;
    if (this._isPressed('MOVE_RIGHT')) inputX += 1;
    if (this._isPressed('MOVE_LEFT')) inputX -= 1;
    if (this.isTouch && (Math.abs(this.touchVector.x) > 0.01 || Math.abs(this.touchVector.y) > 0.01)) {
      inputX = this.touchVector.x; inputZ = this.touchVector.y;
    }

    if (this.CAM_FOLLOW_LOCK) {
      if (inputZ !== 0) {
        let newDir = new BABYLON.Vector3(Math.sin(this.rotY), 0, Math.cos(this.rotY)).normalize();
        if (inputZ < 0) newDir.scaleInPlace(-1);
        this.moveDir = newDir;
        this.speed = Math.max(this.speed, this.SPD_WALK);
      }
    } else {
      const camFwd = this._camForward();
      const camRgt = this._camRight(camFwd);
      let newDir = camRgt.scale(inputX).add(camFwd.scale(inputZ));
      if (newDir.length() > 0.01) {
        newDir.normalize();
        this.moveDir = newDir;
        this.speed = Math.max(this.speed, this.SPD_WALK);
      }
    }

    this.targetScale.set(1.05, 0.92, 1.05);
    setTimeout(() => {
      if (!this.grounded) {
        this.targetScale.set(0.97, 1.05, 0.97);
      }
    }, 100);

    this._showCombo('DOUBLE JUMP');
    setTimeout(() => this._hideCombo(), 1200);

    this.anim.play('Jump_Start', false, 0.15, () => {
      if (this.state === S.JUMP_START && !this.grounded) {
        this._setState(S.JUMP_LOOP);
        this.anim.play('Jump_Loop', true, 0.2);
      }
    });
  }

  _roll() {
    if (this._rollActive) return;
    this._lastRollTime = performance.now();
    this._rollActive = true;
    this._setState(S.ROLL);
    this.comboIdx = 0;

    let inputX = 0, inputZ = 0;
    if (this._isPressed('MOVE_FORWARD')) inputZ += 1;
    if (this._isPressed('MOVE_BACKWARD')) inputZ -= 1;
    if (this._isPressed('MOVE_RIGHT')) inputX += 1;
    if (this._isPressed('MOVE_LEFT')) inputX -= 1;
    if (this.isTouch && (Math.abs(this.touchVector.x) > 0.01 || Math.abs(this.touchVector.y) > 0.01)) {
      inputX = this.touchVector.x; inputZ = this.touchVector.y;
    }
    this._rollMoving = Math.sqrt(inputX * inputX + inputZ * inputZ) > 0.15;

    // Check if we are in mid-air and have existing horizontal velocity to preserve and boost momentum
    let currentFwdDir = new BABYLON.Vector3(Math.sin(this.rotY), 0, Math.cos(this.rotY)).normalize();
    if (!this.grounded) {
      if (this.usePhysics && this.physicsBody) {
        const cv = this.physicsBody.getLinearVelocity();
        const horiz = new BABYLON.Vector3(cv.x, 0, cv.z);
        if (horiz.length() > 0.5) {
          currentFwdDir = horiz.normalize();
          this._rollMoving = true; // Force movement update so the air dash momentum is applied
        }
      } else if (this.speed > 0.5 && this.moveDir.length() > 0.1) {
        currentFwdDir = this.moveDir.clone().normalize();
        this._rollMoving = true;
      }
    }

    if (this._rollMoving) {
      const hasInput = (inputX !== 0 || inputZ !== 0) || (this.isTouch && (Math.abs(this.touchVector.x) > 0.01 || Math.abs(this.touchVector.y) > 0.01));
      if (hasInput) {
        const camFwd = this._camForward();
        let dir = this._camRight(camFwd).scale(inputX).add(camFwd.scale(inputZ));
        if (dir.length() > 0.01) dir.normalize(); else dir = camFwd;
        this._rollDir = dir;
      } else {
        // No input, but has mid-air momentum: push in the direction of the momentum
        this._rollDir = currentFwdDir;
      }
      const baseRollSpeed = this.grounded ? 3.5 : 4.8; // Stronger speed boost in the air (reduced to 4.8)
      this.speed = Math.max(this.speed, baseRollSpeed * this.SPEED_MULTIPLIER);
    } else {
      this._rollDir = currentFwdDir;
      this.speed = 0;
    }

    // Apply vertical push/boost when rolling in mid-air
    if (!this.grounded) {
      const verticalBoost = this.JUMP_PWR * 0.55; // Balanced upward hop boost
      if (this.usePhysics && this.physicsBody) {
        this.physicsBody.setLinearVelocity(new BABYLON.Vector3(
          this._rollDir.x * this.speed,
          verticalBoost,
          this._rollDir.z * this.speed
        ));
      } else {
        this.jumpVel = verticalBoost;
      }
    }

    this.anim.play('Roll', false, 0.5, null, 1.1);

    this._rollTimeoutId = setTimeout(() => {
      this._rollActive = false;
      if (this.state !== S.ROLL) return;

      if (this._isCeilingBlocked()) {
        this.crouching = true;
        this._forcedCrouchFromRoll = true;
      }

      if (this.usePhysics && this.physicsBody) {
        const cv = this.physicsBody.getLinearVelocity();
        this.physicsBody.setLinearVelocity(new BABYLON.Vector3(0, cv.y, 0));
      }

      // Force state out of ROLL immediately
      this.grounded = this._checkGrounded();
      if (!this.grounded) {
        this._setState(S.JUMP_LOOP);
        this.anim.play('Jump_Loop', true, 0.2);
      } else {
        this._returnToLoco(0.2);
      }
    }, 700 / this.SPEED_MULTIPLIER);
  }

  _punch() {
    const now = performance.now();
    const hasPunch = this.anim.has('Punch');
    const comboWindow = 900 / this.SPEED_MULTIPLIER;

    // Prevent spamming combo steps too quickly (minimum 250ms interval between hits)
    if (this.comboIdx > 0 && (now - this.comboT) < 250 / this.SPEED_MULTIPLIER) {
      return;
    }

    if (hasPunch) {
      // 3-hit combo: Punch -> Punch_Jab -> Punch_Cross
      if (this.comboIdx === 1 && now - this.comboT < comboWindow) {
        // Hit 2: Punch_Jab
        this.comboIdx = 2;
        this.comboT = now;
        this._setState(S.PUNCH_JAB);
        this.anim.play('Punch_Jab', false, 0.08, () => {
          if (this.comboIdx === 2) {
            this.comboIdx = 0;
            this._setState(S.IDLE);
            this._returnToLoco();
            this._hideCombo();
          }
        }, 1.2);
        this._showCombo('JAB');
      } else if (this.comboIdx === 2 && now - this.comboT < comboWindow) {
        // Hit 3: Punch_Cross
        this.comboIdx = 3;
        this.comboT = now;
        this._setState(S.PUNCH_CROSS);
        this.anim.play('Punch_Cross', false, 0.08, () => {
          if (this.comboIdx === 3) {
            this.comboIdx = 0;
            this._setState(S.IDLE);
            this._returnToLoco();
            this._hideCombo();
          }
        }, 1.2);
        this._showCombo('CROSS!');
      } else {
        // Hit 1: Punch
        this.comboIdx = 1;
        this.comboT = now;
        this._setState(S.PUNCH);
        this.anim.play('Punch', false, 0.08, () => {
          if (this.comboIdx === 1) {
            this.comboIdx = 0;
            this._setState(S.IDLE);
            this._returnToLoco();
            this._hideCombo();
          }
        }, 1.2);
        this._showCombo('PUNCH');
      }
    } else {
      // 2-hit combo fallback: Punch_Jab -> Punch_Cross
      if (this.comboIdx === 1 && now - this.comboT < comboWindow) {
        // Hit 2: Punch_Cross
        this.comboIdx = 2;
        this.comboT = now;
        this._setState(S.PUNCH_CROSS);
        this.anim.play('Punch_Cross', false, 0.08, () => {
          if (this.comboIdx === 2) {
            this.comboIdx = 0;
            this._setState(S.IDLE);
            this._returnToLoco();
            this._hideCombo();
          }
        }, 1.2);
        this._showCombo('CROSS!');
      } else {
        // Hit 1: Punch_Jab
        this.comboIdx = 1;
        this.comboT = now;
        this._setState(S.PUNCH_JAB);
        this.anim.play('Punch_Jab', false, 0.08, () => {
          if (this.comboIdx === 1) {
            this.comboIdx = 0;
            this._setState(S.IDLE);
            this._returnToLoco();
            this._hideCombo();
          }
        }, 1.2);
        this._showCombo('JAB');
      }
    }
  }

  _showCombo(txt) {
    if (!this.SHOW_COMBO) return;
    if (this.callbacks.onCombo) {
      this.callbacks.onCombo(txt, true);
    } else {
      const el = document.getElementById('combo');
      if (el) {
        el.textContent = txt;
        el.classList.add('show');
      }
    }
    clearTimeout(this._comboTO);
  }

  _hideCombo() {
    if (this.callbacks.onCombo) {
      this.callbacks.onCombo('', false);
    } else {
      const el = document.getElementById('combo');
      if (el) {
        el.classList.remove('show');
      }
    }
  }

  _spellCast() {
    this._setState(S.SPELL_ENTER);
    // Increased blend duration from 0.1 to 0.35 for an incredibly smooth and premium stand-up transition when casting spells from a crouch
    this.anim.play('Spell_Simple_Enter', false, 0.35, () => {
      this._setState(S.SPELL_SHOOT);
      this.anim.play('Spell_Simple_Shoot', false, 0.15);

      // Let the player move almost immediately (50ms into the shoot animation)
      setTimeout(() => {
        if (this.state === S.SPELL_SHOOT) {
          this._returnToLoco(0.35);
        }
      }, 50 / this.SPEED_MULTIPLIER);
    });
  }

  _interact() {
    this._setState(S.INTERACT);
    // Calculate 35% of the interact animation duration to restore movement control even earlier
    const ag = this.anim.g.get('Interact');
    const fps = (ag && ag.targetedAnimations[0] && ag.targetedAnimations[0].animation) ? ag.targetedAnimations[0].animation.framePerSecond : 30;
    const durationMs = ag ? ((ag.to - ag.from) / fps) * 1000 : 1000;
    const recoveryDelay = (durationMs * 0.35) / this.SPEED_MULTIPLIER;

    this.anim.play('Interact', false, 0.35);

    setTimeout(() => {
      if (this.state === S.INTERACT) {
        this._returnToLoco(0.35);
      }
    }, recoveryDelay);
  }

  // ── IDLE ───────────────────────────────────────────────
  _idle(blend = 0.35) {
    if (this.crouching) {
      this._setState(S.CROUCH_IDLE);
      this.anim.play('Crouch_Idle_Loop', true, blend);
    } else {
      this._setState(S.IDLE);
      this.anim.play('Locomotion', true, blend);
    }
  }

  // ── RETURN TO LOCOMOTION (INTELLIGENT DECISION) ──────────
  _returnToLoco(blend = 0.35) {
    const finalBlend = blend / this.SPEED_MULTIPLIER;
    // Check if there is movement input
    let inputX = 0;
    let inputZ = 0;

    if (this._isPressed('MOVE_FORWARD')) inputZ += 1;
    if (this._isPressed('MOVE_BACKWARD')) inputZ -= 1;
    if (this._isPressed('MOVE_RIGHT')) inputX += 1;
    if (this._isPressed('MOVE_LEFT')) inputX -= 1;

    if (this.isTouch && (Math.abs(this.touchVector.x) > 0.01 || Math.abs(this.touchVector.y) > 0.01)) {
      inputX = this.touchVector.x;
      inputZ = this.touchVector.y;
    }

    const isSprinting = this.sprinting;
    const hasMove = Math.sqrt(inputX * inputX + inputZ * inputZ) > 0.15;

    if (hasMove) {
      this._updateLocoAnim(true, isSprinting, inputZ < -0.2, finalBlend);
    } else {
      this._idle(finalBlend);
    }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(s);
    } else {
      const hudState = document.getElementById('hud-state');
      if (hudState) {
        hudState.textContent = s;
      }
    }
  }

  _isInAction() {
    const LOCO_STATES = new Set(['IDLE', 'WALK', 'JOG', 'SPRINT', 'WALK_FORMAL', 'CROUCH_IDLE', 'CROUCH_WALK', 'CROUCH_RUN', 'JUMP_START', 'JUMP_LOOP', 'JUMP_LAND']);
    return ACTION_STATES.has(this.state) || (!LOCO_STATES.has(this.state) && this.state !== 'NONE');
  }

  // ── CAMERA HELPERS ─────────────────────────────────────
  _camForward() {
    const f = this.camera.target.subtract(this.camera.position);
    f.y = 0;
    if (f.length() < 0.001) return new BABYLON.Vector3(0, 0, 1);
    f.normalize();
    return f;
  }
  _camRight(fwd) {
    return BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), fwd).normalize();
  }

  // ── RAYCAST GROUND DETECT ──────────────────────────────
  _checkGrounded() {
    // Ray origin: derived from the ACTUAL current capsule/ellipsoid bottom so that the ray
    // stays consistent during the smooth crouch transition (ellipsoid lerps slowly at rate 4).
    // Using a hardcoded offset that flips instantly while the shape is still transitioning
    // causes a 1-frame miss → grounded=false → unwanted fall state.
    let originYOffset;
    if (this.usePhysics) {
      // For Havok the shape switches instantly; use the assigned shape bottom.
      const usingCrouchShape = this._crouchShape && this.physicsBody && this.physicsBody.shape === this._crouchShape;
      originYOffset = usingCrouchShape ? -0.62 : -0.82;
    } else {
      // For kinematic, read the LIVE ellipsoid.y so the offset tracks the smooth lerp transition.
      // ellipsoid.y is the half-height; capsule bottom = -ellipsoid.y + ellipsoidOffset.y
      const liveHalfH = this.root.ellipsoid ? this.root.ellipsoid.y : this._standEllipsoidY;
      const liveOffY = this.root.ellipsoidOffset ? this.root.ellipsoidOffset.y : 0;
      // Place ray origin 0.08m above the actual capsule bottom to avoid starting inside the ground
      originYOffset = -(liveHalfH) + liveOffY + 0.08;
    }

    // Use a longer ray length on stairs/ramps (scalable meshes) or when rolling to bridge drops and prevent micro-airborne jitter.
    // On flat ground, we use a tight ray (0.20m in kinematic, 0.26m in physics) so that the character snaps instantly and never floats.
    // _wasOnScalable persists the extended ray one extra frame so descending a ramp/stair edge doesn't miss.
    // Add a small extra buffer (0.12m) while crouching is active to absorb the transition frames where
    // the ellipsoid hasn't fully settled yet and the ray might otherwise just miss the ground.
    const baseRayLen = this.usePhysics ? 0.36 : 0.28;
    const crouchBuffer = this.crouching ? 0.12 : 0;
    const rayLen = (this.onScalable || this._wasOnScalable || this.state === S.ROLL) ? 0.55 : (baseRayLen + crouchBuffer);
    const downDir = new BABYLON.Vector3(0, -1, 0);

    const radius = 0.22; // Slightly inset from capsule width of 0.35
    const offsets = [
      new BABYLON.Vector3(0, originYOffset, 0),         // Center
      new BABYLON.Vector3(0, originYOffset, radius),    // Forward
      new BABYLON.Vector3(0, originYOffset, -radius),   // Backward
      new BABYLON.Vector3(-radius, originYOffset, 0),   // Left
      new BABYLON.Vector3(radius, originYOffset, 0)     // Right
    ];

    let hitAny = false;
    let onScalable = false;
    this.onStairs = false;

    for (const offset of offsets) {
      const rayStart = this.root.position.add(offset);
      const ray = new BABYLON.Ray(rayStart, downDir, rayLen);
      const pick = this.scene.pickWithRay(ray, (mesh) => {
        // Only collide with environment meshes
        return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
      });

      if (pick && pick.hit) {
        hitAny = true;
        this._groundNormal = pick.getNormal(true);
        const name = pick.pickedMesh.name || "";
        this.onStairs = /step|stair/i.test(name);
        // Check if mesh is marked, matches step/stair naming patterns, or has sloped surface normals
        if (pick.pickedMesh.meshType === "scalable" ||
          (name && /step|stair|ramp|platform|floor/i.test(name))) {
          onScalable = true;
        } else {
          const normal = this._groundNormal;
          if (normal && normal.y < 0.99 && normal.y > 0.5) {
            onScalable = true;
          }
        }
        break;
      }
    }

    if (!hitAny) {
      this._groundNormal = null;
    }

    this._wasOnScalable = this.onScalable;
    this.onScalable = onScalable;
    return hitAny;
  }

  _isCeilingBlocked() {
    let rayStart, rayLen;
    if (this.usePhysics) {
      // Start raycast just below the top of the crouched head (0.60m above capsule center)
      rayStart = this.root.position.add(new BABYLON.Vector3(0, 0.60, 0));
      // Ray length needs to reach the standing height (1.80m) plus clearance margin
      rayLen = 0.65;
    } else {
      // Start raycast at the bottom of the feet (ground level) instead of the capsule center
      // to avoid starting the ray inside/above a low ceiling, which would fail to detect it.
      rayStart = this.root.position.add(new BABYLON.Vector3(0, -0.9, 0));
      // Ray length needs to reach the full standing height (2 * ellipsoidY = 1.92m) plus clearance margin
      rayLen = (this._standEllipsoidY * 2.0) + 0.1;
    }

    const upDir = new BABYLON.Vector3(0, 1, 0);
    const ray = new BABYLON.Ray(rayStart, upDir, rayLen);
    const pick = this.scene.pickWithRay(ray, (mesh) => {
      return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
    });

    return !!(pick && pick.hit);
  }

  _canUncrouch() {
    if (!this.crouching) return true;
    return !this._isCeilingBlocked();
  }

  // ── UPDATE ─────────────────────────────────────────────
  _update() {
    const dt = this.scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0 || dt > 0.1) return;
    this.stateT += dt;
    this._timeSinceSpawn += dt;

    // Freeze camera vectors during mouse orbit dragging under standard camera mode
    // to allow the character to keep their world direction and let the user look at their face.
    if (this._pointerDragging && !this.CAM_FOLLOW_LOCK) {
      if (!this._frozenCamFwd) {
        this._frozenCamFwd = this._camForward();
        this._frozenCamRgt = this._camRight(this._frozenCamFwd);
      }
    } else {
      this._frozenCamFwd = null;
      this._frozenCamRgt = null;
    }

    const currentVelocity = this.usePhysics ? this.physicsBody.getLinearVelocity() : null;

    // Automatic uncrouch if we were forced to crouch after a roll and are now clear of obstacles
    if (this._forcedCrouchFromRoll && this.crouching) {
      if (!this._isCeilingBlocked()) {
        this.crouching = false;
        this._forcedCrouchFromRoll = false;
        this._returnToLoco(0.2);
      }
    }

    // Input Gathering (Supports Keyboard & Mobile Analog Touch) - Calculated early for landing checks
    let inputX = 0;
    let inputZ = 0;

    if (this._isPressed('MOVE_FORWARD')) inputZ += 1;
    if (this._isPressed('MOVE_BACKWARD')) inputZ -= 1;
    if (this._isPressed('MOVE_RIGHT')) inputX += 1;
    if (this._isPressed('MOVE_LEFT')) inputX -= 1;

    if (this.isTouch && (Math.abs(this.touchVector.x) > 0.01 || Math.abs(this.touchVector.y) > 0.01)) {
      inputX = this.touchVector.x;
      inputZ = this.touchVector.y;
    }

    const isSprinting = this.sprinting;
    const inputMag = Math.min(1.0, Math.sqrt(inputX * inputX + inputZ * inputZ));
    const hasMove = inputMag > 0.15;

    // Probing Ground via Raycasting (bypass when rising from a jump)
    const wasGrounded = this.grounded;
    const isJumpingState = this.state === S.JUMP_START || this.state === S.JUMP_LOOP;
    if (this.usePhysics) {
      if (this.jumpVel > 0.1 || (isJumpingState && currentVelocity.y > 0.1)) {
        this.grounded = false;
      } else {
        const rayGrounded = this._checkGrounded();
        // Havok on ramps/stairs can briefly bounce the capsule above the ray reach.
        // Treat as grounded if: ray hit, OR Havok Y velocity is near-zero and we
        // were grounded very recently (within 3 frames) — prevents false airborne on bumpy surfaces.
        if (rayGrounded) {
          this.grounded = true;
          this._lastGroundedFrame = 0;
        } else {
          this._lastGroundedFrame = (this._lastGroundedFrame || 0) + 1;
          // Buffer only for ramp/stair micro-bounce — never during jump states.
          // Increased velocity threshold from 1.5 to 3.5 to prevent losing grounding while sprinting down slopes.
          this.grounded = !isJumpingState && (this._lastGroundedFrame <= 2) && Math.abs(currentVelocity.y) < 3.5;
        }
      }
    } else {
      if (this.jumpVel > 0.1) {
        this.grounded = false;
      } else {
        this.grounded = this._checkGrounded();
      }
    }

    // Landing / roll recovery
    let landingTriggered = false;
    let _snapVelY = 0;
    if (this.grounded && !wasGrounded) {
      landingTriggered = true;
      this._hasDoubleJumped = false; // Reset double jump!
      const fallHeight = this._highestAirborneY - this.root.position.y;
      const fallingVel = this.usePhysics ? currentVelocity.y : this.jumpVel;
      const isInitialSpawn = this._timeSinceSpawn < 0.5;

      if (isInitialSpawn) {
        // Quietly settle character without emitting landing dust or playing landing camera shakes/anims
        this._rollOnLand = false;
        this._returnToLoco();
      } else if (this.state === S.ROLL) {
        this._emitLandingDust();
        if (!this._rollActive) {
          this._returnToLoco(0.06);
        }
      } else if (this._rollOnLand && this.speed > 1.0) {
        this._rollOnLand = false;
        this._emitLandingDust();
        this._roll();
      } else if (fallingVel < -3.0 && fallHeight > 0.4) {
        this._rollOnLand = false;
        this._setState(S.JUMP_LAND);
        this.anim.play('Jump_Land', false, 0.15, () => this._returnToLoco(), 1.35);
        this.speed *= 0.15;
        this._emitLandingDust();
      } else {
        this._rollOnLand = false;
        this._returnToLoco();
      }
    } else if (this.grounded && (this.state === S.JUMP_START || this.state === S.JUMP_LOOP || (this.state === S.JUMP_LAND && hasMove && this.stateT > 0.15))) {
      this._returnToLoco();
    }

    // Track consecutive airborne time and maximum height reached
    if (!this.grounded) {
      this._airborneTime += dt;
      this._highestAirborneY = Math.max(this._highestAirborneY, this.root.position.y);
    } else {
      this._lastAirborneTime = this._airborneTime;
      this._airborneTime = 0;
      this._highestAirborneY = this.root.position.y;
    }

    let inAction = this._isInAction();

    // Ledge snap push: if we just lost grounding while moving and did not jump or roll, push down to snap to flat floor immediately and avoid floating
    if (!this.grounded && wasGrounded && this.state !== S.JUMP_START && this.state !== S.JUMP_LOOP && this.state !== S.ROLL) {
      if (this.usePhysics) {
        if (!this._wasClimbingStep) {
          const isTempStandingAction = inAction && (this.state === S.SPELL_ENTER || this.state === S.SPELL_SHOOT || this.state === S.SPELL_EXIT || this.state === S.INTERACT);
          const useCrouchHeight = (this.crouching && !isTempStandingAction) || this.state === S.ROLL;
          const originYOffset = useCrouchHeight ? -0.65 : -0.85;
          const snapRayStart = this.root.position.add(new BABYLON.Vector3(0, originYOffset, 0));
          const snapRay = new BABYLON.Ray(snapRayStart, new BABYLON.Vector3(0, -1, 0), 0.5);
          const snapPick = this.scene.pickWithRay(snapRay, (mesh) => {
            return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
          });
          if (snapPick && snapPick.hit) {
            _snapVelY = -2.5;
          }
        }
      } else {
        this.jumpVel = -4.0;
      }
    }

    // Let the roll animation play to completion naturally via its callback

    // ── PROCESS VERTICAL PHYSICS (GRAVITY & JUMPING) ───────
    if (this.usePhysics) {
      if (this.grounded) {
        if (currentVelocity.y <= 0.1) {
          const deltaY = this.root.position.y - (this._lastY !== undefined ? this._lastY : this.root.position.y);
          if (deltaY > 0.005) {
            const inAction = this._isInAction();
            if (this.grounded && hasMove && !this.onScalable && !inAction) {
              this._setState(S.JUMP_LAND);
              this.anim.play('Jump_Land', false, 0.1, () => this._returnToLoco(), 1.65, 0.25);
              this._emitLandingDust();
            }
          } else {
            if (hasMove && this.onScalable) {
              _snapVelY = -1.5;
            }
          }
        }
      }
    } else {
      if (!this.grounded) {
        this.jumpVel -= this.GRAV * dt;
        if (this.jumpVel < -25) this.jumpVel = -25; // Clamp terminal velocity

        // Fall detection: transition to JUMP_LOOP when falling off platforms.
        // Requires 0.35s airborne so stair-step ledge snaps (resolve in <0.1s) don't trigger fall animation.
        if (this.jumpVel < -3.5 && this.state !== S.JUMP_START && this.state !== S.JUMP_LOOP && !inAction && this._airborneTime > 0.35) {
          this._setState(S.JUMP_LOOP);
          this.anim.play('Jump_Loop', true, 0.3);
        }
      } else {
        // Resolve vertical velocity when grounded to eliminate collision jitter
        if (this.jumpVel <= 0) {
          // Track capsule Y delta to detect if we are currently climbing up steps/slopes
          const deltaY = this.root.position.y - (this._lastY !== undefined ? this._lastY : this.root.position.y);

          if (deltaY > 0.005) {
            // If collision response is pushing us UP the steps, do not apply downward snap pressure!
            this.jumpVel = 0;

            // Detect single step climbing:
            // Must be grounded, moving forward/input active, NOT on stairs/ramps (onScalable is false),
            // and not already performing another action.
            const inAction = this._isInAction();
            if (this.grounded && hasMove && !this.onScalable && !inAction) {
              this._setState(S.JUMP_LAND);
              // Play JUMP_LAND animation with a lower weight (0.35) for a subtler, more natural step-up blend
              this.anim.play('Jump_Land', false, 0.1, () => this._returnToLoco(), 1.65, 0.25);
              this._emitLandingDust();
            }
          } else {
            // Snap down on flat ground always (settles after jump); on scalable only when moving (prevents ramp sliding)
            this.jumpVel = this.onScalable && !hasMove ? 0 : -3.5;
          }
        }
      }
    }

    // ── PROCESS CROUCHING / ROLLING COLLISION HEIGHT ADJUSTMENTS ─────
    // If we are performing a standing action (like spell casting or interacting) while crouching,
    // we temporarily restore standing collision bounds and target height so that the character stands properly.
    const isTempStandingAction = inAction && (this.state === S.SPELL_ENTER || this.state === S.SPELL_SHOOT || this.state === S.SPELL_EXIT || this.state === S.INTERACT);
    const useCrouchHeight = (this.crouching && !isTempStandingAction) || this.state === S.ROLL;

    if (this.usePhysics) {
      const activeShape = useCrouchHeight ? this._crouchShape : this._standShape;
      const prevTargetLocalY = this.targetLocalY;
      if (useCrouchHeight) {
        this.targetLocalY = -0.90 - (this.crouching ? 0.08 : 0); // Crouch shape bottom aligns with -0.90
      } else {
        this.targetLocalY = -0.90; // Stand shape bottom is at -0.90
      }

      if (this.physicsBody.shape !== activeShape) {
        this.physicsBody.shape = activeShape;
        this.physicsBody.setMassProperties({
          mass: 1,
          inertia: new BABYLON.Vector3(0, 0, 0)
        });

        // Instantly offset the visual mesh local Y position to compensate for the instant physics body origin shift.
        // This prevents the visual mesh from popping/jumping during shape transitions.
        const shift = this.targetLocalY - prevTargetLocalY;
        this.visualLocalY += shift;
        this.visualMesh.position.y = this.visualLocalY;

        // When switching to the crouchShape the capsule bottom rises and Havok can
        // momentarily lift the body away from the ground, causing _checkGrounded() to miss
        // for 1-2 frames and triggering a spurious JUMP_LOOP fall state.
        // Snap it back down with a small downward impulse so the body stays grounded.
        if (useCrouchHeight && this.grounded) {
          const cv = this.physicsBody.getLinearVelocity();
          this.physicsBody.setLinearVelocity(new BABYLON.Vector3(cv.x, -2.5, cv.z));
        }
      }
    } else {
      const targetEllipsoidY = useCrouchHeight ? this._crouchEllipsoidY : this._standEllipsoidY;
      const targetOffset = useCrouchHeight ? -(this._standEllipsoidY - this._crouchEllipsoidY) : 0;
      // Keep the ellipsoid width constant to avoid clipping/penetration bugs
      const targetEllipsoidWidth = this._standEllipsoidWidth;

      if (isTempStandingAction) {
        this.targetLocalY = this._standMeshY;
      }

      // Calculate forward/backward locomotion offset direction based on follow lock state
      const isMovingBackward = this.CAM_FOLLOW_LOCK && (this._isPressed('MOVE_BACKWARD') || (this.isTouch && this.touchVector.y < -0.2));
      const localMoveSign = isMovingBackward ? -1 : 1;

      // Raycast to detect obstacles in the offset direction (forward or backward) to prevent pushing the ellipsoid into walls/stairs
      let safeMaxOffsetZ = 0.22;
      const facingDir = new BABYLON.Vector3(Math.sin(this.rotY), 0, Math.cos(this.rotY));
      const rayDir = facingDir.scale(localMoveSign);

      // Calculate heights dynamically based on the current ellipsoid geometry to ensure accurate checks while crouching or rolling
      const currentCenterY = this.root.ellipsoidOffset ? this.root.ellipsoidOffset.y : 0;
      const currentHalfHeight = this.root.ellipsoid ? this.root.ellipsoid.y : 0.96;

      // Check at top (head), center (waist), and bottom (feet) of the active ellipsoid volume
      const heights = [
        currentCenterY + currentHalfHeight * 0.7,
        currentCenterY,
        currentCenterY - currentHalfHeight * 0.7
      ];
      const margin = 0.05;

      for (const h of heights) {
        const rayStart = this.root.position.add(new BABYLON.Vector3(0, h, 0));
        const pick = this.scene.pickWithRay(new BABYLON.Ray(rayStart, rayDir, 1.0), (mesh) => {
          return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
        });
        if (pick && pick.hit) {
          const availableSpace = Math.max(0, pick.distance - this._standEllipsoidWidth - margin);
          safeMaxOffsetZ = Math.min(safeMaxOffsetZ, availableSpace);
        }
      }

      // Scale offset based on speed ratio and the safe maximum offset
      const targetOffsetZ = (this.speed / this.SPD_SPRINT) * safeMaxOffsetZ * localMoveSign;
      this.localOffsetZ = lerp(this.localOffsetZ || 0, targetOffsetZ, 1 - Math.exp(-4 * dt));

      // Instant safety clamp: ensure the active offset never exceeds the physical space detected in this frame
      this.localOffsetZ = Math.max(-safeMaxOffsetZ, Math.min(safeMaxOffsetZ, this.localOffsetZ));

      // Smoothly interpolate collision ellipsoid size & offset to prevent sudden camera/physics glitches (slowed down to 4 for premium fluid feel)
      if (this.root.ellipsoid) {
        this.root.ellipsoid.y = lerp(this.root.ellipsoid.y, targetEllipsoidY, 1 - Math.exp(-4 * dt));
        this.root.ellipsoidOffset.y = lerp(this.root.ellipsoidOffset.y, targetOffset, 1 - Math.exp(-4 * dt));

        // Transform local Z offset to world space based on character rotation (Y-axis)
        this.root.ellipsoidOffset.x = this.localOffsetZ * Math.sin(this.rotY);
        this.root.ellipsoidOffset.z = this.localOffsetZ * Math.cos(this.rotY);

        const newWidth = lerp(this.root.ellipsoid.x, targetEllipsoidWidth, 1 - Math.exp(-4 * dt));
        this.root.ellipsoid.x = newWidth;
        this.root.ellipsoid.z = newWidth;
      }
    }

    // ── PROCESS HORIZONTAL PHYSICS (LOCOMOTION) ────────────
    let dir = new BABYLON.Vector3(0, 0, 0);

    const canMove = !inAction || this.state === S.JUMP_START || this.state === S.JUMP_LOOP || this.state === S.JUMP_LAND;
    if (canMove && !this.sitting) {
      if (this.CAM_FOLLOW_LOCK) {
        if (!this.grounded && !this.AIR_CONTROL) {
          // Zero steering in mid-air under follow lock: keep momentum direction and takeoff speed
          dir = this.moveDir;
        } else {
          // ── DIRECT KEYBOARD/ANALOG STEERING ────────────────
          // 1. A/D rotates the character; observer pushes camera.alpha to match rotY
          if (inputX !== 0) {
            const steerSpeed = 2.8 * this.SPEED_MULTIPLIER; // Radians per second
            this.rotY += inputX * steerSpeed * dt;
            if (this.usePhysics) {
              this.root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(this.rotY, 0, 0);
            } else {
              this.root.rotation.y = this.rotY;
            }
          }

          // 2. W/S moves forward/backward relative to character heading
          if (inputZ !== 0) {
            dir = new BABYLON.Vector3(Math.sin(this.rotY), 0, Math.cos(this.rotY)).normalize();
            if (inputZ < 0) dir.scaleInPlace(-1);
          }

          // 3. Direct Target Speed (only W/S drives physical movement speed)
          let tgt = 0;
          if (inputZ !== 0) {
            if (this.crouching) {
              tgt = isSprinting ? this.SPD_CROUCH_RUN : this.SPD_CROUCH;
            } else if (isSprinting) {
              tgt = this.SPD_SPRINT;
            } else {
              tgt = this.SPD_WALK;
            }
            tgt *= Math.abs(inputZ) * this.SPEED_MULTIPLIER;
          }

          const rate = inputZ !== 0 ? this.ACCEL : this.DECEL;
          this.speed = lerp(this.speed, tgt, 1 - Math.exp(-rate * dt));
          if (this.speed < 0.05) this.speed = 0;
        }
      } else {
        // ── STANDARD CAMERA-RELATIVE LOCOMOTION ────────────
        const camFwd = this._camForward();
        const camRgt = this._camRight(camFwd);
        const fwd = (this._frozenCamFwd && !this.CAM_FOLLOW_LOCK) ? this._frozenCamFwd : camFwd;
        const rgt = (this._frozenCamRgt && !this.CAM_FOLLOW_LOCK) ? this._frozenCamRgt : camRgt;

        if (!this.grounded) {
          // Air control logic:
          if (this.AIR_CONTROL) {
            // Full steering in mid-air:
            if (hasMove) {
              dir = rgt.scale(inputX).add(fwd.scale(inputZ));
              if (dir.length() > 0.01) dir.normalize();
            }

            let tgtSpeed = this.speed;
            if (hasMove) {
              let idealTgt = (isSprinting ? this.SPD_SPRINT : this.SPD_WALK) * this.SPEED_MULTIPLIER;
              idealTgt *= inputMag;
              tgtSpeed = lerp(this.speed, idealTgt, 1 - Math.exp(-this.ACCEL * dt));
            } else {
              tgtSpeed = lerp(this.speed, 0, 1 - Math.exp(-this.DECEL * dt));
            }
            this.speed = tgtSpeed;
          } else {
            // Zero steering in mid-air: keep momentum direction and takeoff speed
            dir = this.moveDir;
          }
        } else {
          // Standard grounded logic:
          if (hasMove) {
            dir = rgt.scale(inputX).add(fwd.scale(inputZ));
            if (dir.length() > 0.01) dir.normalize();
          }

          // Target Speed calculation
          let tgt = 0;
          if (hasMove) {
            if (this.crouching) {
              tgt = isSprinting ? this.SPD_CROUCH_RUN : this.SPD_CROUCH;
            } else if (isSprinting) {
              tgt = this.SPD_SPRINT;
            } else {
              tgt = this.SPD_WALK;
            }

            // Analog speed modifier
            tgt *= inputMag * this.SPEED_MULTIPLIER;

            // Slope / Stairs speed modifier (Dynamic effort scaling)
            const deltaY = this.root.position.y - (this._lastY !== undefined ? this._lastY : this.root.position.y);
            if (deltaY > 0.003) {
              // Climbing up: reduce speed based on steepness (up to 22%)
              const climbEffort = Math.min(0.22, (deltaY / dt) * 0.15);
              tgt *= (1.0 - climbEffort);
            } else if (deltaY < -0.003) {
              // Descending: increase speed slightly (up to 8%)
              const fallPull = Math.min(0.08, (-deltaY / dt) * 0.08);
              tgt *= (1.0 + fallPull);
            }
          }

          const rate = hasMove ? this.ACCEL : this.DECEL;
          this.speed = lerp(this.speed, tgt, 1 - Math.exp(-rate * dt));
          if (this.speed < 0.05) this.speed = 0;
        }
      }

      // Smooth target angle before rotating to kill camera micro-jitter
      // (Only rotate character if moving or steering in mid-air with some air control)
      const shouldRotate = !this.CAM_FOLLOW_LOCK && hasMove && dir.length() > 0.05 && (this.grounded || this.AIR_CONTROL > 0.05);
      if (shouldRotate) {
        const tgtAngle = Math.atan2(dir.x, dir.z);
        if (this._smoothTgt === undefined) this._smoothTgt = tgtAngle;
        this._smoothTgt = lerpAngle(this._smoothTgt, tgtAngle, 1 - Math.exp(-30 * dt));
        const k = (this.grounded ? (this.ROT_SPD * 0.16) : (this.ROT_SPD * 0.08)) * this.SPEED_MULTIPLIER;
        this.rotY = lerpAngle(this.rotY, this._smoothTgt, 1 - Math.exp(-k * dt));
        if (this.usePhysics) {
          this.root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(this.rotY, 0, 0);
        } else {
          this.root.rotation.y = this.rotY;
        }
      }

      // Wall detection: check if there is an obstacle directly in front at an unclimbable height
      let wallNormal = null;
      if (hasMove && dir.length() > 0.01) {
        // Ray starts 0.45m above feet (feet is at -0.96 relative to capsule center, so -0.51 relative to center)
        const rayStart = this.root.position.add(new BABYLON.Vector3(0, -0.51, 0));
        const rayDist = this._standEllipsoidWidth + 0.15; // slightly ahead of capsule edge
        const ray = new BABYLON.Ray(rayStart, dir, rayDist);
        const pick = this.scene.pickWithRay(ray, (mesh) => {
          return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
        });
        if (pick && pick.hit) {
          wallNormal = pick.getNormal(true);
        }
      }

      // Project movement direction onto the wall plane if a wall is encountered
      if (wallNormal) {
        wallNormal.y = 0;
        wallNormal.normalize();
        const dot = BABYLON.Vector3.Dot(dir, wallNormal);
        if (dot < 0) { // Moving towards/into the wall
          dir.subtractInPlace(wallNormal.scale(dot));
          if (dir.length() > 0.01) {
            dir.normalize();
          } else {
            dir.set(0, 0, 0);
          }
        }
      }

      if (this.usePhysics) {
        // Step climbing detection
        let stepClimbVelY = 0;
        if ((this.grounded || this._wasClimbingStep) && hasMove && dir.length() > 0.01) {
          // Ray starting 0.05m above feet (bottom of capsule is -0.9, so -0.85 relative to center)
          const lowRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.85, 0));
          const rayDist = 0.7; // slightly ahead of capsule edge (radius 0.35 + margin 0.35)
          const lowRay = new BABYLON.Ray(lowRayStart, dir, rayDist);
          const lowPick = this.scene.pickWithRay(lowRay, (mesh) => {
            return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
          });

          if (lowPick && lowPick.hit) {
            // Check high ray at step limit height (0.50m above bottom, so -0.40 relative to center)
            const highRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.40, 0));
            const highRay = new BABYLON.Ray(highRayStart, dir, rayDist);
            const highPick = this.scene.pickWithRay(highRay, (mesh) => {
              return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
            });

            // If the low obstacle is hit, but not the high one, we can climb it!
            if (!highPick || !highPick.hit) {
              stepClimbVelY = 2.0; // Apply upward step velocity to slide onto the step
            }
          }
        }

        // Apply linear velocity to the Havok PhysicsBody!
        let velocity = new BABYLON.Vector3(dir.x * this.speed, 0, dir.z * this.speed);

        if (this.grounded && this._groundNormal) {
          // Project movement direction onto the ground slope plane for smooth movement
          const dot = BABYLON.Vector3.Dot(dir, this._groundNormal);
          const slopeDir = dir.subtract(this._groundNormal.scale(dot));
          if (slopeDir.length() > 0.01) {
            slopeDir.normalize();
            velocity.set(slopeDir.x * this.speed, slopeDir.y * this.speed, slopeDir.z * this.speed);
          }
        }

        let targetY = velocity.y;
        if (this.jumpVel > 0.1) {
          targetY = this.jumpVel;
          this.jumpVel = 0;
        } else if (stepClimbVelY !== 0) {
          targetY = stepClimbVelY;
        } else if (_snapVelY !== 0) {
          targetY = _snapVelY;
        } else if (!this.grounded) {
          targetY = currentVelocity.y;
        } else if (currentVelocity.y < -1.0) {
          // Havok still falling despite grounded ray hit — capsule bouncing above surface.
          // Don't zero Y — let Havok pull it down to true contact.
          targetY = currentVelocity.y;
        }

        this.physicsBody.setLinearVelocity(new BABYLON.Vector3(velocity.x, targetY, velocity.z));
        this._wasClimbingStep = (stepClimbVelY !== 0);
      } else {
        // Move the Capsule using collisions!
        const horizontalDisplacement = dir.scale(this.speed * dt);
        const verticalDisplacement = new BABYLON.Vector3(0, this.jumpVel * dt, 0);
        const totalDisplacement = horizontalDisplacement.add(verticalDisplacement);

        this.root.moveWithCollisions(totalDisplacement);
      }

      if (this.speed > 0) {
        this.moveDir.copyFrom(dir);
      }
    } else if (this.state === S.ROLL) {
      if (this.usePhysics) {
        // Step climbing detection during roll
        let stepClimbVelY = 0;
        if (this._rollMoving && (this.grounded || this._wasClimbingStep)) {
          const lowRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.85, 0));
          const rayDist = 0.7; // slightly ahead of capsule edge (radius 0.35 + margin 0.35)
          const lowRay = new BABYLON.Ray(lowRayStart, this._rollDir, rayDist);
          const lowPick = this.scene.pickWithRay(lowRay, (mesh) => {
            return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
          });

          if (lowPick && lowPick.hit) {
            const highRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.40, 0));
            const highRay = new BABYLON.Ray(highRayStart, this._rollDir, rayDist);
            const highPick = this.scene.pickWithRay(highRay, (mesh) => {
              return mesh.checkCollisions && mesh !== this.root && !this.root.getChildMeshes().includes(mesh);
            });

            if (!highPick || !highPick.hit) {
              stepClimbVelY = 2.0; // Apply upward step velocity to slide onto the step
            }
          }
        }
        this._wasClimbingStep = (stepClimbVelY !== 0);

        // Project roll direction onto the ground slope normal for smooth slope traversal
        let rollVelocity = new BABYLON.Vector3(this._rollDir.x * this.speed, 0, this._rollDir.z * this.speed);
        let dot = 0;
        if (this.grounded && this._groundNormal) {
          dot = BABYLON.Vector3.Dot(this._rollDir, this._groundNormal);
          const slopeDir = this._rollDir.subtract(this._groundNormal.scale(dot));
          if (slopeDir.length() > 0.01) {
            slopeDir.normalize();
            rollVelocity.set(slopeDir.x * this.speed, slopeDir.y * this.speed, slopeDir.z * this.speed);
          }
        }

        let targetY = rollVelocity.y;
        if (!this.grounded) {
          targetY = currentVelocity.y;
        } else {
          if (this.jumpVel > 0.1) {
            targetY = this.jumpVel;
            this.jumpVel = 0;
          } else if (stepClimbVelY !== 0) {
            targetY = stepClimbVelY;
          } else if (_snapVelY !== 0) {
            targetY = _snapVelY;
          } else if (this.onScalable) {
            if (dot < -0.01) {
              // Rolling up: rely on the slope projected Y velocity
              targetY = rollVelocity.y;
            } else if (dot > 0.01) {
              // Rolling down: add gentle downward snap pressure
              targetY = rollVelocity.y - 1.5;
            } else {
              targetY = -1.5;
            }
          } else {
            // Flat ground snap
            targetY = -4.0;
          }
        }

        if (this._rollMoving) {
          // Steer roll direction mid-air when AIR_CONTROL is enabled
          if (!this.grounded && this.AIR_CONTROL && (inputX !== 0 || inputZ !== 0)) {
            const camFwd = this._camForward();
            const airDir = this._camRight(camFwd).scale(inputX).add(camFwd.scale(inputZ));
            if (airDir.length() > 0.01) {
              airDir.normalize();
              BABYLON.Vector3.LerpToRef(this._rollDir, airDir, 1 - Math.exp(-4 * dt), this._rollDir);
            }
            // Update rollVelocity since _rollDir changed
            if (this.grounded && this._groundNormal) {
              const airDot = BABYLON.Vector3.Dot(this._rollDir, this._groundNormal);
              const slopeDir = this._rollDir.subtract(this._groundNormal.scale(airDot));
              if (slopeDir.length() > 0.01) {
                slopeDir.normalize();
                rollVelocity.set(slopeDir.x * this.speed, slopeDir.y * this.speed, slopeDir.z * this.speed);
              }
            } else {
              rollVelocity.set(this._rollDir.x * this.speed, 0, this._rollDir.z * this.speed);
            }
          }
          this.physicsBody.setLinearVelocity(new BABYLON.Vector3(rollVelocity.x, targetY, rollVelocity.z));
        } else {
          this.physicsBody.setLinearVelocity(new BABYLON.Vector3(0, targetY, 0));
        }
      } else {
        // Project roll direction onto slope in kinematic mode
        let rollVelocity = this._rollDir.scale(this.speed);
        let dot = 0;
        if (this.grounded && this._groundNormal) {
          dot = BABYLON.Vector3.Dot(this._rollDir, this._groundNormal);
          const slopeDir = this._rollDir.subtract(this._groundNormal.scale(dot));
          if (slopeDir.length() > 0.01) {
            slopeDir.normalize();
            rollVelocity = slopeDir.scale(this.speed);
          }
        }

        let snapDown = 0;
        if (this.grounded) {
          if (this.onScalable) {
            if (dot < -0.01) {
              // Rolling up: no downward snap (let it climb naturally)
              snapDown = 0;
            } else if (dot > 0.01) {
              // Rolling down: snap down to keep glued
              snapDown = -3.5;
            } else {
              snapDown = -1.5;
            }
          } else {
            snapDown = -3.0; // Flat ground snap
          }
        } else {
          snapDown = this.jumpVel;
        }

        const vert = new BABYLON.Vector3(0, snapDown * dt, 0);
        if (this._rollMoving) {
          // Steer roll direction mid-air when AIR_CONTROL is enabled
          if (!this.grounded && this.AIR_CONTROL && (inputX !== 0 || inputZ !== 0)) {
            const camFwd = this._camForward();
            const airDir = this._camRight(camFwd).scale(inputX).add(camFwd.scale(inputZ));
            if (airDir.length() > 0.01) {
              airDir.normalize();
              BABYLON.Vector3.LerpToRef(this._rollDir, airDir, 1 - Math.exp(-4 * dt), this._rollDir);
            }
            // Update rollVelocity since _rollDir changed
            if (this.grounded && this._groundNormal) {
              const airDot = BABYLON.Vector3.Dot(this._rollDir, this._groundNormal);
              const slopeDir = this._rollDir.subtract(this._groundNormal.scale(airDot));
              if (slopeDir.length() > 0.01) {
                slopeDir.normalize();
                rollVelocity = slopeDir.scale(this.speed);
              }
            } else {
              rollVelocity = this._rollDir.scale(this.speed);
            }
          }
          this.root.moveWithCollisions(rollVelocity.scale(dt).add(vert));
        } else {
          this.root.moveWithCollisions(vert);
        }
      }
    } else {
      // For other action states (e.g. casting spells, punching, interacting) where horizontal movement is disabled:
      // We must explicitly stop horizontal movement in Havok physics mode to prevent sliding,
      // while still preserving vertical gravity/physics.
      if (this.usePhysics) {
        let targetY = this.grounded ? -4.0 : currentVelocity.y;
        if (this.jumpVel > 0.1) {
          targetY = this.jumpVel;
          this.jumpVel = 0;
        } else if (_snapVelY !== 0) {
          targetY = _snapVelY;
        }
        this.physicsBody.setLinearVelocity(new BABYLON.Vector3(0, targetY, 0));
        this._wasClimbingStep = false;
      }
      this.speed = 0; // Ensure speed is reset to 0 during non-movement actions
    }

    // Teleport back if character falls out of bounds
    if (this.root.position.y < -15) {
      if (this.usePhysics) {
        this.physicsBody.disablePreStep = false;
        this.root.position.copyFrom(new BABYLON.Vector3(0, 1.2, 0));
        this.root.rotationQuaternion = BABYLON.Quaternion.Identity();
        this.rotY = 0;
        this.jumpVel = 0;
        this.speed = 0;
        this.physicsBody.setLinearVelocity(BABYLON.Vector3.Zero());
        this.physicsBody.setAngularVelocity(BABYLON.Vector3.Zero());
      } else {
        this.root.position.copyFrom(new BABYLON.Vector3(0, 1.2, 0));
        this.root.rotation.y = 0;
        this.rotY = 0;
        this.jumpVel = 0;
        this.speed = 0;
      }
    }

    // ── UPDATE LOCOMOTION ANIMATIONS ──────────────────────
    const canLoco = !inAction;
    if (canLoco && !this.sitting) {
      const activeLocoMove = this.CAM_FOLLOW_LOCK ? (inputZ !== 0) : hasMove;
      this._updateLocoAnim(activeLocoMove, isSprinting, inputZ < -0.2);
    }

    // ── UPDATE PROCEDURAL PARTICLES ────────────────────────
    if (this.PLAY_PARTICLES && this.dustPS) {
      const feetPos = this.root.position.add(new BABYLON.Vector3(0, -0.95, 0));
      this.dustPS.emitter = feetPos;

      // Play dust trails while walking, sprinting or rolling on ground with actual speed
      const activeMove = this.CAM_FOLLOW_LOCK ? (inputZ !== 0) : hasMove;
      if (this.grounded && activeMove && this.speed > 0.65 && (this.state === S.SPRINT || this.state === S.WALK || this.state === S.ROLL)) {
        this.dustPS.manualEmitCount = -1; // Reset to continuous emission mode
        this.dustPS.emitRate = this.state === S.SPRINT ? 180 : (this.state === S.WALK ? 25 : 80);
        if (!this.dustPS.isStarted()) {
          this.dustPS.start();
        }
      } else {
        this.dustPS.emitRate = 0;
      }
    } else if (this.dustPS) {
      this.dustPS.emitRate = 0;
    }

    // ── ADVANCED PROCEDURAL VISUALS & SUSPENSION ─────────
    // 1. Visual Y-Suspension
    const deltaY = this.root.position.y - (this._lastY !== undefined ? this._lastY : this.root.position.y);
    if (this.grounded && wasGrounded) {
      if (this.usePhysics) {
        if (this.onStairs) {
          // Compensate visual mesh local Y for capsule height shifts to smooth out stair pops
          this.visualLocalY -= deltaY;
        }
      } else {
        // Compensate visual mesh local Y for capsule height shifts
        this.visualLocalY -= deltaY;
      }
    }
    // Smoothly return visual mesh local Y to its target crouch/stand state Y (slowed to 4 for svelte transitions during spells/interactions)
    // On stairs and ramps (onScalable), we use a middle-ground rate of 12 for high responsiveness with pleasant spring compliance.
    const suspensionRate = this.onScalable ? 12 : 4;
    this.visualLocalY = lerp(this.visualLocalY, this.targetLocalY, 1 - Math.exp(-suspensionRate * dt));
    // Clamp to prevent visual separating too far from capsule boundaries.
    // Extremely important: clamp the lower bound tightly (targetLocalY - 0.02) to prevent clipping into stairs/slopes,
    // while keeping a flexible upper bound (targetLocalY + 0.35 on flat ground, but restricted to targetLocalY + 0.16 on ramps for compliance without floating)!
    const maxUpperSuspension = this.onScalable ? 0.16 : 0.35;
    this.visualLocalY = Math.max(this.targetLocalY - 0.02, Math.min(this.targetLocalY + maxUpperSuspension, this.visualLocalY));
    this.visualMesh.position.y = this.visualLocalY;

    // 1b. Kinetic Locomotion Bobbing
    if (this.grounded && hasMove && this.speed > 0.1 && !inAction) {
      // Bob speed and amplitude scale with movement state
      const bobFreq = this.state === S.SPRINT ? 14.5 : 9.5;
      const bobAmpY = this.state === S.SPRINT ? 0.032 : 0.016;
      const bobAmpX = this.state === S.SPRINT ? 0.020 : 0.009;

      this._bobTime += dt * bobFreq;
      const bobOffsetH = Math.cos(this._bobTime * 0.5) * bobAmpX;
      const bobOffsetY = Math.sin(this._bobTime) * bobAmpY;

      // Apply bobbing offsets locally to the visual mesh (temporary offset, not compounded into visualLocalY to prevent sinking!)
      this.visualMesh.position.x = bobOffsetH;
      this.visualMesh.position.y = this.visualLocalY + bobOffsetY;
    } else {
      // Smoothly return visual mesh local X back to center when resting
      this.visualMesh.position.x = lerp(this.visualMesh.position.x, 0, 1 - Math.exp(-12 * dt));
      this._bobTime = 0;
    }

    // 2. Procedural Leaning (Pitch & Roll)
    // Leaning forward when moving forward, backward when decelerating/braking
    const physicalSpeed = this.usePhysics ? Math.sqrt(currentVelocity.x * currentVelocity.x + currentVelocity.z * currentVelocity.z) : this.speed;
    const currentSpeedRatio = this.usePhysics ? Math.min(1.0, physicalSpeed / this.SPD_SPRINT) : (this.speed / this.SPD_SPRINT);
    const acceleration = (this.speed - this._lastSpeed) / dt;
    let targetPitch = 0;

    if (this.speed > 0.1 && (this._isPressed('MOVE_FORWARD') || (this.isTouch && this.touchVector.y > 0.1))) {
      // Leaning forward proportional to speed
      targetPitch = currentSpeedRatio * 0.12;
    } else if (acceleration < -4.0 && this.speed > 1.0) {
      // Braking lean: lean back slightly when decelerating
      targetPitch = -0.06;
    }

    // Dynamic Slope Pitch Alignment: Rotate visual mesh pitch to align with ground incline/slope normal
    if (this.grounded && this._groundNormal) {
      const fwd = new BABYLON.Vector3(Math.sin(this.rotY), 0, Math.cos(this.rotY)).normalize();
      const normalDotFwd = this._groundNormal.x * fwd.x + this._groundNormal.z * fwd.z;
      // Pitch angle calculated from surface normal projection, scaled down (65%) for a stylish, natural lean
      const slopePitch = Math.atan2(normalDotFwd, this._groundNormal.y) * 1;
      targetPitch += slopePitch;
    }
    this.tiltPitch = lerp(this.tiltPitch, targetPitch, 1 - Math.exp(-10 * dt));

    // Banking into turns (Roll) based on angular velocity (Y-rotation changes)
    let turnDelta = this.rotY - this._lastRotY;
    while (turnDelta > Math.PI) turnDelta -= 2 * Math.PI;
    while (turnDelta < -Math.PI) turnDelta += 2 * Math.PI;

    let targetRoll = 0;
    if (this.speed > 0.5) {
      // Roll proportional to turning delta and current speed ratio
      targetRoll = -turnDelta * 0.4 * Math.min(1.0, currentSpeedRatio * 1.5);
    }
    this.tiltRoll = lerp(this.tiltRoll, targetRoll, 1 - Math.exp(-8 * dt));

    // Apply pitch and roll to local visual mesh rotation, preserving initial Yaw
    if (this.visualMesh.rotationQuaternion) {
      BABYLON.Quaternion.RotationYawPitchRollToRef(this._initialVisualYaw, this.tiltPitch, this.tiltRoll, this.visualMesh.rotationQuaternion);
    } else {
      this.visualMesh.rotation.x = this.tiltPitch;
      this.visualMesh.rotation.y = this._initialVisualYaw;
      this.visualMesh.rotation.z = this.tiltRoll;
    }

    // 3. Procedural Squash & Stretch Scaling
    // Stretch while in air falling/jumping
    if (!this.grounded) {
      if (this.jumpVel > 1.0) {
        // Stretching upwards on rise
        this.targetScale.set(0.97, 1.04, 0.97);
      } else if (this.jumpVel < -2.0 && this._airborneTime > 0.15) {
        // Stretching downwards on fall
        this.targetScale.set(0.96, 1.05, 0.96);
      }
    } else {
      // Check if we just landed this frame and squash
      if (wasGrounded === false && this._lastAirborneTime > 0.15) {
        if (this.jumpVel < -4.0) {
          // Heavy landing squash & trigger heavy camera shake
          this.targetScale.set(1.08, 0.88, 1.08);
          this._camShake = 0.22;
        } else {
          // Soft landing squash & trigger soft camera shake
          this.targetScale.set(1.04, 0.95, 1.04);
          this._camShake = 0.08;
        }
        // Smoothly restore to normal scale after squash duration
        setTimeout(() => {
          this.targetScale.set(1, 1, 1);
        }, 120);
      }
    }

    // Interpolate visual mesh scale smoothly
    BABYLON.Vector3.LerpToRef(this.visualMesh.scaling, this.targetScale, 1 - Math.exp(-12 * dt), this.visualMesh.scaling);

    // 4. Dynamic Camera Shake & FOV Expansion
    // Decay camera shake intensity
    if (this._camShake > 0.002) {
      this._camShake = lerp(this._camShake, 0, 1 - Math.exp(-8 * dt));
      // Perturb camera orientation slightly to convey landing impact weight
      this.camera.beta += Math.sin(performance.now() * 0.048) * this._camShake * 0.05;
      this.camera.alpha += Math.cos(performance.now() * 0.054) * this._camShake * 0.04;
    }

    // Dynamic FOV based on speed (tunnel vision expansion)
    const targetFOV = this.DYNAMIC_FOV ? (this._initialCameraFOV + (this.speed / this.SPD_SPRINT) * this.DYNAMIC_FOV_MAX) : this._initialCameraFOV;
    this.camera.fov = lerp(this.camera.fov, targetFOV, 1 - Math.exp(-6 * dt));

    // Lock camera behind the character if follow lock is active
    if (!this.CAM_FOLLOW_LOCK && this.camera.angularSensibilityX === 999999999) {
      this.camera.angularSensibilityX = this._originalSensibilityX || 1000;
    }

    // Save tracking states for next frame calculations
    this._lastRotY = this.rotY;
    this._lastSpeed = this.speed;

    // Speed update callback / HUD
    if (this.callbacks.onSpeedChange) {
      this.callbacks.onSpeedChange(this.speed);
    } else {
      const hudSpeed = document.getElementById('hud-speed');
      if (hudSpeed) {
        hudSpeed.textContent = `spd: ${this.speed.toFixed(1)}`;
      }
    }

    // Update FPS inside the HUD
    const fpsText = `fps: ${this.scene.getEngine().getFps().toFixed(0)}`;
    const hudFps = document.getElementById('hud-fps');
    if (hudFps) {
      hudFps.textContent = fpsText;
    }
    const hudFpsInline = document.getElementById('hud-fps-inline');
    if (hudFpsInline) {
      hudFpsInline.textContent = fpsText;
    }

    // Update active visual state for mobile toggle buttons
    if (this.isTouch) {
      const btnCrouch = document.getElementById('btn-crouch');
      const btnSprint = document.getElementById('btn-sprint');

      if (btnCrouch) {
        if (this.crouching) btnCrouch.classList.add('active');
        else btnCrouch.classList.remove('active');
      }

      if (btnSprint) {
        if (this.sprinting) btnSprint.classList.add('active');
        else btnSprint.classList.remove('active');
      }
    }

    // Save current Y position for vertical stairs stabilization in the next frame
    this._lastY = this.root.position.y;
  }

  _updateLocoAnim(hasMove, sprint, backward, blend = 0.35) {
    if (!this.grounded) return;

    const charRoot = this.visualMesh;
    if (!charRoot) return;

    const dt = this.scene.getEngine().getDeltaTime() / 1000;

    if (this.crouching) {
      const want = hasMove ? (sprint ? S.CROUCH_RUN : S.CROUCH_WALK) : S.CROUCH_IDLE;

      // Sinks 8 cm relative to rest pose for a smooth visual crouch down
      this.targetLocalY = this._standMeshY - 0.08;

      let speedRatio = want === S.CROUCH_RUN ? this.SPD_CROUCH_RUN * (3.2 / 3.6) : this.SPD_CROUCH * (1.8 / 2.0);

      // Adapt speed to touch control input magnitude on mobile
      if (this.isTouch && hasMove) {
        const inputMag = Math.min(1.0, Math.sqrt(this.touchVector.x * this.touchVector.x + this.touchVector.y * this.touchVector.y));
        speedRatio *= inputMag;
      }

      // Invert crouch animation direction when moving backward under follow lock
      if (this.CAM_FOLLOW_LOCK && backward) {
        speedRatio = -speedRatio;
      }

      if (this.state !== want) {
        this._setState(want);
      }

      this.anim.play(
        want === S.CROUCH_IDLE ? 'Crouch_Idle_Loop' : 'Crouch_Fwd_Loop',
        true,
        blend,
        null,
        want === S.CROUCH_IDLE ? 1.0 : speedRatio
      );
      return;
    } else {
      this.targetLocalY = this._standMeshY;
    }

    if (this.weapon) {
      return;
    }

    // Detect turning in place under follow lock (including manual camera rotation via mouse/trackpad/touch)
    const isMouseOrTouchTurning = (performance.now() - (this._lastYawTurnTime || 0)) < 100;
    const turning = this._isPressed('MOVE_LEFT') || this._isPressed('MOVE_RIGHT') ||
      (this.isTouch && Math.abs(this.touchVector.x) > 0.15) ||
      isMouseOrTouchTurning;

    if (this.CAM_FOLLOW_LOCK && turning && !hasMove) {
      if (this.state !== S.WALK || this.anim.curName !== 'Locomotion') {
        this._setState(S.WALK);
      }
      this.anim.play('Locomotion', true, blend);
      const loco = this.anim.g.get('Locomotion');
      if (loco) {
        // We want a virtual walk weight of 0.15 when turning in place.
        // wWalk = v / spdWalk = 0.15 => v = 0.15 * spdWalk
        const spdWalk = this.SPD_WALK;
        loco.updateSpeed(0.2 * spdWalk);
      }
      return;
    }

    // Determine state based on speed and input
    let wantState = S.IDLE;
    if (this.speed > 0.05) {
      wantState = sprint ? S.SPRINT : S.WALK;
    }

    if (this.state !== wantState || this.anim.curName !== 'Locomotion') {
      this._setState(wantState);
    }

    // Play the unified Locomotion Blend Tree
    this.anim.play('Locomotion', true, blend);

    // Feed current physical speed to dynamically blend weights
    const loco = this.anim.g.get('Locomotion');
    if (loco) {
      loco.updateSpeed(this.speed);
    }
  }

  // ── RECENTER CAMERA (DOUBLE TAP OPTIMIZATION) ─────────
  _recenterCamera() {
    if (!this.camera) return;

    // targetAlpha is the rotation angle directly behind the character's facing direction (rotY)
    const targetAlpha = -this.rotY - Math.PI / 2;
    const targetBeta = Math.PI / 3.5; // Default pitch angle

    let elapsed = 0;
    const duration = 0.35; // 350ms smooth transition
    const startAlpha = this.camera.alpha;
    const startBeta = this.camera.beta;

    // Normalize angle differences to prevent 360-degree round spins
    let diffAlpha = targetAlpha - startAlpha;
    while (diffAlpha > Math.PI) diffAlpha -= 2 * Math.PI;
    while (diffAlpha < -Math.PI) diffAlpha += 2 * Math.PI;

    const diffBeta = targetBeta - startBeta;

    const obs = this.scene.onBeforeRenderObservable.add(() => {
      const dt = this.scene.getEngine().getDeltaTime() / 1000;
      elapsed += dt;
      const t = Math.min(1.0, elapsed / duration);

      // Smooth step ease curve
      const smoothT = t * t * (3 - 2 * t);

      this.camera.alpha = startAlpha + diffAlpha * smoothT;
      this.camera.beta = startBeta + diffBeta * smoothT;

      if (t >= 1.0) {
        this.scene.onBeforeRenderObservable.remove(obs);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════
// SHARED PHYSICS INITIALIZATION HELPER
// ═══════════════════════════════════════════════════════════
async function initPhysics(scene, gravity = new BABYLON.Vector3(0, -22, 0)) {
  const physicsOverride = localStorage.getItem('use-physics');
  if (physicsOverride === 'false') return false;
  try {
    const havokInstance = await HavokPhysics();
    const hk = new BABYLON.HavokPlugin(true, havokInstance);
    scene.enablePhysics(gravity, hk);
    // console.log("[Physics] Havok Physics initialized successfully.");
    return true;
  } catch (e) {
    if (physicsOverride === 'true') {
      // console.warn('[Physics] Havok forced but failed to load — falling back to kinematic.', e);
      localStorage.removeItem('use-physics');
    } else {
      // console.info('[Physics] Havok unavailable — using kinematic mode.', e);
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// SHARED CHARACTER SETUP HELPER
// ═══════════════════════════════════════════════════════════
async function setupCharacter(scene, camera, usePhysics, options = {}) {
  const setLoad = (pct, label) => {
    if (typeof window.setLoad === 'function') {
      window.setLoad(pct, label);
    } else {
      const bar = document.getElementById('bar');
      const barLabel = document.getElementById('bar-label');
      if (bar) bar.style.width = pct + '%';
      if (barLabel && label) barLabel.textContent = label;
    }
  };

  setLoad(10, 'Loading character...');
  const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', options.assetsPath || 'assets/', options.filename || 'character_animated.glb', scene);

  setLoad(75, 'Retargeting bones...');
  const charRoot = charRes.meshes[0];
  charRoot.name = 'Character_Visual';

  charRes.meshes.forEach(m => {
    if (options.shadow) options.shadow.addShadowCaster(m, true);
    m.receiveShadows = true;
    m.isPickable = false;
  });

  // Stop any auto-playing animations from character.glb
  charRes.animationGroups.forEach(ag => ag.stop());
  scene.animationGroups.forEach(ag => ag.stop());

  // Capsule Collider Structure
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.4, height: 1.8 }, scene);
  playerCapsule.position.copyFrom(options.spawnPosition || new BABYLON.Vector3(0, 2, 0));
  playerCapsule.visibility = 0;
  playerCapsule.isPickable = false;

  playerCapsule.checkCollisions = !usePhysics;
  playerCapsule.ellipsoid = options.ellipsoid || new BABYLON.Vector3(0.35, 0.96, 0.35);
  playerCapsule.ellipsoidOffset = new BABYLON.Vector3(0, 0, 0);

  // Parent visual mesh to capsule
  charRoot.setParent(playerCapsule);
  charRoot.position.set(0, usePhysics ? -0.90 : -0.97, 0);
  charRoot.rotation.set(0, 0, 0);

  setLoad(90, 'Building controllers...');

  // Remove T-Pose animation group before building controller
  charRes.animationGroups
    .filter(ag => /t[\-_]?pose/i.test(ag.name))
    .forEach(ag => ag.dispose());
  const filteredGroups = charRes.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

  const animCtrl = new AnimCtrl(filteredGroups, scene);

  // Allow passing keys, config and other options directly or inside charOptions
  const charOptions = Object.assign({}, options.charOptions);
  if (options.keys) charOptions.keys = options.keys;
  if (options.config) charOptions.config = options.config;

  const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, charOptions);

  // Allow custom remapping of animations/controls or extra setup from app
  if (typeof options.configure === 'function') {
    options.configure({ animCtrl, charCtrl, filteredGroups, playerCapsule, scene });
  }

  const isMobileDev = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cameraYOffset = isMobileDev ? -0.25 : 0.4;

  scene.registerBeforeRender(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const clampedDt = Math.max(0.001, Math.min(0.1, dt));
    const tgt = playerCapsule.position.add(new BABYLON.Vector3(0, cameraYOffset, 0));
    camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 1 - Math.exp(-15 * clampedDt));
  });

  return { playerCapsule, animCtrl, charCtrl };
}

// Expose classes and definitions to the global window object for easy consumption in classical script-based setups
window.S = S;
window.ACTION_STATES = ACTION_STATES;
window.AnimCtrl = AnimCtrl;
window.CharCtrl = CharCtrl;
window.normBone = normBone;
window.cleanAnimName = cleanAnimName;
window.lerp = lerp;
window.lerpAngle = lerpAngle;
window.setupCharacter = setupCharacter;
window.loadCharacter = setupCharacter;
window.initPhysics = initPhysics;
