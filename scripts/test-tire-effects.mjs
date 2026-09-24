import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TireEffects } from '../src/tire-effects.js';

const quaternion = new THREE.Quaternion();
const make = () => { const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0xb8cad5,.00038);return new TireEffects(scene); };
const contact=(x,z,slip=.8)=>Object.freeze({grounded:true,surface:'asphalt',slipPower:slip,contactPoint:Object.freeze(new THREE.Vector3(x,0,z))});
function run(hz){
  const effects=make();
  for(let i=0;i<hz*1.5;i++){
    const telemetry=Object.freeze({speedKmh:40,wheels:Object.freeze([contact(-.7,i/hz*5),contact(.7,i/hz*5)])});
    effects.update(1/hz,telemetry,quaternion);
  }
  return effects;
}
const at30=run(30),at120=run(120);
assert.ok(Math.abs(at30.particleCursor-at120.particleCursor)<=1,'Emission count must follow elapsed time, not display FPS');
assert.ok(at30.particleCursor>100&&at30.particleCursor<110);
assert.ok(at30.markCount>0&&at120.markCount>0);
for(const e of [at30,at120]){
  assert.ok(e.markPositions.every(Number.isFinite));
  const a=new THREE.Vector3().fromArray(e.markPositions,0),b=new THREE.Vector3().fromArray(e.markPositions,3),c=new THREE.Vector3().fromArray(e.markPositions,6);
  assert.ok(b.sub(a).cross(c.sub(a)).y>0,'The visible face of a ground stripe must face upward');
  assert.ok(e.markPositions.filter((_,i)=>i%3===1).some(y=>y>.015),'Marks must sit above the visible road, not just the collision plane');
  assert.equal(e.marks.material.depthWrite,false);
  assert.equal(e.smoke.parent,e.smokeScene,'Smoke must not enter the opaque scene or AO depth');
  assert.equal(e.scene.children.includes(e.smoke),false);
}
const markOnly=make();
for(let i=0;i<30;i++)markOnly.update(1/60,{speedKmh:40,wheels:[contact(0,i*.1,.2)]},quaternion);
assert.ok(markOnly.markCount>0);assert.equal(markOnly.particleCursor,0,'Preserve the separate mark and smoke slip thresholds');
const teleport=make();
teleport.update(1/60,{speedKmh:40,wheels:[contact(0,0)]},quaternion);
teleport.update(1/60,{speedKmh:40,wheels:[contact(0,100)]},quaternion);
assert.equal(teleport.markCount,0,'Reset/teleport must not draw a stripe across the track');
const paintScene=new THREE.Scene(),paintRoot=new THREE.Group();
const paint=new THREE.Mesh(new THREE.BoxGeometry(2,.022,.46),new THREE.MeshBasicMaterial());paint.position.y=.048;paintRoot.add(paint);
const painted=new TireEffects(paintScene,{groundRoot:paintRoot});
assert.ok(Math.abs(painted.groundHeight(new THREE.Vector3(0,0,0))-.061)<1e-5,'Rubber must remain above the raised checkerboard paint');
assert.equal(painted.groundHeight(new THREE.Vector3(0,0,2)),.020,'Ordinary asphalt must not inherit the raised paint offset');
const disappearing=make();
for(let i=0;i<90;i++)disappearing.update(1/60,{speedKmh:40,wheels:[contact(0,0)]},quaternion);
const colour=disappearing.particles.find(p=>p.life>0).color.clone();
for(let i=0;i<240;i++)disappearing.update(1/60,{speedKmh:0,wheels:[]},quaternion);
assert.ok(disappearing.particles.every(p=>p.life<=0));
assert.ok(disappearing.particles.some(p=>p.color.equals(colour)),'Fading must not turn smoke colour black');
console.log('PASS: frame-rate-independent emission, immutable telemetry, mark continuity/reset, smoke pass ownership and transparent lifetime');
