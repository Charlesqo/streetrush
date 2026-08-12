import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AssetManager } from '../src/assets.js';
import { disposeOwnedVisual } from '../src/vehicle.js';

class FakeLoader {
  constructor(load) {
    this.load = load;
    this.calls = [];
  }

  loadAsync(url, onProgress) {
    this.calls.push({ url, onProgress });
    return this.load(url, onProgress);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortError() {
  const error = new Error('preload aborted');
  error.name = 'AbortError';
  return error;
}

function makeScene() {
  return {
    children: [],
    add(object) {
      this.children.push(object);
    },
  };
}

function makeTemplate(name = 'fake-car') {
  const root = new THREE.Group();
  root.name = name;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2, 1, 4),
    new THREE.MeshBasicMaterial({ color: 0x336699 }),
  );
  body.name = 'body';
  root.add(body);
  return root;
}

function makeTrackedResources() {
  const counts = { geometry: 0, material: 0, texture: 0 };
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  const material = new THREE.MeshBasicMaterial({ color: 0x445566 });
  const texture = new THREE.Texture();
  material.map = texture;
  geometry.dispose = () => { counts.geometry += 1; };
  material.dispose = () => { counts.material += 1; };
  texture.dispose = () => { counts.texture += 1; };
  return { counts, geometry, material, texture };
}

function makeTemplateWithResources(name, resources) {
  const root = new THREE.Group();
  root.name = name;
  root.add(new THREE.Mesh(resources.geometry, resources.material));
  return root;
}

function makeDynamicMergeTemplate() {
  const root = new THREE.Group();
  root.name = 'dynamic-merge-car';
  root.position.set(1.5, -0.2, 2.4);
  const staticGeometry = new THREE.BoxGeometry(0.4, 0.25, 0.6);
  const staticMaterial = new THREE.MeshBasicMaterial({ color: 0x334455 });
  for (let index = 0; index < 9; index += 1) {
    const mesh = new THREE.Mesh(staticGeometry, staticMaterial);
    mesh.name = `static-${index}`;
    mesh.position.set(index * 0.12, 0, -index * 0.08);
    root.add(mesh);
  }
  const carrier = new THREE.Group();
  carrier.name = 'dynamic-carrier';
  carrier.position.set(-0.7, 0.3, 1.1);
  carrier.rotation.y = 0.19;
  const pivot = new THREE.Group();
  pivot.name = 'dynamic-FL-brake';
  pivot.position.set(-0.4, 0.2, 0.65);
  pivot.userData.dynamicCarPart = { version: 1, id: 'FL-brake' };
  const dynamicMaterial = new THREE.MeshBasicMaterial({ color: 0xaa4422 });
  for (let index = 0; index < 2; index += 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.1), dynamicMaterial);
    mesh.name = `dynamic-detail-${index}`;
    mesh.position.x = index * 0.16;
    pivot.add(mesh);
  }
  carrier.add(pivot);
  root.add(carrier);
  root.updateMatrixWorld(true);
  return { root, pivot };
}

function makeConfig(id = 'test-car', file = `${id}.glb`) {
  return {
    id,
    file,
    model: {
      yaw: 0,
      targetLength: 4,
      groundOffset: 0.12,
      groundAdjust: 0,
    },
    trackWidth: 1.5,
    wheelRadius: 0.32,
    wheelbase: 2.3,
  };
}

function makeManager() {
  const scene = makeScene();
  return { manager: new AssetManager(scene, null), scene };
}

function flushMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('shares one pending loader request across concurrent fetch and prepare calls', async () => {
  const { manager } = makeManager();
  const config = makeConfig('shared-car');
  const gate = deferred();
  const template = makeTemplate(config.id);
  const loader = new FakeLoader(() => gate.promise);
  manager.loader = loader;

  const fetchPending = manager.fetchCar(config);
  const preparePending = manager.prepareCar(config);

  assert.strictEqual(manager.fetchCar(config), fetchPending);
  assert.strictEqual(manager.prepareCar(config), preparePending);
  assert.strictEqual(manager.pendingCars.get(config.id), fetchPending);
  assert.strictEqual(manager.pendingVisuals.get(config.id), preparePending);

  gate.resolve({ scene: template });
  const [loaded, prepared] = await Promise.all([fetchPending, preparePending]);

  assert.strictEqual(loaded, template);
  assert.equal(prepared.userData.source, 'gltf');
  assert.equal(loader.calls.length, 1);
  assert.equal(loader.calls[0].url, `/cars/${config.file}`);
  assert.equal(manager.pendingCars.has(config.id), false);
  assert.equal(manager.pendingVisuals.has(config.id), false);
  assert.equal(manager.visualCache.has(config.id), true);
});

test('clears failed fetch state and retries the same asset', async () => {
  const { manager } = makeManager();
  const config = makeConfig('retry-fetch');
  const failure = new Error('temporary fetch failure');
  const recoveredTemplate = makeTemplate(config.id);
  let attempts = 0;
  const loader = new FakeLoader(() => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(failure) : Promise.resolve({ scene: recoveredTemplate });
  });
  manager.loader = loader;

  const failed = manager.fetchCar(config);
  assert.equal(manager.pendingCars.has(config.id), true);
  await assert.rejects(failed, (error) => error === failure);
  assert.equal(manager.pendingCars.has(config.id), false);
  assert.equal(manager.carCache.has(config.id), false);

  const retried = await manager.fetchCar(config);
  assert.strictEqual(retried, recoveredTemplate);
  assert.equal(loader.calls.length, 2);
  assert.strictEqual(manager.carCache.get(config.id), recoveredTemplate);
});

test('times out one fetch without aborting another shared-loader request, then retries', async () => {
  const { manager } = makeManager();
  const config = makeConfig('timeout-fetch');
  const otherConfig = makeConfig('healthy-fetch');
  const stalled = deferred();
  const healthy = deferred();
  manager.carLoadTimeoutMs = 10;
  let abortCalls = 0;
  manager.loader = new FakeLoader((url) => (
    url.endsWith(`/${config.file}`) ? stalled.promise : healthy.promise
  ));
  manager.loader.manager = {
    abort() {
      abortCalls += 1;
      const error = new Error('shared loading manager aborted');
      stalled.reject(error);
      healthy.reject(error);
    },
  };

  const timedOut = manager.fetchCar(config);
  manager.carLoadTimeoutMs = 1_000;
  const healthyRequest = manager.fetchCar(otherConfig);
  await assert.rejects(timedOut, /Timed out loading car timeout-fetch/);
  healthy.resolve({ scene: makeTemplate(otherConfig.id) });
  const healthyTemplate = await healthyRequest;

  assert.equal(abortCalls, 0);
  assert.equal(healthyTemplate.name, otherConfig.id);
  assert.equal(manager.pendingCars.has(config.id), false);
  assert.equal(manager.carCache.has(config.id), false);

  const recoveredTemplate = makeTemplate(config.id);
  manager.loader = new FakeLoader(() => Promise.resolve({ scene: recoveredTemplate }));
  const recovered = await manager.fetchCar(config);
  assert.strictEqual(recovered, recoveredTemplate);
});

test('preserves explicitly marked dynamic branches while batching static meshes', () => {
  const { manager } = makeManager();
  const { root, pivot } = makeDynamicMergeTemplate();
  const before = pivot.getObjectByName('dynamic-detail-0').getWorldPosition(new THREE.Vector3());

  const optimized = manager.mergeStaticCarMeshes(root);
  const preserved = optimized.getObjectByName('dynamic-FL-brake');
  assert.ok(preserved, 'dynamic pivot survives static batching');
  optimized.updateMatrixWorld(true);
  const after = preserved.getObjectByName('dynamic-detail-0').getWorldPosition(new THREE.Vector3());
  assert.ok(after.distanceTo(before) < 1e-9, 'preserved branch keeps its world transform');
  assert.deepEqual(preserved.userData.dynamicCarPart, { version: 1, id: 'FL-brake' });
  assert.equal(optimized.userData.sourceDrawCalls, 11);
  assert.equal(optimized.userData.staticSourceDrawCalls, 9);
  assert.equal(optimized.userData.dynamicDrawCalls, 2);
  assert.equal(optimized.userData.batchedDrawCalls, 3);

  const instance = optimized.clone(true);
  const instancePivot = instance.getObjectByName('dynamic-FL-brake');
  assert.notStrictEqual(instancePivot, preserved);
  assert.strictEqual(
    instancePivot.getObjectByName('dynamic-detail-0').geometry,
    preserved.getObjectByName('dynamic-detail-0').geometry,
  );
  instancePivot.rotation.y = 0.5;
  assert.notEqual(instancePivot.rotation.y, preserved.rotation.y);
});

test('disposes a timed-out GLTF scene that arrives late with independent resources', async () => {
  const { manager } = makeManager();
  const config = makeConfig('late-independent');
  const gate = deferred();
  const resources = makeTrackedResources();
  const lateTemplate = makeTemplateWithResources(config.id, resources);
  manager.carLoadTimeoutMs = 8;
  manager.loader = new FakeLoader(() => gate.promise);

  await assert.rejects(manager.fetchCar(config), /Timed out loading car late-independent/);
  assert.equal(manager.pendingCars.size, 0);
  assert.equal(manager.carCache.size, 0);
  assert.equal(manager.visualCache.size, 0);
  gate.resolve({ scene: lateTemplate });
  await flushMacrotask();
  await flushMacrotask();

  assert.deepEqual(resources.counts, { geometry: 1, material: 1, texture: 1 });
  assert.equal(manager.carCache.size, 0);
  assert.equal(manager.visualCache.size, 0);
  assert.equal(lateTemplate.parent, null);
});

test('retains every late GLTF resource when any identity is already known', async () => {
  const { manager } = makeManager();
  const config = makeConfig('late-shared');
  const gate = deferred();
  const resources = makeTrackedResources();
  const known = makeTemplateWithResources('known-visual', resources);
  known.userData.source = 'gltf';
  manager.visualCache.set('known-visual', known);
  const lateTemplate = makeTemplateWithResources(config.id, resources);
  manager.carLoadTimeoutMs = 8;
  manager.loader = new FakeLoader(() => gate.promise);

  await assert.rejects(manager.fetchCar(config), /Timed out loading car late-shared/);
  gate.resolve({ scene: lateTemplate });
  await flushMacrotask();
  await flushMacrotask();

  assert.deepEqual(resources.counts, { geometry: 0, material: 0, texture: 0 });
  assert.strictEqual(manager.visualCache.get('known-visual'), known);
});

test('formal load cancels only its matching in-flight HTTP preload', async () => {
  const { manager } = makeManager();
  const configs = [
    makeConfig('preload-a'),
    makeConfig('preload-b'),
    makeConfig('preload-c'),
  ];
  const scheduled = [];
  const preloadCalls = [];
  const hadIdleCallback = Object.hasOwn(globalThis, 'requestIdleCallback');
  const previousIdleCallback = globalThis.requestIdleCallback;
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const previousFetch = globalThis.fetch;
  globalThis.requestIdleCallback = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  globalThis.fetch = (url, options) => {
    const gate = deferred();
    options.signal?.addEventListener('abort', () => gate.reject(abortError()), { once: true });
    preloadCalls.push({ url, options, gate });
    return gate.promise;
  };
  manager.loader = new FakeLoader(() => Promise.resolve({ scene: makeTemplate('preload-b') }));

  try {
    manager.preloadNeighbors(configs, 0);
    for (const callback of scheduled) callback();
    await flushMacrotask();
    assert.equal(preloadCalls.length, 2);

    await manager.fetchCar(configs[1]);
    const matching = preloadCalls.find(({ url }) => url.endsWith(`/${configs[1].file}`));
    const other = preloadCalls.find(({ url }) => url.endsWith(`/${configs[2].file}`));
    assert.equal(matching.options.signal.aborted, true);
    assert.equal(other.options.signal.aborted, false);
    assert.equal(manager.preloadScheduled.has(configs[1].id), false);
    assert.equal(manager.preloadScheduled.has(configs[2].id), true);
    other.gate.resolve({ ok: true });
    await flushMacrotask();
    assert.equal(manager.preloadScheduled.size, 0);
  } finally {
    if (hadIdleCallback) globalThis.requestIdleCallback = previousIdleCallback;
    else delete globalThis.requestIdleCallback;
    if (hadFetch) globalThis.fetch = previousFetch;
    else delete globalThis.fetch;
  }
});

test('six-car stalled preloads abort and release every scheduling slot', async () => {
  const { manager } = makeManager();
  const configs = Array.from({ length: 6 }, (_, index) => makeConfig(`preload-${index + 1}`));
  const scheduled = [];
  const signals = [];
  manager.preloadTimeoutMs = 8;
  const hadIdleCallback = Object.hasOwn(globalThis, 'requestIdleCallback');
  const previousIdleCallback = globalThis.requestIdleCallback;
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const previousFetch = globalThis.fetch;
  globalThis.requestIdleCallback = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signals.push({ url, signal });
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });

  try {
    for (let index = 0; index < configs.length; index += 1) {
      manager.preloadNeighbors(configs, index);
    }
    assert.equal(scheduled.length, 6);
    assert.equal(manager.preloadScheduled.size, 6);
    for (const callback of scheduled) callback();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signals.length, 6);
    assert.ok(signals.every(({ signal }) => signal.aborted));
    assert.equal(manager.preloadScheduled.size, 0);
    assert.equal(manager.preloadRequests.size, 0);
  } finally {
    if (hadIdleCallback) globalThis.requestIdleCallback = previousIdleCallback;
    else delete globalThis.requestIdleCallback;
    if (hadFetch) globalThis.fetch = previousFetch;
    else delete globalThis.fetch;
  }
});

test('clears failed prepare state and retries normalization', async () => {
  const { manager } = makeManager();
  const config = makeConfig('retry-prepare');
  const failure = new Error('temporary prepare failure');
  const recoveredTemplate = makeTemplate(config.id);
  let attempts = 0;
  const loader = new FakeLoader(() => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(failure) : Promise.resolve({ scene: recoveredTemplate });
  });
  manager.loader = loader;

  const failed = manager.prepareCar(config);
  assert.equal(manager.pendingCars.has(config.id), true);
  assert.equal(manager.pendingVisuals.has(config.id), true);
  await assert.rejects(failed, (error) => error === failure);
  assert.equal(manager.pendingCars.has(config.id), false);
  assert.equal(manager.pendingVisuals.has(config.id), false);
  assert.equal(manager.carCache.has(config.id), false);
  assert.equal(manager.visualCache.has(config.id), false);

  const retried = await manager.prepareCar(config);
  assert.equal(retried.userData.source, 'gltf');
  assert.equal(loader.calls.length, 2);
  assert.equal(manager.pendingCars.has(config.id), false);
  assert.equal(manager.pendingVisuals.has(config.id), false);
});

test('marks failed instantiation as a fallback with structured error details', async () => {
  const { manager } = makeManager();
  const config = makeConfig('fallback-car');
  const failure = new TypeError('missing car model');
  manager.loader = new FakeLoader(() => Promise.reject(failure));

  const previousWarn = console.warn;
  console.warn = () => {};
  let visual;
  try {
    visual = await manager.instantiateCar(config);
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(visual.userData.source, 'fallback');
  assert.equal(visual.userData.fallback, true);
  assert.deepEqual(visual.userData.fallbackError, {
    name: 'TypeError',
    message: 'missing car model',
  });
});

test('marks a successfully instantiated GLTF visual as gltf', async () => {
  const { manager } = makeManager();
  const config = makeConfig('gltf-car');
  const template = makeTemplate(config.id);
  manager.loader = new FakeLoader(() => Promise.resolve({ scene: template }));

  const visual = await manager.instantiateCar(config);

  assert.equal(visual.userData.source, 'gltf');
  assert.equal(visual.userData.fallback, undefined);
  assert.notStrictEqual(visual, template);
});

test('disposes fallback-owned resources without touching shared GLTF visuals', () => {
  const fallback = new THREE.Group();
  fallback.userData.source = 'fallback';
  const fallbackGeometry = new THREE.BoxGeometry(1, 1, 1);
  const fallbackMaterial = new THREE.MeshBasicMaterial();
  let geometryDisposals = 0;
  let materialDisposals = 0;
  fallbackGeometry.dispose = () => { geometryDisposals += 1; };
  fallbackMaterial.dispose = () => { materialDisposals += 1; };
  fallback.add(new THREE.Mesh(fallbackGeometry, fallbackMaterial));

  assert.equal(disposeOwnedVisual(fallback), true);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);

  const shared = new THREE.Group();
  shared.userData.source = 'gltf';
  const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
  const sharedMaterial = new THREE.MeshBasicMaterial();
  let sharedGeometryDisposals = 0;
  let sharedMaterialDisposals = 0;
  sharedGeometry.dispose = () => { sharedGeometryDisposals += 1; };
  sharedMaterial.dispose = () => { sharedMaterialDisposals += 1; };
  shared.add(new THREE.Mesh(sharedGeometry, sharedMaterial));

  assert.equal(disposeOwnedVisual(shared), false);
  assert.equal(sharedGeometryDisposals, 0);
  assert.equal(sharedMaterialDisposals, 0);
});

test('preloads neighbors through HTTP only and deduplicates scheduled work', async () => {
  const { manager } = makeManager();
  const configs = [
    makeConfig('car-a', 'a.glb'),
    makeConfig('car-b', 'b.glb'),
    makeConfig('car-c', 'c.glb'),
  ];
  const scheduled = [];
  const requests = [];
  const loader = new FakeLoader(() => {
    throw new Error('preload must not use the GLTF loader');
  });
  manager.loader = loader;

  let prepareCalls = 0;
  manager.prepareCar = () => {
    prepareCalls += 1;
    throw new Error('preload must not prepare a car');
  };

  const hadIdleCallback = Object.hasOwn(globalThis, 'requestIdleCallback');
  const previousIdleCallback = globalThis.requestIdleCallback;
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const previousFetch = globalThis.fetch;
  globalThis.requestIdleCallback = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true };
  };

  try {
    manager.preloadNeighbors(configs, 0);
    manager.preloadNeighbors(configs, 0);

    assert.equal(scheduled.length, 2);
    assert.equal(manager.preloadScheduled.size, 2);
    assert.equal(requests.length, 0);
    assert.equal(prepareCalls, 0);

    for (const callback of scheduled) callback();
    await flushMacrotask();

    assert.equal(prepareCalls, 0);
    assert.equal(loader.calls.length, 0);
    assert.deepEqual(requests.map(({ url }) => url), ['/cars/c.glb', '/cars/b.glb']);
    assert.deepEqual(requests.map(({ options }) => options.cache), ['force-cache', 'force-cache']);
    assert.equal(manager.preloadScheduled.size, 0);
  } finally {
    if (hadIdleCallback) globalThis.requestIdleCallback = previousIdleCallback;
    else delete globalThis.requestIdleCallback;
    if (hadFetch) globalThis.fetch = previousFetch;
    else delete globalThis.fetch;
  }
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${tests.length} asset tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS ${tests.length} asset tests`);
}
