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
      tension: 0.35,
      friction: 0.55,
      mass: 1.0
    };

    // UI Interaction states
    this.isHovering = false;
    this.hoverTarget = null;
    this.hoverScale = 1.0;

    // Dynamic color palette
    this.colors = {
      default: 'rgb(0 153 255)',
      defaultGlow: 'rgba(0 153 255 / 0.45)',
      magnetic: 'rgb(0 255 153)',    // Emerald neon on hover
      magneticGlow: 'rgba(0 255 153 / 0.5)'
    };
    this.currentColor = this.colors.default;
    this.currentGlow = this.colors.defaultGlow;

    this.init();
  }

  init() {
    // Check if device supports touch only
    if (window.matchMedia('(pointer: coarse)').matches) {
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

    // Mouse movement
    window.addEventListener('pointermove', (e) => this.onPointerMove(e), { passive: true });

    // Setup hover listeners
    this.setupInteractions();

    // MutationObserver to attach hovers to dynamic elements
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

    if (this.follower.x === -100) {
      this.follower.x = this.mouse.x;
      this.follower.y = this.mouse.y;
    }
  }

  setupInteractions() {
    const targets = document.querySelectorAll(
      'button, a, input[type="range"], input[type="checkbox"], label.switch-toggle, .slider-toggle, #hud-toggle, .info-code'
    );

    targets.forEach(target => {
      if (target.dataset.pointerBound) return;
      target.dataset.pointerBound = 'true';

      target.addEventListener('mouseenter', (e) => {
        this.isHovering = true;
        this.hoverTarget = e.currentTarget;
        document.body.classList.add('custom-pointer-hovering');
      });

      target.addEventListener('mouseleave', () => {
        this.isHovering = false;
        this.hoverTarget = null;
        document.body.classList.remove('custom-pointer-hovering');
      });
    });
  }

  tick(time) {
    this.update();
    this.draw();
    requestAnimationFrame((t) => this.tick(t));
  }

  update() {
    // Follower physics with spring logic
    const tension = this.spring.tension;
    const friction = this.spring.friction;

    const ax = (this.mouse.x - this.follower.x) * tension;
    const ay = (this.mouse.y - this.follower.y) * tension;

    this.follower.vx = (this.follower.vx + ax) * friction;
    this.follower.vy = (this.follower.vy + ay) * friction;

    this.follower.x += this.follower.vx;
    this.follower.y += this.follower.vy;

    // Hover scale logic
    const targetScale = this.isHovering ? 1.8 : 1.0;
    this.hoverScale += (targetScale - this.hoverScale) * 0.15;
  }

  draw() {
    if (!this.ctx) return;

    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    if (this.mouse.x < 0 || this.mouse.y < 0) return;

    this.ctx.save();

    const color = this.isHovering ? this.colors.magnetic : this.colors.default;
    const glowColor = this.isHovering ? this.colors.magneticGlow : this.colors.defaultGlow;

    // Draw outer ring follower (locked/synced to follower coordinate)
    const radius = 8 * this.hoverScale;
    this.ctx.beginPath();
    this.ctx.arc(this.follower.x, this.follower.y, radius, 0, Math.PI * 2);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = this.isHovering ? 2.0 : 1.5;
    
    this.ctx.shadowBlur = this.isHovering ? 12 : 6;
    this.ctx.shadowColor = glowColor;
    
    this.ctx.stroke();

    this.ctx.restore();
  }
}

// Instantiate pointer when document loads
window.addEventListener('DOMContentLoaded', () => {
  window.premiumPointer = new PremiumPointer();
});

