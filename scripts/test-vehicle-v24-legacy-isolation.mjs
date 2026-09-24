import assert from 'node:assert/strict';

import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  zeroInput,
} from './physics-harness.mjs';

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

function deterministicInput(tick) {
  const reverseRequest = tick >= 420;
  return zeroInput({
    steer: Math.sin(tick * 0.031) * 0.38,
    throttle: reverseRequest ? 0 : 0.72 + 0.12 * Math.sin(tick * 0.017),
    brake: reverseRequest ? 0.82 : 0,
    handbrake: tick >= 300 && tick < 330 ? 0.4 : 0,
    driveIntent: reverseRequest ? -1 : 1,
    shiftUp: tick === 180 || tick === 280,
    shiftDown: tick === 560,
    toggleTransmission: tick === 0,
    reset: tick === 360,
  });
}

function captureVehicle(vehicle) {
  const translation = vehicle.body.translation();
  const rotation = vehicle.body.rotation();
  const linvel = vehicle.body.linvel();
  const angvel = vehicle.body.angvel();
  return {
    body: {
      translation: { ...translation },
      rotation: { ...rotation },
      linvel: { ...linvel },
      angvel: { ...angvel },
      force: { ...vehicle.body.userForce() },
      torque: { ...vehicle.body.userTorque() },
    },
    state: {
      transmissionMode: vehicle.transmissionMode,
      gear: vehicle.gear,
      reverse: vehicle.reverse,
      reverseHold: vehicle.reverseHold,
      shiftTimer: vehicle.shiftTimer,
      engineRpm: vehicle.engineRpm,
      engineLoad: vehicle.engineLoad,
      steerAngle: vehicle.steerAngle,
      previousLongSpeed: vehicle.previousLongSpeed,
      safeSample: vehicle.safeSample,
      trackHint: vehicle.trackHint,
      stuckTimer: vehicle.stuckTimer,
    },
    wheels: vehicle.wheels.map((wheel) => ({
      omega: wheel.omega,
      grounded: wheel.grounded,
      compression: wheel.compression,
      springForce: wheel.springForce,
      surface: wheel.surface,
    })),
    telemetry: {
      speedKmh: vehicle.telemetry.speedKmh,
      signedSpeedKmh: vehicle.telemetry.signedSpeedKmh,
      rpm: vehicle.telemetry.rpm,
      gear: vehicle.telemetry.gear,
      reverse: vehicle.telemetry.reverse,
      throttle: vehicle.telemetry.throttle,
      brake: vehicle.telemetry.brake,
      handbrake: vehicle.telemetry.handbrake,
      steer: vehicle.telemetry.steer,
      longitudinalAcceleration: vehicle.telemetry.longitudinalAcceleration,
      lateralAcceleration: vehicle.telemetry.lateralAcceleration,
      surface: vehicle.telemetry.surface,
      absActive: vehicle.telemetry.absActive,
      tcsActive: vehicle.telemetry.tcsActive,
      stabilityActive: vehicle.telemetry.stabilityActive,
      powertrain: { ...vehicle.telemetry.powertrain },
      wheels: vehicle.telemetry.wheels.map((wheel) => ({
        grounded: wheel.grounded,
        load: wheel.load,
        suspension: wheel.suspension,
        slipRatio: wheel.slipRatio,
        slipAngle: wheel.slipAngle,
        slipPower: wheel.slipPower,
        surface: wheel.surface,
        contactPoint: { ...wheel.contactPoint },
      })),
    },
  };
}

for (const config of CARS) {
  const dispatchRig = createVehicleRig(config);
  const directRig = createVehicleRig(config, { vehiclePhysicsMode: 'legacy' });
  try {
    check(dispatchRig.vehicle.vehiclePhysicsMode === 'legacy', `${config.id} default mode changed`);
    check(dispatchRig.vehicle.vehicleV24 === null, `${config.id} default legacy constructed v2.4`);
    check(directRig.vehicle.vehicleV24 === null, `${config.id} explicit legacy constructed v2.4`);

    for (let tick = 0; tick < 720; tick += 1) {
      const input = deterministicInput(tick);
      if (input.reset) {
        dispatchRig.vehicle.reset(dispatchRig.vehicle.safeSample);
        directRig.vehicle.reset(directRig.vehicle.safeSample);
      }
      dispatchRig.vehicle.fixedUpdate(input, false, FIXED_DT);
      directRig.vehicle.fixedUpdateLegacy(input, false, FIXED_DT);
      dispatchRig.world.step();
      directRig.world.step();
      dispatchRig.vehicle.afterPhysics();
      directRig.vehicle.afterPhysics();
      assert.deepEqual(
        captureVehicle(dispatchRig.vehicle),
        captureVehicle(directRig.vehicle),
        `${config.id} legacy dispatcher diverged at tick ${tick}`,
      );
    }
    checks += 1;
    check(dispatchRig.vehicle.getVehiclePhysicsReport() === null, `${config.id} legacy emitted a v2.4 report`);
  } finally {
    destroyVehicleRig(dispatchRig);
    destroyVehicleRig(directRig);
  }
}

console.log(`vehicle-v24 legacy isolation: PASS (${checks} checks)`);
