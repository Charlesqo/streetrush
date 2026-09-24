import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { CARS } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

const TRACE_STEPS = 720;

function quantize(value) {
  if (typeof value === 'number') return Math.round(value * 1e8) / 1e8;
  if (Array.isArray(value)) return value.map(quantize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, quantize(nested)]));
  }
  return value;
}

function inputAt(step) {
  if (step < 120) return zeroInput();
  if (step < 420) {
    return zeroInput({
      throttle: 0.8,
      steer: 0.22 * Math.sin((step - 120) * 0.021),
      driveIntent: 1,
    });
  }
  if (step < 600) return zeroInput({ brake: 1, driveIntent: -1 });
  return zeroInput({
    throttle: 0.35,
    steer: -0.16,
    driveIntent: 1,
  });
}

function snapshot(rig, report) {
  const body = rig.vehicle.body;
  return quantize({
    translation: body.translation(),
    rotation: body.rotation(),
    linvel: body.linvel(),
    angvel: body.angvel(),
    wheelOmega: rig.vehicle.wheels.map((wheel) => wheel.omega),
    rpm: rig.vehicle.telemetry.rpm,
    gear: rig.vehicle.telemetry.gear,
    reverse: rig.vehicle.telemetry.reverse,
    activeSet: report.solver.activeSet,
    residual: report.solver.scaledResidual,
    ownerState: rig.vehicle.vehicleV24.getStateSnapshot(),
  });
}

function runTrace() {
  const rig = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
  const trace = [];
  let committedSteps = 0;
  try {
    for (let step = 0; step < TRACE_STEPS; step += 1) {
      stepVehicle(rig, inputAt(step));
      const report = rig.vehicle.getVehiclePhysicsReport();
      assert.equal(report.status, 'COMMITTED', `v2.4 determinism step ${step} did not commit`);
      committedSteps += 1;
      if (step % 4 === 3) trace.push(snapshot(rig, report));
    }
  } finally {
    destroyVehicleRig(rig);
  }
  const serialized = JSON.stringify(trace);
  return {
    committedSteps,
    trace,
    hash: createHash('sha256').update(serialized).digest('hex'),
  };
}

const first = runTrace();
const second = runTrace();
assert.equal(first.committedSteps, TRACE_STEPS, 'first deterministic trace missed committed steps');
assert.equal(second.committedSteps, TRACE_STEPS, 'second deterministic trace missed committed steps');
assert.equal(second.hash, first.hash, 'v2.4 trace hash differs between identical StreetRush runs');
assert.deepEqual(second.trace, first.trace, 'v2.4 quantized runtime trace is not deterministic');

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.determinism.v1',
  status: 'PASS',
  checks: 4,
  fixedStepsPerRun: TRACE_STEPS,
  samplesPerRun: first.trace.length,
  sha256: first.hash,
}));
