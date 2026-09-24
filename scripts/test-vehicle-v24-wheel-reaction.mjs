import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CARS, FIXED_DT } from '../src/config.js';
import { updateKeyboardSteer, updatePedal, resolveDriveIntent } from '../src/input.js';
import { POWERTRAIN_CONSTANTS } from '../src/vehicle-v24/powertrain.js';
import { createVehicleRig, destroyVehicleRig, runFor, settleVehicle, stepVehicle, zeroInput } from './physics-harness.mjs';

// Bounded Rapier host accounting + GT3RS regression, not full reference/target parity.
const car = CARS.find(c => c.id === 'gt3rs');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const results = { exchanges: [], maneuvers: [] };

// Compare the actually submitted body torque with independent committed wheel
// spin deltas. Default aero has no moment. Axes are frozen within this substep;
// this does not test engine/axis-transport/gyroscopic angular momentum.
for (const phase of ['drive', 'coast', 'brake', 'airborne-brake']) {
  const rig = createVehicleRig(car, { vehiclePhysicsMode: 'v24-active' });
  try {
    settleVehicle(rig);
    runFor(rig, 4, zeroInput({ throttle: 1, driveIntent: 1 }));
    if (phase === 'airborne-brake') {
      const p = rig.vehicle.body.translation();
      rig.vehicle.body.setTranslation({ x:p.x, y:50, z:p.z }, true);
      rig.vehicle.body.setRotation({ x:0, y:0, z:0, w:1 }, true);
      rig.vehicle.body.setAngvel({ x:0, y:0, z:0 }, true);
    }
    const runtime = rig.vehicle.vehicleV24;
    const before = runtime.getStateSnapshot().mechanics.wheelOmega;
    let batch, writes = 0;
    const original = runtime.host.applyWrenchBatch.bind(runtime.host);
    runtime.host.applyWrenchBatch = value => { batch = value; writes++; return original(value); };
    const input = phase === 'drive' ? zeroInput({ throttle:1, driveIntent:1 })
      : phase === 'coast' ? zeroInput()
      : zeroInput({ brake:1, driveIntent:-1 });
    rig.vehicle.fixedUpdate(input, false, FIXED_DT);
    const after = runtime.getStateSnapshot().mechanics.wheelOmega;
    const report = runtime.getLastReport();
    const spinRate = new THREE.Vector3();
    report.solver.geometryDiagnostics.forEach((g, i) => {
      // +omega axis = -contact.lateral in this host's reflected basis.
      spinRate.addScaledVector(new THREE.Vector3(g.lateral.x,g.lateral.y,g.lateral.z),
        -POWERTRAIN_CONSTANTS.wheelInertia * (after[i]-before[i])/FIXED_DT);
    });
    check(writes === 1, `${phase}: wrench must commit exactly once`);
    const error = spinRate.clone().add(new THREE.Vector3(batch.bodyTorque.x,batch.bodyTorque.y,batch.bodyTorque.z)).length();
    check(error < 1e-6, `${phase}: extra body torque plus wheel spin change = ${error} N.m`);
    if (phase === 'airborne-brake') {
      check(batch.contacts.length === 0, 'airborne test unexpectedly contacted ground');
      check(spinRate.length() > 10, 'airborne test did not slow the spinning wheels');
      check(Math.hypot(batch.bodyTorque.x,batch.bodyTorque.y,batch.bodyTorque.z)>10,
        'airborne braking lost the chassis reaction');
    }
    results.exchanges.push({ phase, errorNm:error, bodyTorque:batch.bodyTorque, spinChangeTorque:spinRate.toArray() });
  } finally { destroyVehicleRig(rig); }
}

// Same original keyboard filtering and timing as the recorded GT3RS onset.
// Use both tap directions and no tap; these are flat-plane tests, not a browser replay.
for (const direction of [0, 1, -1]) {
  const rig = createVehicleRig(car, { vehiclePhysicsMode:'v24-active' });
  let input=zeroInput(), brakeStarted=false, samples=0, path=0, previousPosition;
  let maxBeta=0, maxYaw=0, minRear=Infinity, reset=null;
  rig.vehicle.onAutomaticReset = reason => { reset=reason; };
  const tick = (throttle,brake,steer=0) => {
    input = zeroInput({ throttle:updatePedal(input.throttle,throttle,4.3,7.5,FIXED_DT),
      brake:updatePedal(input.brake,brake,7.5,11,FIXED_DT),
      steer:updateKeyboardSteer(input.steer,steer,rig.vehicle.telemetry.speedKmh,FIXED_DT),
      driveIntent:resolveDriveIntent(throttle,brake) });
    stepVehicle(rig,input);
    const b=rig.vehicle.body,v=b.linvel(),q=b.rotation(),p=b.translation();
    const speed=Math.hypot(v.x,v.z)*3.6;
    if(brakeStarted){
      samples++;
      if(previousPosition) path+=Math.hypot(p.x-previousPosition.x,p.z-previousPosition.z);
      previousPosition={...p};
      if(speed>20){
        const local=new THREE.Vector3(v.x,v.y,v.z).applyQuaternion(new THREE.Quaternion(q.x,q.y,q.z,q.w).invert());
        maxBeta=Math.max(maxBeta,Math.abs(Math.atan2(local.x,local.z)*180/Math.PI));
        maxYaw=Math.max(maxYaw,Math.abs(b.angvel().y));
        minRear=Math.min(minRear,...rig.vehicle.getVehiclePhysicsReport().output.wheels.slice(2).map(w=>w.load));
      }
    }
    return speed;
  };
  try {
    for(let i=0;i<240;i++)tick(0,0);
    let accelerationSteps=0;
    while(rig.vehicle.telemetry.speedKmh<213.6&&accelerationSteps++<2400)tick(1,0);
    check(accelerationSteps<2400, `tap ${direction}: acceleration failed to reach target`);
    for(let i=0;i<13;i++)tick(0,0);
    brakeStarted=true;
    for(let i=0;i<201;i++)tick(0,1);
    for(let i=0;i<19;i++)tick(0,1,direction);
    let finalSpeed;
    for(let i=0;i<1440;i++){ finalSpeed=tick(0,1); if(finalSpeed<0.5)break; }
    check(reset===null, `tap ${direction}: automatic reset ${reset}`);
    check(finalSpeed<0.5, `tap ${direction}: failed to stop (${finalSpeed} km/h)`);
    check(maxBeta<3, `tap ${direction}: excessive sideslip ${maxBeta} deg`);
    check(maxYaw<0.2, `tap ${direction}: excessive yaw ${maxYaw} rad/s`);
    check(minRear>500, `tap ${direction}: rear wheel unloaded (${minRear} N)`);
    check(path>180&&path<215, `tap ${direction}: braking distance outside regression envelope (${path} m)`);
    results.maneuvers.push({ direction, accelerationSeconds:accelerationSteps*FIXED_DT,
      stopSeconds:samples*FIXED_DT, distanceM:path, maxBetaDeg:maxBeta, maxYawRadS:maxYaw, minRearLoadN:minRear });
  } finally { destroyVehicleRig(rig); }
}
console.log(JSON.stringify({ status:'PASS', checks,
  scope:'Frozen-axis host wheel-spin exchange and GT3RS flat-plane keyboard-filter braking regression only', ...results }));
