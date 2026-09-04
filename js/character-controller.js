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
    CAM_TILT: false,      // Drone-style camera banking (roll) when moving laterally at speed
    CAM_TILT_AMOUNT: 0.15, // Maximum camera bank angle in radians applied at full lateral sprint
    CAM_FOLLOW_LOCK: true, // If true, the camera is locked behind the character's facing direction
    CAM_FOLLOW_PITCH: 1.047, // Camera follow lock pitch (beta angle in radians, approx 60 degrees)
    CAM_FOLLOW_DIST: 8.0, // Camera follow lock distance (radius in meters)
    CAM_LOCK_PITCH: false,   // If true, drag input only rotates camera horizontally (locks vertical/pitch axis)
    JOYSTICK_LOCK_X: false,  // If true, joystick input is locked to vertical axis only (no strafing/turning)
    DOUBLE_JUMP_ENABLED: true, // If true, the character can perform a double jump in mid-air
    SPEED_MULTIPLIER: 1.0,     // Speed multiplier for walking and running
    PLAY_PARTICLES: true,      // Play particles/dust under the character's feet
    MOVING_PLATFORMS: true,    // Inherit motion (position + yaw) from animated platforms under the feet
    HEAD_LOOK: true,           // Head softly tracks the camera direction during idle/locomotion
    FOOT_PLANTING: true,       // Pelvis drop on slopes/steps so the downhill foot doesn't float
    TWIST_DRIVER: true,        // Drive *ForeArmTwist bones from hand roll (rigs built with twist bones)
    MANTLE_ENABLED: true,      // Jump near a chest-high ledge boosts exactly enough to mantle onto it
    COYOTE_TIME: 0.12,         // Seconds after walking off a ledge where JUMP still counts as grounded
    JUMP_BUFFER: 0.15,         // Seconds a JUMP press taken in mid-air is remembered and fired on landing
    JUMP_CUT: true,            // Releasing JUMP while ascending shortens the jump (variable height)
    JUMP_CUT_MULT: 2.5,        // Extra downward acceleration multiplier applied on jump-cut (higher = snappier cut)
    ACCEL_CURVE: true          // Apex-based acceleration: fast launch off rest, precise control near top speed
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

// Apex-based acceleration: launches fast off rest (snappy start) and eases
// toward the configured base rate near top speed (precise control at the
// cap), the curve used by Celeste/Mario-style platformers instead of a flat
// exponential blend. `ratio` = current speed / target top speed, 0..1+.
// At ratio=0 the rate is scaled up to 2.2×; it decays to 1× by ratio=1.
function apexAccelRate(baseRate, ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  return baseRate * (1 + 1.2 * (1 - r) * (1 - r));
}

function normBone(name) {
  if (!name) return '';
  let n = name.toLowerCase();

  // 1. Determine side (left / right)
  let side = '';
  if (n.includes('left') || n.match(/\b_l\b/) || n.match(/_l_/) || n.startsWith('l_') || n.match(/[^a-z]l[a-z]/) || n.includes('lhand') || n.includes('lfoot') || n.includes('lthigh') || n.includes('lcalf') || n.includes('larm') || n.includes('lforearm') || n.includes('lclavicle')) {
    side = 'left';
  } else if (n.includes('right') || n.match(/\b_r\b/) || n.match(/_r_/) || n.startsWith('r_') || n.match(/[^a-z]r[a-z]/) || n.includes('rhand') || n.includes('rfoot') || n.includes('rthigh') || n.includes('rcalf') || n.includes('rarm') || n.includes('rforearm') || n.includes('rclavicle')) {
    side = 'right';
  }

  // Clean prefixes and punctuation
  n = n.replace(/^(mixamorig\d*|armature|cc_base)[:_ ]/i, '')
    .replace(/[:_ \-]/g, '');

  // 2. Normalize synonyms
  if (n.includes('thigh')) n = n.replace('thigh', 'upleg');
  if (n.includes('calf')) n = n.replace('calf', 'leg');
  if (n.includes('upperarm')) n = n.replace('upperarm', 'arm');
  if (n.includes('clavicle')) n = n.replace('clavicle', 'shoulder');
  if (n.includes('pelvis')) n = n.replace('pelvis', 'hips');
  if (n.includes('hip')) n = n.replace('hip', 'hips');
  if (n.includes('hand')) n = n.replace('hand', '');
  if (n.includes('middle')) n = n.replace('middle', 'mid');

  // If we found a side, prepend it to ensure left/right are distinct
  if (side) {
    // Exporters use both prefixes (L_Arm) and suffixes (upperarm_r). Remove
    // either marker after punctuation normalization so it does not leak into
    // the canonical role ("rightarmr") and break retarget matching.
    n = n.replace(/^(left|right|l|r)/, '').replace(/(left|right|l|r)$/, '');
    n = side + n;
  }

  return n;
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
    this._endObservers = new Map();
    this._disposed = false;

    // Support both pre-populated Map or a simple Array of AnimationGroups
    if (groups instanceof Map) {
      this.g = groups;
    } else if (Array.isArray(groups)) {
      this.g = new Map();
      groups.forEach(ag => {
        const cleanName = cleanAnimName(ag.name);
        if (this.g.has(cleanName)) {
          console.warn(`[AnimCtrl] Duplicate animation name "${cleanName}" ignored. Rename the clip to map it explicitly.`);
        } else {
          this.g.set(cleanName, ag);
        }
      });
    } else {
      this.g = new Map();
    }

    // console.log('[AnimCtrl] loaded:', [...this.g.keys()].sort().join(', '));

    // Register Locomotion Blend Tree as a virtual animation group
    this.locoGroup = new LocoBlendGroup(this);
    this.g.set('Locomotion', this.locoGroup);

    // ── Animation events ──────────────────────────────────────
    // animationEvents: { [animName]: [{ type, frame, label }] }
    // onAnimationEvent: (evt, animName) => {} fired when playback crosses evt.frame
    this.animationEvents = {};
    this.onAnimationEvent = null;
    this._evtLastFrame = new Map(); // animName -> last seen frame
    this._eventObserver = scene.onBeforeRenderObservable.add(() => this._updateAnimationEvents());

    this.resetInactiveWeights();
  }

  // Fire markers whose frame was crossed since the previous render tick.
  // Handles loop wrap-around (frame jumps back below the last seen frame).
  _updateAnimationEvents() {
    const events = this.animationEvents;
    if (!events || !this.cur) { this._evtLastFrame.clear(); return; }

    // Groups to watch: the current group, fading-out groups still blending
    // (so markers near a clip's end fire during the crossfade), plus the loco
    // loops when the Locomotion blend tree is active (footsteps on Walk/Sprint).
    const watch = [];
    const watched = new Set();
    const addWatch = (name, ag) => {
      if (!name || !ag || watched.has(name)) return;
      watched.add(name);
      if (name === 'Locomotion') {
        for (const n of ['Idle_Loop', 'Walk_Loop', 'Sprint_Loop']) {
          const sub = this.g.get(n);
          const a = sub?.animatables?.[0];
          if (a && a.weight > 0.3 && !watched.has(n)) { watched.add(n); watch.push([n, sub]); }
        }
      } else {
        watch.push([name, ag]);
      }
    };
    addWatch(this.curName, this.cur);
    for (const t of this.activeTransitions) addWatch(t.outgoingName, t.outgoing);

    const seen = new Set();
    for (const [name, ag] of watch) {
      seen.add(name);
      const list = events[name];
      const a = ag.animatables?.[0];
      if (!list || !list.length || !a) continue;
      const frame = a.masterFrame;
      if (!Number.isFinite(frame)) continue;
      if (!this._evtLastFrame.has(name)) { this._evtLastFrame.set(name, frame); continue; }
      const last = this._evtLastFrame.get(name);
      this._evtLastFrame.set(name, frame);
      if (frame === last) continue;
      const direction = Number(ag.speedRatio ?? a.speedRatio ?? 1) < 0 ? -1 : 1;
      for (const evt of list) {
        const f = Number(evt.frame);
        const crossed = direction >= 0
          ? (frame >= last
            ? (f > last && f <= frame)          // forward advance
            : (f > last || f <= frame))         // forward loop wrap
          : (frame <= last
            ? (f < last && f >= frame)          // reverse advance
            : (f < last || f >= frame));        // reverse loop wrap
        if (crossed) this._fireAnimationEvent(evt, name);
      }
    }
    // Drop stale frame tracking for groups no longer playing
    for (const key of this._evtLastFrame.keys()) {
      if (!seen.has(key)) this._evtLastFrame.delete(key);
    }
  }

  _fireAnimationEvent(evt, animName) {
    try {
      if (this.onAnimationEvent) this.onAnimationEvent(evt, animName);
      if (this.charCtrl?.onAnimationEvent) this.charCtrl.onAnimationEvent(evt, animName);
      window.dispatchEvent(new CustomEvent('charanimevent', { detail: { ...evt, animName } }));
    } catch (e) {
      console.error('[AnimCtrl] animation event handler failed:', e);
    }
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
    // console.warn('[AnimCtrl] missing:', name);
  }

  _clearEndObserver(group) {
    const observer = this._endObservers.get(group);
    if (observer && group?.onAnimationGroupEndObservable) {
      group.onAnimationGroupEndObservable.remove(observer);
    }
    this._endObservers.delete(group);
  }

  _setEndObserver(group, callback) {
    this._clearEndObserver(group);
    if (!callback || !group?.onAnimationGroupEndObservable) return;
    const observer = group.onAnimationGroupEndObservable.addOnce(() => {
      this._endObservers.delete(group);
      callback();
    });
    this._endObservers.set(group, observer);
  }

  play(name, loop = false, blendDuration = 0.25, onEnd = null, speedRatio = 1.0, weightParam = null) {
    if (this._disposed) return false;
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
        this._clearEndObserver(this.cur);
        this.cur.start(loop, finalSpeedRatio, this.cur.from, this.cur.to, false);
        if (Number.isFinite(this.cur.from)) this._evtLastFrame.set(name, this.cur.from - 0.001);
        this._setEndObserver(this.cur, onEnd);
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
      this._clearEndObserver(outgoing);
      // An ended one-shot has already stopped: its animatables are gone, so the
      // crossfade would have no source pose — Babylon normalizes the incoming
      // group's tiny weight to full influence and the pose snaps. Re-start the
      // outgoing clip pinned at its last frame at ~zero speed so it keeps
      // writing its end pose into the weighted blend (a paused animatable
      // stops writing and is excluded from weight normalization).
      if (!outgoing.isPlaying) {
        const pinFrom = Math.max(outgoing.from, outgoing.to - 0.01);
        outgoing.start(false, 0.0001, pinFrom, outgoing.to, false);
        outgoing.goToFrame(outgoing.to - 0.005);
      }
      let elapsed = 0;
      const outgoingStartWeight = outgoing.animatables[0] ? outgoing.animatables[0].weight : targetWeight;
      const transition = {
        incoming,
        outgoing,
        outgoingName: this.curName, // for animation event tracking during fade-out
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
    // Seed event tracking at the clip start so frame-0 markers fire
    if (Number.isFinite(incoming.from)) this._evtLastFrame.set(name, incoming.from - 0.001);

    if (this.onAnimationChange) {
      this.onAnimationChange(name);
    } else {
      const hudAnim = document.getElementById('hud-anim');
      if (hudAnim) {
        hudAnim.textContent = name;
      }
    }

    if (onEnd && !loop) {
      this._setEndObserver(incoming, onEnd);
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

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.forceStop();
    if (this._eventObserver) this.scene.onBeforeRenderObservable.remove(this._eventObserver);
    for (const group of this._endObservers.keys()) this._clearEndObserver(group);
    this._evtLastFrame.clear();
    this.charCtrl = null;
  }

  has(name) { return this.g.has(name); }

  setAnimation(name, animationGroup) {
    // If this group is already mapped to another action, clone it so each
    // action keeps independent playback state, weights and frame ranges
    // (allows reusing e.g. Walk for both Walk_Loop and Sprint_Loop).
    for (const [otherName, otherAg] of this.g) {
      if (otherName !== name && otherAg === animationGroup) {
        const clone = animationGroup.clone(`${animationGroup.name}__${name}`);
        clone.__isSharedClone = true;
        animationGroup = clone;
        break;
      }
    }

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
    if (oldAg && oldAg.__isSharedClone && oldAg !== animationGroup) oldAg.dispose();

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
    this.dispose();
  }
}

// ═══════════════════════════════════════════════════════════
// CHARACTER CONTROLLER
// ═══════════════════════════════════════════════════════════
class CharCtrl {
  constructor(root, visualMesh, camera, anim, scene, options = {}) {
    if (!camera || !Number.isFinite(camera.alpha) || !Number.isFinite(camera.beta) || !Number.isFinite(camera.radius)) {
      throw new TypeError('CharCtrl requires a Babylon.js ArcRotateCamera (alpha, beta and radius must be finite).');
    }
    this.root = root; // Capsule collider parent mesh
    this.visualMesh = visualMesh; // Visual character mesh
    this.camera = camera;
    this._destroyed = false;
    this._timers = new Set();
    this._intervals = new Set();
    this._cameraStateBeforeController = {
      alpha: camera.alpha,
      beta: camera.beta,
      radius: camera.radius,
      lowerRadiusLimit: camera.lowerRadiusLimit,
      upperRadiusLimit: camera.upperRadiusLimit,
      wheelPrecision: camera.wheelPrecision,
      pinchPrecision: camera.pinchPrecision,
      panningSensibility: camera.panningSensibility,
      checkCollisions: camera.checkCollisions,
      angularSensibilityX: camera.angularSensibilityX,
      angularSensibilityY: camera.angularSensibilityY,
      fov: camera.fov,
      upVector: camera.upVector?.clone ? camera.upVector.clone() : null,
    };
    const attachedInputs = camera.inputs?.attached;
    const wheelInput = attachedInputs?.mousewheel || attachedInputs?.mouseWheel;
    const pointerInput = attachedInputs?.pointers || attachedInputs?.pointersInput;
    this._cameraInputStateBeforeController = {
      wheelInput,
      pointerInput,
      wheelPrecision: wheelInput?.wheelPrecision,
      wheelPrecisionX: wheelInput?.wheelPrecisionX,
      wheelPrecisionY: wheelInput?.wheelPrecisionY,
      wheelPrecisionZ: wheelInput?.wheelPrecisionZ,
      pinchPrecision: pointerInput?.pinchPrecision,
    };
    if (this.camera) {
      this.camera.checkCollisions = false;
    }
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

    // Runtime configuration is authoritative. Browser persistence is opt-in so
    // an exported project cannot be silently changed by stale settings left by
    // another character or a previous Builder session.
    this._storage = options.storage || (options.persistPreferences === true && typeof localStorage !== 'undefined' ? localStorage : null);
    const stored = (key) => {
      try { return this._storage?.getItem(key) ?? null; } catch (_) { return null; }
    };

    // Use physics parameter
    this.usePhysics = options.usePhysics !== undefined ? !!options.usePhysics : true;

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
    const savedAirControl = stored('air-control-enabled');
    this.AIR_CONTROL = savedAirControl !== null ? (savedAirControl === 'true') : (config.AIR_CONTROL !== undefined ? config.AIR_CONTROL : false);
    // Load optional persisted preferences, falling back to configuration defaults.
    const savedCamFollowLock = stored('cam-follow-lock');
    this.CAM_FOLLOW_LOCK = savedCamFollowLock !== null ? (savedCamFollowLock === 'true') : config.CAM_FOLLOW_LOCK;

    const savedDynamicFov = stored('dynamic-fov');
    this.DYNAMIC_FOV = savedDynamicFov !== null ? (savedDynamicFov === 'true') : config.DYNAMIC_FOV;

    const savedDynamicFovMax = stored('dynamic-fov-max');
    this.DYNAMIC_FOV_MAX = savedDynamicFovMax !== null ? parseFloat(savedDynamicFovMax) : config.DYNAMIC_FOV_MAX;

    const savedCamTilt = stored('cam-tilt');
    this.CAM_TILT = savedCamTilt !== null ? (savedCamTilt === 'true') : (config.CAM_TILT !== undefined ? config.CAM_TILT : false);

    const savedCamTiltAmount = stored('cam-tilt-amount');
    this.CAM_TILT_AMOUNT = savedCamTiltAmount !== null ? parseFloat(savedCamTiltAmount) : (config.CAM_TILT_AMOUNT !== undefined ? config.CAM_TILT_AMOUNT : 0.15);

    const savedCamFollowPitch = stored('cam-follow-pitch');
    this.CAM_FOLLOW_PITCH = savedCamFollowPitch !== null ? parseFloat(savedCamFollowPitch) : (config.CAM_FOLLOW_PITCH !== undefined ? config.CAM_FOLLOW_PITCH : Math.PI / 3.0);

    const savedCamFollowDist = stored('cam-follow-dist');
    this.CAM_FOLLOW_DIST = savedCamFollowDist !== null ? parseFloat(savedCamFollowDist) : (config.CAM_FOLLOW_DIST !== undefined ? config.CAM_FOLLOW_DIST : this.camera.radius);

    const savedCamLockPitch = stored('cam-lock-pitch');
    this.CAM_LOCK_PITCH = savedCamLockPitch !== null ? (savedCamLockPitch === 'true') : (config.CAM_LOCK_PITCH !== undefined ? config.CAM_LOCK_PITCH : false);

    const savedJoystickLockX = stored('joystick-lock-x');
    this.JOYSTICK_LOCK_X = savedJoystickLockX !== null ? (savedJoystickLockX === 'true') : (config.JOYSTICK_LOCK_X !== undefined ? config.JOYSTICK_LOCK_X : false);

    const savedDoubleJump = stored('double-jump-enabled');
    this.DOUBLE_JUMP_ENABLED = savedDoubleJump !== null ? (savedDoubleJump === 'true') : (config.DOUBLE_JUMP_ENABLED !== undefined ? config.DOUBLE_JUMP_ENABLED : true);

    const savedSpeedMultiplier = stored('speed-multiplier');
    this.SPEED_MULTIPLIER = savedSpeedMultiplier !== null ? parseFloat(savedSpeedMultiplier) : (config.SPEED_MULTIPLIER !== undefined ? config.SPEED_MULTIPLIER : 1.0);

    const savedShowCombo = stored('show-combo');
    this.SHOW_COMBO = savedShowCombo !== null ? (savedShowCombo === 'true') : true;

    const savedPlayParticles = stored('play-particles');
    this.PLAY_PARTICLES = savedPlayParticles !== null ? (savedPlayParticles === 'true') : (config.PLAY_PARTICLES !== undefined ? config.PLAY_PARTICLES : true);

    this.MOVING_PLATFORMS = config.MOVING_PLATFORMS !== undefined ? config.MOVING_PLATFORMS : true;
    this.HEAD_LOOK = config.HEAD_LOOK !== undefined ? config.HEAD_LOOK : true;
    this.FOOT_PLANTING = config.FOOT_PLANTING !== undefined ? config.FOOT_PLANTING : true;
    this.TWIST_DRIVER = config.TWIST_DRIVER !== undefined ? config.TWIST_DRIVER : true;
    this.MANTLE_ENABLED = config.MANTLE_ENABLED !== undefined ? config.MANTLE_ENABLED : true;
    this.COYOTE_TIME = config.COYOTE_TIME !== undefined ? config.COYOTE_TIME : 0.12;
    this.JUMP_BUFFER = config.JUMP_BUFFER !== undefined ? config.JUMP_BUFFER : 0.15;
    this.JUMP_CUT = config.JUMP_CUT !== undefined ? config.JUMP_CUT : true;
    this.JUMP_CUT_MULT = config.JUMP_CUT_MULT !== undefined ? config.JUMP_CUT_MULT : 2.5;
    this.ACCEL_CURVE = config.ACCEL_CURVE !== undefined ? config.ACCEL_CURVE : true;
    this._coyoteTimer = 0;        // seconds since last grounded (jump still valid while < COYOTE_TIME)
    this._jumpBufferTimer = -1;   // seconds since last JUMP press (<0 = no buffered press); consumed on landing
    this._jumpCutApplied = false; // whether the current ascent has already been shortened by a release
    this._platformState = null;   // moving-platform ride state (mesh + local anchor)
    this._boneDriversInit = false; // lazy skeleton-node lookup for head/twist/foot drivers
    this._headLookYaw = 0;
    this._headLookPitch = 0;
    this._headLookWeight = 0;
    this._pelvisDrop = 0;

    this._originalSensibilityX = this.camera ? this.camera.angularSensibilityX : 1000;
    this._originalSensibilityY = this.camera ? this.camera.angularSensibilityY : 1000;
    this._originalRadius = this.camera ? this.camera.radius : 8.0;
    // console.log("[CharCtrl] Config loaded: FOLLOW_LOCK =", this.CAM_FOLLOW_LOCK, " | DYNAMIC_FOV =", this.DYNAMIC_FOV, " | FOV_MAX =", this.DYNAMIC_FOV_MAX, " | FOLLOW_PITCH =", this.CAM_FOLLOW_PITCH, " | FOLLOW_DIST =", this.CAM_FOLLOW_DIST);

    // Apply Hide Cursor only when the opt-in storage contains the preference.
    if (stored('hide-cursor') === 'true') {
      document.body.classList.add('cursor-hidden');
    }

    // Mobile / Touch controls configuration
    this.touchConfig = Object.assign({}, DEFAULT_CHAR_CONFIG.TOUCH, options.touch || {});

    // Initialize Havok Physics Body if enabled
    if (this.usePhysics) {
      // Derive physics capsule size from the collision ellipsoid so a scaled character gets a matching body
      const physScaleY = this.root.ellipsoid ? this.root.ellipsoid.y / 0.96 : 1;
      const physScaleW = this.root.ellipsoid ? this.root.ellipsoid.x / 0.46 : 1;
      const startPoint = new BABYLON.Vector3(0, -0.55 * physScaleY, 0);
      const endPoint = new BABYLON.Vector3(0, 0.55 * physScaleY, 0);
      this._standShape = new BABYLON.PhysicsShapeCapsule(startPoint, endPoint, 0.46 * physScaleW, scene);
      this._crouchShape = new BABYLON.PhysicsShapeCapsule(new BABYLON.Vector3(0, -0.55 * physScaleY, 0), new BABYLON.Vector3(0, -0.15 * physScaleY, 0), 0.46 * physScaleW, scene);

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
    this.gamepadEnabled = options.gamepad !== false;
    this.gamepadVector = { x: 0, y: 0 };
    this._gamepadButtons = new Map();
    this.isTouch = false;
    this._touchListeners = [];
    this._pointerDragging = false;

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
      this._setTimeout(() => this._setupTouchHUD(), 200);
    }

    // Capture initial dimensions for automatic crouch scaling
    this._standEllipsoidY = this.root.ellipsoid ? this.root.ellipsoid.y : 0.96;
    this._standEllipsoidWidth = this.root.ellipsoid ? this.root.ellipsoid.x : 0.46;
    this._standMeshY = this.visualMesh.position.y;
    this._crouchEllipsoidY = 0.55 * (this._standEllipsoidY / 0.96);
    // Capsule scale factors relative to the default 1.8m capsule — drive scale-aware ray distances
    this._capScaleY = this._standEllipsoidY / 0.96;
    this._capScaleW = this._standEllipsoidWidth / 0.46;
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

      // Keep camera zoom speed, limits, and sensitivities in sync with character scale Y
      const scaleY = this._capScaleY || 1.0;
      if (this.camera) {
        this.camera.lowerRadiusLimit = 2 * scaleY;
        this.camera.upperRadiusLimit = 20 * scaleY;
        this.camera.wheelPrecision = 55 / scaleY;
        this.camera.pinchPrecision = 55 / scaleY;
        if (this.camera.inputs && this.camera.inputs.attached) {
          const mw = this.camera.inputs.attached.mousewheel || this.camera.inputs.attached.mouseWheel;
          if (mw) {
            mw.wheelPrecision = 55 / scaleY;
            if (mw.wheelPrecisionY !== undefined) mw.wheelPrecisionY = 55 / scaleY;
            if (mw.wheelPrecisionX !== undefined) mw.wheelPrecisionX = 55 / scaleY;
            if (mw.wheelPrecisionZ !== undefined) mw.wheelPrecisionZ = 55 / scaleY;
          }
          const ptrs = this.camera.inputs.attached.pointers || this.camera.inputs.attached.pointersInput;
          if (ptrs) {
            ptrs.pinchPrecision = 55 / scaleY;
          }
        }
        this.camera.panningSensibility = 1000 / scaleY;
        if (!this.CAM_FOLLOW_LOCK) {
          this.camera.angularSensibilityX = (this._originalSensibilityX || 1000) / scaleY;
        }
        this.camera.angularSensibilityY = (this._originalSensibilityY || 1000) / scaleY;
      }

      const radiusDelta = this.camera.radius - this._lastCameraRadius;
      if (isUserZooming && Math.abs(radiusDelta) > 0.0001) {
        const slider = document.getElementById('slider-cam-dist');
        const minVal = slider ? parseFloat(slider.min) : 2;
        const maxVal = slider ? parseFloat(slider.max) : 15;
        this.CAM_FOLLOW_DIST = Math.max(minVal, Math.min(maxVal, this.camera.radius));
        this._baseCamFollowDist = this.CAM_FOLLOW_DIST / (this._capScaleY || 1.0);
        this._setStoredPreference('cam-follow-dist', this.CAM_FOLLOW_DIST);

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
          this._setStoredPreference('cam-follow-pitch', this.CAM_FOLLOW_PITCH);
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
        // Restore full mouse sensitivity, adapted to character scale
        const scaleY = this._capScaleY || 1.0;
        this.camera.angularSensibilityX = (this._originalSensibilityX || 1000) / scaleY;

        // Apply mouse yaw delta to rotY (alpha = -rotY - PI/2, so delta inverts)
        const alphaDelta = this.camera.alpha - this._lastCameraAlpha;
        if (this._pointerDragging && Math.abs(alphaDelta) > 0.0001) {
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

    // Scale-aware camera speed & limits initialization
    const scaleY = this._capScaleY || 1.0;
    this._baseCamFollowDist = this.CAM_FOLLOW_DIST / scaleY;

    if (this.camera) {
      this.camera.lowerRadiusLimit = 2 * scaleY;
      this.camera.upperRadiusLimit = 20 * scaleY;
      this.camera.radius = this.CAM_FOLLOW_DIST;

      this.camera.wheelPrecision = 55 / scaleY;
      this.camera.pinchPrecision = 55 / scaleY;
      if (this.camera.inputs && this.camera.inputs.attached) {
        const mw = this.camera.inputs.attached.mousewheel || this.camera.inputs.attached.mouseWheel;
        if (mw) {
          mw.wheelPrecision = 55 / scaleY;
          if (mw.wheelPrecisionY !== undefined) mw.wheelPrecisionY = 55 / scaleY;
          if (mw.wheelPrecisionX !== undefined) mw.wheelPrecisionX = 55 / scaleY;
          if (mw.wheelPrecisionZ !== undefined) mw.wheelPrecisionZ = 55 / scaleY;
        }
        const ptrs = this.camera.inputs.attached.pointers || this.camera.inputs.attached.pointersInput;
        if (ptrs) {
          ptrs.pinchPrecision = 55 / scaleY;
        }
      }
      this.camera.panningSensibility = 1000 / scaleY;
      this.camera.angularSensibilityX = (this._originalSensibilityX || 1000) / scaleY;
      this.camera.angularSensibilityY = (this.camera.angularSensibilityY || 1000) / scaleY;
    }

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
    this.dustPS.emitter = new BABYLON.Vector3();
    this.dustPS.minEmitBox = new BABYLON.Vector3(-0.25, -0.05, -0.25);
    this.dustPS.maxEmitBox = new BABYLON.Vector3(0.25, 0.05, 0.25);

    this.dustPS.color1 = new BABYLON.Color4(0.7, 0.7, 0.7, 0.25);
    this.dustPS.color2 = new BABYLON.Color4(0.55, 0.52, 0.48, 0.12);
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

    this.dustPS.manualEmitCount = -1; // Default to continuous emission mode
    this._syncDustEmitter();
  }

  _syncDustEmitter() {
    if (!this.dustPS) return;
    // Collider dimensions are already in world units. Multiplying their
    // offsets by root.scaling again would bury the emitter on small models.
    const scaleY = this._capScaleY ?? (this.root.ellipsoid ? this.root.ellipsoid.y / 0.96 : 1);
    const scaleW = this._capScaleW ?? (this.root.ellipsoid ? this.root.ellipsoid.x / 0.46 : 1);
    const feet = this.dustPS.emitter;
    feet.copyFrom(this.root.position);
    if (this.usePhysics) {
      // Both Havok capsules start at -0.55 * scaleY and have this radius.
      feet.y -= 0.55 * scaleY + 0.46 * scaleW;
    } else {
      if (this.root.ellipsoidOffset) feet.addInPlace(this.root.ellipsoidOffset);
      feet.y -= this.root.ellipsoid?.y ?? 0.96 * scaleY;
    }
    feet.y += 0.01 * scaleY;

    // Keep the whole spawn volume above the contact point and the effect
    // proportional to the character. Recompute from base values, not from
    // the previous particle sizes, so repeated slider changes cannot drift.
    this.dustPS.minEmitBox.set(-0.25 * scaleW, 0, -0.25 * scaleW);
    this.dustPS.maxEmitBox.set(0.25 * scaleW, 0.05 * scaleY, 0.25 * scaleW);
    this.dustPS.minSize = 0.16 * scaleW;
    this.dustPS.maxSize = 0.45 * scaleW;
    this.dustPS.gravity.set(0, 1.2 * scaleY, 0);
    this.dustPS.direction1.set(-0.5 * scaleW, 0.2 * scaleY, -0.5 * scaleW);
    this.dustPS.direction2.set(0.5 * scaleW, 0.4 * scaleY, 0.5 * scaleW);
  }

  _emitLandingDust() {
    if (this.PLAY_PARTICLES && this.dustPS) {
      this._syncDustEmitter();
      this.dustPS.manualEmitCount = 30; // Emit 30 particles instantly
      this.dustPS.start();              // Force restart to process manual emission
    }
  }

  _isPressed(action) {
    if (this._isInputBlocked()) return false;
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

  _pollGamepad() {
    if (!this.gamepadEnabled || typeof navigator.getGamepads !== 'function') return;
    const gamepad = [...navigator.getGamepads()].find(Boolean);
    if (!gamepad) {
      this.gamepadVector = { x: 0, y: 0 };
      this._gamepadButtons.clear();
      return;
    }
    const deadzone = 0.16;
    const curve = (value) => {
      const magnitude = Math.abs(value);
      if (magnitude <= deadzone) return 0;
      return Math.sign(value) * Math.min(1, (magnitude - deadzone) / (1 - deadzone));
    };
    this.gamepadVector.x = curve(gamepad.axes[0] || 0);
    this.gamepadVector.y = -curve(gamepad.axes[1] || 0);

    const mapping = {
      0: 'JUMP', 1: 'ROLL', 2: 'INTERACT', 3: 'PUNCH',
      4: 'CROUCH', 5: 'SPRINT', 6: 'SPELL',
    };
    for (const [buttonIndex, action] of Object.entries(mapping)) {
      const pressed = !!gamepad.buttons[Number(buttonIndex)]?.pressed;
      const wasPressed = this._gamepadButtons.get(action) === true;
      if (pressed && !wasPressed) {
        const binding = this.keyBindings[action];
        const code = Array.isArray(binding) ? binding[0] : binding;
        if (code) this._keyDown(code);
      } else if (!pressed && wasPressed && action === 'JUMP') {
        this._releaseJump();
      }
      this._gamepadButtons.set(action, pressed);
    }
  }

  // ── INPUT ──────────────────────────────────────────────
  _setupInput() {
    this._boundKeyDown = e => {
      const modal = document.getElementById('info-panel-modal');
      if (modal && modal.classList.contains('open')) {
        return;
      }
      if (this._isInputBlocked()) {
        this.keys = {};
        return;
      }
      this.keys[e.code] = true;
      if (!e.repeat) this._keyDown(e.code);
    };
    this._boundKeyUp = e => {
      this.keys[e.code] = false;
      if (this._matchesAction(e.code, 'JUMP')) this._releaseJump();
    };
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
    this.gamepadVector = { x: 0, y: 0 };
    this._gamepadButtons.clear();
    this._jumpBufferTimer = -1; // discard any pending buffered jump on focus loss
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
          if (this._matchesAction(keyCode, 'JUMP')) this._releaseJump();
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

  // Gameplay animation markers — stored on the AnimCtrl, which drives playback.
  // Usage: charCtrl.animationEvents = { Punch: [{ type:'hit', frame: 12 }] };
  //        charCtrl.onAnimationEvent = (evt, animName) => { ... };
  get animationEvents() { return this.anim.animationEvents; }
  set animationEvents(v) { this.anim.animationEvents = v || {}; }

  _setTimeout(callback, delay) {
    let id = null;
    id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._destroyed) callback();
    }, delay);
    this._timers.add(id);
    return id;
  }

  _setInterval(callback, delay) {
    const id = setInterval(() => {
      if (!this._destroyed) callback();
    }, delay);
    this._intervals.add(id);
    return id;
  }

  _setStoredPreference(key, value) {
    try { this._storage?.setItem(key, String(value)); } catch (_) { /* optional storage */ }
  }

  _isInputBlocked() {
    const active = document.activeElement;
    return !!active && (active.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
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
    if (this._camTiltPointerObserver) {
      this.scene.onPointerObservable.remove(this._camTiltPointerObserver);
    }
    if (this._cameraFollowObserver) {
      this.scene.onBeforeRenderObservable.remove(this._cameraFollowObserver);
    }
    if (this._recenterObserver) {
      this.scene.onBeforeRenderObservable.remove(this._recenterObserver);
      this._recenterObserver = null;
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

    for (const id of this._timers) clearTimeout(id);
    for (const id of this._intervals) clearInterval(id);
    this._timers.clear();
    this._intervals.clear();

    if (this.anim?.dispose) this.anim.dispose();
    const previous = this._cameraStateBeforeController;
    if (previous && this.camera) {
      this.camera.alpha = previous.alpha;
      this.camera.beta = previous.beta;
      this.camera.radius = previous.radius;
      this.camera.lowerRadiusLimit = previous.lowerRadiusLimit;
      this.camera.upperRadiusLimit = previous.upperRadiusLimit;
      this.camera.wheelPrecision = previous.wheelPrecision;
      this.camera.pinchPrecision = previous.pinchPrecision;
      this.camera.panningSensibility = previous.panningSensibility;
      this.camera.checkCollisions = previous.checkCollisions;
      this.camera.angularSensibilityX = previous.angularSensibilityX;
      this.camera.angularSensibilityY = previous.angularSensibilityY;
      this.camera.fov = previous.fov;
      if (previous.upVector) this.camera.upVector.copyFrom(previous.upVector);
    }
    const inputState = this._cameraInputStateBeforeController;
    if (inputState?.wheelInput) {
      inputState.wheelInput.wheelPrecision = inputState.wheelPrecision;
      if (inputState.wheelPrecisionX !== undefined) inputState.wheelInput.wheelPrecisionX = inputState.wheelPrecisionX;
      if (inputState.wheelPrecisionY !== undefined) inputState.wheelInput.wheelPrecisionY = inputState.wheelPrecisionY;
      if (inputState.wheelPrecisionZ !== undefined) inputState.wheelInput.wheelPrecisionZ = inputState.wheelPrecisionZ;
    }
    if (inputState?.pointerInput && inputState.pinchPrecision !== undefined) {
      inputState.pointerInput.pinchPrecision = inputState.pinchPrecision;
    }
  }

  playParticles(enable) {
    this.PLAY_PARTICLES = !!enable;
    this._setStoredPreference('play-particles', this.PLAY_PARTICLES);
    if (!this.PLAY_PARTICLES && this.dustPS) {
      this.dustPS.emitRate = 0;
      this.dustPS.stop();
    }
  }

  _keyDown(code) {
    if (this._isInputBlocked()) return;
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
            this._setTimeout(() => this._hideCombo(), 1200);
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
      // Coyote time: a few frames after walking off a ledge still count as
      // grounded for jump purposes — forgives the "stepped off 1 frame too
      // late" case that feels unfair with an exact-grounded check.
      const coyoteEligible = this.grounded || (this._coyoteTimer < this.COYOTE_TIME && !this._hasDoubleJumped);
      if (coyoteEligible && (!inAction || this.state === S.JUMP_LAND) && !this.sitting) {
        if (this._isCeilingBlocked()) {
          this._showCombo('CEILING BLOCKED');
          this._setTimeout(() => this._hideCombo(), 1200);
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
          // Jump buffer: remember this press so it fires the instant we land,
          // instead of requiring a frame-perfect press right on touchdown.
          this._jumpBufferTimer = 0;
          this._showCombo('JUMP QUEUED');
          this._setTimeout(() => this._hideCombo(), 1200);
        }
      } else if (!coyoteEligible && inAction && this.state !== S.ROLL) {
        // Pressed jump a moment too early (e.g. tail end of a landing/attack
        // animation) — buffer it instead of dropping the input on the floor.
        this._jumpBufferTimer = 0;
      }
    } else if (this._matchesAction(code, 'ROLL')) {
      const now = performance.now();
      if (this._rollActive) return;
      if (now - this._lastRollTime < 1100) {
        this._showCombo('DODGE COOLDOWN');
        this._setTimeout(() => this._hideCombo(), 800);
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
          this._setTimeout(() => this._hideCombo(), 1200);
          return;
        }
        if (!this.grounded) {
          this._showCombo('AIR DASH');
          this._setTimeout(() => this._hideCombo(), 800);
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
    } else if (!inAction && !this.sitting) {
      // Any mapped non-built-in action with a registered animation is a valid
      // one-shot custom action. This lives in the runtime controller so custom
      // mappings behave identically in Builder preview and exported projects.
      const reserved = new Set([
        'MOVE_FORWARD', 'MOVE_BACKWARD', 'MOVE_LEFT', 'MOVE_RIGHT',
        'CROUCH', 'SPRINT', 'JUMP', 'ROLL', 'PUNCH', 'SPELL', 'INTERACT',
      ]);
      for (const action of Object.keys(this.keyBindings)) {
        if (reserved.has(action) || !this._matchesAction(code, action) || !this.anim.has(action)) continue;
        this.triggerAction(action);
        break;
      }
    }
  }

  triggerAction(action, { blend = 0.25, speedRatio = 1 } = {}) {
    if (!action || this._isInAction() || this.sitting || !this.anim.has(action)) return false;
    this._setState(action);
    return this.anim.play(action, false, blend, () => {
      if (this.state === action) this._returnToLoco();
    }, speedRatio);
  }

  // ── ACTIONS ────────────────────────────────────────────
  // Variable jump height: called on JUMP key/button release. Shortens the
  // ascent instead of always reaching JUMP_PWR's full arc, the same feel as
  // Mario/Celeste-style platformers. No-ops once already falling or already
  // cut this ascent (idempotent — safe from stray key-up events).
  _releaseJump() {
    if (!this.JUMP_CUT || this._jumpCutApplied) return;
    if (this.usePhysics && this.physicsBody) {
      const velocity = this.physicsBody.getLinearVelocity();
      if (velocity?.y > 0.5) {
        this.physicsBody.setLinearVelocity(new BABYLON.Vector3(velocity.x, velocity.y * 0.45, velocity.z));
        this._jumpCutApplied = true;
      }
      return;
    }
    if (this.jumpVel > 0.5) {
      this.jumpVel *= 0.45;
      this._jumpCutApplied = true;
    }
  }

  _jump() {
    this.jumpVel = this.JUMP_PWR;
    this._jumpCutApplied = false;
    this._coyoteTimer = this.COYOTE_TIME; // consume the coyote window
    // Mantle assist: jumping into a chest-high ledge boosts exactly enough to
    // land on top (probes wall, ledge height and headroom before boosting).
    if (this.MANTLE_ENABLED && !this.crouching && this.grounded) this._tryMantle();
    this.grounded = false;
    this._setState(S.JUMP_START);
    // Dynamic takeoff squash
    this.targetScale.set(1.05, 0.92, 1.05);
    this._setTimeout(() => {
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
    this._jumpCutApplied = false;
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
    if (Math.abs(this.gamepadVector.x) > 0.01 || Math.abs(this.gamepadVector.y) > 0.01) {
      inputX = this.gamepadVector.x; inputZ = this.gamepadVector.y;
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
    this._setTimeout(() => {
      if (!this.grounded) {
        this.targetScale.set(0.97, 1.05, 0.97);
      }
    }, 100);

    this._showCombo('DOUBLE JUMP');
    this._setTimeout(() => this._hideCombo(), 1200);

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
      const baseRollSpeed = this.grounded ? 5.2 : 6.2; // Adjusted horizontal impulse/dash speed
      this.speed = Math.max(this.speed, baseRollSpeed * this.SPEED_MULTIPLIER);
    } else {
      this._rollDir = currentFwdDir;
      this.speed = 0;
    }

    // Apply vertical push/boost when rolling (hop/small jump)
    const verticalBoost = this.JUMP_PWR * 0.55; // Increased upward hop boost (55% of jump power)
    this.jumpVel = verticalBoost;
    this.grounded = false;
    if (this.usePhysics && this.physicsBody) {
      this.physicsBody.setLinearVelocity(new BABYLON.Vector3(
        this._rollDir.x * this.speed,
        verticalBoost,
        this._rollDir.z * this.speed
      ));
    }

    this.anim.play('Roll', false, 0.4, null, 1.1);

    this._rollTimeoutId = this._setTimeout(() => {
      this._rollActive = false;
      if (this.state !== S.ROLL) return;

      if (this._isCeilingBlocked()) {
        this.crouching = true;
        this._forcedCrouchFromRoll = true;
      }

      // Zero out horizontal momentum but preserve vertical velocity.
      // Reset speed AND jumpVel: in Havok mode, jumpVel is never decremented by
      // gravity (Havok handles that), so it still holds the verticalBoost value.
      // Without this reset, the locomotion block would re-apply it as a sudden
      // upward impulse the first frame JUMP_LOOP takes control.
      this.speed = 0;
      this.jumpVel = 0;
      if (this.usePhysics && this.physicsBody) {
        const cv = this.physicsBody.getLinearVelocity();
        this.physicsBody.setLinearVelocity(new BABYLON.Vector3(0, cv.y, 0));
      }

      // Resolve post-roll state: wait for the hop arc to settle rather than
      // immediately forcing JUMP_LOOP — this prevents premature fall-animation
      // during jump + roll combos where the character is still ascending.
      this._resolvePostRoll();
    }, 820 / this.SPEED_MULTIPLIER);
  }

  // Called at the end of the roll timer. Polls each frame until the hop arc
  // has settled, then picks the right next state without premature JUMP_LOOP.
  _resolvePostRoll() {
    // Safety: if we somehow left ROLL state already, do nothing
    if (this.state !== S.ROLL) return;

    const check = () => {
      // Stop polling if state changed externally (e.g. landed via _update loop)
      if (this.state !== S.ROLL) return;

      const grounded = this._checkGrounded();
      const fallingDown = this.usePhysics
        ? (this.physicsBody ? this.physicsBody.getLinearVelocity().y < -0.5 : false)
        : this.jumpVel < -0.5;

      if (grounded) {
        // Character has landed — seed a small speed so the run animation
        // doesn't pop in from a dead stop, then return to locomotion.
        this.grounded = true;
        const hasInput = this._isPressed('MOVE_FORWARD') || this._isPressed('MOVE_BACKWARD') ||
          this._isPressed('MOVE_LEFT') || this._isPressed('MOVE_RIGHT') ||
          (this.isTouch && (Math.abs(this.touchVector?.x) > 0.15 || Math.abs(this.touchVector?.y) > 0.15));
        if (hasInput) {
          // Seed speed at walk level so the locomotion blend starts from something
          // non-zero — avoids the jarring snap from 0 → run speed.
          this.speed = this.SPD_WALK * this.SPEED_MULTIPLIER * 0.6;
        }
        this._returnToLoco(0.38);
      } else if (fallingDown) {
        // Arc has peaked and we are now descending — hand off to JUMP_LOOP.
        // speed is already 0 (reset in the timeout above) so no horizontal
        // impulse will be re-injected by _update() on the next frame.
        this.grounded = false;
        this._setState(S.JUMP_LOOP);
        this.anim.play('Jump_Loop', true, 0.7);
      } else {
        // Still ascending or at peak — wait one more frame
        requestAnimationFrame(check);
      }
    };

    requestAnimationFrame(check);
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
      this._setTimeout(() => {
        if (this.state === S.SPELL_SHOOT) {
          this._returnToLoco(0.35);
        }
      }, 50 / this.SPEED_MULTIPLIER);
    });
  }

  _interact() {
    this._setState(S.INTERACT);
    // Allow canceling into movement after 35% of the clip; when idle, let the
    // full clip play (so late animation events still fire) and exit on end.
    const ag = this.anim.g.get('Interact');
    const fps = (ag && ag.targetedAnimations[0] && ag.targetedAnimations[0].animation) ? ag.targetedAnimations[0].animation.framePerSecond : 30;
    const durationMs = ag ? ((ag.to - ag.from) / fps) * 1000 : 1000;
    const recoveryDelay = (durationMs * 0.35) / this.SPEED_MULTIPLIER;

    this.anim.play('Interact', false, 0.35, () => {
      if (this.state === S.INTERACT) this._returnToLoco(0.35);
    });

    this._setTimeout(() => {
      const cancelIfMoving = this._setInterval(() => {
        if (this.state !== S.INTERACT) { clearInterval(cancelIfMoving); return; }
        const moving = this._isPressed('MOVE_FORWARD') || this._isPressed('MOVE_BACKWARD') ||
          this._isPressed('MOVE_LEFT') || this._isPressed('MOVE_RIGHT') ||
          (this.isTouch && (Math.abs(this.touchVector.x) > 0.2 || Math.abs(this.touchVector.y) > 0.2));
        if (moving) { clearInterval(cancelIfMoving); this._returnToLoco(0.35); }
      }, 50);
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
  _returnToLoco(blend = 0.45) {
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
    const alpha = this.camera.alpha;
    return new BABYLON.Vector3(-Math.cos(alpha), 0, -Math.sin(alpha)).normalize();
  }
  _camRight(fwd) {
    const alpha = this.camera.alpha;
    return new BABYLON.Vector3(-Math.sin(alpha), 0, Math.cos(alpha)).normalize();
  }

  _isMeshCharacter(mesh) {
    if (!mesh) return false;
    if (mesh === this.root || mesh === this.visualMesh) return true;

    // Check if it shares any skeleton in the scene that is currently active on our visual mesh
    if (mesh.skeleton) {
      const activeSkel = this.visualMesh.skeleton ||
        (this.visualMesh.getChildMeshes && this.visualMesh.getChildMeshes().find(m => m.skeleton)?.skeleton);
      if (activeSkel && mesh.skeleton === activeSkel) {
        return true;
      }
    }

    // Traverse parent hierarchy to see if it belongs to this character
    let p = mesh.parent;
    while (p) {
      if (p === this.root || p === this.visualMesh) return true;
      if (typeof p.getParent === 'function') {
        p = p.getParent();
      } else {
        p = p.parent;
      }
    }

    // Check name pattern matching
    const lowerName = (mesh.name || "").toLowerCase();
    if (lowerName.includes("character") || lowerName.includes("playercapsule") || lowerName.includes("autorig") || lowerName.includes("wrapper")) {
      return true;
    }

    return false;
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
      originYOffset = (usingCrouchShape ? -0.62 : -0.82) * this._capScaleY;
    } else {
      // For kinematic, read the LIVE ellipsoid.y so the offset tracks the smooth lerp transition.
      // ellipsoid.y is the half-height; capsule bottom = -ellipsoid.y + ellipsoidOffset.y
      const liveHalfH = this.root.ellipsoid ? this.root.ellipsoid.y : this._standEllipsoidY;
      const liveOffY = this.root.ellipsoidOffset ? this.root.ellipsoidOffset.y : 0;
      // Place ray origin 0.08m above the actual capsule bottom to avoid starting inside the ground
      originYOffset = -(liveHalfH) + liveOffY + 0.08 * this._capScaleY;
    }

    // Use a longer ray length on stairs/ramps (scalable meshes) or when rolling to bridge drops and prevent micro-airborne jitter.
    // On flat ground, we use a tight ray (0.20m in kinematic, 0.26m in physics) so that the character snaps instantly and never floats.
    // _wasOnScalable persists the extended ray one extra frame so descending a ramp/stair edge doesn't miss.
    // Add a small extra buffer (0.12m) while crouching is active to absorb the transition frames where
    // the ellipsoid hasn't fully settled yet and the ray might otherwise just miss the ground.
    const baseRayLen = (this.usePhysics ? 0.36 : 0.28) * this._capScaleY;
    const crouchBuffer = this.crouching ? 0.12 * this._capScaleY : 0;
    const rayLen = (this.onScalable || this._wasOnScalable || this.state === S.ROLL) ? 0.55 * this._capScaleY : (baseRayLen + crouchBuffer);
    const downDir = new BABYLON.Vector3(0, -1, 0);

    const radius = 0.22 * this._capScaleW; // Slightly inset from capsule width
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
        return mesh.checkCollisions && !this._isMeshCharacter(mesh);
      });

      if (pick && pick.hit) {
        hitAny = true;
        this._groundNormal = pick.getNormal(true);
        this._groundMesh = pick.pickedMesh;
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
      this._groundMesh = null;
    }

    this._wasOnScalable = this.onScalable;
    this.onScalable = onScalable;
    return hitAny;
  }

  _isCeilingBlocked() {
    let rayStart, rayLen;
    if (this.usePhysics) {
      // Start raycast just below the top of the crouched head (0.60m above capsule center)
      rayStart = this.root.position.add(new BABYLON.Vector3(0, 0.60 * this._capScaleY, 0));
      // Ray length needs to reach the standing height plus clearance margin
      rayLen = 0.65 * this._capScaleY;
    } else {
      // Start raycast at the bottom of the feet (ground level) instead of the capsule center
      // to avoid starting the ray inside/above a low ceiling, which would fail to detect it.
      rayStart = this.root.position.add(new BABYLON.Vector3(0, -0.9 * this._capScaleY, 0));
      // Ray length needs to reach the full standing height (2 * ellipsoidY = 1.92m) plus clearance margin
      rayLen = (this._standEllipsoidY * 2.0) + 0.1;
    }

    const upDir = new BABYLON.Vector3(0, 1, 0);
    const ray = new BABYLON.Ray(rayStart, upDir, rayLen);
    const pick = this.scene.pickWithRay(ray, (mesh) => {
      return mesh.checkCollisions && !this._isMeshCharacter(mesh);
    });

    return !!(pick && pick.hit);
  }

  _canUncrouch() {
    if (!this.crouching) return true;
    return !this._isCeilingBlocked();
  }

  // ── MOVING PLATFORMS ───────────────────────────────────
  // Ride animated platforms: the character's position is anchored in the
  // platform's local space at the end of each frame; at the start of the next
  // frame the anchor is re-projected through the platform's NEW world matrix
  // and the resulting delta (translation + yaw) is applied to the capsule.
  // Works for translating, rotating and orbiting platforms in both physics and
  // kinematic modes without any parenting (collisions stay intact).
  _applyMovingPlatform() {
    const st = this._platformState;
    if (!st || !this.MOVING_PLATFORMS) return;
    const mesh = st.mesh;
    if (!mesh || mesh.isDisposed()) { this._platformState = null; return; }
    const m = mesh.computeWorldMatrix(true);
    const ridePos = BABYLON.Vector3.TransformCoordinates(st.localPos, m);
    const delta = ridePos.subtract(st.worldPos);
    const mm = m.m;
    const newYaw = Math.atan2(mm[8], mm[10]);
    let dYaw = newYaw - st.yaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    // Teleport guard: a platform jumping more than ~1.5 capsule heights or
    // snapping its yaw is being repositioned by gameplay code — don't follow.
    if (delta.length() > 1.5 * this._capScaleY || Math.abs(dYaw) > 0.5) return;
    if (delta.lengthSquared() > 1e-10) this.root.position.addInPlace(delta);
    if (Math.abs(dYaw) > 1e-6) {
      this.rotY += dYaw;
      if (this.usePhysics) {
        this.root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(this.rotY, 0, 0);
      } else {
        this.root.rotation.y = this.rotY;
      }
    }
  }

  _recordPlatformState() {
    const mesh = this.grounded && this.MOVING_PLATFORMS ? this._groundMesh : null;
    if (!mesh) { this._platformState = null; return; }
    const inv = BABYLON.Matrix.Invert(mesh.computeWorldMatrix(true));
    const mm = mesh.getWorldMatrix().m;
    this._platformState = {
      mesh,
      localPos: BABYLON.Vector3.TransformCoordinates(this.root.position, inv),
      worldPos: this.root.position.clone(),
      yaw: Math.atan2(mm[8], mm[10]),
    };
  }

  // ── MANTLE ASSIST ──────────────────────────────────────
  // Jumping while facing a chest-high ledge boosts the jump to exactly clear
  // it and seeds forward momentum, so the character lands on top instead of
  // bouncing off the wall. Probes: obstacle at chest height → ledge top via a
  // downward ray ahead → headroom above the ledge. Returns true when boosted.
  _tryMantle() {
    const sy = this._capScaleY, sw = this._capScaleW;
    const dir = new BABYLON.Vector3(Math.sin(this.rotY), 0, Math.cos(this.rotY));
    const notMe = (mesh) => mesh.checkCollisions && !this._isMeshCharacter(mesh);
    // 1. Wall at chest height directly ahead
    const chestStart = this.root.position.add(new BABYLON.Vector3(0, -0.30 * sy, 0));
    const wallPick = this.scene.pickWithRay(
      new BABYLON.Ray(chestStart, dir, this._standEllipsoidWidth + 0.35 * sw), notMe);
    if (!wallPick || !wallPick.hit) return false;
    // 2. Ledge top: cast down from above, slightly past the wall face
    const ahead = wallPick.distance + 0.25 * sw;
    const topStart = this.root.position.add(dir.scale(ahead)).add(new BABYLON.Vector3(0, 1.2 * sy, 0));
    const topPick = this.scene.pickWithRay(
      new BABYLON.Ray(topStart, new BABYLON.Vector3(0, -1, 0), 2.2 * sy), notMe);
    if (!topPick || !topPick.hit || !topPick.pickedPoint) return false;
    const bottomY = this.root.position.y - 0.9 * sy;
    const rise = topPick.pickedPoint.y - bottomY;
    if (rise < 0.45 * sy || rise > 1.35 * sy) return false;
    // 3. Headroom above the landing spot for a standing capsule
    const clearStart = topPick.pickedPoint.add(new BABYLON.Vector3(0, 0.15 * sy, 0));
    const clearPick = this.scene.pickWithRay(
      new BABYLON.Ray(clearStart, new BABYLON.Vector3(0, 1, 0), 1.8 * sy), notMe);
    if (clearPick && clearPick.hit) return false;
    // Boost: clear the ledge with a small margin + forward momentum
    this.jumpVel = Math.max(this.jumpVel, Math.sqrt(2 * this.GRAV * (rise + 0.35 * sy)));
    this.moveDir.copyFrom(dir);
    this.speed = Math.max(this.speed, this.SPD_WALK * 1.2);
    return true;
  }

  // ── SKELETON-NODE DRIVERS ──────────────────────────────
  // Post-animation layers written on top of the evaluated pose each frame
  // (onBeforeRender fires after animation evaluation): head look-at, forearm
  // twist distribution and slope foot planting. All are lazy, name-driven and
  // silently inactive when the rig lacks the needed nodes.
  _updateBoneDrivers(dt) {
    if (!this._boneDriversInit) this._initBoneDrivers();
    this._updateFootPlanting(dt);
    this._updateHeadLook(dt);
    this._updateTwistDrivers(dt);
  }

  /** Re-scan the skeleton nodes (call after swapping the character mesh). */
  refreshBoneDrivers() {
    this._boneDriversInit = false;
  }

  _initBoneDrivers() {
    this._boneDriversInit = true;
    this._headNode = null;
    this._twistDrivers = [];
    this._footNodes = [];
    const byNorm = new Map();
    for (const n of this.visualMesh.getDescendants(false)) {
      if (!n.getClassName || (n.getClassName() !== 'TransformNode' && n.getClassName() !== 'Mesh')) continue;
      const key = normBone(n.name);
      if (key && !byNorm.has(key)) byNorm.set(key, n);
    }
    this._headNode = byNorm.get('head') || null;
    for (const side of ['left', 'right']) {
      const foot = byNorm.get(side + 'foot');
      if (foot) this._footNodes.push(foot);
      const twist = byNorm.get(side + 'forearmtwist');
      const hand = byNorm.get(side); // normBone('LeftHand') → 'left'
      if (twist && hand && hand.parent === twist.parent) {
        // Twist axis: bone direction (hand local translation in forearm space).
        // Autorig twist rigs bind with identity local rotations, so the same
        // axis is valid in the rest frames used by the decomposition below.
        const axis = hand.position.clone();
        if (axis.lengthSquared() > 1e-10) {
          axis.normalize();
          this._twistDrivers.push({ twist, hand, axis, rest: null, twistRest: null });
        }
      }
    }
  }

  _updateHeadLook(dt) {
    const node = this._headNode;
    if (!node || !this.HEAD_LOOK || !this.camera) return;
    const inLoco = !this._isInAction() && !this.sitting && this.state !== S.ROLL;
    this._headLookWeight = lerp(this._headLookWeight, inLoco ? 1 : 0, 1 - Math.exp(-6 * dt));
    const camFwd = this._camForward();
    const camYaw = Math.atan2(camFwd.x, camFwd.z);
    let dYaw = camYaw - this.rotY;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    // Camera looking at the face (over-shoulder threshold): relax to neutral
    const yawTgt = Math.abs(dYaw) > 2.2 ? 0 : Math.max(-0.9, Math.min(0.9, dYaw));
    const pitchTgt = Math.max(-0.5, Math.min(0.5, (Math.PI / 2 - this.camera.beta) * 0.6));
    this._headLookYaw = lerpAngle(this._headLookYaw, yawTgt, 1 - Math.exp(-8 * dt));
    this._headLookPitch = lerp(this._headLookPitch, pitchTgt, 1 - Math.exp(-8 * dt));
    const w = this._headLookWeight;
    const yaw = this._headLookYaw * w, pitch = this._headLookPitch * w;
    if (Math.abs(yaw) < 0.005 && Math.abs(pitch) < 0.005) return;
    const parent = node.parent;
    if (!parent || !node.rotationQuaternion) return;
    parent.computeWorldMatrix(true);
    const pRot = new BABYLON.Quaternion();
    parent.getWorldMatrix().decompose(undefined, pRot, undefined);
    // World-space delta: yaw about world up, pitch about the head's right axis
    const rightAxis = new BABYLON.Vector3(Math.cos(this.rotY + yaw), 0, -Math.sin(this.rotY + yaw));
    const worldDelta = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), yaw)
      .multiply(BABYLON.Quaternion.RotationAxis(rightAxis, pitch));
    // local' = inv(parentWorld) · delta · parentWorld · localAnim
    const pInv = pRot.conjugate();
    node.rotationQuaternion = pInv.multiply(worldDelta).multiply(pRot).multiply(node.rotationQuaternion);
  }

  _updateTwistDrivers() {
    if (!this.TWIST_DRIVER) return;
    for (const d of this._twistDrivers) {
      const q = d.hand.rotationQuaternion;
      if (!q) continue;
      if (!d.rest) {
        d.rest = q.clone();
        d.twistRest = d.twist.rotationQuaternion ? d.twist.rotationQuaternion.clone() : BABYLON.Quaternion.Identity();
      }
      // Rotation since rest, then swing-twist decomposition about the bone axis
      const rel = d.rest.conjugate().multiply(q);
      const a = d.axis;
      const dot = rel.x * a.x + rel.y * a.y + rel.z * a.z;
      let tx = a.x * dot, ty = a.y * dot, tz = a.z * dot, tw = rel.w;
      const len = Math.sqrt(tx * tx + ty * ty + tz * tz + tw * tw);
      if (len < 1e-6) continue;
      let twq = new BABYLON.Quaternion(tx / len, ty / len, tz / len, tw / len);
      if (twq.w < 0) twq.scaleInPlace(-1); // shortest arc
      // The twist bone takes half of the hand's roll → smooth wrist deformation
      const half = BABYLON.Quaternion.Slerp(BABYLON.Quaternion.Identity(), twq, 0.5);
      d.twist.rotationQuaternion = d.twistRest.multiply(half);
    }
  }

  // Pelvis drop on slopes/steps while standing: lowers the visual mesh so the
  // downhill foot reaches the ground instead of floating. Purely visual (the
  // capsule is untouched) and fades out while moving or acting.
  _updateFootPlanting(dt) {
    let target = 0;
    if (this.FOOT_PLANTING && this.grounded && this.speed < 0.5 && !this.crouching &&
      this._footNodes.length === 2 && !this._isInAction()) {
      const baseY = this.visualMesh.getAbsolutePosition().y;
      const down = new BABYLON.Vector3(0, -1, 0);
      let minDelta = 0;
      for (const f of this._footNodes) {
        f.computeWorldMatrix(true);
        const wp = f.getAbsolutePosition();
        const pick = this.scene.pickWithRay(
          new BABYLON.Ray(new BABYLON.Vector3(wp.x, this.root.position.y, wp.z), down, 2.2 * this._capScaleY),
          (mesh) => mesh.checkCollisions && !this._isMeshCharacter(mesh));
        if (pick && pick.hit && pick.pickedPoint) {
          const delta = pick.pickedPoint.y - baseY; // negative → ground below the feet plane here
          if (delta < minDelta) minDelta = delta;
        }
      }
      target = Math.max(minDelta, -0.22 * this._capScaleY);
    }
    this._pelvisDrop = lerp(this._pelvisDrop, target, 1 - Math.exp(-10 * dt));
    if (Math.abs(this._pelvisDrop) > 0.001) this.visualMesh.position.y += this._pelvisDrop;
  }

  // ── UPDATE ─────────────────────────────────────────────
  // Frame hitches used to be dropped entirely (dt > 0.1 → no simulation), which
  // froze the character while wall-clock time kept running. Long frames are now
  // split into up to 3 equal substeps of ≤50ms each: raycasts and collisions
  // run per substep (less tunneling on hitches) and every exponential smoothing
  // term (1-exp(-k·dt)) composes exactly, so behavior at normal framerates is
  // bit-identical to the single-step path.
  _update() {
    let dt = this.scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;
    if (dt > 0.25) dt = 0.25; // tab switch / debugger pause: cap the catch-up
    const steps = Math.min(3, Math.max(1, Math.ceil(dt / 0.05)));
    const subDt = dt / steps;
    for (let i = 0; i < steps; i++) this._simulate(subDt);
  }

  _simulate(dt) {
    if (dt <= 0 || dt > 0.1) return;
    this._pollGamepad();
    this._applyMovingPlatform(dt);
    this.stateT += dt;
    this._timeSinceSpawn += dt;

    // Camera vectors are no longer frozen during drag under standard camera mode
    // so the character turns progressively as the camera rotates, instead of snapping on release.
    this._frozenCamFwd = null;
    this._frozenCamRgt = null;

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
    if (Math.abs(this.gamepadVector.x) > 0.01 || Math.abs(this.gamepadVector.y) > 0.01) {
      inputX = this.gamepadVector.x;
      inputZ = this.gamepadVector.y;
    }

    const isSprinting = this.sprinting;
    const inputMag = Math.min(1.0, Math.sqrt(inputX * inputX + inputZ * inputZ));
    const hasMove = inputMag > 0.15;

    // Probing Ground via Raycasting (bypass when rising from a jump)
    const wasGrounded = this.grounded;
    const isJumpingOrRolling = this.state === S.JUMP_START || this.state === S.JUMP_LOOP || this.state === S.ROLL;
    if (this.usePhysics) {
      if (this.jumpVel > 0.1 || (isJumpingOrRolling && currentVelocity.y > 0.1)) {
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
          this.grounded = !isJumpingOrRolling && (this._lastGroundedFrame <= 2) && Math.abs(currentVelocity.y) < 3.5;
        }
      }
    } else {
      if (this.jumpVel > 0.1) {
        this.grounded = false;
      } else {
        this.grounded = this._checkGrounded();
      }
    }

    // Coyote timer: resets while grounded, counts up in the air. Read by the
    // JUMP handler so a press shortly after leaving a ledge still succeeds.
    this._coyoteTimer = this.grounded ? 0 : this._coyoteTimer + dt;

    // Landing / roll recovery
    let landingTriggered = false;
    let _snapVelY = 0;
    let inAction = this._isInAction();
    // Buffered jump: a JUMP press taken while airborne (too early to act on)
    // fires the instant landing is detected, instead of being dropped.
    if (this._jumpBufferTimer >= 0) {
      if (this.grounded && !inAction) {
        this._jump();
        this._jumpBufferTimer = -1;
      } else if (this._jumpBufferTimer > this.JUMP_BUFFER) {
        this._jumpBufferTimer = -1; // window expired, discard
      } else {
        this._jumpBufferTimer += dt;
      }
    }
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

    inAction = this._isInAction();

    // Calculate movement direction vector 'dir' early so it is available for vertical snap/slope calculations
    let dir = new BABYLON.Vector3(0, 0, 0);
    const canMove = !inAction || this.state === S.JUMP_START || this.state === S.JUMP_LOOP || this.state === S.JUMP_LAND;

    if (canMove && !this.sitting) {
      if (this.CAM_FOLLOW_LOCK) {
        if (!this.grounded && !this.AIR_CONTROL) {
          dir.copyFrom(this.moveDir);
        } else {
          // Perform horizontal steering rotation early so 'dir' reflects it
          if (inputX !== 0) {
            const steerSpeed = 2.8 * this.SPEED_MULTIPLIER; // Radians per second
            this.rotY += inputX * steerSpeed * dt;
            if (this.usePhysics) {
              this.root.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(this.rotY, 0, 0);
            } else {
              this.root.rotation.y = this.rotY;
            }
          }
          if (inputZ !== 0) {
            dir.copyFromFloats(Math.sin(this.rotY), 0, Math.cos(this.rotY)).normalize();
            if (inputZ < 0) dir.scaleInPlace(-1);
          }
        }
      } else {
        const camFwd = this._camForward();
        const camRgt = this._camRight(camFwd);
        const fwd = (this._frozenCamFwd && !this.CAM_FOLLOW_LOCK) ? this._frozenCamFwd : camFwd;
        const rgt = (this._frozenCamRgt && !this.CAM_FOLLOW_LOCK) ? this._frozenCamRgt : camRgt;

        if (!this.grounded) {
          if (this.AIR_CONTROL) {
            if (hasMove) {
              dir = rgt.scale(inputX).add(fwd.scale(inputZ));
              if (dir.length() > 0.01) dir.normalize();
            }
          } else {
            dir.copyFrom(this.moveDir);
          }
        } else {
          if (hasMove) {
            dir = rgt.scale(inputX).add(fwd.scale(inputZ));
            if (dir.length() > 0.01) dir.normalize();
          }
        }
      }
    }

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
            return mesh.checkCollisions && !this._isMeshCharacter(mesh);
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
            // Apply snap down on stairs or flat parts of scalable meshes.
            // On slanted ramps, the projected Y velocity (velocity.y) handles slope tracking perfectly.
            const dot = this._groundNormal ? BABYLON.Vector3.Dot(dir, this._groundNormal) : 0;
            if (hasMove && this.onScalable && Math.abs(dot) <= 0.01) {
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
          return mesh.checkCollisions && !this._isMeshCharacter(mesh);
        });
        if (pick && pick.hit) {
          const availableSpace = Math.max(0, pick.distance - this._standEllipsoidWidth - margin);
          safeMaxOffsetZ = Math.min(safeMaxOffsetZ, availableSpace);
        }
      }

      // Scale offset based on speed ratio and the safe maximum offset
      // The forward collision offset is useful in follow-lock locomotion, where
      // facing is stable. In free camera-relative locomotion the character yaw
      // continuously follows the input direction; rotating an off-center
      // ellipsoid every frame makes its collision center orbit and the solver
      // visibly jitters during lateral circles.
      const targetOffsetZ = this.CAM_FOLLOW_LOCK
        ? (this.speed / this.SPD_SPRINT) * safeMaxOffsetZ * localMoveSign
        : 0;
      this.localOffsetZ = this.CAM_FOLLOW_LOCK
        ? lerp(this.localOffsetZ || 0, targetOffsetZ, 1 - Math.exp(-4 * dt))
        : 0;

      // Instant safety clamp: ensure the active offset never exceeds the physical space detected in this frame
      this.localOffsetZ = Math.max(-safeMaxOffsetZ, Math.min(safeMaxOffsetZ, this.localOffsetZ));

      // Smoothly interpolate collision ellipsoid size & offset to prevent sudden camera/physics glitches (slowed down to 4 for premium fluid feel)
      if (this.root.ellipsoid) {
        this.root.ellipsoid.y = lerp(this.root.ellipsoid.y, targetEllipsoidY, 1 - Math.exp(-4 * dt));
        this.root.ellipsoidOffset.y = lerp(this.root.ellipsoidOffset.y, targetOffset, 1 - Math.exp(-4 * dt));

        // Transform local Z offset to world space based on character rotation (Y-axis)
        this.root.ellipsoidOffset.x = this.CAM_FOLLOW_LOCK ? this.localOffsetZ * Math.sin(this.rotY) : 0;
        this.root.ellipsoidOffset.z = this.CAM_FOLLOW_LOCK ? this.localOffsetZ * Math.cos(this.rotY) : 0;

        const newWidth = lerp(this.root.ellipsoid.x, targetEllipsoidWidth, 1 - Math.exp(-4 * dt));
        this.root.ellipsoid.x = newWidth;
        this.root.ellipsoid.z = newWidth;
      }
    }

    // ── PROCESS HORIZONTAL PHYSICS (LOCOMOTION) ────────────
    if (canMove && !this.sitting) {
      if (this.CAM_FOLLOW_LOCK) {
        if (this.grounded || this.AIR_CONTROL) {
          // Direct Target Speed (only W/S drives physical movement speed)
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

          let rate = inputZ !== 0 ? this.ACCEL : this.DECEL;
          if (inputZ !== 0 && this.ACCEL_CURVE && tgt > 0.01) rate = apexAccelRate(rate, this.speed / tgt);
          this.speed = lerp(this.speed, tgt, 1 - Math.exp(-rate * dt));
          if (this.speed < 0.05) this.speed = 0;
        }
      } else {
        // ── STANDARD CAMERA-RELATIVE LOCOMOTION ────────────
        if (!this.grounded) {
          // Air control logic:
          if (this.AIR_CONTROL) {
            let tgtSpeed = this.speed;
            if (hasMove) {
              let idealTgt = (isSprinting ? this.SPD_SPRINT : this.SPD_WALK) * this.SPEED_MULTIPLIER;
              idealTgt *= inputMag;
              let rate = this.ACCEL;
              if (this.ACCEL_CURVE && idealTgt > 0.01) rate = apexAccelRate(rate, this.speed / idealTgt);
              tgtSpeed = lerp(this.speed, idealTgt, 1 - Math.exp(-rate * dt));
            } else {
              tgtSpeed = lerp(this.speed, 0, 1 - Math.exp(-this.DECEL * dt));
            }
            this.speed = tgtSpeed;
          }
        } else {
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

          let rate = hasMove ? this.ACCEL : this.DECEL;
          if (hasMove && this.ACCEL_CURVE && tgt > 0.01) rate = apexAccelRate(rate, this.speed / tgt);
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
      const intendedDir = dir.clone();
      let wallNormal = null;
      let blockedByWall = false;
      if (hasMove && dir.length() > 0.01) {
        // Ray starts ~0.45 above feet (feet at -0.96 relative to capsule center, so -0.51 relative to center, scaled)
        const rayStart = this.root.position.add(new BABYLON.Vector3(0, -0.51 * this._capScaleY, 0));
        const rayDist = this._standEllipsoidWidth + 0.15; // slightly ahead of capsule edge
        const ray = new BABYLON.Ray(rayStart, dir, rayDist);
        const pick = this.scene.pickWithRay(ray, (mesh) => {
          return mesh.checkCollisions && !this._isMeshCharacter(mesh);
        });
        if (pick && pick.hit) {
          wallNormal = pick.getNormal(true);
        }
      }

      // Project movement direction onto the wall plane if a wall is encountered
      if (wallNormal) {
        wallNormal.y = 0;
        if (wallNormal.lengthSquared() > 1e-8) {
          wallNormal.normalize();
          const dot = BABYLON.Vector3.Dot(dir, wallNormal);
          if (dot < 0) { // Moving towards/into the wall
            dir.subtractInPlace(wallNormal.scale(dot));
            const slideLength = dir.length();
            // A mostly head-on impact leaves almost no tangent movement. Side
            // contact still slides naturally and must not cancel locomotion.
            blockedByWall = dot < -0.55 && slideLength < 0.22;
            if (slideLength > 0.01) {
              dir.normalize();
            } else {
              dir.set(0, 0, 0);
            }
          }
        }
      }

      blockedByWall = blockedByWall || this._collisionBlocked === true;

      if (this.usePhysics) {
        // Havok resolves contacts after setLinearVelocity, so currentVelocity is
        // the previous physics step's real result. Compare only along the
        // requested direction and arm detection after normal acceleration has
        // had time to start, preventing false blocks from rest.
        if (!hasMove || !this.grounded || intendedDir.lengthSquared() < 0.01) {
          this._physicsMoveCommandTime = 0;
          this._physicsBlockedTime = 0;
          this._physicsBlockedDir = null;
        } else {
          const intendedNorm = intendedDir.normalizeToNew();
          const changedDirection = this._physicsBlockedDir &&
            BABYLON.Vector3.Dot(intendedNorm, this._physicsBlockedDir) < 0.75;
          if (changedDirection) {
            this._physicsBlockedTime = 0;
            this._blockedMoveBlend = Math.min(this._blockedMoveBlend || 0, 0.2);
            this._physicsBlockedDir = null;
          }
          this._physicsMoveCommandTime = (this._physicsMoveCommandTime || 0) + dt;
          const actualAlong = Math.max(0,
            currentVelocity.x * intendedNorm.x + currentVelocity.z * intendedNorm.z);
          const armed = this._physicsMoveCommandTime > 0.18 &&
            (this.speed > 0.8 || (this._blockedMoveBlend || 0) > 0.25);
          const stalled = armed && actualAlong < Math.max(0.04, this.speed * 0.18);
          this._physicsBlockedTime = stalled
            ? (this._physicsBlockedTime || 0) + dt
            : Math.max(0, (this._physicsBlockedTime || 0) - dt * 4);
          if (this._physicsBlockedTime > 0.10) {
            blockedByWall = true;
            this._physicsBlockedDir = intendedNorm;
          }
        }
      }

      const blockedTarget = blockedByWall && hasMove && this.grounded ? 1 : 0;
      const blockedRate = blockedTarget ? 16 : 7;
      this._blockedMoveBlend = lerp(this._blockedMoveBlend || 0, blockedTarget, 1 - Math.exp(-blockedRate * dt));
      if (this._blockedMoveBlend > 0.01) {
        // The input remains held, but locomotion speed must reflect physical
        // progress. A fast stop feels like bracing against the obstacle; the
        // slower release lets acceleration resume naturally after clearing it.
        this.speed = lerp(this.speed, 0.12, 1 - Math.exp(-14 * this._blockedMoveBlend * dt));
      }

      if (this.usePhysics) {
        // Step climbing detection
        let stepClimbVelY = 0;
        if ((this.grounded || this._wasClimbingStep) && hasMove && dir.length() > 0.01) {
          // Ray starting just above feet (bottom of capsule is -0.9, so -0.85 relative to center, scaled)
          const lowRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.85 * this._capScaleY, 0));
          const rayDist = 0.7 * this._capScaleW; // slightly ahead of capsule edge (radius + margin)
          const lowRay = new BABYLON.Ray(lowRayStart, dir, rayDist);
          const lowPick = this.scene.pickWithRay(lowRay, (mesh) => {
            return mesh.checkCollisions && !this._isMeshCharacter(mesh);
          });

          if (lowPick && lowPick.hit) {
            // Check high ray at step limit height (0.50 above bottom, so -0.40 relative to center, scaled)
            const highRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.40 * this._capScaleY, 0));
            const highRay = new BABYLON.Ray(highRayStart, dir, rayDist);
            const highPick = this.scene.pickWithRay(highRay, (mesh) => {
              return mesh.checkCollisions && !this._isMeshCharacter(mesh);
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
        // Project movement direction onto ground slope normal for smooth slope traversal in kinematic mode
        let moveVelocity = dir.scale(this.speed);
        let dot = 0;
        if (this.grounded && this._groundNormal) {
          dot = BABYLON.Vector3.Dot(dir, this._groundNormal);
          const slopeDir = dir.subtract(this._groundNormal.scale(dot));
          if (slopeDir.length() > 0.01) {
            slopeDir.normalize();
            moveVelocity = slopeDir.scale(this.speed);
          }
        }

        let snapDown = 0;
        if (this.grounded) {
          if (this.jumpVel > 0.1) {
            snapDown = this.jumpVel;
            this.jumpVel = 0;
          } else {
            // Snap down on flat ground always (settles after jump); on scalable only when moving (prevents ramp sliding)
            if (this.onScalable) {
              if (dot < -0.01) {
                // Moving up a slope: do not snap down to avoid fighting the slope
                snapDown = 0;
              } else if (dot > 0.01) {
                // Moving down a slope: add gentle downward snap pressure
                snapDown = -1.5;
              } else {
                // On stairs or flat parts of scalable meshes:
                // If we are currently climbing up (deltaY is positive), do not snap down!
                const deltaY = this.root.position.y - (this._lastY !== undefined ? this._lastY : this.root.position.y);
                if (deltaY > 0.002) {
                  snapDown = 0;
                } else {
                  snapDown = hasMove ? -1.5 : 0;
                }
              }
            } else {
              snapDown = -3.5;
            }
          }
        } else {
          snapDown = this.jumpVel;
        }

        const horizontalDisplacement = new BABYLON.Vector3(moveVelocity.x * dt, 0, moveVelocity.z * dt);
        const verticalDisplacement = new BABYLON.Vector3(0, (moveVelocity.y + snapDown) * dt, 0);
        const totalDisplacement = horizontalDisplacement.add(verticalDisplacement);

        const beforeMoveX = this.root.position.x;
        const beforeMoveZ = this.root.position.z;
        this.root.moveWithCollisions(totalDisplacement);
        const requestedHorizontal = horizontalDisplacement.length();
        const actualHorizontal = Math.hypot(
          this.root.position.x - beforeMoveX,
          this.root.position.z - beforeMoveZ
        );
        // Same-frame collision result: acceleration and camera motion cannot
        // create false positives. Preserve wall sliding when a meaningful
        // portion of the requested tangent displacement succeeds.
        this._collisionBlocked = hasMove && this.grounded && requestedHorizontal > 1e-4 &&
          actualHorizontal < requestedHorizontal * 0.18;
      }

      if (this.speed > 0) {
        this.moveDir.copyFrom(dir);
      }
    } else if (this.state === S.ROLL) {
      if (this.usePhysics) {
        // Step climbing detection during roll
        let stepClimbVelY = 0;
        if (this._rollMoving && (this.grounded || this._wasClimbingStep)) {
          const lowRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.85 * this._capScaleY, 0));
          const rayDist = 0.7 * this._capScaleW; // slightly ahead of capsule edge (radius + margin)
          const lowRay = new BABYLON.Ray(lowRayStart, this._rollDir, rayDist);
          const lowPick = this.scene.pickWithRay(lowRay, (mesh) => {
            return mesh.checkCollisions && !this._isMeshCharacter(mesh);
          });

          if (lowPick && lowPick.hit) {
            const highRayStart = this.root.position.add(new BABYLON.Vector3(0, -0.40 * this._capScaleY, 0));
            const highRay = new BABYLON.Ray(highRayStart, this._rollDir, rayDist);
            const highPick = this.scene.pickWithRay(highRay, (mesh) => {
              return mesh.checkCollisions && !this._isMeshCharacter(mesh);
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
      const physicallyMoving = activeLocoMove && (this._blockedMoveBlend || 0) < 0.82;
      this._updateLocoAnim(physicallyMoving, isSprinting && (this._blockedMoveBlend || 0) < 0.35, inputZ < -0.2);
    }

    // ── UPDATE PROCEDURAL PARTICLES ────────────────────────
    if (this.PLAY_PARTICLES && this.dustPS) {
      this._syncDustEmitter();

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
        if (this.onScalable) {
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
    const maxUpperSuspension = (this.onScalable ? 0.16 : 0.35) * this._capScaleY;
    this.visualLocalY = Math.max(this.targetLocalY - 0.02 * this._capScaleY, Math.min(this.targetLocalY + maxUpperSuspension, this.visualLocalY));
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
        this._setTimeout(() => {
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

    // Dynamic FOV based on speed (tunnel vision expansion).
    // Skip FOV update during the roll — keep the camera FOV frozen so the
    // speed=0 reset at roll-end doesn't cause any visible zoom-in/out change.
    if (this.state !== S.ROLL && !this._rollActive) {
      const targetFOV = this.DYNAMIC_FOV
        ? (this._initialCameraFOV + (this.speed / this.SPD_SPRINT) * this.DYNAMIC_FOV_MAX)
        : this._initialCameraFOV;
      this.camera.fov = lerp(this.camera.fov, targetFOV, 1 - Math.exp(-6 * dt));
    }

    // 5. Camera Angle Movement (Drone-style Banking)
    // Roll the camera slightly when moving laterally at speed, like a chase drone banking into the move
    if (this._camTilt === undefined) this._camTilt = 0;
    // Lazily hook pointer drag tracking (works regardless of CAM_FOLLOW_LOCK, which freezes alpha)
    if (!this._camTiltPointerInit) {
      this._camTiltPointerInit = true;
      this._camTiltDragPx = 0;
      this._camTiltPointerObserver = this.scene.onPointerObservable.add((pi) => {
        if (pi.type === BABYLON.PointerEventTypes.POINTERMOVE && pi.event && pi.event.buttons > 0) {
          this._camTiltDragPx += pi.event.movementX || 0;
        }
      });
    }
    let targetCamTilt = 0;
    const camDragVel = this._camTiltDragPx / Math.max(dt, 0.001); // horizontal drag speed in px/s
    this._camTiltDragPx = 0;
    // Smooth the raw per-frame drag velocity to avoid jitter from discrete mouse events
    if (this._camDragVelSmooth === undefined) this._camDragVelSmooth = 0;
    this._camDragVelSmooth = lerp(this._camDragVelSmooth, camDragVel, 1 - Math.exp(-3.5 * dt));
    if (this.CAM_TILT) {
      // Bank from mouse/touch camera drag speed (drone orbiting feel).
      // Soft deadzone: subtract the threshold so the response stays continuous (no on/off popping).
      const dragMag = Math.max(0, Math.abs(this._camDragVelSmooth) - 30);
      targetCamTilt += -Math.sign(this._camDragVelSmooth) * dragMag * 0.0015 * this.CAM_TILT_AMOUNT;

      if (this.speed > 0.5 && !inAction) {
        // Lateral input relative to the camera (strafe direction)
        let lateralX = 0;
        if (this._isPressed('MOVE_LEFT')) lateralX -= 1;
        if (this._isPressed('MOVE_RIGHT')) lateralX += 1;
        if (this.isTouch && Math.abs(this.touchVector.x) > 0.01) lateralX = this.touchVector.x;
        // Bank into lateral movement; also add a touch of bank from yaw turning for fluid arcs.
        // The raw per-frame turn rate is noisy, so keep a smoothed copy for the tilt only.
        if (this._camTurnVelSmooth === undefined) this._camTurnVelSmooth = 0;
        this._camTurnVelSmooth = lerp(this._camTurnVelSmooth, turnDelta / Math.max(dt, 0.001), 1 - Math.exp(-4 * dt));
        targetCamTilt += (-lateralX * 0.85 - this._camTurnVelSmooth * 0.04) * this.CAM_TILT_AMOUNT * currentSpeedRatio;
      }
      // Clamp to the configured maximum bank
      targetCamTilt = Math.max(-this.CAM_TILT_AMOUNT, Math.min(this.CAM_TILT_AMOUNT, targetCamTilt));
    }
    this._camTilt = lerp(this._camTilt, targetCamTilt, 1 - Math.exp(-2.5 * dt));
    if (Math.abs(this._camTilt) > 0.0005) {
      // Derive viewDir from rotY + CAM_FOLLOW_PITCH — controller-owned values that are
      // never contaminated by the tilted upVector feeding back into Babylon's alpha/beta.
      const yaw = -this.rotY - Math.PI / 2;
      const pitch = this.CAM_FOLLOW_PITCH;
      const sinP = Math.sin(pitch);
      const viewDir = new BABYLON.Vector3(
        -Math.cos(yaw) * sinP,
        -Math.cos(pitch),
        -Math.sin(yaw) * sinP
      ).normalize();
      const tiltMatrix = BABYLON.Matrix.RotationAxis(viewDir, this._camTilt);
      this.camera.upVector = BABYLON.Vector3.TransformNormal(BABYLON.Vector3.Up(), tiltMatrix);
    } else if (this.camera.upVector.x !== 0 || this.camera.upVector.z !== 0 || this.camera.upVector.y !== 1) {
      this.camera.upVector = BABYLON.Vector3.Up();
    }

    // Lock camera behind the character if follow lock is active
    if (!this.CAM_FOLLOW_LOCK && this.camera.angularSensibilityX === 999999999) {
      const scaleY = this._capScaleY || 1.0;
      this.camera.angularSensibilityX = (this._originalSensibilityX || 1000) / scaleY;
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

    // ── SKELETON-NODE DRIVERS (head look, forearm twist, foot planting) ────
    this._updateBoneDrivers(dt);

    // Anchor the moving-platform ride point AFTER this frame's own movement
    this._recordPlatformState();

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

      // Sinks 8 cm relative to rest pose for a smooth visual crouch down.
      // Physics mode: capsule bottom is fixed; targetLocalY already set by the shape-switch path.
      if (!this.usePhysics) {
        this.targetLocalY = this._standMeshY - 0.08 * this._capScaleY;
      }

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
    const isMouseOrTouchTurning = this._pointerDragging && (performance.now() - (this._lastYawTurnTime || 0)) < 100;
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
    if (this._recenterObserver) {
      this.scene.onBeforeRenderObservable.remove(this._recenterObserver);
      this._recenterObserver = null;
    }

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
        if (this._recenterObserver === obs) this._recenterObserver = null;
      }
    });
    this._recenterObserver = obs;
  }
}

// ═══════════════════════════════════════════════════════════
// SHARED PHYSICS INITIALIZATION HELPER
// ═══════════════════════════════════════════════════════════
async function initPhysics(scene, gravityOrOptions = null, maybeOptions = {}) {
  const looksLikeVector = gravityOrOptions &&
    Number.isFinite(gravityOrOptions.x) && Number.isFinite(gravityOrOptions.y) && Number.isFinite(gravityOrOptions.z);
  const gravity = looksLikeVector ? gravityOrOptions : new BABYLON.Vector3(0, -22, 0);
  const options = looksLikeVector ? maybeOptions : (gravityOrOptions || {});
  const storage = options.storage ||
    (options.persistPreferences === true && typeof localStorage !== 'undefined' ? localStorage : null);
  let physicsOverride = null;
  if (options.usePhysics === false) physicsOverride = 'false';
  else if (options.usePhysics === true) physicsOverride = 'true';
  else {
    try { physicsOverride = storage?.getItem('use-physics') ?? null; } catch (_) { physicsOverride = null; }
  }
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
      try { storage?.removeItem('use-physics'); } catch (_) { /* optional storage */ }
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

  // ── Option B: separate mesh + animations files ───────────────────────────────
  // When animationsFilename is provided, we first try to merge them server-side
  // using /api/merge (same pipeline as the Builder: virtual T-pose + change-of-basis
  // quaternion retargeting via merge_api.mjs). This correctly handles skeletons with
  // different bone orientations (e.g. Mixamo → CC3/UE5).
  // If the server is unavailable, we fall back to BJS AnimatorAvatar (works for
  // same-convention skeletons like Mixamo→Mixamo).
  if (options.animationsFilename) {
    setLoad(10, 'Merging character + animations on server...');
    let serverMerged = false;
    try {
      const healthRes = await fetch('/api/health');
      if (healthRes.ok) {
        setLoad(20, 'Server available — loading files for merge...');
        const assetsPath = options.assetsPath || 'assets/';

        // Fetch both GLBs as ArrayBuffers
        const [charBuf, animBuf] = await Promise.all([
          fetch(assetsPath + options.filename).then(r => { if (!r.ok) throw new Error('char fetch failed'); return r.arrayBuffer(); }),
          fetch(assetsPath + options.animationsFilename).then(r => { if (!r.ok) throw new Error('anim fetch failed'); return r.arrayBuffer(); }),
        ]);

        setLoad(40, 'Sending to server for retargeting...');
        const formData = new FormData();
        formData.append('character', new Blob([charBuf], { type: 'model/gltf-binary' }), options.filename);
        formData.append('animations', new Blob([animBuf], { type: 'model/gltf-binary' }), options.animationsFilename);
        formData.append('options', JSON.stringify({ COMPRESS_OUTPUT: false, ...(options.mergeOptions || {}) }));

        const mergeRes = await fetch('/api/merge', { method: 'POST', body: formData });
        if (!mergeRes.ok) {
          const errBody = await mergeRes.json().catch(() => ({ error: mergeRes.statusText }));
          throw new Error(errBody.error || 'Server merge failed');
        }

        setLoad(65, 'Loading server-merged character...');
        const mergedBuf = await mergeRes.arrayBuffer();
        console.log('[setupCharacter] Server merge OK:', (mergedBuf.byteLength / 1024 / 1024).toFixed(2), 'MB');

        // No charRes to dispose — in Option B we skip the initial ImportMeshAsync
        // and go straight to the server merge, so nothing needs cleaning up here.

        const blob = new Blob([mergedBuf], { type: 'model/gltf-binary' });
        const blobUrl = URL.createObjectURL(blob);
        // Same pattern as builder.js _loadGlbIntoScene: ('', '', blobUrl, scene, null, '.glb')
        const mergedRes = await BABYLON.SceneLoader.ImportMeshAsync('', '', blobUrl, scene, null, '.glb');
        URL.revokeObjectURL(blobUrl);

        if (!mergedRes.meshes || mergedRes.meshes.length === 0) {
          throw new Error('Merged GLB loaded but contained no meshes');
        }

        serverMerged = true;

        // Reassign charRoot/charRes from merged result
        const mergedRoot = mergedRes.meshes[0];
        mergedRoot.name = 'Character_Visual';
        mergedRes.meshes.forEach(m => {
          if (options.shadow) options.shadow.addShadowCaster(m, true);
          m.receiveShadows = true;
          m.isPickable = false;
          m.checkCollisions = false;
        });
        mergedRes.animationGroups.forEach(ag => ag.stop());
        scene.animationGroups.forEach(ag => ag.stop());

        setLoad(75, 'Building controller...');

        // Capsule
        const capScale = options.capsuleScale || 1;
        const capY = typeof capScale === 'number' ? capScale : (capScale.y !== undefined ? capScale.y : 1);
        const capW = typeof capScale === 'number' ? capScale : Math.max(capScale.x !== undefined ? capScale.x : 1, capScale.z !== undefined ? capScale.z : 1);
        const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.46 * capW, height: 1.8 * capY }, scene);
        playerCapsule.position.copyFrom(options.spawnPosition || new BABYLON.Vector3(0, 2, 0));
        playerCapsule.visibility = 0;
        playerCapsule.isPickable = false;
        playerCapsule.checkCollisions = !usePhysics;
        playerCapsule.ellipsoid = options.ellipsoid || new BABYLON.Vector3(0.46 * capW, 0.96 * capY, 0.46 * capW);
        playerCapsule.ellipsoidOffset = new BABYLON.Vector3(0, 0, 0);

        mergedRoot.setParent(playerCapsule);
        mergedRoot.position.set(0, (usePhysics ? -0.90 : -0.97) * capY, 0);
        mergedRoot.rotation.set(0, 0, 0);

        // Filter T-Pose
        mergedRes.animationGroups.filter(ag => /t[\-_]?pose/i.test(ag.name)).forEach(ag => ag.dispose());
        const filteredGroups = mergedRes.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

        setLoad(90, 'Building controllers...');
        const animCtrl = new AnimCtrl(filteredGroups, scene);
        const charOptions = Object.assign({}, options.charOptions);
        if (options.keys) charOptions.keys = options.keys;
        if (options.config) charOptions.config = options.config;
        if (options.persistPreferences !== undefined) charOptions.persistPreferences = options.persistPreferences;
        if (options.storage) charOptions.storage = options.storage;
        if (options.gamepad !== undefined) charOptions.gamepad = options.gamepad;
        charOptions.usePhysics = !!usePhysics;
        const charCtrl = new CharCtrl(playerCapsule, mergedRoot, camera, animCtrl, scene, charOptions);
        if (typeof options.configure === 'function') {
          options.configure({ animCtrl, charCtrl, filteredGroups, playerCapsule, scene });
        }

        const isMobileDev = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const cameraYOffset = isMobileDev ? -0.25 : 0.4;
        charCtrl._cameraFollowObserver = scene.onBeforeRenderObservable.add(() => {
          const dt = scene.getEngine().getDeltaTime() / 1000;
          const clampedDt = Math.max(0.001, Math.min(0.1, dt));
          const deflection = charCtrl.visualLocalY - charCtrl.targetLocalY;
          const currentScaleY = playerCapsule.scaling.y;
          const tgt = playerCapsule.position.add(new BABYLON.Vector3(0, (cameraYOffset + deflection) * currentScaleY, 0));
          camera.target = BABYLON.Vector3.Lerp(camera.target, tgt, 1 - Math.exp(-15 * clampedDt));
        });

        setLoad(100, 'Ready!');
        return { playerCapsule, charRoot: mergedRoot, animCtrl, charCtrl, scene };
      }
    } catch (serverErr) {
      console.warn('[setupCharacter] Server merge failed, falling back to client retargeting:', serverErr.message);
    }

    if (!serverMerged) {
      // ── Fallback: BabylonJS AnimatorAvatar (client-side, same-convention skeletons) ──
      console.warn('[setupCharacter] Using client-side AnimatorAvatar fallback (may distort cross-convention skeletons)');
    }
  }

  // ── Option A: single merged GLB, OR Option B client-side fallback ──
  setLoad(10, 'Loading character...');
  const mergedCharRes = await BABYLON.SceneLoader.ImportMeshAsync('', options.assetsPath || 'assets/', options.filename || 'character_animated.glb', scene);

  setLoad(75, 'Setting up character...');
  const charRoot = mergedCharRes.meshes[0];
  charRoot.name = 'Character_Visual';

  mergedCharRes.meshes.forEach(m => {
    if (options.shadow) options.shadow.addShadowCaster(m, true);
    m.receiveShadows = true;
    m.isPickable = false;
    m.checkCollisions = false;
  });

  mergedCharRes.animationGroups.forEach(ag => ag.stop());
  scene.animationGroups.forEach(ag => ag.stop());

  const capScale = options.capsuleScale || 1;
  const capY = typeof capScale === 'number' ? capScale : (capScale.y !== undefined ? capScale.y : 1);
  const capW = typeof capScale === 'number' ? capScale : Math.max(capScale.x !== undefined ? capScale.x : 1, capScale.z !== undefined ? capScale.z : 1);
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.46 * capW, height: 1.8 * capY }, scene);
  playerCapsule.position.copyFrom(options.spawnPosition || new BABYLON.Vector3(0, 2, 0));
  playerCapsule.visibility = 0;
  playerCapsule.isPickable = false;
  playerCapsule.checkCollisions = !usePhysics;
  playerCapsule.ellipsoid = options.ellipsoid || new BABYLON.Vector3(0.46 * capW, 0.96 * capY, 0.46 * capW);
  playerCapsule.ellipsoidOffset = new BABYLON.Vector3(0, 0, 0);

  setLoad(90, 'Building controllers...');

  mergedCharRes.animationGroups
    .filter(ag => /t[\-_]?pose/i.test(ag.name))
    .forEach(ag => ag.dispose());
  let filteredGroups = mergedCharRes.animationGroups.filter(ag => !/t[\-_]?pose/i.test(ag.name));

  if (options.animationsFilename) {
    // Client-side fallback retargeting with AnimatorAvatar
    setLoad(80, 'Client retargeting animations...');
    const animRes = await BABYLON.SceneLoader.LoadAssetContainerAsync(options.assetsPath || 'assets/', options.animationsFilename, scene);

    const skeleton = mergedCharRes.skeletons[0] || scene.skeletons[0];
    const avatar = new BABYLON.AnimatorAvatar('avatar', charRoot);

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
    animRes.animationGroups.forEach(sg => {
      sg.targetedAnimations.forEach(ta => {
        const srcNode = ta.target;
        if (!srcNode || !srcNode.name) return;
        const srcName = srcNode.name;
        if (boneMap.has(srcName)) return;
        let matchedName = targetByName.get(srcName.toLowerCase());
        if (!matchedName) {
          const alias = boneAliases[srcName.toLowerCase()];
          if (alias) matchedName = targetByName.get(alias);
        }
        if (!matchedName) {
          const norm = normBone(srcName);
          matchedName = targetByNorm.get(norm);
        }
        if (matchedName) boneMap.set(srcName, matchedName);
      });
    });
    console.log('[setupCharacter] Client fallback — Bone map size:', boneMap.size);

    const retargetedGroups = [];
    // Helper: find the source node name that plays a given skeleton role
    const findSrcRole = (sg, norms) => {
      for (const ta of sg.targetedAnimations) {
        const node = ta.target;
        if (!node || !node.name) continue;
        const n = normBone(node.name);
        if (norms.some(s => n.includes(s) || s.includes(n))) return node.name;
      }
      return null;
    };

    animRes.animationGroups.forEach(sg => {
      const cleanName = cleanAnimName(sg.name);
      const srcRootName = findSrcRole(sg, ['hips', 'pelvis', 'hip']) || 'mixamorig:Hips';
      const srcGroundName = findSrcRole(sg, ['leftfoot', 'footl', 'ankle_l']) || 'mixamorig:LeftFoot';
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
      retargeted.stop();
      scene.addAnimationGroup(retargeted);
      retargetedGroups.push(retargeted);
    });
    animRes.dispose();
    filteredGroups = retargetedGroups;
  }

  charRoot.setParent(playerCapsule);
  charRoot.position.set(0, (usePhysics ? -0.90 : -0.97) * capY, 0);
  charRoot.rotation.set(0, 0, 0);

  const animCtrl = new AnimCtrl(filteredGroups, scene);

  // Allow passing keys, config and other options directly or inside charOptions
  const charOptions = Object.assign({}, options.charOptions);
  if (options.keys) charOptions.keys = options.keys;
  if (options.config) charOptions.config = options.config;
  if (options.persistPreferences !== undefined) charOptions.persistPreferences = options.persistPreferences;
  if (options.storage) charOptions.storage = options.storage;
  if (options.gamepad !== undefined) charOptions.gamepad = options.gamepad;
  charOptions.usePhysics = !!usePhysics;

  const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, charOptions);

  // Allow custom remapping of animations/controls or extra setup from app
  if (typeof options.configure === 'function') {
    options.configure({ animCtrl, charCtrl, filteredGroups, playerCapsule, scene });
  }

  const isMobileDev = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cameraYOffset = isMobileDev ? -0.25 : 0.4;

  charCtrl._cameraFollowObserver = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const clampedDt = Math.max(0.001, Math.min(0.1, dt));
    const deflection = charCtrl.visualLocalY - charCtrl.targetLocalY;
    const currentScaleY = playerCapsule.scaling.y;
    const tgt = playerCapsule.position.add(new BABYLON.Vector3(0, (cameraYOffset + deflection) * currentScaleY, 0));
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
