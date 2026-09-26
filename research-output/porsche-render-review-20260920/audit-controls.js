import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export async function installPorscheAudit({ renderer, camera, scene, renderPipeline, lighting, getVehicle, setView }) {
  const car = getVehicle().visual;
  if (car.userData.configId !== 'gt3rs') throw new Error('911 audit requires gt3rs');
  const slots = [], originals = new Map();
  car.traverse(o => {
    if (!o.isMesh) return;
    slots.push({ object: o, material: o.material });
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) originals.set(m.uuid, m);
  });
  const baselineEnvironment = scene.environment;
  let generatedEnvironment = null, variants = [];
  const settings = { view: 'hero', environment: 'baseline', blackTrim: false,
    paintNonmetal: false, sharperCoat: false, carbonCoat: false, clay: false, nearShadow: false, noNormalBias: false, depthBiasTest: false };
  const panel = document.createElement('aside');
  panel.id = 'porsche-audit';
  panel.style.cssText = 'position:fixed;right:8px;top:84px;width:300px;max-height:240px;overflow:auto;z-index:110;background:#15212bef;color:#fff;padding:10px;font:12px sans-serif';
  const title = document.createElement('strong'); title.textContent = '911 专项诊断 · 临时实验，未修改生产'; panel.append(title);
  const controls = document.createElement('div'); panel.append(controls);
  const status = document.createElement('output'); status.id = 'porsche-audit-status'; panel.append(status);
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '材质与状态 JSON'; details.append(summary);
  const data = document.createElement('pre'); data.id = 'porsche-audit-data'; details.append(data); panel.append(details);
  document.body.append(panel);
  const button = (label, fn) => {
    const b = document.createElement('button'); b.textContent = label;
    b.style.cssText = 'margin:3px;padding:5px;background:#304557;color:white;border:1px solid #69808e';
    b.onclick = async () => { try { status.textContent = '处理中'; await fn(); publish(); } catch(e) { status.textContent = '失败：'+e.message; console.error(e); } };
    controls.append(b);
  };
  const inspect = m => ({name:m.name,type:m.type,role:m.userData.streetRushRole,
    colorLinear:m.color?.toArray(),roughness:m.roughness,metalness:m.metalness,
    opacity:m.opacity,transparent:m.transparent,side:m.side,depthWrite:m.depthWrite,
    clearcoat:m.clearcoat,clearcoatRoughness:m.clearcoatRoughness,specularIntensity:m.specularIntensity,
    normalScale:m.normalScale?.toArray(),
    maps:Object.fromEntries(['map','roughnessMap','metalnessMap','normalMap','aoMap','clearcoatNormalMap'].map(k=>[k,m[k]?{
      width:m[k].image?.width,height:m[k].image?.height,colorSpace:m[k].colorSpace,anisotropy:m[k].anisotropy,channel:m[k].channel}:null]))});
  function publish() {
    const mats = new Map();
    car.traverse(o=>{if(o.isMesh) for(const m of Array.isArray(o.material)?o.material:[o.material]) mats.set(m.uuid,m);});
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const payload = {settings:{...settings},source:'production scene with isolated diagnostic controls',
      carPosition:car.position.toArray(),cameraPosition:camera.position.toArray(),
      resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],
      gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
      lights:{sun:lighting.sun.intensity,fill:lighting.fill.intensity,environment:scene.environmentIntensity},
      shadow:{span:lighting.sun.shadow.camera.right*2,map:lighting.sun.shadow.mapSize.toArray(),bias:lighting.sun.shadow.bias,normalBias:lighting.sun.shadow.normalBias},
      ao:renderPipeline.ao.blendIntensity,exposure:renderer.toneMappingExposure,
      baselineMaterials:[...originals.values()].map(inspect),currentMaterials:[...mats.values()].map(inspect)};
    data.textContent = JSON.stringify(payload,null,2);
    status.textContent = '就绪 '+JSON.stringify(settings);
  }
  const views = {
    hero:[[-3.4,1.3,4.3],[0,.3,.25]], opposite:[[3.4,1.3,4.3],[0,.3,.25]],
    rear:[[2.6,1.1,-3.9],[0,.2,-.6]], side:[[-4.2,.7,.1],[0,.05,0]],
    glass:[[-1.25,1.15,2.05],[0,.55,.35]],
    headlight:[[-1.3,.45,3.15],[-.65,.12,1.7]],
    wheel:[[-2.25,.1,2.3],[-.8,-.3,1.2]], roof:[[-2.3,2.7,.4],[0,.5,0]],
    badge:[[0,.4,-3.2],[0,.1,-2]], cockpit:[[-1.6,1.25,.2],[0,.3,.1]],
  };
  for (const [key,label] of Object.entries({hero:'左前近景',opposite:'右前近景',rear:'后侧近景',side:'侧面',glass:'前挡玻璃',headlight:'前灯特写',wheel:'前轮特写',roof:'车顶碳纤维',badge:'车尾特写',cockpit:'内饰近景'})) {
    button(label,()=>{settings.view=key;setView({position:views[key][0],target:views[key][1]});});
  }
  function physical(source) {
    if (source.isMeshPhysicalMaterial) return source.clone();
    const result = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(result,source);
    result.defines={STANDARD:'',PHYSICAL:''}; return result;
  }
  function applyMaterials() {
    const old=variants; variants=[]; const cache=new Map();
    function apply(source) {
      if(cache.has(source))return cache.get(source);
      if(!source.isMeshStandardMaterial)return source;
      const carbon=source.name==='TwiXeR_992_carbon_roof.001';
      const m=carbon&&settings.carbonCoat?physical(source):source.clone();variants.push(m);
      if(settings.blackTrim&&source.name==='TwiXeR_992_blackGlass.001')m.color.setRGB(.0137937,.0137937,.0137937);
      if(source.name==='TwiXeR_992_carPaint.003'){
        if(settings.paintNonmetal)m.metalness=0;
        if(settings.sharperCoat)m.clearcoatRoughness=.045;
      }
      if(carbon&&settings.carbonCoat){m.clearcoat=1;m.clearcoatRoughness=.13;}
      if(settings.clay&&!m.transparent){
        m.color.setRGB(.35,.35,.35);m.metalness=1;m.roughness=.08;
        m.map=null;m.normalMap=null;m.roughnessMap=null;m.metalnessMap=null;m.aoMap=null;
        if(m.isMeshPhysicalMaterial)m.clearcoat=0;
      }
      m.needsUpdate=true;cache.set(source,m);return m;
    }
    for(const s of slots)s.object.material=Array.isArray(s.material)?s.material.map(apply):apply(s.material);
    for(const m of old)m.dispose();lighting.sun.shadow.needsUpdate=true;
  }
  for(const [key,label] of Object.entries({blackTrim:'黑边恢复源色',paintNonmetal:'白漆金属度零',sharperCoat:'车漆清漆更锐',carbonCoat:'碳纤维加清漆',clay:'灰色曲面检查'}))button(label,()=>{settings[key]=!settings[key];applyMaterials();});
  button('恢复全部材质',()=>{for(const k of ['blackTrim','paintNonmetal','sharperCoat','carbonCoat','clay'])settings[k]=false;applyMaterials();});
  function setEnvironment(next) {
    scene.environment=next?next.texture:baselineEnvironment;
    if(generatedEnvironment)generatedEnvironment.dispose();generatedEnvironment=next;
  }
  function capture(position,size,sigma) {
    const prev={visible:car.visible,shadow:renderer.shadowMap.enabled,fog:scene.fog,environment:scene.environment};
    const hdr=scene.children.find(o=>o.material?.uniforms?.captureMode);
    const mode=hdr?.material.uniforms.captureMode.value;
    const pmrem=new THREE.PMREMGenerator(renderer);
    try{
      car.visible=false;renderer.shadowMap.enabled=false;scene.fog=null;scene.environment=baselineEnvironment;
      if(hdr)hdr.material.uniforms.captureMode.value=1;
      return pmrem.fromScene(scene,sigma,.1,1500,{position,size});
    }finally{
      car.visible=prev.visible;renderer.shadowMap.enabled=prev.shadow;scene.fog=prev.fog;scene.environment=prev.environment;
      if(hdr)hdr.material.uniforms.captureMode.value=mode;pmrem.dispose();
    }
  }
  button('原场地反射',()=>{setEnvironment(null);settings.environment='baseline';});
  button('原点同设置重采',()=>{setEnvironment(capture(new THREE.Vector3(-55,2.5,12),256,.025));settings.environment='original-position-256-sigma025-recapture';});
  button('原点去预模糊',()=>{setEnvironment(capture(new THREE.Vector3(-55,2.5,12),256,0));settings.environment='original-position-256-no-preblur';});
  button('车旁同精度反射',()=>{const p=car.position.clone();p.y=2.5;setEnvironment(capture(p,256,.025));settings.environment='local-position-256-sigma025';});
  button('车旁高清反射',()=>{const p=car.position.clone();p.y=2.5;setEnvironment(capture(p,512,0));settings.environment='local-position-512-no-preblur';});
  button('摄影棚反射诊断',async()=>{
    const tex=await new HDRLoader().loadAsync('/scratch/car-art-20260907/references/studio_small_09_2k.hdr');
    const gen=new THREE.PMREMGenerator(renderer);try{setEnvironment(gen.fromEquirectangular(tex));}finally{tex.dispose();gen.dispose();}
    settings.environment='studio-hdri-diagnostic';
  });
  button('条纹反射诊断',()=>{
    const w=512,h=256,values=new Float32Array(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const v=Math.sin(x/w*Math.PI*24)>.4?3:.03;
      values.set([v,v,v,1],(y*w+x)*4);
    }
    const tex=new THREE.DataTexture(values,w,h,THREE.RGBAFormat,THREE.FloatType);tex.mapping=THREE.EquirectangularReflectionMapping;tex.needsUpdate=true;
    const gen=new THREE.PMREMGenerator(renderer);try{setEnvironment(gen.fromEquirectangular(tex));}finally{tex.dispose();gen.dispose();}
    settings.environment='stripe-diagnostic';
  });
  button('近车阴影诊断',()=>{
    settings.nearShadow=!settings.nearShadow;
    lighting.setShadowCoverage(settings.nearShadow?20:112,settings.nearShadow?0:24,car);
  });
  button('阴影法线偏移零',()=>{settings.noNormalBias=!settings.noNormalBias;lighting.sun.shadow.normalBias=settings.noNormalBias?0:.03;lighting.sun.shadow.needsUpdate=true;});
  button('阴影深度偏移实验',()=>{settings.depthBiasTest=!settings.depthBiasTest;lighting.sun.shadow.bias=settings.depthBiasTest?-.0006:-.00024;lighting.sun.shadow.needsUpdate=true;});
  button('刷新审计数据',publish);
  publish();
}
