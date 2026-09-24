import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, FIXED_DT } from '../src/config.js';
import { resolveDriveIntent, updatePedal } from '../src/input.js';
import { initializeRapier } from '../src/rapier-init.js';
import { VehicleSystem } from '../src/vehicle.js';

await initializeRapier(RAPIER);

class FlatTrack {
  constructor() {
    this.config = { width: 14 };
    this.samples = Array.from({ length: 1024 }, (_, index) => ({
      point: new THREE.Vector3(0, 0, index * 2),
      index,
    }));
  }
  getResetPose(index = 0) {
    return { position: new THREE.Vector3(0, 0.8, index * 2), yaw: 0, sampleIndex: index };
  }
  getSurface(position) {
    return { id: 'asphalt', grip: 1, rolling: 1, info: this.nearestInfo(position) };
  }
  nearestInfo(position) {
    const index = Math.max(0, Math.min(1023, Math.round(position.z / 2)));
    return { index, offset: position.x, point: this.samples[index].point, surface: 'asphalt' };
  }
}

const zeroInput = () => ({
  steer: 0, throttle: 0, brake: 0, handbrake: 0,
  shiftUp: false, shiftDown: false, toggleTransmission: false, reset: false,
});

function yawOf(rotation) {
  return Math.atan2(
    2 * (rotation.w * rotation.y + rotation.x * rotation.z),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
  );
}

function signedBodySpeedKmh(vehicle) {
  const rotation = vehicle.body.rotation();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(
    rotation.x,
    rotation.y,
    rotation.z,
    rotation.w,
  ));
  forward.y = 0;
  forward.normalize();
  const velocity = vehicle.body.linvel();
  return (velocity.x * forward.x + velocity.y * forward.y + velocity.z * forward.z) * 3.6;
}

function runSteps(vehicle, world, seconds, patch = {}, onStep) {
  const input = { ...zeroInput(), ...patch };
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i += 1) {
    vehicle.fixedUpdate(input, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
    onStep?.();
  }
}

let failed = false;
for (const config of CARS) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.integrationParameters.dt = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(80, 0.3, 2200).setFriction(0.2), ground);
  const scene = new THREE.Scene();
  const visual = new THREE.Group();
  visual.userData.wheelNodes = [];
  let automaticResetReason = null;
  const vehicle = new VehicleSystem({
    RAPIER,
    world,
    scene,
    track: new FlatTrack(),
    config,
    visual,
    onAutomaticReset: (reason) => {
      automaticResetReason = reason;
    },
  });

  runSteps(vehicle, world, 2);
  const restStart = vehicle.body.translation();
  let minimumRideHeight = Infinity;
  let maximumRideHeight = -Infinity;
  const restInput = zeroInput();
  for (let i = 0; i < Math.round(10 / FIXED_DT); i += 1) {
    vehicle.fixedUpdate(restInput, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
    const rideHeight = vehicle.body.translation().y;
    minimumRideHeight = Math.min(minimumRideHeight, rideHeight);
    maximumRideHeight = Math.max(maximumRideHeight, rideHeight);
  }
  const restEnd = vehicle.body.translation();
  const drift = Math.hypot(restEnd.x - restStart.x, restEnd.z - restStart.z);
  const heave = maximumRideHeight - minimumRideHeight;
  let maximumLaunchHeight = -Infinity;
  let maximumGear = 1;
  let maximumRpm = config.idle;
  runSteps(vehicle, world, 8, { throttle: 1 }, () => {
    maximumLaunchHeight = Math.max(maximumLaunchHeight, vehicle.body.translation().y);
    maximumGear = Math.max(maximumGear, vehicle.telemetry.gear);
    maximumRpm = Math.max(maximumRpm, vehicle.telemetry.rpm);
  });
  const launchLift = maximumLaunchHeight - restEnd.y;
  const forwardSpeed = vehicle.telemetry.signedSpeedKmh;
  let stoppedSpeed = Math.abs(forwardSpeed);
  const filteredInput = { throttle: 1, brake: 0 };
  const stepRawPedals = (rawThrottle, rawBrake) => {
    filteredInput.throttle = updatePedal(filteredInput.throttle, rawThrottle, 4.3, 7.5, FIXED_DT);
    filteredInput.brake = updatePedal(filteredInput.brake, rawBrake, 7.5, 11, FIXED_DT);
    const frame = {
      ...zeroInput(),
      throttle: filteredInput.throttle,
      brake: filteredInput.brake,
      driveIntent: resolveDriveIntent(rawThrottle, rawBrake),
    };
    vehicle.fixedUpdate(frame, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
  };
  for (let i = 0; i < Math.round(6 / FIXED_DT); i += 1) {
    if (!vehicle.reverse) stoppedSpeed = Math.min(stoppedSpeed, Math.abs(signedBodySpeedKmh(vehicle)));
    stepRawPedals(0, 1);
    if (vehicle.telemetry.reverse) break;
  }
  for (let i = 0; i < Math.round(2 / FIXED_DT); i += 1) {
    if (!vehicle.reverse) stoppedSpeed = Math.min(stoppedSpeed, Math.abs(signedBodySpeedKmh(vehicle)));
    stepRawPedals(0, 1);
  }
  const reverseSpeed = vehicle.telemetry.signedSpeedKmh;
  for (let i = 0; i < Math.round(4 / FIXED_DT); i += 1) stepRawPedals(1, 0);
  const forwardRecoverySpeed = vehicle.telemetry.signedSpeedKmh;
  const recoveredForward = !vehicle.telemetry.reverse && forwardRecoverySpeed > 3;
  vehicle.reset(0);
  runSteps(vehicle, world, 5, { throttle: 0.68 });
  const yawStart = yawOf(vehicle.body.rotation());
  let peakLateralAcceleration = 0;
  runSteps(vehicle, world, 0.8, { throttle: 0.18, steer: 0.38 }, () => {
    peakLateralAcceleration = Math.max(peakLateralAcceleration, Math.abs(vehicle.telemetry.lateralAcceleration));
  });
  const yawChange = Math.abs(yawOf(vehicle.body.rotation()) - yawStart);
  vehicle.body.setTranslation({ x: 0, y: -5, z: 0 }, true);
  vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
  const automaticRecoveryPassed = automaticResetReason === 'fell-below-world'
    && vehicle.body.translation().y > 0;
  const finite = [drift, heave, launchLift, yawChange, peakLateralAcceleration, forwardSpeed, stoppedSpeed, reverseSpeed, forwardRecoverySpeed, maximumRpm, vehicle.body.translation().y].every(Number.isFinite);
  const passed = finite && drift < 0.05 && heave < 0.035 && launchLift < 0.18
    && yawChange > 0.08 && peakLateralAcceleration > 2.2
    && forwardSpeed > 20 && stoppedSpeed < 1.5 && reverseSpeed < -2 && reverseSpeed > -46
    && recoveredForward && automaticRecoveryPassed
    && maximumGear >= 2 && maximumRpm <= config.redline * 1.04;
  failed ||= !passed;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${config.name.padEnd(22)} heave=${heave.toFixed(3)}m lift=${launchLift.toFixed(3)}m turn=${yawChange.toFixed(2)}rad forward=${forwardSpeed.toFixed(1)}km/h stop=${stoppedSpeed.toFixed(1)}km/h gear=${maximumGear} rpm=${maximumRpm.toFixed(0)} reverse=${reverseSpeed.toFixed(1)}km/h recover=${forwardRecoverySpeed.toFixed(1)}km/h`);
  vehicle.destroy();
  world.free();
}

if (failed) process.exitCode = 1;
