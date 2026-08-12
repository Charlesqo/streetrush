import { CARS } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  zeroInput,
} from './physics-harness.mjs';

const TEST_DURATION_SECONDS = 60;

function simulateProductionVehicle(config) {
  const rig = createVehicleRig(config);
  settleVehicle(rig);
  const start = rig.vehicle.body.translation();
  let zeroToHundred = null;
  let zeroToTwoHundred = null;
  let peakSpeed = 0;
  const fullThrottle = zeroInput({ throttle: 1, driveIntent: 1 });

  runFor(rig, TEST_DURATION_SECONDS, fullThrottle, ({ elapsed, vehicle }) => {
    const speed = vehicle.telemetry.speedKmh;
    peakSpeed = Math.max(peakSpeed, speed);
    if (zeroToHundred === null && speed >= 100) zeroToHundred = elapsed;
    if (zeroToTwoHundred === null && speed >= 200) zeroToTwoHundred = elapsed;
  });

  const end = rig.vehicle.body.translation();
  const result = {
    zeroToHundred,
    zeroToTwoHundred,
    speedAtEnd: rig.vehicle.telemetry.speedKmh,
    peakSpeed,
    distance: Math.hypot(end.x - start.x, end.z - start.z),
    rpm: rig.vehicle.telemetry.rpm,
    gear: rig.vehicle.telemetry.gear,
  };
  destroyVehicleRig(rig);
  return result;
}

const formatTime = (value) => value === null ? '--' : `${value.toFixed(2)}s`;

console.log('Production VehicleSystem / flat asphalt / AT / full throttle');
for (const config of CARS) {
  const result = simulateProductionVehicle(config);
  console.log(
    `${config.name.padEnd(22)} `
    + `0-100 ${formatTime(result.zeroToHundred).padStart(7)}  `
    + `0-200 ${formatTime(result.zeroToTwoHundred).padStart(7)}  `
    + `60s ${result.speedAtEnd.toFixed(0).padStart(3)}km/h  `
    + `peak ${result.peakSpeed.toFixed(0).padStart(3)}km/h  `
    + `G${result.gear} ${Math.round(result.rpm)}rpm  `
    + `${(result.distance / 1000).toFixed(2)}km`,
  );
}
