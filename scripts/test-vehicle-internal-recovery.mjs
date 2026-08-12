import assert from 'node:assert/strict';
import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  zeroInput,
} from './physics-harness.mjs';

function snapshot(vehicle) {
  const values = new Map();
  const add = (path, value) => values.set(path, value);
  const addVector = (path, value) => {
    add(`${path}.x`, value.x);
    add(`${path}.y`, value.y);
    add(`${path}.z`, value.z);
  };
  addVector('body.translation', vehicle.body.translation());
  addVector('body.linvel', vehicle.body.linvel());
  addVector('body.angvel', vehicle.body.angvel());
  const rotation = vehicle.body.rotation();
  for (const field of ['x', 'y', 'z', 'w']) add(`body.rotation.${field}`, rotation[field]);
  for (const field of [
    'steerAngle', 'engineLoad', 'engineRpm', 'reverseHold', 'shiftTimer',
    'previousLongSpeed', 'smoothedLongAcceleration', 'stuckTimer',
  ]) add(field, vehicle[field]);
  add('gear', vehicle.gear);
  add('reverse', Number(vehicle.reverse));
  for (const [index, wheel] of vehicle.wheels.entries()) add(`wheels[${index}].omega`, wheel.omega);
  for (const field of [
    'speedKmh', 'signedSpeedKmh', 'rpm', 'throttle', 'brake', 'steer',
    'longitudinalAcceleration', 'lateralAcceleration',
  ]) add(`telemetry.${field}`, vehicle.telemetry[field]);
  for (const [index, wheel] of vehicle.telemetry.wheels.entries()) {
    for (const field of ['load', 'suspension', 'slipRatio', 'slipAngle', 'slipPower']) {
      add(`telemetry.wheels[${index}].${field}`, wheel[field]);
    }
    addVector(`telemetry.wheels[${index}].contactPoint`, wheel.contactPoint);
  }
  return values;
}

function assertFiniteSnapshot(values, label) {
  for (const [path, value] of values) {
    assert.ok(Number.isFinite(value), `${label}: ${path} is ${value}`);
  }
}

function assertSnapshotClose(actual, expected, label) {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${label}: snapshot shape`);
  for (const [path, expectedValue] of expected) {
    const actualValue = actual.get(path);
    const tolerance = 1e-9 * Math.max(1, Math.abs(expectedValue));
    assert.ok(
      Math.abs(actualValue - expectedValue) <= tolerance,
      `${label}: ${path} expected ${expectedValue}, got ${actualValue}`,
    );
  }
}

function hasFiniteBodyState(vehicle) {
  const translation = vehicle.body.translation();
  const rotation = vehicle.body.rotation();
  const linvel = vehicle.body.linvel();
  const angvel = vehicle.body.angvel();
  return [
    translation.x, translation.y, translation.z,
    rotation.x, rotation.y, rotation.z, rotation.w,
    linvel.x, linvel.y, linvel.z,
    angvel.x, angvel.y, angvel.z,
  ].every(Number.isFinite);
}

const scalarCases = [
  {
    name: 'controls',
    poison(vehicle) {
      vehicle.steerAngle = Number.NaN;
      vehicle.engineLoad = Number.POSITIVE_INFINITY;
      vehicle.engineRpm = Number.NEGATIVE_INFINITY;
    },
    normalize(vehicle) {
      vehicle.steerAngle = 0;
      vehicle.engineLoad = 0;
      vehicle.engineRpm = vehicle.config.idle;
    },
  },
  {
    name: 'transmission-timers',
    poison(vehicle) {
      vehicle.reverseHold = Number.NaN;
      vehicle.shiftTimer = Number.POSITIVE_INFINITY;
      vehicle.gear = 999;
      vehicle.reverse = 'truthy-corruption';
    },
    normalize(vehicle) {
      vehicle.reverseHold = 0;
      vehicle.shiftTimer = 0;
      vehicle.gear = 1;
      vehicle.reverse = false;
    },
  },
  {
    name: 'history-timers',
    poison(vehicle) {
      vehicle.previousLongSpeed = Number.NaN;
      vehicle.smoothedLongAcceleration = Number.POSITIVE_INFINITY;
      vehicle.stuckTimer = Number.NEGATIVE_INFINITY;
    },
    normalize(vehicle) {
      vehicle.previousLongSpeed = 0;
      vehicle.smoothedLongAcceleration = 0;
      vehicle.stuckTimer = 0;
    },
  },
  {
    name: 'wheel-omega',
    poison(vehicle) {
      for (const [index, wheel] of vehicle.wheels.entries()) {
        wheel.omega = index % 2 ? Number.POSITIVE_INFINITY : Number.NaN;
      }
    },
    normalize(vehicle) {
      for (const wheel of vehicle.wheels) wheel.omega = 0;
    },
  },
  {
    name: 'telemetry-cache',
    setup(vehicle) {
      const translation = vehicle.body.translation();
      vehicle.body.setTranslation({ x: translation.x, y: 20, z: translation.z }, true);
      vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    poison(vehicle) {
      for (const field of [
        'speedKmh', 'signedSpeedKmh', 'rpm', 'throttle', 'brake', 'steer',
        'longitudinalAcceleration', 'lateralAcceleration',
      ]) vehicle.telemetry[field] = Number.NaN;
      for (const wheel of vehicle.telemetry.wheels) {
        wheel.load = Number.NaN;
        wheel.suspension = Number.POSITIVE_INFINITY;
        wheel.slipRatio = Number.NaN;
        wheel.slipAngle = Number.NEGATIVE_INFINITY;
        wheel.slipPower = Number.NaN;
        wheel.contactPoint.set(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
      }
    },
    normalize(vehicle) {
      vehicle.resetTelemetry();
    },
  },
];

const bodyCases = [
  {
    name: 'body-translation',
    poison(vehicle) {
      vehicle.body.setTranslation({ x: Number.NaN, y: 1, z: 0 }, true);
    },
  },
  {
    name: 'body-rotation',
    poison(vehicle) {
      vehicle.body.setRotation({ x: Number.NaN, y: 0, z: 0, w: 1 }, true);
    },
  },
  {
    name: 'body-linvel',
    poison(vehicle) {
      vehicle.body.setLinvel({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, true);
    },
  },
  {
    name: 'body-angvel',
    poison(vehicle) {
      vehicle.body.setAngvel({ x: 0, y: Number.NaN, z: 0 }, true);
    },
  },
];

const stepInput = zeroInput({ throttle: 0.35, steer: 0.2, driveIntent: 1 });
const failures = [];
let scalarPairs = 0;
let bodyPairs = 0;
let bodySetterNormalizedPairs = 0;

for (const config of CARS) {
  for (const recoveryCase of scalarCases) {
    const actualRig = createVehicleRig(config);
    const oracleRig = createVehicleRig(config);
    const label = `${config.id}/${recoveryCase.name}`;
    try {
      runFor(actualRig, 0.5, stepInput);
      runFor(oracleRig, 0.5, stepInput);
      recoveryCase.setup?.(actualRig.vehicle);
      recoveryCase.setup?.(oracleRig.vehicle);
      recoveryCase.poison(actualRig.vehicle);
      recoveryCase.normalize(oracleRig.vehicle);
      actualRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      oracleRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      assertFiniteSnapshot(snapshot(actualRig.vehicle), `${label}/fixedUpdate`);
      actualRig.world.step();
      oracleRig.world.step();
      actualRig.vehicle.afterPhysics();
      oracleRig.vehicle.afterPhysics();
      const actual = snapshot(actualRig.vehicle);
      const expected = snapshot(oracleRig.vehicle);
      assertFiniteSnapshot(actual, `${label}/worldStep`);
      assertSnapshotClose(actual, expected, label);
      scalarPairs += 1;
    } catch (error) {
      failures.push({ label, phase: 'scalar', error });
    } finally {
      destroyVehicleRig(actualRig);
      destroyVehicleRig(oracleRig);
    }
  }

  for (const recoveryCase of bodyCases) {
    const actualRig = createVehicleRig(config);
    const oracleRig = createVehicleRig(config);
    const label = `${config.id}/${recoveryCase.name}`;
    try {
      runFor(actualRig, 0.5, stepInput);
      runFor(oracleRig, 0.5, stepInput);
      recoveryCase.poison(actualRig.vehicle);
      const requiresReset = !hasFiniteBodyState(actualRig.vehicle);
      if (requiresReset) oracleRig.vehicle.reset(oracleRig.vehicle.safeSample);
      else oracleRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      actualRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      assertFiniteSnapshot(snapshot(actualRig.vehicle), `${label}/fixedUpdate`);
      actualRig.world.step();
      oracleRig.world.step();
      actualRig.vehicle.afterPhysics();
      oracleRig.vehicle.afterPhysics();
      const actual = snapshot(actualRig.vehicle);
      const expected = snapshot(oracleRig.vehicle);
      assertFiniteSnapshot(actual, `${label}/worldStep`);
      assertSnapshotClose(actual, expected, label);
      bodyPairs += 1;
      if (!requiresReset) bodySetterNormalizedPairs += 1;
    } catch (error) {
      failures.push({ label, phase: 'body', error });
    } finally {
      destroyVehicleRig(actualRig);
      destroyVehicleRig(oracleRig);
    }
  }
}

if (failures.length > 0) {
  const grouped = Object.groupBy(failures, ({ phase }) => phase);
  for (const [phase, entries] of Object.entries(grouped)) {
    console.error(`FAIL ${phase}: ${entries.length}`);
    for (const { label, error } of entries.slice(0, 8)) console.error(`- ${label}: ${error.message}`);
  }
  console.error(`FAIL vehicle internal recovery ${failures.length}/${CARS.length * (scalarCases.length + bodyCases.length)} paired cases`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS vehicle internal recovery scalar=${scalarPairs} body=${bodyPairs} `
    + `rapier-normalized=${bodySetterNormalizedPairs} total=${scalarPairs + bodyPairs}`,
  );
}
