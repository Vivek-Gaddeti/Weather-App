// Shared WebGL engine for the 3D weather worlds: renderer, render loop,
// dynamic resolution, look/boost input, and pause/resume plumbing.
// Worlds receive `engine.api` ({ THREE, renderer, quality, isMobile }).
import * as THREE from '../vendor/three.module.min.js';

const LOOK_IGNORE = 'button, a, input, select, textarea, [role="dialog"], [data-no-look]';
const DENSITY = { low: 0.5, medium: 0.75, high: 1 };
const LEVELS = ['low', 'medium', 'high'];

const YAW_LIMIT = 1.2;
const PITCH_LIMIT = 0.55;
const HOLD_MS = 250;     // pointer held still this long -> boost
const STILL_PX = 8;      // movement tolerated while "holding still"
const RETURN_TAU = 1.3;  // seconds; look offsets are ~95% back at rest after 4s

const MIN_PIXEL_RATIO = 0.6;
const SLOW_MS = 1000 / 45;
const FAST_MS = 1000 / 58;

export function detectMobile() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const shortSide = Math.min(screen.width || innerWidth, screen.height || innerHeight);
  return coarse || shortSide < 600;
}

export function webgl2Available() {
  try {
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) return false;
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function autoLevel(isMobile) {
  const memory = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (isMobile) return memory < 4 || cores < 4 ? 'low' : 'medium';
  return memory < 4 || cores < 4 ? 'medium' : 'high';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Pointer drag to look around, hold still (or Shift / Space) to boost.
class LookInput {
  constructor() {
    this.state = { yaw: 0, pitch: 0, boost: 0 };
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.pointerId = null;
    this.lastX = 0;
    this.lastY = 0;
    this.anchorX = 0;
    this.anchorY = 0;
    this.stillSince = 0;
    this.keyBoost = false;

    const passive = { passive: true };
    window.addEventListener('pointerdown', (e) => this.down(e), passive);
    window.addEventListener('pointermove', (e) => this.move(e), passive);
    window.addEventListener('pointerup', (e) => this.up(e), passive);
    window.addEventListener('pointercancel', (e) => this.up(e), passive);
    window.addEventListener('keydown', (e) => this.key(e, true), passive);
    window.addEventListener('keyup', (e) => this.key(e, false), passive);
    window.addEventListener('blur', () => this.release(), passive);
  }

  static ignored(target) {
    if (document.body.classList.contains('sheet-open')) return true;
    return target instanceof Element && target.closest(LOOK_IGNORE) !== null;
  }

  down(e) {
    if (this.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (LookInput.ignored(e.target)) return;
    this.pointerId = e.pointerId;
    this.lastX = this.anchorX = e.clientX;
    this.lastY = this.anchorY = e.clientY;
    this.stillSince = performance.now();
  }

  move(e) {
    if (e.pointerId !== this.pointerId) return;
    if (document.body.classList.contains('sheet-open')) {
      this.pointerId = null;
      return;
    }
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // A drag across the whole screen turns the view by about 90 degrees.
    const span = Math.PI / 2;
    this.targetYaw = clamp(this.targetYaw + (dx / innerWidth) * span, -YAW_LIMIT, YAW_LIMIT);
    this.targetPitch = clamp(this.targetPitch + (dy / innerHeight) * span, -PITCH_LIMIT, PITCH_LIMIT);
    if (Math.hypot(e.clientX - this.anchorX, e.clientY - this.anchorY) > STILL_PX) {
      this.anchorX = e.clientX;
      this.anchorY = e.clientY;
      this.stillSince = performance.now();
    }
  }

  up(e) {
    if (e.pointerId === this.pointerId) this.pointerId = null;
  }

  key(e, isDown) {
    if (e.key !== 'Shift' && e.code !== 'Space') return;
    if (isDown && e.target instanceof Element && e.target.closest(`${LOOK_IGNORE}, [contenteditable]`)) return;
    this.keyBoost = isDown;
  }

  release() {
    this.pointerId = null;
    this.keyBoost = false;
  }

  update(dt, now) {
    const s = this.state;
    const holding = this.pointerId !== null;
    if (!holding) {
      const k = Math.exp(-dt / RETURN_TAU);
      this.targetYaw *= k;
      this.targetPitch *= k;
    }
    const follow = 1 - Math.exp(-dt * 7);
    s.yaw += (this.targetYaw - s.yaw) * follow;
    s.pitch += (this.targetPitch - s.pitch) * follow;
    const boosting = this.keyBoost || (holding && now - this.stillSince > HOLD_MS);
    s.boost += ((boosting ? 1 : 0) - s.boost) * (1 - Math.exp(-dt * 2.2));
    if (s.boost < 1e-4) s.boost = 0;
  }
}

export class Engine {
  constructor(canvas, qualityMode = 'auto') {
    this.canvas = canvas;
    this.isMobile = detectMobile();
    this.quality = { level: 'medium', density: DENSITY.medium };
    this.setQuality(qualityMode);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !this.isMobile,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor(0x000000, 1);

    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.5 : 2);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);

    this.api = { THREE, renderer: this.renderer, quality: this.quality, isMobile: this.isMobile };
    this.input = new LookInput();

    this.world = null;
    this.onFirstFrame = null;
    this.onError = null;
    this.running = false;
    this.contextLost = false;
    this.rafId = 0;
    this.lastTime = 0;
    this.elapsed = 0;
    this.resetTiming();

    this.width = 0;
    this.height = 0;
    this.resize();

    this.frame = this.frame.bind(this);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.resize(), 150);
    });
    document.addEventListener('visibilitychange', () => this.schedule());
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.schedule();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.schedule();
    });
  }

  // Returns true when the instance density changed (worlds must be rebuilt).
  setQuality(mode) {
    const level = mode === 'auto' ? autoLevel(this.isMobile) : mode;
    if (!LEVELS.includes(level)) return false;
    const changed = this.quality.density !== DENSITY[level];
    this.quality.level = level;
    this.quality.density = DENSITY[level];
    return changed;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    if (this.world) this.guard(() => this.world.resize(w, h));
  }

  start(world, { onFirstFrame, onError }) {
    this.world = world;
    this.onFirstFrame = onFirstFrame;
    this.onError = onError;
    this.running = true;
    this.resize();
    this.guard(() => world.resize(this.width, this.height));
    this.schedule();
  }

  stop() {
    this.running = false;
    this.world = null;
    this.onFirstFrame = null;
    this.schedule();
  }

  // Starts or cancels the rAF loop to match running / visibility / context state.
  schedule() {
    const shouldRun = this.running && !document.hidden && !this.contextLost;
    if (shouldRun && !this.rafId) {
      this.lastTime = 0;
      this.resetTiming();
      this.rafId = requestAnimationFrame(this.frame);
    } else if (!shouldRun && this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  guard(fn) {
    try {
      fn();
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  fail(err) {
    const handler = this.onError;
    this.stop();
    if (handler) handler(err);
  }

  frame(now) {
    this.rafId = 0;
    if (!this.running || !this.world) return;
    const raw = this.lastTime ? now - this.lastTime : 16.7;
    this.lastTime = now;
    const dt = Math.min(raw / 1000, 0.05);
    this.elapsed += dt;

    const world = this.world;
    const ok = this.guard(() => {
      this.input.update(dt, now);
      world.update(dt, this.elapsed, this.input.state);
      this.renderer.render(world.scene, world.camera);
    });
    if (!ok || this.world !== world) return;

    if (this.onFirstFrame) {
      const notify = this.onFirstFrame;
      this.onFirstFrame = null;
      notify();
    }
    this.adaptResolution(raw);
    this.rafId = requestAnimationFrame(this.frame);
  }

  resetTiming() {
    this.avgMs = 16.7;
    this.slowMs = 0;
    this.fastMs = 0;
    this.warmup = 30;
    this.upDelay = this.upDelay || 4000;
  }

  // Rolling frame-time average drives the pixel ratio: drop quickly when slow,
  // climb back cautiously (with growing patience after each drop).
  adaptResolution(raw) {
    if (this.warmup > 0) {
      this.warmup--;
      return;
    }
    if (raw > 250) return;
    this.avgMs += (raw - this.avgMs) * 0.1;
    this.slowMs = this.avgMs > SLOW_MS ? this.slowMs + raw : 0;
    this.fastMs = this.avgMs < FAST_MS ? this.fastMs + raw : 0;

    let next = this.pixelRatio;
    if (this.slowMs > 1000 && this.pixelRatio > MIN_PIXEL_RATIO) {
      next = Math.max(MIN_PIXEL_RATIO, this.pixelRatio * 0.85);
      this.upDelay = Math.min(this.upDelay * 2, 32000);
    } else if (this.fastMs > this.upDelay && this.pixelRatio < this.maxPixelRatio) {
      next = this.pixelRatio * 1.1;
      if (next > this.maxPixelRatio * 0.97) next = this.maxPixelRatio;
    } else {
      return;
    }
    this.slowMs = 0;
    this.fastMs = 0;
    this.pixelRatio = next;
    this.renderer.setPixelRatio(next);
  }
}
