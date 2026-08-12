import assert from 'node:assert/strict';

import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  zeroInput,
} from './physics-harness.mjs';

const MIN_SAFE_UPDATE_DT = FIXED_DT * 0.25;
const MAX_SAFE_UPDATE_DT = 0.05;
const neutralInput = zeroInput();
const activeInput = zeroInput({ steer: 0.25, throttle: 0.6, driveIntent: 1 });
const cases = [
  { label: 'null-input', input: null, dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'empty-input', input: {}, dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'nan-steer', input: zeroInput({ steer: Number.NaN }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'positive-infinite-throttle', input: zeroInput({ throttle: Number.POSITIVE_INFINITY }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'negative-infinite-brake', input: zeroInput({ brake: Number.NEGATIVE_INFINITY }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'nan-handbrake', input: zeroInput({ handbrake: Number.NaN }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'positive-infinite-drive-intent', input: zeroInput({ driveIntent: Number.POSITIVE_INFINITY }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  {
    label: 'out-of-range-controls',
    input: zeroInput({ steer: 4, throttle: 2, brake: -3, handbrake: 2, driveIntent: 9 }),
    dt: FIXED_DT,
    expectedInput: zeroInput({ steer: 1, throttle: 1, brake: 0, handbrake: 1, driveIntent: 1 }),
    expectedDt: FIXED_DT,
  },
  {
    label: 'truthy-non-boolean-pulses',
    input: zeroInput({ shiftUp: 1, shiftDown: 'yes', toggleTransmission: {}, reset: 'true' }),
    dt: FIXED_DT,
    expectedInput: neutralInput,
    expectedDt: FIXED_DT,
  },
  { label: 'nan-dt', input: activeInput, dt: Number.NaN, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'positive-infinite-dt', input: activeInput, dt: Number.POSITIVE_INFINITY, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'negative-infinite-dt', input: activeInput, dt: Number.NEGATIVE_INFINITY, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'zero-dt', input: activeInput, dt: 0, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'minimum-positive-dt', input: activeInput, dt: Number.MIN_VALUE, expectedInput: activeInput, expectedDt: MIN_SAFE_UPDATE_DT },
  { label: 'maximum-dt', input: activeInput, dt: Number.MAX_VALUE, expectedInput: activeInput, expectedDt: MAX_SAFE_UPDATE_DT },
];

function collectNumericState(vehicle) {
  const entries = [];
  const add = (path, value) => entries.push([path, value]);
  const addVector = (path, vector) => {
    add(`${path}.x`, vector.x);
    add(`${path}.y`, vector.y);
    add(`${path}.z`, vector.z);
  };

  addVector('body.translation', vehicle.body.translation());
  addVector('body.linvel', vehicle.body.linvel());
  addVector('body.angvel', vehicle.body.angvel());
  const rotation = vehicle.body.rotation();
  add('body.rotation.x', rotation.x);
  add('body.rotation.y', rotation.y);
  add('body.rotation.z', rotation.z);
  add('body.rotation.w', rotation.w);
  for (const field of [
    'gear',
    'steerAngle',
    'engineLoad',
    'engineRpm',
    'reverseHold',
    'shiftTimer',
    'previousLongSpeed',
    'smoothedLongAcceleration',
    'stuckTimer',
  ]) {
    add(field, vehicle[field]);
  }
  for (const [index, wheel] of vehicle.wheels.entries()) add(`wheels[${index}].omega`, wheel.omega);
  for (const field of [
    'gear',
    'speedKmh',
    'signedSpeedKmh',
    'rpm',
    'throttle',
    'brake',
    'steer',
    'longitudinalAcceleration',
    'lateralAcceleration',
  ]) {
    add(`telemetry.${field}`, vehicle.telemetry[field]);
  }
  for (const [index, wheel] of vehicle.telemetry.wheels.entries()) {
    for (const field of ['load', 'suspension', 'slipRatio', 'slipAngle', 'slipPower']) {
      add(`telemetry.wheels[${index}].${field}`, wheel[field]);
    }
    addVector(`telemetry.wheels[${index}].contactPoint`, wheel.contactPoint);
  }
  return entries;
}

function collectNonFiniteFields(vehicle) {
  return collectNumericState(vehicle)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([path]) => path);
}

function collectOracleMismatches(actualVehicle, expectedVehicle) {
  const expected = new Map(collectNumericState(expectedVehicle));
  return collectNumericState(actualVehicle).flatMap(([path, actual]) => {
    const expectedValue = expected.get(path);
    const tolerance = 1e-10 * Math.max(1, Math.abs(expectedValue));
    return Number.isFinite(actual) && Math.abs(actual - expectedValue) <= tolerance ? [] : [path];
  });
}

const failures = [];
for (const config of CARS) {
  for (const boundaryCase of cases) {
    const rig = createVehicleRig(config);
    const oracleRig = createVehicleRig(config);
    try {
      runFor(rig, 0.25, zeroInput());
      runFor(oracleRig, 0.25, zeroInput());
      oracleRig.vehicle.fixedUpdate(boundaryCase.expectedInput, false, boundaryCase.expectedDt);
      oracleRig.world.step();
      oracleRig.vehicle.afterPhysics();
      try {
        rig.vehicle.fixedUpdate(boundaryCase.input, false, boundaryCase.dt);
      } catch (error) {
        failures.push({
          carId: config.id,
          case: boundaryCase.label,
          phase: 'fixedUpdate',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        continue;
      }

      const updateFields = collectNonFiniteFields(rig.vehicle);
      if (updateFields.length > 0) {
        failures.push({ carId: config.id, case: boundaryCase.label, phase: 'fixedUpdate', fields: updateFields });
      }
      try {
        rig.world.step();
        rig.vehicle.afterPhysics();
      } catch (error) {
        failures.push({
          carId: config.id,
          case: boundaryCase.label,
          phase: 'worldStep',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        continue;
      }
      const worldFields = collectNonFiniteFields(rig.vehicle);
      if (worldFields.length > 0) {
        failures.push({ carId: config.id, case: boundaryCase.label, phase: 'worldStep', fields: worldFields });
      }
      const oracleFields = collectOracleMismatches(rig.vehicle, oracleRig.vehicle);
      if (oracleFields.length > 0) {
        failures.push({ carId: config.id, case: boundaryCase.label, phase: 'sanitizedOracle', fields: oracleFields });
      }
    } finally {
      destroyVehicleRig(rig);
      destroyVehicleRig(oracleRig);
    }
  }
}

const unique = (values) => [...new Set(values)].sort();
const failedCars = unique(failures.map(({ carId }) => carId));
const failedCases = unique(failures.map(({ case: label }) => label));
const failedPhases = unique(failures.map(({ phase }) => phase));
const failedFields = unique(failures.flatMap(({ fields = [] }) => fields));
const errors = unique(failures.flatMap(({ error }) => error ? [error] : []));
assert.equal(
  failures.length,
  0,
  `invalid vehicle calls failed for cars=${failedCars.join(',')} cases=${failedCases.join(',')} `
    + `phases=${failedPhases.join(',')} fields=${failedFields.join(',')} errors=${errors.join(' | ')}`,
);
console.log(`PASS ${cases.length} invalid input/dt boundaries stay finite for ${CARS.length}/${CARS.length} cars`);
