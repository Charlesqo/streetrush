import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, FIXED_DT } from '../src/config.js';
import { initializeRapier } from '../src/rapier-init.js';
import { VehicleSystem } from '../src/vehicle.js';
import { FlatTrack, stepVehicle, zeroInput } from './physics-harness.mjs';

await initializeRapier(RAPIER);

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const magnitude = (value) => Math.hypot(value.x, value.y, value.z);
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (value, scalar) => ({
  x: value.x * scalar,
  y: value.y * scalar,
  z: value.z * scalar,
});
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const multiplyMatrix = (matrix, vector) => ({
  x: matrix.m11 * vector.x + matrix.m12 * vector.y + matrix.m13 * vector.z,
  y: matrix.m21 * vector.x + matrix.m22 * vector.y + matrix.m23 * vector.z,
  z: matrix.m31 * vector.x + matrix.m32 * vector.y + matrix.m33 * vector.z,
});
const copyMatrix = (matrix) => ({
  m11: matrix.m11, m12: matrix.m12, m13: matrix.m13,
  m21: matrix.m21, m22: matrix.m22, m23: matrix.m23,
  m31: matrix.m31, m32: matrix.m32, m33: matrix.m33,
});

function checkVector(actual, expected, tolerance, message) {
  check(magnitude(subtract(actual, expected)) <= tolerance, `${message}: ${JSON.stringify({ actual, expected })}`);
}

function createRig({
  groundType = 'fixed',
  options = {},
  airborne = false,
  gravity = { x: 0, y: -9.81, z: 0 },
  config = CARS[0],
} = {}) {
  const world = new RAPIER.World(gravity);
  world.integrationParameters.dt = FIXED_DT;
  const desc = groundType === 'kinematic'
    ? RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -0.3, 0)
    : groundType === 'dynamic'
      ? RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -0.3, 0).setCanSleep(false)
      : RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0);
  const ground = world.createRigidBody(desc);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(100, 0.3, 100)
      .setMass(groundType === 'dynamic' ? 10000 : 0)
      .setFriction(0.8),
    ground,
  );
  const scene = new THREE.Scene();
  const track = new FlatTrack();
  const vehicle = new VehicleSystem({
    RAPIER,
    world,
    scene,
    track,
    config,
    visual: new THREE.Group(),
    vehiclePhysicsMode: 'v24-active',
    vehicleV24Options: options,
  });
  if (airborne) vehicle.body.setTranslation({ x: 0, y: 5, z: 0 }, true);
  if (groundType === 'kinematic') {
    ground.setNextKinematicTranslation({ x: 0.01, y: -0.3, z: 0 });
  }
  world.step();
  return { world, ground, vehicle };
}

function destroy(rig) {
  rig.vehicle.destroy();
  rig.world.free();
}

const fixed = createRig();
fixed.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
const fixedReport = fixed.vehicle.getVehiclePhysicsReport();
check(fixedReport.contacts.every((contact) => contact.inContact), 'fixed-ground wheel ray missed');
check(fixedReport.contacts.every((contact) => contact.colliderHandle !== null), 'Rapier collider handle missing');
check(fixedReport.contacts.every((contact) => contact.normalSource === 'RAPIER_RAY_HIT_NORMAL_WORLD'), 'normal did not come from Rapier hit');
check(fixedReport.contacts.every((contact) => Math.abs(contact.point.y) < 1e-5), 'contact point is not the real ground intersection');
check(fixedReport.contacts.every((contact) => Math.abs(contact.normal.y - 1) < 1e-9), 'contact normal is not world-space up');
check(fixedReport.contacts.every((contact) => magnitude(contact.groundVelocity) < 1e-12), 'fixed ground velocity must be zero');
destroy(fixed);

const moving = createRig({ groundType: 'kinematic' });
moving.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
const movingReport = moving.vehicle.getVehiclePhysicsReport();
check(movingReport.contacts.every((contact) => contact.inContact), 'kinematic platform wheel ray missed');
check(
  movingReport.contacts.every((contact) => Math.abs(contact.groundVelocity.x - 1.2) < 2e-4),
  'kinematic ground velocity was not sampled with velocityAtPoint',
);
destroy(moving);

const reactionConfig = { ...CARS[0], cdA: 0 };
const reacting = createRig({
  groundType: 'dynamic',
  gravity: { x: 0, y: 0, z: 0 },
  config: reactionConfig,
});
const carVelocityBefore = { ...reacting.vehicle.body.linvel() };
const groundVelocityBefore = { ...reacting.ground.linvel() };
reacting.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
const reactionReport = reacting.vehicle.getVehiclePhysicsReport();
check(reactionReport.actionReaction.length === 4, 'dynamic ground did not receive four wheel reactions');
check(reactionReport.hostCounters.groundReactionWrites === 4, 'dynamic reaction write count is incorrect');
for (const pair of reactionReport.actionReaction) {
  check(pair.groundBodyType === 'DYNAMIC', 'reaction target was not dynamic');
  check(magnitude({
    x: pair.vehicleForce.x + pair.groundForce.x,
    y: pair.vehicleForce.y + pair.groundForce.y,
    z: pair.vehicleForce.z + pair.groundForce.z,
  }) < 1e-12, 'contact force action/reaction does not balance');
}
const carForce = { ...reacting.vehicle.body.userForce() };
const groundForce = { ...reacting.ground.userForce() };
check(magnitude(carForce) > 100, 'dynamic-platform suspension did not load the Rapier vehicle body');
checkVector(add(carForce, groundForce), { x: 0, y: 0, z: 0 }, 2e-4, 'Rapier body forces violate action/reaction');
const reportedCarForce = reactionReport.actionReaction.reduce(
  (sum, pair) => add(sum, pair.vehicleForce),
  { x: 0, y: 0, z: 0 },
);
checkVector(carForce, reportedCarForce, 2e-4, 'Rapier vehicle userForce differs from the committed contact wrench');
const carMass = reacting.vehicle.body.mass();
const groundMass = reacting.ground.mass();
const totalMomentumBefore = add(scale(carVelocityBefore, carMass), scale(groundVelocityBefore, groundMass));
reacting.world.step();
const carVelocityAfter = { ...reacting.vehicle.body.linvel() };
const groundVelocityAfter = { ...reacting.ground.linvel() };
const totalMomentumAfter = add(scale(carVelocityAfter, carMass), scale(groundVelocityAfter, groundMass));
checkVector(
  subtract(carVelocityAfter, carVelocityBefore),
  scale(carForce, FIXED_DT / carMass),
  2e-5,
  'Rapier vehicle velocity increment does not match F dt / m',
);
checkVector(
  subtract(groundVelocityAfter, groundVelocityBefore),
  scale(groundForce, FIXED_DT / groundMass),
  2e-5,
  'Rapier ground velocity increment does not match reaction F dt / m',
);
checkVector(totalMomentumAfter, totalMomentumBefore, 2e-3, 'dynamic action/reaction did not conserve total momentum');
const secondMomentumBefore = totalMomentumAfter;
reacting.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
const secondReactionReport = reacting.vehicle.getVehiclePhysicsReport();
const secondCarForce = { ...reacting.vehicle.body.userForce() };
const secondGroundForce = { ...reacting.ground.userForce() };
const secondReportedForce = secondReactionReport.actionReaction.reduce(
  (sum, pair) => add(sum, pair.vehicleForce),
  { x: 0, y: 0, z: 0 },
);
checkVector(add(secondCarForce, secondGroundForce), { x: 0, y: 0, z: 0 }, 2e-4, 'second Rapier step accumulated a stale ground reaction');
checkVector(secondCarForce, secondReportedForce, 1e-3, 'second Rapier force differs from its committed wrench');
reacting.world.step();
const secondMomentumAfter = add(
  scale(reacting.vehicle.body.linvel(), carMass),
  scale(reacting.ground.linvel(), groundMass),
);
checkVector(secondMomentumAfter, secondMomentumBefore, 2e-3, 'second dynamic action/reaction step did not conserve momentum');
destroy(reacting);

const angularReaction = createRig({
  groundType: 'dynamic',
  gravity: { x: 0, y: 0, z: 0 },
  config: reactionConfig,
  airborne: true,
});
angularReaction.vehicle.body.setLinearDamping(0);
angularReaction.vehicle.body.setAngularDamping(0);
angularReaction.ground.setLinearDamping(0);
angularReaction.ground.setAngularDamping(0);
angularReaction.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
angularReaction.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
angularReaction.ground.setLinvel({ x: 0, y: 0, z: 0 }, true);
angularReaction.ground.setAngvel({ x: 0, y: 0, z: 0 }, true);
angularReaction.vehicle.body.resetForces(false);
angularReaction.vehicle.body.resetTorques(false);
angularReaction.ground.resetForces(false);
angularReaction.ground.resetTorques(false);
const angularHost = angularReaction.vehicle.vehicleV24.host;
const reactionPoint = { x: 0.8, y: 0.1, z: -0.6 };
const appliedForce = { x: 325, y: 475, z: -210 };
const appliedMoment = { x: 19, y: -31, z: 23 };
const vehicleCom = { ...angularReaction.vehicle.body.worldCom() };
const groundCom = { ...angularReaction.ground.worldCom() };
const vehicleInverseInertia = copyMatrix(angularReaction.vehicle.body.effectiveWorldInvInertia());
const groundInverseInertia = copyMatrix(angularReaction.ground.effectiveWorldInvInertia());
const expectedVehicleTorque = add(
  cross(subtract(reactionPoint, vehicleCom), appliedForce),
  appliedMoment,
);
const expectedGroundTorque = add(
  cross(subtract(reactionPoint, groundCom), scale(appliedForce, -1)),
  scale(appliedMoment, -1),
);
angularHost.applyWrenchBatch({
  contacts: [{
    wheelIndex: 0,
    point: reactionPoint,
    groundBody: angularReaction.ground,
    forceWorld: appliedForce,
    momentWorld: appliedMoment,
  }],
  bodyForce: { x: 0, y: 0, z: 0 },
  bodyTorque: { x: 0, y: 0, z: 0 },
});
const actualVehicleForce = { ...angularReaction.vehicle.body.userForce() };
const actualGroundForce = { ...angularReaction.ground.userForce() };
const actualVehicleTorque = { ...angularReaction.vehicle.body.userTorque() };
const actualGroundTorque = { ...angularReaction.ground.userTorque() };
checkVector(actualVehicleForce, appliedForce, 1e-9, 'vehicle Rapier force differs from the known contact wrench');
checkVector(actualGroundForce, scale(appliedForce, -1), 1e-9, 'ground Rapier force differs from the known reaction wrench');
checkVector(actualVehicleTorque, expectedVehicleTorque, 1e-4, 'vehicle Rapier torque omitted r cross F or tire moment');
checkVector(actualGroundTorque, expectedGroundTorque, 1e-4, 'ground Rapier torque omitted reaction r cross F or tire moment');
checkVector(
  add(
    add(actualVehicleTorque, cross(vehicleCom, actualVehicleForce)),
    add(actualGroundTorque, cross(groundCom, actualGroundForce)),
  ),
  { x: 0, y: 0, z: 0 },
  2e-4,
  'actual Rapier wrenches do not balance angular impulse about the world origin',
);
angularReaction.world.step();
checkVector(
  angularReaction.vehicle.body.angvel(),
  scale(multiplyMatrix(vehicleInverseInertia, expectedVehicleTorque), FIXED_DT),
  2e-6,
  'vehicle angular state did not integrate the known contact torque',
);
checkVector(
  angularReaction.ground.angvel(),
  scale(multiplyMatrix(groundInverseInertia, expectedGroundTorque), FIXED_DT),
  2e-6,
  'ground angular state did not integrate the known reaction torque',
);
angularHost.dispose();
checkVector(angularReaction.ground.userForce(), { x: 0, y: 0, z: 0 }, 1e-9, 'dispose retained a dynamic-ground reaction force');
checkVector(angularReaction.ground.userTorque(), { x: 0, y: 0, z: 0 }, 1e-4, 'dispose retained a dynamic-ground reaction torque');
destroy(angularReaction);

const aeroAsset = {
  area: 1,
  length: 2.7,
  forceCoefficients: [-0.65, 0.08, -0.12],
  momentCoefficients: [0.04, -0.03, 0.02],
  referenceOffsetLocal: { x: 0.15, y: 0.2, z: -0.1 },
};
const sixDof = createRig({
  airborne: true,
  gravity: { x: 0, y: 0, z: 0 },
  config: { ...CARS[0], gears: [0], finalDrive: 0, cdA: 0 },
  options: { aeroAsset },
});
sixDof.vehicle.body.setAngularDamping(0);
sixDof.vehicle.body.setLinearDamping(0);
sixDof.vehicle.body.setLinvel({ x: 1.5, y: 0.4, z: 20 }, true);
sixDof.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
const velocityBefore = { ...sixDof.vehicle.body.linvel() };
const inverseInertiaValue = sixDof.vehicle.body.effectiveWorldInvInertia();
const inverseInertia = {
  m11: inverseInertiaValue.m11, m12: inverseInertiaValue.m12, m13: inverseInertiaValue.m13,
  m21: inverseInertiaValue.m21, m22: inverseInertiaValue.m22, m23: inverseInertiaValue.m23,
  m31: inverseInertiaValue.m31, m32: inverseInertiaValue.m32, m33: inverseInertiaValue.m33,
};
sixDof.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
const userForce = sixDof.vehicle.body.userForce();
const userTorque = sixDof.vehicle.body.userTorque();
const dynamicPressure = 0.5 * 1.225 * magnitude(velocityBefore) ** 2;
const forceOracle = aeroAsset.forceCoefficients.map((coefficient) => dynamicPressure * aeroAsset.area * coefficient);
const expectedForce = { x: -forceOracle[1], y: forceOracle[2], z: forceOracle[0] };
const momentOracle = aeroAsset.momentCoefficients.map(
  (coefficient) => dynamicPressure * aeroAsset.area * aeroAsset.length * coefficient,
);
const momentAtReference = { x: momentOracle[1], y: -momentOracle[2], z: -momentOracle[0] };
const expectedTorque = add(momentAtReference, cross(aeroAsset.referenceOffsetLocal, expectedForce));
checkVector(userForce, expectedForce, 2e-4, 'Rapier userForce does not equal the mapped six-coefficient aero force');
checkVector(userTorque, expectedTorque, 2e-4, 'Rapier userTorque does not equal the mapped axial moment about COM');
check(sixDof.vehicle.getVehiclePhysicsReport().aero.coefficients.length === 6, 'Aero wrench is not six-dimensional');
const sixDofMass = sixDof.vehicle.body.mass();
sixDof.world.step();
checkVector(
  sixDof.vehicle.body.linvel(),
  add(velocityBefore, scale(expectedForce, FIXED_DT / sixDofMass)),
  2e-5,
  'Rapier linear state did not integrate the expected aero force',
);
checkVector(
  sixDof.vehicle.body.angvel(),
  scale(multiplyMatrix(inverseInertia, expectedTorque), FIXED_DT),
  2e-5,
  'Rapier angular state did not integrate the expected aero torque',
);
destroy(sixDof);

const airborne = createRig({ airborne: true });
airborne.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
const airborneReport = airborne.vehicle.getVehiclePhysicsReport();
check(airborneReport.contacts.every((contact) => !contact.inContact), 'airborne ray unexpectedly hit');
check(airborneReport.solver.activeSet.normal.every((mode) => mode === 'AIRBORNE'), 'normal active-set did not classify AIRBORNE');
check(airborneReport.solver.activeSet.tires.every((mode) => mode === 'AIRBORNE'), 'Tire state did not clear to AIRBORNE');
check(airborne.vehicle.telemetry.wheels.every((wheel) => wheel.load === 0), 'airborne wheel retained normal load');
const airborneOwnerState = airborne.vehicle.vehicleV24.getStateSnapshot();
check(
  airborneOwnerState.tires.corners.every((corner) => (
    corner.mode === 'AIRBORNE' && corner.sx === 0 && corner.sy === 0 && corner.sGamma === 0
  )),
  'AIRBORNE did not clear the canonical Tire state',
);
airborne.vehicle.body.setTranslation({ x: 0, y: 0.8, z: 0 }, true);
airborne.vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
airborne.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
airborne.vehicle.body.resetForces(false);
airborne.vehicle.body.resetTorques(false);
let recontactStep = null;
let recontactFramesCommitted = true;
let recontactFramesFinite = true;
let maximumRecontactResidual = 0;
for (let index = 0; index < 60; index += 1) {
  stepVehicle(airborne, zeroInput());
  const report = airborne.vehicle.getVehiclePhysicsReport();
  if (recontactStep === null && report.contacts.every((contact) => contact.inContact)) {
    recontactStep = index + 1;
  }
  recontactFramesCommitted &&= report.status === 'COMMITTED'
    && report.transaction.status === 'COMMITTED';
  maximumRecontactResidual = Math.max(maximumRecontactResidual, report.solver.scaledResidual);
  recontactFramesFinite &&= Number.isFinite(report.solver.scaledResidual)
    && report.output.wheelOmega.every(Number.isFinite)
    && report.output.wheels.every((wheel) => [
      wheel.load,
      wheel.suspension,
      wheel.slipRatio,
      wheel.slipAngle,
      wheel.slipPower,
    ].every(Number.isFinite));
}
const recontactReport = airborne.vehicle.getVehiclePhysicsReport();
const recontactOwnerState = airborne.vehicle.vehicleV24.getStateSnapshot();
check(recontactStep !== null, 'AIRBORNE vehicle never reacquired all four Rapier contacts');
check(recontactFramesCommitted, 'AIRBORNE to CONTACT sequence aborted a transaction');
check(recontactFramesFinite, 'AIRBORNE to CONTACT sequence produced a non-finite quantity');
check(
  maximumRecontactResidual <= recontactReport.solver.tolerance,
  'AIRBORNE to CONTACT sequence exceeded the residual gate',
);
check(recontactReport.solver.activeSet.normal.every((mode) => mode === 'CONTACT'), 'recontact did not restore normal CONTACT authority');
check(recontactReport.solver.activeSet.tires.every((mode) => mode !== 'AIRBORNE'), 'recontact left Tire in AIRBORNE');
check(
  recontactOwnerState.tires.corners.every((corner) => (
    corner.mode !== 'AIRBORNE' && [corner.sx, corner.sy, corner.sGamma].every(Number.isFinite)
  )),
  'recontact did not restore finite canonical Tire state',
);
destroy(airborne);

console.log(`vehicle-v24 Rapier host: PASS (${checks} checks)`);
