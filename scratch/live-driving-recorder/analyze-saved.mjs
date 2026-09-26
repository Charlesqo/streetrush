import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const root = new URL('../../', import.meta.url);
const directory = new URL('research-output/live-driving/', root);
const output = new URL('research-output/live-driving-analysis/', root);
fs.mkdirSync(output, { recursive: true });
const deg = 180 / Math.PI;
const rounded = v => typeof v === 'number' ? Number(v.toFixed(4)) : v;
for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(new URL(name, directory)));
  if (data.vehicleConfig?.id !== 'lp700') continue;
  let previousYaw, heading = 0;
  const rows = data.samples.map((sample, i) => {
    const b = sample.bodyAfter, q = new THREE.Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
    const v = new THREE.Vector3(b.velocity.x, b.velocity.y, b.velocity.z).applyQuaternion(q.clone().invert());
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const yaw = Math.atan2(forward.x, forward.z);
    if (i) heading += Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw));
    previousYaw = yaw;
    const speed = Math.hypot(b.velocity.x, b.velocity.z) * 3.6;
    const o = sample.report?.output ?? {}, a = sample.report?.solver?.assistDiagnostics ?? {};
    const g = sample.report?.solver?.geometryDiagnostics ?? [];
    return {
      index: i, step: sample.stepIndex, t: i * sample.dt, wallS: (sample.wallTimeMs - data.samples[0].wallTimeMs) / 1000,
      speed, longitudinalKmh: v.z * 3.6, lateralKmh: v.x * 3.6,
      beta: speed > 20 ? Math.atan2(v.x, v.z) * deg : null,
      yawRate: b.angularVelocity.y, heading: heading * deg,
      y: b.position.y, tiltDeg: Math.acos(Math.max(-1, Math.min(1, new THREE.Vector3(0, 1, 0).applyQuaternion(q).y))) * deg,
      x: b.position.x, z: b.position.z,
      steerInput: sample.input.steer, steerDeg: o.steerAngle * deg,
      rawThrottle: sample.input.rawThrottle, rawBrake: sample.input.rawBrake,
      throttle: o.throttle, brake: o.brake, handbrake: sample.input.handbrake,
      grounded: o.groundedCount, loads: o.wheels?.map(w => w.load), surfaces: o.wheels?.map(w => w.surface),
      slipRatios: o.wheels?.map(w => w.slipRatio), slipAnglesDeg: o.wheels?.map(w => w.slipAngle * deg),
      wheelSpeed: o.wheelOmega, wheelSteerDeg: g.map(w => w.steeringAngle * deg),
      wheelTravelDirectionDeg: g.map(w => Math.atan2(w.velocityY, w.velocityX) * deg),
      brakeTorque: sample.report?.solver?.brakeDiagnostics?.map(w => w.appliedTorque),
      abs: a.absModulation, esc: a.escBrakeCapacity, tcs: a.tcsBrakeCapacity, assistSlip: a.wheelSlip,
      frontBrakeShare: a.serviceBrakeFrontShare, desiredYaw: a.desiredYaw,
      geometricDemandG: Math.abs(o.signedSpeed * a.desiredYaw) / 9.81,
      driveTorque: o.powertrain?.wheelDriveTorqueAppliedNm, reverse: o.reverse,
      status: sample.report?.status,
    };
  });
  const clean = row => row && Object.fromEntries(Object.entries(row).map(([k,v]) => [k, Array.isArray(v) ? v.map(rounded) : rounded(v)]));
  const max = key => Math.max(...rows.map(r => Math.abs(r[key] ?? 0)));
  const transitions = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].grounded !== rows[i-1].grounded || rows[i].surfaces.join() !== rows[i-1].surfaces.join()) transitions.push(clean(rows[i]));
  }
  const events = data.events.filter(e => !e.repeat).map(e => ({...e, relativeS:(e.wallTimeMs-data.samples[0].wallTimeMs)/1000}));
  const summary = {
    file: name, clickedAt: data.createdAt, firstAlreadyTurning: Math.abs(rows[0].steerInput)>0.05,
    sourceUnchanged: data.sourceUnchangedAtSave, samples: rows.length,
    continuous: rows.every((r,i)=>!i||r.step===rows[i-1].step+1),
    max: Object.fromEntries(['speed','beta','yawRate','heading','tiltDeg','steerInput','steerDeg','geometricDemandG'].map(k=>[k,max(k)])),
    minGrounded:Math.min(...rows.map(r=>r.grounded)),
    events, first:clean(rows[0]), last:clean(rows.at(-1)),
    checkpoints: rows.filter((r,i)=>i%60===0).map(clean), transitions,
  };
  fs.writeFileSync(new URL(name.replace('.json','.analysis.json'),output),JSON.stringify(summary,null,2));
  fs.writeFileSync(new URL(name.replace('.json','.rows.json'),output),JSON.stringify(rows));
  console.log(JSON.stringify({file:name,sourceUnchanged:summary.sourceUnchanged,continuous:summary.continuous,max:summary.max,minGrounded:summary.minGrounded,
    events:events.map(({type,code,relativeS})=>({type,code,t:rounded(relativeS)})),
    checkpoints:summary.checkpoints.map(({t,speed,beta,yawRate,heading,steerInput,steerDeg,rawThrottle,rawBrake,grounded,loads,surfaces,geometricDemandG})=>({t,speed,beta,yawRate,heading,steerInput,steerDeg,rawThrottle,rawBrake,grounded,loads,surfaces,geometricDemandG}))},null,2));
}
