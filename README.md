# 🎮 3D Character Animation Controller V2 for Babylon.js

An advanced third-person character locomotion and physics framework built with **Babylon.js**. This framework features high-fidelity collision physics, dynamic locomotion blend trees, procedural dust particles, advanced visual suspension mechanics, combat combos, spell casting, and a top-tier responsive mobile touch interface.

🎮 **Live Demo**: [https://viseni.com/_demos_/bjs_character_controller_v2/](https://viseni.com/_demos_/bjs_character_controller_v2/)

---

## 🚀 Key Features & Engine Mechanics

*   **Locomotion Blend Tree (Reactive Animations)**: Smoothly blends weight and speeds between `Idle_Loop`, `Walk_Loop`, and `Sprint_Loop` based on physical velocity.
*   **Dual-State Coexistence**: Crouch and Sprint operate as persistent **Toggles (Latch Mode)** and can cohabitate seamlessly, allowing a high-speed **Crouch Run (Agachado)** locomotion state.
*   **Procedural Footstep Particles**: Generates dynamic dust trails at the feet during locomotion, with impactful landing bursts based on fall velocity.
*   **Advanced Visual Suspension**:
    *   **Y-Suspension & Morphing**: Dampens vertical height shocks when walking up/down steps. Automatically morphs collision bounds and visual offsets during standing actions (magics, interactions) when crouched.
    *   **Leaning & Banking**: Automatically pitches forward on acceleration, backward on braking, and banks into sharp angular turns.
    *   **Squash & Stretch**: Elastic scale distortions on jumps, falls, and landing impact.
*   **Ledge Snap & Stairs Snapping**: Downward snap pressure prevents micro-airborne jitter on ramps and stairs.
*   **High-End Mobile Touch UI**: Fully custom glassmorphism virtual joystick and responsive action buttons.
    *   **Integrated Collapsing panel**: Double-click/tap recenters camera seamlessly. The HUD collapses into a compact glowing glass bead in the screen corner and persists its state via `localStorage`.

---

## 🕹️ Controls Layout

### Keyboard & Mouse (PC):
*   `W`, `A`, `S`, `D` / `Arrow Keys`: Camera-relative movement.
*   `Shift`: Sprint (Persistent Toggle).
*   `Ctrl`: Crouch (Persistent Toggle; blocked under ceilings).
*   `Space`: Jump (Hold in air to queue a landing dodge-roll recovery).
*   `R`: Dodge roll (Horizontal momentum).
*   `Q`: Punch combo (Tap with rhythm to chain Jab into Cross).
*   `E`: Spell casting (Automatic stand-up when crouched).
*   `F`: Interaction (Automatic stand-up when crouched).
*   `Mouse Drag`: Orbit camera.

### Mobile Touch Layout:
*   **Left Hand**: Floating Analog Joystick (drag to adjust speed/animations dynamically).
*   **Screen Double-Tap**: Smoothly recenter camera behind the character.
*   **Right Hand (Button Grid)**:
    *   **Row 1 (Upper)**: `SPELL` · `ACT` · `CROUCH` (with visual active indicators)
    *   **Row 2 (Lower)**: `ROLL` · `SPRINT` (with visual active indicators) · `JUMP`

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

---

## 🔄 Animation Rig Correction Utility (`merge_animations.mjs`)

Combines multiple skeletal animation GLBs (e.g. from Mixamo) into a single optimized GLB file, applying axis remapping, Draco compression, and manifest generations.

```bash
# Install dependencies
npm install fs-extra @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf

# Run merging pipeline
node js/merge_animations.mjs -c base_character.glb -a animations.glb -o assets/character_animated.glb
```

---

## 📚 Credits & Attributions
*   **Animations**: Built using the [Universal Animation Library by Quaternius](https://quaternius.com/packs/universalanimationlibrary.html).
