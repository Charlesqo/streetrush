import assert from 'node:assert/strict';
import * as THREE from 'three';

import { AssetManager } from '../src/assets.js';
import { CARS, FIXED_DT } from '../src/config.js';
import { createVehicleRig, destroyVehicleRig } from './physics-harness.mjs';

const config = CARS.find(({ id }) => id === 'm3e30');
const assets = new AssetManager(new THREE.Scene(), null);
const visual = new THREE.Group();
visual.userData.source = 'gltf';
const canonicalWheelSet = assets.createCalibratedWheelSet(config);
visual.add(canonicalWheelSet.clone(true));

const ids = ['FL', 'FR', 'RL', 'RR'];
for (const id of ids) {
  const steer = visual.getObjectByName(`visual-wheel-${id}-steer`);
  const roll = visual.getObjectByName(`visual-wheel-${id}-roll`);
  assert.ok(steer, `${id} has a steer/suspension pivot`);
  assert.ok(roll, `${id} has a nested roll pivot`);
  assert.strictEqual(roll.parent, steer, `${id} roll pivot is nested under steer`);
}

const rig = createVehicleRig(config, { visual });
const { vehicle } = rig;
assert.equal(vehicle.visualWheelBindings.length, 4);

vehicle.steerAngle = 0.24;
for (const [index, wheel] of vehicle.wheels.entries()) {
  wheel.compression = 0.01 * (index + 1);
  wheel.omega = 12 * (index + 1);
}
vehicle.advanceVisualWheelAngles(FIXED_DT);
vehicle.syncVisual(0.5);

for (const [index, id] of ids.entries()) {
  const wheel = vehicle.wheels[index];
  const binding = vehicle.visualWheelBindings[index];
  assert.equal(binding.id, id);
  assert.equal(binding.steer.rotation.y, wheel.front ? vehicle.steerAngle : 0);
  assert.equal(binding.steer.position.y, binding.baseY + wheel.compression);
  assert.equal(binding.roll.rotation.x, wheel.visualAngle * 0.5);
}

vehicle.reset();
vehicle.syncVisual(1);
for (const [index, binding] of vehicle.visualWheelBindings.entries()) {
  assert.equal(vehicle.wheels[index].visualAngle, 0);
  assert.equal(vehicle.wheels[index].previousVisualAngle, 0);
  assert.equal(binding.roll.rotation.x, 0);
  assert.equal(binding.steer.rotation.y, 0);
}

vehicle.wheels[0].previousVisualAngle = Number.NaN;
vehicle.wheels[0].visualAngle = Number.POSITIVE_INFINITY;
vehicle.wheels[0].omega = 6;
vehicle.advanceVisualWheelAngles(FIXED_DT);
vehicle.syncVisual(1);
assert.equal(Number.isFinite(vehicle.visualWheelBindings[0].roll.rotation.x), true);

vehicle.reset();
vehicle.body.setTranslation({ x: 0, y: 20, z: 0 }, true);
vehicle.wheels[0].omega = 12;
vehicle.fixedUpdate({}, true, FIXED_DT);
assert.notEqual(vehicle.wheels[0].visualAngle, 0, 'fixedUpdate advances visual wheel rotation');

destroyVehicleRig(rig);
console.log('PASS generated M3 wheels bind in FL/FR/RL/RR order');
console.log('PASS steer, suspension, roll interpolation, and reset reach visual wheel pivots');
