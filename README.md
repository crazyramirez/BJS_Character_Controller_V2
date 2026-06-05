# 🎮 3D Character Animation Controller V2 for Babylon.js

An advanced third-person character locomotion and physics framework built with **Babylon.js**. This framework provides a fluid, powerful, and easy-to-use Character Controller with integrated physics, animations, and high-end visual features.

🎮 **Live Demo**: [https://viseni.com/_demos_/bjs_character_controller_v2/](https://viseni.com/_demos_/bjs_character_controller_v2/)

![BJS Character Controller V2 Screenshot](assets/screenshot.jpg)

> ☕ If this controller saves you time, consider supporting its development!
>
> <a href="https://www.buymeacoffee.com/drlerian" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="42"></a>

---

## 🚀 Key Features

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
*   `Space`: Jump / Double Jump (or queue landing roll).
*   `R`: Dodge roll.
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
1.  **`character-controller.js`**: Holds `AnimCtrl` (animation blending/state machine) and `CharCtrl` (inputs, movement physics, collisions).
2.  **`custom-hud.js`**: Tactile settings panel (toggles for Camera Lock, Dynamic FOV, Double Jump, Air Control, and sliders).
3.  **`custom-pointer.js`**: Responsive custom cursor.

See the `loadCharacter` function inside [js/app.js](js/app.js) for a fully documented production loading example.

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
