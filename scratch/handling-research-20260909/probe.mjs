import fs from 'node:fs';
import { CARS, FIXED_DT } from '../../src/config.js';
import { updateKeyboardSteer, updatePedal, resolveDriveIntent } from '../../src/input.js';
import { createVehicleRig, destroyVehicleRig, settleVehicle, stepVehicle, zeroInput, yawOf } from '../../scripts/physics-harness.mjs';

// Research-only probes; imports the unchanged production vehicle runtime on a flat Rapier road.
const outputDir = new URL('./', import.meta.url);
const scenarios = [
  { name: 'straight-brake', turn: 0, brake: 1, steerAfter: 0 },
  { name: 'turn-coast', turn: 0.3, brake: 0, steerAfter: 0 },
  { name: 'turn-brake-release-steer', turn: 0.3, brake: 1, steerAfter: 0 },
  { name: 'turn-brake-hold-steer', turn: 0.3, brake: 1, steerAfter: 0.3 },
];
const summaries = [];
for (const id of ['mx5', 'lp700', 'm5g90']) {
  for (const scenario of scenarios) {
    const car = CARS.find(c => c.id === id);
    const rig = createVehicleRig(car, { vehiclePhysicsMode: 'v24-active' });
    let resets = 0;
    rig.vehicle.onAutomaticReset = () => resets++;
    const rows = [];
    let initialYaw = 0;
    let totalYaw = 0;
    let lastYaw = 0;
    const record = (phase, i) => {
      const report = rig.vehicle.getVehiclePhysicsReport();
      const body = rig.vehicle.body;
      const q = body.rotation(), v = body.linvel(), w = body.angvel();
      const yaw = yawOf(q);
      totalYaw += Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw));
      lastYaw = yaw;
      const forward = { x: 2*(q.x*q.z+q.w*q.y), y: 2*(q.y*q.z-q.w*q.x), z: 1-2*(q.x*q.x+q.y*q.y) };
      const right = { x: 1-2*(q.y*q.y+q.z*q.z), y: 2*(q.x*q.y+q.w*q.z), z: 2*(q.x*q.z-q.w*q.y) };
      const vx = v.x*forward.x+v.y*forward.y+v.z*forward.z;
      const vy = v.x*right.x+v.y*right.y+v.z*right.z;
      const o = report?.output;
      const d = report?.solver?.assistDiagnostics;
      rows.push({ phase, t: i*FIXED_DT, speed: vx*3.6, yawRate: w.y, heading: totalYaw*180/Math.PI,
        betaDeg: Math.atan2(vy, Math.abs(vx))*180/Math.PI,
        load: o?.wheels.map(x=>x.load), omega: o?.wheelOmega,
        trueKappa: o?.wheels.map(x=>x.slipRatio), alpha: o?.wheels.map(x=>x.slipAngle),
        assistSlip: d?.wheelSlip, abs: d?.absModulation, esc: d?.escBrakeCapacity, tcs: d?.tcsBrakeCapacity,
        frontShare: d?.serviceBrakeFrontShare, desiredYaw: d?.desiredYaw, yawError: d?.yawError,
        brake: report?.solver?.brakeDiagnostics, geometry: report?.solver?.geometryDiagnostics,
        powertrain: o?.powertrain, throttle: o?.throttle, brakeInput: o?.brake, engineLoad: o?.engineLoad,
        rpm: o?.engineRpm, gear: o?.gear, steerAngle: o?.steerAngle, resets,
        tireRegime: o?.wheels.map(x=>x.regime), solverResidual: report?.solver?.scaledResidual });
    };
    try {
      settleVehicle(rig, 1.5);
      let steps = 0;
      while (rig.vehicle.telemetry.speedKmh < 140 && steps < 4800) {
        stepVehicle(rig, zeroInput({ throttle: 1, driveIntent: 1 }));
        steps++;
      }
      initialYaw = yawOf(rig.vehicle.body.rotation()); lastYaw = initialYaw;
      for (let i=0;i<96;i++) {
        stepVehicle(rig, zeroInput({ throttle: 0.15, steer: scenario.turn, driveIntent: 1 }));
        record('entry',i);
      }
      for (let i=0;i<720;i++) {
        stepVehicle(rig, zeroInput({ brake: scenario.brake, steer: scenario.steerAfter, driveIntent: 0 }));
        record('brake-or-coast',i);
        if (resets || Math.abs(rig.vehicle.telemetry.signedSpeedKmh)<0.1) break;
      }
      const braking=rows.filter(r=>r.phase==='brake-or-coast');
      const max=(key)=>Math.max(...braking.map(r=>Math.abs(r[key])));
      const summary={car:id,scenario:scenario.name,startSpeed:rows[0].speed,brakeEntry:braking[0],
        maxYawRate:max('yawRate'),maxBetaDeg:max('betaDeg'),maxHeadingDeg:max('heading'),
        minRearLoad:Math.min(...braking.flatMap(r=>r.load.slice(2))),
        tcsSteps:braking.filter(r=>r.tcs.some(x=>x>0)||r.engineLoad===0).length,
        escSteps:braking.filter(r=>r.esc.some(x=>x>0)).length,
        final:braking.at(-1),resets};
      summaries.push(summary);
      console.log(JSON.stringify({car:id,scenario:scenario.name,maxYawRate:summary.maxYawRate,maxBeta:summary.maxBetaDeg,maxHeading:summary.maxHeadingDeg,finalSpeed:summary.final.speed,minRearLoad:summary.minRearLoad,resets}));
    } catch(error) {
      const summary={car:id,scenario:scenario.name,error:error.message,audit:error.audit,resets};
      summaries.push(summary); console.log(JSON.stringify({car:id,scenario:scenario.name,error:error.message}));
    } finally {
      fs.writeFileSync(new URL(`${id}-${scenario.name}.json`,outputDir),JSON.stringify(rows));
      destroyVehicleRig(rig);
    }
  }
}
fs.writeFileSync(new URL('summary.json',outputDir),JSON.stringify(summaries,null,2));
