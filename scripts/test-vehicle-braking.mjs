import assert from 'node:assert/strict';

import { CARS, FIXED_DT } from '../src/config.js';
import { integrateWheelOmegaWithBrakeCapacity } from '../src/vehicle-physics.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

const WHEEL_INERTIA = 1.25;

function nearlyEqual(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

nearlyEqual(
  integrateWheelOmegaWithBrakeCapacity(0, 300, 50, WHEEL_INERTIA, FIXED_DT),
  (300 - 50) / WHEEL_INERTIA * FIXED_DT,
);
assert.equal(
  integrateWheelOmegaWithBrakeCapacity(0, 300, 1500, WHEEL_INERTIA, FIXED_DT),
  0,
  'brake capacity larger than the free angular impulse holds a stopped wheel',
);
nearlyEqual(
  integrateWheelOmegaWithBrakeCapacity(0, -300, 50, WHEEL_INERTIA, FIXED_DT),
  -(300 - 50) / WHEEL_INERTIA * FIXED_DT,
);
assert.ok(
  integrateWheelOmegaWithBrakeCapacity(0, 300, 1e-25, WHEEL_INERTIA, FIXED_DT) > 0,
  'a tiny positive brake capacity cannot absorb a finite launch torque',
);

function sampleAssist(config, {
  speed,
  reverse = false,
  input,
  wheelOmega,
  initialSteerAngle = 0,
}) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    rig.vehicle.reverse = reverse;
    rig.vehicle.steerAngle = initialSteerAngle;
    rig.vehicle.body.setLinvel({ x: 0, y: 0, z: speed }, true);
    for (const wheel of rig.vehicle.wheels) {
      wheel.omega = typeof wheelOmega === 'function' ? wheelOmega(wheel) : wheelOmega;
    }
    rig.vehicle.fixedUpdate(input, false, FIXED_DT);
    return {
      absActive: rig.vehicle.telemetry.absActive,
      tcsActive: rig.vehicle.telemetry.tcsActive,
      stabilityActive: rig.vehicle.telemetry.stabilityActive,
      slipRatios: rig.vehicle.telemetry.wheels.map((wheel) => wheel.slipRatio),
      powertrain: { ...rig.vehicle.telemetry.powertrain },
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

const mx5 = CARS.find((config) => config.id === 'mx5');
const forwardLockedBrake = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ brake: 1, driveIntent: -1 }),
  wheelOmega: 0,
});
const reverseLockedBrake = sampleAssist(mx5, {
  speed: -10,
  reverse: true,
  input: zeroInput({ throttle: 1, driveIntent: 1 }),
  wheelOmega: 0,
});
assert.equal(forwardLockedBrake.absActive, true, 'ABS recognizes forward braking slip');
assert.equal(reverseLockedBrake.absActive, true, 'ABS recognizes reverse braking slip symmetrically');
assert.ok(
  forwardLockedBrake.powertrain.serviceBrakeTorqueAppliedNm
    < forwardLockedBrake.powertrain.serviceBrakeTorqueRequestedNm,
  'brake diagnostics report ABS-reduced service-brake torque',
);
assert.ok(
  reverseLockedBrake.powertrain.serviceBrakeTorqueAppliedNm
    < reverseLockedBrake.powertrain.serviceBrakeTorqueRequestedNm,
  'brake diagnostics report the symmetric reverse ABS reduction',
);

const handbrakeLock = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ handbrake: 1 }),
  wheelOmega: 0,
});
assert.equal(handbrakeLock.absActive, false, 'handbrake torque is not released by service-brake ABS');
nearlyEqual(
  handbrakeLock.powertrain.handbrakeTorqueAppliedNm,
  handbrakeLock.powertrain.handbrakeTorqueRequestedNm,
  1e-9,
);

const drivenWheelLag = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ throttle: 1, driveIntent: 1 }),
  wheelOmega: 0,
});
assert.equal(drivenWheelLag.tcsActive, false, 'TCS ignores a driven wheel lagging behind road speed');
nearlyEqual(
  drivenWheelLag.powertrain.driveTorqueAppliedNm,
  drivenWheelLag.powertrain.driveTorqueRequestedNm,
  1e-9,
);

const forwardWheelspin = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ throttle: 1, driveIntent: 1 }),
  wheelOmega: 13 / mx5.wheelRadius,
});
assert.equal(forwardWheelspin.tcsActive, true, 'TCS recognizes forward driven-wheel overspeed');
assert.ok(
  forwardWheelspin.powertrain.driveTorqueAppliedNm
    < forwardWheelspin.powertrain.driveTorqueRequestedNm,
  'power diagnostics report the TCS-limited driven-wheel torque',
);

const reverseWheelspin = sampleAssist(mx5, {
  speed: -10,
  reverse: true,
  input: zeroInput({ brake: 1, driveIntent: -1 }),
  wheelOmega: -13 / mx5.wheelRadius,
});
assert.equal(reverseWheelspin.tcsActive, true, 'TCS recognizes reverse driven-wheel overspeed');
assert.ok(
  reverseWheelspin.powertrain.driveTorqueAppliedNm
    < reverseWheelspin.powertrain.driveTorqueRequestedNm,
  'power diagnostics report reverse TCS limiting symmetrically',
);

const frontOnlySlip = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ throttle: 1, driveIntent: 1 }),
  wheelOmega: (wheel) => (wheel.front ? 13 : 10) / mx5.wheelRadius,
});
assert.equal(frontOnlySlip.tcsActive, false, 'TCS ignores slip on undriven front wheels');

const residualHandbrakeStability = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ steer: 1, handbrake: 1e-25 }),
  wheelOmega: 10 / mx5.wheelRadius,
  initialSteerAngle: mx5.steer,
});
const activeHandbrakeStability = sampleAssist(mx5, {
  speed: 10,
  input: zeroInput({ steer: 1, handbrake: 1 }),
  wheelOmega: 10 / mx5.wheelRadius,
  initialSteerAngle: mx5.steer,
});
assert.equal(residualHandbrakeStability.stabilityActive, true, 'a numerical handbrake residual does not disable ESC');
assert.equal(activeHandbrakeStability.stabilityActive, false, 'an intentionally active handbrake disables ESC');

const fullLock = zeroInput({ throttle: 1, handbrake: 1, driveIntent: 1 });
const residualRelease = zeroInput({ throttle: 1, handbrake: 1e-25, driveIntent: 1 });
for (const config of CARS) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    for (const wheel of rig.vehicle.wheels) wheel.omega = 0;
    stepVehicle(rig, fullLock);
    assert.ok(
      rig.vehicle.wheels.filter((wheel) => !wheel.front).every((wheel) => wheel.omega === 0),
      `${config.id} full handbrake holds both stopped rear wheels`,
    );

    stepVehicle(rig, residualRelease);
    assert.ok(
      rig.vehicle.wheels.filter((wheel) => !wheel.front).every((wheel) => wheel.omega > 1e-3),
      `${config.id} rear wheels restart against a 1e-25 handbrake residual`,
    );

    runFor(rig, 0.75, residualRelease);
    assert.ok(
      rig.vehicle.telemetry.signedSpeedKmh > 1,
      `${config.id} accelerates after handbrake lock and residual release`,
    );

    runFor(rig, 3.25, residualRelease);
    assert.ok(
      rig.vehicle.telemetry.signedSpeedKmh > 25,
      `${config.id} reaches the moving W+Space acceptance scenario`,
    );

    runFor(rig, 1, fullLock);
    assert.ok(
      rig.vehicle.wheels.filter((wheel) => !wheel.front).every((wheel) => wheel.omega === 0),
      `${config.id} W+Space locks both moving rear wheels`,
    );

    stepVehicle(rig, residualRelease);
    assert.ok(
      rig.vehicle.wheels.filter((wheel) => !wheel.front).every((wheel) => wheel.omega > 1e-3),
      `${config.id} moving rear wheels restart without pause after residual release`,
    );
  } finally {
    destroyVehicleRig(rig);
  }
}

console.log('PASS finite wheel braking, directional ABS/TCS, and six-car handbrake recovery');
