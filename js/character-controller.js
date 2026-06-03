'use strict';

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
    CROUCH: ['ControlLeft', 'ControlRight'],// Crouch
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
    SPD_CROUCH_RUN: 3.6,  // Maximum physical crouching run speed
    ACCEL: 14,            // Movement acceleration rate (speed-up responsiveness)
    DECEL: 16,            // Movement deceleration rate (braking/stopping responsiveness)
    ROT_SPD: 40,          // Character yaw rotation speed responsiveness
    AIR_CONTROL: false,   // Steering control in mid-air (true = full control, false = no control)
    DYNAMIC_FOV: true,    // Dynamically adjust camera Field of View based on movement speed
    DYNAMIC_FOV_MAX: 0.10, // Maximum camera FOV expansion amount added at full sprint speed
    CAM_FOLLOW_LOCK: false, // If true, the camera is locked behind the character's facing direction
    CAM_FOLLOW_PITCH: 1.047, // Camera follow lock pitch (beta angle in radians, approx 60 degrees)
    CAM_FOLLOW_DIST: 8.0, // Camera follow lock distance (radius in meters)
    DOUBLE_JUMP_ENABLED: true // If true, the character can perform a double jump in mid-air
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
  PUNCH_JAB: 'PUNCH_JAB', PUNCH_CROSS: 'PUNCH_CROSS',
  SPELL_ENTER: 'SPELL_ENTER', SPELL_SHOOT: 'SPELL_SHOOT', SPELL_EXIT: 'SPELL_EXIT',
  INTERACT: 'INTERACT', PICKUP: 'PICKUP',
};

const ACTION_STATES = new Set([
  S.JUMP_START, S.JUMP_LOOP, S.JUMP_LAND, S.ROLL,
  S.PUNCH_JAB, S.PUNCH_CROSS,
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

    const walkRatio = spdWalk * (1.5 / 2.4);
    const sprintRatio = spdSprint * (1.1 / 6.0);

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
          // Normal walking speed ratio (with sign for backwards movement)
          const spdWalk = char.SPD_WALK;
          walk.speedRatio = sign * spdWalk * (1.5 / 2.4);
        }
      }

      if (sprint) {
        // Normal sprinting speed ratio (with sign for backwards movement)
        const spdSprint = char.SPD_SPRINT;
        sprint.speedRatio = sign * spdSprint * (1.1 / 6.0);
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
    const spdWalk = char ? char.SPD_WALK : 2.4;
    const spdSprint = char ? char.SPD_SPRINT : 6.0;

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

    console.log('[AnimCtrl] loaded:', [...this.g.keys()].sort().join(', '));

    // Register Locomotion Blend Tree as a virtual animation group
    this.locoGroup = new LocoBlendGroup(this);
    this.g.set('Locomotion', this.locoGroup);

    this.resetInactiveWeights();
  }

  resetInactiveWeights() {
    const active = new Set();
    if (this.cur) {
      active.add(this.curName);
      if (this.curName === 'Locomotion') {
        active.add('Idle_Loop');
        active.add('Walk_Loop');
        active.add('Sprint_Loop');
      }
    }
    this.activeTransitions.forEach(t => {
      for (const [name, group] of this.g.entries()) {
        if (group === t.incoming || group === t.outgoing) {
          active.add(name);
          if (name === 'Locomotion') {
            active.add('Idle_Loop');
            active.add('Walk_Loop');
            active.add('Sprint_Loop');
          }
        }
      }
    });

    for (const [name, group] of this.g.entries()) {
      if (!active.has(name)) {
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

  play(name, loop = false, blendDuration = 0.25, onEnd = null, speedRatio = 1.0, weightParam = null) {
    const ag = this.g.get(name);
    if (!ag) { console.warn('[AnimCtrl] missing:', name); return false; }

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
      this.cur.speedRatio = speedRatio;
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
    incoming.start(loop, speedRatio, incoming.from, incoming.to, false);
    incoming.setWeightForAllAnimatables(outgoing ? 0 : targetWeight);

    if (outgoing) {
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

    const savedDoubleJump = localStorage.getItem('double-jump-enabled');
    this.DOUBLE_JUMP_ENABLED = savedDoubleJump !== null ? (savedDoubleJump === 'true') : (config.DOUBLE_JUMP_ENABLED !== undefined ? config.DOUBLE_JUMP_ENABLED : true);

    this._originalSensibilityX = this.camera.angularSensibilityX;
    this._originalRadius = this.camera.radius;
    console.log("[CharCtrl] Config loaded: FOLLOW_LOCK =", this.CAM_FOLLOW_LOCK, " | DYNAMIC_FOV =", this.DYNAMIC_FOV, " | FOV_MAX =", this.DYNAMIC_FOV_MAX, " | FOLLOW_PITCH =", this.CAM_FOLLOW_PITCH, " | FOLLOW_DIST =", this.CAM_FOLLOW_DIST);

    // Mobile / Touch controls configuration
    this.touchConfig = Object.assign({}, DEFAULT_CHAR_CONFIG.TOUCH, options.touch || {});

    // Physics running state
    this.speed = 0;
    this.rotY = 0;
    this.jumpVel = 0;
    this.grounded = false;
    this.onScalable = false;
    this._airborneTime = 0;
    this._rollOnLand = false;
    this._rollActive = false;

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
    // iPad OS 13+ spoofs a Mac UA — can't use UA alone.
    // Strategy: has touch API + not a desktop OS UA = real touch device.
    const hasTouchAPI = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);
    const isDesktopUA = /Win(dows NT|32|64)|Macintosh|Linux x86_64/i.test(navigator.userAgent) &&
                        !/Android|iPhone|iPod/i.test(navigator.userAgent);
    const hasTouch = hasTouchAPI && !isDesktopUA;
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
    this._crouchEllipsoidY = 0.65;
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
      const isWheelZooming = (now - (this._lastWheelTime || 0)) < 200;
      const isTouchPinchZooming = this._pointerDragging && (this._activePointers ? this._activePointers.size >= 2 : false);
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
        if (label) {
          label.textContent = this.CAM_FOLLOW_DIST.toFixed(1) + 'm';
        }
      }

      // Sync manual camera pitch drag back to CAM_FOLLOW_PITCH and sync HUD in both modes!
      const betaDelta = this.camera.beta - this._lastCameraBeta;
      if (this._pointerDragging && Math.abs(betaDelta) > 0.0001) {
        // Block manual camera pitch in the air if air control is disabled
        if (!this.grounded && !this.AIR_CONTROL) {
          this.camera.beta = this._lastCameraBeta;
        } else {
          const lo = this.camera.lowerBetaLimit || 0.05;
          const hi = this.camera.upperBetaLimit || (Math.PI / 2.05);
          this.CAM_FOLLOW_PITCH = Math.max(lo, Math.min(hi, this.camera.beta));
          localStorage.setItem('cam-follow-pitch', this.CAM_FOLLOW_PITCH);
          // Sync HUD slider and label
          const slider = document.getElementById('slider-cam-pitch');
          const label = document.getElementById('cam-pitch-val');
          if (slider && label) {
            const deg = Math.round(this.CAM_FOLLOW_PITCH * 180 / Math.PI);
            slider.value = deg;
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
            this.rotY -= alphaDelta;
            this.root.rotation.y = this.rotY;
            this._lastYawTurnTime = performance.now();
          }
        }

        // Push camera alpha to match rotY (single source of truth)
        const dt = this.scene.getEngine().getDeltaTime() / 1000;
        if (dt > 0 && dt < 0.1) {
          const targetAlpha = -this.rotY - Math.PI / 2;
          this.camera.alpha = lerpAngle(this.camera.alpha, targetAlpha, 1 - Math.exp(-14 * dt));
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
    this.dustPS.emitter = new BABYLON.Vector3(0, 0, 0);
    this.dustPS.minEmitBox = new BABYLON.Vector3(-0.25, -0.05, -0.25);
    this.dustPS.maxEmitBox = new BABYLON.Vector3(0.25, 0.05, 0.25);

    this.dustPS.color1 = new BABYLON.Color4(0.68, 0.65, 0.6, 0.45);
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
    if (this.dustPS) {
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
      console.log('[CharCtrl] Mobile joystick elements not found in DOM, skipping joystick initialization');
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

      knob.style.transform = `translate(${dx}px, ${dy}px)`;

      // Normalize vector to [-1, 1] range
      // Swap Y because screen down is positive, but we want forward (W) to be positive, backward (S) negative
      this.touchVector.x = dx / maxDist;
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
    }
  }

  _keyDown(code) {
    const inAction = ACTION_STATES.has(this.state);

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
      if (this.grounded && !inAction && !this.sitting && !this._rollActive) {
        if (this.crouching && this._isCeilingBlocked()) {
          this._showCombo('NO SPACE TO ROLL');
          setTimeout(() => this._hideCombo(), 1200);
          return;
        }
        this._roll();
      }
    } else if (this._matchesAction(code, 'PUNCH')) {
      if (this.grounded && !inAction && !this.weapon && !this.sitting)
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
    this.targetScale.set(1.15, 0.78, 1.15);
    setTimeout(() => {
      if (!this.grounded) {
        this.targetScale.set(0.92, 1.14, 0.92);
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

    this.targetScale.set(1.15, 0.78, 1.15);
    setTimeout(() => {
      if (!this.grounded) {
        this.targetScale.set(0.92, 1.14, 0.92);
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
    this._rollActive = true;
    this._setState(S.ROLL);

    let inputX = 0, inputZ = 0;
    if (this._isPressed('MOVE_FORWARD')) inputZ += 1;
    if (this._isPressed('MOVE_BACKWARD')) inputZ -= 1;
    if (this._isPressed('MOVE_RIGHT')) inputX += 1;
    if (this._isPressed('MOVE_LEFT')) inputX -= 1;
    if (this.isTouch && (Math.abs(this.touchVector.x) > 0.01 || Math.abs(this.touchVector.y) > 0.01)) {
      inputX = this.touchVector.x; inputZ = this.touchVector.y;
    }
    this._rollMoving = Math.sqrt(inputX * inputX + inputZ * inputZ) > 0.15;

    if (this._rollMoving) {
      const camFwd = this._camForward();
      let dir = this._camRight(camFwd).scale(inputX).add(camFwd.scale(inputZ));
      if (dir.length() > 0.01) dir.normalize(); else dir = camFwd;
      this._rollDir = dir;
      this.speed = Math.max(this.speed, 3.5);
    } else {
      this.speed = 0;
    }

    this.anim.play('Roll', false, 0.2, null, 1.1);

    // Reliable 1-second timer to exit the roll state and return to locomotion
    setTimeout(() => {
      this._rollActive = false;
      if (this.state !== S.ROLL) return;

      // If we are under a low obstacle/ceiling when the roll ends, automatically force crouching
      if (this._isCeilingBlocked()) {
        this.crouching = true;
        this._forcedCrouchFromRoll = true;
      }

      const rollAg = this.anim.g.get('Roll');
      if (rollAg) {
        this.anim.activeTransitions = this.anim.activeTransitions.filter(t => {
          if (t.outgoing === rollAg) {
            if (t.observer) this.scene.onBeforeRenderObservable.remove(t.observer);
            return false;
          }
          return true;
        });
        rollAg.setWeightForAllAnimatables(0);
        rollAg.stop();
      }
      this._returnToLoco(0.2);
    }, 700);
  }

  _punch() {
    const now = performance.now();
    if (this.comboIdx === 1 && now - this.comboT < 900) {
      this.comboIdx = 2;
      this._setState(S.PUNCH_CROSS);
      this.anim.play('Punch_Cross', false, 0.08, () => {
        this.comboIdx = 0;
        this._setState(S.IDLE);
        this._returnToLoco();
        this._hideCombo();
      }, 1.2);
      this._showCombo('CROSS!');
    } else {
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

  _showCombo(txt) {
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
      this.anim.play('Spell_Simple_Shoot', false, 0.15, () => {
        this._setState(S.SPELL_EXIT);
        this.anim.play('Spell_Simple_Exit', false, 0.2, () => this._returnToLoco(0.35));
      });
    });
  }

  _interact() {
    this._setState(S.INTERACT);
    // Increased blend duration from 0.1 to 0.35 for a gorgeous smooth stand-up transition when interacting from a crouch
    this.anim.play('Interact', false, 0.35, () => this._returnToLoco(0.35));
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
      this._updateLocoAnim(true, isSprinting, inputZ < -0.2, blend);
    } else {
      this._idle(blend);
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
    // Origin at slightly above the bottom of the capsule (sits at Y = -0.95 relative to center)
    const originYOffset = -0.9;
    // Use a longer ray length on stairs/ramps (scalable meshes) or when rolling to bridge drops and prevent micro-airborne jitter.
    // On flat ground, we use a tight ray (0.20m) so that the character snaps instantly and never floats.
    const rayLen = (this.onScalable || this.state === S.ROLL) ? 0.32 : 0.20;
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
        // Check if mesh is marked, matches step/stair naming patterns, or has sloped surface normals
        if (pick.pickedMesh.meshType === "scalable" ||
          (pick.pickedMesh.name && /step|stair|ramp|platform|floor/i.test(pick.pickedMesh.name))) {
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

    this.onScalable = onScalable;
    return hitAny;
  }

  _isCeilingBlocked() {
    // Start raycast at the bottom of the feet (ground level) instead of the capsule center
    // to avoid starting the ray inside/above a low ceiling, which would fail to detect it.
    const rayStart = this.root.position.add(new BABYLON.Vector3(0, -0.9, 0));
    const upDir = new BABYLON.Vector3(0, 1, 0);
    // Ray length needs to reach the full standing height (2 * ellipsoidY = 1.92m) plus clearance margin
    const rayLen = (this._standEllipsoidY * 2.0) + 0.1;

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
    if (this.jumpVel > 0.1) {
      this.grounded = false;
    } else {
      this.grounded = this._checkGrounded();
    }

    // Landing / roll recovery
    let landingTriggered = false;
    if (this.grounded && !wasGrounded) {
      landingTriggered = true;
      this._hasDoubleJumped = false; // Reset double jump!
      const fallHeight = this._highestAirborneY - this.root.position.y;
      if (this.state === S.ROLL) {
        this._emitLandingDust();
        if (!this._rollActive) {
          this._returnToLoco(0.06);
        }
      } else if (this._rollOnLand && this.speed > 1.0) {
        this._rollOnLand = false;
        this._emitLandingDust();
        this._roll();
      } else if (this.jumpVel < -3.0 && fallHeight > 0.4) {
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
      this._airborneTime = 0;
      this._highestAirborneY = this.root.position.y;
    }

    // Ledge snap push: if we just lost grounding while moving and did not jump or roll, push down to snap to flat floor immediately and avoid floating
    if (!this.grounded && wasGrounded && this.state !== S.JUMP_START && this.state !== S.JUMP_LOOP && this.state !== S.ROLL) {
      this.jumpVel = -4.0;
    }

    let inAction = ACTION_STATES.has(this.state);

    // Let the roll animation play to completion naturally via its callback

    // ── PROCESS VERTICAL PHYSICS (GRAVITY & JUMPING) ───────
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
          const inAction = ACTION_STATES.has(this.state);
          if (this.grounded && hasMove && !this.onScalable && !inAction) {
            this._setState(S.JUMP_LAND);
            // Play JUMP_LAND animation with a lower weight (0.35) for a subtler, more natural step-up blend
            this.anim.play('Jump_Land', false, 0.1, () => this._returnToLoco(), 1.65, 0.25);
            this._emitLandingDust();
          }
        } else {
          // Apply a gentle downward snap pressure only when moving on stairs/ramps to prevent flying off step edges
          this.jumpVel = hasMove && this.onScalable ? -3.5 : 0;
        }
      }
    }

    // ── PROCESS CROUCHING / ROLLING COLLISION HEIGHT ADJUSTMENTS ─────
    // If we are performing a standing action (like spell casting or interacting) while crouching,
    // we temporarily restore standing collision bounds and target height so that the character stands properly.
    const isTempStandingAction = inAction && (this.state === S.SPELL_ENTER || this.state === S.SPELL_SHOOT || this.state === S.SPELL_EXIT || this.state === S.INTERACT);
    const useCrouchHeight = (this.crouching && !isTempStandingAction) || this.state === S.ROLL;

    const targetEllipsoidY = useCrouchHeight ? this._crouchEllipsoidY : this._standEllipsoidY;
    const targetOffset = useCrouchHeight ? -(this._standEllipsoidY - this._crouchEllipsoidY) : 0;
    // Make the ellipsoid slightly wider when sprinting (from 0.35 to 0.65) so the head doesn't clip into low ceilings/walls when leaning forward at high speeds
    const targetEllipsoidWidth = (this.state === S.SPRINT) ? 0.65 : this._standEllipsoidWidth;

    if (isTempStandingAction) {
      this.targetLocalY = this._standMeshY;
    }

    // Smoothly interpolate collision ellipsoid size & offset to prevent sudden camera/physics glitches (slowed down to 4 for premium fluid feel)
    if (this.root.ellipsoid) {
      this.root.ellipsoid.y = lerp(this.root.ellipsoid.y, targetEllipsoidY, 1 - Math.exp(-4 * dt));
      this.root.ellipsoidOffset.y = lerp(this.root.ellipsoidOffset.y, targetOffset, 1 - Math.exp(-4 * dt));

      const newWidth = lerp(this.root.ellipsoid.x, targetEllipsoidWidth, 1 - Math.exp(-4 * dt));
      this.root.ellipsoid.x = newWidth;
      this.root.ellipsoid.z = newWidth;
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
            const steerSpeed = 2.8; // Radians per second
            this.rotY += inputX * steerSpeed * dt;
            this.root.rotation.y = this.rotY;
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
            tgt *= Math.abs(inputZ);
          }

          const rate = inputZ !== 0 ? this.ACCEL : this.DECEL;
          this.speed = lerp(this.speed, tgt, 1 - Math.exp(-rate * dt));
          if (this.speed < 0.05) this.speed = 0;
        }
      } else {
        // ── STANDARD CAMERA-RELATIVE LOCOMOTION ────────────
        // Compute camera-relative direction
        const camFwd = this._camForward();
        const camRgt = this._camRight(camFwd);

        if (!this.grounded) {
          // Air control logic:
          if (this.AIR_CONTROL) {
            // Full steering in mid-air:
            if (hasMove) {
              dir = camRgt.scale(inputX).add(camFwd.scale(inputZ));
              if (dir.length() > 0.01) dir.normalize();
            }

            let tgtSpeed = this.speed;
            if (hasMove) {
              let idealTgt = isSprinting ? this.SPD_SPRINT : this.SPD_WALK;
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
            dir = camRgt.scale(inputX).add(camFwd.scale(inputZ));
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
            tgt *= inputMag;

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
        const k = this.grounded ? (this.ROT_SPD * 0.16) : (this.ROT_SPD * 0.08);
        this.rotY = lerpAngle(this.rotY, this._smoothTgt, 1 - Math.exp(-k * dt));
        this.root.rotation.y = this.rotY;
      }

      // Move the Capsule using collisions!
      const horizontalDisplacement = dir.scale(this.speed * dt);
      const verticalDisplacement = new BABYLON.Vector3(0, this.jumpVel * dt, 0);
      const totalDisplacement = horizontalDisplacement.add(verticalDisplacement);

      this.root.moveWithCollisions(totalDisplacement);

      if (this.speed > 0) {
        this.moveDir.copyFrom(dir);
      }
    } else if (this.state === S.ROLL) {
      const snapDown = this.grounded ? -4.0 : this.jumpVel;
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
        }
        this.root.moveWithCollisions(this._rollDir.scale(this.speed * dt).add(vert));
      } else {
        this.root.moveWithCollisions(vert);
      }
    }

    // Teleport back if character falls out of bounds
    if (this.root.position.y < -15) {
      this.root.position.copyFrom(new BABYLON.Vector3(0, 1.2, 0));
      this.root.rotation.y = 0;
      this.rotY = 0;
      this.jumpVel = 0;
      this.speed = 0;
    }

    // ── UPDATE LOCOMOTION ANIMATIONS ──────────────────────
    const canLoco = !inAction;
    if (canLoco && !this.sitting) {
      const activeLocoMove = this.CAM_FOLLOW_LOCK ? (inputZ !== 0) : hasMove;
      this._updateLocoAnim(activeLocoMove, isSprinting, inputZ < -0.2);
    }

    // ── UPDATE PROCEDURAL PARTICLES ────────────────────────
    if (this.dustPS) {
      const feetPos = this.root.position.add(new BABYLON.Vector3(0, -0.95, 0));
      this.dustPS.emitter = feetPos;

      // Play dust trails while walking, sprinting or rolling on ground
      const activeMove = this.CAM_FOLLOW_LOCK ? (inputZ !== 0) : hasMove;
      if (this.grounded && activeMove && (this.state === S.SPRINT || this.state === S.WALK || this.state === S.ROLL)) {
        this.dustPS.manualEmitCount = -1; // Reset to continuous emission mode
        this.dustPS.emitRate = this.state === S.SPRINT ? 180 : (this.state === S.WALK ? 25 : 80);
        if (!this.dustPS.isStarted()) {
          this.dustPS.start();
        }
      } else {
        this.dustPS.emitRate = 0;
      }
    }

    // ── ADVANCED PROCEDURAL VISUALS & SUSPENSION ─────────
    // 1. Visual Y-Suspension
    const deltaY = this.root.position.y - (this._lastY !== undefined ? this._lastY : this.root.position.y);
    if (this.grounded && wasGrounded) {
      // Compensate visual mesh local Y for capsule height shifts
      this.visualLocalY -= deltaY;
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
    const currentSpeedRatio = this.speed / this.SPD_SPRINT;
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
        this.targetScale.set(0.92, 1.12, 0.92);
      } else if (this.jumpVel < -2.0) {
        // Stretching downwards on fall
        this.targetScale.set(0.90, 1.15, 0.90);
      }
    } else {
      // Check if we just landed this frame and squash
      if (wasGrounded === false) {
        if (this.jumpVel < -4.0) {
          // Heavy landing squash & trigger heavy camera shake
          this.targetScale.set(1.22, 0.72, 1.22);
          this._camShake = 0.22;
        } else {
          // Soft landing squash & trigger soft camera shake
          this.targetScale.set(1.10, 0.88, 1.10);
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
    const hudFps = document.getElementById('hud-fps');
    if (hudFps) {
      hudFps.textContent = `fps: ${this.scene.getEngine().getFps().toFixed(0)}`;
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

// Expose classes and definitions to the global window object for easy consumption in classical script-based setups
window.S = S;
window.ACTION_STATES = ACTION_STATES;
window.AnimCtrl = AnimCtrl;
window.CharCtrl = CharCtrl;
window.normBone = normBone;
window.cleanAnimName = cleanAnimName;
window.lerp = lerp;
window.lerpAngle = lerpAngle;
