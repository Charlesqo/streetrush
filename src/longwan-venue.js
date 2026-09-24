import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

export async function buildLongwanVenue(group,track){
  const {scene:venue}=await new GLTFLoader().loadAsync('/scenery/longwan/venue.gltf');
  venue.name='Longwan permanent pit facilities';venue.rotation.y=Math.PI;venue.position.set(-255,0,0);
  const originals=[...venue.children];
  for(const child of originals){
    if(/A02_Race_Control|D02_Control_Details/.test(child.name))child.position.x-=205;
    if(/A03_Marshal_Post|F08_Scanned_Service/.test(child.name))child.position.x-=248;
    if(child.name.startsWith('F01_Pit_Exit'))child.position.x-=260;
    if(child.name.startsWith('F07_Timing_Gantry')){child.position.x+=102;child.scale.z*=1.25;}
    if(/Longwan_Pit_Building|Pit_roof_services|F02_Tool|F03_Tyre|Pit_working_drain/.test(child.name)){
      for(let i=1;i<6;i++){const copy=child.clone(true);copy.position.x-=i*34;venue.add(copy);}
    }
    if(child.name.startsWith('A04_Trackside_Grandstand')){
      for(let i=1;i<4;i++){const copy=child.clone(true);copy.position.x-=i*48;venue.add(copy);}
    }
  }
  const glass=new THREE.MeshPhysicalMaterial({name:'Clear venue glazing',color:0x435660,roughness:.05,metalness:0,transmission:0,transparent:true,opacity:.3,depthWrite:false,clearcoat:1,clearcoatRoughness:.03,specularIntensity:1,side:THREE.FrontSide});
  venue.traverse(object=>{
    if(!object.isMesh)return;
    object.castShadow=true;object.receiveShadow=true;object.userData.sceneryShadowCaster=true;
    if(!Array.isArray(object.material)&&/(^Glass$|windows_glass)/i.test(object.material.name)){
      object.material=glass;object.castShadow=false;object.receiveShadow=false;object.userData.sceneryShadowCaster=false;
    }
    for(const m of [].concat(object.material))for(const texture of Object.values(m))if(texture?.isTexture)texture.anisotropy=8;
  });
  group.add(venue);group.updateMatrixWorld(true);
  // Instance all repeated opaque pieces, including the garage modules.
  const sets=new Map(),inverse=new THREE.Matrix4().copy(group.matrixWorld).invert();
  venue.traverse(mesh=>{if(!mesh.isMesh||Array.isArray(mesh.material)||mesh.material.transparent)return;const key=mesh.geometry.uuid+mesh.material.uuid;if(!sets.has(key))sets.set(key,[]);sets.get(key).push(mesh);});
  let drawSavings=0;
  for(const meshes of sets.values()){
    if(meshes.length<2)continue;
    const batch=new THREE.InstancedMesh(meshes[0].geometry,meshes[0].material,meshes.length);batch.name='Venue shared '+meshes[0].material.name;
    meshes.forEach((mesh,i)=>batch.setMatrixAt(i,new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld)));
    batch.castShadow=true;batch.receiveShadow=true;batch.userData.sceneryShadowCaster=true;batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();group.add(batch);
    meshes.forEach(mesh=>mesh.removeFromParent());drawSavings+=meshes.length-1;
  }
  const loader=new THREE.TextureLoader();const map=await loader.loadAsync('/scenery/longwan/textures/paving.jpg');map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(76,12);map.anisotropy=8;
  const apron=new THREE.Mesh(new THREE.PlaneGeometry(304,48),new THREE.MeshStandardMaterial({map,color:0xccc9bd,roughness:.95}));apron.rotation.x=-Math.PI/2;apron.position.set(-143,.11,35.7);apron.receiveShadow=true;apron.name='Continuous pit apron';group.add(apron);
  const serviceMaterial=new THREE.MeshStandardMaterial({color:0x383c3b,roughness:.98});
  const service=new THREE.Mesh(new THREE.PlaneGeometry(440,7),serviceMaterial);service.rotation.x=-Math.PI/2;service.position.set(-84,.013,68);service.receiveShadow=true;group.add(service);
  // Keep the original live start lights, replace only their oversized decoration.
  const start=track.checkpointMarkers[0]?.group;
  if(start)for(const child of start.children){if(!track.startLights.includes(child))child.visible=false;else{child.position.y=5.7;child.scale.setScalar(.75);}}
  // Grounded service blocks: varied lengths and rooflines behind the active pits.
  const maintenance=new THREE.Group();maintenance.name='Paddock service buildings';
  const wall=new THREE.MeshStandardMaterial({color:0xc3c1b4,roughness:.9});
  const roof=new THREE.MeshStandardMaterial({color:0x414c4b,roughness:.65,metalness:.3});
  for(let i=0;i<5;i++){
    const x=-240+i*62,depth=16+(i%2)*4,height=4.2+(i%3)*.6;
    const body=new THREE.Mesh(new THREE.BoxGeometry(39,height,depth),wall);body.position.set(x,height/2,87);body.castShadow=true;body.receiveShadow=true;maintenance.add(body);
    const top=new THREE.Mesh(new THREE.BoxGeometry(41,.25,depth+2),roof);top.position.set(x,height+.12,87);top.castShadow=true;maintenance.add(top);
    for(let j=-1;j<=1;j++){const door=new THREE.Mesh(new THREE.BoxGeometry(7,3.4,.12),roof);door.position.set(x+j*11,1.7,87-depth/2-.07);maintenance.add(door);}
  }
  group.add(maintenance);
  group.userData.drawCallsSavedPerPass=drawSavings;
  return {facilities:originals.length,garageModules:6,grandstands:4,drawCallsSavedPerPass:drawSavings};
}
