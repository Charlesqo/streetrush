import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

const FIXED_BUDGET_MS = FIXED_DT * 1000;
const WARMUP_STEPS = 240;
const MEASURED_STEPS = 1200;

function percentile(sortedValues, quantile) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)];
}

function inputAt(step) {
  const phase = step % 600;
  if (phase < 420) {
    return zeroInput({
      throttle: 0.72,
      steer: 0.24 * Math.sin(step * 0.017),
      driveIntent: 1,
    });
  }
  return zeroInput({ brake: 0.55, driveIntent: -1 });
}

const rig = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
const elapsed = [];
const solverElapsed = [];
let committedSteps = 0;
try {
  for (let step = 0; step < WARMUP_STEPS; step += 1) stepVehicle(rig, inputAt(step));
  for (let step = 0; step < MEASURED_STEPS; step += 1) {
    const startedAt = performance.now();
    stepVehicle(rig, inputAt(WARMUP_STEPS + step));
    elapsed.push(performance.now() - startedAt);
    const report = rig.vehicle.getVehiclePhysicsReport();
    assert.equal(report.status, 'COMMITTED', `performance step ${step} did not commit`);
    solverElapsed.push(report.elapsedMs);
    committedSteps += 1;
  }
} finally {
  destroyVehicleRig(rig);
}

elapsed.sort((a, b) => a - b);
solverElapsed.sort((a, b) => a - b);
const meanMs = elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length;
const p95Ms = percentile(elapsed, 0.95);
const p99Ms = percentile(elapsed, 0.99);
const maxMs = elapsed.at(-1);
const overrunCount = elapsed.filter((value) => value > FIXED_BUDGET_MS).length;
const overrunRatio = overrunCount / elapsed.length;

assert.equal(committedSteps, MEASURED_STEPS, 'performance run missed committed steps');
assert.ok(meanMs < FIXED_BUDGET_MS * 0.5, `mean fixed-step time ${meanMs} ms exceeds half the 120 Hz budget`);
assert.ok(p95Ms < FIXED_BUDGET_MS, `p95 fixed-step time ${p95Ms} ms exceeds the 120 Hz budget`);
assert.ok(p99Ms < FIXED_BUDGET_MS, `p99 fixed-step time ${p99Ms} ms exceeds the 120 Hz budget`);
assert.ok(overrunRatio <= 0.01, `${overrunCount}/${MEASURED_STEPS} fixed steps exceeded the 120 Hz budget`);

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.performance.v1',
  status: 'PASS',
  checks: 5,
  fixedHz: Math.round(1 / FIXED_DT),
  warmupSteps: WARMUP_STEPS,
  measuredSteps: MEASURED_STEPS,
  fixedBudgetMs: FIXED_BUDGET_MS,
  endToEndMs: { mean: meanMs, p95: p95Ms, p99: p99Ms, max: maxMs },
  solverMs: {
    p95: percentile(solverElapsed, 0.95),
    p99: percentile(solverElapsed, 0.99),
    max: solverElapsed.at(-1),
  },
  overrunCount,
  overrunRatio,
}));
