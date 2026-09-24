import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createTireState,
  evaluateAcceptedHandlingTrial,
  evaluateBrakeAssists,
  idealOpenDifferentialMapping,
  solveAcceptedTireContact,
} from '../src/vehicle-v24/index.js';

const golden = JSON.parse(fs.readFileSync(new URL('../data/vehicle-v24-golden.json', import.meta.url)));
let checks = 0;
const close = (actual, expected, tolerance = 2e-12, label = 'value') => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
  checks += 1;
};

assert.equal(golden.schema, 'streetrush.vehicle-v24.golden.v1');
checks += 1;
assert.equal(golden.source.maneuverMatrixSha256, 'da141d1efec12f9abd28de081a596db91a875cd8f7a2dc3b393861b7ea2d51b3');
checks += 1;
assert.equal(golden.source.validationManifestSha256, 'bcf50f41a6c6382b40cf92e7ad4b1a69f6f7978264237e3de01a1a68c1d39e9c');
checks += 1;
assert.deepEqual(golden.source.matrixCounts, { EXPECTED_HOST_BOUNDARY: 2, FAIL: 0, PASS: 31, TIMEOUT: 0 });
checks += 1;

const vector = golden.componentVectors.tireHandling;
const tire = evaluateAcceptedHandlingTrial({
  previousState: { sx: 0, sy: 0, sGamma: 0, mode: 'HANDLING' },
  normalLoad: vector.input.normal_load_n,
  velocityX: vector.input.velocity_x_mps,
  velocityY: vector.input.velocity_y_mps,
  omega: vector.input.wheel_omega_radps,
  camber: vector.input.camber_rad,
  muScale: vector.input.surface_mu_x,
  dt: vector.input.dt_s,
  unloadedRadius: 0.31,
});
close(tire.forceX, vector.output.force_x_n, 2e-12, 'Tire Fx');
close(tire.forceY, vector.output.force_y_n, 2e-12, 'Tire Fy');
close(tire.momentZ, vector.output.moment_z_nm, 2e-12, 'Tire Mz');
close(tire.effectiveRadius, vector.output.effective_radius_m, 2e-12, 'effective radius');
close(tire.wheelContactTorque, vector.output.wheel_contact_torque_nm, 2e-12, 'wheel contact torque');
close(tire.nextState.sx, vector.output.state_next.sx, 2e-12, 'transient sx');
close(tire.nextState.sy, vector.output.state_next.sy, 2e-12, 'transient sy');
close(tire.contactPower, vector.output.contact_power_w, 2e-10, 'contact power');

const airborne = solveAcceptedTireContact({
  previousState: { sx: 0.2, sy: -0.1, sGamma: 0.03, mode: 'HANDLING' },
  inContact: false,
  normalLoad: 0,
  velocityX: 0,
  velocityY: 0,
  omega: 0,
  dt: 1 / 120,
  unloadedRadius: 0.31,
  delassus: [[1, 0], [0, 1]],
});
assert.equal(airborne.regime, 'AIRBORNE');
checks += 1;
assert.deepEqual(airborne.nextState, createTireState());
checks += 1;
assert.deepEqual([airborne.forceX, airborne.forceY, airborne.forceZ], [0, 0, 0]);
checks += 1;
assert.equal(golden.componentVectors.lowSpeedHostBoundary.exception, 'FrictionContactHostRequired');
checks += 1;

const differential = idealOpenDifferentialMapping(
  { drivetrain: 'RWD', finalDrive: 3.5, gears: [1] },
  '1',
);
assert.deepEqual(differential, golden.componentVectors.openDifferential.mapping);
checks += 1;
assert.notEqual(
  golden.componentVectors.openDifferential.independentWheelOmega[2],
  golden.componentVectors.openDifferential.independentWheelOmega[3],
);
checks += 1;

// Do not re-record the immutable oracle or call revised host input/speed-assist
// behavior reference parity. The separate playability suite tests that user-requested
// command policy; full Steering differential coverage remains PARTIAL.
const steeringReferenceParity = {
  status: 'PARTIAL',
  reason: 'host steering command policy changed; this suite does not assert standalone steering parity',
  behaviorSuite: 'test-vehicle-v24-playability.mjs',
};

const brakeVector = golden.componentVectors.brakeAssist;
const brake = evaluateBrakeAssists({
  serviceBrake: brakeVector.input.service,
  parkingBrake: brakeVector.input.parking,
  bodyLongSpeed: brakeVector.input.bodyUMps,
  oracleYawRate: 0,
  steeringCurvature: 0.02,
  wheelOmega: [48, 48, 48, 48],
  effectiveRadii: [0.31, 0.31, 0.31, 0.31],
  drivenWheels: [false, false, true, true],
  config: { brakeTorque: brakeVector.input.streetRushBrakeTorqueNm },
});
assert.deepEqual(brake.totalBrakeCapacity, brakeVector.output.total_brake_capacity_nm);
checks += 1;
assert.deepEqual(brake.absModulation, brakeVector.output.abs_modulation);
checks += 1;
close(brake.enginePositiveTorqueLimit, brakeVector.output.engine_positive_torque_limit, 0, 'TCS torque limit');

assert.ok(golden.maneuver120Hz.length >= 9, '120 Hz matrix evidence is incomplete');
checks += 1;
assert.ok(golden.maneuver120Hz.every((entry) => entry.status === 'PASS'));
checks += 1;
assert.ok(golden.maneuver120Hz.every((entry) => {
  const transaction = entry.details.transaction;
  if (!transaction) return entry.scenario === 'step_driver_F_to_R_full_brake';
  return transaction.committed_exactly_once === true;
}));
checks += 1;

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.selected-reference-checks.v2',
  status: 'PASS',
  checks,
  scope: 'unchanged selected components and recorded manifest metadata only',
  referenceParity: 'PARTIAL',
  steeringReferenceParity,
}));
