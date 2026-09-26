import fs from 'node:fs';
import { CARS, FIXED_DT } from '../../src/config.js';
import { updateKeyboardSteer, updatePedal, resolveDriveIntent } from '../../src/input.js';
import { createVehicleRig, destroyVehicleRig, settleVehicle, stepVehicle, zeroInput, yawOf } from '../../scripts/physics-harness.mjs';

const rows=[];
for(const car of CARS) for(const kind of ['straight-180','near-straight-140']) {
  const rig=createVehicleRig(car,{vehiclePhysicsMode:'v24-active'});
  let resets=0; rig.vehicle.onAutomaticReset=()=>resets++;
  const samples=[];
  try {
    settleVehicle(rig,1.5);
    let n=0;
    const target=kind==='straight-180'?180:140;
    while(rig.vehicle.telemetry.speedKmh<target&&n<4800){stepVehicle(rig,zeroInput({throttle:1,driveIntent:1}));n++;}
    let input=zeroInput({throttle:1,driveIntent:1});
    if(kind==='near-straight-140') for(let i=0;i<60;i++) stepVehicle(rig,zeroInput({throttle:0.15,driveIntent:1,steer:0.02}));
    const startYaw=yawOf(rig.vehicle.body.rotation());
    let lastYaw=startYaw, heading=0;
    for(let i=0;i<1080;i++) {
      input=zeroInput({throttle:updatePedal(input.throttle,0,4.3,7.5,FIXED_DT),brake:updatePedal(input.brake,1,7.5,11,FIXED_DT),driveIntent:-1});
      stepVehicle(rig,input);
      const b=rig.vehicle.body,q=b.rotation(),v=b.linvel(),report=rig.vehicle.getVehiclePhysicsReport();
      const yaw=yawOf(q);heading+=Math.atan2(Math.sin(yaw-lastYaw),Math.cos(yaw-lastYaw));lastYaw=yaw;
      const f={x:2*(q.x*q.z+q.w*q.y),y:2*(q.y*q.z-q.w*q.x),z:1-2*(q.x*q.x+q.y*q.y)};
      const r={x:1-2*(q.y*q.y+q.z*q.z),y:2*(q.x*q.y+q.w*q.z),z:2*(q.x*q.z-q.w*q.y)};
      const vx=v.x*f.x+v.y*f.y+v.z*f.z,vy=v.x*r.x+v.y*r.y+v.z*r.z;
      samples.push({t:i*FIXED_DT,speed:vx*3.6,heading:heading*180/Math.PI,yawRate:b.angvel().y,betaDeg:Math.atan2(vy,Math.abs(vx))*180/Math.PI,report});
      if(resets||Math.abs(vx)<0.1) break;
    }
    const moving=samples.filter(s=>Math.abs(s.speed)>20);
    const out={car:car.id,kind,startSpeed:samples[0].speed,entryHeadingDeg:startYaw*180/Math.PI,
      maxYawRate:Math.max(...moving.map(s=>Math.abs(s.yawRate))),maxBeta:Math.max(...moving.map(s=>Math.abs(s.betaDeg))),
      maxHeading:Math.max(...samples.map(s=>Math.abs(s.heading))),finalSpeed:samples.at(-1).speed,resets};
    rows.push(out);console.log(JSON.stringify(out));
    fs.writeFileSync(new URL(`${car.id}-${kind}.json`,import.meta.url),JSON.stringify(samples));
  }catch(e){rows.push({car:car.id,kind,error:e.message});console.log(JSON.stringify(rows.at(-1)));}
  finally{destroyVehicleRig(rig);}
}
fs.writeFileSync(new URL('straight-summary.json',import.meta.url),JSON.stringify(rows,null,2));
