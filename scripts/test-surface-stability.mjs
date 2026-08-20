import assert from 'node:assert/strict';
import { CARS, FIXED_DT, SURFACES } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  settleVehicle,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

function accelerateTo(rig, targetKmh) {
  const input = zeroInput({ throttle: 0.65, driveIntent: 1 });
  for (let step = 0; step < Math.round(20 / FIXED_DT); step += 1) {
    stepVehicle(rig, input);
    if (rig.vehicle.telemetry.speedKmh >= targetKmh) return;
  }
  throw new Error(`failed to reach ${targetKmh} km/h`);
}

function measureTurn(config, surfaceId) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    accelerateTo(rig, 65);
    const baseNearestInfo = rig.vehicle.track.nearestInfo.bind(rig.vehicle.track);
    rig.vehicle.track.getSurface = (position) => ({
      id: surfaceId,
      ...SURFACES[surfaceId],
      info: { ...baseNearestInfo(position), surface: surfaceId },
    });

    const input = zeroInput({ throttle: 0.18, steer: 0.24, driveIntent: 1 });
    const totalSteps = Math.round(2.5 / FIXED_DT);
    const sampleStart = Math.round(2 / FIXED_DT);
    let yawRateTotal = 0;
    let lateralGTotal = 0;
    let samples = 0;
    for (let step = 0; step < totalSteps; step += 1) {
      stepVehicle(rig, input);
      if (step < sampleStart) continue;
      yawRateTotal += Math.abs(rig.vehicle.body.angvel().y);
      lateralGTotal += Math.abs(rig.vehicle.telemetry.lateralAcceleration) / 9.81;
      samples += 1;
    }
    return {
      yawRate: yawRateTotal / samples,
      lateralG: lateralGTotal / samples,
      speedKmh: rig.vehicle.telemetry.speedKmh,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

const mx5 = CARS.find((config) => config.id === 'mx5');
const asphalt = measureTurn(mx5, 'asphalt');
const gravel = measureTurn(mx5, 'gravel');
const grass = measureTurn(mx5, 'grass');

assert.ok(asphalt.yawRate > 0.3, 'asphalt reference turn must be established');
for (const [surfaceId, result] of [['asphalt', asphalt], ['gravel', gravel], ['grass', grass]]) {
  const availableLateralG = mx5.tire.mu * SURFACES[surfaceId].grip;
  assert.ok(
    result.lateralG <= availableLateralG * 1.05,
    `${surfaceId} lateral ${result.lateralG.toFixed(3)}g exceeded `
      + `${availableLateralG.toFixed(3)}g friction budget`,
  );
}

console.log(
  'PASS surface-limited stability',
  `asphalt=${asphalt.yawRate.toFixed(3)}rad/s ${asphalt.lateralG.toFixed(2)}g`,
  `gravel=${gravel.yawRate.toFixed(3)}rad/s ${gravel.lateralG.toFixed(2)}g`,
  `grass=${grass.yawRate.toFixed(3)}rad/s ${grass.lateralG.toFixed(2)}g`,
);
