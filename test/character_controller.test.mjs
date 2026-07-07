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

function makeBabylon() {
  return {
    Vector3, Quaternion, Ray,
    Matrix: { RotationAxis: () => ({}) },
    PointerEventTypes: { POINTERMOVE: 4 },
    ParticleSystem: ParticleSystemMock,
    Texture: class { constructor() { } },
    Color4: class { constructor(r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; } },
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
      // Only downward rays intersect the virtual floor; horizontal/up rays miss.
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

// Advance the simulation: fires every onBeforeRenderObservable observer per frame
function step(env, seconds, dtMs = 1000 / 60) {
  const { world } = env;
  world.dtMs = dtMs;
  const frames = Math.round((seconds * 1000) / dtMs);
  for (let i = 0; i < frames; i++) {
    world.clock.ms += dtMs;
    for (const o of [...world.scene.onBeforeRenderObservable.observers]) o.fn();
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
