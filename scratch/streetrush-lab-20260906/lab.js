import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sky } from 'three/addons/objects/Sky.js';

// Isolated scene study: fixed seed, authored dimensions, no production state writes.
const $ = (id) => document.getElementById(id);
const recipe = { version: 1, seed: 260906, sunElevation: 32, exposure: 1, speedKmh: 72, ui: 'quiet', camera: 'close', shadows: true, materials: true, details: true };
let randomState = recipe.seed;
const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = recipe.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#aac6d0');
scene.fog = new THREE.Fog('#bed0cb', 90, 220);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 400);
camera.position.set(-6.5, 3.2, 7.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(5.0, 1.25, -3.5);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 4;
controls.maxDistance = 95;
const hemi = new THREE.HemisphereLight('#d7edee', '#858261', 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff0cc', 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 170 });
sun.shadow.bias = -0.00015;
sun.shadow.normalBias = 0.035;
scene.add(sun, sun.target);
const sky=new Sky();sky.scale.setScalar(360);sky.material.uniforms.turbidity.value=3.5;sky.material.uniforms.rayleigh.value=1.4;sky.material.uniforms.mieCoefficient.value=.004;sky.material.uniforms.mieDirectionalG.value=.82;scene.add(sky);
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, 0.06);
scene.environment = environment.texture;
scene.environmentIntensity = 0.32;
room.dispose(); pmrem.dispose();

const world = new THREE.Group(); scene.add(world);
const details = new THREE.Group(); world.add(details);
const materialSources = [];
const assetResults = [];
const loader = new THREE.TextureLoader();
const textureRoot = '/scratch/glm-materials-20260905-084701/extracted/';
async function surface(folder, id, repeat, tint, normalStrength) {
  const values = await Promise.allSettled(['B','N','ORM'].map(channel => loader.loadAsync(`${textureRoot}${folder}/Textures/T_${id}_1K_${channel}.jpg`)));
  const maps = values.map((v, i) => {
    if (v.status !== 'fulfilled') { assetResults.push(`${id}/${['B','N','ORM'][i]} 加载失败`); return null; }
    const tex = v.value;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(...repeat);
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.colorSpace = i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  });
  const material = new THREE.MeshStandardMaterial({ color: tint, map: maps[0], normalMap: maps[1], roughnessMap: maps[2], roughness: 0.93, metalness: 0, normalScale: new THREE.Vector2(normalStrength, normalStrength) });
  materialSources.push({ material, map: maps[0], normalMap: maps[1], roughnessMap: maps[2] });
  return material;
}
const standard = (color, roughness = 0.8, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const palette = {
  plaster: standard('#d2cfc0'), concrete: standard('#abae9e'), concreteDark: standard('#767f71'),
  roof: standard('#4c615c', 0.6, 0.38), steel: standard('#677c75', 0.46, 0.58),
  dark: standard('#283b37'), paint: standard('#eee9d8', 0.67), red: standard('#a85443', 0.76),
  orange: standard('#d48b46'), wood: standard('#797660'), tire: standard('#232a25', 0.96),
  glass: new THREE.MeshStandardMaterial({ color: '#699292', metalness: 0.28, roughness: 0.18, transparent: true, opacity: 0.57 }),
  light: new THREE.MeshStandardMaterial({ color:'#fff2ca', emissive:'#ffdf93', emissiveIntensity: 2.2 }),
};
function box(w,h,d,material,x,y,z,parent=world,shadow=true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), material);
  m.position.set(x,y,z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m;
}
function cylinder(r1,r2,h,material,x,y,z,parent=world,n=12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,h,n),material);
  m.position.set(x,y,z); m.castShadow=true; m.receiveShadow=true; parent.add(m); return m;
}
function plane(w,d,material,x,y,z,parent=world) {
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,d),material);
  m.rotation.x=-Math.PI/2;m.position.set(x,y,z);m.receiveShadow=true;parent.add(m);return m;
}
function sign(text,w,h,fg='#eeeadd',bg='#344b43') {
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=Math.round(1024*h/w);
  const ctx=canvas.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle=fg;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`600 ${Math.round(canvas.height*.48)}px system-ui`;
  ctx.fillText(text,canvas.width/2,canvas.height/2);
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshStandardMaterial({map:tex,roughness:.85}));
  return mesh;
}
function frontSign(text,w,h,x,y,z,bg) {
  const mesh=sign(text,w,h,undefined,bg);mesh.rotation.y=-Math.PI/2;mesh.position.set(x,y,z);world.add(mesh);return mesh;
}

const [asphalt,grass] = await Promise.all([
  surface('road_asphalt_rh0ribp0_1k_ue_low','rh0ribp0',[32,350],'#b2b4ad',0.27),
  surface('lawn_grass_tkynejer_1k_ue_low','tkynejer',[75,105],'#bec69c',0.35),
]);
grass.vertexColors=true;
const terrainGeometry = new THREE.PlaneGeometry(180,230,42,48);
terrainGeometry.rotateX(-Math.PI/2);
const terrainPositions=terrainGeometry.attributes.position;
const terrainColors=[];
const shade = new THREE.Color();
for(let i=0;i<terrainPositions.count;i++) {
  const x=terrainPositions.getX(i),z=terrainPositions.getZ(i);
  const away=THREE.MathUtils.smoothstep(Math.abs(x),25,70);
  terrainPositions.setY(i,-.06+away*(1.8+1.4*Math.sin(z*.038+x*.061)));
  const v=.84+.08*Math.sin(x*.16+z*.052)+.065*Math.cos(x*.042-z*.11);
  shade.setRGB(v,v*.985,v*.91);terrainColors.push(shade.r,shade.g,shade.b);
}
terrainGeometry.setAttribute('color',new THREE.Float32BufferAttribute(terrainColors,3));terrainGeometry.computeVertexNormals();
const terrain=new THREE.Mesh(terrainGeometry,grass);terrain.receiveShadow=true;world.add(terrain);
plane(13,142,asphalt,0,.025,0);
const apron=standard('#939889',.96);
plane(13,42,apron,13,.033,0);
// Authored broad patches and construction joints, separate from grain repetition.
const patch=standard('#555e55',.94);patch.transparent=true;patch.opacity=.14;patch.depthWrite=false;
plane(6,19,patch,-2.9,.029,-38);plane(3.8,11,patch,3.5,.03,40);
for(let z=-68;z<70;z+=14) plane(.16,6,palette.paint,-3.4,.038,z);
plane(.12,140,palette.paint,-6.1,.038,0);plane(.12,140,palette.paint,6.1,.038,0);
for(let i=0;i<64;i++) {
  const z=-63+i*2;
  box(.56,.08,1.98,i%2?palette.paint:palette.red,-6.55,.02,z,world,false);
  if(z < -23 || z > 24)box(.56,.08,1.98,i%2?palette.paint:palette.red,6.55,.02,z,world,false);
}
for(let i=0;i<11;i++)box(1.1,.007,1.1,i%2?palette.paint:palette.dark,-5.5+i*1.1,.04,-16,world,false);
for(let i=0;i<11;i++)box(1.1,.007,1.1,i%2?palette.dark:palette.paint,-5.5+i*1.1,.04,-17.1,world,false);
for(let x=7.5;x<20;x+=3)for(let z=-21;z<22;z+=6)plane(.012,5.98,palette.concreteDark,x,.039,z,details);

// A five-bay open garage: structural columns, roof depth and interior, not a painted box facade.
const bayPitch=5.5;
box(8.6,.18,29,palette.concrete,13.6,.1,0);
box(.22,3.25,28.4,palette.plaster,17.8,1.8,0);
box(8.4,3.25,.18,palette.plaster,13.6,1.8,-14.2);
box(8.4,3.25,.18,palette.plaster,13.6,1.8,14.2);
box(9.7,.17,30,palette.roof,13.3,3.72,0);
box(.17,.44,30,palette.dark,8.5,3.63,0);
box(.18,.23,30,palette.steel,18,3.7,0);
for(let i=0;i<=5;i++) {
  const z=-13.75+i*bayPitch;
  box(.24,3.55,.25,palette.plaster,9.15,1.86,z);
  box(.17,3.45,.18,palette.steel,17.35,1.86,z);
  box(8.5,.22,.18,palette.steel,13.3,3.48,z);
  if(i<5){
    const center=z+bayPitch/2;
    frontSign(String(i+1).padStart(2,'0'),.73,.4,8.39,3.63,center);
    box(.07,.05,3.6,palette.light,11.1,3.42,center,details,false);
    box(.1,.28,2.8,palette.concreteDark,17.62,1.45,center,details);
    box(.68,.92,1.5,i%2?palette.dark:palette.red,16.9,.65,center+1.45,details);
    for(let j=0;j<4;j++)box(.04,.03,1.35,palette.steel,16.54,.4+j*.19,center+1.45,details,false);
    if(i===0||i===4){
      for(let j=0;j<10;j++)box(.065,.095,5.1,palette.roof,9.05,3.28-j*.11,center,details);
    }
  }
}
for(let z=-14.8;z<15;z+=.46)box(9.6,.035,.022,palette.steel,13.3,3.825,z,details,false);
frontSign('LONGWAN  /  MOTOR CLUB',9,.75,8.37,4.15,0,'#314b42');
box(.14,.9,9.5,palette.dark,8.45,4.14,0);
// The sign must sit on the road-facing side of its backing.
const office=new THREE.Group();world.add(office);
box(5.3,3.3,6.5,palette.plaster,14,1.76,20.8,office);
box(6.0,.18,7.1,palette.roof,14,3.5,20.8,office);
box(4.4,2.1,4.8,palette.plaster,14.2,4.6,21.5,office);
box(5.4,.2,5.9,palette.dark,14.2,5.75,21.5,office);
for(let z=19.55;z<23.7;z+=1.35){
  box(.03,1.3,1.1,palette.glass,11.98,4.72,z,office,false);
  box(.07,1.5,.07,palette.steel,11.96,4.72,z-.63,office);
}
box(.09,.08,4.7,palette.steel,11.95,4.04,21.5,office);
frontSign('CONTROL',2.1,.5,11.29,2.55,20.6,'#a87449');
for(let i=0;i<11;i++)box(1.5,.16,.32,palette.concrete,18.1,.18+i*.28,18.3+i*.32,office);

// Canopy, benches, pit-lane objects and long-range scale references.
box(4.9,.14,5.8,palette.paint,-12,3.05,1.5);
for(const x of [-14.2,-9.8])for(const z of [-1,4])cylinder(.045,.045,3,palette.steel,x,1.5,z);
for(const z of [0,2.3]){
  box(3.1,.11,.42,palette.wood,-12,.65,z,details);
  box(3.1,.5,.06,palette.wood,-12,1,z+.19,details);
  for(const x of [-13.1,-10.9])box(.08,.6,.38,palette.dark,x,.32,z,details);
}
for(let i=0;i<10;i++) {
  const z=-22+i*4.4;
  cylinder(.016,.19,.6,palette.orange,7.05,.3,z,details);
  cylinder(.076,.12,.14,palette.paint,7.05,.38,z,details);
  box(.44,.035,.44,palette.dark,7.05,.022,z,details);
}
for(const z of [-39,-15,9,36,61]){
  cylinder(.045,.07,5.8,palette.steel,-9,2.9,z,world);
  box(1.1,.055,.055,palette.steel,-8.52,5.76,z);
  box(.67,.08,.28,palette.dark,-8.15,5.68,z);
  box(.54,.025,.2,palette.light,-8.15,5.63,z,details,false);
}
for(let z=-65;z<72;z+=5){
  cylinder(.055,.055,1.1,palette.steel,24,.56,z,world,8);
  box(.07,.2,4.95,palette.steel,24,.82,z+2.5);
  box(.055,.12,4.95,palette.steel,24,.48,z+2.5);
}
for(let i=0;i<3;i++){
  const z=34+i*12;
  const board=sign(String(150-i*50),1.2,.65,'#213b31','#edeedc');
  board.position.set(-8.15,1.25,z);board.rotation.y=Math.PI;world.add(board);
  box(.06,1.05,.06,palette.steel,-8.15,.55,z,details);
}

// Deterministic planted clusters. Geometry is opaque, so dense alpha overdraw is avoided.
const foliageMaterials=['#6c8055','#829361','#566e4e'].map(c=>standard(c));
const crownGeometry=new THREE.IcosahedronGeometry(1,2);
const leafPositions=crownGeometry.attributes.position;
for(let i=0;i<leafPositions.count;i++){const x=leafPositions.getX(i),y=leafPositions.getY(i),z=leafPositions.getZ(i);const f=.84+.12*Math.sin(x*13+y*17)+.06*Math.cos(z*19-x*11);leafPositions.setXYZ(i,x*f,y*f,z*f)}
crownGeometry.computeVertexNormals();
const treeInstances=foliageMaterials.map(m=>new THREE.InstancedMesh(crownGeometry,m,160));
const treeCount=[0,0,0];
const matrix=new THREE.Matrix4(),q=new THREE.Quaternion(),scale=new THREE.Vector3(),pos=new THREE.Vector3();
for(let i=0;i<30;i++){
  const x=(i%2?1:-1)*(30+random()*30),z=-89+random()*180,h=4+random()*3;
  cylinder(.12,.23,h*.7,palette.wood,x,h*.35,z,world,8);
  for(let j=0;j<12;j++){
    const mi=(i+j)%3;pos.set(x+(random()-.5)*4.5,h+(random()-.5)*3,z+(random()-.5)*4.5);
    scale.set(.85+random()*.65,1+random()*.8,.8+random()*.8);q.setFromEuler(new THREE.Euler(random(),random(),random()));
    matrix.compose(pos,q,scale);treeInstances[mi].setMatrixAt(treeCount[mi]++,matrix);
  }
}
treeInstances.forEach((m,i)=>{m.count=treeCount[i];m.castShadow=true;m.receiveShadow=true;world.add(m)});
const bladeGeo=new THREE.BufferGeometry();
bladeGeo.setAttribute('position',new THREE.Float32BufferAttribute([-.04,0,0,.03,0,0,0,.28,.015,0,0,-.045,0,0,.04,.02,.2,0,-.025,0,-.025,.03,0,.03,-.03,.18,.04],3));
bladeGeo.computeVertexNormals();
const blades=new THREE.InstancedMesh(bladeGeo,new THREE.MeshStandardMaterial({color:'#81935b',roughness:1,side:THREE.DoubleSide}),1800);
for(let i=0;i<1800;i++){
  const side=i%2?-1:1;let x=side*(7.2+random()*5),z=-67+random()*136;
  if(x>0 && z>-24 && z<26)x=25+random()*5;
  if(x<0 && x>-15 && z>-3 && z<6)z-=12;
  pos.set(x,.015,z);q.setFromAxisAngle(new THREE.Vector3(0,1,0),random()*Math.PI*2);scale.setScalar(.7+random()*.9);matrix.compose(pos,q,scale);blades.setMatrixAt(i,matrix);
  shade.setHSL(.19+random()*.045,.2+random()*.1,.27+random()*.15);blades.setColorAt(i,shade);
}
blades.receiveShadow=true;details.add(blades);

const car=new THREE.Group();world.add(car);car.position.set(2.6,.06,-5.5);
try {
  const gltf=await new GLTFLoader().loadAsync('/cars/mazda-miata-mx5-na.glb');
  const model=gltf.scene;
  model.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(model,true),size=bounds.getSize(new THREE.Vector3());
  if(size.x>size.z){model.rotation.y=Math.PI/2;model.updateMatrixWorld(true);}
  const length=Math.max(size.x,size.z);
  model.scale.multiplyScalar(4.02/length);model.updateMatrixWorld(true);
  bounds.setFromObject(model,true);const center=bounds.getCenter(new THREE.Vector3());
  const wheelBottoms=[];
  model.traverse(o=>{if(o.isMesh && o.visible && /tyre|tire/i.test(o.name))wheelBottoms.push(new THREE.Box3().setFromObject(o,true).min.y);});
  const groundY=wheelBottoms.length>=2?Math.min(...wheelBottoms):bounds.min.y;
  model.position.sub(new THREE.Vector3(center.x,groundY,center.z));
  model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material]){if('envMapIntensity' in m)m.envMapIntensity=.75;}}}});
  car.add(model);$('asset-status').textContent=assetResults.length?`车模已加载 · ${assetResults.length} 张贴图降级`:'已有 GLB · 真实地表贴图 · 实时投影';
} catch(error){
  box(1.7,.55,3.5,palette.red,0,.75,0,car);box(1.35,.5,1.6,palette.dark,0,1.2,-.15,car);
  $('asset-status').textContent='车辆加载失败：当前显示几何占位';assetResults.push(String(error));
}

let view='orbit',paused=false,travel=0,last=performance.now(),metricTime=0;
let smoothedFrame=16.7;
const desiredPosition=new THREE.Vector3(),lookTarget=new THREE.Vector3(),desiredTarget=new THREE.Vector3();
function updateSun(){
  const a=THREE.MathUtils.degToRad(recipe.sunElevation);
  sun.position.set(-Math.cos(a)*58,Math.sin(a)*85,-Math.cos(a)*48);
  sky.material.uniforms.sunPosition.value.copy(sun.position).normalize();
  sun.target.position.set(4,0,0);
  sun.color.setHSL(.10,.18+(70-recipe.sunElevation)*.003,.91);
  $('sun-output').textContent=`${recipe.sunElevation}°`;
}
updateSun();
function setView(value){
  view=value;controls.enabled=value==='orbit';document.querySelector('.game-overlay').classList.toggle('driving',value==='drive');
  document.querySelector('.driving-hud').hidden=value!=='drive';$('pause').hidden=value!=='drive';
  $('view-label').textContent=value==='drive'?'固定轨迹演示 · 未连接车辆物理':'自由观察 · 拖动旋转 / 滚轮缩放';
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===value));
  if(value==='orbit'){car.position.set(2.6,.06,-5.5);car.rotation.y=0;camera.position.set(-6.5,3.2,7.5);camera.fov=48;controls.target.set(5,1.25,-3.5);camera.updateProjectionMatrix();controls.update();}
  else{travel=0;car.position.set(1,.06,-35);car.rotation.y=0;camera.position.set(1,3.1,-43);lookTarget.set(1,1,-25);}
}
$('panel-button').onclick=()=>{$('controls').hidden=!$('controls').hidden;$('panel-button').setAttribute('aria-expanded',String(!$('controls').hidden));};
$('drive-button').onclick=()=>{setView('drive');$('controls').hidden=false;$('panel-button').setAttribute('aria-expanded','true');};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.querySelectorAll('[data-ui-choice]').forEach(b=>b.onclick=()=>{recipe.ui=b.dataset.uiChoice;document.body.dataset.ui=recipe.ui;document.querySelectorAll('[data-ui-choice]').forEach(x=>x.classList.toggle('selected',x===b));});
document.querySelectorAll('[data-camera]').forEach(b=>b.onclick=()=>{recipe.camera=b.dataset.camera;document.querySelectorAll('[data-camera]').forEach(x=>x.classList.toggle('selected',x===b));if(view!=='drive')setView('drive');});
$('speed').oninput=e=>{recipe.speedKmh=Number(e.target.value);$('speed-output').textContent=`${recipe.speedKmh} km/h`;$('speed-value').textContent=recipe.speedKmh;};
$('sun').oninput=e=>{recipe.sunElevation=Number(e.target.value);updateSun();};
$('exposure').oninput=e=>{recipe.exposure=Number(e.target.value)/100;renderer.toneMappingExposure=recipe.exposure;$('exposure-output').textContent=recipe.exposure.toFixed(2);};
$('shadows').onchange=e=>{recipe.shadows=e.target.checked;renderer.shadowMap.enabled=recipe.shadows;scene.traverse(o=>{if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])m.needsUpdate=true;});};
$('materials').onchange=e=>{recipe.materials=e.target.checked;for(const s of materialSources){s.material.map=recipe.materials?s.map:null;s.material.normalMap=recipe.materials?s.normalMap:null;s.material.roughnessMap=recipe.materials?s.roughnessMap:null;s.material.needsUpdate=true;}};
$('details').onchange=e=>{recipe.details=e.target.checked;details.visible=recipe.details;};
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'继续轨迹':'暂停轨迹';};
$('reset').onclick=()=>location.reload();
$('save').onclick=()=>{
  const data={...recipe,view,orbit:{position:camera.position.toArray(),target:controls.target.toArray()},assets:{car:'/cars/mazda-miata-mx5-na.glb',textures:textureRoot},note:'构图与材质实验；轨迹未连接生产物理'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='streetrush-scene-recipe.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();});
$('loading').hidden=true;
function animate(now){
  requestAnimationFrame(animate);const dt=Math.min(.05,(now-last)/1000);last=now;smoothedFrame=THREE.MathUtils.damp(smoothedFrame,dt*1000,3,dt);
  if(view==='orbit')controls.update();else{
    if(!paused)travel=(travel+dt*recipe.speedKmh/3.6)%98;
    const z=-40+travel;car.position.set(1,.06,z);
    const factor=Math.min(1,recipe.speedKmh/260);
    let height=2.9,distance=7.8,ahead=12,fov=56+factor*6,damping=7;
    if(recipe.camera==='current'){height=4.25;distance=9.4+factor*2.2;ahead=7.5+factor*4;fov=58+factor*11;damping=8.5;}
    if(recipe.camera==='steady'){height=3.25;distance=8.6;ahead=15;fov=58;damping=10;}
    desiredPosition.set(1,height,z-distance);desiredTarget.set(1,1.15,z+ahead);
    if(camera.position.distanceTo(desiredPosition)>35){camera.position.copy(desiredPosition);lookTarget.copy(desiredTarget);}
    camera.position.lerp(desiredPosition,1-Math.exp(-damping*dt));lookTarget.lerp(desiredTarget,1-Math.exp(-12*dt));camera.lookAt(lookTarget);camera.fov=THREE.MathUtils.damp(camera.fov,fov,6,dt);camera.updateProjectionMatrix();
  }
  renderer.render(scene,camera);
  if(now-metricTime>600){metricTime=now;$('metrics').textContent=`FRAME ${smoothedFrame.toFixed(1)} ms · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles/1000).toFixed(0)}k triangles\n资源降级 ${assetResults.length} · seed ${recipe.seed}`;}
}
requestAnimationFrame(animate);
