import assert from 'node:assert/strict';
import { CARS } from '../src/config.js';
import { createGearboxState, createEngineState, prepareDriverGearboxTrial, prepareEngineClutchTrial, idealOpenDifferentialMapping } from '../src/vehicle-v24/powertrain.js';
import { createVehicleRig, destroyVehicleRig, settleVehicle, stepVehicle, zeroInput } from './physics-harness.mjs';

let checks = 0;
for (const config of CARS) {
  const state = { ...createGearboxState(), transmissionMode: 'MT', selectedGear: '3' };
  const before = structuredClone(state);
  const trial = prepareDriverGearboxTrial({state,input:zeroInput({shiftDown:true}),signedSpeed:80,
    engineRpm:config.redline,config,dt:1/120});
  assert.equal(trial.nextState.phase, 'OPENING');
  assert.equal(trial.nextState.targetGear, '2');
  assert.deepEqual(state, before);
  checks += 3;

  // Beyond the old hard threshold, crank and wheel speeds remain independent
  // physical states. Combustion is cut; finite clutch torque can still backdrive.
  const rpm = config.redline * 1.7;
  const mapping = idealOpenDifferentialMapping(config,'1');
  const ratio = mapping.reduce((sum,value)=>sum+value,0);
  const omega = rpm / (60/(2*Math.PI));
  const args = {engineState:{...createEngineState(config),omega},
    gearboxTrial:{effectiveGear:'1',averageEngagement:1,driveThrottle:1},
    wheelOmega:[omega/ratio,omega/ratio,omega/ratio,omega/ratio],bodyLongSpeed:80,
    assists:{enginePositiveTorqueLimit:1},config,dt:1/120};
  assert.throws(()=>prepareEngineClutchTrial(args),/hard overspeed domain/);
  const overrev = prepareEngineClutchTrial({...args,allowMechanicalOverrev:true});
  assert.ok(overrev.rpm > config.redline*1.12, 'must not hide overrev with an RPM clamp');
  assert.equal(overrev.mapTorque,0);
  assert.equal(overrev.nextState.limiterCut,true);
  assert.equal(overrev.engineDomainStatus,'MECHANICAL_OVERRUN_EXTENSION');
  assert.ok(Math.abs(overrev.clutchImpulse)<=overrev.clutchCapacity+1e-12);
  assert.equal(overrev.engagement,1,'must not hide overrev by opening the clutch');
  assert.throws(()=>prepareEngineClutchTrial({...args,allowMechanicalOverrev:true,engineState:{...args.engineState,omega:Infinity}}),/finite/);
  checks += 8;

  const rig = createVehicleRig(config, {vehiclePhysicsMode:'v24-active'});
  try {
    settleVehicle(rig);
    for (let i=0;i<2400;i++) stepVehicle(rig,zeroInput({throttle:1}));
    const startSpeed = rig.vehicle.telemetry.speedKmh;
    let peakRpm=0, firstGearSpeed=null, overrevSteps=0;
    for (let i=0;i<1200;i++) {
      stepVehicle(rig,zeroInput({throttle:i<600?1:0,toggleTransmission:i===0,shiftDown:i%12===0}));
      const t=rig.vehicle.telemetry;
      peakRpm=Math.max(peakRpm,t.rpm);
      if(t.gear===1 && firstGearSpeed===null) firstGearSpeed=t.speedKmh;
      if(t.powertrain.engineDomainStatus==='MECHANICAL_OVERRUN_EXTENSION') overrevSteps++;
      assert.ok(Number.isFinite(t.rpm) && t.rpm>=0);
      assert.equal(rig.vehicle.vehiclePhysicsReport.status,'COMMITTED');
      checks+=2;
    }
    assert.ok(peakRpm>config.redline*1.12,'must exercise actual mechanical overrev');
    assert.ok(firstGearSpeed>startSpeed*.65,'must actually select first while still fast');
    assert.equal(rig.vehicle.telemetry.gear,1);
    assert.ok(overrevSteps>60,'must keep simulating through overrev, not just tolerate one frame');
    checks+=4;
    // Upshifts must recover normally after the abusive maneuver.
    for(let i=0;i<600;i++) stepVehicle(rig,zeroInput({shiftUp:i%36===0}));
    assert.equal(rig.vehicle.telemetry.gear,config.gears.length);
    assert.ok(rig.vehicle.telemetry.rpm<config.redline*1.12);
    stepVehicle(rig,zeroInput({toggleTransmission:true}));
    assert.equal(rig.vehicle.transmissionMode,'AT');
    checks+=3;
    console.log(JSON.stringify({car:config.id,startSpeedKmh:startSpeed,firstGearSpeedKmh:firstGearSpeed,peakRpm,redline:config.redline,overrevSteps,result:'PASS'}));
  } finally {destroyVehicleRig(rig);}
}
console.log(JSON.stringify({status:'PASS',checks,scope:'six-car synthetic Rapier forced downshifts with actual overrev; not target calibration'}));
