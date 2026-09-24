import * as THREE from 'three';
import {installTrackKerbs} from './track-kerbs.js';
import {createSafetyMeshMaterial,createTreeMaterial} from './track-detail-materials.js';
import {installTrackSurfaceDetail} from './track-surface-detail.js';

function surfaceTexture(renderer,name,scale,color=true){
  const texture=new THREE.TextureLoader().load('/scenery/longwan/textures/'+name);
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(scale,scale);
  texture.anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy());
  texture.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;return texture;
}
function batch(group,geometry,material,placements,name){
  const mesh=new THREE.InstancedMesh(geometry,material,placements.length);
  mesh.name=name;const dummy=new THREE.Object3D();
  placements.forEach((p,i)=>{dummy.position.set(...p.position);dummy.rotation.set(0,p.yaw??0,0);dummy.scale.set(...(p.scale??[1,1,1]));dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});
  mesh.castShadow=true;mesh.receiveShadow=true;mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();group.add(mesh);return mesh;
}
function bandGeometry(track,inner,outer,start=0,end=1,height=.022){
  const count=Math.ceil((end-start)*track.length/2),positions=[],uv=[],indices=[];
  for(let i=0;i<=count;i++){
    const t=start+(end-start)*i/count,s=track.pointAt(t);
    for(const offset of [inner,outer]){const p=s.point.clone().addScaledVector(s.side,offset);positions.push(p.x,p.y+height,p.z);uv.push(t*track.length/4,offset/4);}
    if(i<count){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return g;
}
export function buildCircuitEnvironment(track){
  const group=new THREE.Group();group.name='longwan-circuit-environment';track.group.add(group);track.environmentGroup=group;
  for(const mesh of track.group.children)if(mesh.geometry?.type==='CircleGeometry')mesh.visible=false;
  const concreteMap=surfaceTexture(track.renderer,'concrete.jpg',1);
  const concrete=new THREE.MeshStandardMaterial({map:concreteMap,color:0xd4d1c7,roughness:.92});
  const metal=new THREE.MeshStandardMaterial({color:0x69736f,roughness:.45,metalness:.8});
  const dark=new THREE.MeshStandardMaterial({color:0x303a35,roughness:.65,metalness:.7});
  const gravel=new THREE.MeshStandardMaterial({map:surfaceTexture(track.renderer,'gravel.jpg',1),color:0xe6d5b9,roughness:1});
  const grass=new THREE.MeshStandardMaterial({map:surfaceTexture(track.renderer,'grass.jpg',1),color:0xc0c7a1,roughness:1});
  const paint=new THREE.MeshStandardMaterial({color:0xe4e2d7,roughness:.87});
  const kerb=new THREE.MeshStandardMaterial({map:concreteMap,normalMap:surfaceTexture(track.renderer,'concrete-normal.jpg',1,false),normalScale:new THREE.Vector2(.28,.28),vertexColors:true,roughness:.88});
  installTrackKerbs(track,kerb);
  installTrackSurfaceDetail(track,group);
  const asphalt=track.group.children.find(m=>m.material?.name==='dry-asphalt').material;
  for(const [from,to] of [[-11.5,-7.01],[7.01,11.5]]){
    const run=new THREE.Mesh(bandGeometry(track,from,to,.301,1,.012),gravel);run.receiveShadow=true;group.add(run);
    const paved=new THREE.Mesh(bandGeometry(track,from,to,0,.301,.012),asphalt);paved.receiveShadow=true;group.add(paved);
  }
  for(const side of [-1,1]){
    const stripe=new THREE.Mesh(bandGeometry(track,side<0?-6.84:6.72,side<0?-6.72:6.84,0,1,.043),paint);stripe.receiveShadow=true;group.add(stripe);
    const verge=new THREE.Mesh(bandGeometry(track,side<0?-23:11.85,side<0?-11.85:23,0,1,-.035),grass);verge.receiveShadow=true;group.add(verge);
  }
  track.legacyBoundaryMeshes.barriers.visible=false;track.legacyBoundaryMeshes.edgeLines.visible=false;
  const walls=[],posts=[],rails=[],fences=[],caps=[];
  const count=Math.ceil(track.length/6),segment=track.length/count;
  for(let i=0;i<count;i++){
    const s=track.pointAt((i+.5)/count),yaw=Math.atan2(-s.tangent.z,s.tangent.x);
    for(const sign of [-1,1]){
      const a=track.pointAt(i/count,sign*track.config.barrierOffset).point;
      const b=track.pointAt((i+1)/count,sign*track.config.barrierOffset).point;
      const p=a.clone().add(b).multiplyScalar(.5),tangent=b.clone().sub(a).normalize();
      const yaw=Math.atan2(-tangent.z,tangent.x),segment=a.distanceTo(b)+.035;
      walls.push({position:[p.x,.63,p.z],yaw,scale:[segment,1.26,.34]});
      const f=p.clone().addScaledVector(s.side,sign*.22);
      posts.push({position:[f.x,2.4,f.z],yaw,scale:[.065,2.8,.075]});
      rails.push({position:[f.x,3.85,f.z],yaw,scale:[segment*1.01,.045,.05]});
      rails.push({position:[f.x,1.38,f.z],yaw,scale:[segment*1.01,.055,.07]});
      fences.push({position:[f.x,2.62,f.z],yaw,scale:[segment,2.4,1]});
      caps.push({position:[p.x,1.3,p.z],yaw,scale:[segment*1.012,.075,.4]});
    }
  }
  const box=new THREE.BoxGeometry(1,1,1);
  batch(group,box,concrete,walls,'Circuit concrete walls');batch(group,box,dark,posts,'Fence posts');batch(group,box,metal,rails,'Fence rails');batch(group,box,metal,caps,'Wall caps');
  const netMaterial=createSafetyMeshMaterial();
  const net=batch(group,new THREE.PlaneGeometry(1,1),netMaterial,fences,'Circuit safety mesh');net.castShadow=false;
  // Far terrain rises only outside the protected track corridor.
  const ground=new THREE.PlaneGeometry(1900,1700,100,90);ground.rotateX(-Math.PI/2);
  const positions=ground.attributes.position,colors=[];
  const path=track.samples.filter((_,i)=>i%8===0);
  for(let i=0;i<positions.count;i++){
    const x=positions.getX(i),z=positions.getZ(i);let dist=Infinity;
    for(const s of path)dist=Math.min(dist,Math.hypot(x-s.point.x,z-s.point.z));
    const fade=THREE.MathUtils.smoothstep(dist,55,240);
    const h=fade*(12+10*Math.sin(x*.009+z*.003)+8*Math.cos(z*.011)+5*Math.sin(x*.022-z*.017));
    positions.setY(i,-.1+Math.max(0,h));const v=.88+.1*Math.sin(x*.03)*Math.cos(z*.023);colors.push(v*.94,v,v*.86);
  }
  ground.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));const uv=ground.attributes.uv;for(let i=0;i<uv.count;i++)uv.setXY(i,positions.getX(i)/12,positions.getZ(i)/12);ground.computeVertexNormals();
  const terrainMaterial=grass.clone();terrainMaterial.vertexColors=true;terrainMaterial.polygonOffset=true;terrainMaterial.polygonOffsetFactor=2;terrainMaterial.polygonOffsetUnits=2;const terrain=new THREE.Mesh(ground,terrainMaterial);terrain.name='Circuit terrain';terrain.receiveShadow=true;group.add(terrain);
  // Seeded tree belts break up the horizon without placing scenery on the road.
  let seed=937;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const crowns=[[],[]];let treeCount=0;
  terrain.updateMatrixWorld(true);const groundRay=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0);
  for(let i=0;i<980;i++){
    const x=-680+random()*1360,z=-540+random()*810;let dist=Infinity;
    for(const s of path)dist=Math.min(dist,Math.hypot(x-s.point.x,z-s.point.z));
    // Irregular groves with clear service access, rather than uniform scatter.
    const grove=.5+.25*Math.sin(x*.021+Math.sin(z*.015)*2)+.25*Math.cos(z*.025-x*.009);
    if(dist<32 || random()>grove*.82 || (x>-320&&x<280&&z>0&&z<110))continue;
    groundRay.set(new THREE.Vector3(x,150,z),down);const groundHit=groundRay.intersectObject(terrain,false)[0];if(!groundHit)continue;
    const base=groundHit.point.y,height=5+random()*7;
    treeCount++;const k=treeCount%2;
    crowns[k].push({position:[x,base+height*.46,z],scale:[height*(1.12+random()*.25),height*1.25,1]});
  }
  for(let k=0;k<2;k++){
    const map=new THREE.TextureLoader().load(`/scenery/longwan/textures/tree-${k}.png`);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=Math.min(8,track.renderer.capabilities.getMaxAnisotropy());
    const leaves=createTreeMaterial(map);
    const trees=batch(group,new THREE.PlaneGeometry(1,1),leaves,crowns[k],'Distant Jacaranda trees '+k);trees.castShadow=false;
    const tint=new THREE.Color();for(let i=0;i<crowns[k].length;i++){const v=.82+random()*.25;tint.setRGB(v,v*(.97+random()*.08),v*.91);trees.setColorAt(i,tint);}
  }
  track.venueStats={wallSegments:walls.length,trees:treeCount,kerbSections:track.kerbMeshes.length};
}
