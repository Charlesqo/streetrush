import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { bindManifestVisualWheels, measureMeshWorldVertexCentroid } from '../src/car-wheel-pivots.js';
import { CARS, FIXED_DT } from '../src/config.js';
import { createGameAssetManager, PRODUCTION_WHEEL_MANIFESTS } from '../src/game-assets.js';
import { createVehicleRig, destroyVehicleRig } from './physics-harness.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'data', 'car-wheel-manifests', 'gt3rs.json'), 'utf8'));
const config = CARS.find(({ id }) => id === 'gt3rs');
const bytes = await readFile(path.join(projectRoot, manifest.source.file));
assert.equal(bytes.length, manifest.source.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.source.sha256);

function findUnique(root, name) {
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  assert.equal(matches.length, 1, `${name} is unique`);
  return matches[0];
}

function worldMatrix(object) {
  object.updateWorldMatrix(true, false);
  return object.matrixWorld.clone();
}

function matrixDistance(left, right) {
  return Math.max(...left.elements.map((value, index) => Math.abs(value - right.elements[index])));
}

const hadSelf = Object.hasOwn(globalThis, 'self');
const previousSelf = globalThis.self;
const previousError = console.error;
const textureErrors = [];
globalThis.self = globalThis;
console.error = (...args) => textureErrors.push(args.map(String).join(' '));
let gltf;
try {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  gltf = await new GLTFLoader().parseAsync(arrayBuffer, 'file:///E:/Projects/streetrush/public/cars/');
} finally {
  console.error = previousError;
  if (hadSelf) globalThis.self = previousSelf;
  else delete globalThis.self;
}
assert.ok(textureErrors.every((message) => /GLTFLoader: Couldn't load texture/.test(message)));

const sourceObjects = new Set();
const sourceGeometryObjects = new Set();
for (const wheel of manifest.wheels) {
  for (const branch of wheel.spinBranches) {
    const object = findUnique(gltf.scene, branch.runtimeName);
    assert.equal(object.type, 'Object3D');
    assert.equal(object.parent.name, branch.sourceParentRuntimeName);
    assert.ok(!sourceObjects.has(object), `${branch.runtimeName} is not reused`);
    sourceObjects.add(object);
    for (const geometryName of branch.geometryRuntimeNames) {
      const geometry = findUnique(object, geometryName);
      assert.equal(geometry.type, 'Mesh');
      assert.ok(geometry.geometry.attributes.position.count > 0);
      assert.ok(!sourceGeometryObjects.has(geometry), `${geometryName} is not reused`);
      sourceGeometryObjects.add(geometry);
    }
  }
  for (const part of [...wheel.spinParts, ...wheel.carrierParts]) {
    const object = findUnique(gltf.scene, part.runtimeName);
    assert.equal(object.type, 'Mesh');
    assert.equal(object.parent.name, part.sourceParentRuntimeName);
    assert.ok(object.geometry.attributes.position.count > 0);
    assert.ok(!sourceObjects.has(object), `${part.runtimeName} is not reused`);
    sourceObjects.add(object);
  }
}
assert.equal(sourceObjects.size, 24);
assert.equal(sourceGeometryObjects.size, 12);
assert.deepEqual(Object.keys(PRODUCTION_WHEEL_MANIFESTS), ['mx5', 'gt3rs', 'lp700']);
assert.deepEqual(PRODUCTION_WHEEL_MANIFESTS.gt3rs, manifest);

const manager = createGameAssetManager(new THREE.Scene(), null);
const canonical = manager.normalizeCar(gltf.scene, config);
const wheelSet = findUnique(canonical, 'calibrated-wheels');
assert.equal(wheelSet.userData.visualWheelSource, 'manifest:gt3rs');
assert.deepEqual(wheelSet.userData.visualWheelOrder, ['FL', 'FR', 'RL', 'RR']);

for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const roll = findUnique(wheelSet, `visual-wheel-${wheel.id}-roll`);
  const tire = findUnique(roll, wheel.pivot.geometryRuntimeName);
  const caliper = findUnique(steer, wheel.carrierParts[0].runtimeName);
  assert.ok(measureMeshWorldVertexCentroid(tire).distanceTo(steer.getWorldPosition(new THREE.Vector3())) < 1e-8);
  assert.equal(caliper.parent, steer);
  for (const branch of wheel.spinBranches) assert.equal(findUnique(roll, branch.runtimeName).parent, roll);
  for (const part of wheel.spinParts) assert.equal(findUnique(roll, part.runtimeName).parent, roll);

  const caliperBefore = worldMatrix(caliper);
  const disc = findUnique(roll, wheel.spinParts.find(({ role }) => role === 'brake-disc').runtimeName);
  const discBefore = worldMatrix(disc);
  roll.rotation.x = 0.4;
  wheelSet.updateMatrixWorld(true);
  assert.ok(matrixDistance(worldMatrix(caliper), caliperBefore) < 1e-12, `${wheel.id} caliper does not roll`);
  assert.ok(matrixDistance(worldMatrix(disc), discBefore) > 1e-4, `${wheel.id} disc rolls`);
  roll.rotation.x = 0;
}

const instance = canonical.clone(true);
assert.notStrictEqual(findUnique(instance, 'calibrated-wheels'), wheelSet);
assert.strictEqual(
  findUnique(instance, manifest.wheels[0].pivot.geometryRuntimeName).geometry,
  findUnique(canonical, manifest.wheels[0].pivot.geometryRuntimeName).geometry,
);
const rig = createVehicleRig(config, { visual: instance });
assert.equal(rig.vehicle.visualWheelBindings.length, 4);
rig.vehicle.steerAngle = 0.18;
for (const [index, wheel] of rig.vehicle.wheels.entries()) {
  wheel.compression = 0.01 * (index + 1);
  wheel.omega = 8 * (index + 1);
}
rig.vehicle.advanceVisualWheelAngles(FIXED_DT);
rig.vehicle.syncVisual(0.5);
for (const [index, binding] of rig.vehicle.visualWheelBindings.entries()) {
  const wheel = rig.vehicle.wheels[index];
  assert.equal(binding.steer.rotation.y, wheel.front ? rig.vehicle.steerAngle : 0);
  assert.equal(binding.steer.position.y, binding.baseY + wheel.compression);
  assert.equal(binding.roll.rotation.x, wheel.visualAngle * 0.5);
}
destroyVehicleRig(rig);

const brokenManifest = structuredClone(manifest);
brokenManifest.wheels[3].carrierParts[0].runtimeName = 'missing-caliper';
const brokenScene = gltf.scene.clone(true);
const brokenHost = new THREE.Group();
brokenHost.add(brokenScene);
assert.throws(
  () => bindManifestVisualWheels(brokenHost, brokenScene, brokenManifest),
  /RR caliper runtimeName missing-caliper matched 0 objects/,
);
assert.equal(brokenHost.getObjectByName('calibrated-wheels'), undefined, 'failure is atomic');

const overlappingManifest = structuredClone(manifest);
overlappingManifest.wheels[0].spinParts[0].runtimeName = manifest.wheels[0].spinBranches[1].geometryRuntimeNames[0];
overlappingManifest.wheels[0].spinParts[0].sourceParentRuntimeName = manifest.wheels[0].spinBranches[1].runtimeName;
const overlappingScene = gltf.scene.clone(true);
const overlappingHost = new THREE.Group();
overlappingHost.add(overlappingScene);
assert.throws(
  () => bindManifestVisualWheels(overlappingHost, overlappingScene, overlappingManifest),
  /FL rim-root\/brake-chrome ownership overlaps/,
);
assert.equal(overlappingHost.getObjectByName('calibrated-wheels'), undefined, 'overlap failure is atomic');

class SceneLoader {
  constructor(scene) {
    this.scene = scene;
  }

  loadAsync() {
    return Promise.resolve({ scene: this.scene });
  }
}

const fallbackScene = gltf.scene.clone(true);
findUnique(fallbackScene, manifest.wheels[3].carrierParts[0].runtimeName).removeFromParent();
const fallbackManager = createGameAssetManager(new THREE.Scene(), null);
fallbackManager.loader = new SceneLoader(fallbackScene);
const previousWarn = console.warn;
console.warn = () => {};
let fallback;
try {
  fallback = await fallbackManager.instantiateCar(config);
} finally {
  console.warn = previousWarn;
}
assert.equal(fallback.userData.source, 'fallback');
assert.match(fallback.userData.fallbackError.message, /RR caliper runtimeName .* matched 0 objects/);
assert.equal(fallbackManager.visualCache.size, 0);
assert.equal(fallbackManager.pendingCars.size, 0);
assert.equal(fallbackManager.pendingVisuals.size, 0);
for (const wheel of manifest.wheels) {
  assert.equal(findUnique(fallbackScene, wheel.spinBranches[0].runtimeName).parent.name, 'RootNode');
}

const lifecycleManager = createGameAssetManager(new THREE.Scene(), null);
lifecycleManager.loader = new SceneLoader(gltf.scene.clone(true));
const lifecycleA = await lifecycleManager.instantiateCar(config);
const lifecycleB = await lifecycleManager.instantiateCar(config);
assert.equal(lifecycleManager.visualCache.size, 1);
assert.equal(lifecycleA.userData.source, 'gltf');
assert.equal(lifecycleB.userData.source, 'gltf');
const lifecycleAWheels = findUnique(lifecycleA, 'calibrated-wheels');
const lifecycleBWheels = findUnique(lifecycleB, 'calibrated-wheels');
assert.notStrictEqual(lifecycleAWheels, lifecycleBWheels);
assert.strictEqual(
  findUnique(lifecycleA, manifest.wheels[0].pivot.geometryRuntimeName).geometry,
  findUnique(lifecycleB, manifest.wheels[0].pivot.geometryRuntimeName).geometry,
);
const lifecycleRigA = createVehicleRig(config, { visual: lifecycleA });
const lifecycleRigB = createVehicleRig(config, { visual: lifecycleB });
lifecycleRigA.vehicle.steerAngle = 0.2;
lifecycleRigA.vehicle.wheels[0].omega = 11;
lifecycleRigA.vehicle.advanceVisualWheelAngles(FIXED_DT);
lifecycleRigA.vehicle.syncVisual(1);
assert.notEqual(lifecycleRigA.vehicle.visualWheelBindings[0].roll.rotation.x, 0);
assert.equal(Math.abs(lifecycleRigB.vehicle.visualWheelBindings[0].roll.rotation.x), 0);
destroyVehicleRig(lifecycleRigA);
lifecycleRigB.vehicle.reset();
lifecycleRigB.vehicle.syncVisual(1);
assert.equal(Math.abs(lifecycleRigB.vehicle.visualWheelBindings[0].steer.rotation.y), 0);
destroyVehicleRig(lifecycleRigB);

console.log(`PASS real GT3 loader split wheels objects=${sourceObjects.size} textureLimitations=${textureErrors.length}`);
console.log('PASS production factory, tire/rim/disc spin, caliper carrier, cache clones, Rapier owner, and atomic fallbacks');
