(function () {
  const hudHTML = `
    <div class="panel main-panel">
      <button id="hud-toggle" aria-label="Toggle HUD">
        <svg class="toggle-icon" viewBox="0 0 24 24">
          <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
        </svg>
      </button>
      <button id="hud-info" aria-label="Show Information" style="position: absolute; top: 10px; right: 38px; width: 22px; height: 22px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); color: #8c8c9c; display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); outline: none; z-index: 110;">
        <span style="font-family: 'Outfit', sans-serif; font-weight: bold; font-size: 13px;">i</span>
      </button>
      <div class="hud-content">
        <div id="hud-engine-badge" style="position: absolute; top: 10px; right: 68px; font-size: 8px; font-weight: 800; padding: 0 8px; height: 22px; display: flex; align-items: center; border-radius: 6px; letter-spacing: 1px; text-transform: uppercase; border: 1px solid transparent; box-sizing: border-box;">—</div>
        <div class="state-label">State</div>
        <div class="state-val" id="hud-state">IDLE</div>
        <div class="weapon-val" id="hud-weapon" style="display:none"></div>
        <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px; color: #8c8c9c;">
          <span class="anim-val" id="hud-anim" style="display: none;">—</span>
          <span class="speed-val" id="hud-speed" style="font-family: monospace; color: #aeb4ff; font-weight: 600; font-size: 17px;">spd: 0.0</span>
          <span style="font-size: 17px; color: rgba(255,255,255,0.15)">|</span>
          <span id="hud-fps-inline" style="color: #00aaff; font-family: monospace; font-weight: 600; font-size: 17px;">fps: 0</span>
        </div>
        <!-- HUD Settings Toggles -->
        <div style="margin-top: 8px;">
          <!-- Group 1: Physics / Speed -->
          <div style="font-size: 8px; font-weight: 800; color: #FFB060; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">PHYSICS & SPEEDS</div>
          
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Havok Physics</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-physics">
              <span class="slider-toggle"></span>
            </label>
          </div>

          <div class="weight-container" id="speed-mult-container"
            style="margin-top: 12px; margin-bottom: 20px;">
            <div class="weight-header"
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span class="weight-label"
                style="font-size: 10px; color: #aeb4ff; letter-spacing: 1px; text-transform: uppercase;">Speed Multiplier</span>
              <span class="weight-val" id="speed-mult-val"
                style="font-size: 11px; font-weight: bold; color: #00ff99;">1.0x</span>
            </div>
            <div class="slider-wrapper" style="display: flex; align-items: center;">
              <input type="range" id="slider-speed-mult" min="0.5" max="2.0" step="0.1" value="1.0" class="weight-slider"
                style="width: 100%; pointer-events: auto;">
            </div>
          </div>

          <!-- Group 2: Camera Follow -->
          <div style="font-size: 8px; font-weight: 800; color: #FFB060; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">CAMERA FOLLOW</div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Lock Camera (Follow)</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-cam-lock">
              <span class="slider-toggle"></span>
            </label>
          </div>

          <div class="weight-container" id="cam-dist-container" style="margin-top: 10px; margin-bottom: 16px;">
            <div class="weight-header"
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span class="weight-label"
                style="font-size: 10px; color: #aeb4ff; letter-spacing: 1px; text-transform: uppercase;">Cam Follow
                Distance</span>
              <span class="weight-val" id="cam-dist-val"
                style="font-size: 11px; font-weight: bold; color: #00ff99;">8.0m</span>
            </div>
            <div class="slider-wrapper" style="display: flex; align-items: center;">
              <input type="range" id="slider-cam-dist" min="2" max="15" step="0.5" value="8" class="weight-slider"
                style="width: 100%; pointer-events: auto;">
            </div>
          </div>

          <div class="weight-container" id="cam-pitch-container"
            style="margin-top: 12px; margin-bottom: 20px;">
            <div class="weight-header"
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span class="weight-label"
                style="font-size: 10px; color: #aeb4ff; letter-spacing: 1px; text-transform: uppercase;">Cam Follow
                Pitch</span>
              <span class="weight-val" id="cam-pitch-val"
                style="font-size: 11px; font-weight: bold; color: #00ff99;">60°</span>
            </div>
            <div class="slider-wrapper" style="display: flex; align-items: center;">
              <input type="range" id="slider-cam-pitch" min="15" max="80" step="1" value="60" class="weight-slider"
                style="width: 100%; pointer-events: auto;">
            </div>
          </div>

          <!-- Group 3: Camera Steering & Input -->
          <div style="font-size: 8px; font-weight: 800; color: #FFB060; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">STEERING & INPUT</div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Lock Pitch (Horizontal Cam)</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-cam-lock-pitch">
              <span class="slider-toggle"></span>
            </label>
          </div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; font-size: 11px; color: #aeb4ff;">
            <span>Joystick Vertical Only</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-joystick-lock-x">
              <span class="slider-toggle"></span>
            </label>
          </div>

          <!-- Group 4: Dynamic FOV -->
          <div style="font-size: 8px; font-weight: 800; color: #FFB060; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">DYNAMIC FOV</div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #aeb4ff; margin-bottom: 6px;">
            <span>Dynamic FOV</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-dynamic-fov" checked>
              <span class="slider-toggle"></span>
            </label>
          </div>

          <div class="weight-container" id="fov-max-container"
            style="margin-top: 12px; margin-bottom: 20px;">
            <div class="weight-header"
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span class="weight-label"
                style="font-size: 10px; color: #aeb4ff; letter-spacing: 1px; text-transform: uppercase;">Dynamic FOV
                Intensity</span>
              <span class="weight-val" id="fov-max-val"
                style="font-size: 11px; font-weight: bold; color: #00ff99;">0.10</span>
            </div>
            <div class="slider-wrapper" style="display: flex; align-items: center;">
              <input type="range" id="slider-fov-max" min="0" max="1" step="0.05" value="0.10" class="weight-slider"
                style="width: 100%; pointer-events: auto;">
            </div>
          </div>

          <!-- Group 5: Air Locomotion -->
          <div style="font-size: 8px; font-weight: 800; color: #FFB060; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">AIR LOCOMOTION</div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Double Jump</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-double-jump" checked>
              <span class="slider-toggle"></span>
            </label>
          </div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; font-size: 11px; color: #aeb4ff;">
            <span>Air Control</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-air-control">
              <span class="slider-toggle"></span>
            </label>
          </div>

          <!-- Group 6: UI / System -->
          <div style="font-size: 8px; font-weight: 800; color: #FFB060; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">SYSTEM & UI</div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Hide Cursor</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-hide-cursor">
              <span class="slider-toggle"></span>
            </label>
          </div>

          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Show Action Text</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-show-combo">
              <span class="slider-toggle"></span>
            </label>
          </div>
        </div>
        <div
          style="margin-top: 10px; font-size: 11px; color: #aeb4ff; font-weight: 500;">
          <span
            style="color: #00ff99; font-weight: bold; font-size: 10px; letter-spacing: 1px; text-transform: uppercase;">Tip:</span>
          Press <span
            style="background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 3px; font-family: monospace; color:#fff; font-size: 10px;">Space</span>
          in air to <span style="color:#ffcc00; font-weight: 600;">Double Jump</span>, or press <span
            style="background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 3px; font-family: monospace; color:#fff; font-size: 10px;">R</span>
          in air for an <span style="color:#00ff99; font-weight: 600;">Air Dash (Mid-Air Roll)</span>!
        </div>
        
        <!-- Inline Mobile Support -->
        <div class="bmac-mobile-only" style="display: none; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;">
          <div class="bmac-content">
            <span class="bmac-tag">Support</span>
            <p class="bmac-text" style="font-size: 11px; color: #8c8c9c; margin-bottom: 8px; line-height: 1.4;">If you like this controller, consider supporting my work!</p>
            <a href="https://buymeacoffee.com/drlerian" target="_blank" rel="noopener noreferrer" class="bmac-btn">
              <svg class="bmac-icon" viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;">
                <path d="M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM2 21h18v-2H2v2z" />
              </svg>
              <span>Buy me a coffee</span>
            </a>
          </div>
        </div>
      </div>
    </div>
    <div class="panel keys-grid">
      <div class="krow"><span>W A S D</span>Move</div>
      <div class="krow"><span>Shift</span>Sprint</div>
      <div class="krow"><span>Ctrl</span>Crouch</div>
      <div class="krow"><span>Space</span>Jump</div>
      <div class="krow"><span>R</span>Roll</div>
      <div class="krow"><span>Q</span>Punch</div>
      <div class="krow"><span>E</span>Spell</div>
      <div class="krow"><span>F</span>Function</div>
    </div>
    <div class="panel bmac-panel">
      <div class="bmac-content">
        <span class="bmac-tag">Support</span>
        <p class="bmac-text">If you like this controller, consider supporting my work!</p>
        <a href="https://buymeacoffee.com/drlerian" target="_blank" rel="noopener noreferrer" class="bmac-btn">
          <svg class="bmac-icon" viewBox="0 0 24 24">
            <path
              d="M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM2 21h18v-2H2v2z" />
          </svg>
          <span>Buy me a coffee</span>
        </a>
      </div>
    </div>
  `;

  // Create the hud container and inject it synchronously
  const hudContainer = document.createElement('div');
  hudContainer.id = 'hud';
  hudContainer.innerHTML = hudHTML;
  document.body.appendChild(hudContainer);

  // Create the hud-fps container and inject it synchronously
  const hudFps = document.createElement('div');
  hudFps.id = 'hud-fps';
  document.body.appendChild(hudFps);

  // Set engine badge based on current selection
  const usePhysics = localStorage.getItem('use-physics') !== 'false';
  const badge = document.getElementById('hud-engine-badge');
  if (badge) {
    if (usePhysics) {
      badge.textContent = 'HAVOK PHYSICS';
      badge.style.background = 'rgba(0, 255, 153, 0.12)';
      badge.style.border = '1px solid rgba(0, 255, 153, 0.3)';
      badge.style.color = '#00ff99';
      badge.style.textShadow = '0 0 8px rgba(0, 255, 153, 0.3)';
    } else {
      badge.textContent = 'SIN FÍSICAS';
      badge.style.background = 'rgba(235, 94, 85, 0.12)';
      badge.style.border = '1px solid rgba(235, 94, 85, 0.3)';
      badge.style.color = '#eb5e55';
      badge.style.textShadow = '0 0 8px rgba(235, 94, 85, 0.3)';
    }
  }

  // Set up Hide Cursor state
  const hideCursorValue = localStorage.getItem('hide-cursor') === 'true';
  if (hideCursorValue) {
    document.body.classList.add('cursor-hidden');
  }
  const hideCursorCheckbox = document.getElementById('toggle-hide-cursor');
  if (hideCursorCheckbox) {
    hideCursorCheckbox.checked = hideCursorValue;
    hideCursorCheckbox.addEventListener('change', (e) => {
      const checked = e.target.checked;
      localStorage.setItem('hide-cursor', checked);
      if (checked) {
        document.body.classList.add('cursor-hidden');
      } else {
        document.body.classList.remove('cursor-hidden');
      }
    });
  }

  // Create and inject the Fullscreen Info Panel Modal
  const modalHTML = `
    <div class="info-modal-content">
      <div class="info-modal-header">
        <div style="display: flex; align-items: center; gap: 14px;">
          <h2 style="margin: 0;">BJS Character Controller V2 - Info & Integration</h2>
          <a href="https://github.com/crazyramirez/BJS_Character_Controller_V2" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #a2a7db; font-size: 11px; text-decoration: none; font-weight: 600; letter-spacing: 0.5px; transition: all 0.25s; height: 24px;" onmouseover="this.style.background='rgba(0, 255, 153, 0.1)'; this.style.borderColor='rgba(0, 255, 153, 0.3)'; this.style.color='#00ff99';" onmouseout="this.style.background='rgba(255, 255, 255, 0.04)'; this.style.borderColor='rgba(255, 255, 255, 0.1)'; this.style.color='#a2a7db';>
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.137 20.162 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
            <span>GitHub</span>
          </a>
        </div>
        <button class="info-modal-close" id="info-modal-close" aria-label="Close panel">✕</button>
      </div>
      <div class="info-modal-body">
        <div class="info-modal-sidebar">
          <button class="info-tab-btn active" data-tab="tab-controls">🎮 CONTROLS</button>
          <button class="info-tab-btn" data-tab="tab-integration">🛠️ INTEGRATION</button>
          <button class="info-tab-btn" data-tab="tab-physics-anims">⚖️ PHYSICS & ANIMS</button>
        </div>
        <div class="info-modal-panes">
          <!-- CONTROLS PANE -->
          <div class="info-pane active" id="tab-controls">
            <h3>Controls Layout (Keyboard & Mouse)</h3>
            <p>The application is designed with a fluid Third-Person action locomotion control scheme (Action RPG) optimized for PC keyboards, mice, and mobile touchscreens.</p>
            
            <table class="info-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Keyboard / Mouse</th>
                  <th>Mobile Touch Control</th>
                  <th>Behavior Details</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Movement</strong></td>
                  <td><span class="info-kbd">W</span> <span class="info-kbd">A</span> <span class="info-kbd">S</span> <span class="info-kbd">D</span> / <span class="info-kbd">↑</span><span class="info-kbd">↓</span><span class="info-kbd">←</span><span class="info-kbd">→</span></td>
                  <td>Floating Virtual Joystick (Left Side)</td>
                  <td>The character runs/walks in the direction relative to the camera view.</td>
                </tr>
                <tr>
                  <td><strong>Camera (Orbit)</strong></td>
                  <td>Drag with <span class="info-kbd">Left Click</span></td>
                  <td>Drag anywhere on screen (Right Side)</td>
                  <td>Free orbit. Double click/tap anywhere on the canvas centers the camera behind the character.</td>
                </tr>
                <tr>
                  <td><strong>Sprint</strong></td>
                  <td><span class="info-kbd">Shift</span> (Toggle)</td>
                  <td><span class="info-kbd">SPRINT</span> Button</td>
                  <td>Increases maximum movement speed. Coexists seamlessly with the Crouch state.</td>
                </tr>
                <tr>
                  <td><strong>Crouch</strong></td>
                  <td><span class="info-kbd">Ctrl</span> (Toggle)</td>
                  <td><span class="info-kbd">CROUCH</span> Button</td>
                  <td>Reduces movement speed and physical capsule height, letting you pass under low obstacles.</td>
                </tr>
                <tr>
                  <td><strong>Jump / Double Jump</strong></td>
                  <td><span class="info-kbd">Space</span></td>
                  <td><span class="info-kbd">JUMP</span> Button</td>
                  <td>Standard jump. Press again mid-air for a second impulse (if enabled in HUD).</td>
                </tr>
                <tr>
                  <td><strong>Dodge Roll</strong></td>
                  <td><span class="info-kbd">R</span></td>
                  <td><span class="info-kbd">ROLL</span> Button</td>
                  <td>
                    Quick defensive dash in the direction of current movement.
                    <br>• <strong>Action Interrupt:</strong> Instantly cancels active attack combos or spell casts.
                    <br>• <strong>Roll Cooldown:</strong> 1.1s cooldown between rolls with a "DODGE COOLDOWN" HUD alert.
                    <br>• <strong>Air Dash (Mid-Air Roll):</strong> If Double Jump is enabled, dash in the air with a horizontal speed boost and a 55% jump-power vertical hop (usable even after double jumping!).
                  </td>
                </tr>
                <tr>
                  <td><strong>Attack Combos</strong></td>
                  <td><span class="info-kbd">Q</span></td>
                  <td><span class="info-kbd">ACT</span> Button</td>
                  <td>Quick physical combo attack (Jab & Cross). Chain attacks by pressing repeatedly.</td>
                </tr>
                <tr>
                  <td><strong>Spell Cast</strong></td>
                  <td><span class="info-kbd">E</span></td>
                  <td><span class="info-kbd">SPELL</span> Button</td>
                  <td>Casts an elemental magic projectile with a premium charging/channeling animation.</td>
                </tr>
                <tr>
                  <td><strong>Interact / Function</strong></td>
                  <td><span class="info-kbd">F</span></td>
                  <td><span class="info-kbd">ACT</span> Button / Auto</td>
                  <td>Interacts with triggers or picks up items.</td>
                </tr>
              </tbody>
            </table>
            
            <h3>Procedural Animations & Physics Highlights</h3>
            <div class="info-grid">
              <div class="info-card">
                <h4>Squash & Stretch & Impacts</h4>
                <p>When falling from high ground, the character's mesh undergoes elastic deformation (squash & stretch) combined with a rotational camera shake relative to fall velocity.</p>
              </div>
              <div class="info-card">
                <h4>Turn Banking & Leaning</h4>
                <p>When turning sharply at speed, the character model procedurally leans into the turn direction to simulate momentum using real-time bone transformation.</p>
              </div>
            </div>

            <h3>Remapping Key Bindings</h3>
            <p>You can customize all keyboard interactions during initialization by passing a custom <code>keys</code> configuration object to the <code>CharCtrl</code> constructor:</p>
            <div class="info-code">const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, {
  keys: {
    MOVE_FORWARD: ['KeyW', 'ArrowUp'],      // Move forward
    MOVE_BACKWARD: ['KeyS', 'ArrowDown'],   // Move backward
    MOVE_LEFT: ['KeyA', 'ArrowLeft'],       // Move left
    MOVE_RIGHT: ['KeyD', 'ArrowRight'],     // Move right
    SPRINT: ['ShiftLeft', 'ShiftRight'],    // Run / Sprint
    CROUCH: ['ControlLeft', 'ControlRight'],// Crouch
    JUMP: ['Space'],                        // Jump / Double jump (in mid-air)
    ROLL: ['KeyR'],                         // Roll / Dodge
    PUNCH: ['KeyQ'],                        // Punch combo (Jab & Cross)
    SPELL: ['KeyE'],                        // Cast spell
    INTERACT: ['KeyF'],                     // Interact / Pick up items
  }
});</div>
          </div>
          
          <!-- INTEGRATION PANE -->
          <div class="info-pane" id="tab-integration">
            <h3>How to Integrate in your Project</h3>
            <p>The controller codebase is composed of three vanilla scripts in the <span class="info-kbd">js/</span> directory that run out-of-the-box (note that the HUD interface is optional):</p>
            <ul>
              <li><strong>character-controller.js:</strong> The unified core engine. Handles locomotion state machines, blends, and Havok/Kinematic motion paths (Required).</li>
              <li><strong>custom-hud.js (Optional):</strong> The tactile settings overlay and quick configurations drawer.</li>
              <li><strong>custom-pointer.js (Optional):</strong> Custom reactive mouse cursor.</li>
            </ul>
            <p><strong>Note on cursor styling:</strong> You can hide all cursors (both hardware dot and custom canvas ring) by toggling the <strong>Hide Cursor</strong> switch in the HUD, which persists your preference in local storage and adds the <code>.cursor-hidden</code> class to the <code>body</code> element.</p>

            <h3>Recommended HTML Structure</h3>
            <div class="info-code">&lt;!-- Import BabylonJS & Havok Physics WebAssembly --&gt;
&lt;script src="https://cdn.babylonjs.com/havok/HavokPhysics_umd.js"&gt;&lt;/script&gt;
&lt;script src="https://cdn.babylonjs.com/babylon.js"&gt;&lt;/script&gt;
&lt;script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"&gt;&lt;/script&gt;

&lt;!-- Import custom controllers (custom-hud.js is optional) --&gt;
&lt;script src="js/custom-hud.js"&gt;&lt;/script&gt;
&lt;script src="js/character-controller.js"&gt;&lt;/script&gt;
&lt;script src="js/app.js"&gt;&lt;/script&gt;</div>

            <h3>High-Level Setup Helper (Recommended)</h3>
            <p>You can initialize physics and load the character in just a few lines of code using the shared helper functions: <code>initPhysics</code> and <code>setupCharacter</code> (wrapped in a clean <code>loadCharacter</code> helper function across the app templates). This helper supports configuring model paths, spawn locations, bounding ellipsoids, controls, and animations:</p>
            <div class="info-code">// 1. Define character initialization helper
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
}</div>

            <h3>Minimal Instantiation (Manual Setup)</h3>
            <div class="info-code">// 1. Initialize the Animation Controller (AnimCtrl)
const animCtrl = new AnimCtrl(characterAsset.animationGroups, scene);

// 2. Initialize the Character Controller (CharCtrl)
// playerCapsule is the physics transform root; charRoot is the visual mesh child
const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, {
  usePhysics: true, // or false to skip Havok WASM and run kinematic collisions
  config: {
    SPD_WALK: 2.5,
    SPD_SPRINT: 5.0,
    GRAV: 22.0,
    SPEED_MULTIPLIER: 1.0
  }
});</div>

            <h3>Reference Example Templates</h3>
            <ul>
              <li><strong>js/app-minimal.js:</strong> Barebones boilerplate to see engine setup, capsule creation, mesh parenting, and basic constructor bindings.</li>
              <li><strong>js/app-complex.js:</strong> High-geometry environment demonstrating raycast grounding, stair climbing, and mesh slope alignment.</li>
              <li><strong>js/app.js:</strong> Production loading flow including lighting rig, soft shadow maps, Aces Tonemapping, post-processing pipelines, and HUD syncing.</li>
            </ul>
          </div>
          
          <!-- PHYSICS & ANIMATIONS PANE -->
          <div class="info-pane" id="tab-physics-anims">
            <h3>Havok Physics vs. Kinematic Regimes</h3>
            <p>The controller runs on a unified codebase supporting two movement regimes toggled dynamically:</p>
            <ul>
              <li><strong>Havok WASM Physics:</strong> The character root is a dynamic <span class="info-kbd">PhysicsBody</span>. It reacts to impulses, collision materials, mass properties, and pushes dynamic shapes realistically.</li>
              <li><strong>Kinematic Collisions:</strong> Bypasses Havok and relies on Babylon's native ellipsoid sweep resolver (<span class="info-kbd">moveWithCollisions</span>). Ensures deterministic locomotion.</li>
            </ul>
            
            <h3>Programmatic Regimes Configuration</h3>
            <p>Define the active movement mode by setting the local storage variable or passing parameters inside the controller constructor:</p>
            <div class="info-code">// Force Kinematic Mode (skips Havok WASM loading)
localStorage.setItem('use-physics', 'false');

// Force Havok WASM Physics Mode
localStorage.setItem('use-physics', 'true');

// Clear overrides and revert to automatic detection
localStorage.removeItem('use-physics');</div>

            <h3>Physics & Speeds Configuration</h3>
            <p>Customize forces, limits, speeds, and camera properties by passing a <code>config</code> object to the <code>CharCtrl</code> constructor:</p>
            <div class="info-code">const charCtrl = new CharCtrl(playerCapsule, charRoot, camera, animCtrl, scene, {
  config: {
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
    CAM_FOLLOW_LOCK: false, // If true, the camera is locked behind the character's facing direction
    CAM_FOLLOW_PITCH: 1.047, // Camera follow lock pitch (beta angle in radians, approx 60 degrees)
    CAM_FOLLOW_DIST: 8.0, // Camera follow lock distance (radius in meters)
    CAM_LOCK_PITCH: false,   // If true, drag input only rotates camera horizontally (locks vertical/pitch axis)
    JOYSTICK_LOCK_X: false,  // If true, joystick input is locked to vertical axis only (no strafing/turning)
    DOUBLE_JUMP_ENABLED: true, // If true, the character can perform a double jump in mid-air
    SPEED_MULTIPLIER: 1.0     // Speed multiplier for walking and running
  }
});</div>

            <h3>Dynamic Animations Swapping & Retargeting</h3>
            <p>Reassign clips or crop keyframe ranges programmatically via the animation controller (<span class="info-kbd">animCtrl</span>):</p>
            <div class="info-code">// REMAP Animations -- You can setup different animation here
animCtrl.setWalkAnim(filteredGroups[15]);
animCtrl.setAnimationRanges('Walk_Loop', 0, 15);
animCtrl.setRunAnim(newRunAnimGroup);
animCtrl.setIdleAnim(newIdleAnimGroup);</div>

            <h3>Merging Animation Files (merge_animations.mjs)</h3>
            <p>Consolidate multiple GLB/FBX animation assets into a single optimized character asset package using glTF-Transform:</p>
            <div class="info-code"># Install dependencies
npm install @gltf-transform/core fs-extra

# Run merge utility
node js/merge_animations.mjs -c base.glb -a animations.glb -o assets/character_animated.glb</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const infoModal = document.createElement('div');
  infoModal.id = 'info-panel-modal';
  infoModal.innerHTML = modalHTML;
  document.body.appendChild(infoModal);

  // Tab navigation logic inside Modal
  const tabButtons = infoModal.querySelectorAll('.info-tab-btn');
  const panes = infoModal.querySelectorAll('.info-pane');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      tabButtons.forEach(b => b.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const activePane = infoModal.querySelector('#' + targetTab);
      if (activePane) activePane.classList.add('active');

      // Blur tab button to release focus
      btn.blur();
      const canvasEl = document.getElementById('c');
      if (canvasEl) canvasEl.focus();
    });
  });

  // Click to copy code blocks
  const codeBlocks = infoModal.querySelectorAll('.info-code');
  codeBlocks.forEach(block => {
    block.addEventListener('click', () => {
      navigator.clipboard.writeText(block.textContent).then(() => {
        block.classList.add('copied');
        setTimeout(() => {
          block.classList.remove('copied');
        }, 1500);
      }).catch(err => {
        console.error('Could not copy text: ', err);
      });
    });
  });

  // Open & Close logic
  const hudInfoBtn = document.getElementById('hud-info');
  const closeBtn = document.getElementById('info-modal-close');

  const openInfoPanel = () => {
    infoModal.classList.add('open');
    // Blur button and focus canvas/page container to clear keyboard traps
    if (hudInfoBtn) hudInfoBtn.blur();
  };

  const closeInfoPanel = () => {
    infoModal.classList.remove('open');
    if (closeBtn) closeBtn.blur();
    const canvasEl = document.getElementById('c');
    if (canvasEl) canvasEl.focus();
  };

  if (hudInfoBtn) {
    hudInfoBtn.addEventListener('click', openInfoPanel);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closeInfoPanel);
  }

  // Close with Escape or open/close with keyboard Shortcut "I"
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (infoModal.classList.contains('open')) {
        closeInfoPanel();
      }
    } else if (e.key === 'i' || e.key === 'I') {
      // Check if user is typing in an input field (to avoid triggers if HUD has inputs, though there are only checkboxes/sliders here)
      if (document.activeElement && document.activeElement.tagName === 'INPUT') {
        return;
      }
      if (infoModal.classList.contains('open')) {
        closeInfoPanel();
      } else {
        openInfoPanel();
      }
    }
  });

  // Close on backdrop click
  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) {
      closeInfoPanel();
    }
  });

  // Handle cursor-over-hud class toggling to show cursor when hovering interactive panels/controls
  const enterHUD = () => document.body.classList.add('cursor-over-hud');
  const leaveHUD = () => document.body.classList.remove('cursor-over-hud');

  // Bind to settings panels
  const panels = document.querySelectorAll('.panel');
  panels.forEach(p => {
    p.addEventListener('pointerenter', enterHUD);
    p.addEventListener('pointerleave', leaveHUD);
  });

  // Bind to mobile touch elements
  const joystickZone = document.getElementById('joystick-zone');
  if (joystickZone) {
    joystickZone.addEventListener('pointerenter', enterHUD);
    joystickZone.addEventListener('pointerleave', leaveHUD);
  }

  const touchButtons = document.querySelectorAll('.touch-btn');
  touchButtons.forEach(btn => {
    btn.addEventListener('pointerenter', enterHUD);
    btn.addEventListener('pointerleave', leaveHUD);
  });

  // Bind to fullscreen modal
  infoModal.addEventListener('pointerenter', enterHUD);
  infoModal.addEventListener('pointerleave', leaveHUD);

  // ── HUD COLLAPSE CONTROLLER ──────────────────────────────
  const hud = document.getElementById('hud');
  const toggle = document.getElementById('hud-toggle');
  if (toggle && hud) {
    const isCollapsed = localStorage.getItem('hud-collapsed') === 'true';
    if (isCollapsed) {
      hud.classList.add('collapsed');
    }

    toggle.addEventListener('click', () => {
      hud.classList.toggle('collapsed');
      localStorage.setItem('hud-collapsed', hud.classList.contains('collapsed'));
    });
  }

  // ── HUD FOCUS RELEASE (BLUR) CONTROLLER ──────────────────
  const interactiveElements = document.querySelectorAll('#hud input, #hud button, #hud-toggle, #hud a');
  interactiveElements.forEach(el => {
    const releaseFocus = () => {
      el.blur();
      const canvasEl = document.getElementById('c');
      if (canvasEl) canvasEl.focus();
    };
    el.addEventListener('click', releaseFocus);
    el.addEventListener('change', releaseFocus);
    el.addEventListener('input', releaseFocus);
  });

  // ── BIND HUD CONTROLS ─────────────────────────────────────
  window.bindHUDControls = function (charCtrl, camera, usePhysics) {
    const $ = id => document.getElementById(id);

    const togglePhysics = $('toggle-physics');
    if (togglePhysics) {
      togglePhysics.checked = usePhysics;
      togglePhysics.addEventListener('change', (e) => {
        localStorage.setItem('use-physics', e.target.checked);
        window.location.reload();
      });
    }

    const toggleCamLock = $('toggle-cam-lock');
    if (toggleCamLock) {
      toggleCamLock.checked = charCtrl.CAM_FOLLOW_LOCK;
      toggleCamLock.addEventListener('change', (e) => {
        charCtrl.CAM_FOLLOW_LOCK = e.target.checked;
        localStorage.setItem('cam-follow-lock', e.target.checked);
      });
    }

    const toggleDynamicFov = $('toggle-dynamic-fov');
    const sliderFovMax = $('slider-fov-max');
    const fovMaxVal = $('fov-max-val');

    if (toggleDynamicFov) {
      toggleDynamicFov.checked = charCtrl.DYNAMIC_FOV;
      toggleDynamicFov.addEventListener('change', (e) => {
        charCtrl.DYNAMIC_FOV = e.target.checked;
        localStorage.setItem('dynamic-fov', e.target.checked);
      });
    }

    const toggleDoubleJump = $('toggle-double-jump');
    if (toggleDoubleJump) {
      toggleDoubleJump.checked = charCtrl.DOUBLE_JUMP_ENABLED;
      toggleDoubleJump.addEventListener('change', (e) => {
        charCtrl.DOUBLE_JUMP_ENABLED = e.target.checked;
        localStorage.setItem('double-jump-enabled', e.target.checked);
      });
    }

    const toggleAirControl = $('toggle-air-control');
    if (toggleAirControl) {
      toggleAirControl.checked = charCtrl.AIR_CONTROL;
      toggleAirControl.addEventListener('change', (e) => {
        charCtrl.AIR_CONTROL = e.target.checked;
        localStorage.setItem('air-control-enabled', e.target.checked);
      });
    }

    const toggleCamLockPitch = $('toggle-cam-lock-pitch');
    if (toggleCamLockPitch) {
      toggleCamLockPitch.checked = charCtrl.CAM_LOCK_PITCH;
      toggleCamLockPitch.addEventListener('change', (e) => {
        charCtrl.CAM_LOCK_PITCH = e.target.checked;
        localStorage.setItem('cam-lock-pitch', e.target.checked);
      });
    }

    const toggleJoystickLockX = $('toggle-joystick-lock-x');
    if (toggleJoystickLockX) {
      toggleJoystickLockX.checked = charCtrl.JOYSTICK_LOCK_X;
      toggleJoystickLockX.addEventListener('change', (e) => {
        charCtrl.JOYSTICK_LOCK_X = e.target.checked;
        localStorage.setItem('joystick-lock-x', e.target.checked);
      });
    }

    if (sliderFovMax && fovMaxVal) {
      sliderFovMax.value = charCtrl.DYNAMIC_FOV_MAX;
      fovMaxVal.textContent = charCtrl.DYNAMIC_FOV_MAX.toFixed(2);
      sliderFovMax.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        charCtrl.DYNAMIC_FOV_MAX = val;
        fovMaxVal.textContent = val.toFixed(2);
        localStorage.setItem('dynamic-fov-max', val);
      });
    }

    const sliderSpeedMult = $('slider-speed-mult');
    const speedMultVal = $('speed-mult-val');
    if (sliderSpeedMult && speedMultVal) {
      sliderSpeedMult.value = charCtrl.SPEED_MULTIPLIER;
      speedMultVal.textContent = charCtrl.SPEED_MULTIPLIER.toFixed(1) + 'x';
      sliderSpeedMult.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        charCtrl.SPEED_MULTIPLIER = val;
        speedMultVal.textContent = val.toFixed(1) + 'x';
        localStorage.setItem('speed-multiplier', val);
      });
    }

    const sliderCamPitch = $('slider-cam-pitch');
    const camPitchVal = $('cam-pitch-val');
    if (sliderCamPitch && camPitchVal) {
      const initialDeg = Math.round(charCtrl.CAM_FOLLOW_PITCH * 180 / Math.PI);
      sliderCamPitch.value = initialDeg;
      camPitchVal.textContent = initialDeg + '°';
      sliderCamPitch.addEventListener('input', (e) => {
        const deg = parseInt(e.target.value);
        const rad = deg * Math.PI / 180;
        charCtrl.CAM_FOLLOW_PITCH = rad;
        camPitchVal.textContent = deg + '°';
        localStorage.setItem('cam-follow-pitch', rad);
      });
    }

    const sliderCamDist = $('slider-cam-dist');
    const camDistVal = $('cam-dist-val');
    if (sliderCamDist && camDistVal) {
      sliderCamDist.value = charCtrl.CAM_FOLLOW_DIST;
      camDistVal.textContent = charCtrl.CAM_FOLLOW_DIST.toFixed(1) + 'm';
      sliderCamDist.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        charCtrl.CAM_FOLLOW_DIST = val;
        camDistVal.textContent = val.toFixed(1) + 'm';
        localStorage.setItem('cam-follow-dist', val);
        if (charCtrl.CAM_FOLLOW_LOCK) {
          camera.radius = val;
        }
      });
    }

    const toggleShowCombo = $('toggle-show-combo');
    if (toggleShowCombo) {
      toggleShowCombo.checked = charCtrl.SHOW_COMBO;
      toggleShowCombo.addEventListener('change', (e) => {
        charCtrl.SHOW_COMBO = e.target.checked;
        localStorage.setItem('show-combo', e.target.checked);
      });
    }
  };
})();
