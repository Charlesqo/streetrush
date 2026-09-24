import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {initializeRapier} from '../src/rapier-init.js';
import {TRACK_CONFIG} from '../src/config.js';
import {TrackSystem} from '../src/track.js';
import {createTrackKerbGeometry} from '../src/track-kerbs.js';
import {KERB_WIDTH,kerbHeight} from '../src/longwan-layout.js';
await initializeRapier(RAPIER);
const curve=new THREE.CatmullRomCurve3(TRACK_CONFIG.points.map(p=>new THREE.Vector3(...p)),true,'catmullrom',.2);
const track={config:TRACK_CONFIG,curve,length:curve.getLength(),pointAt:TrackSystem.prototype.pointAt,surfaceForOffset:TrackSystem.prototype.surfaceForOffset};
const world=new RAPIER.World({x:0,y:-9.81,z:0});track.RAPIER=RAPIER;track.physicsWorld=world;track.kerbMeshes=[];
let triangles=0;
for(const s of TRACK_CONFIG.kerbSections){
 const g=createTrackKerbGeometry(track,s);triangles+=g.index.count/3;
 assert.ok(g.attributes.normal.array.every(Number.isFinite));
 for(let i=1;i<g.attributes.normal.array.length;i+=3)assert.ok(g.attributes.normal.array[i]>.7,`${s.id} normal must point upward`);
 track.kerbMeshes.push({geometry:g});
}
TrackSystem.prototype.buildPhysics.call(track);world.step();let hits=0;
for(const s of TRACK_CONFIG.kerbSections){
 const length=(s.end-s.start)*track.length;
 for(const fraction of [.1,.45,.8]){
  const station=length*fraction,t=s.start+station/track.length,frame=track.pointAt(t),point=frame.point.clone().addScaledVector(frame.side,s.side*(TRACK_CONFIG.width/2+.8*KERB_WIDTH));
  const hit=world.castRayAndGetNormal(new RAPIER.Ray({x:point.x,y:2,z:point.z},{x:0,y:-1,z:0}),5,true);
  assert.ok(hit,`${s.id}: scene query missed kerb`);const height=2-hit.timeOfImpact;
  assert.ok(Math.abs(height-kerbHeight(station,.8,length))<.012,`${s.id}: rendered/collider height mismatch ${height}`);
  assert.ok(hit.normal.y>.7);assert.equal(track.surfaceForOffset(s.side*7.8,t),'kerb');hits++;
 }
}
for(const t of [.05,.12,.24])for(const side of [-1,1])assert.equal(track.surfaceForOffset(side*7.8,t),'asphalt');
assert.equal(track.surfaceForOffset(-7.8,.34),'gravel');
assert.equal(track.surfaceForOffset(13,.34),'grass');
console.log(JSON.stringify({status:'PASS',sections:TRACK_CONFIG.kerbSections.length,realRapierKerbQueries:hits,triangles,straightSurface:'asphalt',offKerbCornerSurface:'gravel',scope:'Geometry/surface integration only; not target-vehicle validation'}));
world.free();
