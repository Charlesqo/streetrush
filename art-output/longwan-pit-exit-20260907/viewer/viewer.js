import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RGBELoader} from 'three/addons/loaders/RGBELoader.js';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.AgXToneMapping;renderer.toneMappingExposure=1.1;
document.body.prepend(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#aebcc4');
const camera=new THREE.PerspectiveCamera(46,innerWidth/innerHeight,.05,600);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;
const hemi=new THREE.HemisphereLight(0xc3d9e8,0x6d6758,.65);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffedda,2.0);sun.position.set(-25,55,38);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-68,right:68,top:65,bottom:-65,near:1,far:160});sun.shadow.bias=-.0001;sun.shadow.normalBias=.03;scene.add(sun);
const pmrem=new THREE.PMREMGenerator(renderer);const status=document.querySelector('#status');
new RGBELoader().load('../materials/kloofendal_48d_partly_cloudy_puresky_2k.hdr',texture=>{const env=pmrem.fromEquirectangular(texture).texture;scene.environment=env;scene.environmentIntensity=.78;texture.mapping=THREE.EquirectangularReflectionMapping;scene.background=texture;scene.backgroundIntensity=.78;scene.backgroundBlurriness=.025;pmrem.dispose();draw();},undefined,()=>{});
const views={overview:[[-65,36,58],[-4,2.5,-6]],drive:[[-43,1.45,1.8],[14,3,-3]],pit:[[-31,3.1,-10.5],[-15,3.2,-19]],surface:[[23,1.15,10.7],[3,.03,8.4]],tower:[[25,7.9,-8],[12,7,-20]]};
let root,wire=false,drawPending=false;const assets=[];
function draw(){if(drawPending)return;drawPending=true;requestAnimationFrame(()=>{drawPending=false;renderer.render(scene,camera);document.querySelector('#stats').textContent=`${renderer.info.render.triangles.toLocaleString()} triangles · ${renderer.info.render.calls} draw calls · WebGL`;});}
function setView(name){const [p,t]=views[name];camera.position.fromArray(p);controls.target.fromArray(t);controls.update();draw();document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));}
function resetVisibility(){assets.forEach(a=>a.visible=true);document.querySelector('#asset').value='all';document.querySelector('#details').textContent='';}
new GLTFLoader().load('../scene/longwan_pit_exit.glb',gltf=>{root=gltf.scene;scene.add(root);root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;for(const m of Array.isArray(o.material)?o.material:[o.material]){if(m.map)m.map.anisotropy=renderer.capabilities.getMaxAnisotropy();if(m.transparent)m.depthWrite=false;}}});
for(const ob of root.children){assets.push(ob);const opt=document.createElement('option');opt.value=ob.name;opt.textContent=ob.name;document.querySelector('#asset').append(opt);}
status.textContent='实际模型 / PBR 材质 · 独立预览，未接入游戏';window.longwanReady=true;window.longwanScene=root;setView('overview');},p=>{if(p.total)status.textContent=`加载模型 ${Math.round(100*p.loaded/p.total)}%`;},e=>{status.textContent='模型加载失败。请用目录内的启动脚本打开，或查看控制台。';console.error(e);window.longwanError=String(e);});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{resetVisibility();setView(b.dataset.view);});
document.querySelector('#wire').onclick=()=>{wire=!wire;root?.traverse(o=>{if(o.isMesh)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{m.wireframe=wire;});});document.querySelector('#wire').classList.toggle('active',wire);draw();};
document.querySelector('#asset').onchange=e=>{const name=e.target.value;if(name==='all'){resetVisibility();setView('overview');return;}assets.forEach(a=>a.visible=a.name===name);const obj=assets.find(a=>a.name===name);const box=new THREE.Box3().setFromObject(obj);const c=box.getCenter(new THREE.Vector3()),d=box.getSize(new THREE.Vector3()).length();controls.target.copy(c);camera.position.copy(c).add(new THREE.Vector3(-.8,.5,1).multiplyScalar(d*.9));camera.near=Math.max(.01,d/1000);camera.updateProjectionMatrix();controls.update();document.querySelector('#details').textContent=obj.userData.description||name;draw();};
controls.addEventListener('change',draw);addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);draw();});
// Rendering is event driven: idle viewer does not hold a permanent GPU loop.
setView('overview');
