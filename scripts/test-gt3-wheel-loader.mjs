import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { AssetManager } from '../src/assets.js';
import { bindManifestVisualWheels, measureMeshWorldVertexCentroid } from '../src/car-wheel-pivots.js';
import { CARS, FIXED_DT } from '../src/config.js';
import { PRODUCTION_WHEEL_MANIFESTS } from '../src/game-assets.js';
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
assert.deepEqual(Object.keys(PRODUCTION_WHEEL_MANIFESTS), ['mx5'], 'GT3 remains outside production during candidate validation');

const manager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { gt3rs: manifest },
  bindVisualWheels: bindManifestVisualWheels,
});
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

console.log(`PASS real GT3 loader split wheels objects=${sourceObjects.size} textureLimitations=${textureErrors.length}`);
console.log('PASS tire/rim/disc spin, caliper carrier, clone, Rapier owner, and atomic failure');
