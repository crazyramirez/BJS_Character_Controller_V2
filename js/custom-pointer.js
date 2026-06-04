/**
 * Premium Custom Pointer System
 * Features:
 * - True zero-latency physical hardware pinpoint cursor using custom SVGs.
 * - Lag-free GPU composited HTML5 Canvas follower & click particle system.
 * - Custom spring-damper physics for realistic micro-animations.
 * - Magnetic element snapping (snaps to interactive HUD components).
 * - Multi-state dynamic color transitions matching the application theme.
 */
class PremiumPointer {
  constructor() {
    this.canvas = null;
    this.ctx = null;

    // Hardware mouse position (immediate)
    this.mouse = { x: -100, y: -100 };
    // Smooth follower position (lerped with spring physics)
    this.follower = { x: -100, y: -100, vx: 0, vy: 0 };

    // Spring physics configuration
    this.spring = {
      tension: 0.15,
      friction: 0.55,
      mass: 1.0
    };

    // UI Interaction states
    this.isHovering = false;
    this.hoverTarget = null;
    this.hoverRect = null;
    this.magneticAlpha = 0; // Transition weight between free follower and snap box

    // Magnetic target coordinates
    this.targetBounds = { x: 0, y: 0, w: 0, h: 0 };
    this.snap = { x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0 };

    // Dynamic color palette
    this.colors = {
      default: 'rgb(0 153 255)',     // Emerald Neon
      defaultGlow: 'rgba(0 170 255 / 0.45)',
      magnetic: 'rgb(0 106 255)',    // Cyan
      magneticGlow: 'rgba(0 132 255 / 0.3)'
    };
    this.currentColor = this.colors.default;
    this.currentGlow = this.colors.defaultGlow;

    this.init();
  }

  init() {
    // Check if device supports touch only (no cursor needed if touch only, though we can still support pointer events)
    if (window.matchMedia('(pointer: coarse)').matches) {
      // Typically mobile, we can skip initializing custom cursor to avoid overhead.
      return;
    }

    // Hide normal cursor
    document.body.classList.add('custom-cursor-active');

    // Create container and canvas
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'custom-pointer-canvas';
    this.canvas.style.position = 'fixed';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100vw';
    this.canvas.style.height = '100vh';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '99999';
    document.body.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d');
    this.resizeCanvas();

    // Event listeners
    window.addEventListener('resize', () => this.resizeCanvas());

    // Mouse movement with high precision pointerevents
    window.addEventListener('pointermove', (e) => this.onPointerMove(e), { passive: true });

    // Setup hover listeners for interactive components
    this.setupInteractions();

    // MutationObserver to attach hovers to dynamic elements if added later
    const observer = new MutationObserver(() => this.setupInteractions());
    observer.observe(document.body, { childList: true, subtree: true });

    // Start animation loop
    requestAnimationFrame((t) => this.tick(t));
  }

  resizeCanvas() {
    if (!this.canvas) return;
    this.canvas.width = window.innerWidth * window.devicePixelRatio;
    this.canvas.height = window.innerHeight * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  onPointerMove(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;

    // Initialize follower to mouse position immediately on first move
    if (this.follower.x === -100) {
      this.follower.x = this.mouse.x;
      this.follower.y = this.mouse.y;
    }
  }

  setupInteractions() {
    // Query all interactive buttons, links, inputs, and toggles
    const targets = document.querySelectorAll(
      'button, a, input[type="range"], input[type="checkbox"], label.switch-toggle, .slider-toggle, #hud-toggle'
    );

    targets.forEach(target => {
      if (target.dataset.pointerBound) return;
      target.dataset.pointerBound = 'true';

      target.addEventListener('mouseenter', (e) => {
        this.isHovering = true;
        this.hoverTarget = e.currentTarget;
        this.updateTargetBounds();
      });

      target.addEventListener('mouseleave', () => {
        this.isHovering = false;
        this.hoverTarget = null;
      });
    });
  }

  updateTargetBounds() {
    if (!this.hoverTarget) return;
    const rect = this.hoverTarget.getBoundingClientRect();
    this.targetBounds = {
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height
    };

    // If not snapping yet, initialize snap dimensions to current dimensions
    if (this.snap.w === 0) {
      this.snap.x = this.follower.x - 10;
      this.snap.y = this.follower.y - 10;
      this.snap.w = 20;
      this.snap.h = 20;
    }
  }

  tick(time) {
    this.update();
    this.draw();
    requestAnimationFrame((t) => this.tick(t));
  }

  update() {
    // 1. Position follower ring directly at mouse coords (instant movement)
    this.follower.x = this.mouse.x;
    this.follower.y = this.mouse.y;
    this.follower.vx = 0;
    this.follower.vy = 0;

    // 2. Manage magnetic snapping transition
    if (this.isHovering && this.hoverTarget) {
      // Get fresh coordinates in case of scroll/resize/HUD collapse animation
      this.updateTargetBounds();

      // Lerp snap target to the element bounds
      const snapTension = 0.22;
      const snapFriction = 0.55;

      const axS = (this.targetBounds.x - this.snap.x) * snapTension;
      const ayS = (this.targetBounds.y - this.snap.y) * snapTension;
      const awS = (this.targetBounds.w - this.snap.w) * snapTension;
      const ahS = (this.targetBounds.h - this.snap.h) * snapTension;

      this.snap.vx = (this.snap.vx + axS) * snapFriction;
      this.snap.vy = (this.snap.vy + ayS) * snapFriction;
      this.snap.vw = (this.snap.vw + awS) * snapFriction;
      this.snap.vh = (this.snap.vh + ahS) * snapFriction;

      this.snap.x += this.snap.vx;
      this.snap.y += this.snap.vy;
      this.snap.w += this.snap.vw;
      this.snap.h += this.snap.vh;

      // Blend magnetic alpha to 1
      this.magneticAlpha += (1 - this.magneticAlpha) * 0.15;
    } else {
      // Blends magnetic alpha back to 0
      this.magneticAlpha += (0 - this.magneticAlpha) * 0.2;

      // Reset snap velocity
      this.snap.vx = 0;
      this.snap.vy = 0;
      this.snap.vw = 0;
      this.snap.vh = 0;
      this.snap.w = 0;
      this.snap.h = 0;
    }
  }

  draw() {
    if (!this.ctx) return;

    // Clear canvas
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // Skip drawing custom elements if mouse is out of viewport/uninitialized
    if (this.mouse.x < 0 || this.mouse.y < 0) return;

    // Draw secondary custom visual elements (follower glow, snap rings)
    this.ctx.save();

    // Draw magnetic snapping outline
    if (this.magneticAlpha > 0.01) {
      this.ctx.globalAlpha = this.magneticAlpha;
      this.ctx.strokeStyle = this.colors.magnetic;
      this.ctx.lineWidth = 1.5;
      this.ctx.shadowBlur = 15;
      this.ctx.shadowColor = this.colors.magneticGlow;

      const padding = 6;
      const x = this.snap.x - padding;
      const y = this.snap.y - padding;
      const w = this.snap.w + padding * 2;
      const h = this.snap.h + padding * 2;
      const r = 8; // rounded corners

      // Draw stylized rounded border around element
      this.ctx.beginPath();
      this.ctx.moveTo(x + r, y);
      this.ctx.lineTo(x + w - r, y);
      this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      this.ctx.lineTo(x + w, y + h - r);
      this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      this.ctx.lineTo(x + r, y + h - r);
      this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      this.ctx.lineTo(x, y + r);
      this.ctx.quadraticCurveTo(x, y, x + r, y);
      this.ctx.closePath();
      this.ctx.stroke();
    }

    this.ctx.restore();
  }
}

// Instantiate pointer when document loads
window.addEventListener('DOMContentLoaded', () => {
  window.premiumPointer = new PremiumPointer();
});

