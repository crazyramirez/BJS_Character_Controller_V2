<a href="https://www.viseni.com" target="_blank"><img src="https://www.viseni.com/_demos_/viseni-logo-white.webp" style="width: 200px; margin-bottom: 50px"></a>

# 3D Character Animation Controller for Babylon.js

An advanced 3D character animation and third-person controller framework built with **Babylon.js**. This framework features high-fidelity collision physics, dynamic locomotion blend trees, procedural dust particles, advanced visual suspension mechanics, combat combos, spell casting, and built-in mobile touch support.

🎮 **Live Demo**: [https://viseni.com/_demos_/bjs_character_controller_v2/](https://viseni.com/_demos_/bjs_character_controller_v2/)

![BJS Character Controller V2 Screenshot](assets/screenshot.jpg)

---

## 🎮 Demo Features & Engine Mechanics

The demo showcases a third-person sandbox where a 3D character interacts with a physical environment under active collisions. 

### Core Engine Capabilities:
*   **Stable Collision Physics**: Utilizes a capsule collider with `moveWithCollisions` physics for fluid world navigation, smooth step-climbing, and ramp-sliding without vertical jitter.
*   **Locomotion Blend Tree (Reactive Animations)**: A unified `Locomotion` virtual group interpolates animation weights in real time between `Idle_Loop`, `Walk_Loop`, and `Sprint_Loop` based on physical velocity. This makes animations fully reactive to the character's movement: as the velocity changes, the model transitions fluidly from walking to jogging and sprinting. This reactivity is especially noticeable on mobile devices using the touch joystick, where dragging the analog control gradually increases speed, and the animations correspond and scale dynamically to match the movement.
*   **Procedural Footstep & Impact Particles**: Generates dynamic smoke/dust trails at the character's feet during walking, sprinting, and rolling, with heavy bursts emitted upon impact landing.
*   **Advanced Visual Suspension & Kinetic Animation**:
    *   **Y-Suspension**: Absorbs height shocks when stepping up or down, smoothly returning the visual mesh to its height baseline.
    *   **Kinetic Locomotion Bobbing**: Simulates physical stride weight shifts by translating the mesh locally along the X and Y axes depending on walk/sprint frequencies.
    *   **Procedural Leaning (Pitch & Roll)**: Leans the character forward during acceleration, backward during braking, and banks (rolls) the character into sharp turns.
    *   **Squash & Stretch**: Elastic scale distortion stretching the mesh vertically during jumps/falls and squashing it on impact.
*   **Dynamic Camera Mechanics**:
    *   **Tunnel Vision (FOV Expansion)**: Smoothly expands the camera Field of View (FOV) at higher velocities.
    *   **Landing Impact Shake**: Triggers multi-axis rotational camera shake depending on landing height/velocity.
*   **Dynamic Stair & Slope Speed Adjustments**: Automatically scales movement speed based on vertical displacement rate (reducing speed by up to 22% when climbing, and increasing it by up to 8% when descending).
*   **Ledge Snap System**: Applies downward snap pressure when walking off steps to prevent floating and eliminate micro-airborne physics state switching.
*   **Crouch Ellipsoid Scaling**: Dynamically shrinks and offsets the physical capsule collider when crouching, allowing the character to fit under low obstacles.
*   **Mobile-Ready & Adaptive Inputs**: Automatically detects touch displays, spawning a dual-zone analog joystick and floating action buttons with full multi-touch capture.
*   **High-End Post-Processing**: Includes ACES tone mapping, contrast and exposure color grading, FXAA anti-aliasing, and soft vignette/aberration overlays.

### Keyboard & Mouse Controls:
*   `W`, `A`, `S`, `D` / `Arrow Keys`: Move relative to camera orientation.
*   `Shift`: Sprint.
*   `Ctrl`: Crouch (toggles capsule height; uncrouching is blocked if a ceiling is detected).
*   `Space`: Jump (with gravity phase animations; triggers dodge-roll recovery on landing if held).
*   `R`: Dodge roll (provides horizontal momentum).
*   `Q`: Punch combo (triggers a Jab; tap again with correct timing to follow up with a Cross).
*   `E`: Spell casting (three-stage cast: enter, shoot, exit).
*   `F`: Interact / Trigger mechanisms.
*   `Mouse Drag`: Orbit camera around the character.

---

## 🛠️ Implementing the Character Controller in Your Game

The framework is split into two modular classes in [character-controller.js](file:///d:/DEV/bjs_character_animation_controller_v2/js/character-controller.js):
1.  **`AnimCtrl`**: Handles animation state transitions, cross-fades, custom defaults, and virtual groups (like locomotion blend trees).
2.  **`CharCtrl`**: Drives collision physics, keyboard/touch input listeners, procedural visuals, gravity, and particle emission.

Both classes are **decoupled from the DOM/UI**, making them easy to port to any Babylon.js application.

### Step 1: Include Required Scripts
Ensure `character-controller.js` is imported or included in your HTML before your main application code.

### Step 2: Instantiate and Configure
Below is a clean script demonstrating how to set up the capsule, bind the visual mesh, and initialize the controllers:

```javascript
// 1. Load the animated GLB character model
const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'character_combined.glb', scene);
const charVisualMesh = charRes.meshes[0];

// 2. Configure shadows and disable raycast pickability on character meshes
charRes.meshes.forEach(m => {
  shadowGenerator.addShadowCaster(m, true);
  m.receiveShadows = true;
  m.isPickable = false;
});

// 3. Create the physical capsule collider
const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.35, height: 1.8 }, scene);
playerCapsule.position.set(0, 1.3, 0);
playerCapsule.visibility = 0; // Hide the physics capsule
playerCapsule.checkCollisions = true;
playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);

// 4. Parent visual mesh to capsule collider and offset Y
charVisualMesh.setParent(playerCapsule);
charVisualMesh.position.set(0, -0.98, 0); // Offset to align feet with the base
charVisualMesh.rotation.set(0, 0, 0);

// 5. Instantiate AnimCtrl using base animations
const animCtrl = new AnimCtrl(charRes.animationGroups, scene);

// 6. Instantiate CharCtrl with customized physics values and callbacks
const charCtrl = new CharCtrl(playerCapsule, charVisualMesh, camera, animCtrl, scene, {
  config: {
    GRAV: 22,             // Gravity strength
    JUMP_PWR: 9.5,        // Jump launch velocity
    SPD_WALK: 2.4,        // Walk speed (m/s)
    SPD_SPRINT: 6.0,      // Sprint speed (m/s)
    ACCEL: 14,            // Ground acceleration rate
    DECEL: 16,            // Ground deceleration rate
    ROT_SPD: 50,          // Rotation turn rate
    AIR_CONTROL: true     // Allow steering while airborne
  },
  callbacks: {
    onStateChange: (state) => {
      myHUD.updateState(state);
    },
    onSpeedChange: (speed) => {
      myHUD.updateSpeedometer(speed);
    },
    onCombo: (comboText, isActive) => {
      myHUD.displayComboBanner(comboText, isActive);
    }
  }
});

// 7. Establish camera follow routine
scene.registerBeforeRender(() => {
  const targetPoint = playerCapsule.position.add(new BABYLON.Vector3(0, 0.4, 0)); // Target chest level
  camera.target = BABYLON.Vector3.Lerp(camera.target, targetPoint, 0.12);
});
```

---

## ⚙️ Advanced Configuration Options

The `CharCtrl` constructor accepts an options object to customize physics constants, mobile buttons, and callbacks.

### Configuration Constants (`config`)
| Option | Default | Description |
|---|---|---|
| `GRAV` | `22` | Acceleration due to gravity. |
| `JUMP_PWR` | `9.5` | Upward velocity applied during jumps. |
| `SPD_WALK` | `2.4` | Base walking speed. |
| `SPD_JOG` | `3` | Base jogging speed. |
| `SPD_SPRINT` | `6` | Sprinting speed. |
| `SPD_CROUCH` | `2` | Speed while crouch-walking. |
| `SPD_CROUCH_RUN` | `3.6`| Speed while crouch-sprinting. |
| `ACCEL` | `14` | How quickly the character reaches target speed. |
| `DECEL` | `16` | Friction deceleration rate when stopping. |
| `ROT_SPD` | `50` | Yaw turning rotation interpolation speed. |
| `AIR_CONTROL` | `false`| If true, players can steer the character mid-air. |

### Mobile Touch Controls Mapping (`touch`)
By default, touch integrations map floating screen button interactions to specific physical key codes:
```javascript
touch: {
  zoneId: 'joystick-zone', // DOM ID of joystick drag area
  ringId: 'joystick-ring', // DOM ID of joystick backdrop ring
  knobId: 'joystick-knob', // DOM ID of sliding central knob
  buttons: {
    'btn-sprint': 'ShiftLeft',
    'btn-jump': 'Space',
    'btn-roll': 'KeyR',
    'btn-crouch': 'ControlLeft',
    'btn-act': 'KeyF'
  }
}
```

---

## 🔄 Animation Retargeting & Merging CLI (`merge_animations.mjs`)

The framework includes [merge_animations.mjs](file:///d:/DEV/bjs_character_animation_controller_v2/js/merge_animations.mjs), a Node.js command-line utility used to combine external skeletal animations (such as those exported from Mixamo) directly into your base character GLB.

This produces a **single consolidated GLB file** containing all the necessary animations, significantly reducing network request overhead.

### Key Capabilities of the Script:
*   **Automatic Quaternion Axis Correction**: Corrects the coordinate system differences between skeletal armatures (e.g., Mixamo/Unity) and the target character's rest pose using base-change transformations.
*   **Proportional Scale Preservation**: Ignores scale channels (`IGNORE_SCALE`) and strips translations on non-root bones (`IGNORE_NON_ROOT_TRANSLATION`), preventing limb deformation when retargeting between characters of different sizes.
*   **Draco Geometry Compresion**: Integrates Google Draco compression and curve resampling to reduce the final combined GLB file size by up to 70%.
*   **Manifest Generation**: Automatically outputs a plain-text manifest file (`character_combined_animations.txt`) listing the clean names of all packaged animations.

### Prerequisites:
Install Node.js and the glTF-Transform pipeline dependencies:
```bash
npm install fs-extra @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf
```

### Usage Command:
Place your base skeletal character GLB and your animations GLB in an input directory, then execute:
```bash
node js/merge_animations.mjs -c base_character.glb -a animations.glb -o assets/character_combined.glb
```

#### CLI Flags:
*   `-c`, `--character`: Path to the source character mesh model.
*   `-a`, `--animations`: Path to the source GLB containing target skeletal animations.
*   `-o`, `--output`: Path where the consolidated GLB will be written.

#### Manual Rig Correction Parameters:
If the character's limbs cross or stick too close to the body due to skeletal differences, open `merge_animations.mjs` and tweak the angle offsets:
*   `ARM_SPREAD_ANGLE = -5`: Separation angle offset (in degrees) for the upper arms.
*   `LEG_SPREAD_ANGLE = 5`: Outward spread angle offset (in degrees) for the upper legs.

---

## 📚 Credits & Attributions

*   **Animations**: Assets from the [Universal Animation Library by Quaternius](https://quaternius.com/packs/universalanimationlibrary.html) (a highly recommended and extremely comprehensive library for game development).
