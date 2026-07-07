// Deterministic locomotion tests for js/character-controller.js (kinematic mode).
// Runs the real controller script inside a vm sandbox with a minimal BABYLON /
// DOM mock and drives _update() with fixed dt steps against a virtual floor.
//
//   npm test        (node --test test/*.test.mjs)
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTROLLER_SRC = readFileSync(path.join(__dirname, '..', 'js', 'character-controller.js'), 'utf-8');

// ── Minimal BABYLON mock ─────────────────────────────────────
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copyFrom(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  copyFromFloats(x, y, z) { return this.set(x, y, z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z); }
  addInPlace(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  subtract(v) { return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z); }
  subtractInPlace(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  scale(s) { return new Vector3(this.x * s, this.y * s, this.z * s); }
  scaleInPlace(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lengthSquared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.length() || 1; return this.scaleInPlace(1 / l); }
  minimizeInPlace(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); this.z = Math.min(this.z, v.z); return this; }
  maximizeInPlace(v) { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); this.z = Math.max(this.z, v.z); return this; }
  static Zero() { return new Vector3(0, 0, 0); }
  static Up() { return new Vector3(0, 1, 0); }
  static Dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static Lerp(a, b, t) { return new Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  static LerpToRef(a, b, t, ref) { ref.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); return ref; }
  static TransformNormal(v, _m) { return v.clone(); }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; this._yaw = 0; }
  static Identity() { return new Quaternion(); }
  static RotationYawPitchRoll(yaw, pitch, roll) { const q = new Quaternion(); q._yaw = yaw; q._pitch = pitch; q._roll = roll; return q; }
  static RotationYawPitchRollToRef(yaw, pitch, roll, ref) { ref._yaw = yaw; ref._pitch = pitch; ref._roll = roll; return ref; }
  toEulerAngles() { return new Vector3(this._pitch || 0, this._yaw || 0, this._roll || 0); }
}

class Ray {
  constructor(origin, direction, length) { this.origin = origin; this.direction = direction; this.length = length; }
}

class ParticleSystemMock {
  constructor() { this.emitRate = 0; this._started = false; this.manualEmitCount = -1; }
  start() { this._started = true; }
  stop() { this._started = false; }
  dispose() { this._disposed = true; }
  isStarted() { return this._started; }
}
ParticleSystemMock.BLENDMODE_ADD = 1;

class PhysicsShapeCapsuleMock {
  constructor() { this.material = null; }
  dispose() { this._disposed = true; }
}

class PhysicsBodyMock {
  constructor(root) {
    this.root = root;
    this.vel = new Vector3();
    this.disablePreStep = false;
    this.shape = null;
    PhysicsBodyMock.last = this;
  }
  setMassProperties() { }
  getLinearVelocity() { return this.vel.clone(); }
  setLinearVelocity(v) { this.vel.copyFrom(v); }
  setAngularVelocity() { }
  dispose() { this._disposed = true; }
}

function makeBabylon() {
  return {
    Vector3, Quaternion, Ray,
    Matrix: { RotationAxis: () => ({}) },
    PointerEventTypes: { POINTERMOVE: 4 },
    ParticleSystem: ParticleSystemMock,
    Texture: class { constructor() { } },
    Color4: class { constructor(r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; } },
    PhysicsShapeCapsule: PhysicsShapeCapsuleMock,
    PhysicsBody: PhysicsBodyMock,
    PhysicsMotionType: { DYNAMIC: 1 },
  };
}

// ── DOM / browser mock ───────────────────────────────────────
function makeObservable() {
  const observers = [];
  return {
    observers,
    add(fn) { const o = { fn }; observers.push(o); return o; },
    remove(o) { const i = observers.indexOf(o); if (i >= 0) observers.splice(i, 1); },
  };
}

function makeWorld() {
  const clock = { ms: 0 };
  const world = {
    clock,
    dtMs: 1000 / 60,
    // Virtual floor: an infinite horizontal plane at floorY with normal floorNormal.
    floorY: 0,
    floorNormal: new Vector3(0, 1, 0),
    floorMesh: { name: 'ground', checkCollisions: true },
  };

  const engine = {
    getDeltaTime: () => world.dtMs,
    getFps: () => 1000 / world.dtMs,
    getRenderingCanvas: () => null,
  };

  world.scene = {
    onBeforeRenderObservable: makeObservable(),
    onBeforeCameraRenderObservable: makeObservable(),
    onPointerObservable: makeObservable(),
    getEngine: () => engine,
    pickWithRay(ray, predicate) {
      // Upward rays: virtual ceiling plane (world.ceilingY, disabled by default)
      if (ray.direction.y > 0.5) {
        if (world.ceilingY === undefined || world.ceilingY === null) return null;
        if (predicate && !predicate(world.floorMesh)) return null;
        const cDist = world.ceilingY - ray.origin.y;
        if (cDist < 0 || cDist > ray.length) return null;
        return {
          hit: true, distance: cDist, pickedMesh: world.floorMesh,
          getNormal: () => new Vector3(0, -1, 0),
        };
      }
      // Downward rays: virtual floor plane
      if (!(ray.direction.y < -0.5)) return null;
      if (world.floorY === null) return null;
      if (predicate && !predicate(world.floorMesh)) return null;
      const dist = ray.origin.y - world.floorY;
      if (dist < 0 || dist > ray.length) return null;
      return {
        hit: true,
        distance: dist,
        pickedMesh: world.floorMesh,
        getNormal: () => world.floorNormal.clone(),
      };
    },
  };

  world.camera = {
    alpha: -Math.PI / 2, beta: Math.PI / 3, radius: 8, fov: 0.8,
    angularSensibilityX: 1000, angularSensibilityY: 1000,
    upVector: Vector3.Up(),
    inputs: { attached: {} },
    target: new Vector3(),
  };

  world.root = {
    position: new Vector3(0, 0.96, 0), // capsule center: feet exactly on the y=0 floor
    rotation: new Vector3(),
    rotationQuaternion: null,
    scaling: new Vector3(1, 1, 1),
    ellipsoid: new Vector3(0.35, 0.96, 0.35),
    ellipsoidOffset: new Vector3(0, 0, 0),
    moveWithCollisions(disp) {
      this.position.addInPlace(disp);
      // Simple floor collision: never sink below the floor plane
      if (world.floorY !== null && this.position.y - this.ellipsoid.y + this.ellipsoidOffset.y < world.floorY) {
        this.position.y = world.floorY + this.ellipsoid.y - this.ellipsoidOffset.y;
      }
    },
  };

  world.visualMesh = {
    position: new Vector3(0, -0.97, 0),
    rotation: new Vector3(),
    rotationQuaternion: null,
    scaling: new Vector3(1, 1, 1),
    getChildMeshes: () => [],
  };

  world.anim = {
    charCtrl: null,
    g: new Map(),
    curName: '',
    lastPlayed: null,
    lastCallback: null,
    play(name, _loop, _blend, cb) { this.curName = name; this.lastPlayed = name; this.lastCallback = cb || null; },
    has: () => false,
    destroy() { this.destroyed = true; },
    animationEvents: {},
  };

  return world;
}

// ── Sandbox loader ───────────────────────────────────────────
function loadController() {
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const world = makeWorld();
  const listeners = [];
  const windowObj = {
    addEventListener: (t, fn) => listeners.push({ t, fn }),
    removeEventListener: (t, fn) => {
      const i = listeners.findIndex(l => l.t === t && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    matchMedia: () => ({ matches: false }),
  };
  const rafCallbacks = new Map();
  let rafId = 0;
  const ctx = {
    BABYLON: makeBabylon(),
    window: windowObj,
    document: {
      getElementById: () => null,
      addEventListener: () => { },
      removeEventListener: () => { },
      body: { classList: { add: () => { }, remove: () => { } } },
    },
    localStorage,
    navigator: { maxTouchPoints: 0, msMaxTouchPoints: 0, userAgent: 'node-test' },
    performance: { now: () => world.clock.ms },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => { rafId++; rafCallbacks.set(rafId, fn); return rafId; },
    cancelAnimationFrame: (id) => rafCallbacks.delete(id),
    HavokPhysics: undefined,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CONTROLLER_SRC, ctx, { filename: 'character-controller.js' });
  return { ctx, world, windowListeners: listeners, rafCallbacks, storage };
}

function makeCtrl(env, options = {}) {
  const { ctx, world } = env;
  const opts = Object.assign({ usePhysics: false }, options);
  const ctrl = new ctx.window.CharCtrl(world.root, world.visualMesh, world.camera, world.anim, world.scene, opts);
  return ctrl;
}

// Advance the simulation: fires every onBeforeRenderObservable observer per frame.
// When a mock Havok body exists, integrates velocity + gravity like the solver would.
function step(env, seconds, dtMs = 1000 / 60) {
  const { world } = env;
  world.dtMs = dtMs;
  const frames = Math.round((seconds * 1000) / dtMs);
  for (let i = 0; i < frames; i++) {
    world.clock.ms += dtMs;
    for (const o of [...world.scene.onBeforeRenderObservable.observers]) o.fn();
    const body = world.physicsBody;
    if (body) {
      const dt = dtMs / 1000;
      world.root.position.addInPlace(body.vel.scale(dt));
      body.vel.y -= 22 * dt; // Havok world gravity
      // Capsule bottom (physics anchor) sits 0.90 below the capsule center
      if (world.floorY !== null && world.root.position.y - 0.90 < world.floorY) {
        world.root.position.y = world.floorY + 0.90;
        if (body.vel.y < 0) body.vel.y = 0;
      }
    }
  }
}

function pressKey(ctrl, code) {
  ctrl.keys[code] = true;
  ctrl._keyDown(code);
}
function releaseKey(ctrl, code) {
  ctrl.keys[code] = false;
}

// ═════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════

test('usePhysics option overrides localStorage (fallback propagation)', () => {
  const env = loadController();
  env.storage.set('use-physics', 'true'); // stale flag says physics on
  const ctrl = makeCtrl(env, { usePhysics: false }); // ...but Havok init failed
  assert.equal(ctrl.usePhysics, false);
  assert.equal(ctrl.physicsBody, undefined);
});

test('setupCharacter code paths pass usePhysics into charOptions', () => {
  // Static check on the source: both CharCtrl construction sites must set
  // charOptions.usePhysics from the setupCharacter parameter.
  const matches = CONTROLLER_SRC.match(/charOptions\.usePhysics = usePhysics;/g) || [];
  assert.equal(matches.length, 2, 'expected both charOptions builds to propagate usePhysics');
});

test('character grounds on a flat floor and stays put', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  step(env, 1.0);
  assert.equal(ctrl.grounded, true);
  assert.ok(Math.abs(env.world.root.position.y - 0.96) < 0.15, `y=${env.world.root.position.y}`);
});

test('walkable slope (30°) is accepted as ground', () => {
  const env = loadController();
  const a = 30 * Math.PI / 180;
  env.world.floorNormal = new Vector3(Math.sin(a), Math.cos(a), 0);
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  assert.equal(ctrl.grounded, true);
  assert.ok(ctrl._groundNormal, 'ground normal should be captured');
  assert.ok(ctrl._groundNormal.y > 0.8);
});

test('steep slope (>MAX_SLOPE_ANGLE) is rejected — character is not grounded', () => {
  const env = loadController();
  const a = 65 * Math.PI / 180; // 65° > default 50° limit
  env.world.floorNormal = new Vector3(Math.sin(a), Math.cos(a), 0);
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  assert.equal(ctrl.grounded, false);
  assert.equal(ctrl._onSteepSlope, true);
  assert.ok(ctrl.jumpVel < 0, 'gravity should be pulling the character down the slope');
});

test('MAX_SLOPE_ANGLE is configurable', () => {
  const env = loadController();
  const a = 65 * Math.PI / 180;
  env.world.floorNormal = new Vector3(Math.sin(a), Math.cos(a), 0);
  const ctrl = makeCtrl(env, { config: { MAX_SLOPE_ANGLE: 80 } });
  step(env, 0.5);
  assert.equal(ctrl.grounded, true, '65° slope must be walkable with an 80° limit');
});

test('jump rises, falls and lands again', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  assert.equal(ctrl.grounded, true);

  pressKey(ctrl, 'Space');
  assert.equal(ctrl.state, 'JUMP_START');
  assert.equal(ctrl.jumpVel, ctrl.JUMP_PWR);

  step(env, 0.3);
  assert.equal(ctrl.grounded, false);
  assert.ok(env.world.root.position.y > 1.5, `should be airborne, y=${env.world.root.position.y}`);

  step(env, 2.0);
  assert.equal(ctrl.grounded, true, 'must land within 2s');
  assert.ok(Math.abs(env.world.root.position.y - 0.96) < 0.15);
});

test('grounding behaves the same at 30 and 144 FPS (time-based, not frame-based)', () => {
  for (const dtMs of [1000 / 30, 1000 / 144]) {
    const env = loadController();
    const ctrl = makeCtrl(env);
    step(env, 0.5, dtMs);
    assert.equal(ctrl.grounded, true, `grounded at dt=${dtMs.toFixed(1)}ms`);
    pressKey(ctrl, 'Space');
    step(env, 2.5, dtMs);
    assert.equal(ctrl.grounded, true, `landed again at dt=${dtMs.toFixed(1)}ms`);
  }
});

test('coyote time: jump accepted shortly after walking off a ledge, rejected later', () => {
  // Within COYOTE_TIME
  let env = loadController();
  let ctrl = makeCtrl(env);
  step(env, 0.5);
  env.world.floorY = null; // ledge disappears — free fall
  step(env, 0.06); // 60ms airborne < COYOTE_TIME (0.12)
  assert.equal(ctrl.grounded, false);
  pressKey(ctrl, 'Space');
  assert.equal(ctrl.state, 'JUMP_START', 'coyote jump should fire');
  assert.equal(ctrl.jumpVel, ctrl.JUMP_PWR);

  // Past COYOTE_TIME
  env = loadController();
  ctrl = makeCtrl(env);
  step(env, 0.5);
  env.world.floorY = null;
  step(env, 0.3); // 300ms airborne > COYOTE_TIME
  const velBefore = ctrl.jumpVel;
  pressKey(ctrl, 'Space');
  assert.notEqual(ctrl.state, 'JUMP_START', 'late press must not grant a free air jump');
  assert.equal(ctrl.jumpVel, velBefore);
});

test('jump buffering: press just before landing fires a jump on touchdown', () => {
  const env = loadController();
  const ctrl = makeCtrl(env, { config: { DOUBLE_JUMP_ENABLED: false } });
  step(env, 0.5);
  pressKey(ctrl, 'Space'); // first jump
  releaseKey(ctrl, 'Space');
  // Ride the arc until we are clearly descending and close to the ground
  step(env, 0.8);
  assert.equal(ctrl.grounded, false);
  assert.ok(ctrl.jumpVel < 0, 'should be descending');
  pressKey(ctrl, 'Space'); // buffered press while airborne
  releaseKey(ctrl, 'Space');
  step(env, 0.3); // land within JUMP_BUFFER_TIME of the press
  assert.equal(ctrl.state, 'JUMP_START', 'buffered jump should fire on landing');
  assert.equal(ctrl.jumpVel > 0, true);
});

test('long frames are clamped, not skipped', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  const tBefore = ctrl.stateT;
  step(env, 0.5, 500); // one 500ms frame — old code skipped dt > 0.1 entirely
  assert.ok(ctrl.stateT > tBefore, 'update must still run on long frames');
});

test('out-of-bounds recovery teleports to the configured spawn point', () => {
  const env = loadController();
  env.world.root.position.set(3, 5, -2);
  const ctrl = makeCtrl(env); // spawnPoint snapshots the initial position
  env.world.floorY = null;
  ctrl.setSpawnPoint(new Vector3(7, 2, 7));
  env.world.root.position.set(0, -20, 0); // below OUT_OF_BOUNDS_Y (-15)
  step(env, 0.1);
  assert.equal(env.world.root.position.x, 7);
  assert.equal(env.world.root.position.z, 7);
  assert.ok(env.world.root.position.y >= 2 - 0.5);
});

test('AIR_CONTROL accepts a numeric coefficient', () => {
  const env = loadController();
  const ctrl = makeCtrl(env, { config: { AIR_CONTROL: 0.5 } });
  assert.equal(ctrl.AIR_CONTROL, 0.5);
  const env2 = loadController();
  const ctrl2 = makeCtrl(env2, { config: { AIR_CONTROL: true } });
  assert.equal(ctrl2.AIR_CONTROL, 1);
});

test('destroy() cancels timers, removes observers and stops updates', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  step(env, 0.2);

  // Force the lazy camera-tilt pointer observer to exist
  assert.ok(ctrl._camTiltPointerObserver, 'camera-tilt pointer observer must be tracked');
  assert.equal(env.world.scene.onPointerObservable.observers.length, 1);

  // Schedule delayed work, then destroy
  let fired = false;
  ctrl._setTimeout(() => { fired = true; }, 1);
  ctrl._roll(); // arms _rollTimeoutId + rAF polling
  const winListenersBefore = env.windowListeners.length;
  assert.ok(winListenersBefore > 0);

  ctrl.destroy();

  assert.equal(ctrl._destroyed, true);
  assert.equal(ctrl._timeouts.size, 0);
  assert.equal(ctrl._intervals.size, 0);
  assert.equal(ctrl._rafIds.size, 0);
  assert.equal(env.world.scene.onPointerObservable.observers.length, 0, 'pointer observer must be removed');
  assert.equal(env.world.scene.onBeforeRenderObservable.observers.length, 0, 'update observer must be removed');
  assert.equal(env.windowListeners.length, 0, 'window listeners must be removed');

  // A tracked timeout must never fire after destroy
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(fired, false, 'timeout scheduled before destroy must not fire');
    resolve();
  }, 10));
});

test('destroy() is safe to call twice and _update is a no-op afterwards', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  step(env, 0.1);
  ctrl.destroy();
  ctrl.destroy(); // idempotent
  const y = env.world.root.position.y;
  ctrl._update(); // direct call — must be guarded by _destroyed
  assert.equal(env.world.root.position.y, y);
});

test('initPhysics default gravity derives from DEFAULT_CHAR_CONFIG.PHYSICS.GRAV', () => {
  // Static source check: no hardcoded -22 fallback vector left in initPhysics
  assert.match(CONTROLLER_SRC, /DEFAULT_CHAR_CONFIG\.PHYSICS\.GRAV, 0\)/);
  assert.doesNotMatch(CONTROLLER_SRC, /initPhysics\(scene, gravity = new BABYLON\.Vector3\(0, -22, 0\)\)/);
});

// ── New behaviour: pause, persistence, events, ceiling, slide, moonwalk, Havok ──

test('setEnabled(false) freezes input and updates; setEnabled(true) resumes', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  ctrl.setEnabled(false);

  pressKey(ctrl, 'Space');
  assert.notEqual(ctrl.state, 'JUMP_START', 'disabled controller must ignore input');
  const y = env.world.root.position.y;
  const t = ctrl.stateT;
  step(env, 0.3);
  assert.equal(env.world.root.position.y, y, 'disabled controller must not move');
  assert.equal(ctrl.stateT, t, 'disabled controller must not tick');

  ctrl.setEnabled(true);
  step(env, 0.1);
  pressKey(ctrl, 'Space');
  assert.equal(ctrl.state, 'JUMP_START', 're-enabled controller must respond again');
});

test('persistSettings:false — config wins over localStorage and nothing is written', () => {
  const env = loadController();
  env.storage.set('double-jump-enabled', 'false');
  env.storage.set('speed-multiplier', '9');
  const sizeBefore = env.storage.size;
  const ctrl = makeCtrl(env, { persistSettings: false, config: { DOUBLE_JUMP_ENABLED: true } });
  assert.equal(ctrl.DOUBLE_JUMP_ENABLED, true, 'stale localStorage must be ignored');
  assert.equal(ctrl.SPEED_MULTIPLIER, 1.0);
  ctrl.playParticles(false); // method that normally writes localStorage
  assert.equal(env.storage.size, sizeBefore, 'no localStorage writes allowed');
});

test('onJump / onLand / onRoll gameplay events fire with payloads', () => {
  const env = loadController();
  const events = [];
  const ctrl = makeCtrl(env, {
    callbacks: {
      onJump: (e) => events.push(['jump', e]),
      onLand: (e) => events.push(['land', e]),
      onRoll: (e) => events.push(['roll', e]),
    },
  });
  step(env, 0.6); // settle past the initial-spawn grace
  pressKey(ctrl, 'Space');
  releaseKey(ctrl, 'Space');
  assert.equal(events[0][0], 'jump');
  assert.equal(events[0][1].double, false);
  step(env, 2.0);
  const land = events.find(e => e[0] === 'land');
  assert.ok(land, 'onLand must fire');
  assert.ok(land[1].fallHeight > 0.3, `fallHeight=${land[1].fallHeight}`);
  assert.ok(land[1].velocity < 0, 'landing velocity is downward');

  pressKey(ctrl, 'KeyR');
  const roll = events.find(e => e[0] === 'roll');
  assert.ok(roll, 'onRoll must fire');
  assert.equal(typeof roll[1].moving, 'boolean');
});

test('head bump: ascending into a ceiling kills upward velocity', () => {
  const env = loadController();
  env.world.ceilingY = 2.6;
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  pressKey(ctrl, 'Space');
  let maxY = 0;
  for (let i = 0; i < 60; i++) { // 1s at 60fps
    step(env, 1 / 60);
    maxY = Math.max(maxY, env.world.root.position.y);
  }
  // Without the fix the apex is ~3.0 (jump arc ignores the ceiling entirely)
  assert.ok(maxY < 2.0, `apex must stay under the ceiling, got ${maxY.toFixed(2)}`);
  step(env, 1.5);
  assert.equal(ctrl.grounded, true, 'must fall back and land after the bump');
});

test('steep slope: character slides downhill instead of hanging in place', () => {
  const env = loadController();
  const a = 65 * Math.PI / 180; // steeper than the 50° limit, tilted toward +x
  env.world.floorNormal = new Vector3(Math.sin(a), Math.cos(a), 0);
  const ctrl = makeCtrl(env);
  step(env, 1.5);
  assert.equal(ctrl.grounded, false);
  assert.ok(env.world.root.position.x > 0.5,
    `must slide downhill (+x), got x=${env.world.root.position.x.toFixed(2)}`);
});

test('anti-moonwalk: blocked movement feeds ~zero speed to the anim blend tree', () => {
  const env = loadController();
  const locoMock = { lastSpeed: null, updateSpeed(v) { this.lastSpeed = v; } };
  env.world.anim.g.set('Locomotion', locoMock);
  // Wall: horizontal displacement is fully blocked, vertical passes through
  const origMove = env.world.root.moveWithCollisions.bind(env.world.root);
  env.world.root.moveWithCollisions = (disp) => origMove(new Vector3(0, disp.y, 0));
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  ctrl.keys['KeyW'] = true; // hold forward against the wall
  step(env, 1.5);
  assert.ok(ctrl.speed > 1.0, 'logical speed keeps pushing');
  assert.ok(locoMock.lastSpeed !== null && locoMock.lastSpeed < 0.5,
    `anim speed must collapse when blocked, got ${locoMock.lastSpeed}`);
});

test('wall-blocked: no vertical bobbing and no dust while pushing a wall', () => {
  const env = loadController();
  const origMove = env.world.root.moveWithCollisions.bind(env.world.root);
  env.world.root.moveWithCollisions = (disp) => origMove(new Vector3(0, disp.y, 0));
  const ctrl = makeCtrl(env);
  step(env, 0.5);
  ctrl.keys['KeyW'] = true;
  step(env, 1.5); // long enough for _realSpeedSmooth to collapse

  // Bobbing must be off: sample visual Y over a walk-bob period, expect it flat
  const ys = [];
  for (let i = 0; i < 40; i++) { step(env, 1 / 60); ys.push(env.world.visualMesh.position.y); }
  const spread = Math.max(...ys) - Math.min(...ys);
  assert.ok(spread < 0.005, `visual Y must not bounce against a wall, spread=${spread.toFixed(4)}`);
  assert.equal(ctrl._bobTime, 0, 'bob phase must stay reset');
  assert.equal(ctrl.dustPS.emitRate, 0, 'no dust while blocked');

  // Unblock the wall — bobbing resumes while walking
  env.world.root.moveWithCollisions = origMove;
  step(env, 1.0);
  const ys2 = [];
  for (let i = 0; i < 40; i++) { step(env, 1 / 60); ys2.push(env.world.visualMesh.position.y); }
  const spread2 = Math.max(...ys2) - Math.min(...ys2);
  assert.ok(spread2 > 0.005, `bobbing must resume when moving freely, spread=${spread2.toFixed(4)}`);
});

test('environment mesh with "character" in its name is still valid ground', () => {
  const env = loadController();
  const ctrl = makeCtrl(env);
  assert.equal(ctrl._isMeshCharacter({ name: 'character_statue', parent: null }), false);
  assert.equal(ctrl._isMeshCharacter({ name: 'old_wrapper_rock', parent: null }), false);
  assert.equal(ctrl._isMeshCharacter(env.world.root), true);
  assert.equal(ctrl._isMeshCharacter(env.world.visualMesh), true);
  assert.equal(ctrl._isMeshCharacter({ name: 'playerCapsule_2', parent: null }), true);
});

test('Havok mode: grounds, jumps and lands with a physics body', () => {
  const env = loadController();
  const ctrl = makeCtrl(env, { usePhysics: true });
  env.world.physicsBody = ctrl.physicsBody;
  assert.ok(ctrl.physicsBody, 'physics body must be created');
  assert.ok(ctrl._standShape && ctrl._crouchShape);

  step(env, 0.6);
  assert.equal(ctrl.grounded, true, 'must ground on the floor via ray + body');

  pressKey(ctrl, 'Space');
  assert.equal(ctrl.state, 'JUMP_START');
  step(env, 0.3);
  assert.equal(ctrl.grounded, false);
  assert.ok(env.world.root.position.y > 1.3, `airborne, y=${env.world.root.position.y.toFixed(2)}`);

  step(env, 2.5);
  assert.equal(ctrl.grounded, true, 'must land again');
});

test('Havok mode: destroy() disposes body and both capsule shapes', () => {
  const env = loadController();
  const ctrl = makeCtrl(env, { usePhysics: true });
  const body = ctrl.physicsBody;
  ctrl.destroy();
  assert.equal(body._disposed, true);
  assert.equal(ctrl._standShape._disposed, true);
  assert.equal(ctrl._crouchShape._disposed, true);
});

test('runtime swap destroys the old character only AFTER the new load succeeds', () => {
  // Static source checks on loadCharacterRuntime / swapCharacterAnimations
  const body = CONTROLLER_SRC.slice(CONTROLLER_SRC.indexOf('async function loadCharacterRuntime'));
  const destroyIdx = body.indexOf('prevHandle.destroy()');
  const loadIdx = body.indexOf('await setupCharacter');
  assert.ok(loadIdx >= 0 && destroyIdx > loadIdx, 'destroy must come after the awaited load');
  assert.match(body, /setEnabled\(true\)/, 'old character must be re-enabled on failure');
  assert.match(CONTROLLER_SRC, /revokeObjectURL/, 'swap blob URLs must be revoked');
});
