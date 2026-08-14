import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AssetManager } from '../src/assets.js';
import { bindManifestVisualWheels, measureMeshWorldVertexCentroid } from '../src/car-wheel-pivots.js';
import { CARS, FIXED_DT } from '../src/config.js';
import { createVehicleRig, destroyVehicleRig } from './physics-harness.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'data', 'car-wheel-manifests', 'mx5.json'), 'utf8'));
const config = CARS.find(({ id }) => id === 'mx5');
const bytes = await readFile(path.join(projectRoot, manifest.source.file));

function findUnique(root, name) {
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  assert.equal(matches.length, 1, `${name} is unique`);
  return matches[0];
}

async function loadRealMx5() {
  const hadSelf = Object.hasOwn(globalThis, 'self');
  const previousSelf = globalThis.self;
  const previousError = console.error;
  const textureErrors = [];
  globalThis.self = globalThis;
  console.error = (...args) => textureErrors.push(args.map(String).join(' '));
  try {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new GLTFLoader().parseAsync(arrayBuffer, 'file:///E:/Projects/streetrush/public/cars/');
    return { gltf, textureErrors };
  } finally {
    console.error = previousError;
    if (hadSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  }
}

const { gltf, textureErrors } = await loadRealMx5();
assert.equal(textureErrors.length, 1);
assert.match(textureErrors[0], /GLTFLoader: Couldn't load texture blob:nodedata:/);
assert.deepEqual(gltf.animations.map((clip) => ({
  name: clip.name,
  tracks: clip.tracks.map(({ name }) => name),
})), [{ name: 'Scene', tracks: ['Empty005.quaternion'] }]);

for (const wheel of manifest.wheels) {
  const root = findUnique(gltf.scene, wheel.root.runtimeName);
  assert.equal(root.type, 'Object3D');
  for (const part of wheel.parts) {
    const mesh = findUnique(root, part.runtimeName);
    assert.equal(mesh.parent, root);
    assert.equal(mesh.type, 'Mesh');
    assert.equal(mesh.geometry.attributes.position.count, part.vertexCount);
    assert.equal(mesh.material.name, part.materialName);
  }
}

const manager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { mx5: manifest },
  bindVisualWheels: bindManifestVisualWheels,
});
const canonical = manager.normalizeCar(gltf.scene, config);
assert.equal(canonical.userData.source, 'gltf');
assert.equal(canonical.userData.groundCalibration, 'shape:12');
const wheelSet = findUnique(canonical, 'calibrated-wheels');
assert.deepEqual(wheelSet.userData.visualWheelOrder, ['FL', 'FR', 'RL', 'RR']);
assert.equal(wheelSet.userData.visualWheelSource, 'manifest:mx5');
const batched = canonical.children.find(({ name }) => /-batched$/.test(name));
assert.ok(batched, 'normalized static model was batched');
assert.equal(batched.userData.sourceDrawCalls, 12);
assert.equal(batched.userData.dynamicDrawCalls, 0);

for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const roll = findUnique(wheelSet, `visual-wheel-${wheel.id}-roll`);
  const root = findUnique(wheelSet, wheel.root.runtimeName);
  const tire = findUnique(root, wheel.parts.find(({ role }) => role === 'tire').runtimeName);
  assert.equal(root.parent, roll);
  assert.equal(root.matrixAutoUpdate, false);
  assert.ok(measureMeshWorldVertexCentroid(tire).distanceTo(steer.getWorldPosition(new THREE.Vector3())) < 1e-8);
}

const instance = canonical.clone(true);
assert.notStrictEqual(findUnique(instance, 'calibrated-wheels'), wheelSet);
assert.strictEqual(
  findUnique(instance, manifest.wheels[0].parts[1].runtimeName).geometry,
  findUnique(canonical, manifest.wheels[0].parts[1].runtimeName).geometry,
);

const rig = createVehicleRig(config, { visual: instance });
assert.equal(rig.vehicle.visualWheelBindings.length, 4);
rig.vehicle.steerAngle = 0.21;
for (const [index, wheel] of rig.vehicle.wheels.entries()) {
  wheel.compression = 0.0125 * (index + 1);
  wheel.omega = 9 * (index + 1);
}
rig.vehicle.advanceVisualWheelAngles(FIXED_DT);
rig.vehicle.syncVisual(0.5);
for (const [index, binding] of rig.vehicle.visualWheelBindings.entries()) {
  const wheel = rig.vehicle.wheels[index];
  assert.equal(binding.steer.rotation.y, wheel.front ? rig.vehicle.steerAngle : 0);
  assert.equal(binding.steer.position.y, binding.baseY + wheel.compression);
  assert.equal(binding.roll.rotation.x, wheel.visualAngle * 0.5);
}
rig.vehicle.reset();
rig.vehicle.syncVisual(1);
for (const binding of rig.vehicle.visualWheelBindings) {
  assert.equal(binding.steer.rotation.y, 0);
  assert.equal(binding.roll.rotation.x, 0);
}
destroyVehicleRig(rig);

class SceneLoader {
  constructor(scene) {
    this.scene = scene;
  }

  loadAsync() {
    return Promise.resolve({ scene: this.scene });
  }
}

const brokenScene = gltf.scene.clone(true);
findUnique(brokenScene, manifest.wheels[3].parts[1].runtimeName).removeFromParent();
const fallbackManager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { mx5: manifest },
  bindVisualWheels: bindManifestVisualWheels,
});
fallbackManager.loader = new SceneLoader(brokenScene);
const previousWarn = console.warn;
console.warn = () => {};
let fallback;
try {
  fallback = await fallbackManager.instantiateCar(config);
} finally {
  console.warn = previousWarn;
}
assert.equal(fallback.userData.source, 'fallback');
assert.equal(fallback.userData.fallback, true);
assert.match(fallback.userData.fallbackError.message, /RR tire runtimeName .* matched 0 objects/);
assert.equal(fallbackManager.visualCache.size, 0);
assert.equal(fallbackManager.pendingCars.size, 0);
assert.equal(fallbackManager.pendingVisuals.size, 0);
for (const wheel of manifest.wheels) assert.equal(findUnique(brokenScene, wheel.root.runtimeName).parent.name, 'RootNode');

const missingBinderManager = new AssetManager(new THREE.Scene(), null, { wheelManifests: { mx5: manifest } });
missingBinderManager.loader = new SceneLoader(gltf.scene);
console.warn = () => {};
try {
  fallback = await missingBinderManager.instantiateCar(config);
} finally {
  console.warn = previousWarn;
}
assert.equal(fallback.userData.source, 'fallback');
assert.equal(fallback.userData.fallbackError.message, 'Wheel manifest configured without a binder for mx5');
assert.equal(missingBinderManager.visualCache.size, 0);

console.log('PASS real MX-5 GLTFLoader roots=4 parts=12 animation=1 recoverableTextureFailures=1');
console.log('PASS AssetManager injected bind, ground, static merge, cache clone, Rapier visual owner, reset, and atomic fallbacks');
