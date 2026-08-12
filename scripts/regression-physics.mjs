import assert from 'node:assert/strict';
import { CARS, FIXED_DT } from '../src/config.js';
import {
  AIR_DENSITY,
  GRAVITY,
  aerodynamicDragScale,
  drivetrainEfficiency,
  roadWheelRpm,
  torqueCurveFactor,
} from '../src/vehicle-physics.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

const nearlyEqual = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

function testSharedModel() {
  const sample = CARS[0];
  nearlyEqual(torqueCurveFactor(sample, sample.idle), 0.56);
  nearlyEqual(torqueCurveFactor(sample, sample.peakRpm), 1);
  nearlyEqual(torqueCurveFactor(sample, sample.redline), 0.74);
  assert.equal(torqueCurveFactor(sample, sample.redline * 1.018), 0);
  assert.equal(drivetrainEfficiency('AWD'), 0.82);
  assert.equal(drivetrainEfficiency('RWD'), 0.88);
  nearlyEqual(roadWheelRpm(-20, sample.wheelRadius), roadWheelRpm(20, sample.wheelRadius));

  const speed = 25;
  const scale = aerodynamicDragScale(sample.cdA, speed * speed);
  const forceMagnitude = Math.abs(scale) * speed;
  nearlyEqual(forceMagnitude, 0.5 * AIR_DENSITY * sample.cdA * speed * speed);
  assert.equal(aerodynamicDragScale(sample.cdA, 0), 0);
}

function accelerateTo(rig, targetKmh, maximumSeconds, throttle = 1) {
  const input = zeroInput({ throttle, driveIntent: 1 });
  const maximumSteps = Math.round(maximumSeconds / FIXED_DT);
  for (let index = 0; index < maximumSteps; index += 1) {
    stepVehicle(rig, input);
    if (rig.vehicle.telemetry.speedKmh >= targetKmh) {
      return { reached: true, elapsed: (index + 1) * FIXED_DT };
    }
  }
  return { reached: false, elapsed: maximumSeconds };
}

function measureStraightLinePerformance(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const fullThrottle = zeroInput({ throttle: 1, driveIntent: 1 });
    let zeroToTwenty = null;
    let zeroToHundred = null;
    let minimumLaunchRpm = Infinity;
    let peakSpeed = 0;
    runFor(rig, 60, fullThrottle, ({ elapsed, vehicle }) => {
      const speed = vehicle.telemetry.speedKmh;
      peakSpeed = Math.max(peakSpeed, speed);
      if (elapsed >= 0.25 && speed < 20) {
        minimumLaunchRpm = Math.min(minimumLaunchRpm, vehicle.telemetry.rpm);
      }
      if (zeroToTwenty === null && speed >= 20) zeroToTwenty = elapsed;
      if (zeroToHundred === null && speed >= 100) zeroToHundred = elapsed;
    });
    // `speed` is the existing gameplay calibration target shown in the garage,
    // not a claim of engineering-grade reproduction. A broad envelope catches
    // hidden resistance or runaway power without overfitting the simcade tune.
    const targetRatio = peakSpeed / config.speed;
    const minimumLaunchBandRpm = config.idle + (config.redline - config.idle) * 0.15;
    const maximumLaunchBandRpm = config.idle + (config.redline - config.idle) * 0.35;
    const passed = zeroToTwenty !== null
      && zeroToTwenty > 1
      && zeroToTwenty < 2.5
      && minimumLaunchRpm > minimumLaunchBandRpm
      && minimumLaunchRpm < maximumLaunchBandRpm
      && zeroToHundred !== null
      && zeroToHundred > 3
      && zeroToHundred < 15
      && targetRatio > 0.88
      && targetRatio < 1.15;
    return { passed, zeroToTwenty, zeroToHundred, minimumLaunchRpm, peakSpeed, targetRatio };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureBraking(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 100, 30);
    const startSpeed = rig.vehicle.telemetry.speedKmh;
    const start = rig.vehicle.body.translation();
    let minimumSpeed = Math.abs(rig.vehicle.telemetry.signedSpeedKmh);
    let elapsed = 0;
    const brake = zeroInput({ brake: 1, driveIntent: -1 });
    const maximumSteps = Math.round(6 / FIXED_DT);
    for (let index = 0; index < maximumSteps && minimumSpeed > 1; index += 1) {
      stepVehicle(rig, brake);
      elapsed = (index + 1) * FIXED_DT;
      if (!rig.vehicle.reverse) {
        minimumSpeed = Math.min(minimumSpeed, Math.abs(rig.vehicle.telemetry.signedSpeedKmh));
      }
    }
    const end = rig.vehicle.body.translation();
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const idealTireLimitedDistance = (startSpeed / 3.6) ** 2 / (2 * GRAVITY * config.tire.mu);
    const passed = acceleration.reached
      && minimumSpeed < 1.2
      && elapsed > 1.5
      && elapsed < 5.5
      && distance > idealTireLimitedDistance * 0.65
      && distance < idealTireLimitedDistance * 1.9
      && !rig.vehicle.reverse;
    return { passed, startSpeed, minimumSpeed, elapsed, distance, idealTireLimitedDistance };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureConstantRadius(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 65, 20, 0.6);
    const circleInput = zeroInput({ throttle: 0.18, steer: 0.28, driveIntent: 1 });
    const totalSteps = Math.round(4 / FIXED_DT);
    const sampleStart = Math.round(3 / FIXED_DT);
    let lateralGTotal = 0;
    let speedTotal = 0;
    let yawRateTotal = 0;
    let samples = 0;
    for (let index = 0; index < totalSteps; index += 1) {
      stepVehicle(rig, circleInput);
      if (index < sampleStart) continue;
      lateralGTotal += Math.abs(rig.vehicle.telemetry.lateralAcceleration) / GRAVITY;
      speedTotal += rig.vehicle.telemetry.speedKmh;
      yawRateTotal += Math.abs(rig.vehicle.body.angvel().y);
      samples += 1;
    }
    const lateralG = lateralGTotal / samples;
    const speedKmh = speedTotal / samples;
    const yawRate = yawRateTotal / samples;
    const radius = speedKmh / 3.6 / yawRate;
    const passed = acceleration.reached
      && Number.isFinite(radius)
      && lateralG > 0.38
      && lateralG < config.tire.mu * 1.05
      && speedKmh > 30
      && speedKmh < 95
      && yawRate > 0.2
      && yawRate < 0.75
      && radius > 15
      && radius < 90;
    return { passed, lateralG, speedKmh, yawRate, radius };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureSteeringStepAndSlalom(config) {
  const stepRig = createVehicleRig(config);
  let stepResult;
  try {
    settleVehicle(stepRig);
    const acceleration = accelerateTo(stepRig, 65, 20, 0.6);
    const steeringStep = zeroInput({ throttle: 0.18, steer: 0.28, driveIntent: 1 });
    let responseTime = null;
    let peakYawRate = 0;
    let peakLateralG = 0;
    runFor(stepRig, 1.5, steeringStep, ({ elapsed, vehicle }) => {
      const yawRate = vehicle.body.angvel().y;
      if (responseTime === null && yawRate > 0.1) responseTime = elapsed;
      peakYawRate = Math.max(peakYawRate, yawRate);
      peakLateralG = Math.max(peakLateralG, Math.abs(vehicle.telemetry.lateralAcceleration) / GRAVITY);
    });
    stepResult = {
      passed: acceleration.reached
        && responseTime !== null
        && responseTime > 0.03
        && responseTime < 0.35
        && peakYawRate > 0.35
        && peakYawRate < 0.9
        && peakLateralG > 0.55
        && peakLateralG < config.tire.mu * 1.35
        && stepRig.vehicle.telemetry.speedKmh > 40,
      responseTime,
      peakYawRate,
      peakLateralG,
    };
  } finally {
    destroyVehicleRig(stepRig);
  }

  const slalomRig = createVehicleRig(config);
  try {
    settleVehicle(slalomRig);
    const acceleration = accelerateTo(slalomRig, 65, 20, 0.6);
    const slalomInput = zeroInput({ throttle: 0.2, driveIntent: 1 });
    const duration = 8;
    const period = 1.6;
    const steps = Math.round(duration / FIXED_DT);
    let previousYawSign = 0;
    let yawReversals = 0;
    let peakLateralG = 0;
    let minimumSpeed = Infinity;
    let maximumSpeed = 0;
    let minimumX = Infinity;
    let maximumX = -Infinity;
    for (let index = 0; index < steps; index += 1) {
      const elapsed = index * FIXED_DT;
      slalomInput.steer = 0.36 * Math.sin(2 * Math.PI * elapsed / period);
      stepVehicle(slalomRig, slalomInput);
      const yawRate = slalomRig.vehicle.body.angvel().y;
      const yawSign = Math.abs(yawRate) > 0.08 ? Math.sign(yawRate) : 0;
      if (yawSign && previousYawSign && yawSign !== previousYawSign) yawReversals += 1;
      if (yawSign) previousYawSign = yawSign;
      peakLateralG = Math.max(
        peakLateralG,
        Math.abs(slalomRig.vehicle.telemetry.lateralAcceleration) / GRAVITY,
      );
      minimumSpeed = Math.min(minimumSpeed, slalomRig.vehicle.telemetry.speedKmh);
      maximumSpeed = Math.max(maximumSpeed, slalomRig.vehicle.telemetry.speedKmh);
      const positionX = slalomRig.vehicle.body.translation().x;
      minimumX = Math.min(minimumX, positionX);
      maximumX = Math.max(maximumX, positionX);
    }
    const lateralSpan = maximumX - minimumX;
    const slalomResult = {
      passed: acceleration.reached
        && yawReversals >= 8
        && yawReversals <= 11
        && peakLateralG > 0.6
        && peakLateralG < config.tire.mu * 1.5
        && minimumSpeed > 40
        && maximumSpeed < 90
        && lateralSpan > 10
        && lateralSpan < 50
        && slalomRig.vehicle.body.translation().y > 0.45,
      yawReversals,
      peakLateralG,
      minimumSpeed,
      maximumSpeed,
      lateralSpan,
    };
    return { step: stepResult, slalom: slalomResult };
  } finally {
    destroyVehicleRig(slalomRig);
  }
}

function measureLiftOffStability(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 75, 20, 0.6);
    const steadyTurn = zeroInput({ throttle: 0.2, steer: 0.18, driveIntent: 1 });
    let baselineYawRateTotal = 0;
    let baselineSamples = 0;
    runFor(rig, 2, steadyTurn, ({ elapsed, vehicle }) => {
      if (elapsed < 1.5) return;
      baselineYawRateTotal += Math.abs(vehicle.body.angvel().y);
      baselineSamples += 1;
    });
    const baselineYawRate = baselineYawRateTotal / baselineSamples;
    const startSpeed = rig.vehicle.telemetry.speedKmh;
    const liftOff = zeroInput({ steer: 0.18 });
    let peakYawRate = 0;
    let wrongWayYaw = false;
    runFor(rig, 2, liftOff, ({ vehicle }) => {
      const yawRate = vehicle.body.angvel().y;
      peakYawRate = Math.max(peakYawRate, Math.abs(yawRate));
      wrongWayYaw ||= yawRate < -0.03;
    });
    const endSpeed = rig.vehicle.telemetry.speedKmh;
    const rotation = rig.vehicle.body.rotation();
    const passed = acceleration.reached
      && baselineYawRate > 0.2
      && peakYawRate < baselineYawRate * 1.45
      && !wrongWayYaw
      && startSpeed - endSpeed > 4
      && startSpeed - endSpeed < 20
      && Math.abs(rotation.x) < 0.45
      && Math.abs(rotation.z) < 0.45
      && rig.vehicle.body.translation().y > 0.45;
    return { passed, baselineYawRate, peakYawRate, startSpeed, endSpeed };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureHandbrakeEvent(config, handbrake) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 65, 20, 0.6);
    runFor(rig, 0.8, zeroInput({ throttle: 0.16, steer: 0.22, driveIntent: 1 }));
    let peakYawRate = 0;
    let peakLateralG = 0;
    runFor(
      rig,
      0.7,
      zeroInput({ throttle: 0.05, steer: 0.22, handbrake, driveIntent: 1 }),
      ({ vehicle }) => {
        peakYawRate = Math.max(peakYawRate, Math.abs(vehicle.body.angvel().y));
        peakLateralG = Math.max(
          peakLateralG,
          Math.abs(vehicle.telemetry.lateralAcceleration) / GRAVITY,
        );
      },
    );
    const eventSpeed = rig.vehicle.telemetry.speedKmh;
    runFor(rig, 4, zeroInput({ throttle: 0.25, driveIntent: 1 }));
    return {
      acceleration,
      peakYawRate,
      peakLateralG,
      eventSpeed,
      recoveredYawRate: Math.abs(rig.vehicle.body.angvel().y),
      recoveredSpeed: rig.vehicle.telemetry.speedKmh,
      rideHeight: rig.vehicle.body.translation().y,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureHandbrakeRecovery(config) {
  const control = measureHandbrakeEvent(config, 0);
  const handbrake = measureHandbrakeEvent(config, 1);
  const yawGain = handbrake.peakYawRate / control.peakYawRate;
  const passed = control.acceleration.reached
    && handbrake.acceleration.reached
    && yawGain > 1.15
    && yawGain < 2.2
    && handbrake.peakYawRate < 1
    && handbrake.peakLateralG < config.tire.mu * 1.3
    && handbrake.eventSpeed > 35
    && handbrake.recoveredYawRate < 0.08
    && handbrake.recoveredSpeed > 35
    && handbrake.rideHeight > 0.45;
  return { passed, control, handbrake, yawGain };
}

testSharedModel();
let failed = false;
for (const config of CARS) {
  const straightLine = measureStraightLinePerformance(config);
  const braking = measureBraking(config);
  const circle = measureConstantRadius(config);
  const passed = straightLine.passed && braking.passed && circle.passed;
  failed ||= !passed;
  console.log(
    `${passed ? 'PASS' : 'FAIL'} ${config.name.padEnd(22)} `
    + `0-20 ${straightLine.zeroToTwenty?.toFixed(2) ?? '--'}s `
    + `0-100 ${straightLine.zeroToHundred?.toFixed(2) ?? '--'}s `
    + `launch ${Math.round(straightLine.minimumLaunchRpm)}rpm `
    + `60s ${straightLine.peakSpeed.toFixed(0)}/${config.speed}km/h  `
    + `brake ${braking.startSpeed.toFixed(1)}→${braking.minimumSpeed.toFixed(1)}km/h `
    + `${braking.distance.toFixed(1)}m/${braking.elapsed.toFixed(2)}s  `
    + `circle ${circle.speedKmh.toFixed(1)}km/h ${circle.lateralG.toFixed(2)}g `
    + `${circle.radius.toFixed(0)}m radius`,
  );
}

const mx5 = CARS.find((config) => config.id === 'mx5');
const steering = measureSteeringStepAndSlalom(mx5);
const liftOff = measureLiftOffStability(mx5);
const handbrake = measureHandbrakeRecovery(mx5);
const handlingPassed = steering.step.passed
  && steering.slalom.passed
  && liftOff.passed
  && handbrake.passed;
failed ||= !handlingPassed;
console.log(
  `${handlingPassed ? 'PASS' : 'FAIL'} ${mx5.name.padEnd(22)} handling  `
  + `step ${(steering.step.responseTime * 1000).toFixed(0)}ms/${steering.step.peakYawRate.toFixed(2)}rad/s  `
  + `slalom ${steering.slalom.yawReversals} reversals/${steering.slalom.peakLateralG.toFixed(2)}g/`
  + `${steering.slalom.minimumSpeed.toFixed(0)}–${steering.slalom.maximumSpeed.toFixed(0)}km/h  `
  + `lift yaw ×${(liftOff.peakYawRate / liftOff.baselineYawRate).toFixed(2)}  `
  + `handbrake yaw ×${handbrake.yawGain.toFixed(2)} `
  + `recover ${handbrake.handbrake.recoveredYawRate.toFixed(3)}rad/s`,
);

if (failed) process.exitCode = 1;
