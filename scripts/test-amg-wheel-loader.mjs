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
import { PRODUCTION_WHEEL_MANIFESTS } from '../src/game-assets.js';
import { createVehicleRig, destroyVehicleRig } from './physics-harness.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'data', 'car-wheel-manifests', 'amggt3.json'), 'utf8'));
const config = CARS.find(({ id }) => id === 'amggt3');
const bytes = await readFile(path.join(projectRoot, manifest.source.file));
assert.equal(bytes.length, manifest.source.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.source.sha256);
assert.equal(PRODUCTION_WHEEL_MANIFESTS.amggt3, undefined, 'candidate is not production integrated');

function materialName(mesh) {
  return Array.isArray(mesh.material) ? mesh.material[0]?.name ?? '' : mesh.material?.name ?? '';
}

function findUnique(root, name) {
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  assert.equal(matches.length, 1, `${name} is unique`);
  return matches[0];
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
assert.equal(gltf.scene.getObjectByName('WHEEL_RF_333'), undefined, 'source hierarchy is absent from optimized derivative');
const retainedCaliperMaterials = [];
gltf.scene.traverse((object) => {
  if (object.isMesh && /EXT_Caliper/i.test(materialName(object))) retainedCaliperMaterials.push(materialName(object));
});
assert.deepEqual(retainedCaliperMaterials, [], 'source caliper materials are absent after palette merge');
assert.equal(manifest.geometrySplit.knownUnboundParts[0].status, 'blocked-by-optimizer-palette-merge');

for (const part of manifest.geometrySplit.sourceParts) {
  const mesh = findUnique(gltf.scene, part.runtimeName);
  assert.equal(mesh.type, 'Mesh');
  assert.equal(materialName(mesh), part.materialName);
  assert.ok(mesh.geometry.attributes.position.count > 0);
  const sourceTriangleListCount = mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count;
  const expectedSplitTotal = part.expectedSplitVertexCountPerWheel
    ? part.expectedSplitVertexCountPerWheel * manifest.wheels.length
    : Object.values(part.expectedSplitVertexCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(expectedSplitTotal, sourceTriangleListCount, `${part.materialName} split accounts for every source index`);
}

let normalizedModel;
const manager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { amggt3: manifest },
  bindVisualWheels(host, model, nextManifest) {
    normalizedModel = model;
    return bindGeometrySplitVisualWheels(host, model, nextManifest);
  },
});
const startedAt = performance.now();
const canonical = manager.normalizeCar(gltf.scene, config);
const splitMilliseconds = performance.now() - startedAt;
const wheelSet = findUnique(canonical, 'calibrated-wheels');
assert.equal(wheelSet.userData.visualWheelSource, 'manifest:amggt3');
assert.deepEqual(wheelSet.userData.visualWheelOrder, ['FL', 'FR', 'RL', 'RR']);

const geometries = new Set();
const measuredPivots = [];
for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const roll = findUnique(wheelSet, `visual-wheel-${wheel.id}-roll`);
  const measuredPivot = steer.getWorldPosition(new THREE.Vector3());
  measuredPivots.push([wheel.id, ...measuredPivot.toArray().map((value) => Number(value.toFixed(9)))]);
  assert.ok(measuredPivot.distanceTo(new THREE.Vector3(...wheel.expectedPivot)) <= manifest.geometrySplit.pivotToleranceMeters);
  for (const part of manifest.geometrySplit.sourceParts) {
    const mesh = findUnique(roll, `${wheel.id}-${part.materialName}-split`);
    assert.equal(mesh.geometry.attributes.position.count, part.expectedSplitVertexCounts?.[wheel.id] ?? part.expectedSplitVertexCountPerWheel);
    geometries.add(mesh.geometry);
  }
  const tire = findUnique(roll, `${wheel.id}-amg_gt3_tyres-split`);
  steer.rotation.y = wheel.axle === 'front' ? 0.34 : 0;
  roll.rotation.x = 0.72;
  wheelSet.updateMatrixWorld(true);
  assert.ok(new THREE.Box3().setFromObject(tire).getCenter(new THREE.Vector3())
    .distanceTo(steer.getWorldPosition(new THREE.Vector3())) < 1e-8, `${wheel.id} center stable under steer/roll`);
  steer.rotation.y = 0;
  roll.rotation.x = 0;
}
assert.equal(geometries.size, 16);
for (const part of manifest.geometrySplit.sourceParts) assert.equal(findUnique(normalizedModel, part.runtimeName).visible, false);

const instance = canonical.clone(true);
assert.strictEqual(findUnique(instance, 'FL-amg_gt3_tyres-split').geometry, findUnique(canonical, 'FL-amg_gt3_tyres-split').geometry);
const rig = createVehicleRig(config, { visual: instance });
assert.equal(rig.vehicle.visualWheelBindings.length, 4);
rig.vehicle.steerAngle = 0.17;
rig.vehicle.wheels[0].compression = 0.03;
rig.vehicle.wheels[0].omega = 9;
rig.vehicle.advanceVisualWheelAngles(FIXED_DT);
rig.vehicle.syncVisual(0.5);
assert.equal(rig.vehicle.visualWheelBindings[0].steer.rotation.y, rig.vehicle.steerAngle);
assert.equal(rig.vehicle.visualWheelBindings[0].steer.position.y, rig.vehicle.visualWheelBindings[0].baseY + 0.03);
assert.notEqual(rig.vehicle.visualWheelBindings[0].roll.rotation.x, 0);
destroyVehicleRig(rig);

const broken = structuredClone(manifest);
broken.geometrySplit.sourceParts[1].expectedSplitVertexCountPerWheel += 3;
let brokenHost;
let brokenModel;
const brokenManager = new AssetManager(new THREE.Scene(), null, {
  wheelManifests: { amggt3: broken },
  bindVisualWheels(host, model, nextManifest) {
    brokenHost = host;
    brokenModel = model;
    return bindGeometrySplitVisualWheels(host, model, nextManifest);
  },
});
assert.throws(() => brokenManager.normalizeCar(gltf.scene.clone(true), config), /PaletteMaterial003 split vertex count/);
assert.equal(brokenHost.getObjectByName('calibrated-wheels'), undefined);
for (const part of broken.geometrySplit.sourceParts) assert.equal(findUnique(brokenModel, part.runtimeName).visible, true);

const geometryBytes = [...geometries].reduce((sum, geometry) => sum + Object.values(geometry.attributes)
  .reduce((attributeSum, attribute) => attributeSum + attribute.array.byteLength, 0), 0);
console.log(`PASS optimized AMG loader sourceParts=4 splitParts=16 geometryBytes=${geometryBytes} splitMs=${splitMilliseconds.toFixed(1)} pivots=${JSON.stringify(measuredPivots)} textureLimitations=${textureErrors.length}`);
console.log('PASS exact derivative materials/counts, stable pivots, Rapier owner, atomic failure, and explicit caliper blocker');
