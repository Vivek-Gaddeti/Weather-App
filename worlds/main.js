// Entry point for the 3D weather worlds. Defines window.Worlds and manages
// world lifecycles: lazy engine start, fade-out / dispose / fade-in when the
// kind changes, and graceful shutdown on any error.
import { Engine, webgl2Available } from './engine.js';

const KINDS = ['sunny', 'rain'];
const FADE_MS = 450;
const loaders = {
  sunny: () => import('./sunny.js'),
  rain: () => import('./rain.js'),
};

const canvas = document.getElementById('world');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const capable = Boolean(canvas) && webgl2Available();

let engine = null;
let qualityMode = 'auto';
let wanted = null;        // kind most recently requested
let params = null;        // params most recently passed to set()
let current = null;       // { kind, world } currently alive
let busy = false;
let rebuild = false;      // recreate the current world (quality change)
const failed = new Set(); // kinds that failed to load or crashed; never retried
const modules = {};

const supported = () => capable && !reducedMotion.matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function warn(message, err) {
  console.warn(`[worlds] ${message}`, err);
}

function disposeWorld(world) {
  try {
    world.dispose();
  } catch (err) {
    warn('dispose failed', err);
  }
}

function hide() {
  const wasShown = 'world' in document.body.dataset;
  delete document.body.dataset.world;
  return wasShown;
}

// Shuts everything down after an error so the app keeps working in 2D.
function crash(kind, err) {
  warn(`"${kind}" world stopped after an error`, err);
  hide();
  engine?.stop();
  failed.add(kind);
  if (current) {
    disposeWorld(current.world);
    current = null;
  }
  if (wanted === kind) wanted = null;
}

function loadModule(kind) {
  modules[kind] ??= loaders[kind]();
  return modules[kind];
}

async function teardown() {
  const { world } = current;
  if (hide()) await sleep(FADE_MS);
  if (current?.world !== world) return;
  engine.stop();
  disposeWorld(world);
  current = null;
}

async function build(kind) {
  let world = null;
  try {
    const mod = await loadModule(kind);
    engine ??= new Engine(canvas, qualityMode);
    world = mod.create(engine.api);
    if (params) world.setParams(params);
    world.resize(engine.width, engine.height);
    // Compile shaders before the first frame; in parallel where the GPU allows it.
    const { renderer } = engine;
    if (renderer.extensions.has('KHR_parallel_shader_compile')) {
      await renderer.compileAsync(world.scene, world.camera);
    } else {
      renderer.compile(world.scene, world.camera);
    }
  } catch (err) {
    if (world) disposeWorld(world);
    failed.add(kind);
    warn(`could not start the "${kind}" world`, err);
    return;
  }
  if (wanted !== kind || rebuild) {
    disposeWorld(world);
    return;
  }
  current = { kind, world };
  engine.start(world, {
    onFirstFrame: () => {
      if (current?.world === world) document.body.dataset.world = kind;
    },
    onError: (err) => crash(kind, err),
  });
}

// Serialises transitions: runs until the live world matches `wanted`.
async function pump() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const target = wanted;
      if (current && current.kind === target && !rebuild) break;
      if (current) {
        await teardown();
        continue;
      }
      rebuild = false;
      if (!target) break;
      await build(target);
      if (failed.has(target) && wanted === target) wanted = null;
    }
  } catch (err) {
    warn('transition failed', err);
  } finally {
    busy = false;
  }
}

function set(kind, nextParams) {
  if (!supported()) return;
  const k = KINDS.includes(kind) && !failed.has(kind) ? kind : null;
  if (nextParams) params = nextParams;
  if (k === wanted) {
    if (current && current.kind === k && nextParams) {
      try {
        current.world.setParams(nextParams);
      } catch (err) {
        crash(k, err);
      }
    }
    return;
  }
  wanted = k;
  pump();
}

function setQuality(level) {
  if (!['low', 'medium', 'high', 'auto'].includes(level)) return;
  qualityMode = level;
  if (engine && engine.setQuality(level) && current) {
    rebuild = true;
    pump();
  }
}

reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches || !wanted) return;
  wanted = null;
  pump();
});

window.Worlds = {
  get supported() {
    return supported();
  },
  get active() {
    return wanted;
  },
  set,
  setQuality,
};

window.dispatchEvent(new Event('worlds:ready'));
