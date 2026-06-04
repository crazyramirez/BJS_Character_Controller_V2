(function () {
  const hudHTML = `
    <div class="panel main-panel">
      <button id="hud-toggle" aria-label="Toggle HUD">
        <svg class="toggle-icon" viewBox="0 0 24 24">
          <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
        </svg>
      </button>
      <div class="hud-content">
        <div class="state-label">State</div>
        <div class="state-val" id="hud-state">IDLE</div>
        <div class="state-label" style="margin-top:4px">Animation</div>
        <div class="anim-val" id="hud-anim">—</div>
        <div class="weapon-val" id="hud-weapon"></div>
        <div class="speed-val" id="hud-speed"></div>
        <!-- HUD Settings Toggles -->
        <div style="margin-top: 26px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);">
          <!-- Slider for CAM_FOLLOW_DIST -->
          <div class="weight-container" id="cam-dist-container" style="margin-bottom: 8px;">
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
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: #aeb4ff; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">
            <span>Lock Camera (Follow)</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-cam-lock">
              <span class="slider-toggle"></span>
            </label>
          </div>
          <!-- Slider for CAM_FOLLOW_PITCH -->
          <div class="weight-container" id="cam-pitch-container"
            style="margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px; margin-bottom: 8px;">
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
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #aeb4ff;">
            <span>Dynamic FOV</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-dynamic-fov" checked>
              <span class="slider-toggle"></span>
            </label>
          </div>
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Double Jump</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-double-jump" checked>
              <span class="slider-toggle"></span>
            </label>
          </div>
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Air Control</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-air-control">
              <span class="slider-toggle"></span>
            </label>
          </div>
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Lock Pitch (Horizontal Cam)</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-cam-lock-pitch">
              <span class="slider-toggle"></span>
            </label>
          </div>
          <div class="hud-toggle-container"
            style="display: flex; align-items: center; justify-content: space-between; margin-top: 6px; font-size: 11px; color: #aeb4ff;">
            <span>Joystick Vertical Only</span>
            <label class="switch-toggle">
              <input type="checkbox" id="toggle-joystick-lock-x">
              <span class="slider-toggle"></span>
            </label>
          </div>
          <!-- Slider for DYNAMIC_FOV_MAX -->
          <div class="weight-container" id="fov-max-container"
            style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">
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
        </div>
        <div
          style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px; color: #aeb4ff; font-weight: 500;">
          <span
            style="color: #00ff99; font-weight: bold; font-size: 10px; letter-spacing: 1px; text-transform: uppercase;">Tip:</span>
          Press <span
            style="background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 3px; font-family: monospace; color:#fff; font-size: 10px;">Space</span>
          in air to queue a <span style="color:#ffcc00; font-weight: 600;">Double Jump (Landing Roll)</span>
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
})();
