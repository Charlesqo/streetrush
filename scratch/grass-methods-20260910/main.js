import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Independent visual study. No production entry points, physics, UI or assets
// are modified. Existing textures are read from the local repository only.
const $ = s => document.querySelector(s);
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.setSize(innerWidth,innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = .9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#b8d2dd');
scene.fog = new THREE.FogExp2('#b4c6c2',.0038);
const camera = new THREE.PerspectiveCamera(57,innerWidth/innerHeight,.06,1800);
const controls = new OrbitControls(camera,canvas);
controls.enableDamping = true;
controls.dampingFactor = .075;
controls.maxPolarAngle = Math.PI*.495;
controls.minDistance = .4;
controls.maxDistance = 140;
const hemi = new THREE.HemisphereLight('#d4e7ef','#686349',1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff3d6',2.8);
sun.position.set(-48,60,18);
sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
Object.assign(sun.shadow.camera,{left:-52,right:52,top:65,bottom:-65,near:1,far:170});
sun.shadow.normalBias=.025;
sun.shadow.bias=-.00015;
scene.add(sun,sun.target);

const clock = new THREE.Clock();
const uniforms = {time:{value:0},wind:{value:1},eye:{value:new THREE.Vector3()},density:{value:1}};
const materialList=[];
const initialQuery=new URLSearchParams(location.search);
let mode='hybrid',view='drive',compare=false,travel=false,travelTime=0,lastMeasure=0,frameTimes=[],previousFrame=0,nextRenderAt=0,pendingFrames=3;
const groups={cards:new THREE.Group(),blades:new THREE.Group()};
groups.cards.name='AI crossed grass cards'; groups.blades.name='Curved geometric grass blades';
scene.add(groups.cards,groups.blades);
const chunks=[];
function rng(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
const random = rng(9821);
const roadX = z => 6*Math.sin(z*.018)+.00045*z*z;
const terrainY = (x,z) => {
  const distance = Math.abs(x-roadX(z));
  return -.055 + THREE.MathUtils.smoothstep(distance,8.0,24)*(.6+.35*Math.sin(z*.025)+.18*Math.sin(x*.14+z*.08));
};
const patch = (x,z) => .5+.23*Math.sin(x*.56+Math.sin(z*.2)*2)+.18*Math.sin(z*.73-x*.32)+.09*Math.cos(x*2.4+z*1.23);
const fieldColor = (x,z) => new THREE.Color().setHSL(.225+patch(x,z)*.018,.23+patch(x,z)*.08,.24+patch(x,z)*.075);

const loader = new THREE.TextureLoader();
async function texture(url,repeat=1,color=true){
  const t=await loader.loadAsync(url);t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.setScalar(repeat);t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return t;
}
function mesh(geometry,material,parent=scene){const m=new THREE.Mesh(geometry,material);parent.add(m);return m;}
function box(w,h,d,x,y,z,material){const m=mesh(new THREE.BoxGeometry(w,h,d),material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;return m;}
function roadBand(a,b,y,material){
  if(a>b)[a,b]=[b,a];
  const pos=[],uv=[],indices=[];
  for(let i=0;i<=180;i++){
    const z=-112+i;for(const x of [a,b]){pos.push(roadX(z)+x,y,z);uv.push(x/5,z/5);}
    if(i<180){let j=i*2;indices.push(j,j+2,j+1,j+1,j+2,j+3);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();
  const m=mesh(g,material);m.receiveShadow=true;return m;
}

// Wind and distance transitions are evaluated on the GPU. Both methods share
// wind and world-space positions; the roots stay fixed, including on slopes.
function vegetationMaterial({map=null,type}){
  const m=new THREE.MeshStandardMaterial({map,side:THREE.DoubleSide,roughness:.98,metalness:0,vertexColors:type==='blade',alphaTest:map?.58:0,alphaToCoverage:!!map});
  const state={near:{value:0},far:{value:68},hybrid:{value:0}};
  m.userData.study=state;
  m.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{uTime:uniforms.time,uWind:uniforms.wind,uEye:uniforms.eye,uDensity:uniforms.density,uNear:state.near,uFar:state.far,uHybrid:state.hybrid});
    shader.vertexShader=`uniform float uTime,uWind,uDensity,uNear,uFar,uHybrid; uniform vec3 uEye; varying vec3 vFieldPos; varying float vGrassHeight; varying float vKeep;\n`+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`
      #include <begin_vertex>
      vec4 root = modelMatrix * instanceMatrix * vec4(0.,0.,0.,1.);
      float distToEye = distance(root.xz,uEye.xz);
      float nearFade = uNear > 0. ? smoothstep(uNear-6.,uNear+6.,distToEye) : 1.;
      float farFade = 1.-smoothstep(uFar-9.,uFar,distToEye);
      float h = ${type==='blade'?'position.y':'uv.y'};
      float wave = sin(uTime*1.75+root.x*.68+root.z*.35)+.45*sin(uTime*2.83+root.z*.7);
      transformed.x += wave*.10*h*h*uWind;
      transformed.z += cos(uTime*1.35+root.z*.4)*.045*h*h*uWind;
      float keep = nearFade*farFade;
      float seed = fract(sin(dot(root.xz,vec2(12.9898,78.233)))*43758.5453);
      float densityKeep = smoothstep(seed-.07,seed+.07,uDensity/1.5);
      transformed.y *= keep*densityKeep;
      vKeep = keep*densityKeep;
      vGrassHeight = h;
      vFieldPos = root.xyz;
    `);
    shader.fragmentShader=`varying vec3 vFieldPos; varying float vGrassHeight; varying float vKeep;\n`+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
      #include <map_fragment>
      ${map?`// Reject low-alpha fringe texels, then restrain remaining chroma in
      // material space. Original image files remain untouched.
      float luma = dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
      diffuseColor.rgb = mix(vec3(.026,.056,.009),vec3(.155,.225,.056),smoothstep(.005,.39,luma));`:''}
      diffuseColor.rgb *= mix(.58,1.08,smoothstep(0.,.75,vGrassHeight));
      if(vKeep<.025) discard;
    `);
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_end>',`
      #include <lights_fragment_end>
      // A modest leaf translucency approximation; direct light and shadows
      // still come from the same scene rig as the ground and road.
      reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(.06,.075,.035) * vGrassHeight;
    `);
    shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>',`
      #include <normal_fragment_begin>
      vec3 grassUp = normalize(mat3(viewMatrix) * vec3(0.,1.,0.));
      normal = ${map?'grassUp':'normalize(normal*.52+grassUp*.72)'};
    `);
  };
  m.customProgramCacheKey=()=>`grass-study-${type}-v1`;
  materialList.push(m);return m;
}

function cardGeometry(rect){
  const pos=[],uv=[],normal=[],index=[];
  // Three stationary intersecting cards. They do not swivel toward the camera.
  for(let p=0;p<3;p++){
    const a=p*Math.PI/3,dx=Math.cos(a)*.5,dz=Math.sin(a)*.5;
    const n=[-Math.sin(a)*.45,.89,Math.cos(a)*.45];
    const j=pos.length/3;
    pos.push(-dx,0,-dz,dx,0,dz,-dx,1,-dz,dx,1,dz);
    for(let k=0;k<4;k++)normal.push(...n);
    uv.push(rect[0],rect[1],rect[2],rect[1],rect[0],rect[3],rect[2],rect[3]);
    index.push(j,j+1,j+2,j+1,j+3,j+2);
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(index);
  // Card wind/root gradient needs a separate normalized height, not atlas UV.
  return g;
}

function bladeGeometry(){
  const positions=[],colors=[],indices=[];
  // Three curved segments, two vertices per level: six triangles per blade.
  for(let level=0;level<=3;level++){
    const h=level/3,width=.025*(.3+.7*Math.sin(h*2.5))*(1.-h*h*h)+.00015;
    for(const edge of [-1,1]){
      positions.push(edge*width+.065*h*h,h,.65*h*h);
      const c=new THREE.Color().setHSL(.21+h*.012,.4,.20+h*.26).convertSRGBToLinear();colors.push(c.r,c.g,c.b);
    }
    if(level<3){const i=level*2;indices.push(i,i+2,i+1,i+1,i+2,i+3);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setIndex(indices);g.computeVertexNormals();return g;
}

async function build(){
  const [grass,asphalt,asphaltNormal,gravel,...maps]=await Promise.all([
    texture('/scenery/longwan/textures/grass.jpg'),texture('/textures/asphalt/asphalt_01_diff_1k.jpg'),texture('/textures/asphalt/asphalt_01_nor_gl_1k.jpg',1,false),texture('/scenery/longwan/textures/gravel.jpg'),
    ...['a-short','b-sparse','c-wild','d-mixed'].map(n=>texture(`../grass-generation-20260910/${n}.png`))
  ]);
  for(const t of maps){t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=8;}
  const turf=new THREE.MeshStandardMaterial({map:grass,color:'#a6b897',roughness:1,vertexColors:true});
  turf.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec3 vTerrainWorld;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvTerrainWorld=(modelMatrix*vec4(position,1.)).xyz;');
    shader.fragmentShader='varying vec3 vTerrainWorld;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
      #include <map_fragment>
      vec3 groundSample=texture2D(map,vMapUv).rgb;
      float detail=dot(groundSample,vec3(.25,.6,.15));
      float growth=.5+.23*sin(vTerrainWorld.x*.56+sin(vTerrainWorld.z*.2)*2.)+.18*sin(vTerrainWorld.z*.73-vTerrainWorld.x*.32);
      vec3 soil=vec3(.085,.074,.039)*(.6+detail*1.8);
      vec3 lawn=vec3(.065,.10,.024)*(.7+detail*1.8);
      diffuseColor.rgb=mix(soil,lawn,smoothstep(.16,.65,growth));
    `);
  };
  turf.customProgramCacheKey=()=> 'study-turf-v1';
  const ground=new THREE.PlaneGeometry(240,280,150,175);ground.rotateX(-Math.PI/2);
  const pos=ground.attributes.position,uv=ground.attributes.uv,colors=[];
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i),z=pos.getZ(i);pos.setY(i,terrainY(x,z));uv.setXY(i,x/3.5,z/3.5);
    const c=fieldColor(x,z).multiplyScalar(1.9);colors.push(c.r,c.g,c.b);
  }
  ground.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));ground.computeVertexNormals();mesh(ground,turf).receiveShadow=true;
  const asphaltMat=new THREE.MeshStandardMaterial({map:asphalt,normalMap:asphaltNormal,normalScale:new THREE.Vector2(.35,.35),color:'#b5b7b6',roughness:.94});
  const gravelMat=new THREE.MeshStandardMaterial({map:gravel,color:'#c5bda5',roughness:1});
  const whiteMat=new THREE.MeshStandardMaterial({color:'#e2e0cf',roughness:.9});
  roadBand(-6.4,6.4,.004,asphaltMat);
  for(const sign of [-1,1]){
    roadBand(sign*6.4,sign*7.3,-.018,gravelMat);
    roadBand(sign*6.12,sign*6.25,.014,whiteMat);
  }
  // Small red/cream kerbs follow the outer bend; grass never covers asphalt.
  const red=new THREE.MeshStandardMaterial({color:'#a7523d',roughness:.86});
  const concrete=new THREE.MeshStandardMaterial({color:'#bdc0ac',roughness:.95});
  const steel=new THREE.MeshStandardMaterial({color:'#89958a',metalness:.52,roughness:.6});
  for(let z=-98;z<48;z+=1.5){
    const k=box(.72,.065,1.46,roadX(z)+6.65,.006,z,Math.round(z/1.5)%2?red:whiteMat);
    k.rotation.y=Math.atan((roadX(z+.5)-roadX(z-.5)));
  }
  for(let z=-103;z<62;z+=6){
    const x=roadX(z)-11.6;
    box(.12,.75,.12,x,.34,z,steel);
    const rail=box(.10,.25,6.08,x,.56,z+3,steel);rail.rotation.y=Math.atan((roadX(z+6)-roadX(z))/6);
    if(z%18===-13){const marker=box(.11,.65,.1,roadX(z)+8.0,.3,z,whiteMat);marker.rotation.y=.1;}
  }
  // Restrained background context is shared by every method.
  const distantMat=new THREE.MeshStandardMaterial({color:'#586d63',roughness:1,flatShading:false});
  for(let k=0;k<9;k++){
    const hill=mesh(new THREE.SphereGeometry(1,24,12),distantMat);hill.scale.set(65+random()*65,11+random()*11,45+random()*40);hill.position.set(-170+k*48,-9,-220-random()*50);
  }
  const treeMap=await texture('/scenery/longwan/textures/tree-0.png');
  const canopy=new THREE.MeshBasicMaterial({map:treeMap,color:new THREE.Color(2.8,2.85,2.65),alphaTest:.3,side:THREE.DoubleSide,fog:true});
  for(let i=0;i<34;i++){
    const x=(random()>.5?1:-1)*(42+random()*58),z=-140+random()*170,h=5+random()*5;
    const tree=mesh(new THREE.PlaneGeometry(h*1.15,h),canopy);tree.position.set(x,terrainY(x,z)+h*.46,z);tree.rotation.y=x>0?-.45:.45;
  }
  // Merge static roadside boxes by material; shadows are baked once for this
  // fixed-light study, not redrawn for hundreds of individual kerb blocks.
  const mergeByMaterial=new Map();
  for(const object of [...scene.children])if(object.isMesh&&object.geometry.type==='BoxGeometry'){
    object.updateMatrix();const g=object.geometry.clone().applyMatrix4(object.matrix);
    if(!mergeByMaterial.has(object.material))mergeByMaterial.set(object.material,[]);
    mergeByMaterial.get(object.material).push(g);scene.remove(object);object.geometry.dispose();
  }
  for(const [mat,geos] of mergeByMaterial){const merged=mesh(mergeGeometries(geos),mat);merged.castShadow=merged.receiveShadow=true;for(const g of geos)g.dispose();}

  const rects=[
    [20/1254,1-841/1254,1220/1254,1-610/1254],
    [28/1254,1-950/1254,1228/1254,1-442/1254],
    [25/1254,1-941/1254,1234/1254,1-323/1254],
    [33/1239,1-983/1269,1212/1239,1-347/1269]
  ];
  const cardMaterials=maps.map(map=>vegetationMaterial({map,type:'card'}));
  // Normalize vertex height independently of each image crop for rooted wind.
  cardMaterials.forEach(m=>{
    const compile=m.onBeforeCompile;
    m.onBeforeCompile=s=>{compile(s);s.vertexShader=s.vertexShader.replace('float h = uv.y;','float h = position.y;');};
  });
  const cardGeometries=rects.map(cardGeometry),bladeGeo=bladeGeometry();
  const bladeMat=vegetationMaterial({type:'blade'});
  const dummy=new THREE.Object3D();
  const makeBatch=(g,m,placements,parent,name)=>{
    const im=new THREE.InstancedMesh(g,m,placements.length);im.name=name;
    const tint=new THREE.Color();
    for(let i=0;i<placements.length;i++){
      const p=placements[i];dummy.position.set(p.x,p.y,p.z);dummy.rotation.set(0,p.a,0);dummy.scale.set(p.w,p.h,p.d??p.w);dummy.updateMatrix();im.setMatrixAt(i,dummy.matrix);
      tint.setRGB(p.tint,p.tint*(.98+p.shade*.035),p.tint*.91);im.setColorAt(i,tint);
    }
    im.instanceMatrix.needsUpdate=true;if(im.instanceColor)im.instanceColor.needsUpdate=true;im.computeBoundingSphere();im.boundingSphere.radius+=1;
    im.castShadow=false;im.receiveShadow=true;parent.add(im);return im;
  };
  // 180 m sample, planted in 10 m chunks. Both methods use the same biome mask.
  for(let zStart=-108;zStart<62;zStart+=10)for(const sign of [-1,1])for(let strip=0;strip<2;strip++){
    const seeded=rng((zStart+200)*991+strip*631+(sign+2)*421),cards=[[],[],[],[]],blades=[];
    const width=7,offsetStart=7.4+strip*width;
    for(let n=0;n<780;n++){
      const z=zStart+seeded()*10,offset=offsetStart+seeded()*width,x=roadX(z)+sign*offset;
      const p=patch(x,z),edge=THREE.MathUtils.smoothstep(offset,7.4,8.2);
      if(seeded()>(.48+.45*p)*edge)continue;
      const k=strip===0?(seeded()<.72?0:1):(seeded()<.66?2:3);
      const h=(k===0?.10:k===1?.16:.22)+seeded()*(strip===0?.14:.29);
      const aspect=(rects[k][2]-rects[k][0])/(rects[k][3]-rects[k][1]);
      cards[k].push({x,z,y:terrainY(x,z)-.024,a:seeded()*Math.PI,h,w:h*aspect*.66,tint:.78+seeded()*.34,shade:p});
    }
    for(let n=0;n<3300;n++){
      const z=zStart+seeded()*10,offset=offsetStart+seeded()*width,x=roadX(z)+sign*offset;
      const p=patch(x,z),edge=THREE.MathUtils.smoothstep(offset,7.4,7.9);
      if(seeded()>(.44+.5*p)*edge)continue;
      const clumpHeight=(strip===0?.10:.17)+seeded()**1.7*(strip===0?.19:.30);
      for(let leaf=0;leaf<8;leaf++){
        const a=seeded()*Math.PI*2,spread=seeded()*.085,bx=x+Math.cos(a)*spread,bz=z+Math.sin(a)*spread,h=clumpHeight*(.55+seeded()*.70);
        blades.push({x:bx,z:bz,y:terrainY(bx,bz)-.008,a,w:.13+seeded()*.18,h,d:h*(.6+seeded()*.65),tint:.86+seeded()*.42,shade:p});
      }
    }
    const center=new THREE.Vector3(roadX(zStart+5)+sign*(offsetStart+width/2),0,zStart+5);
    const cardMeshes=cards.map((list,k)=>makeBatch(cardGeometries[k],cardMaterials[k],list,groups.cards,`Cards ${zStart}/${sign}/${strip}/${k}`));
    const bladeMesh=makeBatch(bladeGeo,bladeMat,blades,groups.blades,`Blades ${zStart}/${sign}/${strip}`);
    chunks.push({center,cards:cardMeshes,blades:bladeMesh});
  }
  try{
    const hdr=await new HDRLoader().loadAsync('/textures/sky/kloofendal_48d_partly_cloudy_puresky_2k.hdr');hdr.mapping=THREE.EquirectangularReflectionMapping;
    scene.background=hdr;scene.backgroundRotation.y=.35;scene.backgroundIntensity=.8;
    const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromEquirectangular(hdr);scene.environment=env.texture;scene.environmentIntensity=.45;pmrem.dispose();
  }catch(e){console.warn('Preview HDR unavailable; using neutral sky',e);}
  setView(['drive','edge','low','overhead'].includes(initialQuery.get('view'))?initialQuery.get('view'):'drive');
  setMode(['ground','cards','blades','hybrid'].includes(initialQuery.get('mode'))?initialQuery.get('mode'):'hybrid');
  if(initialQuery.get('compare')==='1')toggleCompare();
  renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
  $('#loading').remove();
  document.body.dataset.ready='true';
  requestAnimationFrame(frame);
}

const descriptions={ground:'只有地面颜色与纹理，没有竖立草叶。用于判断体积究竟改善了多少。',cards:'使用刚生成的四张透明草图。每簇三片交叉，近看和斜看可检查平面感。',blades:'每根草都是弯曲、收尖的真实几何。无需透明图片，侧看也保留体积。',hybrid:'近处用真实叶片建立体积，远处过渡到轻量草丛贴片。'};
function saveView(){const q=new URLSearchParams({mode,view});if(compare)q.set('compare','1');history.replaceState(null,'',`${location.pathname}?${q}`);}
function setMode(next){mode=next;for(const b of document.querySelectorAll('[data-mode]')){b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode));}$('#method-note').textContent=descriptions[mode];document.body.dataset.mode=mode;frameTimes=[];saveView();}
function setView(next){
  view=next;travel=false;$('#travel').textContent='▶ 沿路移动';$('#travel').classList.remove('active');
  const presets={drive:{eye:[roadX(35)+3.7,1.35,35],target:[roadX(4)+6.3,.32,4]},edge:{eye:[roadX(25)+6.9,.72,25],target:[roadX(17)+10.1,.21,17]},low:{eye:[roadX(22)+8.0,.25,22],target:[roadX(16)+10.5,.19,16]},overhead:{eye:[42,39,47],target:[4,0,-12]}};
  camera.position.fromArray(presets[next].eye);controls.target.fromArray(presets[next].target);controls.update();
  for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===next);
  document.body.dataset.view=next;frameTimes=[];saveView();
}
function configure(method){
  groups.cards.visible=method==='cards'||method==='hybrid';groups.blades.visible=method==='blades'||method==='hybrid';
  for(const m of materialList){const isCard=!!m.map;m.userData.study.near.value=method==='hybrid'&&isCard?19:0;m.userData.study.far.value=method==='hybrid'&&!isCard?31:76;}
  for(const c of chunks){
    const d=Math.hypot(camera.position.x-c.center.x,camera.position.z-c.center.z);
    for(const m of c.cards)m.visible=d<88;
    c.blades.visible=d<(method==='hybrid'?43:88);
  }
}
function frame(now){
  requestAnimationFrame(frame);
  if(document.hidden)return;
  controls.update();
  if(!travel&&!$('#wind').checked&&pendingFrames<=0){previousFrame=0;$('#metrics').textContent=`已停绘 · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles/1000).toFixed(0)}k 三角形`;return;}
  pendingFrames--;
  if(now<nextRenderAt-.5)return;
  nextRenderAt=Math.max(nextRenderAt+1000/60,now-1);
  const dt=Math.min(clock.getDelta(),.05);uniforms.time.value+=dt;
  if(travel){
    travelTime+=dt;const z=46-(travelTime*7)%142;
    camera.position.set(roadX(z)+4.3,1.35,z);controls.target.set(roadX(z-22)+6.8,.28,z-22);
  }
  controls.update();uniforms.eye.value.copy(camera.position);
  const {width,height}=renderer.getSize(new THREE.Vector2());
  renderer.info.reset();
  if(compare){
    renderer.setScissorTest(true);
    ['cards','blades','hybrid'].forEach((method,i)=>{
      const w=Math.floor(width/3),x=i*w;renderer.setViewport(x,0,i===2?width-x:w,height);renderer.setScissor(x,0,i===2?width-x:w,height);
      camera.aspect=w/height;camera.updateProjectionMatrix();configure(method);renderer.render(scene,camera);
    });
    renderer.setScissorTest(false);renderer.setViewport(0,0,width,height);
  }else{camera.aspect=width/height;camera.updateProjectionMatrix();configure(mode);renderer.render(scene,camera);}
  if(previousFrame)frameTimes.push(now-previousFrame);previousFrame=now;
  if(now-lastMeasure>900){
    const sorted=frameTimes.sort((a,b)=>a-b),p95=sorted[Math.floor(sorted.length*.95)]??0;
    const avg=frameTimes.reduce((n,t)=>n+t,0)/Math.max(1,frameTimes.length);
    $('#metrics').textContent=`${(1000/Math.max(.1,avg)).toFixed(0)} FPS · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles/1000).toFixed(0)}k 三角形`;
    $('#metrics').title=`独立样段，最高60 FPS；当前帧间隔 P95 ${p95.toFixed(1)} ms。绘制次数和三角形为提交量，不代表完整游戏或手机性能。`;
    $('#metrics').dataset.triangles=String(renderer.info.render.triangles);$('#metrics').dataset.draws=String(renderer.info.render.calls);$('#metrics').dataset.p95=p95.toFixed(1);
    frameTimes=[];lastMeasure=now;
  }
}

for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>{if(compare)toggleCompare();setMode(b.dataset.mode);};
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>setView(b.dataset.view);
function toggleCompare(){compare=!compare;document.body.classList.toggle('comparing',compare);$('#compare-labels').hidden=!compare;$('#compare').textContent=compare?'↙ 返回单方案观察':'三种方法并排比较 ↗';frameTimes=[];saveView();}
$('#compare').onclick=toggleCompare;
$('#density').oninput=e=>{uniforms.density.value=Number(e.target.value);$('#density-value').textContent=({'0.5':'稀疏','1':'标准','1.5':'茂密'})[e.target.value];};
$('#wind').onchange=e=>{uniforms.wind.value=e.target.checked?1:0;};
$('#travel').onclick=()=>{travel=!travel;travelTime=0;$('#travel').classList.toggle('active',travel);$('#travel').textContent=travel?'Ⅱ 暂停移动':'▶ 沿路移动';};
controls.addEventListener('start',()=>{travel=false;$('#travel').textContent='▶ 沿路移动';$('#travel').classList.remove('active');});
addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();});
for(const event of ['click','input','pointermove','wheel','resize'])addEventListener(event,()=>{pendingFrames=4;});
controls.addEventListener('change',()=>{pendingFrames=4;});
addEventListener('visibilitychange',()=>{clock.getDelta();previousFrame=0;nextRenderAt=0;frameTimes=[];});
build().catch(error=>{console.error(error);$('#loading')?.remove();$('#error').hidden=false;$('#error').textContent='样段加载失败\n'+error.message;});
