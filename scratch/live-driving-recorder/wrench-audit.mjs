import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import * as THREE from 'three';

// Research-only instrumentation and counterfactuals. No production file edits.
const variant = process.argv[2] ?? 'baseline';
const scenario = process.argv[3] ?? 'tap';
if (!['baseline', 'brake-net', 'all-net'].includes(variant)) throw Error('Unknown variant');
if (!['tap', 'straight'].includes(scenario)) throw Error('Unknown scenario');
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/src/vehicle-v24/runtime.js')) return result;
  let source = String(result.source);
  const replace = (from, to) => {
    if (!source.includes(from)) throw Error('Research seam changed: ' + from);
    source = source.replace(from, to);
  };
  if (variant !== 'baseline') {
    replace('function sumBodyTorqueFromHubs(contacts, powertrain, brakeResults)',
      'function sumBodyTorqueFromHubs(contacts, powertrain, brakeResults, tireOutputs = null)');
    replace('const wheelActuatorTorque = powertrain.wheelDriveTorque[index] + brakeTorqueSigned;',
      'const wheelActuatorTorque = powertrain.wheelDriveTorque[index] + brakeTorqueSigned + (tireOutputs?.[index].wheelContactTorque ?? 0);');
    replace('const hubReactionTorque = sumBodyTorqueFromHubs(contacts, powertrain, brakeResults);',
      `const hubReactionTorque = sumBodyTorqueFromHubs(contacts, powertrain, brakeResults, ${variant === 'all-net' ? 'tireOutputs' : 'gearboxTrial.serviceBrake > 0 ? tireOutputs : null'});`);
  }
  replace('let actionReaction = [];',
    'globalThis.__auditWrench({ contacts, powertrain, brakeResults, tireOutputs, mechanicsState, wheelOmega, bodySample, hubReactionTorque, wrenchBatch, suspensionTrial, dt });\n      let actionReaction = [];');
  return { ...result, source };
} });
const { CARS, FIXED_DT } = await import('../../src/config.js');
const { updateKeyboardSteer, updatePedal, resolveDriveIntent } = await import('../../src/input.js');
const { createVehicleRig, stepVehicle, zeroInput, destroyVehicleRig } = await import('../../scripts/physics-harness.mjs');
const files = ['runtime.js', 'powertrain.js', 'rapier-host-adapter.js', 'tire.js'].map(n => new URL(`../../src/vehicle-v24/${n}`, import.meta.url));
const hashes = () => Object.fromEntries(files.map(f => [f.pathname, createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
const before = hashes();
const dot = (a, b) => a.x*b.x+a.y*b.y+a.z*b.z;
const cross = (a, b) => ({ x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x });
const sub = (a, b) => ({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const scale = (a, s) => ({x:a.x*s,y:a.y*s,z:a.z*s});
const sum = xs => xs.reduce((a,b) => a+b, 0);
let audit;
globalThis.__auditWrench = s => {
  const pitch = s.bodySample.axes.right;
  const wheels = s.contacts.map((c, i) => {
    const drive = s.powertrain.wheelDriveTorque[i];
    const brake = s.brakeResults[i].impulse / s.dt;
    const contact = s.tireOutputs[i].wheelContactTorque;
    const spinChange = 1.25 * (s.wheelOmega[i] - s.mechanicsState.wheelOmega[i]) / s.dt;
    return { drive, brake, contact, spinChange,
      spinEquationResidual: spinChange - drive - brake - contact,
      spinChangePitch: dot(scale(c.lateral, -spinChange), pitch),
      inContact: c.inContact, load: s.suspensionTrial.corners[i].normalLoad,
      omega: s.wheelOmega[i] };
  });
  const longitudinalContactPitch = sum(s.contacts.map((c, i) =>
    dot(cross(sub(c.point, s.bodySample.worldCom), scale(c.forward, s.tireOutputs[i].forceX)), pitch)));
  const roadPitch = sum(s.wrenchBatch.contacts.map(c =>
    dot(cross(sub(c.point, s.bodySample.worldCom), c.forceWorld), pitch) + dot(c.momentWorld, pitch)));
  const extraPitch = dot(s.hubReactionTorque, pitch);
  const wheelSpinChangePitch = sum(wheels.map(w => w.spinChangePitch));
  audit = { longitudinalContactPitch, roadPitch, extraPitch, wheelSpinChangePitch,
    // Frozen-axis spin exchange only, not a complete engine/gyro/Rapier conservation residual.
    frozenAxisExchangeResidual: extraPitch + wheelSpinChangePitch,
    wheels };
};
const rig = createVehicleRig(CARS.find(c => c.id === 'gt3rs'), { vehiclePhysicsMode: 'v24-active' });
const rows = [];
let input = zeroInput(), reset = null, step = 0;
rig.vehicle.onAutomaticReset = reason => { reset = reason; };
function tick(phase, throttle, brake, steer = 0) {
  input = zeroInput({ throttle: updatePedal(input.throttle, throttle, 4.3, 7.5, FIXED_DT),
    brake: updatePedal(input.brake, brake, 7.5, 11, FIXED_DT),
    steer: updateKeyboardSteer(input.steer, steer, rig.vehicle.telemetry.speedKmh, FIXED_DT),
    driveIntent: resolveDriveIntent(throttle, brake) });
  stepVehicle(rig, input);
  const b = rig.vehicle.body, q = b.rotation(), v = b.linvel();
  const local = new THREE.Vector3(v.x,v.y,v.z).applyQuaternion(new THREE.Quaternion(q.x,q.y,q.z,q.w).invert());
  const speed = Math.hypot(v.x,v.z)*3.6;
  rows.push({ t:step++*FIXED_DT, phase, speed,
    beta: Math.atan2(local.x, local.z)*180/Math.PI, yaw:b.angvel().y,
    steer:rig.vehicle.telemetry.steer, position:{...b.translation()}, audit });
  if (reset) throw Error('Automatic reset: ' + reset);
}
try {
  for(let i=0;i<240;i++) tick('settle',0,0);
  let n=0;
  while(rig.vehicle.telemetry.speedKmh<213.6 && n++<10800) tick('accelerate',1,0);
  if(n>=10800) throw Error('Target speed not reached');
  for(let i=0;i<13;i++) tick('coast',0,0);
  for(let i=0;i<201;i++) tick('brake-before-tap',0,1);
  for(let i=0;i<19;i++) tick('tap',0,1,scenario==='tap'?1:0);
  for(let i=0;i<2400;i++) { tick('brake-after-tap',0,1); if(rows.at(-1).speed<0.5) break; }
  const braking = rows.filter(r=>r.phase.startsWith('brake')||r.phase==='tap');
  const moving = braking.filter(r=>r.speed>20);
  const preTap = rows.findLast(r=>r.phase==='brake-before-tap');
  const avg = (xs, fn) => sum(xs.map(fn))/Math.max(1,xs.length);
  const out = { variant, scenario,
    scope:'GT3RS fresh uniform flat-plane rig, original keyboard filters; not browser input or exact recorded-state replay. Frozen-axis audit excludes axis transport, engine angular momentum, and Rapier integration/damping.',
    sourceUnchanged: JSON.stringify(before)===JSON.stringify(hashes()), sourceSha256:before,
    accelerationSeconds:rows.filter(r=>r.phase==='accelerate').length*FIXED_DT,
    brakeEntrySpeed:braking[0].speed, finalSpeed:rows.at(-1).speed,
    reachedStopThreshold:rows.at(-1).speed<0.5,
    observedBrakeSeconds:braking.at(-1).t-braking[0].t+FIXED_DT,
    stopSeconds:rows.at(-1).speed<0.5 ? braking.at(-1).t-braking[0].t+FIXED_DT : null,
    pathLengthAfterBrake:sum(braking.slice(1).map((r,i)=>Math.hypot(r.position.x-braking[i].position.x,r.position.z-braking[i].position.z))),
    maxBetaAbove20:Math.max(...moving.map(r=>Math.abs(r.beta))),
    maxYawAbove20:Math.max(...moving.map(r=>Math.abs(r.yaw))),
    minRearLoadAbove20:Math.min(...moving.flatMap(r=>r.audit.wheels.slice(2).map(w=>w.load))),
    preTap,
    phaseAudit:Object.fromEntries(['accelerate','coast','brake-before-tap'].map(phase=>{
      const rs=rows.filter(r=>r.phase===phase&&r.speed>100);
      return [phase,{samples:rs.length,
        meanLongitudinalContactPitch:avg(rs,r=>r.audit.longitudinalContactPitch),
        meanExtraPitch:avg(rs,r=>r.audit.extraPitch),
        meanWheelSpinChangePitch:avg(rs,r=>r.audit.wheelSpinChangePitch),
        meanFrozenAxisExchangeResidual:avg(rs,r=>r.audit.frozenAxisExchangeResidual),
        maxAbsSpinEquationResidual:Math.max(0,...rs.flatMap(r=>r.audit.wheels.map(w=>Math.abs(w.spinEquationResidual))))}];
    })), reset };
  const dir = new URL('../../research-output/third-record-wrench-audit/',import.meta.url);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(new URL(`${variant}-${scenario}.json`,dir),JSON.stringify(out,null,2));
  fs.writeFileSync(new URL(`${variant}-${scenario}.jsonl`,dir),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  console.log(JSON.stringify({...out,sourceSha256:undefined,preTap:{speed:preTap.speed,audit:preTap.audit}}));
} finally { destroyVehicleRig(rig); delete globalThis.__auditWrench; }
