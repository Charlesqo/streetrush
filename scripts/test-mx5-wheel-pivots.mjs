import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { AssetManager } from '../src/assets.js';
import { bindManifestVisualWheels, measureMeshWorldVertexCentroid } from '../src/car-wheel-pivots.js';
import { parseGlb } from './car-model-structure.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'data', 'car-wheel-manifests', 'mx5.json'), 'utf8'));
const { json } = parseGlb(await readFile(path.join(projectRoot, manifest.source.file)), manifest.source.file);
const MODEL_SCALE = 0.015102163;

function meshWorldCentroid(mesh) {
  return measureMeshWorldVertexCentroid(mesh);
}

function findUnique(root, name) {
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  assert.equal(matches.length, 1, `fixture name ${name} is unique`);
  return matches[0];
}

function makeCenteredGeometry(center) {
  const offsets = [
    [-0.3, -0.2, -0.1],
    [0.3, -0.2, 0.1],
    [-0.1, 0.4, 0.2],
    [0.1, 0, -0.2],
  ];
  const values = offsets.flatMap((offset) => offset.map((value, axis) => center.getComponent(axis) + value));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  return geometry;
}

function makeFixture() {
  const host = new THREE.Group();
  host.name = 'vehicle-host';
  const model = new THREE.Group();
  model.name = 'mx5-model';
  model.scale.setScalar(MODEL_SCALE);
  model.position.set(-2.3, -0.98, 0.42);
  host.add(model);
  for (const wheel of manifest.wheels) {
    const rawRoot = json.nodes[wheel.root.node];
    const root = new THREE.Group();
    root.name = wheel.root.runtimeName;
    root.position.fromArray(rawRoot.translation || [0, 0, 0]);
    root.quaternion.fromArray(rawRoot.rotation || [0, 0, 0, 1]);
    root.scale.fromArray(rawRoot.scale || [1, 1, 1]);
    root.updateMatrix();
    const inverseRoot = root.matrix.clone().invert();
    for (const part of wheel.parts) {
      const rawCenter = part.role === wheel.pivot.partRole
        ? wheel.pivot.expectedRawWorldCentroid
        : part.expectedRawWorldBounds.min.map((value, axis) => (value + part.expectedRawWorldBounds.max[axis]) * 0.5);
      const localCenter = new THREE.Vector3(...rawCenter).applyMatrix4(inverseRoot);
      const mesh = new THREE.Mesh(makeCenteredGeometry(localCenter), new THREE.MeshBasicMaterial());
      mesh.name = part.runtimeName;
      mesh.userData.wheelPartRole = part.role;
      root.add(mesh);
    }
    model.add(root);
  }
  const staticGeometry = new THREE.BoxGeometry(1, 1, 1);
  const staticMaterial = new THREE.MeshBasicMaterial();
  for (let index = 0; index < 9; index += 1) {
    const mesh = new THREE.Mesh(staticGeometry, staticMaterial);
    mesh.name = `static-body-${index}`;
    mesh.position.set(index * 5, 80, index * -3);
    model.add(mesh);
  }
  host.updateMatrixWorld(true);
  return { host, model };
}

const direct = makeFixture();
const before = manifest.wheels.filter(({ axle }) => axle === 'front').map((wheel) => {
  const tire = findUnique(direct.model, wheel.parts.find(({ role }) => role === 'tire').runtimeName);
  return { wheel, tire, centroid: meshWorldCentroid(tire) };
});
for (const { wheel } of before) {
  const root = findUnique(direct.model, wheel.root.runtimeName);
  root.rotateZ(0.72);
  root.rotateY(0.34);
}
direct.host.updateMatrixWorld(true);
const directMaxCentroidDrift = Math.max(...before.map(({ tire, centroid }) => meshWorldCentroid(tire).distanceTo(centroid)));
assert.ok(directMaxCentroidDrift > 0.008 && directMaxCentroidDrift < 0.01, `direct control drift ${directMaxCentroidDrift}m is outside evidence range`);

function maxMatrixError(left, right) {
  return Math.max(...left.elements.map((value, index) => Math.abs(value - right.elements[index])));
}

function captureParts(root) {
  const result = new Map();
  for (const wheel of manifest.wheels) {
    for (const part of wheel.parts) {
      const mesh = findUnique(root, part.runtimeName);
      mesh.updateWorldMatrix(true, false);
      result.set(`${wheel.id}:${part.role}`, {
        mesh,
        matrix: mesh.matrixWorld.clone(),
        centroid: meshWorldCentroid(mesh),
        geometry: mesh.geometry,
        material: mesh.material,
      });
    }
  }
  return result;
}

const bound = makeFixture();
const resourcesBefore = captureParts(bound.host);
const wheelSet = bindManifestVisualWheels(bound.host, bound.model, manifest);
const resourcesAfter = captureParts(bound.host);
assert.equal(wheelSet.parent, bound.host);
assert.deepEqual(wheelSet.userData.visualWheelOrder, ['FL', 'FR', 'RL', 'RR']);
assert.deepEqual(wheelSet.userData.dynamicCarPart, { version: 1, id: 'mx5-wheel-set' });
let maxAttachMatrixError = 0;
for (const [key, after] of resourcesAfter) {
  const prior = resourcesBefore.get(key);
  maxAttachMatrixError = Math.max(maxAttachMatrixError, maxMatrixError(after.matrix, prior.matrix));
  assert.strictEqual(after.geometry, prior.geometry);
  assert.strictEqual(after.material, prior.material);
}
assert.ok(maxAttachMatrixError < 1e-12, `zero-pose attach matrix error ${maxAttachMatrixError}`);

let maxBoundTireDrift = 0;
for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const roll = findUnique(wheelSet, `visual-wheel-${wheel.id}-roll`);
  assert.equal(roll.parent, steer);
  assert.equal(findUnique(bound.host, wheel.root.runtimeName).parent, roll);
  const tire = findUnique(bound.host, wheel.parts.find(({ role }) => role === 'tire').runtimeName);
  maxBoundTireDrift = Math.max(maxBoundTireDrift, meshWorldCentroid(tire).distanceTo(steer.getWorldPosition(new THREE.Vector3())));
  if (wheel.axle === 'front') steer.rotation.y = 0.34;
  roll.rotation.x = 0.72;
}
bound.host.updateMatrixWorld(true);
for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const tire = findUnique(bound.host, wheel.parts.find(({ role }) => role === 'tire').runtimeName);
  maxBoundTireDrift = Math.max(maxBoundTireDrift, meshWorldCentroid(tire).distanceTo(steer.getWorldPosition(new THREE.Vector3())));
  for (const part of wheel.parts) {
    const beforePart = resourcesAfter.get(`${wheel.id}:${part.role}`);
    const afterMesh = findUnique(bound.host, part.runtimeName);
    afterMesh.updateWorldMatrix(true, false);
    assert.ok(maxMatrixError(afterMesh.matrixWorld, beforePart.matrix) > 1e-4, `${wheel.id} ${part.role} matrix follows nested roll`);
    if (wheel.axle === 'front' && part.role !== 'tire') {
      assert.ok(meshWorldCentroid(afterMesh).distanceTo(beforePart.centroid) > 1e-5, `${wheel.id} ${part.role} offset centroid follows nested roll`);
    }
  }
}
assert.ok(maxBoundTireDrift < 1e-8, `bound tire centroid drift ${maxBoundTireDrift}`);

for (const wheel of manifest.wheels) {
  const steer = findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`);
  const roll = findUnique(wheelSet, `visual-wheel-${wheel.id}-roll`);
  steer.rotation.y = 0;
  roll.rotation.x = 0;
}
bound.host.updateMatrixWorld(true);
const suspensionBefore = captureParts(bound.host);
for (const wheel of manifest.wheels) {
  findUnique(wheelSet, `visual-wheel-${wheel.id}-steer`).position.y += 0.08;
}
bound.host.updateMatrixWorld(true);
for (const wheel of manifest.wheels) {
  for (const part of wheel.parts) {
    const key = `${wheel.id}:${part.role}`;
    const delta = meshWorldCentroid(findUnique(bound.host, part.runtimeName)).sub(suspensionBefore.get(key).centroid);
    assert.ok(delta.distanceTo(new THREE.Vector3(0, 0.08, 0)) < 1e-8, `${key} suspension stays in host metres`);
  }
}

const clone = bound.host.clone(true);
const cloneWheelSet = findUnique(clone, 'calibrated-wheels');
assert.notStrictEqual(cloneWheelSet, wheelSet);
assert.strictEqual(
  findUnique(clone, manifest.wheels[0].parts[1].runtimeName).geometry,
  findUnique(bound.host, manifest.wheels[0].parts[1].runtimeName).geometry,
);

const broken = makeFixture();
const brokenManifest = structuredClone(manifest);
brokenManifest.wheels[3].parts[1].runtimeName = 'missing-tire';
await assert.rejects(
  async () => bindManifestVisualWheels(broken.host, broken.model, brokenManifest),
  /RR tire runtimeName missing-tire matched 0 objects/,
);
assert.equal(broken.host.getObjectByName('calibrated-wheels'), undefined);
for (const wheel of manifest.wheels) assert.equal(findUnique(broken.model, wheel.root.runtimeName).parent, broken.model);

const scaledHost = makeFixture();
scaledHost.host.scale.setScalar(2);
assert.throws(
  () => bindManifestVisualWheels(scaledHost.host, scaledHost.model, manifest),
  /vehicle host scale must remain unit/,
);
assert.equal(scaledHost.host.getObjectByName('calibrated-wheels'), undefined);

assert.throws(
  () => bindManifestVisualWheels(bound.host, bound.model, manifest),
  /vehicle host already has calibrated-wheels/,
);

const manager = new AssetManager(new THREE.Scene(), null);
const optimized = manager.mergeStaticCarMeshes(bound.model);
assert.equal(optimized.userData.sourceDrawCalls, 9);
assert.equal(optimized.userData.batchedDrawCalls, 1);
bound.host.remove(bound.model);
bound.host.add(optimized);
assert.equal(findUnique(bound.host, 'calibrated-wheels'), wheelSet);

console.log(`PASS MX-5 direct centroid drift=${directMaxCentroidDrift.toFixed(9)}m bound<${maxBoundTireDrift.toExponential(2)}`);
console.log(`PASS zero attach error=${maxAttachMatrixError.toExponential(2)}, nested roll, 0.08m suspension, clone, atomic failures, and static merge`);
