import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { CARS, FIXED_DT } from '../src/config.js';
import { updatePedal, resolveDriveIntent } from '../src/input.js';
import { createVehicleRig, destroyVehicleRig, stepVehicle, zeroInput, yawOf } from './physics-harness.mjs';

// Run from any directory: node scripts/record-flat-braking.mjs [--car=lp700] [--target-kmh=200]
// Observe the existing runtime. Do not set velocity, pose, wheel state, or physics tuning.
const root = fileURLToPath(new URL('../', import.meta.url));
const options = { car: 'lp700', 'target-kmh': '200' };
for (const arg of process.argv.slice(2)) {
  const match = /^--(car|target-kmh)=(.+)$/.exec(arg);
  if (!match) throw new Error(`Unknown argument: ${arg}. Use --car=lp700 --target-kmh=200`);
  options[match[1]] = match[2];
}
const car = CARS.find((item) => item.id === options.car);
const targetKmh = Number(options['target-kmh']);
if (!car || !Number.isFinite(targetKmh) || targetKmh <= 0) throw new Error('Invalid car or target speed');
const outputRoot = path.join(root, 'research-output/flat-braking');
fs.mkdirSync(outputRoot, { recursive: true });
const out = fs.mkdtempSync(path.join(outputRoot, `${car.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
const writeJSON = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const sourceFiles = ['src/config.js', 'src/input.js', 'src/vehicle.js', 'src/vehicle-physics.js', 'src/rapier-init.js',
  'scripts/physics-harness.mjs', 'scripts/record-flat-braking.mjs', 'package.json'];
function includeSources(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) includeSources(relative);
    else if (entry.name.endsWith('.js')) sourceFiles.push(relative);
  }
}
includeSources('src/vehicle-v24');
const hashes = () => Object.fromEntries(sourceFiles.map((name) => [name,
  createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const beforeHashes = hashes();
let revision = null;
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* Hashes are authoritative for dirty sources. */ }
writeJSON('metadata.json', {
  createdAt: new Date().toISOString(), car, targetKmh, physicsMode: 'v24-active', dtSeconds: FIXED_DT,
  protocol: '2 s settling; W from rest until forward speed reaches target; next step release W and press S; zero steering throughout.',
  input: 'Uses production updatePedal and resolveDriveIntent at 120 Hz. S retains production brake/reverse semantics; abort on reverse engagement.',
  scene: 'Rapier fixed horizontal cuboid, top y=0, 24 km square; FlatTrack asphalt, grip=1; no scenery, collisions with other objects, or artificial disturbances.',
  stop: '3D speed < 0.5 km/h and angular speed < 0.05 rad/s for 0.1 s; abort on automatic reset, reverse, invalid state, or time limit.',
  limitsSeconds: { acceleration: 90, braking: 30 },
  timing: 'bodyBefore and bodyAfter bracket fixedUpdate -> world.step -> afterPhysics. report is that step’s vehicle solver output, NOT an afterPhysics resample.',
  units: 'SI except explicit Kmh/Deg columns. Wheel order FL FR RL RR. Local +Z forward, +X lateral, +Y up. tire force columns = solver impulse / dt.',
  scope: 'Headless minimal-scene reproduction using the game vehicle runtime; does not certify browser input/render scheduling or production track parity.',
  revision, sourceSha256: beforeHashes,
});

const plain = (v) => ({ x: v.x, y: v.y, z: v.z, ...(v.w === undefined ? {} : { w: v.w }) });
function bodyState(body) {
  const rotation = plain(body.rotation()), velocity = plain(body.linvel());
  const local = new THREE.Vector3(velocity.x, velocity.y, velocity.z)
    .applyQuaternion(new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).invert());
  const horizontalKmh = Math.hypot(velocity.x, velocity.z) * 3.6;
  return {
    position: plain(body.translation()), rotation, velocity, angularVelocity: plain(body.angvel()),
    worldCom: plain(body.worldCom()), localCom: plain(body.localCom()),
    forwardKmh: local.z * 3.6, lateralKmh: local.x * 3.6,
    horizontalKmh, totalKmh: Math.hypot(velocity.x, velocity.y, velocity.z) * 3.6,
    // Suppress meaningless standstill angles; preserve full atan2 range if the vehicle spins backwards.
    sideslipDeg: horizontalKmh > 5 ? Math.atan2(local.x, local.z) * 180 / Math.PI : null,
    yaw: yawOf(rotation),
  };
}

const rig = createVehicleRig(car, { vehiclePhysicsMode: 'v24-active' });
const rawFile = fs.openSync(path.join(out, 'steps.jsonl'), 'wx');
const csvFile = fs.openSync(path.join(out, 'telemetry.csv'), 'wx');
const rows = [], events = [];
let columns, phase = 'settle', phaseSteps = 0, throttle = 0, brake = 0;
let brakeStart = null, lastYaw = bodyState(rig.vehicle.body).yaw, unwrappedYaw = 0;
let outcome = 'INCOMPLETE', caughtError = null, resetReason = null, stoppedSteps = 0;
rig.vehicle.onAutomaticReset = (reason) => { resetReason = reason; };
const seen = new Set();
function eventOnce(type, row) {
  if (seen.has(type)) return;
  seen.add(type); events.push({ type, ...row });
}
try {
  for (let step = 0; step < Math.ceil(122 / FIXED_DT); step += 1) {
    const bodyBefore = bodyState(rig.vehicle.body);
    if (phase === 'settle' && phaseSteps >= Math.round(2 / FIXED_DT)) {
      phase = 'accelerate'; phaseSteps = 0;
    } else if (phase === 'accelerate' && bodyBefore.forwardKmh >= targetKmh) {
      phase = 'brake'; phaseSteps = 0;
      brakeStart = { time: step * FIXED_DT, body: bodyBefore, yaw: unwrappedYaw, pathM: 0 };
    }
    const rawThrottle = Number(phase === 'accelerate'), rawBrake = Number(phase === 'brake');
    throttle = updatePedal(throttle, rawThrottle, 4.3, 7.5, FIXED_DT);
    brake = updatePedal(brake, rawBrake, 7.5, 11, FIXED_DT);
    const input = zeroInput({ throttle, brake, rawThrottle, rawBrake, driveIntent: resolveDriveIntent(rawThrottle, rawBrake) });
    stepVehicle(rig, input);
    const bodyAfter = bodyState(rig.vehicle.body), report = rig.vehicle.getVehiclePhysicsReport();
    unwrappedYaw += Math.atan2(Math.sin(bodyAfter.yaw - lastYaw), Math.cos(bodyAfter.yaw - lastYaw));
    lastYaw = bodyAfter.yaw;
    const o = report?.output ?? {}, solver = report?.solver ?? {}, assists = solver.assistDiagnostics ?? {};
    const row = {
      step, timeS: (step + 1) * FIXED_DT, phase, phaseTimeS: (phaseSteps + 1) * FIXED_DT,
      rawThrottle, rawBrake, steerInput: input.steer, throttleInput: throttle, brakeInput: brake,
      driveIntent: input.driveIntent, appliedThrottle: o.throttle, appliedBrake: o.brake,
      forwardKmh: bodyAfter.forwardKmh, lateralKmh: bodyAfter.lateralKmh, horizontalKmh: bodyAfter.horizontalKmh,
      totalKmh: bodyAfter.totalKmh, xM: bodyAfter.position.x, yM: bodyAfter.position.y, zM: bodyAfter.position.z,
      vxMps: bodyAfter.velocity.x, vyMps: bodyAfter.velocity.y, vzMps: bodyAfter.velocity.z,
      yawRateRadS: bodyAfter.angularVelocity.y, pitchRateRadS: bodyAfter.angularVelocity.x, rollRateRadS: bodyAfter.angularVelocity.z,
      yawFromStartDeg: unwrappedYaw * 180 / Math.PI,
      yawFromBrakeDeg: brakeStart ? (unwrappedYaw - brakeStart.yaw) * 180 / Math.PI : null,
      sideslipDeg: bodyAfter.sideslipDeg,
      longitudinalAccelMps2: (bodyAfter.forwardKmh - bodyBefore.forwardKmh) / (3.6 * FIXED_DT),
      steerAngleRad: o.steerAngle, gear: o.gear, reverse: o.reverse, rpm: o.engineRpm,
      groundedCount: o.groundedCount, frontBrakeShare: assists.serviceBrakeFrontShare,
      frontLoadShare: assists.serviceBrakeFrontLoadShare, absActive: o.absActive, tcsActive: o.tcsActive,
      escActive: o.stabilityActive, desiredYawRadS: assists.desiredYaw, yawErrorRadS: assists.yawError,
      driveTorqueNm: o.powertrain?.wheelDriveTorqueAppliedNm,
      serviceBrakeTorqueNm: o.powertrain?.serviceBrakeTorqueAppliedNm,
      solverStatus: report?.status, scaledResidual: solver.scaledResidual,
    };
    for (const [i, label] of ['FL', 'FR', 'RL', 'RR'].entries()) {
      const w = o.wheels?.[i] ?? {}, b = solver.brakeDiagnostics?.[i] ?? {}, g = solver.geometryDiagnostics?.[i] ?? {};
      const values = {
        loadN: w.load, grounded: w.grounded, wheelOmegaRadS: o.wheelOmega?.[i], suspensionM: w.suspension,
        slipRatio: w.slipRatio, slipAngleRad: w.slipAngle, contactForwardMps: g.velocityX, contactLateralMps: g.velocityY,
        tireForwardN: solver.tireDiagnostics?.[i]?.impulse?.[0] / FIXED_DT,
        tireLateralN: solver.tireDiagnostics?.[i]?.impulse?.[1] / FIXED_DT,
        toeRad: g.toe, camberRad: g.camber, steeringAngleRad: g.steeringAngle,
        brakeTorqueNm: b.appliedTorque, brakeRegime: b.regime,
        absModulation: assists.absModulation?.[i], assistSlip: assists.wheelSlip?.[i],
        driverBrakeCapacityNm: assists.driverServiceCapacity?.[i],
        tcsBrakeCapacityNm: assists.tcsBrakeCapacity?.[i], escBrakeCapacityNm: assists.escBrakeCapacity?.[i],
      };
      for (const [key, value] of Object.entries(values)) row[`${label}_${key}`] = value;
    }
    fs.writeSync(rawFile, `${JSON.stringify({ ...row, input, bodyBefore, bodyAfter, report, resetReason })}\n`);
    if (!columns) { columns = Object.keys(row); fs.writeSync(csvFile, `${columns.join(',')}\n`); }
    fs.writeSync(csvFile, `${columns.map((key) => JSON.stringify(row[key] ?? '')).join(',')}\n`);
    rows.push(row); phaseSteps += 1;
    if (phase === 'brake') {
      brakeStart.pathM += Math.hypot(bodyAfter.position.x - bodyBefore.position.x, bodyAfter.position.z - bodyBefore.position.z);
      if (Math.abs(row.yawRateRadS) > 0.06 && row.horizontalKmh > 20) eventOnce('YAW_RATE_OVER_0.06_RAD_S', row);
      if (Math.abs(row.yawFromBrakeDeg) > 5 && row.horizontalKmh > 20) eventOnce('HEADING_DEVIATION_OVER_5_DEG', row);
      if (Math.abs(row.sideslipDeg) > 5 && row.horizontalKmh > 20) eventOnce('SIDESLIP_OVER_5_DEG', row);
      if (row.RL_loadN <= 0 || row.RR_loadN <= 0) eventOnce('REAR_ZERO_NORMAL_LOAD', row);
      if (row.groundedCount < 4) eventOnce('FEWER_THAN_FOUR_GROUNDED', row);
      const angularSpeed = Math.hypot(...Object.values(bodyAfter.angularVelocity));
      stoppedSteps = bodyAfter.totalKmh < 0.5 && angularSpeed < 0.05 ? stoppedSteps + 1 : 0;
    }
    if (resetReason) { outcome = 'AUTOMATIC_RESET'; break; }
    if (o.reverse) { outcome = 'REVERSE_ENGAGED'; break; }
    if (report?.mode !== 'v24-active' || report?.status !== 'COMMITTED') { outcome = 'RUNTIME_NOT_COMMITTED'; break; }
    if (Object.values(row).some((value) => typeof value === 'number' && !Number.isFinite(value))) { outcome = 'NONFINITE_DATA'; break; }
    if (stoppedSteps >= Math.round(0.1 / FIXED_DT)) { outcome = 'STOPPED'; break; }
    if (phase === 'accelerate' && phaseSteps * FIXED_DT >= 90) { outcome = 'TARGET_NOT_REACHED'; break; }
    if (phase === 'brake' && phaseSteps * FIXED_DT >= 30) { outcome = 'BRAKE_TIMEOUT'; break; }
  }
} catch (error) { outcome = 'ERROR'; caughtError = error.stack; }
finally {
  fs.closeSync(rawFile); fs.closeSync(csvFile);
  destroyVehicleRig(rig);
}

const braking = rows.filter((row) => row.phase === 'brake');
const movingBraking = braking.filter((row) => row.horizontalKmh > 20);
const maxAbs = (samples, key) => samples.length ? Math.max(...samples.map((row) => Math.abs(row[key] ?? 0))) : null;
const end = rows.at(-1);
const summary = {
  outcome, error: caughtError, car: car.id, targetKmh, outputDirectory: out, samples: rows.length,
  sourceUnchangedDuringRun: JSON.stringify(beforeHashes) === JSON.stringify(hashes()),
  zeroSteeringEveryStep: rows.every((row) => row.steerInput === 0 && row.steerAngleRad === 0),
  runtimeCommittedEveryStep: rows.every((row) => row.solverStatus === 'COMMITTED'),
  automaticReset: resetReason,
  reachedTarget: Boolean(brakeStart), brakeEntryForwardKmh: brakeStart?.body.forwardKmh ?? null,
  accelerateSeconds: rows.filter((row) => row.phase === 'accelerate').length * FIXED_DT,
  brakeSeconds: braking.length * FIXED_DT, brakePathM: brakeStart?.pathM ?? null,
  maxHeadingDeviationWhileBrakingDeg: maxAbs(braking, 'yawFromBrakeDeg'),
  maxSideslipAbove20KmhDeg: maxAbs(movingBraking, 'sideslipDeg'),
  maxYawRateAbove20KmhRadS: maxAbs(movingBraking, 'yawRateRadS'),
  maxLateralDepartureFromBrakePointM: brakeStart ? Math.max(...braking.map((row) => Math.abs(row.xM - brakeStart.body.position.x))) : null,
  minRearLoadN: braking.length ? Math.min(...braking.flatMap((row) => [row.RL_loadN, row.RR_loadN])) : null,
  finalTotalKmh: end?.totalKmh, finalHorizontalKmh: end?.horizontalKmh,
  finalHeadingDeviationDeg: end?.yawFromBrakeDeg, events,
};
writeJSON('summary.json', summary);
console.log(JSON.stringify({ ...summary, events: events.map(({ type, phaseTimeS, horizontalKmh }) => ({ type, phaseTimeS, horizontalKmh })) }, null, 2));
if (outcome !== 'STOPPED' || !summary.sourceUnchangedDuringRun) process.exitCode = 1;
