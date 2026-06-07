# 🎮 3D Character Animation Controller V2 for Babylon.js

An advanced third-person character locomotion and physics framework built with **Babylon.js**. This framework provides a fluid, powerful, and easy-to-use Character Controller with integrated physics, animations, and high-end visual features.

🎮 **Live Demo**: [https://viseni.com/_demos_/bjs_character_controller_v2/](https://viseni.com/_demos_/bjs_character_controller_v2/)

![BJS Character Controller V2 Screenshot](assets/screenshot.webp)

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
*   **Air Dash (Mid-Air Roll)**: Perform a responsive dodge roll in mid-air with a horizontal speed boost and a 55% jump-power vertical hop (available if Double Jump is enabled, works even after double jumping).
*   **Action Interrupt Roll**: Pressing Roll immediately interrupts active attack combos or spell casts for instant responsiveness.
*   **Roll Cooldown & HUD Feedback**: A 1.1s cooldown prevents roll spamming, displaying a "DODGE COOLDOWN" HUD warning when pressed too early.
*   **Toggleable Action HUD Texts**: Toggle on-screen action text alerts (like "AIR DASH", "JAB", "CROSS!") directly from the System & UI settings drawer.

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
const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, {
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

The `js/` directory is organized into subfolders by role:

- **`js/character-controller.js`** — Unified core engine. Handles Havok Physics and Kinematic modes, locomotion state machines, and animation blending. Exports `initPhysics` and `setupCharacter` helpers.
- **`js/ui/custom-hud.js`** — Tactile settings overlay (Camera Lock, Physics toggle, Dynamic FOV, Hide Cursor, Double Jump, Air Control, sliders). Optional.
- **`js/ui/custom-pointer.js`** — Spring-damper trailing cursor ring. Optional.
- **`js/examples/`** — Ready-to-run setup templates (`app.js`, `app-minimal.js`, `app-complex.js`).
- **`js/core/builder.js`** — Powers `builder.html`, the visual configuration tool (see below).

### ⚡ High-Level Setup (Recommended)
You can initialize physics and load the character in just a few lines of code using the shared helper functions: `initPhysics` and `setupCharacter` (wrapped in a clean `loadCharacter` helper function across the app templates). This helper supports configuring model paths, spawn locations, bounding ellipsoids, controls, and animations:

```javascript
// 1. Define character initialization helper
async function loadCharacter(scene, shadow, camera, usePhysics) {
  return setupCharacter(scene, camera, usePhysics, {
    shadow,                             // Optional: shadow generator to add character meshes to
    assetsPath: 'assets/',              // Optional: path to GLB assets folder (defaults to 'assets/')
    filename: 'character_animated.glb', // Optional: GLB file name (defaults to 'character_animated.glb')
    spawnPosition: new BABYLON.Vector3(0, 2, 0), // Optional: starting position override
    ellipsoid: new BABYLON.Vector3(0.35, 0.96, 0.35), // Optional: collision ellipsoid override
    keys: { JUMP: ['KeyK'] },           // Optional: remap keyboard controls directly
    config: { JUMP_PWR: 12 },           // Optional: override physical and camera parameters
    configure: ({ animCtrl, filteredGroups }) => {
      // Optional: callback to remap animations or customize keyframe ranges
      animCtrl.setWalkAnim(filteredGroups[15]);
    }
  });
}

// 2. Initialize physics (Havok or Kinematic fallback)
const usePhysics = await initPhysics(scene);

// 3. Load the character using the helper
const { playerCapsule, animCtrl, charCtrl } = await loadCharacter(scene, shadow, camera, usePhysics);

// 4. Hook up HUD setting toggles dynamically via custom-hud.js
if (typeof bindHUDControls === 'function') {
  bindHUDControls(charCtrl, camera, usePhysics);
}
```

We have provided three setup examples to guide your implementation:
*   **[js/examples/app-minimal.js](js/examples/app-minimal.js)**: A bare-minimum integration template/guide to quickly see how to set up the Babylon.js engine, scene, capsule collider, parent the mesh, and initialize the controllers.
*   **[js/examples/app-complex.js](js/examples/app-complex.js)**: A full-featured setup designed to demonstrate how the character controller functions with a highly complex 3D scenery model ([assets/backyard_demo.glb](assets/backyard_demo.glb)) containing many intricate, complex collisions and polygon-heavy geometry.
*   **[js/examples/app.js](js/examples/app.js)**: A fully featured production loading example including advanced lighting, shadows, skyboxes, procedural environment shapes (boxes, ramp, stairs), post-processing, and HUD settings synchronization.

---

## 🔧 Visual Builder (`builder.html`)

`builder.html` is an interactive GUI tool for visually configuring and exporting a custom character controller — no code editing required.

> [!NOTE]
> **NodeJS Visual Builder in Development:** A server-backed Visual Builder powered by NodeJS (`server.mjs`) is under active development. When running the local NodeJS server, it automatically handles advanced skeletal retargeting, GLB animation merges, and asset optimizations via a local backend API, bringing automatic offline compilation to your character workflow.


### Tabs

| Tab | What it does |
|---|---|
| **Model** | Set the GLB asset path and filename for your character model |
| **Animations** | Auto-match Mixamo/custom animation names to controller slots. Each row has an `↺` reset button to re-run keyword auto-detection for that single slot |
| **Controls** | Remap every key binding. Each action has an `↺` button to restore its default key |
| **Physics** | Tune all physics, camera, and speed parameters with sliders and toggles. Each control has an `↺` reset to restore the baked default |
| **Export** | Preview the final configuration code, download `custom-character-controller.js`, or export the character in GLB format with all animations incorporated |

All changes auto-save to `localStorage`. Use **Reset All** in the sidebar to wipe all overrides and restore factory defaults.

### 📥 Exporting the Character as GLB (with animations)

The **Export** tab also provides the ability to export the character directly in `.glb` format with the configured animations incorporated. This allows you to generate a single, self-contained GLB file that includes both the character mesh and the mapped animations, ready to be used in other scenes or external tools.

### 🔄 Retargeting & Animation Merging (`merge_api.mjs`)

The Visual Builder utilizes the server-side module [merge_api.mjs](file:///d:/DEV/BJS%20Character%20Controller%20V2/js/core/merge_api.mjs) (via `server.mjs`) to dynamically retarget and combine your character model with custom animations.

When using the builder, you can import assets in different ways:
- **Separate Import:** You can load your character mesh (with or without animations) in the **Model** tab, and then load external animation GLB files in the **Animations** tab.
- **Using Embedded Animations:** If you want to use the animations already present in the character model itself, you must import the character model file in the **Model** tab, and then import the **same character model file** again in the **Animations** tab.

### Downloading `custom-character-controller.js`

The **Export** tab lets you download a pre-configured version of `character-controller.js` with your settings baked in. This file includes an **auto-seed block** that writes your configuration values to `localStorage` on first load (detected by a config signature). This ensures your exported Physics settings always take priority over any stale `localStorage` values from previous sessions. If you export with new settings, the signature changes and the seed re-runs automatically.

```html
<!-- Use the downloaded file in place of the original: -->
<script src="js/character-controller.js"></script>
<!-- or, if using the builder export: -->
<script src="js/custom-character-controller.js"></script>
```

---

## 📦 Merging Animations (`merge_animations.mjs`)

Animations are baked inside `character_animated.glb`. To merge new external GLB animation files onto your character mesh:

```bash
# Install dependencies
npm install

# Run the merge tool
node js/core/merge_animations.mjs

# Example usage with custom paths
node js/core/merge_animations.mjs -c base_character.glb -a animations.glb -o assets/character_animated.glb
```

For batch conversion of FBX animations, see [FBX2GLB-Batch-Convert-Optimizer](https://github.com/crazyramirez/FBX2GLB-Batch-Convert-Optimizer).

---

## 📚 Credits & License

*   **Rig**: Customized Mixamo skeletal rig.
*   **Animations**: [Universal Animation Library by Quaternius](https://quaternius.com/packs/universalanimationlibrary.html).
*   **License**: Licensed under the **MIT License** - see [LICENSE](LICENSE) for details. Keep the copyright notice and attribute the authorship of the Character Controller to **Diego Ramirez** in all copies.
