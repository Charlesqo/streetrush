import * as THREE from 'three';
import { createOutdoorLighting } from '/src/rendering.js';
import { createRenderPipeline } from '/src/render-pipeline.js';
import { installScanSurfaceSampling } from '/src/scan-surface-sampling.js';

const W=1015,H=866, $=id=>document.getElementById(id);
const renderer=new THREE.WebGLRenderer({canvas:$('canvas'),antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);renderer.setSize(W,H,false);
const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(58,W/H,.1,1300);
const rig=createOutdoorLighting(renderer,scene);
const target=new THREE.WebGLRenderTarget(W,H,{type:THREE.FloatType,depthBuffer:true});
const pixels=new Float32Array(W*H*4);
const mode={value:0};
const labels=['total','directDiffuse','directSpecular','indirectDiffuse','indirectSpecular','normalEncoded','roughness','baseColor'];
let busy=false;
const materials={}, sources={};
const texLoader=new THREE.TextureLoader();
const planeGeo=new THREE.BufferGeometry();
planeGeo.setAttribute('position',new THREE.Float32BufferAttribute([0,0,-7,0,0,7,180,0,-7,180,0,7],3));
planeGeo.setAttribute('uv',new THREE.Float32BufferAttribute([0,-7,0,7,180,-7,180,7],2));
planeGeo.setIndex([0,1,2,1,3,2]);planeGeo.computeVertexNormals();
const plane=new THREE.Mesh(planeGeo,new THREE.MeshStandardMaterial({color:.2}));plane.receiveShadow=false;scene.add(plane);
const report={description:'Controlled GPU lab, real source textures and project light functions. Plane-only frozen venue probe; no track buildings, GTAO, fog or output AA in float measurements. NOT production GPU performance.',three:THREE.REVISION,size:[W,H],rows:[]};
function instrument(mat){
  const before=mat.onBeforeCompile, key=mat.customProgramCacheKey.bind(mat);
  const oldKey=key();
  mat.onBeforeCompile=(shader,renderer)=>{
    before.call(mat,shader,renderer);
    shader.uniforms.labMode=mode;
    shader.fragmentShader='uniform int labMode;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
      if(labMode==1) outgoingLight=reflectedLight.directDiffuse;
      if(labMode==2) outgoingLight=reflectedLight.directSpecular;
      if(labMode==3) outgoingLight=reflectedLight.indirectDiffuse;
      if(labMode==4) outgoingLight=reflectedLight.indirectSpecular;
      if(labMode==5) outgoingLight=normal*.5+.5;
      if(labMode==6) outgoingLight=vec3(material.roughness);
      if(labMode==7) outgoingLight=diffuseColor.rgb;
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey=()=>oldKey+'-lab-aov-v1';
}
function light(which){rig.sun.intensity=['sun','all'].includes(which)?3.5:0;rig.fill.intensity=['hemi','all'].includes(which)?.48:0;scene.environmentIntensity=['env','all'].includes(which)?.8:0;}
function pose(view){
  camera.position.set(0,view==='drive'?1.7:.65,0);
  camera.lookAt(view==='drive'?24:8,view==='drive'?1:.05,0);
  camera.updateMatrixWorld(true);
}
function display(){
  if(busy)return;
  plane.material=materials[$('asset').value][$('sampling').value];
  pose($('view').value);light($('light').value);mode.value=Number($('aov').value);
  renderer.toneMapping=mode.value>=5?THREE.NoToneMapping:THREE.ACESFilmicToneMapping;
  renderer.setRenderTarget(null);renderer.render(scene,camera);
}
function summarize(data,mask){
  let n=0,sum=0,sq=0,hp=0,hpn=0;const channels=[0,0,0];
  for(const i of mask){const j=i*4,r=data[j],g=data[j+1],b=data[j+2];if(!Number.isFinite(r+g+b))throw new Error('Nonfinite GPU output');
    const y=.2126*r+.7152*g+.0722*b;n++;sum+=y;sq+=y*y;channels[0]+=r;channels[1]+=g;channels[2]+=b;
    if(i%W>1&&i%W<W-2&&i>W&&i<W*(H-1)){
      let neighbour=0;for(const q of [i-1,i+1,i-W,i+W])neighbour+=.2126*data[q*4]+.7152*data[q*4+1]+.0722*data[q*4+2];
      hp+=(y-neighbour*.25)**2;hpn++;
    }
  }
  return {pixels:n,mean:sum/n,std:Math.sqrt(Math.max(0,sq/n-(sum/n)**2)),highpassRms:Math.sqrt(hp/hpn),meanRGB:channels.map(v=>v/n)};
}
function masks(){
  const ranges=[[3,8],[8,20],[20,50]],out=ranges.map(()=>[]),v=new THREE.Vector3();
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){
    v.set((x+.5)/W*2-1,(y+.5)/H*2-1,.5).unproject(camera).sub(camera.position).normalize();
    if(v.y>=0)continue;const t=-camera.position.y/v.y;
    const px=camera.position.x+t*v.x,pz=camera.position.z+t*v.z;
    if(Math.abs(pz)>5.5)continue;
    ranges.forEach(([a,b],k)=>{if(px>=a&&px<b)out[k].push(y*W+x);});
  }
  return out;
}
async function read(modeValue){mode.value=modeValue;renderer.toneMapping=THREE.NoToneMapping;renderer.setRenderTarget(target);renderer.render(scene,camera);await renderer.readRenderTargetPixelsAsync(target,0,0,W,H,pixels);return pixels;}
const yieldUI=()=>new Promise(resolve=>requestAnimationFrame(resolve));
function publish(){ $('results').value=JSON.stringify(report,null,2);$('results').textContent=$('results').value; }
async function matrix(){
  busy=true;report.rows=[];try{
    for(const view of ['drive','near']){pose(view);const regions=masks();
      for(const asset of ['asphalt','fresh'])for(const sampling of ['plain','mixed']){
        plane.material=materials[asset][sampling];
        for(const illumination of ['all','sun','env','hemi']){
          light(illumination);const row={view,asset,sampling,illumination,aov:{}};
          const totals=[];let totalL=0;
          for(let channel=0;channel<8;channel++){
            if(illumination!=='all'&&channel>4)continue;
            const data=await read(channel);row.aov[labels[channel]]=regions.map(mask=>summarize(data,mask));
            if(channel===0)totalL=row.aov.total[0].mean;
            else if(channel<=4)totals.push(row.aov[labels[channel]][0].mean);
          }
          row.closureRelativeError=Math.abs(totals.reduce((a,b)=>a+b,0)-totalL)/Math.max(totalL,1e-8);
          report.rows.push(row);$('status').textContent=`已完成 ${report.rows.length}/32 · ${asset} / ${sampling} / ${illumination}`;await yieldUI();
        }
      }
    }
    publish();$('status').textContent='矩阵完成：32 组实际 GPU 分项；结果已显示';
  }catch(e){$('status').textContent='诊断失败：'+e.stack;console.error(e);}finally{busy=false;display();}
}
async function dfgTest(){
  busy=true;
  const saved={env:scene.environment,intensity:scene.environmentIntensity,material:plane.material};
  let white;
  try{
    const flat=new THREE.MeshStandardMaterial({color:0x111111,metalness:0,roughness:.837});flat.fog=false;instrument(flat);plane.material=flat;
    const uniformScene=new THREE.Scene();uniformScene.background=new THREE.Color(1,1,1);
    const generator=new THREE.PMREMGenerator(renderer);white=generator.fromScene(uniformScene,0,.1,100);generator.dispose();
    scene.environment=white.texture;light('none');scene.environmentIntensity=1;
    const ortho=new THREE.OrthographicCamera(-.01,.01,.01,-.01,.01,100);
    const tiny=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType});const one=new Float32Array(4);
    const payload=await (await fetch('/research-output/asphalt-research-review-20260916/received/c/dfg-reference.json')).json();
    const binary=Uint8Array.from(atob(payload.base64),x=>x.charCodeAt(0));const vals=new Float32Array(binary.length/4),dv=new DataView(binary.buffer);for(let i=0;i<vals.length;i++)vals[i]=dv.getFloat32(i*4,true);
    const lut=new THREE.DataTexture(vals,payload.width,payload.height,THREE.RGFormat,THREE.FloatType);lut.minFilter=lut.magFilter=THREE.NearestFilter;lut.needsUpdate=true;
    const patched=flat.clone();instrument(patched);const aovHook=patched.onBeforeCompile;
    patched.onBeforeCompile=(shader,renderer)=>{
      aovHook(shader,renderer);shader.uniforms.labLut={value:lut};
      let chunk=THREE.ShaderChunk.lights_physical_pars_fragment;
      const start=chunk.indexOf('vec2 DFGApprox('),open=chunk.indexOf('{',start);let end=open,level=0;
      for(;end<chunk.length;end++){if(chunk[end]==='{')level++;if(chunk[end]==='}'&&--level===0)break;}
      const replacement=`uniform sampler2D labLut;vec2 DFGApprox(const in vec3 n,const in vec3 v,const in float r){
        vec2 dims=vec2(${payload.width}.0,${payload.height}.0);vec2 p=(vec2(clamp(dot(n,v),.025,1.),clamp(r,.6,1.))-vec2(.025,.6))/vec2(.975,.4)*(dims-1.);
        vec2 a=floor(p),b=min(a+1.,dims-1.),f=fract(p);
        vec2 q0=mix(texture2D(labLut,(a+.5)/dims).rg,texture2D(labLut,(vec2(b.x,a.y)+.5)/dims).rg,f.x);
        vec2 q1=mix(texture2D(labLut,(vec2(a.x,b.y)+.5)/dims).rg,texture2D(labLut,(b+.5)/dims).rg,f.x);return mix(q0,q1,f.y);}`;
      chunk=chunk.slice(0,start)+replacement+chunk.slice(end+1);
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',chunk);
    };patched.customProgramCacheKey=()=> 'independent-lab-dfg-reference-v1';
    const results=[];
    for(const nv of [1,.5,.1])for(const variant of ['legacy','referenceLut']){
      ortho.position.set(20-10*Math.sqrt(1-nv*nv),nv*10,0);ortho.lookAt(20,0,0);ortho.updateMatrixWorld(true);
      plane.material=variant==='legacy'?flat:patched;
      for(const m of [3,4]){mode.value=m;renderer.toneMapping=THREE.NoToneMapping;renderer.setRenderTarget(tiny);renderer.render(scene,ortho);await renderer.readRenderTargetPixelsAsync(tiny,0,0,1,1,one);results.push({nv,variant,component:labels[m],rgb:Array.from(one.slice(0,3))});}
    }
    report.dfg={conditions:'Constant unit environment. Plane normal, r=.837, Standard F0=.04. No direct/hemisphere/AO/fog. Values include existing IBL multiple scattering. Reference LUT only used at its validated coordinates.',results};
    publish();$('status').textContent='DFG GPU 验证完成';tiny.dispose();flat.dispose();patched.dispose();lut.dispose();
  }catch(e){$('status').textContent='DFG 失败：'+e.stack;console.error(e);}finally{scene.environment=saved.env;scene.environmentIntensity=saved.intensity;plane.material=saved.material;white?.dispose();busy=false;display();}
}
async function captureTest(){
  busy=true;
  try{
    pose('drive');light('all');plane.material=materials.asphalt.mixed;
    const regions=masks(),history=[];
    for(let iteration=0;iteration<4;iteration++){
      if(iteration){mode.value=0;rig.captureVenue(new THREE.Vector3(-55,2.5,12),null);}
      await read(0);const combined=regions.map(m=>summarize(pixels,m));
      await read(4);const environmentSpecular=regions.map(m=>summarize(pixels,m));
      history.push({iteration,total:combined,environmentSpecular});
    }
    mode.value=0;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.setRenderTarget(null);renderer.render(scene,camera);
    const screen=new Uint8Array(W*H*4);const gl=renderer.getContext();gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,screen);
    const before=screen.slice();const pipeline=createRenderPipeline(renderer,scene,camera);
    await pipeline.warmup();pipeline.render();gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,screen);
    const post=regions.map(mask=>{
      let sum=0,b=0,a=0;for(const i of mask)for(let k=0;k<3;k++){sum+=Math.abs(screen[i*4+k]-before[i*4+k]);b+=before[i*4+k];a+=screen[i*4+k];}
      return {beforeMean8bit:b/(mask.length*3),afterMean8bit:a/(mask.length*3),meanAbsoluteDifference8bit:sum/(mask.length*3)};
    });
    report.captureHistory={conditions:'Same isolated plane, current captureVenue, 0 means initial capture. Subsequent captures retain previous environment, as production does. No buildings; cannot infer full-scene drift.',history};
    report.postprocess={conditions:'Same isolated plane after last capture; compare direct ACES canvas vs project HDR+GTAO+OutputPass pipeline. Final encoded 8-bit screen values, not radiance.',msaa:pipeline.msaaSamples,regions:post};
    pipeline.dispose();publish();$('status').textContent='捕获与后处理检查完成；重新加载可恢复初始冻结环境';
  }catch(e){$('status').textContent=e.stack;console.error(e);}finally{busy=false;display();}
}
async function boot(){
  for(const key of ['asphalt','fresh']){
    const maps=await Promise.all(['BaseColor.jpg','Normal.jpg','ORM.png'].map(async(name,i)=>{
      const map=await texLoader.loadAsync('/scratch/straight-art-20260916/assets/'+key+'/'+name);map.colorSpace=i===0?THREE.SRGBColorSpace:THREE.NoColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;
      const scale=key==='asphalt'?3:2;map.repeat.setScalar(1/scale);map.anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy());return map;
    }));sources[key]=maps;materials[key]={};
    for(const sampling of ['plain','mixed']){
      const mat=new THREE.MeshStandardMaterial({map:maps[0],normalMap:maps[1],roughnessMap:maps[2],aoMap:maps[2],roughness:1,metalness:0,aoMapIntensity:.6,fog:false});
      // Both candidates use the same source-grade parameters; the only variable is synthesis.
      if(sampling==='mixed')installScanSurfaceSampling(mat,{neutral:.8,gain:key==='fresh'?1.65:1});
      else {mat.onBeforeCompile=s=>{s.fragmentShader=s.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),.8)*${key==='fresh'?'1.65':'1.0'};`);};mat.customProgramCacheKey=()=>`plain-grade-${key}`;}
      instrument(mat);materials[key][sampling]=mat;
    }
  }
  plane.material=materials.asphalt.plain;mode.value=0;
  // The production light updater requires a visual/focus object before it moves
  // the DirectionalLight. A null visual would leave the initial sun position.
  const lightFocus=new THREE.Object3D();
  await rig.setSkyRotation(-1.1,lightFocus);scene.fog=null;renderer.shadowMap.enabled=false;
  report.lightDirection=rig.direction.toArray();
  report.actualLightDirection=rig.sun.position.clone().sub(rig.sun.target.position).normalize().toArray();
  if(new THREE.Vector3().fromArray(report.actualLightDirection).distanceTo(rig.direction)>1e-6)throw new Error('DirectionalLight is not synchronized to the HDR direction');
  report.maxAnisotropy=renderer.capabilities.getMaxAnisotropy();report.floatColorBuffer=!!renderer.extensions.get('EXT_color_buffer_float');
  $('run').disabled=$('dfg').disabled=$('capture').disabled=false;$('status').textContent='就绪：实际素材已加载，平面场景环境已冻结';
  for(const id of ['asset','sampling','light','view','aov'])$(id).onchange=display;
  $('run').onclick=matrix;$('dfg').onclick=dfgTest;$('capture').onclick=captureTest;display();
}
boot().catch(e=>{$('status').textContent=e.stack;console.error(e);});
