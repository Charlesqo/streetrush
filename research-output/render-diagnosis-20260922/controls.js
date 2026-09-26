// Isolated diagnosis only. Nothing here is imported by the normal build.
// Every comparison is captured after a draw, with its state from that draw.
export function installDiagnosis(a) {
  const { THREE, renderer, scene, camera, lighting, renderPipeline: pipeline, track } = a;
  const panel = document.createElement('aside');
  panel.style.cssText = 'position:fixed;z-index:2000;top:8px;left:8px;max-width:690px;padding:8px;background:#14212fec;color:white;font:12px system-ui';
  const title = document.createElement('strong'); title.textContent = '渲染诊断 · 独立入口 · 实验不是修复'; panel.append(title);
  const row = document.createElement('div'), status = document.createElement('output');
  status.style.display = 'block'; status.textContent = '先正常选车、开始比赛；静止后取证。'; panel.append(row, status); document.body.append(panel);
  let busy = false, ready = false, view = 'normal', sequence = 0;
  const car = () => a.getVehicle().visual;
  const meshes = () => { const r = []; car().traverse(o => { if (o.isMesh) r.push(o); }); return r; };
  const materials = () => [...new Set(meshes().flatMap(o => [].concat(o.material)))];
  let baseline;
  function freeze() {
    if (ready) return;
    a.freeze(); ready = true;
    baseline = { cameraPosition: camera.position.clone(), cameraQuaternion: camera.quaternion.clone(), fov: camera.fov,
      ratio: renderer.getPixelRatio(), width: renderer.domElement.width, height: renderer.domElement.height,
      ao: pipeline.ao.blendIntensity, sun: lighting.sun.intensity, fill: lighting.fill.intensity, environment: scene.environmentIntensity,
      shadowEnabled: renderer.shadowMap.enabled, shadowIntensity: lighting.sun.shadow.intensity, bias: lighting.sun.shadow.bias, normalBias: lighting.sun.shadow.normalBias,
      shadowCamera: { left: lighting.sun.shadow.camera.left, right: lighting.sun.shadow.camera.right, top: lighting.sun.shadow.camera.top, bottom: lighting.sun.shadow.camera.bottom },
      cast: meshes().map(o => [o, o.castShadow]), receive: meshes().map(o => [o, o.receiveShadow]),
      shadowSides: materials().map(m => [m, m.shadowSide]), blob: car().getObjectByName('contact-shadow') };
  }
  function restore() {
    renderer.shadowMap.enabled = baseline.shadowEnabled;
    lighting.sun.shadow.intensity = baseline.shadowIntensity;
    pipeline.ao.blendIntensity = baseline.ao;
    lighting.sun.intensity = baseline.sun; lighting.fill.intensity = baseline.fill; scene.environmentIntensity = baseline.environment;
    lighting.sun.shadow.bias = baseline.bias; lighting.sun.shadow.normalBias = baseline.normalBias;
    Object.assign(lighting.sun.shadow.camera, baseline.shadowCamera); lighting.sun.shadow.camera.updateProjectionMatrix();
    baseline.cast.forEach(([o,v]) => o.castShadow = v); baseline.receive.forEach(([o,v]) => o.receiveShadow = v);
    baseline.shadowSides.forEach(([m,v]) => m.shadowSide = v);
    if (baseline.blob) baseline.blob.visible = true;
  }
  function diagnosticSize() {
    renderer.setPixelRatio(1); renderer.setSize(1280, 720, false);
    camera.aspect = 1280 / 720; camera.fov = 58; camera.near = .1; camera.updateProjectionMatrix();
  }
  function carView(name, p, t) {
    freeze(); restore(); diagnosticSize(); view = name;
    camera.position.copy(new THREE.Vector3(...p).applyQuaternion(car().quaternion).add(car().position));
    camera.lookAt(new THREE.Vector3(...t).applyQuaternion(car().quaternion).add(car().position)); camera.updateMatrixWorld(true);
    lighting.update(car(), performance.now() + 100);
  }
  function routeView(name, t, offset = 0, height = 1.7, lookAhead = 24, lookOffset = 0) {
    freeze(); restore(); diagnosticSize(); view = name;
    const p = track.pointAt(t, offset), q = track.pointAt(t + lookAhead / track.length, lookOffset);
    camera.position.copy(p.point).add(new THREE.Vector3(0, height, 0)); camera.lookAt(q.point.clone().add(new THREE.Vector3(0, height < 1 ? .2 : 1, 0)));
    camera.updateMatrixWorld(true);
    const focus = new THREE.Object3D(); focus.position.copy(p.point); focus.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), p.tangent);
    lighting.update(focus, performance.now() + 100);
  }
  function snapshot(name) {
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { name, diagnosisVersion: 2, sequence: sequence++, recordedAt: new Date().toISOString(), view, frozen: ready, gameState: a.getState(),
      car: a.getVehicle().config.id, position: car().position.toArray(), quaternion: car().quaternion.toArray(),
      camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect },
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], pixelRatio: renderer.getPixelRatio(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      lights: { sun: lighting.sun.intensity, fill: lighting.fill.intensity, environment: scene.environmentIntensity, environmentId: scene.environment?.uuid, direction: lighting.direction.toArray() },
      shadow: { enabled: renderer.shadowMap.enabled, intensity: lighting.sun.shadow.intensity, type: renderer.shadowMap.type, map: lighting.sun.shadow.mapSize.toArray(), bias: lighting.sun.shadow.bias, normalBias: lighting.sun.shadow.normalBias,
        camera: { left: lighting.sun.shadow.camera.left, right: lighting.sun.shadow.camera.right, top: lighting.sun.shadow.camera.top, bottom: lighting.sun.shadow.camera.bottom }, sunPosition: lighting.sun.position.toArray(), target: lighting.sun.target.position.toArray() },
      ao: { blend: pipeline.ao.blendIntensity, width: pipeline.ao.width, height: pipeline.ao.height, quality: pipeline.qualityTier },
      exposure: renderer.toneMappingExposure, msaa: pipeline.msaaSamples,
      blob: { visible: baseline?.blob?.visible, opacity: baseline?.blob?.material.opacity, position: baseline?.blob?.getWorldPosition(new THREE.Vector3()).toArray() },
      carMeshes: meshes().map(o => ({ name: o.name, castShadow: o.castShadow, receiveShadow: o.receiveShadow, materials: [].concat(o.material).map(m=>m.uuid) })),
      materials: materials().map(m => ({ uuid:m.uuid, name:m.name, type:m.type, color:m.color?.toArray(), roughness:m.roughness, metalness:m.metalness, side:m.side, shadowSide:m.shadowSide })),
      limits: 'Frozen visual diagnosis. Camera and output size are explicit. No performance or driving acceptance. Changes live only in this browser instance.' };
  }
  async function capture(label) {
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); lighting.sun.shadow.needsUpdate = true;
    pipeline.render();
    const name = a.getVehicle().config.id + '-' + view + '-' + label;
    const png = renderer.domElement.toDataURL('image/png'), state = snapshot(name);
    const response = await fetch('/__diagnosis_save', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name,png,state}) });
    if (!response.ok) throw new Error(await response.text());
    status.textContent = '已保存 ' + name;
  }
  async function variants(cases) {
    const sunPosition=lighting.sun.position.clone(), targetPosition=lighting.sun.target.position.clone(), mapSize=lighting.sun.shadow.mapSize.clone();
    const resetShadow=()=>{lighting.sun.position.copy(sunPosition);lighting.sun.target.position.copy(targetPosition);lighting.sun.target.updateMatrixWorld(true);
      if(!lighting.sun.shadow.mapSize.equals(mapSize)){lighting.sun.shadow.map?.dispose();lighting.sun.shadow.map=null;lighting.sun.shadow.mapSize.copy(mapSize);}};
    for (const [label, change] of cases) { restore(); resetShadow(); change(); await capture(label); }
    resetShadow();
    restore(); lighting.sun.shadow.needsUpdate = true; pipeline.render();
  }
  function button(label, fn) {
    const b=document.createElement('button');b.textContent=label;b.style.cssText='margin:3px;padding:5px 8px;color:white;background:#344a5c;border:1px solid #84909c';
    b.onclick=async()=>{if(busy)return;busy=true;status.textContent='处理中';try{await fn();status.textContent+=' · 完成';}catch(e){status.textContent='失败 '+e.stack;console.error(e);}finally{busy=false;}};row.append(b);
  }
  button('冻结并保存正常画面', async()=>{freeze();await capture('baseline');});
  button('车身斜纹对照', async()=>{
    carView('wheel',[-2.25,.1,2.3],[-.8,-.3,1.2]);
    await variants([
      ['baseline',()=>{}],['no-sun-shadow',()=>lighting.sun.shadow.intensity=0],
      ['no-car-cast',()=>baseline.cast.forEach(([o])=>o.castShadow=false)],
      ['no-car-receive',()=>baseline.receive.forEach(([o])=>o.receiveShadow=false)],
      ['backface-shadow',()=>baseline.shadowSides.forEach(([m])=>m.shadowSide=THREE.BackSide)],
      ['frontface-shadow',()=>baseline.shadowSides.forEach(([m])=>m.shadowSide=THREE.FrontSide)],
      ['normal-bias-zero',()=>lighting.sun.shadow.normalBias=0],
      ['span-40-same-bias',()=>{Object.assign(lighting.sun.shadow.camera,{left:-20,right:20,top:20,bottom:-20});lighting.sun.shadow.camera.updateProjectionMatrix();}],
      ['map-4096-same-bias',()=>{lighting.sun.shadow.map?.dispose();lighting.sun.shadow.map=null;lighting.sun.shadow.mapSize.setScalar(4096);}],
      ['quarter-texel-shift',()=>{const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),lighting.direction).normalize().multiplyScalar(112/2048*.25);lighting.sun.position.add(right);lighting.sun.target.position.add(right);lighting.sun.target.updateMatrixWorld(true);}],
    ]);
  });
  button('车底暗部对照', async()=>{
    carView('rear',[2.8,1,-4.4],[0,.05,-.5]);
    await variants([
      ['baseline',()=>{}],['no-blob',()=>baseline.blob.visible=false],['no-ao',()=>pipeline.ao.blendIntensity=0],
      ['no-blob-no-ao',()=>{baseline.blob.visible=false;pipeline.ao.blendIntensity=0;}],
      ['no-sun-shadow',()=>lighting.sun.shadow.intensity=0],
      ['no-three-darkeners',()=>{lighting.sun.shadow.intensity=0;baseline.blob.visible=false;pipeline.ao.blendIntensity=0;}],
    ]);
  });
  button('正常追车暗部对照', async()=>{
    freeze();restore();diagnosticSize();view='chase';camera.position.copy(baseline.cameraPosition);camera.quaternion.copy(baseline.cameraQuaternion);camera.fov=baseline.fov;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);lighting.update(car(),performance.now()+100);
    await variants([['baseline',()=>{}],['no-blob',()=>baseline.blob.visible=false],['no-ao',()=>pipeline.ao.blendIntensity=0],['no-sun-shadow',()=>lighting.sun.shadow.intensity=0]]);
  });
  button('环境多路段',async()=>{
    for(const [name,t] of [['straight',.09],['turn-one',.325],['esses',.60],['south',.715],['west',.875]]){routeView(name,t);await capture('baseline');}
    routeView('wall-near',.09,-8.8,.8,5,-11.45);await capture('baseline');
    routeView('road-near',.09,0,.3,5,0);await capture('baseline');
    routeView('pit',.11,18,1.7,15,27);await capture('baseline');
    view='overview';camera.position.set(-560,365,360);camera.lookAt(-15,0,-120);camera.updateMatrixWorld(true);await capture('baseline');
  });
  button('路墙受光拆分',async()=>{
    routeView('wall-light',.09,-8.8,1.25,9,-11.4);
    await variants([['baseline',()=>{}],['no-ao',()=>pipeline.ao.blendIntensity=0],['sun-only',()=>{lighting.fill.intensity=0;scene.environmentIntensity=0;}],['environment-only',()=>lighting.sun.intensity=0],['no-hemisphere',()=>lighting.fill.intensity=0]]);
  });
  button('恢复正常运行',()=>{if(ready){restore();renderer.setPixelRatio(baseline.ratio);renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();ready=false;a.resume();}});
}
