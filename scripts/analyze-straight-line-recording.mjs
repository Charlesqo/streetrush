import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read a saved production run only. No alternative simulator or replay input path.
const path = resolve(process.argv[2]);
const raw = readFileSync(path, 'utf8');
const run = JSON.parse(raw);
assert.equal(run.schema, 'streetrush.straight-line-recording.v1');
assert.ok(run.samples.length > 0);
const samples = run.samples;
const max = (rows, value) => Math.max(0, ...rows.map(value));
const abs = (value) => Math.abs(value);
const phases = [...new Set(samples.map((s) => s.phase))].map((phase) => {
  const rows = samples.filter((s) => s.phase === phase);
  return {
    phase, samples: rows.length, startTime: rows[0].time, endTime: rows.at(-1).time,
    startSpeedKmh: rows[0].body.speedKmh, endSpeedKmh: rows.at(-1).body.speedKmh,
    startHeadingDeg: rows[0].body.headingChangeDeg, endHeadingDeg: rows.at(-1).body.headingChangeDeg,
    maximumAbsHeadingDeg: max(rows, (s) => abs(s.body.headingChangeDeg)),
    maximumAbsYawRate: max(rows, (s) => abs(s.body.angularVelocity.y)),
    startLateralM: rows[0].body.lateralDisplacementM, endLateralM: rows.at(-1).body.lateralDisplacementM,
    maximumAbsLateralM: max(rows, (s) => abs(s.body.lateralDisplacementM)),
  };
});
const timedAccelerationSeconds = run.protocol?.accelerationSeconds ?? null;
const accelerationRows = samples.filter((s) => s.phase === 'accelerate');
const actualAccelerationSeconds = accelerationRows.length * run.fixedDt;
const fullThrottleSeconds = accelerationRows.filter((s) => s.input.rawThrottle >= 0.99 && s.input.driveIntent > 0).length * run.fixedDt;
const limits = { minimumTargetSpeedKmh: run.targetSpeedKmh ?? 140, maximumAbsHeadingDeg: 3, maximumAbsLateralM: 0.5, maximumAbsYawRate: 0.1, stoppedSpeedKmh: 0.5 };
const checks = {
  highSpeedReached: samples.some((s) => s.phase === 'accelerate' && s.body.signedSpeedKmh >= limits.minimumTargetSpeedKmh),
  ...(timedAccelerationSeconds ? {
    fullAccelerationDuration: actualAccelerationSeconds >= timedAccelerationSeconds - run.fixedDt,
    fullThrottleHeld: fullThrottleSeconds >= timedAccelerationSeconds - 0.5,
  } : {}),
  allFixedStepsRetained: samples.every((s, i) => i === 0 || (
    s.fixedStepIndex === samples[i - 1].fixedStepIndex + 1 && abs(s.time - samples[i - 1].time - run.fixedDt) < 1e-9
  )),
  zeroSteeringAndHandbrake: samples.every((s) => s.input.steer === 0 && s.input.rawHandbrake === 0),
  allReportsCommitted: samples.every((s) => s.reportStatus === 'COMMITTED'),
  noAutomaticRecovery: !run.events.some((event) => event.type === 'automatic-reset') && !run.endReason.startsWith('AUTOMATIC_RESET'),
  stoppedNormally: run.endReason === 'STOPPED' && samples.at(-1).body.speedKmh < limits.stoppedSpeedKmh,
  headingStayedStraight: max(samples, (s) => abs(s.body.headingChangeDeg)) <= limits.maximumAbsHeadingDeg,
  stayedInStraightCorridor: max(samples, (s) => abs(s.body.lateralDisplacementM)) <= limits.maximumAbsLateralM,
  noRapidYaw: max(samples, (s) => abs(s.body.angularVelocity.y)) <= limits.maximumAbsYawRate,
  noUncommandedEsc: samples.every((s) => Array.isArray(s.assists?.escBrakeCapacity) && s.assists.escBrakeCapacity.every((v) => v === 0)),
};
const summary = {
  recording: path, sha256: createHash('sha256').update(raw).digest('hex'), runId: run.runId,
  automatedStatus: Object.values(checks).every(Boolean) ? 'PASS_STRAIGHT_BRAKING_AUTOMATED' : 'FAIL_STRAIGHT_BRAKING_AUTOMATED',
  scope: timedAccelerationSeconds
    ? `This ${timedAccelerationSeconds} s continuous-throttle production straight-line maneuver only; user handling acceptance remains pending.`
    : 'This 140 km/h production straight-line maneuver only; user handling acceptance remains pending.',
  sampleCount: samples.length, endReason: run.endReason, limits, checks, phases,
  maximumSpeedKmh: max(samples, (s) => s.body.speedKmh),
  ...(timedAccelerationSeconds ? {
    protocol: run.protocol, actualAccelerationSeconds, fullThrottleSeconds,
    carId: run.configuration.id,
  } : {}),
  events: run.events,
};

// Every sample/leaf field is exported; the original JSON remains authoritative.
function flatten(value, prefix = '', result = {}) {
  if (value !== null && typeof value === 'object' && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result);
  } else result[prefix] = value;
  return result;
}
const rows = samples.map((sample) => flatten(sample));
const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
const csvValue = (value) => {
  const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
function saveWithoutReplacing(target, contents) {
  try { writeFileSync(target, contents, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(target, 'utf8') !== contents) throw error;
  }
}
const prefix = path.replace(/\.json$/, '');
saveWithoutReplacing(`${prefix}.csv`, `${columns.map(csvValue).join(',')}\n${rows.map((row) => columns.map((key) => csvValue(row[key])).join(',')).join('\n')}\n`);
saveWithoutReplacing(`${prefix}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, csvColumns: columns.length, csvRows: rows.length }, null, 2));
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
