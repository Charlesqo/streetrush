import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCarWheelManifest } from './car-wheel-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'data', 'car-wheel-manifests', 'mx5.json'), 'utf8'));
const filePath = path.join(root, manifest.source.file);

if (process.argv.includes('--measure')) {
  const measurement = await inspectCarWheelManifest({ filePath, manifest, validateExpected: false });
  process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
  process.exit(0);
}

const result = await inspectCarWheelManifest({ filePath, manifest });
assert.deepEqual(result.order, ['FL', 'FR', 'RL', 'RR']);
assert.ok(result.maxAxisError < 1e-6);
assert.ok(result.maxPivotError < 1e-6);

const wrongHash = structuredClone(manifest);
wrongHash.source.sha256 = '0'.repeat(64);
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongHash }), /source sha256/);

const wrongRoot = structuredClone(manifest);
wrongRoot.wheels[0].root.name = 'Circle.999';
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongRoot }), /FL root name/);

const wrongRole = structuredClone(manifest);
wrongRole.wheels[1].parts[1].materialName = 'Material.invalid';
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongRole }), /tire material name/);

const wrongAccessor = structuredClone(manifest);
wrongAccessor.wheels[1].parts[1].positionAccessor += 1;
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongAccessor }), /tire POSITION accessor/);

const wrongBounds = structuredClone(manifest);
wrongBounds.wheels[3].parts[0].expectedRawWorldBounds.min[0] += 0.001;
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongBounds }), /rim bounds min/);

const wrongAxis = structuredClone(manifest);
wrongAxis.coordinates.expectedSourceParentRollAxisWorld = [0, 0, 1];
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongAxis }), /FL source parent roll axis/);

const wrongRuntimeAxis = structuredClone(manifest);
wrongRuntimeAxis.coordinates.runtimeRollAxis = [0, 0, 1];
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongRuntimeAxis }), /runtime roll axis/);

const wrongPivot = structuredClone(manifest);
wrongPivot.wheels[2].pivot.expectedRawWorldCentroid[2] += 0.001;
await assert.rejects(() => inspectCarWheelManifest({ filePath, manifest: wrongPivot }), /RL pivot centroid/);

console.log(`PASS ${result.vehicleId} wheel manifest order=${result.order.join('/')} centroid=${result.centroidDigest.slice(0, 16)}`);
console.log('PASS source hash, roots, part roles, accessors, vertex centroids, and axes fail closed');
