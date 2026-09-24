import assert from 'node:assert/strict';
import { CARS, FIXED_DT } from '../src/config.js';
import { createSuspensionState, solveMappedKcSuspension } from '../src/vehicle-v24/suspension.js';
import { createSteeringState, prepareSteeringTrial } from '../src/vehicle-v24/steering.js';

// Narrow regression for the canonical-corner application bug, not a road test.
// The separate browser recorder verifies the actual 140 km/h production maneuver.
const config = {
  mass: 1600,
  suspension: { springRate: 50000, travel: 0.3, antiRoll: 10000, damperBump: 3000, damperRebound: 4000 },
};
let checks = 0;
function close(a, b, label) {
  checks += 1;
  assert.ok(Math.abs(a - b) <= 1e-12, `${label}: ${a} != ${b}`);
}
for (const jounce of [-0.05, 0, 0.05]) {
  const staticCompression = config.mass * 9.81 / (4 * config.suspension.springRate);
  const result = solveMappedKcSuspension({
    previousState: createSuspensionState(config), config, dt: 1 / 120,
    steeringTrial: { oracleWheelAngles: { left: 0, right: 0 } },
    contacts: Array.from({ length: 4 }, () => ({
      inContact: true, compression: staticCompression + jounce, compressionRate: 0, gap: 0,
    })),
  });
  for (const [a, b] of [[0, 1], [2, 3]]) {
    close(result.corners[a].normalLoad, result.corners[b].normalLoad, `${jounce}: axle ${a}/${b} load`);
    close(result.corners[a].toe, -result.corners[b].toe, `${jounce}: axle ${a}/${b} toe`);
    close(result.corners[a].camber, -result.corners[b].camber, `${jounce}: axle ${a}/${b} camber`);
  }
  console.log(JSON.stringify({ jounce, corners: result.corners.map(({ normalLoad, toe, camber }) => ({ normalLoad, toe, camber })) }));
}

// Keep the existing low/medium/high-speed steering seam checks independently
// runnable, without importing a Rapier harness or replacing the real road test.
const mx5 = CARS.find((car) => car.id === 'mx5');
const positiveAngles = [];
function ok(condition, label) { checks += 1; assert.ok(condition, label); }
for (const speed of [2, 16, 40]) {
  for (const command of [-1, 1]) {
    let state = createSteeringState();
    let trial;
    for (let step = 0; step < 90; step += 1) {
      trial = prepareSteeringTrial({
        state, streetRushCommand: command, speed, dt: FIXED_DT,
        maximumAngle: mx5.steer, wheelbase: mx5.wheelbase, trackWidth: mx5.trackWidth,
      });
      state = trial.nextState;
    }
    ok(trial.streetRushVirtualAngle * command > 0, 'driver-left must retain positive host yaw');
    ok(trial.oracleWheelAngles.left * command < 0, 'the sole device-to-rack handedness seam must remain unchanged');
    if (command === 1) positiveAngles.push(trial.streetRushVirtualAngle);
    console.log(JSON.stringify({ speedMps: speed, command, angle: trial.streetRushVirtualAngle, speedAuthority: trial.speedAuthority }));
  }
}
ok(positiveAngles[0] > positiveAngles[1] && positiveAngles[1] > positiveAngles[2], 'speed assistance must remain progressive');
for (const [index, minimum] of [0.35, 0.16, 0.07].entries()) ok(positiveAngles[index] > minimum, `steering authority at speed case ${index}`);
console.log(`PASS: ${checks} assertions (18 suspension symmetry + 16 steering seam/authority)`);
