// Type declarations for bjs-character-controller (js/character-controller.js).
// Hand-written; shipped as dist/lib/character-controller.d.ts by `npm run build:lib`.
// Babylon types come from @babylonjs/core (the ES module build of Babylon.js 9).

import type {
  AbstractMesh,
  AnimationGroup,
  ArcRotateCamera,
  Mesh,
  Observable,
  Scene,
  ShadowGenerator,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

// ─── Module wiring (ES module build only) ────────────────────────────────────

/** Provide the Babylon.js namespace (`import * as BABYLON from '@babylonjs/core'`). */
export function useBabylon<T extends object>(namespace: T, options?: { havok?: HavokSource }): T;
/** The Babylon.js namespace currently used by the controller. */
export function getBabylon(): any;

/** HavokPhysics factory (`import HavokPhysics from '@babylonjs/havok'`) or an initialised instance. */
export type HavokSource = (() => Promise<unknown>) | unknown;

// ─── States, keys and config ─────────────────────────────────────────────────

export type BuiltinState =
  | 'IDLE' | 'WALK' | 'JOG' | 'SPRINT' | 'WALK_FORMAL'
  | 'CROUCH_IDLE' | 'CROUCH_WALK' | 'CROUCH_RUN'
  | 'JUMP_START' | 'JUMP_LOOP' | 'JUMP_LAND' | 'ROLL'
  | 'PUNCH' | 'PUNCH_JAB' | 'PUNCH_CROSS'
  | 'SPELL_ENTER' | 'SPELL_SHOOT' | 'SPELL_EXIT'
  | 'INTERACT' | 'PICKUP';
/** Built-in states; custom actions use their action name as state. */
export type CharState = BuiltinState | (string & {});

export const S: { readonly [K in BuiltinState]: K };
export const ACTION_STATES: Set<string>;

export type BuiltinAction =
  | 'MOVE_FORWARD' | 'MOVE_BACKWARD' | 'MOVE_LEFT' | 'MOVE_RIGHT'
  | 'SPRINT' | 'CROUCH' | 'JUMP' | 'ROLL' | 'PUNCH' | 'SPELL' | 'INTERACT';

/** Action name → KeyboardEvent.code list. Custom action names are allowed. */
export type KeyBindings = Partial<Record<BuiltinAction, string[]>> & Record<string, string[]>;

export interface CharConfig {
  GRAV: number;
  JUMP_PWR: number;
  SPD_WALK: number;
  SPD_JOG: number;
  SPD_SPRINT: number;
  SPD_CROUCH: number;
  SPD_CROUCH_RUN: number;
  ACCEL: number;
  DECEL: number;
  ROT_SPD: number;
  AIR_CONTROL: boolean | number;
  DYNAMIC_FOV: boolean;
  DYNAMIC_FOV_MAX: number;
  CAM_TILT: boolean;
  CAM_TILT_AMOUNT: number;
  CAM_FOLLOW_LOCK: boolean;
  CAM_FOLLOW_PITCH: number;
  CAM_FOLLOW_DIST: number;
  CAM_LOCK_PITCH: boolean;
  JOYSTICK_LOCK_X: boolean;
  DOUBLE_JUMP_ENABLED: boolean;
  SPEED_MULTIPLIER: number;
  PLAY_PARTICLES: boolean;
  MOVING_PLATFORMS: boolean;
  HEAD_LOOK: boolean;
  FOOT_PLANTING: boolean;
  TWIST_DRIVER: boolean;
  MANTLE_ENABLED: boolean;
  COYOTE_TIME: number;
  JUMP_BUFFER: number;
  JUMP_CUT: boolean;
  JUMP_CUT_MULT: number;
  ACCEL_CURVE: boolean;
  STRIDE_MATCHING: boolean | 'full' | 'scale';
  UPPER_BODY_ACTIONS: boolean;
}

export interface TouchConfig {
  zoneId: string;
  ringId: string;
  knobId: string;
  buttons: Record<string, string>;
}

export const DEFAULT_CHAR_CONFIG: {
  KEYS: KeyBindings;
  PHYSICS: CharConfig;
  TOUCH: TouchConfig;
};
export const KEYS: KeyBindings;

// ─── Presets ─────────────────────────────────────────────────────────────────

export const CHARACTER_PRESET_SCHEMA: 'bjs-character-preset/v1';

export interface PresetClip {
  /** Clean clip name ("Armature|Walk" → "Walk"). */
  clip: string;
  from?: number;
  to?: number;
}

export interface CharacterPreset {
  schema?: 'bjs-character-preset/v1';
  character?: {
    filename?: string;
    animationsFilename?: string;
    assetsPath?: string;
    capsuleScale?: number | { x: number; y: number; z: number };
  };
  keys?: KeyBindings;
  config?: Partial<CharConfig>;
  /** Standard slot (Walk_Loop, Roll, …) → clip; `null` = explicitly no clip; a string is a clip name. */
  animations?: Record<string, PresetClip | string | null>;
  customActions?: Array<{ name: string; clip: string; keys?: string[]; from?: number; to?: number }>;
  animationEvents?: Record<string, AnimationEventMarker[]>;
  mergeOptions?: { boneMapOverrides?: Record<string, string>; [option: string]: unknown };
}

/** null unless a Builder "Download controller" export baked a preset in. */
export const BAKED_PRESET: CharacterPreset | null;

export interface PresetApplyResult {
  /** e.g. 'keys', 'config', 'animations.Walk_Loop', 'animations.Roll=none', 'customActions.WAVE', 'animationEvents' */
  applied: string[];
  missing: Array<{ slot: string; clip: string }>;
}

/** Apply keys, config, slot mapping, custom actions and events. Warns once listing missing clips. */
export function applyCharacterPreset(
  charCtrl: CharCtrl | null,
  animCtrl: AnimCtrl | null,
  groups: AnimationGroup[] | null | undefined,
  preset: CharacterPreset,
): PresetApplyResult;

/** v1 presets pass through; a Builder builder-config.json is converted. */
export function normalizeCharacterPreset(preset: unknown): CharacterPreset | null;
export function resolveCharacterPreset(preset: CharacterPreset | string | null | false | undefined): Promise<CharacterPreset | null>;

// ─── Animation slots ─────────────────────────────────────────────────────────

export interface StandardAnimSlot {
  key: string;
  label: string;
  /** Keyword fallback (same table as the Builder's auto-mapper). */
  defaultKeyword: RegExp;
  /** Idle/Walk/Sprint: required by the locomotion blend tree. */
  core?: boolean;
  loop?: boolean;
}
export const STANDARD_ANIM_SLOTS: ReadonlyArray<StandardAnimSlot>;

export interface MappingReport {
  exact: string[];
  keyword: Array<{ slot: string; clip: string; sharedWith?: string }>;
  missing: string[];
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface AnimationEventMarker {
  type: string;
  frame: number;
  label?: string;
  [extra: string]: unknown;
}
export interface AnimationEventInfo extends AnimationEventMarker {
  animName: string;
  /** CharCtrl name ('player' unless options.name). */
  character?: string;
}
export interface StateChangedInfo { state: CharState; previous: CharState; character: string }
export interface SpeedChangedInfo { speed: number; previous: number; character: string }
export interface ComboInfo { text: string; visible: boolean; character: string }
export interface ConfigChangedInfo { changes: Partial<CharConfig>; source: 'setConfig' | 'camera'; character: string }
export interface AnimationChangedInfo { name: string; previous: string; character?: string }

// ─── AnimCtrl ────────────────────────────────────────────────────────────────

export interface AnimCtrlOptions {
  /** Keyword-map standard slots with no exact-name clip (default true). */
  autoMap?: boolean;
  /** Warn (deferred, once) when Idle/Walk/Sprint have no clip (default true). */
  warnMissing?: boolean;
  /** false: never write #hud-anim. */
  hud?: false | 'auto';
}

export class LocoBlendGroup {
  constructor(animCtrl: AnimCtrl);
  weight: number;
  speed: number;
  isPlaying: boolean;
  start(loop?: boolean, speedRatio?: number): void;
  stop(): void;
  updateSpeed(speed: number): void;
  updateWeights(): void;
  setWeightForAllAnimatables(weight: number): void;
}

export class AnimCtrl {
  constructor(groups: AnimationGroup[] | Map<string, AnimationGroup>, scene: Scene, options?: AnimCtrlOptions);
  scene: Scene;
  /** Slot / clip name → group ('Locomotion' is the virtual blend tree). */
  g: Map<string, AnimationGroup | LocoBlendGroup | any>;
  cur: AnimationGroup | LocoBlendGroup | null;
  curName: string;
  locoGroup: LocoBlendGroup;
  charCtrl: CharCtrl | null;
  activeWeight: number;
  mappingReport: MappingReport;
  animationEvents: Record<string, AnimationEventMarker[]>;
  onAnimationChange: ((name: string) => void) | null;
  onAnimationEvent: ((event: AnimationEventMarker, animName: string) => void) | null;
  readonly onAnimationChangedObservable: Observable<AnimationChangedInfo>;
  readonly onAnimationEventObservable: Observable<AnimationEventInfo>;

  play(name: string, loop?: boolean, blendDuration?: number, onEnd?: (() => void) | null, speedRatio?: number, weight?: number | null): boolean;
  stop(): void;
  forceStop(): void;
  has(name: string): boolean;
  setAnimation(name: string, group: AnimationGroup): boolean;
  /** Unmap a slot (the Builder's "None"). */
  clearAnimation(name: string): boolean;
  setAnimationRanges(name: string, from: number, to: number): boolean;
  addAnimationGroups(groups: AnimationGroup[], options?: { replace?: boolean }): string[];
  setWeight(weight: number): void;
  setCustomWeight(name: string, weight: number): void;
  playUpperBody(name: string, options?: { loop?: boolean; blend?: number; speedRatio?: number; onEnd?: (() => void) | null }): boolean;
  stopUpperBody(blend?: number): void;
  readonly upperBodyPlaying: string | null;
  playAdditive(name: string, options?: { weight?: number; loop?: boolean; speedRatio?: number; referenceFrame?: number }): boolean;
  setAdditiveWeight(name: string, weight: number): void;
  stopAdditive(name: string): void;
  setWalkAnim(group: AnimationGroup): boolean;
  setRunAnim(group: AnimationGroup): boolean;
  setIdleAnim(group: AnimationGroup): boolean;
  setCrouchIdleAnim(group: AnimationGroup): boolean;
  setCrouchFwdAnim(group: AnimationGroup): boolean;
  setJumpStartAnim(group: AnimationGroup): boolean;
  setJumpLoopAnim(group: AnimationGroup): boolean;
  setJumpLandAnim(group: AnimationGroup): boolean;
  setRollAnim(group: AnimationGroup): boolean;
  setPunchAnim(group: AnimationGroup): boolean;
  setPunchJabAnim(group: AnimationGroup): boolean;
  setPunchCrossAnim(group: AnimationGroup): boolean;
  setSpellEnterAnim(group: AnimationGroup): boolean;
  setSpellShootAnim(group: AnimationGroup): boolean;
  setSpellExitAnim(group: AnimationGroup): boolean;
  setInteractAnim(group: AnimationGroup): boolean;
  dispose(): void;
  destroy(): void;
}

// ─── CharCtrl ────────────────────────────────────────────────────────────────

export interface CharCtrlCallbacks {
  onStateChange?: ((state: CharState) => void) | null;
  onSpeedChange?: ((speed: number) => void) | null;
  onCombo?: ((text: string, visible: boolean) => void) | null;
}

export interface CharCtrlOptions {
  usePhysics?: boolean;
  keys?: Partial<KeyBindings>;
  config?: Partial<CharConfig>;
  callbacks?: CharCtrlCallbacks;
  touch?: Partial<TouchConfig>;
  /** 'player' (keyboard, gamepad, touch; default) or 'none' (AI / network: setMoveInput/pressAction only). */
  input?: 'player' | 'none';
  /** 'auto' writes the legacy HUD DOM ids when present; false never touches the DOM. Default: 'auto', false for input:'none'. */
  hud?: 'auto' | false;
  /** Character name in events and mesh names (default 'player'). */
  name?: string;
  gamepad?: boolean;
  /** Read this navigator.getGamepads() slot instead of the first connected pad. */
  gamepadIndex?: number;
  /** false: read the camera for camera-relative input but never move it. */
  cameraControl?: boolean;
  /** Called when the controller changes config itself (camera zoom/pitch sync) or via setConfig(). */
  onConfigChanged?: (changes: Partial<CharConfig>, source: 'setConfig' | 'camera') => void;
  /** Dust particle texture URL (default 'assets/smoke.png'). */
  dustTexture?: string;
  persistPreferences?: boolean;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export class CharCtrl implements CharConfig {
  /** Camera may be null only with options.input === 'none' (world-relative movement). */
  constructor(root: Mesh, visualMesh: AbstractMesh | TransformNode, camera: ArcRotateCamera | null, anim: AnimCtrl, scene: Scene, options?: CharCtrlOptions);
  /** Extra name fallback for unflagged character meshes (default /playercapsule|autorig/i; null disables). */
  static legacyCharacterNamePattern: RegExp | null;

  name: string;
  root: Mesh;
  visualMesh: AbstractMesh | TransformNode;
  camera: ArcRotateCamera | null;
  anim: AnimCtrl;
  scene: Scene;
  usePhysics: boolean;
  keyBindings: KeyBindings;
  callbacks: CharCtrlCallbacks;
  keys: Record<string, boolean>;
  state: CharState;
  speed: number;
  rotY: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  isTouch: boolean;
  gamepadEnabled: boolean;
  gamepadIndex: number | null;
  virtualMove: { x: number; z: number };
  animationEvents: Record<string, AnimationEventMarker[]>;
  onAnimationEvent: ((event: AnimationEventMarker, animName: string) => void) | null;
  SHOW_COMBO: boolean;

  readonly onStateChangedObservable: Observable<StateChangedInfo>;
  readonly onSpeedChangedObservable: Observable<SpeedChangedInfo>;
  readonly onComboObservable: Observable<ComboInfo>;
  readonly onAnimationEventObservable: Observable<AnimationEventInfo>;
  readonly onConfigChangedObservable: Observable<ConfigChangedInfo>;

  /** Analog movement −1..1 (x right, z forward); camera-relative with a camera, else world-relative. */
  setMoveInput(x: number, z: number): this;
  setMoveInput(vector: { x: number; z?: number; y?: number }): this;
  /** Press an action by KEYS name ('JUMP', 'SPRINT', …) or a custom action name. */
  pressAction(action: BuiltinAction | (string & {})): boolean;
  releaseAction(action: BuiltinAction | (string & {})): boolean;
  triggerAction(action: string, options?: { blend?: number; speedRatio?: number }): boolean;
  /** Validated partial config: unknown keys / wrong types warn once and are ignored. Returns the applied subset. */
  setConfig(partial: Partial<CharConfig>): Partial<CharConfig>;
  getConfig(): CharConfig;
  playParticles(enable: boolean): void;
  loadAnimations(source: string | ArrayBuffer | Uint8Array | Blob, options?: { replace?: boolean; [option: string]: unknown }): Promise<{ added: string[]; report: unknown }>;
  measureLocomotion(): Record<string, number>;
  refreshBoneDrivers(): void;
  destroy(): void;

  // Runtime config (instance fields)
  GRAV: number; JUMP_PWR: number; SPD_WALK: number; SPD_JOG: number; SPD_SPRINT: number;
  SPD_CROUCH: number; SPD_CROUCH_RUN: number; ACCEL: number; DECEL: number; ROT_SPD: number;
  AIR_CONTROL: boolean | number; DYNAMIC_FOV: boolean; DYNAMIC_FOV_MAX: number; CAM_TILT: boolean;
  CAM_TILT_AMOUNT: number; CAM_FOLLOW_LOCK: boolean; CAM_FOLLOW_PITCH: number; CAM_FOLLOW_DIST: number;
  CAM_LOCK_PITCH: boolean; JOYSTICK_LOCK_X: boolean; DOUBLE_JUMP_ENABLED: boolean; SPEED_MULTIPLIER: number;
  PLAY_PARTICLES: boolean; MOVING_PLATFORMS: boolean; HEAD_LOOK: boolean; FOOT_PLANTING: boolean;
  TWIST_DRIVER: boolean; MANTLE_ENABLED: boolean; COYOTE_TIME: number; JUMP_BUFFER: number;
  JUMP_CUT: boolean; JUMP_CUT_MULT: number; ACCEL_CURVE: boolean; STRIDE_MATCHING: boolean | 'full' | 'scale';
  UPPER_BODY_ACTIONS: boolean;
}

// ─── Setup helpers ───────────────────────────────────────────────────────────

export interface InitPhysicsOptions {
  usePhysics?: boolean;
  persistPreferences?: boolean;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  havok?: HavokSource;
}
/** Enable Havok (resolves false → kinematic collisions). `initPhysics.havok` sets the default factory. */
export function initPhysics(scene: Scene, gravityOrOptions?: Vector3 | InitPhysicsOptions | null, options?: InitPhysicsOptions): Promise<boolean>;
export namespace initPhysics { let havok: HavokSource | undefined; }

export interface SetupCharacterOptions extends Omit<CharCtrlOptions, 'usePhysics'> {
  filename?: string;
  animationsFilename?: string;
  assetsPath?: string;
  /** Preset object, URL of its JSON, or false to ignore the baked preset. Defaults to BAKED_PRESET. */
  preset?: CharacterPreset | string | false | null;
  shadow?: ShadowGenerator;
  spawnPosition?: Vector3;
  ellipsoid?: Vector3;
  capsuleScale?: number | { x: number; y: number; z: number };
  mergeOptions?: { boneMapOverrides?: Record<string, string>; [option: string]: unknown };
  /** Base URL of the merge server for /api/health and /api/merge (default '' = same origin). */
  serverUrl?: string;
  /** false: skip the server merge, retarget client side. */
  serverMerge?: boolean;
  onProgress?: (percent: number, label: string) => void;
  autoMapAnimations?: boolean;
  charOptions?: CharCtrlOptions;
  configure?: (context: {
    animCtrl: AnimCtrl; charCtrl: CharCtrl; filteredGroups: AnimationGroup[]; playerCapsule: Mesh;
    scene: Scene; charRoot: AbstractMesh; preset: CharacterPreset | null; report: SetupReport;
  }) => void;
}

export interface SetupReport extends PresetApplyResult {
  mode: 'server' | 'client' | 'single';
  preset: 'options' | 'baked' | null;
  mapping: MappingReport | null;
  retarget: unknown;
  serverError: string | null;
}

export interface CharacterSetup {
  playerCapsule: Mesh;
  charRoot: AbstractMesh;
  animCtrl: AnimCtrl;
  charCtrl: CharCtrl;
  scene: Scene;
  report: SetupReport;
}

export function setupCharacter(scene: Scene, camera: ArcRotateCamera | null, usePhysics: boolean, options?: SetupCharacterOptions): Promise<CharacterSetup>;
export { setupCharacter as loadCharacter };

export interface CreateCharacterOptions extends Omit<SetupCharacterOptions, 'filename' | 'animationsFilename' | 'spawnPosition'> {
  /** Model URL, or a file name under assetsPath (default 'assets/'). Optional with a preset that names the character. */
  model?: string;
  animations?: string;
  /** ArcRotateCamera to drive; omitted → one is created and attached (players) or none (input:'none'). */
  camera?: ArcRotateCamera | null;
  /** 'auto' (default): Havok when the scene has physics or HavokPhysics loads; your level then needs PhysicsAggregates. */
  physics?: boolean | 'auto';
  havok?: HavokSource;
  spawn?: Vector3 | [number, number, number] | { x: number; y: number; z: number };
}

export interface CreatedCharacter extends CharacterSetup {
  camera: ArcRotateCamera | null;
  usePhysics: boolean;
  /** Destroy the controller and dispose capsule, meshes, skeletons, its animation groups and a created camera. */
  dispose(): void;
}

export function createCharacter(scene: Scene, options?: CreateCharacterOptions | string): Promise<CreatedCharacter>;

// ─── Utilities & client retargeting ──────────────────────────────────────────

export function normBone(name: string): string;
export function cleanAnimName(name: string): string;
export function lerp(a: number, b: number, t: number): number;
export function lerpAngle(a: number, b: number, t: number): number;
export function canonicalBoneRole(name: string): string | null;
export function readGlbJson(buffer: ArrayBuffer | Uint8Array): any;
export function buildRetargetBoneMap(sourceNodes: TransformNode[], skeleton: any, translatedSources?: Set<TransformNode>): Map<string, string>;
export function loadRetargetSource(scene: Scene, source: string | ArrayBuffer | Uint8Array | Blob): Promise<{ container: any; json: any }>;
export function retargetAnimationGroupsClient(scene: Scene, charRoot: TransformNode, container: any, options?: Record<string, unknown>): { groups: AnimationGroup[]; report: any; boneMap: Map<string, string> };
export { retargetAnimationGroupsClient as retargetAnimationGroups };
export function measureLocomotionClip(group: AnimationGroup, root: TransformNode): { speed: number; duration: number; leftStrike: number; leg: number } | null;
export const BJSRetarget: {
  canonicalBoneRole: typeof canonicalBoneRole;
  readGlbJson: typeof readGlbJson;
  buildRetargetBoneMap: typeof buildRetargetBoneMap;
  loadRetargetSource: typeof loadRetargetSource;
  retargetAnimationGroups: typeof retargetAnimationGroupsClient;
};
