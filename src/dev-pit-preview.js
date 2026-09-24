// Explicit local art review: existing game world and renderer, visual assets only.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function installPitPreview({ scene, camera, renderer, renderPipeline, lighting, track }) {
  const root = new THREE.Group();
  root.name = 'pit-facilities-game-trial';
  const gltf = await new GLTFLoader().loadAsync('/scratch/pit-game-preview-20260907/pit-facilities.glb');
  root.add(gltf.scene);
  // Fit the pit wall to the existing 11.6 m roadside boundary.
  for(const child of gltf.scene.children) {
    if(child.name.startsWith('Pit_divider')) { child.position.z -= 3.9; child.position.y -= .1; }
    if(child.name.startsWith('F01_Pit_Exit')) child.position.z -= 3.9;
  }
  const cleanGlass = new THREE.MeshPhysicalMaterial({
    name:'Pit clear architectural glass',color:0xe0edef,roughness:0,
    metalness:0,transmission:1,transparent:false,opacity:1,depthWrite:true,ior:1.45,thickness:0,
    side:THREE.FrontSide,envMapIntensity:1.0,
  });
  root.rotation.y = Math.PI;
  root.position.set(-265, 0, 0);
  root.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const original=[].concat(object.material);
    const corrected=original.map(material => /(^Glass$|windows_glass)/i.test(material.name) ? cleanGlass : material);
    object.material=Array.isArray(object.material)?corrected:corrected[0];
    if(corrected.every(material=>material===cleanGlass)){object.castShadow=false;object.receiveShadow=false;}
    for (const material of [].concat(object.material)) {
      for (const value of Object.values(material)) if (value?.isTexture) value.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
  });
  // Repeated roadside sections share geometry and materials; draw each primitive
  // once with instance transforms rather than once per 24 m section.
  root.updateMatrixWorld(true);
  const shared = new Map();
  gltf.scene.traverse(object => {
    if (!object.isMesh || Array.isArray(object.material)) return;
    let owner = object;
    while(owner && !owner.name.startsWith('Roadside_module')) owner=owner.parent;
    if(!owner)return;
    const key=object.geometry.uuid+':'+object.material.uuid;
    if(!shared.has(key))shared.set(key,[]);
    shared.get(key).push(object);
  });
  const localFromWorld=new THREE.Matrix4().copy(root.matrixWorld).invert();
  let savedDraws=0;
  for(const meshes of shared.values()){
    if(meshes.length<2)continue;
    const batch=new THREE.InstancedMesh(meshes[0].geometry,meshes[0].material,meshes.length);
    batch.name='Shared roadside '+meshes[0].material.name;
    batch.castShadow=true;batch.receiveShadow=true;
    meshes.forEach((mesh,index)=>batch.setMatrixAt(index,new THREE.Matrix4().multiplyMatrices(localFromWorld,mesh.matrixWorld)));
    batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();root.add(batch);
    for(const mesh of meshes)mesh.removeFromParent();
    savedDraws+=meshes.length-1;
  }
  root.userData.roadsideDrawCallsSavedPerPass=savedDraws;
  // Explicit first-block layout: the main straight has paint and a flush
  // asphalt margin, not continuous raised red/white kerbs.
  const straightSamples=track.samples.filter(sample=>sample.point.x>=-313 && sample.point.x<=-217 && Math.abs(sample.point.z)<3).sort((a,b)=>a.point.x-b.point.x);
  const roadMaterial=track.group.children.find(mesh=>mesh.material?.name==='dry-asphalt').material;
  const shoulderMaterial=roadMaterial.clone();shoulderMaterial.color.multiplyScalar(.91);
  const inverseRoot=new THREE.Matrix4().copy(root.matrixWorld).invert();
  const edgePaint=new THREE.MeshStandardMaterial({color:0xe6e3d8,roughness:.86});
  for(const [sign,inner,outer,material,height] of [[-1,7,9.25,shoulderMaterial,.021],[1,7,11.3,shoulderMaterial,.021],[-1,6.725,6.835,edgePaint,.043],[1,6.725,6.835,edgePaint,.043]]){
    const positions=[],uv=[],indices=[];
    for(const [i,sample] of straightSamples.entries()){
      for(const offset of [inner,outer]){
        // side is -Z on this straight; sign here expresses world-side Z.
        const point=sample.point.clone().addScaledVector(sample.side,-sign*offset);
        point.y=height;point.applyMatrix4(inverseRoot);positions.push(...point.toArray());
        uv.push(sample.point.x/12,offset/track.config.width);
      }
      if(i){const a=(i-1)*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();
    // Winding differs across the two sides of the centerline.
    if(sign===-1){const index=geometry.index.array;for(let i=0;i<index.length;i+=3)[index[i+1],index[i+2]]=[index[i+2],index[i+1]];geometry.computeVertexNormals();}
    const strip=new THREE.Mesh(geometry,material);strip.name='Straight flush asphalt margin '+sign;strip.receiveShadow=true;root.add(strip);
  }
  // A working apron connects the imported facilities to the existing runoff.
  const textureLoader = new THREE.TextureLoader();
  const materialBase = '/art-output/longwan-pit-exit-20260907/materials/';
  const [concreteMap, concreteNormal] = await Promise.all([
    textureLoader.loadAsync(materialBase+'floor_pavement_diff_2k.jpg'),
    textureLoader.loadAsync(materialBase+'floor_pavement_nor_gl_2k.jpg'),
  ]);
  concreteMap.colorSpace=THREE.SRGBColorSpace;
  for(const map of [concreteMap,concreteNormal]) { map.wrapS=map.wrapT=THREE.RepeatWrapping; map.repeat.set(96/4,20/4); map.anisotropy=8; }
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(96,20), new THREE.MeshStandardMaterial({map:concreteMap,normalMap:concreteNormal,normalScale:new THREE.Vector2(.45,.45),color:0xd3d1c4, roughness:.92}));
  apron.rotation.x=-Math.PI/2;
  apron.position.set(0, .11, -22);
  apron.receiveShadow = true;
  root.add(apron);
  scene.add(root);
  // Retain all original matrices so same-camera comparison restores them exactly.
  const replacements=[];const matrix=new THREE.Matrix4();const point=new THREE.Vector3();
  for(const mesh of track.group.children){
    if(!mesh.isInstancedMesh || !mesh.geometry.type.includes('Box'))continue;
    const isWall=mesh.material.metalness===.72;
    const isKerb=mesh.material.roughness===.78 || mesh.material.roughness===.82;
    const isEdge=mesh.material.roughness===.75 && mesh.material.color?.getHex()===0xf0eee7;
    if(!isWall&&!isKerb&&!isEdge)continue;
    for(let i=0;i<mesh.count;i++){
      mesh.getMatrixAt(i,matrix);point.setFromMatrixPosition(matrix);
      const within=point.x>=-313 && point.x<=-217;
      // No raised kerbs in this straight section; restore them only for baseline comparison.
      if(within && ((isWall && point.z<0)||(isWall && point.z>0 && point.x>=-284)||isKerb||isEdge))
        replacements.push({mesh,index:i,matrix:matrix.clone()});
    }
  }
  const applyTrial=visible=>{
    root.visible=visible;
    for(const entry of replacements){entry.mesh.setMatrixAt(entry.index,visible?new THREE.Matrix4().makeScale(0,0,0):entry.matrix);entry.mesh.instanceMatrix.needsUpdate=true;}
  };
  applyTrial(true);
  // Rotate the photographed sky and its matching sun together.
  await lighting.setSkyRotation(-1.1);

  const shots = {
    '驾驶高度': {position:[-298, 1.65, -1], target:[-244, 2.1, 9]},
    '维修区近景': {position:[-223, 2.35, 14], target:[-245, 3, 20]},
    '玻璃近景': {position:[-260, 9.2, 16], target:[-271, 9, 23]},
    '直道全景': {position:[-322, 7, -14], target:[-253, 2, 16]},
  };
  let shot = shots['驾驶高度'];
  const focus = new THREE.Object3D();focus.position.set(-260,0,16);
  const panel = document.createElement('aside');
  panel.id='pit-art-review';
  panel.style.cssText='position:fixed;z-index:1000;bottom:20px;left:24px;background:#152128ed;padding:14px 18px;border-radius:10px;color:#fff;font:14px system-ui;box-shadow:0 4px 24px #0006';
  const label=document.createElement('div');label.textContent='维修区 · 游戏内局部试装';label.style.marginBottom='10px';panel.append(label);
  const button=(text,fn)=>{const b=document.createElement('button');b.textContent=text;b.style.cssText='margin-right:8px;padding:8px 12px;background:#34464e;border:1px solid #63747a;border-radius:5px;color:white;cursor:pointer';b.onclick=fn;panel.append(b);};
  for(const [name,value] of Object.entries(shots))button(name,()=>{shot=value;});
  button('原场景 / 试装',()=>{applyTrial(!root.visible);label.textContent=root.visible?'维修区 · 游戏内局部试装':'维修区 · 原场景（同一机位）';});
  button('返回正常视角',()=>{shot=null;});
  document.body.append(panel);
  const style=document.createElement('style');style.textContent='body:has(#pit-art-review) #menu,body:has(#pit-art-review) #hud,body:has(#pit-art-review) #loading{display:none!important}';document.head.append(style);
  const render=renderPipeline.render.bind(renderPipeline);
  renderPipeline.render=(...args)=>{
    if(shot){camera.position.fromArray(shot.position);camera.lookAt(new THREE.Vector3().fromArray(shot.target));lighting.update(focus,performance.now());}
    const previewRatio=Math.min(devicePixelRatio,1.5);
    if(renderer.getPixelRatio()!==previewRatio)renderer.setPixelRatio(previewRatio);
    const result=render(...args);
    document.documentElement.dataset.pitPreview='ready';
    return result;
  };
  return {root};
}
