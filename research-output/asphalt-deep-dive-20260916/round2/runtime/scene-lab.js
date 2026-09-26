import * as THREE from 'three';
import { TrackSystem } from '/src/track.js';
import { TRACK_CONFIG } from '/src/config.js';
import { AssetManager } from '/src/assets.js';
import { installStraightArt } from '/src/dev-straight-art.js';
import { createOutdoorLighting } from '/src/rendering.js';
import { createRenderPipeline } from '/src/render-pipeline.js';

const W=1015,H=866,$=id=>document.getElementById(id);
const renderer=new THREE.WebGLRenderer({canvas:$('canvas'),antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);renderer.setSize(W,H,false);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(58,W/H,.1,1300);
const rig=createOutdoorLighting(renderer,scene),focus=new THREE.Object3D();
// This is an independent visual fixture, not a replacement physics implementation.
class VisualTrack extends TrackSystem { buildPhysics() {} }
const track=new VisualTrack(TRACK_CONFIG,scene,renderer,null,null);
const assets=new AssetManager(scene,track);
const floatTarget=new THREE.WebGLRenderTarget(W,H,{type:THREE.FloatType});
const pixels=new Float32Array(W*H*4),mode={value:0},measure={value:false};
const labels=['total','directDiffuse','directSpecular','indirectDiffuse','indirectSpecular','viewNormalEncoded','roughness','baseColor','NdotV'];
const views={early:.055,middle:.145,end:.275},ranges=[[3,8],[8,20],[20,50]];
const materials={};let road,pipeline,busy=false,currentView='middle',captureCount=0;
const report={description:'Full static visual fixture assembled using original track, scenery, straight-art, lighting and postprocessing modules. No vehicle or physics. AOVs are linear, road fog disabled only during measurement; frozen initial venue probe. Bare-road ID mask excludes overlays and occluding scenery.',three:THREE.REVISION,size:[W,H],rows:[]};
const status=s=>$('status').textContent=s;
const yieldUI=()=>new Promise(resolve=>requestAnimationFrame(resolve));
function capture(){rig.captureVenue(new THREE.Vector3(-55,2.5,12),null);captureCount++;}
const maskHashes=regions=>regions.map(m=>{let h=2166136261;for(const i of m)h=Math.imul(h^i,16777619)>>>0;return h;});
function publish(){const txt=JSON.stringify(report,null,2);$('results').value=txt;$('results').textContent=txt;}
function instrument(mat){
  const before=mat.onBeforeCompile,key=mat.customProgramCacheKey();
  mat.onBeforeCompile=(s,r)=>{before.call(mat,s,r);s.uniforms.labMode=mode;s.uniforms.labMeasure=measure;
    s.fragmentShader='uniform int labMode;uniform bool labMeasure;\n'+s.fragmentShader;
    s.fragmentShader=s.fragmentShader.replace('#include <opaque_fragment>',`
      if(labMode==1) outgoingLight=reflectedLight.directDiffuse;
      if(labMode==2) outgoingLight=reflectedLight.directSpecular;
      if(labMode==3) outgoingLight=reflectedLight.indirectDiffuse;
      if(labMode==4) outgoingLight=reflectedLight.indirectSpecular;
      if(labMode==5) outgoingLight=normal*.5+.5;
      if(labMode==6) outgoingLight=vec3(material.roughness);
      if(labMode==7) outgoingLight=diffuseColor.rgb;
      if(labMode==8) outgoingLight=vec3(dot(normal,geometryViewDir));
      #include <opaque_fragment>`);
    s.fragmentShader=s.fragmentShader.replace('#include <fog_fragment>','if(!labMeasure){\n#include <fog_fragment>\n}');
  };mat.customProgramCacheKey=()=>key+'-round2-aov-v1';mat.needsUpdate=true;
}
function pose(view){currentView=view;const t=views[view],s=track.pointAt(t),ahead=track.pointAt(t+24/track.length);
  camera.position.copy(s.point).add(new THREE.Vector3(0,1.7,0));camera.lookAt(ahead.point.clone().add(new THREE.Vector3(0,1,0)));camera.updateMatrixWorld(true);
  focus.position.copy(s.point);rig.update(focus,performance.now());return s;
}
function select(asset,sampling){road.material[1]=materials[asset][sampling];}
function display(){if(busy||!pipeline)return;pose($('view').value);select($('asset').value,$('sampling').value);mode.value=Number($('aov').value);measure.value=false;
  renderer.toneMapping=mode.value>=5?THREE.NoToneMapping:THREE.ACESFilmicToneMapping;
  if(mode.value===0)pipeline.render();else{renderer.setRenderTarget(null);renderer.render(scene,camera);}
}
async function read(channel){mode.value=channel;measure.value=true;renderer.toneMapping=THREE.NoToneMapping;renderer.setRenderTarget(floatTarget);renderer.render(scene,camera);await renderer.readRenderTargetPixelsAsync(floatTarget,0,0,W,H,pixels);return pixels;}
function summarize(data,mask){let sum=0,sq=0,hp=0;const rgb=[0,0,0];for(const i of mask){const j=i*4,r=data[j],g=data[j+1],b=data[j+2],y=.2126*r+.7152*g+.0722*b;if(!Number.isFinite(y))throw Error('Nonfinite pixel');sum+=y;sq+=y*y;rgb[0]+=r;rgb[1]+=g;rgb[2]+=b;let n=0;for(const q of [i-1,i+1,i-W,i+W])n+=.2126*data[q*4]+.7152*data[q*4+1]+.0722*data[q*4+2];hp+=(y-n*.25)**2;}
  return{pixels:mask.length,mean:sum/mask.length,std:Math.sqrt(Math.max(0,sq/mask.length-(sum/mask.length)**2)),highpassRms:Math.sqrt(hp/mask.length),meanRGB:rgb.map(v=>v/mask.length)};
}
async function masks(){
  // Render object ID with original geometry/depth. Black foreground excludes
  // markings, rubber overlays, patch meshes and scenery from bare-road statistics.
  const black=new THREE.MeshBasicMaterial({color:0,side:THREE.DoubleSide,fog:false}),white=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide,fog:false});
  const saved=[];scene.traverse(o=>{if(o.isMesh){saved.push([o,o.material]);o.material=o===road?[black,white]:black;}});
  const shadow=renderer.shadowMap.enabled;renderer.shadowMap.enabled=false;
  try{await read(0);}finally{for(const[o,m]of saved)o.material=m;renderer.shadowMap.enabled=shadow;black.dispose();white.dispose();}
  const base=track.pointAt(views[currentView]),out=ranges.map(()=>[]),v=new THREE.Vector3(),p=new THREE.Vector3();
  const isRoad=i=>pixels[i*4]>.99&&pixels[i*4+1]>.99&&pixels[i*4+2]>.99;
  for(let y=2;y<H-2;y++)for(let x=2;x<W-2;x++){const i=y*W+x;if(![i,i-1,i+1,i-W,i+W].every(isRoad))continue;
    v.set((x+.5)/W*2-1,(y+.5)/H*2-1,.5).unproject(camera).sub(camera.position).normalize();if(v.y>=0)continue;
    p.copy(camera.position).addScaledVector(v,(.015-camera.position.y)/v.y).sub(base.point);const along=p.dot(base.tangent),side=p.dot(base.side);if(Math.abs(side)>5.5)continue;
    ranges.forEach(([a,b],k)=>{if(along>=a&&along<b)out[k].push(i);});
  }
  if(out.some(m=>!m.length))throw Error('Empty ROI');
  const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const ctx=canvas.getContext('2d'),im=ctx.createImageData(W,H);
  out.forEach((mask,k)=>{for(const i of mask){const j=((H-1-Math.floor(i/W))*W+i%W)*4;im.data[j+k]=255;im.data[j+3]=255;}});ctx.putImageData(im,0,0);
  report.roiMasks??={};report.roiMasks[currentView]={counts:out.map(m=>m.length),hashes:maskHashes(out),png:canvas.toDataURL(),description:'Conservative road ID: opaque black replacement excludes entire transparent cards/overlays, then restricts road width and distance. R=3..8,G=8..20,B=20..50 metres.'};return out;
}
async function matrix(){busy=true;report.rows=[];try{
  report.matrixEnvironment={captureCount,uuid:scene.environment.uuid};
  for(const view of ['early','middle','end']){pose(view);const regions=await masks();
    for(const asset of view==='middle'?['fine','fresh']:['fine'])for(const sampling of ['mixed','plain']){
      select(asset,sampling);const row={view,t:views[view],camera:camera.position.toArray(),asset,sampling,shadows:true,aov:{}};
      for(let c=0;c<9;c++){const data=await read(c);row.aov[labels[c]]=regions.map(m=>summarize(data,m));await yieldUI();}
      row.closureRelativeError=ranges.map((_,i)=>Math.abs(labels.slice(1,5).reduce((s,k)=>s+row.aov[k][i].mean,0)-row.aov.total[i].mean)/row.aov.total[i].mean);
      report.rows.push(row);status(`静态赛道矩阵 ${report.rows.length}/8 · ${view} / ${asset} / ${sampling}`);publish();
    }
  }
  pose('middle');select('fine','mixed');const regions=await masks();renderer.shadowMap.enabled=false;
  const noShadow={view:'middle',asset:'fine',sampling:'mixed',aov:{}};for(const c of [0,1,2,3,4]){const data=await read(c);noShadow.aov[labels[c]]=regions.map(m=>summarize(data,m));}
  report.noShadow=noShadow;renderer.shadowMap.enabled=true;rig.sun.shadow.needsUpdate=true;
  publish();status('静态赛道矩阵完成：8组＋阴影对照');
}catch(e){status(e.stack);console.error(e);}finally{renderer.shadowMap.enabled=true;busy=false;display();}}
async function probe(){busy=true;try{
  pose('middle');select('fine','mixed');const regions=await masks(),history=[];
  const startingCaptureCount=captureCount,expectedMask=JSON.stringify(maskHashes(regions));
  const lods=[];scene.traverse(o=>{if(o.isLOD)lods.push(o);});
  const levels=()=>lods.map(o=>o.getCurrentLevel());
  // Leave all AOV overrides disabled while baking; otherwise we would capture
  // a diagnostic channel into the lighting and corrupt the experiment.
  for(let iteration=0;iteration<4;iteration++){
    const beforeCapture=levels();if(iteration){mode.value=0;measure.value=false;renderer.toneMapping=THREE.ACESFilmicToneMapping;capture();}
    const afterCapture=levels(),check=await masks();if(JSON.stringify(maskHashes(check))!==expectedMask)throw Error('LOD changed bare-road mask; do not compare fixed ROI');
    const row={iteration,captureCount,beforeCapture,afterCapture,maskHashes:maskHashes(check),aov:{}};for(const c of [0,3,4]){const data=await read(c);row.aov[labels[c]]=regions.map(m=>summarize(data,m));}history.push(row);status(`固定位置探针捕获 ${iteration}/3`);await yieldUI();
  }
  report.probeHistory={startingCaptureCount,conditions:'Repeated capture at original (-55,2.5,12), retains previous environment as production; current fine mixed road. Iteration 0 is preexisting environment; startingCaptureCount=1 indicates boot capture.',history};
  const frozen=[];for(const o of lods)o.autoUpdate=false;
  try{for(let iteration=0;iteration<4;iteration++){
    mode.value=0;measure.value=false;renderer.toneMapping=THREE.ACESFilmicToneMapping;capture();
    const row={iteration,levels:levels(),aov:{}};for(const c of [0,3,4]){const data=await read(c);row.aov[labels[c]]=regions.map(m=>summarize(data,m));}frozen.push(row);status(`冻结模型细节的探针捕获 ${iteration+1}/4`);await yieldUI();
  }}finally{for(const o of lods)o.autoUpdate=true;}
  report.probeFrozenLOD={conditions:'LOD visibility frozen at middle camera before all 4 captures. Iteration 0 also captures, so compare 0..3 for environment history with fixed geometry. Reuses environment from previous production-history test.',history:frozen};
  mode.value=0;measure.value=false;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.setRenderTarget(null);renderer.render(scene,camera);
  const gl=renderer.getContext(),screen=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,screen);const before=screen.slice();pipeline.render();gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,screen);
  report.postprocess={conditions:'Direct ACES vs original HDR MSAA+GTAO+OutputPass. Encoded 8-bit values on same bare-road mask; no cars, excludes overlays.',msaa:pipeline.msaaSamples,regions:regions.map(mask=>{let sum=0,a=0,b=0;for(const i of mask)for(let k=0;k<3;k++){sum+=Math.abs(screen[i*4+k]-before[i*4+k]);a+=screen[i*4+k];b+=before[i*4+k];}return{meanAbsoluteDifference8bit:sum/mask.length/3,beforeMean8bit:b/mask.length/3,afterMean8bit:a/mask.length/3};})};
  publish();status('探针与后处理完成；重新加载恢复初始环境');
}catch(e){status(e.stack);console.error(e);}finally{busy=false;display();}}
async function dfg(){busy=true;const patched=[];let lut;try{
  const environmentAtStart={captureCount,uuid:scene.environment.uuid};
  const payload=await(await fetch('/research-output/asphalt-research-review-20260916/received/c/dfg-reference.json')).json();
  const bytes=Uint8Array.from(atob(payload.base64),x=>x.charCodeAt(0)),values=new Float32Array(bytes.length/4),dv=new DataView(bytes.buffer);for(let i=0;i<values.length;i++)values[i]=dv.getFloat32(i*4,true);
  lut=new THREE.DataTexture(values,payload.width,payload.height,THREE.RGFormat,THREE.FloatType);lut.minFilter=lut.magFilter=THREE.NearestFilter;lut.needsUpdate=true;
  const rows=[];for(const view of ['middle','end']){pose(view);const regions=await masks();for(const asset of ['fine','fresh']){
    const original=materials[asset].mixed,p=original.clone();patched.push(p);const hook=original.onBeforeCompile;
    p.onBeforeCompile=(s,r)=>{hook.call(p,s,r);s.uniforms.labLut={value:lut};let chunk=THREE.ShaderChunk.lights_physical_pars_fragment;
      const start=chunk.indexOf('vec2 DFGApprox('),open=chunk.indexOf('{',start);let end=open,level=0;for(;end<chunk.length;end++){if(chunk[end]==='{')level++;if(chunk[end]==='}'&&--level===0)break;}
      const originalFn=chunk.slice(start,end+1).replace('DFGApprox(','DFGLegacy(');
      const replacement=originalFn+`\nuniform sampler2D labLut;vec2 DFGApprox(const in vec3 n,const in vec3 v,const in float r){
        float nv=dot(n,v);if(nv<.025||nv>1.||r<.6||r>1.)return DFGLegacy(n,v,r);
        vec2 dims=vec2(${payload.width}.0,${payload.height}.0);vec2 p=(vec2(nv,r)-vec2(.025,.6))/vec2(.975,.4)*(dims-1.);
        vec2 a=floor(p),b=min(a+1.,dims-1.),f=fract(p);
        vec2 q0=mix(texture2D(labLut,(a+.5)/dims).rg,texture2D(labLut,(vec2(b.x,a.y)+.5)/dims).rg,f.x);
        vec2 q1=mix(texture2D(labLut,(vec2(a.x,b.y)+.5)/dims).rg,texture2D(labLut,(b+.5)/dims).rg,f.x);return mix(q0,q1,f.y);}`;
      chunk=chunk.slice(0,start)+replacement+chunk.slice(end+1);s.fragmentShader=s.fragmentShader.replace('#include <lights_physical_pars_fragment>',chunk);
    };p.customProgramCacheKey=()=>original.customProgramCacheKey()+'-bounded-dfg-reference';
    select(asset,'mixed');const rough=(await read(6)).slice(),nv=(await read(8)).slice();
    const coverage=regions.map(mask=>mask.filter(i=>rough[i*4]>=.6&&rough[i*4]<=1&&nv[i*4]>=.025&&nv[i*4]<=1).length/mask.length);
    for(const variant of ['legacy','boundedReference']){road.material[1]=variant==='legacy'?original:p;const row={view,asset,variant,referenceDomainFraction:coverage,aov:{}};
      for(let c=0;c<5;c++){const data=await read(c);row.aov[labels[c]]=regions.map(m=>summarize(data,m));await yieldUI();}
      if(view==='middle'&&asset==='fine'){mode.value=0;measure.value=false;renderer.toneMapping=THREE.ACESFilmicToneMapping;pipeline.render();$(variant==='legacy'?'legacy-shot':'reference-shot').src=renderer.domElement.toDataURL('image/png');$('comparisons').hidden=false;}
      rows.push(row);status(`真实路面DFG ${rows.length}/8`);
    }
  }}report.dfg={environmentAtStart,conditions:'Only road DFG function changes. Same frozen environment, actual maps and all existing multiple scattering. Reference LUT applies only Nv in [.025,1], roughness in [.6,1]; outside uses legacy, domain coverage reported. Boundary behavior is diagnostic, not production-ready.',rows};publish();status('真实路面DFG对照完成');
}catch(e){status(e.stack);console.error(e);}finally{busy=false;display();for(const p of patched)p.dispose();lut?.dispose();}}
async function boot(){
  await assets.loadScenery();status('铺设扫描素材…');await installStraightArt({track,renderer});
  road=track.group.children.find(o=>Array.isArray(o.material)&&o.material[0]?.name==='dry-asphalt');if(!road)throw Error('Road not found');
  const fine=road.material[1];track.straightArt.toggleAsphalt();const fresh=road.material[1];track.straightArt.toggleAsphalt();
  for(const [name,source]of[['fine',fine],['fresh',fresh]]){const plain=source.clone();plain.onBeforeCompile=s=>{s.fragmentShader=s.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),.8)*${name==='fresh'?'1.65':'1.0'};`);};plain.customProgramCacheKey=()=>`round2-plain-${name}`;materials[name]={mixed:source,plain};}
  rig.prepareScenery(track.group);rig.prepareScenery(assets.cityGroup);
  const textureSet=new Set();scene.traverse(o=>{if(o.isMesh)for(const m of [].concat(o.material))for(const t of Object.values(m))if(t?.isTexture&&!t.isRenderTargetTexture)textureSet.add(t);});
  for(const t of textureSet){const im=t.image;if(!im)throw Error('Missing texture image: '+t.name);if(im.complete===false)await new Promise((resolve,reject)=>{im.addEventListener('load',resolve,{once:true});im.addEventListener('error',()=>reject(Error('Image load failed')),{once:true});});if(im.complete===true&&im.naturalWidth===0)throw Error('Failed image: '+im.src);}
  report.texturesReadyBeforeCapture=textureSet.size;
  focus.position.copy(track.getResetPose().position);await rig.setSkyRotation(-1.1,focus);captureCount=1;
  // Initial capture occurs before instrumentation and matches production order.
  for(const v of Object.values(materials))for(const m of Object.values(v))instrument(m);
  pose('middle');pipeline=createRenderPipeline(renderer,scene,camera);await pipeline.warmup();
  report.lightDirection=rig.direction.toArray();report.actualLightDirection=rig.sun.position.clone().sub(rig.sun.target.position).normalize().toArray();report.trackLength=track.length;report.straightLength=track.straightArt.length;report.sourceRepeats={fine:fine.map.repeat.toArray(),fresh:fresh.map.repeat.toArray()};
  const missing=[];scene.traverse(o=>{if(o.isMesh)for(const m of [].concat(o.material))for(const[k,t]of Object.entries(m))if(t?.isTexture&&t.image?.complete===false)missing.push({material:m.name,channel:k});});report.incompleteTextureImages=missing;if(missing.length)throw Error('Texture images incomplete');
  for(const id of['view','asset','sampling','aov'])$(id).onchange=display;$('run').onclick=matrix;$('probe').onclick=probe;$('dfg').onclick=dfg;$('run').disabled=$('probe').disabled=$('dfg').disabled=false;status('静态赛道已就绪，初始探针冻结；按需绘制');display();publish();
}
boot().catch(e=>{status(e.stack);console.error(e);});
