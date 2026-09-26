// Geometry-only audit. Calls the production geometry builder; no assets,
// WebGL, Rapier, vehicle, or physics runtime is constructed or run.
import fs from 'node:fs';
import * as THREE from '../../../node_modules/three/build/three.module.js';
import { TrackSystem } from '../../../src/track.js';
import { TRACK_CONFIG } from '../../../src/config.js';
class GeometryAuditTrack extends TrackSystem {
  buildVisuals() {}
  buildPhysics() {}
}
const track = new GeometryAuditTrack(TRACK_CONFIG, new THREE.Scene(), null, null, null);
const mesh = track.createStrip(TRACK_CONFIG.width / 2, .015, new THREE.MeshStandardMaterial());
const g=mesh.geometry;
const vec=(attribute,i)=>new THREE.Vector3().fromBufferAttribute(attribute,i);
function derivatives(positions,uvs){
  const e1=positions[1].clone().sub(positions[0]),e2=positions[2].clone().sub(positions[0]);
  const d1=uvs[1].clone().sub(uvs[0]),d2=uvs[2].clone().sub(uvs[0]);
  const determinant=d1.x*d2.y-d2.x*d1.y;
  const U=e1.clone().multiplyScalar(d2.y).addScaledVector(e2,-d1.y).divideScalar(determinant);
  const V=e2.clone().multiplyScalar(d1.x).addScaledVector(e1,-d2.x).divideScalar(determinant);
  const N=e1.clone().cross(e2).normalize();
  return {U_metre_per_tile:U.length(),V_metre_per_tile:V.length(),U:U.clone().normalize().toArray(),V:V.clone().normalize().toArray(),N:N.toArray(),handedness:Math.sign(U.clone().cross(V).dot(N))};
}
const rows=[];
for(const t of [.006,.055,.145,.275]){
  const i=Math.floor(t*TRACK_CONFIG.samples),ids=[2*i,2*i+2,2*i+1];
  const positions=ids.map(i=>vec(g.attributes.position,i));
  const uvs=ids.map(i=>new THREE.Vector2().fromBufferAttribute(g.attributes.uv,i).multiply(new THREE.Vector2(4,14/3)));
  const s=track.pointAt(t),ahead=track.pointAt(t+24/track.length),cam=s.point.clone().add(new THREE.Vector3(0,1.7,0)),target=ahead.point.clone().add(new THREE.Vector3(0,1,0));
  rows.push({t,point:s.point.toArray(),tangent:s.tangent.toArray(),side:s.side.toArray(),worldCamera:cam.toArray(),worldTarget:target.toArray(),actualFineUv:uvs.map(v=>v.toArray()),basis:derivatives(positions,uvs)});
}
const p=[new THREE.Vector3(0,0,-7),new THREE.Vector3(0,0,7),new THREE.Vector3(180,0,-7)];
const uv=[new THREE.Vector2(0,-7/3),new THREE.Vector2(0,7/3),new THREE.Vector2(180/3,-7/3)];
const result={status:'GEOMETRY_CPU_ONLY',trackLength:track.length,mainStraightNominalLength:.301*track.length,planeBasis:derivatives(p,uv),productionRoad:rows};
fs.writeFileSync(new URL('./lighting-geometry-audit.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
