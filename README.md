# 🎮 3D Character Animation Controller V2 for Babylon.js

An advanced third-person character locomotion and physics framework built with **Babylon.js**. **The primary goal of this framework is to provide a highly powerful, fluid, and extremely easy-to-use Character Controller** that integrates out-of-the-box physics, animations, and high-end visual features.

🎮 **Live Demo**: [https://viseni.com/_demos_/bjs_character_controller_v2/](https://viseni.com/_demos_/bjs_character_controller_v2/)

![BJS Character Controller V2 Screenshot](assets/screenshot.jpg)

---

## 🚀 Key Features & Engine Mechanics

*   **Locomotion Blend Tree (Reactive Animations)**: Smoothly blends weight and speeds between `Idle_Loop`, `Walk_Loop`, and `Sprint_Loop` based on physical velocity.
*   **Dual-State Coexistence**: Crouch and Sprint operate as persistent **Toggles (Latch Mode)** and can cohabitate seamlessly, allowing a high-speed **Crouch Run (Agachado)** locomotion state.
*   **Advanced Kinetic Camera System**:
    *   **Natural Lerped Follow**: Smoothly tracks the character's height using adaptive linear interpolation (Lerp), eliminating rigid camera cuts and stutter.
    *   **Dynamic Tunnel Vision (FOV Expansion)**: Automatically expands the camera Field of View (FOV) at higher velocities to increase the sensation of speed.
    *   **Landing Impact Camera Shake**: Triggers multi-axis rotational camera shake depending on landing height and landing physics velocity.
    *   **Mobile-Adaptive Framing & Recenter**: Lowers the target center on mobile to keep the character perfectly visible above the thumbs and touch overlay, with a seamless double-tap screen recentering transition.
*   **Procedural Footstep Particles**: Generates dynamic dust trails at the feet during locomotion, with impactful landing bursts based on fall velocity.
*   **Advanced Visual Suspension**:
    *   **Y-Suspension & Morphing**: Dampens vertical height shocks when walking up/down steps. Automatically morphs collision bounds and visual offsets during standing actions (magics, interactions) when crouched.
    *   **Leaning & Banking**: Automatically pitches forward on acceleration, backward on braking, and banks into sharp angular turns.
    *   **Squash & Stretch**: Elastic scale distortions on jumps, falls, and landing impact.
*   **Ledge Snap & Stairs Snapping**: Downward snap pressure prevents micro-airborne jitter on ramps and stairs.
*   **Smart Landing Physics & Height Filtering**: Evaluates vertical impact velocity (`jumpVel < -3.0`) and tracks peak airborne height to calculate the exact physical drop distance (`fallHeight > 0.4m`). This allows the controller to ignore tiny stair drops or curbs while perfectly triggering the landing animation (`Jump_Land`) and visual squash effects on real falls and jumps. The execution order resolves calculations *before* grounded state resets, ensuring perfect precision.
*   **High-End Mobile Touch UI**: Fully custom glassmorphism virtual joystick and responsive action buttons.
    *   **Integrated Collapsing panel**: Double-click/tap recenters camera seamlessly. The HUD collapses into a compact glowing glass bead in the screen corner and persists its state via `localStorage`.

---

## 🕹️ Controls Layout

### Keyboard & Mouse (PC):
*   `W`, `A`, `S`, `D` / `Arrow Keys`: Camera-relative movement.
*   `Shift`: Sprint (Persistent Toggle / Latch Mode button).
*   `Ctrl`: Crouch (Persistent Toggle / Latch Mode button; blocked under ceilings).
*   `Space`: Jump (Hold in air to queue a landing dodge-roll recovery).
*   `R`: Dodge roll (Horizontal momentum).
*   `Q`: Punch.
*   `E`: Spell casting (Automatic stand-up when crouched).
*   `F`: Interaction (Automatic stand-up when crouched).
*   `Mouse Drag`: Orbit camera.

### Mobile Touch Layout:
*   **Left Hand**: Floating Analog Joystick (drag to adjust speed/animations dynamically).
*   **Screen Double-Tap**: Smoothly recenter camera behind the character.
*   **Right Hand (Button Grid)**:
    *   **Row 1 (Upper)**: `SPELL` · `ACT` · `CROUCH` (Latch Mode toggle with visual active glow indicator)
    *   **Row 2 (Lower)**: `ROLL` · `SPRINT` (Latch Mode toggle with visual active glow indicator) · `JUMP`

---

## 🛠️ Implementation Quickstart

The core architecture consists of two modular classes in `js/character-controller.js`:
1.  **`AnimCtrl`**: Handles skeletal animations cross-fades, virtual groups, and custom transitions.
2.  **`CharCtrl`**: Handles keyboard/touch inputs, capsule collision physics, and procedural visuals.

### Basic Setup Example:

```javascript
// 1. Load the animated GLB character
const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'character_animated.glb', scene);
const visualMesh = charRes.meshes[0];

// 2. Configure mesh parameters
charRes.meshes.forEach(m => {
  shadowGenerator.addShadowCaster(m, true);
  m.receiveShadows = true;
  m.isPickable = false;
});

// 3. Create the physical capsule collider parent
const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.35, height: 1.8 }, scene);
playerCapsule.position.set(0, 4, 0);
playerCapsule.visibility = 0;
playerCapsule.checkCollisions = true;
playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);

// 4. Bind visual mesh to collider
visualMesh.setParent(playerCapsule);
visualMesh.position.set(0, -0.98, 0);

// 5. Initialize Controllers
const animCtrl = new AnimCtrl(charRes.animationGroups.filter(ag => !/t-pose/i.test(ag.name)), scene);
const charCtrl = new CharCtrl(playerCapsule, visualMesh, camera, animCtrl, scene, {
  config: {
    GRAV: 22,
    JUMP_PWR: 9.5,
    SPD_WALK: 2.2,
    SPD_SPRINT: 5.0,
    AIR_CONTROL: true
  }
});
```

## 🔄 Animation Pipeline & Rig Correction

This framework is designed around a 3D character from **Mixamo** retargeted with high-quality animations from the **Universal Animation Library by Quaternius**.

### 📦 All-in-One Embedded Assets
To achieve optimal loading performance and zero-overhead network delivery, the final asset (`character_animated.glb`) packages **both the 3D character mesh and all skeletal animations embedded inside a single, highly compressed file**. This makes the asset extremely easy to distribute, load, and manage inside your Babylon.js scene.

### 🛠️ Merging Animations (`merge_animations.mjs`)
You can use the local script [merge_animations.mjs](file:///d:/DEV/BJS%20Character%20Controller%20V2/js/merge_animations.mjs) to retarget and blend skeletal animations from external GLB files (e.g., Mixamo or Blender animations) directly onto your character model:

```bash
# Install tool dependencies
npm install fs-extra @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf

# Run the merging utility
node js/merge_animations.mjs -c base_character.glb -a animations.glb -o assets/character_animated.glb
```

### ⚡ Advanced Automated Pipeline: FBX2GLB
For a fully automated and advanced asset workflow, you can use **FBX2GLB-Batch-Convert-Optimizer**, an advanced batch converter and optimizer utility. It handles converting FBX characters and animations directly to GLB, optimizing textures/geometry, and automatically merging them into a single consolidated file:

👉 **GitHub Repository**: [FBX2GLB-Batch-Convert-Optimizer](https://github.com/crazyramirez/FBX2GLB-Batch-Convert-Optimizer)

This utility allows you to easily convert FBX folders, apply Draco mesh compression, bake textures, and automatically run the `merge_animations` script in a single-command batch pipeline.

---

## 📚 Credits & Attributions
*   **Character Rig**: Customized **Mixamo** skeletal rig.
*   **Animations**: Built using the [Universal Animation Library by Quaternius](https://quaternius.com/packs/universalanimationlibrary.html).
