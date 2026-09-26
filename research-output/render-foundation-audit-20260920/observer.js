export function installObserver({renderer,scene,camera,renderPipeline,lighting,getVehicle,getState}) {
  const panel=document.createElement('aside');panel.id='foundation-observer';
  panel.style.cssText='position:fixed;z-index:200;right:8px;bottom:8px;max-width:320px;padding:10px;background:#13232beb;color:white;font:12px sans-serif';
  const title=document.createElement('strong');title.textContent='正式路径 · 只读观察';panel.append(title);
  const button=document.createElement('button');button.textContent='记录画面与实际状态';panel.append(button);
  const status=document.createElement('output');status.id='foundation-status';status.textContent='等待记录';panel.append(status);
  const link=document.createElement('a');link.id='foundation-frame';link.textContent='原始画面';link.hidden=true;panel.append(link);
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
  summary.textContent='实际状态 JSON';pre.id='foundation-data';details.append(summary,pre);panel.append(details);document.body.append(panel);
  let requested=false, passes=[];
  const originalSceneRender=renderer.render.bind(renderer);
  renderer.render=(object,view)=>{
    if(requested){
      const target=renderer.getRenderTarget(),m=object.material;
      passes.push({object:object===scene?'game-scene':object.type,material:m?.name||m?.type,
        target:target?{id:target.texture.uuid,width:target.width,height:target.height,type:target.texture.type,samples:target.samples,depth:!!target.depthTexture}:null,
        defines:m?.defines?{...m.defines}:null,uniforms:m?.uniforms?Object.keys(m.uniforms):null});
    }
    return originalSceneRender(object,view);
  };
  const originalPipelineRender=renderPipeline.render.bind(renderPipeline);
  renderPipeline.render=()=>{
    const result=originalPipelineRender();
    if(result&&requested){
      requested=false;
      link.href=renderer.domElement.toDataURL('image/png');link.download='normal-game-frame.png';link.hidden=false;
      pre.textContent=JSON.stringify(snapshot(passes),null,2);status.textContent='记录完成';
    }
    return result;
  };
  button.onclick=()=>{passes=[];requested=true;link.hidden=true;status.textContent='等待下一帧';};
  function texture(t){return t?{name:t.name,width:t.image?.width,height:t.image?.height,colorSpace:t.colorSpace,channel:t.channel,anisotropy:t.anisotropy,source:t.image?.currentSrc??t.image?.src??null}:null;}
  function snapshot(passes){
    const car=getVehicle()?.visual, materials=new Map(),meshes=[],lights=[];
    scene.traverseVisible(o=>{
      if(o.isLight)lights.push({name:o.name,type:o.type,intensity:o.intensity,color:o.color?.toArray(),castShadow:o.castShadow});
      if(!o.isMesh)return;
      let parent=o,isCar=false;while(parent){if(parent===car)isCar=true;parent=parent.parent;}
      const mats=Array.isArray(o.material)?o.material:[o.material];
      for(const m of mats)if(!materials.has(m.uuid))materials.set(m.uuid,{id:m.uuid,name:m.name,type:m.type,role:m.userData.streetRushRole,
        color:m.color?.toArray(),metalness:m.metalness,roughness:m.roughness,clearcoat:m.clearcoat,clearcoatRoughness:m.clearcoatRoughness,
        transmission:m.transmission,opacity:m.opacity,transparent:m.transparent,depthWrite:m.depthWrite,alphaTest:m.alphaTest,side:m.side,shadowSide:m.shadowSide,
        emissive:m.emissive?.toArray(),emissiveIntensity:m.emissiveIntensity,
        maps:Object.fromEntries(['map','normalMap','roughnessMap','metalnessMap','aoMap','lightMap','envMap'].map(k=>[k,texture(m[k])]))});
      meshes.push({name:o.name,car:isCar,geometry:o.geometry.type,instances:o.isInstancedMesh?o.count:1,
        castShadow:o.castShadow,receiveShadow:o.receiveShadow,renderOrder:o.renderOrder,materials:mats.map(m=>m.uuid)});
    });
    const gl=renderer.getContext(),extension=gl.getExtension('WEBGL_debug_renderer_info'),ao=renderPipeline.ao;
    return {recordedAt:new Date().toISOString(),mode:getState(),car:getVehicle()?.config.id,
      carPosition:car?.position.toArray(),camera:{position:camera.position.toArray(),fov:camera.fov,near:camera.near,far:camera.far},
      drawingBuffer:[renderer.domElement.width,renderer.domElement.height],css:[innerWidth,innerHeight],pixelRatio:renderer.getPixelRatio(),
      gpu:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):null,
      renderer:{toneMapping:renderer.toneMapping,exposure:renderer.toneMappingExposure,outputColorSpace:renderer.outputColorSpace,msaa:renderPipeline.msaaSamples,qualityTier:renderPipeline.qualityTier},
      environment:{texture:texture(scene.environment),id:scene.environment?.uuid,intensity:scene.environmentIntensity,preset:lighting.preset},
      shadow:{enabled:renderer.shadowMap.enabled,type:renderer.shadowMap.type,mapSize:lighting.sun.shadow.mapSize.toArray(),span:lighting.sun.shadow.camera.right*2,bias:lighting.sun.shadow.bias,normalBias:lighting.sun.shadow.normalBias,direction:lighting.direction.toArray()},
      ao:{size:[ao.width,ao.height],externalDepth:!!ao.depthTexture,normalTexture:!!ao.normalTexture,defines:{...ao.gtaoMaterial.defines},blendIntensity:ao.blendIntensity,
        blend:{blending:ao.blendMaterial.blending,src:ao.blendMaterial.blendSrc,dst:ao.blendMaterial.blendDst}},
      passes,lights,materials:[...materials.values()],meshes,
      note:'Observer wraps render calls and exports one frame. Rendering/asset parameters are unchanged. Capture overhead is not a performance benchmark.'};
  }
}
