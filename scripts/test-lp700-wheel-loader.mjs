import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { AssetManager } from '../src/assets.js';
import { bindGeometrySplitVisualWheels } from '../src/car-wheel-geometry-split.js';
import { CARS, FIXED_DT } from '../src/config.js';
import { createVehicleRig, destroyVehicleRig } from './physics-harness.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'data', 'car-wheel-manifests', 'lp700.json'), 'utf8'));
const config = CARS.find(({ id }) => id === 'lp700');
const bytes = await readFile(path.join(projectRoot, manifest.source.file));
assert.equal(bytes.length, manifest.source.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.source.sha256);

function materialName(mesh) {
  return Array.isArray(mesh.material) ? mesh.material[0]?.name ?? '' : mesh.material?.name ?? '';
}

function findUnique(root, name) {
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  assert.equal(matches.length, 1, `${name} is unique`);
  return matches[0];
}

function boxDistance(left, right) {
  return Math.max(left.min.distanceTo(right.min), left.max.distanceTo(right.max));
}

function collectNamedBounds(root, names) {
  root.updateMatrixWorld(true);
  return new Map(names.map((name) => [name, new THREE.Box3().setFromObject(findUnique(root, name))]));
}

function unionMaterialBounds(root, material) {
  const bounds = new THREE.Box3();
  let count = 0;
  root.traverse((object) => {
    if (!object.isMesh || materialName(object) !== material) return;
    bounds.union(new THREE.Box3().setFromObject(object));
    count += 1;
  });
  assert.equal(count, 4, `${material} split into four meshes`);
  return bounds;
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

for (const part of manifest.geometrySplit.sourceParts) {
  const mesh = findUnique(gltf.scene, part.runtimeName);
  assert.equal(mesh.type, 'Mesh');
  assert.equal(materialName(mesh), part.materialName);
  assert.ok(mesh.geometry.attributes.position.count > 0);
}

let normalizedModel;
let sourceBounds;
let splitBounds;
const manager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { lp700: manifest },
  bindVisualWheels(host, model, nextManifest) {
    normalizedModel = model;
    sourceBounds = collectNamedBounds(model, nextManifest.geometrySplit.sourceParts.map(({ runtimeName }) => runtimeName));
    const result = bindGeometrySplitVisualWheels(host, model, nextManifest);
    splitBounds = new Map(nextManifest.geometrySplit.sourceParts.map(({ materialName: material }) => [material, unionMaterialBounds(result, material)]));
    return result;
  },
});

const startedAt = performance.now();
const canonical = manager.normalizeCar(gltf.scene, config);
const splitMilliseconds = performance.now() - startedAt;
const wheelSet = findUnique(canonical, 'calibrated-wheels');
assert.equal(wheelSet.userData.visualWheelSource, 'manifest:lp700');
assert.deepEqual(wheelSet.userData.visualWheelOrder, ['FL', 'FR', 'RL', 'RR']);

for (const part of manifest.geometrySplit.sourceParts) {
  assert.equal(findUnique(normalizedModel, part.runtimeName).visible, false, `${part.materialName} source hidden before static merge`);
  assert.ok(boxDistance(sourceBounds.get(part.runtimeName), splitBounds.get(part.materialName)) < 1e-8, `${part.materialName} bounds preserved`);
}

const splitGeometries = new Set();
for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const roll = findUnique(wheelSet, `visual-wheel-${wheel.id}-roll`);
  const expectedPivot = new THREE.Vector3(...wheel.expectedPivot);
  assert.ok(steer.getWorldPosition(new THREE.Vector3()).distanceTo(expectedPivot) <= manifest.geometrySplit.pivotToleranceMeters);
  for (const part of manifest.geometrySplit.sourceParts) {
    const mesh = findUnique(roll, `${wheel.id}-${part.materialName}-split`);
    assert.equal(mesh.parent, roll);
    assert.equal(materialName(mesh), part.materialName);
    assert.equal(mesh.geometry.attributes.position.count, part.expectedSplitVertexCountPerWheel);
    splitGeometries.add(mesh.geometry);
  }
  const tire = findUnique(roll, `${wheel.id}-Pneu-split`);
  steer.rotation.y = wheel.axle === 'front' ? 0.34 : 0;
  roll.rotation.x = 0.72;
  wheelSet.updateMatrixWorld(true);
  assert.ok(new THREE.Box3().setFromObject(tire).getCenter(new THREE.Vector3())
    .distanceTo(steer.getWorldPosition(new THREE.Vector3())) < 1e-8, `${wheel.id} center stable under steer/roll`);
  roll.rotation.x = -0.72;
  wheelSet.updateMatrixWorld(true);
  assert.ok(new THREE.Box3().setFromObject(tire).getCenter(new THREE.Vector3())
    .distanceTo(steer.getWorldPosition(new THREE.Vector3())) < 1e-8, `${wheel.id} center stable under reverse roll`);
  steer.rotation.y = 0;
  roll.rotation.x = 0;
}
assert.equal(splitGeometries.size, 16);

const instance = canonical.clone(true);
assert.notStrictEqual(findUnique(instance, 'calibrated-wheels'), wheelSet);
assert.strictEqual(findUnique(instance, 'FL-Pneu-split').geometry, findUnique(canonical, 'FL-Pneu-split').geometry);
const rig = createVehicleRig(config, { visual: instance });
assert.equal(rig.vehicle.visualWheelBindings.length, 4);
rig.vehicle.steerAngle = 0.19;
for (const [index, wheel] of rig.vehicle.wheels.entries()) {
  wheel.compression = 0.012 * (index + 1);
  wheel.omega = 7 * (index + 1);
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
brokenManifest.geometrySplit.sourceParts[2].expectedSplitVertexCountPerWheel += 3;
let brokenHost;
let brokenModel;
const brokenManager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { lp700: brokenManifest },
  bindVisualWheels(host, model, nextManifest) {
    brokenHost = host;
    brokenModel = model;
    return bindGeometrySplitVisualWheels(host, model, nextManifest);
  },
});
let disposedGeometryCount = 0;
const originalGeometryDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function trackedDispose() {
  disposedGeometryCount += 1;
  return originalGeometryDispose.call(this);
};
try {
  assert.throws(
    () => brokenManager.normalizeCar(gltf.scene.clone(true), config),
    /Jante split vertex count/,
  );
} finally {
  THREE.BufferGeometry.prototype.dispose = originalGeometryDispose;
}
assert.ok(disposedGeometryCount >= 16, 'temporary split geometries disposed after atomic failure');
assert.equal(brokenHost.getObjectByName('calibrated-wheels'), undefined, 'failure is atomic');
for (const part of brokenManifest.geometrySplit.sourceParts) {
  assert.equal(findUnique(brokenModel, part.runtimeName).visible, true, `${part.materialName} stays visible after failure`);
}

const geometryBytes = [...splitGeometries].reduce((sum, geometry) => sum + Object.values(geometry.attributes)
  .reduce((attributeSum, attribute) => attributeSum + attribute.array.byteLength, 0), 0);
console.log(`PASS real LP700 loader sourceParts=4 splitParts=16 geometryBytes=${geometryBytes} splitMs=${splitMilliseconds.toFixed(1)} textureLimitations=${textureErrors.length}`);
console.log('PASS preserved source bounds, exact wheel pivots/counts, clone sharing, Rapier owner, and atomic count failure');
