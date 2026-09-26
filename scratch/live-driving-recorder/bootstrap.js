import { VehicleSystem } from '/src/vehicle.js';

// IDM can intercept .wav/.bin fetches even though the game requests array buffers.
// Only this temporary page uses opaque URLs; the server returns identical bytes.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = function (resource, init) {
  const originalUrl = resource instanceof Request ? resource.url : String(resource);
  const url = new URL(originalUrl, location.href);
  if (url.origin === location.origin && /\.(wav|bin|glb|hdr)$/i.test(url.pathname)
    && (init?.method ?? (resource instanceof Request ? resource.method : 'GET')).toUpperCase() === 'GET') {
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(url.pathname)))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const replacement = `${location.origin}/__live-recorder/asset?key=${encoded}`;
    return nativeFetch(resource instanceof Request ? new Request(replacement, resource) : replacement, init);
  }
  return nativeFetch(resource, init);
};

// Temporary page instrumentation. Original methods run once with unchanged arguments.
const contexts = new WeakMap();
const samples = [], events = [];
let stepIndex = 0, lastVehicle = null, captureError = null, saves = 0;
const windowMs = 5000;
const vector = v => ({ x: v.x, y: v.y, z: v.z, ...(v.w === undefined ? {} : { w: v.w }) });
const bodyState = vehicle => ({
  position: vector(vehicle.body.translation()), rotation: vector(vehicle.body.rotation()),
  velocity: vector(vehicle.body.linvel()), angularVelocity: vector(vehicle.body.angvel()),
  worldCom: vector(vehicle.body.worldCom()), localCom: vector(vehicle.body.localCom()),
});
function trim(array, now) {
  while (array.length && array[0].wallTimeMs < now - windowMs) array.shift();
  while (array.length > 2048) array.shift();
}
function observe(fn) {
  try { fn(); } catch (error) { captureError = error.message; }
}
const originalFixedUpdate = VehicleSystem.prototype.fixedUpdate;
VehicleSystem.prototype.fixedUpdate = function (...args) {
  observe(() => contexts.set(this, { stepIndex: ++stepIndex, input: structuredClone(args[0]),
    controlsLocked: args[1] ?? false, dt: args[2], bodyBefore: bodyState(this), completed: false }));
  const result = originalFixedUpdate.apply(this, args);
  const context = contexts.get(this);
  if (context) context.completed = true;
  return result;
};
const originalAfterPhysics = VehicleSystem.prototype.afterPhysics;
VehicleSystem.prototype.afterPhysics = function (...args) {
  const result = originalAfterPhysics.apply(this, args);
  observe(() => {
    const context = contexts.get(this);
    if (!context?.completed) return;
    context.completed = false;
    const start = performance.now();
    lastVehicle = this;
    const sample = structuredClone({
      wallTimeMs: start, stepIndex: context.stepIndex, dt: context.dt, carId: this.config.id,
      controlsLocked: context.controlsLocked, input: context.input, bodyBefore: context.bodyBefore,
      bodyAfter: bodyState(this), report: this.getVehiclePhysicsReport(),
    });
    sample.captureCostMs = performance.now() - start;
    samples.push(sample); trim(samples, start);
  });
  return result;
};
const originalReset = VehicleSystem.prototype.reset;
VehicleSystem.prototype.reset = function (...args) {
  observe(() => { const now = performance.now(); events.push({ type: 'vehicle-reset', wallTimeMs: now,
    stepIndex, carId: this.config.id, requestedSample: args[0], before: bodyState(this) }); trim(events, now); });
  return originalReset.apply(this, args);
};
for (const type of ['keydown', 'keyup', 'blur', 'focus', 'visibilitychange']) {
  const target = type === 'visibilitychange' ? document : window;
  target.addEventListener(type, event => observe(() => {
    const now = performance.now();
    events.push({ wallTimeMs: now, stepIndex, type, code: event.code, repeat: event.repeat,
      trusted: event.isTrusted, target: event.target?.id ?? event.target?.tagName,
      hidden: document.hidden });
    trim(events, now);
  }), { capture: true });
}

const panel = document.createElement('section');
panel.id = 'temporary-driving-recorder';
panel.setAttribute('aria-label', '驾驶问题记录');
Object.assign(panel.style, { position: 'fixed', right: '18px', top: '160px', zIndex: '10000',
  width: '225px', padding: '12px', borderRadius: '10px', background: '#101c2deb',
  color: '#fff', font: '13px system-ui', boxShadow: '0 4px 18px #0005' });
const button = document.createElement('button');
button.id = 'save-driving-last-five';
button.type = 'button';
button.textContent = '保存前 5 秒';
Object.assign(button.style, { width: '100%', padding: '11px', color: '#102030', background: '#dbff64',
  border: '0', borderRadius: '6px', font: 'bold 16px system-ui', cursor: 'pointer' });
const status = document.createElement('output');
status.id = 'driving-recorder-status';
Object.assign(status.style, { display: 'block', marginTop: '8px', lineHeight: '1.5', overflowWrap: 'anywhere' });
status.textContent = '开始驾驶后自动记录';
panel.append(button, status); document.body.append(panel);
let busy = false, messageUntil = 0;
button.addEventListener('mousedown', event => event.preventDefault());
button.addEventListener('click', async () => {
  if (busy) return;
  const now = performance.now();
  trim(samples, now); trim(events, now);
  if (!samples.length) { status.textContent = '还没有驾驶记录，请先开车。'; messageUntil = now + 2500; return; }
  // Freeze the interval at the click; no post-click samples can enter this save.
  const captured = samples.slice(), capturedEvents = events.slice();
  const recording = {
    schema: 'streetrush.last-five-seconds.v1', runId: crypto.randomUUID(), createdAt: new Date().toISOString(),
    pageUrl: location.href, clickedAtWallTimeMs: now, requestedWindowMs: windowMs,
    windowPolicy: 'Previous five seconds of wall time at button click; every completed physics step in that interval. No future samples. Less history if recently started or paused.',
    capturePolicy: 'Temporary method observers in this page; originals called once without altered arguments. Input/bodyBefore before fixedUpdate; bodyAfter and report after Rapier and afterPhysics.',
    vehicleConfig: structuredClone(lastVehicle.config), trackConfig: structuredClone(lastVehicle.track.config),
    captureError, samples: captured, events: capturedEvents,
  };
  busy = true; button.disabled = true; status.textContent = '正在保存…';
  document.getElementById('game')?.focus({ preventScroll: true });
  try {
    const response = await fetch('/__live-recorder/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recording) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? response.status);
    saves++; status.textContent = `已保存第 ${saves} 段 · ${captured.length} 个物理步`;
    status.dataset.savedPath = result.path;
    status.dataset.savedCount = String(saves);
    messageUntil = performance.now() + 5000;
  } catch (error) {
    status.textContent = `保存失败：${error.message}`; messageUntil = performance.now() + 8000;
  } finally { busy = false; button.disabled = false; }
});
setInterval(() => {
  if (busy || performance.now() < messageUntil) return;
  const now = performance.now(); trim(samples, now); trim(events, now);
  if (captureError) { status.textContent = `记录异常：${captureError}`; return; }
  const seconds = samples.length > 1 ? Math.min(5, (samples.at(-1).wallTimeMs - samples[0].wallTimeMs) / 1000) : 0;
  status.textContent = samples.length ? `正在记录 · 最近 ${seconds.toFixed(1)} 秒` : '开始驾驶后自动记录';
}, 500);

await import('/src/main.js');
