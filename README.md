# 🎮 3D Character Animation Controller V2 for Babylon.js

An advanced third-person character locomotion and physics framework built with **Babylon.js**. This framework provides a fluid, powerful, and easy-to-use Character Controller with integrated physics, animations, and high-end visual features.

🎮 **Live Demo**: [https://viseni.com/_demos_/bjs_character_controller_v2/](https://viseni.com/_demos_/bjs_character_controller_v2/)

![BJS Character Controller V2 Screenshot](assets/screenshot.jpg)

> ☕ If this controller saves you time, consider supporting its development!
>
> <a href="https://www.buymeacoffee.com/drlerian" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="42"></a>

---

## 🚀 Key Features

*   **Dual-Movement Modes (Physics vs Kinematic)**: Toggle dynamically between Havok Physics (dynamic simulation with body bodies) and standard Kinematic Collisions (ellipsoid-based movement) directly from the HUD.
*   **Locomotion Blend Tree**: Smoothly blends weight and speed between Idle, Walk, and Sprint.
*   **Dual-State Toggle Coexistence**: Crouch and Sprint operate as persistent toggles and can co-exist (allowing crouch-running).
*   **Dynamic Zoom & Camera Follow**: Smooth camera tracking with automated user-zoom sync (mouse wheel, trackpad, pinch) and double-tap recentering.
*   **Dynamic FOV & Camera Shake**: Camera Field of View expands with speed. Rotational camera shake is triggered on landing impacts relative to fall height.
*   **Camera Follow Lock (Direct Steering)**: Locks the camera directly behind the character for tank-style direct controls.
*   **Visual Enhancements**: Procedural dust/smoke trails at the feet, procedural leaning/banking on turns, slope-incline alignment, and squash & stretch scaling.
*   **Collision height adjustments & Ceiling protection**: Shrinks the capsule automatically when crouching/rolling, prevents standing up or rolling under low ceilings, and expands width when sprinting to prevent wall clipping.
*   **Ledge & Stairs Snapping**: Keeps the character grounded on sloped surfaces and stairs to prevent airborne jitter.
*   **Mobile Touch Support**: Responsive virtual joystick and customizable glassmorphism action buttons.

---

## ⚖️ Physics vs. Kinematic Modes

`character-controller.js` is a **unified single-file engine** that runs in two distinct physics regimes. Both modes live in the same class — a single `usePhysics` flag switches the internal code paths at initialization time.

*   **Havok Physics (Default)**: Leverages the WASM-powered **Havok Physics** engine. The character capsule is created as a dynamic `PhysicsBody` with defined mass and inertia properties, interacting naturally with other dynamic aggregates (like boxes, cylinders, and triggers).
*   **Kinematic Collisions**: Runs entirely within Babylon's native collision engine using kinematic ellipsoids (`moveWithCollisions`). Havok initialization is skipped entirely, providing maximum performance and deterministic locomotion.

### Automatic detection (default behaviour)

The engine **auto-detects** on every load. No configuration required:

| `localStorage('use-physics')` | Result |
|---|---|
| not set | Try Havok → success: physics mode. Fail: kinematic silently. |
| `'true'` (HUD forced ON) | Try Havok → success: physics mode. Fail: kinematic + clears override. |
| `'false'` (HUD forced OFF) | Kinematic always, skips Havok init entirely. |

### Overriding the mode

**HUD toggle** — easiest. Saves to `localStorage` and reloads. Clears itself automatically if Havok fails to load.

**Programmatic override via `localStorage`:**
```javascript
localStorage.setItem('use-physics', 'false'); // force kinematic
localStorage.setItem('use-physics', 'true');  // force Havok (falls back if unavailable)
localStorage.removeItem('use-physics');        // back to auto-detect
// reload required for change to take effect
window.location.reload();
```

**Direct constructor option** (bypasses localStorage, for embedded use):
```javascript
const charCtrl = new CharacterController(scene, camera, root, anims, {
  usePhysics: true,  // or false
  config: {
    SPEED_MULTIPLIER: 1.5 // Multiplies walking, running and jogging speeds
  }
});
```

---

## 🔄 Dynamic Animation Remapping

You can dynamically change any animation on the character controller or adjust keyframe ranges at runtime using the `AnimCtrl` instance (accessed via `charCtrl.anim`):

### 1. Reassigning Animations (Setters)
Pass a new Babylon `AnimationGroup` to dynamically swap any of the pre-mapped animations:

```javascript
// Remap basic locomotion
charCtrl.anim.setWalkAnim(newWalkAnimGroup);
charCtrl.anim.setRunAnim(newRunAnimGroup);
charCtrl.anim.setIdleAnim(newIdleAnimGroup);

// Remap crouch states
charCtrl.anim.setCrouchIdleAnim(newCrouchIdle);
charCtrl.anim.setCrouchFwdAnim(newCrouchWalk);

// Remap jumps and actions
charCtrl.anim.setJumpStartAnim(newJumpStart);
charCtrl.anim.setJumpLoopAnim(newJumpLoop);
charCtrl.anim.setJumpLandAnim(newJumpLand);
charCtrl.anim.setRollAnim(newRoll);
charCtrl.anim.setPunchJabAnim(newPunchJab);
charCtrl.anim.setPunchCrossAnim(newPunchCross);
charCtrl.anim.setSpellEnterAnim(newSpellEnter);
charCtrl.anim.setSpellShootAnim(newSpellShoot);
charCtrl.anim.setSpellExitAnim(newSpellExit);
charCtrl.anim.setInteractAnim(newInteract);

// Remap any custom animation key
charCtrl.anim.setAnimation('Custom_State_Name', myAnimGroup);
```

### 2. Modifying Playback Keyframe Ranges
Change the start/end frames of an animation without replacing the group:
```javascript
// setAnimationRanges(animKey, startFrame, endFrame)
charCtrl.anim.setAnimationRanges('Walk_Loop', 10, 45);
```

---

## 🕹️ Controls Layout

### Keyboard (PC):
*   `W`, `A`, `S`, `D` / `Arrow Keys`: Movement.
*   `Shift`: Sprint (Toggle).
*   `Ctrl`: Crouch (Toggle).
*   `Space`: Jump / Double Jump.
*   `R`: Dodge roll / Air Dash:
    *   **Action Interrupt:** Instantly cancels active attack combos or spell casts.
    *   **Roll Cooldown:** 1.1s cooldown between rolls (triggers a "DODGE COOLDOWN" HUD alert).
    *   **Air Dash:** If Double Jump is enabled in settings, performs a mid-air roll with a horizontal boost and a 55% jump-power vertical hop (usable even after double jumping).
*   `Q`: Punch combo.
*   `E`: Spell casting.
*   `F`: Interaction.
*   `Mouse Drag`: Orbit camera / Double-click to recenter.

### Mobile Touch:
*   **Left Hand**: Floating Analog Joystick.
*   **Right Hand (Buttons)**: `SPELL`, `ACT`, `CROUCH`, `ROLL`, `SPRINT`, `JUMP`.
*   **Canvas Double-Tap**: Recenter camera.

---

## 🛠️ Implementation Quickstart

The core architecture consists of three components in the `js/` directory:
1.  **`character-controller.js`**: Unified character controller — handles both Havok Physics and Kinematic modes. Select the mode via the `usePhysics` constructor option or `localStorage`. Also exports helper functions `initPhysics` and `setupCharacter` for a clean, few-lines-of-code setup.
2.  **`custom-hud.js`**: Tactile settings panel (toggles for Camera Lock, Havok Physics, Dynamic FOV, Hide Cursor, Double Jump, Air Control, and sliders).
3.  **`custom-pointer.js`**: Responsive custom cursor. Tracks a zero-latency hardware cursor and renders a spring-damper trailing ring (hidden completely when the `Hide Cursor` toggle is enabled).

### ⚡ High-Level Setup (Recommended)
You can initialize physics and load the character in just a few lines of code:

```javascript
// 1. Initialize physics (Havok or Kinematic fallback)
const usePhysics = await initPhysics(scene);

// 2. Load character, parent capsule collider, and build controllers in one call
const { playerCapsule, animCtrl, charCtrl } = await setupCharacter(scene, camera, usePhysics, {
  shadow,                     // Optional: shadow generator to add character meshes to
  keys: { JUMP: ['KeyK'] },   // Optional: remap keyboard controls directly
  config: { JUMP_PWR: 12 },   // Optional: override physical and camera parameters
  configure: ({ animCtrl, filteredGroups }) => {
    // Optional: callback to remap animations or customize keyframe ranges
    animCtrl.setWalkAnim(filteredGroups[15]);
  }
});
```

We have provided three setup examples to guide your implementation:
*   **[js/app-minimal.js](js/app-minimal.js)**: A bare-minimum integration template/guide to quickly see how to set up the Babylon.js engine, scene, capsule collider, parent the mesh, and initialize the controllers.
*   **[js/app-complex.js](js/app-complex.js)**: A full-featured setup designed to demonstrate how the character controller functions with a highly complex 3D scenery model ([assets/backyard_demo.glb](assets/backyard_demo.glb)) containing many intricate, complex collisions and polygon-heavy geometry.
*   **[js/app.js](js/app.js)**: A fully featured production loading example including advanced lighting, shadows, skyboxes, procedural environment shapes (boxes, ramp, stairs), post-processing, and HUD settings synchronization.

---

## 📦 Merging Animations (`merge_animations.mjs`)

Animations are baked inside `character_animated.glb`. To merge new external GLB animation files onto your character mesh:

```bash
# Install dependencies
npm install fs-extra @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf

# Run the merge tool
node js/merge_animations.mjs -c base_character.glb -a animations.glb -o assets/character_animated.glb
```

For batch conversion of FBX animations, see [FBX2GLB-Batch-Convert-Optimizer](https://github.com/crazyramirez/FBX2GLB-Batch-Convert-Optimizer).

---

## 📚 Credits & License

*   **Rig**: Customized Mixamo skeletal rig.
*   **Animations**: [Universal Animation Library by Quaternius](https://quaternius.com/packs/universalanimationlibrary.html).
*   **License**: Licensed under the **MIT License** - see [LICENSE](LICENSE) for details. Keep the copyright notice and attribute the authorship of the Character Controller to **Diego Ramirez** in all copies.
