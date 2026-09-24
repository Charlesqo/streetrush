import nodeAssert from 'node:assert/strict';
import * as THREE from 'three';

import { CARS, FIXED_DT } from '../src/config.js';
import { ChaseCamera } from '../src/effects.js';
import {
  CLUTCH_ACTIVE_SET,
  createEngineState,
  createGearboxState,
  evaluateBrakeAssists,
  prepareDriverGearboxTrial,
  prepareEngineClutchTrial,
} from '../src/vehicle-v24/powertrain.js';
import {
  createSuspensionState,
  solveMappedKcSuspension,
} from '../src/vehicle-v24/suspension.js';
import {
  createSteeringState,
  prepareSteeringTrial,
} from '../src/vehicle-v24/steering.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

const mx5 = CARS.find((car) => car.id === 'mx5');
let checks = 0;
const assert = {
  ok: (...args) => { nodeAssert.ok(...args); checks += 1; },
  equal: (...args) => { nodeAssert.equal(...args); checks += 1; },
  deepEqual: (...args) => { nodeAssert.deepEqual(...args); checks += 1; },
};

const closeEnough = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
};

function bodyObservation(rig, wallCollider = null) {
  const body = rig.vehicle.body;
  const q = body.rotation();
  const v = body.linvel();
  const forward = {
    x: 2 * (q.x * q.z + q.w * q.y),
    y: 2 * (q.y * q.z - q.w * q.x),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
  let wallContacts = 0;
  let wallNormal = null;
  if (wallCollider) {
    rig.world.contactPair(rig.vehicle.collider, wallCollider, (manifold) => {
      wallContacts += manifold.numContacts();
      if (!wallNormal && manifold.numContacts() > 0) {
        const normal = manifold.normal();
        wallNormal = { x: normal.x, y: normal.y, z: normal.z };
      }
    });
  }
  const translation = body.translation();
  return {
    position: { x: translation.x, y: translation.y, z: translation.z },
    velocity: { x: v.x, y: v.y, z: v.z },
    signedBodySpeed: v.x * forward.x + v.y * forward.y + v.z * forward.z,
    wallContacts,
    wallNormal,
    telemetry: {
      signedSpeedKmh: rig.vehicle.telemetry.signedSpeedKmh,
      speedKmh: rig.vehicle.telemetry.speedKmh,
      reverse: rig.vehicle.reverse,
    },
  };
}

function runPhase(rig, seconds, input, wallCollider = null, phase = 'phase') {
  const rows = [];
  const steps = Math.round(seconds / FIXED_DT);
  for (let index = 0; index < steps; index += 1) {
    try {
      stepVehicle(rig, input);
    } catch (error) {
      error.phase = phase;
      error.step = index;
      error.observation = bodyObservation(rig, wallCollider);
      throw error;
    }
    rows.push({ index, ...bodyObservation(rig, wallCollider) });
  }
  return rows;
}

const report = {
  schema: 'streetrush.vehicle-v24.playability-probe.v1',
  fixedHz: Math.round(1 / FIXED_DT),
};

// 1. Steering authority and handedness at low, medium, and high speed.
{
  const rows = [];
  for (const speed of [2, 16, 40]) {
    for (const command of [-1, 1]) {
      let state = createSteeringState();
      let trial = null;
      for (let index = 0; index < 90; index += 1) {
        trial = prepareSteeringTrial({
          state,
          streetRushCommand: command,
          speed,
          dt: FIXED_DT,
          maximumAngle: mx5.steer,
          wheelbase: mx5.wheelbase,
          trackWidth: mx5.trackWidth,
        });
        state = trial.nextState;
      }
      assert.ok(trial.streetRushVirtualAngle * command > 0, 'driver-left must produce positive host yaw');
      assert.ok(trial.oracleWheelAngles.left * command < 0, 'driver command must use the oracle-to-host handedness seam');
      rows.push({
        speedMps: speed,
        command,
        streetRushVirtualAngle: trial.streetRushVirtualAngle,
        oracleWheelAngles: trial.oracleWheelAngles,
        streetRushWheelAngles: trial.streetRushWheelAngles,
        speedAuthority: trial.speedAuthority,
      });
    }
  }
  const positive = rows.filter((row) => row.command === 1);
  assert.ok(
    Math.abs(positive[0].streetRushVirtualAngle)
      > Math.abs(positive[1].streetRushVirtualAngle)
      && Math.abs(positive[1].streetRushVirtualAngle)
      > Math.abs(positive[2].streetRushVirtualAngle),
    'steering speed authority is not progressive',
  );
  assert.ok(Math.abs(positive[0].streetRushVirtualAngle) > 0.35, 'low-speed steering is too weak');
  assert.ok(Math.abs(positive[1].streetRushVirtualAngle) > 0.16, 'medium-speed steering is too weak');
  assert.ok(Math.abs(positive[2].streetRushVirtualAngle) > 0.07, 'high-speed steering is near zero');
  report.steering = rows;

  // Reach each speed through normal drive torque, then measure displacement along
  // the production chase camera's screen-right axis. The legacy body axis named
  // "right" (+X) points SCREEN LEFT when the camera looks along +Z with +Y up.
  // No velocity/pose/omega injection.
  report.physicalSteering = [];
  for (const speed of [2, 16, 40]) {
    for (const command of [-1, 1]) {
      const rig = createVehicleRig(mx5, { vehiclePhysicsMode: 'v24-active' });
      const resets = [];
      rig.vehicle.onAutomaticReset = (reason) => resets.push(reason);
      try {
        const drive = zeroInput({ throttle: 1, driveIntent: 1 });
        let accelerationSteps = 0;
        while (bodyObservation(rig).signedBodySpeed < speed && accelerationSteps < 45 / FIXED_DT) {
          stepVehicle(rig, drive);
          accelerationSteps += 1;
        }
        const start = bodyObservation(rig);
        assert.ok(start.signedBodySpeed >= speed, `normal launch did not reach ${speed} m/s`);
        const q = rig.vehicle.body.rotation();
        const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1300);
        new ChaseCamera(camera).snap(
          new THREE.Vector3(start.position.x, start.position.y, start.position.z),
          new THREE.Quaternion(q.x, q.y, q.z, q.w),
        );
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        let minimumGrounded = 4;
        runFor(rig, 0.5, { ...drive, steer: command }, () => {
          minimumGrounded = Math.min(minimumGrounded, rig.vehicle.telemetry.wheels.filter((wheel) => wheel.grounded).length);
        });
        const end = bodyObservation(rig);
        const lateralTravel = (end.position.x - start.position.x) * right.x
          + (end.position.y - start.position.y) * right.y
          + (end.position.z - start.position.z) * right.z;
        assert.ok(lateralTravel * command < -0.05, `driver-view steering direction/authority failed at ${speed} m/s: screen-right travel=${lateralTravel}, command=${command}`);
        assert.ok(minimumGrounded >= 3, `steering unloaded the car at ${speed} m/s`);
        assert.deepEqual(resets, [], 'steering must not be rescued by an automatic reset');
        report.physicalSteering.push({
          speedMps: speed, command, accelerationSeconds: accelerationSteps * FIXED_DT,
          reachedSpeedMps: start.signedBodySpeed, lateralTravel, minimumGrounded,
          lateralBasis: 'production ChaseCamera.snap screen-right',
          screenRight: right.toArray(),
          steerAngle: rig.vehicle.steerAngle, automaticResets: resets,
        });
      } finally {
        destroyVehicleRig(rig);
      }
    }
  }
}

// 2. A straight-line foot brake must allocate identical left/right axle capacity.
{
  const radius = mx5.wheelRadius;
  const symmetricAssist = evaluateBrakeAssists({
    serviceBrake: 1,
    parkingBrake: 0,
    bodyLongSpeed: 12,
    oracleYawRate: 0,
    steeringCurvature: 0,
    wheelOmega: [12 / radius, 12 / radius, 12 / radius, 12 / radius],
    effectiveRadii: [radius, radius, radius, radius],
    drivenWheels: [false, false, true, true],
    groundedCount: 4,
    steerCommand: 0,
    config: mx5,
  });
  for (const values of [
    symmetricAssist.driverServiceCapacity,
    symmetricAssist.serviceRequestCapacity,
    symmetricAssist.serviceCapacity,
    symmetricAssist.totalBrakeCapacity,
  ]) {
    closeEnough(values[0], values[1], 1e-9, 'front foot-brake request is asymmetric');
    closeEnough(values[2], values[3], 1e-9, 'rear foot-brake request is asymmetric');
  }
  const rig = createVehicleRig(mx5, { vehiclePhysicsMode: 'v24-active' });
  try {
    settleVehicle(rig, 1);
    runFor(rig, 3, zeroInput({ throttle: 1, driveIntent: 1 }));
    const launchSpeedKmh = rig.vehicle.telemetry.speedKmh;
    const startPosition = { ...rig.vehicle.body.translation() };
    const brakeInput = zeroInput({ brake: 1, driveIntent: -1 });
    let maximumCapacityPairDifference = 0;
    let maximumAppliedPairDifference = 0;
    let maximumYawRate = 0;
    let maximumRollRate = 0;
    let escActive = false;
    let first = null;
    for (let index = 0; index < 48; index += 1) {
      stepVehicle(rig, brakeInput);
      const current = rig.vehicle.getVehiclePhysicsReport();
      const diagnostics = current.solver.brakeDiagnostics;
      const angularVelocity = rig.vehicle.body.angvel();
      maximumYawRate = Math.max(maximumYawRate, Math.abs(angularVelocity.y));
      maximumRollRate = Math.max(maximumRollRate, Math.abs(angularVelocity.z));
      escActive ||= current.output.stabilityActive;
      first ??= diagnostics;
      maximumCapacityPairDifference = Math.max(
        maximumCapacityPairDifference,
        Math.abs(diagnostics[0].serviceCapacity - diagnostics[1].serviceCapacity),
        Math.abs(diagnostics[2].serviceCapacity - diagnostics[3].serviceCapacity),
      );
      maximumAppliedPairDifference = Math.max(
        maximumAppliedPairDifference,
        Math.abs(diagnostics[0].appliedTorque - diagnostics[1].appliedTorque),
        Math.abs(diagnostics[2].appliedTorque - diagnostics[3].appliedTorque),
      );
    }
    assert.ok(maximumCapacityPairDifference <= 10, 'straight-line ABS modulation became grossly asymmetric');
    assert.ok(maximumAppliedPairDifference <= 10, 'straight-line foot-brake torque became grossly asymmetric');
    assert.ok(maximumYawRate < 0.05, 'straight-line foot brake generated persistent yaw');
    assert.ok(Math.abs(rig.vehicle.body.translation().x - startPosition.x) < 0.1, 'straight braking drifted laterally');
    assert.equal(escActive, false, 'straight foot braking must not request one-sided ESC');
    report.footBrake = {
      launchSpeedKmh,
      maximumCapacityPairDifference,
      maximumAppliedPairDifference,
      maximumYawRate,
      maximumRollRate,
      startPosition,
      endPosition: { ...rig.vehicle.body.translation() },
      symmetricAssist: {
        driverServiceCapacity: symmetricAssist.driverServiceCapacity,
        serviceRequestCapacity: symmetricAssist.serviceRequestCapacity,
        serviceCapacity: symmetricAssist.serviceCapacity,
        totalBrakeCapacity: symmetricAssist.totalBrakeCapacity,
      },
      firstDiagnostics: first,
      finalSignedSpeedKmh: rig.vehicle.telemetry.signedSpeedKmh,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

// 3. ESC is explicitly ineligible below its speed authority threshold.
{
  const radius = mx5.wheelRadius;
  const assist = evaluateBrakeAssists({
    serviceBrake: 0,
    parkingBrake: 0,
    bodyLongSpeed: 1,
    oracleYawRate: 0,
    steeringCurvature: 1,
    wheelOmega: [1 / radius, 1 / radius, 1 / radius, 1 / radius],
    effectiveRadii: [radius, radius, radius, radius],
    drivenWheels: [false, false, true, true],
    groundedCount: 4,
    steerCommand: 1,
    config: mx5,
  });
  assert.equal(assist.escEligible, false, 'low-speed ESC became eligible');
  assert.equal(assist.escActive, false, 'low-speed ESC applied a one-sided brake');
  assert.deepEqual(assist.escBrakeCapacity, [0, 0, 0, 0]);
  for (const guard of [
    { groundedCount: 2, steerCommand: 1 },
    { groundedCount: 4, steerCommand: 0 },
  ]) {
    const guarded = evaluateBrakeAssists({
      serviceBrake: 0,
      parkingBrake: 0,
      bodyLongSpeed: 20,
      oracleYawRate: 0,
      steeringCurvature: 0.1,
      wheelOmega: Array(4).fill(20 / radius),
      effectiveRadii: Array(4).fill(radius),
      drivenWheels: [false, false, true, true],
      ...guard,
      config: mx5,
    });
    assert.equal(guarded.escEligible, false, 'ESC requires contact and valid steering authority');
    assert.deepEqual(guarded.escBrakeCapacity, [0, 0, 0, 0]);
  }
  report.lowSpeedEsc = {
    bodyLongSpeedMps: 1,
    desiredYaw: assist.desiredYaw,
    yawError: assist.yawError,
    escSpeedAuthority: assist.escSpeedAuthority,
    escSteerAuthority: assist.escSteerAuthority,
    escEligible: assist.escEligible,
    escBrakeCapacity: assist.escBrakeCapacity,
  };
}

// 4. ARB load increments must oppose roll, not merely look symmetric on flat ground.
{
  const previousState = createSuspensionState(mx5);
  const staticCompression = previousState.corners[0].compression;
  const steeringTrial = { oracleWheelAngles: { left: 0, right: 0 } };
  const withoutArb = { ...mx5, suspension: { ...mx5.suspension, antiRoll: 0 } };
  const rows = [];
  for (const rollSign of [-1, 1]) {
    const contacts = Array.from({ length: 4 }, (_, index) => ({
      inContact: true,
      compression: staticCompression + (index % 2 === 0 ? 1 : -1) * rollSign * 0.01,
      compressionRate: 0,
      gap: 0,
    }));
    const base = solveMappedKcSuspension({ previousState, contacts, steeringTrial, config: withoutArb, dt: FIXED_DT });
    const active = solveMappedKcSuspension({ previousState, contacts, steeringTrial, config: mx5, dt: FIXED_DT });
    const loadDelta = active.corners.map((corner, index) => corner.normalLoad - base.corners[index].normalLoad);
    const rollTorque = loadDelta.reduce((sum, load, index) => (
      sum + (index % 2 === 0 ? -1 : 1) * mx5.trackWidth * 0.5 * load
    ), 0);
    assert.ok(rollTorque * rollSign < 0, 'ARB torque must restore a left/right compression imbalance');
    closeEnough(loadDelta.reduce((sum, load) => sum + load, 0), 0, 1e-9, 'ARB must not add net vertical force');
    rows.push({ rollSign, loadDelta, rollTorque });
  }
  report.antiRoll = rows;
}

// 5. Collision rebound is not a requested gear reversal; clutch zero-speed is an active set.
{
  const rebound = prepareDriverGearboxTrial({
    state: createGearboxState(),
    input: zeroInput({ throttle: 1, driveIntent: 1 }),
    signedSpeed: -8,
    engineRpm: mx5.idle,
    config: mx5,
    dt: FIXED_DT,
  });
  assert.equal(rebound.driveThrottle, 1, 'W in FORWARD must drive through a collision rebound');
  assert.equal(rebound.serviceBrake, 0, 'collision rebound must not turn W into a brake');
  assert.equal(rebound.nextState.direction, 'FORWARD');
  const reverseToForward = prepareDriverGearboxTrial({
    state: { ...createGearboxState(), selectedGear: 'R', direction: 'REVERSE' },
    input: zeroInput({ throttle: 1, driveIntent: 1 }),
    signedSpeed: -8,
    engineRpm: mx5.idle,
    config: mx5,
    dt: FIXED_DT,
  });
  assert.equal(reverseToForward.driveThrottle, 0, 'deliberate reverse-to-forward change still brakes first');
  assert.equal(reverseToForward.serviceBrake, 1);
  const clutch = prepareEngineClutchTrial({
    engineState: { ...createEngineState(mx5), omega: 1 },
    gearboxTrial: { driveThrottle: 0, effectiveGear: '1', averageEngagement: 1 },
    wheelOmega: [-10, -10, -10, -10],
    bodyLongSpeed: -8,
    assists: { enginePositiveTorqueLimit: 1 },
    config: mx5,
    dt: FIXED_DT,
  });
  assert.equal(clutch.engineStopActive, true, 'reverse wheel impulse must activate the engine lower boundary');
  assert.equal(clutch.clutchRegime, CLUTCH_ACTIVE_SET.SLIP_POSITIVE);
  closeEnough(clutch.nextState.omega, 0, 1e-10, 'engine lower-bound solution');
  assert.ok(clutch.residual / clutch.residualScale <= 2e-6, 'clutch boundary must satisfy its own residual');
  report.collisionDirectionAndClutch = {
    reboundDriveThrottle: rebound.driveThrottle,
    reboundServiceBrake: rebound.serviceBrake,
    engineStopActive: clutch.engineStopActive,
    clutchRegime: clutch.clutchRegime,
    engineOmega: clutch.nextState.omega,
    scaledResidual: clutch.residual / clutch.residualScale,
  };
}

// 6. No-input dwell exposes drive intent and actual shaft/wheel torque without creep.
{
  const rig = createVehicleRig(mx5, { vehiclePhysicsMode: 'v24-active' });
  try {
    settleVehicle(rig, 1);
    const startPosition = { ...rig.vehicle.body.translation() };
    let maximumIdleSpeedKmh = 0;
    let maximumIdleTransferNm = 0;
    let unexpectedDriveInput = false;
    for (let index = 0; index < 360; index += 1) {
      stepVehicle(rig, zeroInput());
      const idle = rig.vehicle.getVehiclePhysicsReport().output;
      unexpectedDriveInput ||= idle.driveIntent !== 0 || idle.throttle !== 0;
      maximumIdleSpeedKmh = Math.max(maximumIdleSpeedKmh, idle.speedKmh);
      maximumIdleTransferNm = Math.max(maximumIdleTransferNm, idle.powertrain.wheelDriveTorqueAppliedNm);
    }
    const current = rig.vehicle.getVehiclePhysicsReport();
    const output = current.output;
    const torque = output.powertrain;
    const torqueFields = [
      'driveTorqueRequestedNm', 'driveTorqueAppliedNm',
      'wheelDriveTorqueRequestedNm', 'wheelDriveTorqueAppliedNm',
      'serviceBrakeTorqueRequestedNm', 'serviceBrakeTorqueAppliedNm',
      'driverServiceBrakeTorqueRequestedNm', 'driverServiceBrakeTorqueAppliedNm',
      'assistBrakeTorqueRequestedNm', 'assistBrakeTorqueAppliedNm',
      'handbrakeTorqueRequestedNm', 'handbrakeTorqueAppliedNm',
    ];
    assert.equal(unexpectedDriveInput, false, 'idle dwell must not acquire a driving request');
    assert.ok(output.speedKmh < 0.02, `zero input did not hold the car at rest: ${output.speedKmh} km/h`);
    assert.ok(maximumIdleSpeedKmh < 0.02, `no-input dwell developed creep: ${maximumIdleSpeedKmh} km/h`);
    assert.equal(output.driveIntent, 0, 'zero input drive intent is not neutral');
    assert.equal(output.throttle, 0, 'zero input must not request driver throttle');
    for (const field of torqueFields) assert.ok(Number.isFinite(torque[field]), `${field} is not finite`);
    assert.ok(Math.abs(output.signedSpeed * 3.6) < 0.02, 'zero input speed is not stationary');
    assert.ok(torque.wheelDriveTorqueAppliedNm < 2, 'zero input applied excessive wheel torque');
    assert.equal(maximumIdleTransferNm, 0, 'idle clutch must not feed contact noise back into drive torque');
    report.zeroInput = {
      speedKmh: output.speedKmh,
      signedSpeed: output.signedSpeed,
      driveIntent: output.driveIntent,
      durationSeconds: 3,
      maximumIdleSpeedKmh,
      maximumIdleTransferNm,
      startPosition,
      endPosition: { ...rig.vehicle.body.translation() },
      powertrain: torque,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

// 7. Real Rapier wall collision, then W/S recovery and forward motion without state injection.
{
  const rig = createVehicleRig(mx5, { vehiclePhysicsMode: 'v24-active' });
  const resets = [];
  rig.vehicle.onAutomaticReset = (reason) => resets.push(reason);
  try {
    settleVehicle(rig, 1);
    const RAPIER = rig.vehicle.RAPIER;
    const wallBody = rig.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.65, 4.5),
    );
    const wallCollider = rig.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.8, 0.75, 0.12)
        .setFriction(0.35)
        .setRestitution(0.04),
      wallBody,
    );
    const forward = zeroInput({ throttle: 1, driveIntent: 1 });
    let collision = null;
    const forwardRows = [];
    for (let index = 0; index < 720 && !collision; index += 1) {
      stepVehicle(rig, forward);
      const observation = bodyObservation(rig, wallCollider);
      forwardRows.push({ index, ...observation });
      if (observation.wallContacts > 0) collision = { index, ...observation };
    }
    assert.ok(collision, 'forward drive never contacted the fixed Rapier wall');

    // Keep W down briefly after impact to exercise the contact state before braking.
    const pushRows = runPhase(rig, 0.25, forward, wallCollider, 'wall-forward-push');
    const brake = zeroInput({ brake: 1, driveIntent: -1 });
    const brakeRows = runPhase(rig, 0.5, brake, wallCollider, 'wall-brake');
    assert.ok(
      brakeRows.some((row) => row.telemetry.signedSpeedKmh >= 0),
      'wall braking did not retain a non-negative forward phase',
    );

    const reverseRows = [];
    let reverseEngaged = null;
    let cleared = null;
    for (let index = 0; index < 480; index += 1) {
      stepVehicle(rig, brake);
      const observation = bodyObservation(rig, wallCollider);
      reverseRows.push({ index, ...observation });
      if (!reverseEngaged && rig.vehicle.reverse) reverseEngaged = { index, ...observation };
      // Back past the starting position so the body has room to stop reversing
      // and turn around the wall. z < 2 only clears the collision face: a change
      // in legitimate braking load transfer can then make the scripted W phase
      // hit the wall a second time, which does not test direction-change failure.
      if (reverseEngaged && !cleared && observation.position.z < 0) cleared = { index, ...observation };
      if (cleared && index > cleared.index + 48) break;
    }
    assert.ok(reverseEngaged, 'S/brake never engaged reverse after the wall stop');
    assert.ok(cleared, 'reverse motion never cleared the wall longitudinally');

    // The wall is finite in X; keep steering through the escape so the next W phase
    // can drive around it instead of immediately re-contacting the same obstacle.
    const escapeInput = zeroInput({ throttle: 1, steer: -1, driveIntent: 1 });
    const escapeRows = runPhase(rig, 2.5, escapeInput, wallCollider, 'wall-forward-escape');
    const final = escapeRows.at(-1);
    assert.ok(final.signedBodySpeed > 1, 'forward drive did not resume after reverse escape');
    assert.equal(final.wallContacts, 0, 'escape trajectory contacted the wall again');
    assert.equal(rig.vehicle.getVehiclePhysicsReport().status, 'COMMITTED');
    assert.deepEqual(resets, [], 'wall recovery must not use an automatic reset');

    report.wallRecovery = {
      wallColliderHandle: wallCollider.handle,
      collision,
      forwardAfterCollision: pushRows.at(-1),
      brakeAfterCollision: brakeRows.at(-1),
      reverseEngaged,
      reverseCleared: cleared,
      final,
      maxWallContacts: Math.max(
        ...[forwardRows, pushRows, brakeRows, reverseRows, escapeRows]
          .flatMap((rows) => rows.map((row) => row.wallContacts)),
      ),
      finalReportStatus: rig.vehicle.getVehiclePhysicsReport().status,
      automaticResets: resets,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

console.log(JSON.stringify({ ...report, status: 'PASS', checks, scenarioGroups: 7 }));
