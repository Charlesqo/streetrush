import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {CARS,TRACK_CONFIG,FIXED_DT} from '../src/config.js';
import {TrackSystem} from '../src/track.js';
import {createTrackKerbGeometry} from '../src/track-kerbs.js';
import {createVehicleRig,destroyVehicleRig,stepVehicle,zeroInput} from './physics-harness.mjs';
const curve=new THREE.CatmullRomCurve3(TRACK_CONFIG.points.map(p=>new THREE.Vector3(...p)),true,'catmullrom',.2);
const track={config:TRACK_CONFIG,curve,length:curve.getLength(),pointAt:TrackSystem.prototype.pointAt,surfaceForOffset:TrackSystem.prototype.surfaceForOffset,nearestInfo:TrackSystem.prototype.nearestInfo,getSurface:TrackSystem.prototype.getSurface,lastIndex:0};
track.samples=Array.from({length:TRACK_CONFIG.samples},(_,index)=>({...track.pointAt(index/TRACK_CONFIG.samples),index}));
const reports=[];
for(const id of ['t1-apex-inner','esses-exit-inner']){
 const section=TRACK_CONFIG.kerbSections.find(s=>s.id===id),t=(section.start+section.end)/2,frame=track.pointAt(t);
 const rig=createVehicleRig(CARS.find(c=>c.id==='mx5'),{vehiclePhysicsMode:'v24-active'});
 try{
  for(const s of TRACK_CONFIG.kerbSections){const g=createTrackKerbGeometry(track,s);rig.world.createCollider(RAPIER.ColliderDesc.trimesh(g.attributes.position.array,Uint32Array.from(g.index.array)));}
  rig.vehicle.track=track;rig.vehicle.vehicleV24.host.track=track;
  const pos=frame.point.clone().addScaledVector(frame.side,section.side*6.65);pos.y=.75;const yaw=Math.atan2(frame.tangent.x,frame.tangent.z);
  rig.vehicle.body.setTranslation(pos,true);rig.vehicle.body.setRotation({x:0,y:Math.sin(yaw/2),z:0,w:Math.cos(yaw/2)},true);
  let kerbSamples=0,slopedSamples=0,maxHeight=0,maxVerticalSpeed=0,aborts=0,maxSpeed=0;
  for(let i=0;i<360;i++){
   stepVehicle(rig,zeroInput({throttle:i>120?.3:0,driveIntent:1}));
   const p=rig.vehicle.body.translation(),v=rig.vehicle.body.linvel();maxSpeed=Math.max(maxSpeed,Math.hypot(v.x,v.z));assert.ok([p.x,p.y,p.z,v.x,v.y,v.z].every(Number.isFinite));maxHeight=Math.max(maxHeight,p.y);maxVerticalSpeed=Math.max(maxVerticalSpeed,Math.abs(v.y));
   for(const w of rig.vehicle.telemetry.wheels??[]){if(w.surface==='kerb')kerbSamples++;}
   const report=rig.vehicle.vehiclePhysicsReport;
   if(report?.status!=='COMMITTED')aborts++;
   for(const contact of report?.contacts??[])if(contact.inContact && contact.normal.y<.999)slopedSamples++;
  }
  assert.ok(kerbSamples>0,`${id}: no actual kerb contacts`);assert.ok(maxHeight<1.5,`${id}: chassis launched`);assert.ok(maxVerticalSpeed<5,`${id}: excessive vertical speed`);assert.equal(aborts,0);assert.ok(slopedSamples>0,`${id}: no sloped contact normals`);
  const last=rig.vehicle.body.translation(),travel=Math.hypot(last.x-pos.x,last.z-pos.z);assert.ok(travel>1,`${id}: vehicle did not actually move`);
  reports.push({id,kerbSamples,slopedSamples,maxHeight,maxVerticalSpeed,aborts,maxSpeed,travel});
 }finally{destroyVehicleRig(rig);}
}
console.log(JSON.stringify({status:'PASS',mode:'v24-active',stepsPerCase:360,dt:FIXED_DT,reports,scope:'Synthetic low-speed two-sided kerb smoke; not high-speed or target-car validation'}));
