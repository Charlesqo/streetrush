import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HDRLoader} from 'three/addons/loaders/HDRLoader.js';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.4));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.AgXToneMapping;renderer.toneMappingExposure=1.15;document.body.prepend(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#858f95');
const camera=new THREE.PerspectiveCamera(32,innerWidth/innerHeight,.04,450);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.maxDistance=200;
const sun=new THREE.DirectionalLight(0xfff6ed,3.2);sun.target.position.set(12,.5,1);sun.position.copy(sun.target.position).add(new THREE.Vector3(-30,60,39));sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-22,right:22,top:22,bottom:-22,near:.1,far:160});sun.shadow.camera.updateProjectionMatrix();sun.shadow.bias=-.00004;sun.shadow.normalBias=.015;scene.add(sun,sun.target);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(240,240),new THREE.MeshStandardMaterial({color:0x414d36,roughness:.95}));ground.rotation.x=-Math.PI/2;ground.position.set(0,-.2,0);ground.receiveShadow=true;scene.add(ground);
const status=document.querySelector('#status');const pmrem=new THREE.PMREMGenerator(renderer);
let queued=false,model,wire=false,currentView='overview';
function draw(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;renderer.render(scene,camera);});}
new HDRLoader().load('../materials/kloofendal_48d_partly_cloudy_puresky_2k.hdr',texture=>{texture.mapping=THREE.EquirectangularReflectionMapping;scene.environment=pmrem.fromEquirectangular(texture).texture;scene.environmentIntensity=.45;scene.background=texture;scene.backgroundIntensity=.65;pmrem.dispose();draw();},undefined,error=>{console.error(error);status.textContent='环境光加载失败';});
const views={overview:{p:[-63,39,53],t:[-4,3.2,-8],lens:40},driving:{p:[-42,1.25,1],t:[18,2.8,-9],lens:31},pit:{p:[-37,2.9,-10],t:[-20,2.8,-20],lens:37},control:{p:[22,6.1,-8],t:[8,5.7,-22],lens:40},stand:{p:[-25,3.1,17],t:[-11,2.5,24],lens:36},ground:{p:[14,.83,10.8],t:[4,.18,14.8],lens:40}};
function setView(key){currentView=key;const v=views[key];const offset=sun.position.clone().sub(sun.target.position);sun.target.position.fromArray(v.t);sun.position.copy(sun.target.position).add(offset);const extent=({overview:68,driving:45,pit:18,control:20,stand:19,ground:9})[key];Object.assign(sun.shadow.camera,{left:-extent,right:extent,top:extent,bottom:-extent});sun.shadow.camera.updateProjectionMatrix();camera.near=({overview:.65,driving:.15,pit:.12,control:.2,stand:.15,ground:.08})[key];camera.position.fromArray(v.p);controls.target.fromArray(v.t);camera.aspect=innerWidth/innerHeight;camera.fov=2*Math.atan(18/v.lens/camera.aspect)*180/Math.PI;camera.updateProjectionMatrix();controls.update();document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===key));draw();}
new GLTFLoader().load('../models/longwan_region_realtime.glb',gltf=>{model=gltf.scene;scene.add(model);model.traverse(ob=>{if(!ob.isMesh)return;ob.castShadow=true;ob.receiveShadow=true;for(const mat of Array.isArray(ob.material)?ob.material:[ob.material]){for(const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap','alphaMap'])if(mat[key])mat[key].anisotropy=renderer.capabilities.getMaxAnisotropy();if(mat.transparent)mat.depthWrite=false;}});model.traverse(ob=>{if(!ob.isMesh)return;let parent=ob;while(parent&&parent!==model){if(parent.name.startsWith('E01_')||parent.name.startsWith('E03_'))ob.castShadow=false;parent=parent.parent;}const mats=Array.isArray(ob.material)?ob.material:[ob.material];if(mats.some(m=>['Photographic dust fringe','Rubber contact trace'].includes(m.name)))ob.castShadow=false;if(mats.every(m=>/^(Varied asphalt|Varied apron|Varied grass|Varied gravel|Region paving|Track limit paint|Rubber contact|Photographic dust|Asphalt repair)/.test(m.name)))ob.castShadow=false;});status.textContent='96m 区域 / 当前交付 · 独立查看';setView('overview');},p=>{if(p.total)status.textContent=`加载模型 ${Math.round(p.loaded/p.total*100)}%`;},error=>{console.error(error);status.id='failure';status.textContent='模型加载失败';});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.querySelector('#wire').onclick=()=>{wire=!wire;model?.traverse(o=>{if(o.isMesh)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.wireframe=wire);});document.querySelector('#wire').classList.toggle('active',wire);draw();};
controls.addEventListener('change',draw);addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.fov=2*Math.atan(18/views[currentView].lens/camera.aspect)*180/Math.PI;camera.updateProjectionMatrix();draw();});setView('overview');
// No permanent animation loop; the idle viewer only renders after interaction.

let alternateLight=false;
document.querySelector('#light').onclick=()=>{alternateLight=!alternateLight;sun.position.copy(sun.target.position).add(new THREE.Vector3(...(alternateLight?[42,35,18]:[-30,60,39])));document.querySelector('#light').textContent=alternateLight?'光照 B':'光照 A';draw();};
