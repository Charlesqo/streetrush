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
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.maxDistance=80;
const sun=new THREE.DirectionalLight(0xfff6ed,3.2);sun.target.position.set(9,3,-4.5);sun.position.copy(sun.target.position).add(new THREE.Vector3(-30,60,39));sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-16,right:16,top:16,bottom:-16,near:.1,far:160});sun.shadow.camera.updateProjectionMatrix();sun.shadow.bias=-.00004;sun.shadow.normalBias=.006;scene.add(sun,sun.target);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(240,240),new THREE.MeshStandardMaterial({color:0x545d60,roughness:.95}));ground.rotation.x=-Math.PI/2;ground.position.set(9,-.006,-4.5);ground.receiveShadow=true;scene.add(ground);
const status=document.querySelector('#status');const pmrem=new THREE.PMREMGenerator(renderer);
let queued=false,model,wire=false,currentView='front';
function draw(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;renderer.render(scene,camera);});}
new HDRLoader().load('../materials/kloofendal_48d_partly_cloudy_puresky_2k.hdr',texture=>{texture.mapping=THREE.EquirectangularReflectionMapping;scene.environment=pmrem.fromEquirectangular(texture).texture;scene.environmentIntensity=.45;scene.background=texture;scene.backgroundIntensity=.65;pmrem.dispose();draw();},undefined,error=>{console.error(error);status.textContent='环境光加载失败';});
const views={front:{p:[-12,9,18],t:[9,2.5,-3],lens:45},near:{p:[-1.1,2.25,5.6],t:[5.8,1.65,0],lens:48},rear:{p:[30,11,-24],t:[9,2.8,-4],lens:47}};
function setView(key){currentView=key;const v=views[key];camera.position.fromArray(v.p);controls.target.fromArray(v.t);camera.aspect=innerWidth/innerHeight;camera.fov=2*Math.atan(18/v.lens/camera.aspect)*180/Math.PI;camera.updateProjectionMatrix();controls.update();document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===key));draw();}
new GLTFLoader().load('../models/longwan_pit_building_realtime.glb',gltf=>{model=gltf.scene;scene.add(model);model.traverse(ob=>{if(!ob.isMesh)return;ob.castShadow=true;ob.receiveShadow=true;for(const mat of Array.isArray(ob.material)?ob.material:[ob.material]){if(mat.map)mat.map.anisotropy=renderer.capabilities.getMaxAnisotropy();if(mat.transparent)mat.depthWrite=false;}});status.textContent='实际模型 / PBR 材质 · 建筑单体检查';setView('front');},p=>{if(p.total)status.textContent=`加载模型 ${Math.round(p.loaded/p.total*100)}%`;},error=>{console.error(error);status.id='failure';status.textContent='模型加载失败';});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.querySelector('#wire').onclick=()=>{wire=!wire;model?.traverse(o=>{if(o.isMesh)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.wireframe=wire);});document.querySelector('#wire').classList.toggle('active',wire);draw();};
controls.addEventListener('change',draw);addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.fov=2*Math.atan(18/views[currentView].lens/camera.aspect)*180/Math.PI;camera.updateProjectionMatrix();draw();});setView('front');
// No permanent animation loop; the idle viewer only renders after interaction.

let alternateLight=false;
document.querySelector('#light').onclick=()=>{alternateLight=!alternateLight;sun.position.copy(sun.target.position).add(new THREE.Vector3(...(alternateLight?[42,35,18]:[-30,60,39])));document.querySelector('#light').textContent=alternateLight?'光照 B':'光照 A';draw();};
