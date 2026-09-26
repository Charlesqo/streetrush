import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import * as THREE from 'three';

// Research-only component ablations at module load; never writes game source.
const variant = process.argv[2] ?? 'baseline';
if (!['baseline', 'retain-bias', 'no-braking-hub-reaction', 'balanced-braking-hub-reaction', 'no-esc'].includes(variant)) throw Error('Unknown variant');
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/src/vehicle-v24/powertrain.js') && ['retain-bias','no-esc'].includes(variant)) {
    let source = String(result.source);
    const from = variant === 'retain-bias' ? 'const hasLoadAuthority = groundedCount === 4' : 'const escAuthority = Math.min(escSpeedAuthority, escManeuverAuthority);';
    const to = variant === 'retain-bias' ? 'const hasLoadAuthority = groundedCount >= 3' : 'const escAuthority = 0;';
    if (!source.includes(from)) throw Error('Ablation seam changed');
    return { ...result, source: source.replace(from,to) };
  }
  if (url.endsWith('/src/vehicle-v24/runtime.js') && variant === 'no-braking-hub-reaction') {
    const source = String(result.source), from = 'const hubReactionTorque = sumBodyTorqueFromHubs(contacts, powertrain, brakeResults);';
    if (!source.includes(from)) throw Error('Ablation seam changed');
    return {...result,source:source.replace(from,'const hubReactionTorque = gearboxTrial.serviceBrake > 0 ? vec3() : sumBodyTorqueFromHubs(contacts, powertrain, brakeResults);')};
  }
  if (url.endsWith('/src/vehicle-v24/runtime.js') && variant === 'balanced-braking-hub-reaction') {
    let source = String(result.source);
    for (const [from,to] of [
      ['function sumBodyTorqueFromHubs(contacts, powertrain, brakeResults)', 'function sumBodyTorqueFromHubs(contacts, powertrain, brakeResults, tireOutputs = null)'],
      ['const wheelActuatorTorque = powertrain.wheelDriveTorque[index] + brakeTorqueSigned;', 'const wheelActuatorTorque = powertrain.wheelDriveTorque[index] + brakeTorqueSigned + (tireOutputs?.[index].wheelContactTorque ?? 0);'],
      ['const hubReactionTorque = sumBodyTorqueFromHubs(contacts, powertrain, brakeResults);', 'const hubReactionTorque = sumBodyTorqueFromHubs(contacts, powertrain, brakeResults, gearboxTrial.serviceBrake > 0 ? tireOutputs : null);'],
    ]) { if (!source.includes(from)) throw Error('Ablation seam changed'); source = source.replace(from,to); }
    return {...result,source};
  }
  return result;
} });
const { CARS, FIXED_DT } = await import('../../src/config.js');
const { updateKeyboardSteer, updatePedal, resolveDriveIntent } = await import('../../src/input.js');
const { createVehicleRig, stepVehicle, zeroInput, destroyVehicleRig } = await import('../../scripts/physics-harness.mjs');
const files = ['runtime.js','powertrain.js'].map(n=>new URL(`../../src/vehicle-v24/${n}`,import.meta.url));
const hashes = () => files.map(f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
const before = hashes();
const rig = createVehicleRig(CARS.find(c=>c.id==='gt3rs'),{vehiclePhysicsMode:'v24-active'});
const rows=[];let input=zeroInput(),step=0,reset=null;
rig.vehicle.onAutomaticReset=reason=>{reset=reason;};
function tick(phase,rawThrottle,rawBrake,rawSteer=0) {
  input = zeroInput({throttle:updatePedal(input.throttle,rawThrottle,4.3,7.5,FIXED_DT),brake:updatePedal(input.brake,rawBrake,7.5,11,FIXED_DT),
    steer:updateKeyboardSteer(input.steer,rawSteer,rig.vehicle.telemetry.speedKmh,FIXED_DT),driveIntent:resolveDriveIntent(rawThrottle,rawBrake)});
  stepVehicle(rig,input);
  const b=rig.vehicle.body,q=b.rotation(),vel=b.linvel(),report=rig.vehicle.getVehiclePhysicsReport();
  const local=new THREE.Vector3(vel.x,vel.y,vel.z).applyQuaternion(new THREE.Quaternion(q.x,q.y,q.z,q.w).invert());
  const speed=Math.hypot(vel.x,vel.z)*3.6;
  rows.push({t:step++*FIXED_DT,phase,speed,beta:speed>20?Math.atan2(local.x,local.z)*180/Math.PI:null,yaw:b.angvel().y,
    input:{...input},position:{...b.translation()},rotation:{...q},report});
  if(reset)throw Error('Automatic reset: '+reset);
}
try {
  for(let i=0;i<240;i++)tick('settle',0,0);
  let n=0;while(rig.vehicle.telemetry.speedKmh<213.6&&n++<10800)tick('accelerate',1,0);
  if(n>=10800)throw Error('Speed not reached');
  for(let i=0;i<13;i++)tick('coast',0,0);
  for(let i=0;i<201;i++)tick('brake-before-tap',0,1);
  for(let i=0;i<19;i++)tick('tap',0,1,1);
  for(let i=0;i<480;i++){tick('brake-after-tap',0,1);if(rows.at(-1).speed<0.5)break;}
  const brake=rows.filter(r=>r.phase.startsWith('brake')||r.phase==='tap'), moving=brake.filter(r=>r.speed>20);
  const out={variant,scope:'Fresh flat-plane GT3RS scenario approximating recorded speed, braking and tap timings; NOT exact state replay or a proposed physics fix.',
    samples:rows.length,sourceUnchanged:JSON.stringify(before)===JSON.stringify(hashes()),brakeEntrySpeed:brake[0].speed,
    preTap:brake.findLast(r=>r.phase==='brake-before-tap')&&{speed:brake.findLast(r=>r.phase==='brake-before-tap').speed,yaw:brake.findLast(r=>r.phase==='brake-before-tap').yaw},
    maxBeta:Math.max(...moving.map(r=>Math.abs(r.beta??0))),maxYaw:Math.max(...moving.map(r=>Math.abs(r.yaw))),
    minRearLoad:Math.min(...brake.flatMap(r=>r.report.output.wheels.slice(2).map(w=>w.load))),
    firstRearZeroTime:brake.find(r=>r.report.output.wheels.slice(2).some(w=>w.load===0))?.t-brake[0].t,
    finalSpeed:rows.at(-1).speed,reset};
  fs.mkdirSync(new URL('../../research-output/third-record-causal/',import.meta.url),{recursive:true});
  fs.writeFileSync(new URL(`../../research-output/third-record-causal/${variant}.json`,import.meta.url),JSON.stringify(out,null,2));
  fs.writeFileSync(new URL(`../../research-output/third-record-causal/${variant}.jsonl`,import.meta.url),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  console.log(JSON.stringify(out));
} finally {destroyVehicleRig(rig);}
