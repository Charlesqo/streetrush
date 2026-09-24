// Imported only by the explicit DEV ?renderreview mode. Exercises the normal
// game scene and scheduler; records render costs without changing physics.
import * as THREE from 'three';

export async function installRenderReview({ renderer, camera, scene, renderPipeline, lighting, effects, getVehicle, getState, startRace, pausePreview, resumePreview, selectVehicle, cars }) {
  const params = new URLSearchParams(location.search);
  // Optional low-load measurement. It limits only this DEV inspection page;
  // frame spacing is not a throughput benchmark when this option is present.
  const measurementCap = params.has('reviewfps') ? THREE.MathUtils.clamp(Number(params.get('reviewfps')) || 5, 1, 10) : null;
  let lastDiagnosticDraw = -Infinity;
  const canRender = renderPipeline.shouldRender.bind(renderPipeline);
  renderPipeline.shouldRender = (now = performance.now()) => canRender(now)
    && (measurementCap === null || now - lastDiagnosticDraw >= 1000 / measurementCap);
  let scale = THREE.MathUtils.clamp(Number(params.get('reviewscale') || 1), .5, 2);
  renderer.setPixelRatio(scale);
  renderer.info.autoReset = false;
  const panel = document.createElement('aside');
  panel.id = 'render-review';
  panel.style.cssText = 'position:fixed;z-index:100;bottom:8px;left:8px;max-width:96vw;max-height:185px;overflow:auto;background:#101820e8;color:#dce8ed;padding:8px;font:11px monospace;border-radius:6px;';
  const toolbar = document.createElement('div');
  const status = document.createElement('div');
  status.id = 'review-resolution';
  const captureLink = document.createElement('a');
  captureLink.id = 'review-capture'; captureLink.textContent = '下载原始渲染帧'; captureLink.hidden = true;
  captureLink.style.cssText = 'color:#dbef89';
  const videoLink=document.createElement('a');videoLink.id='review-video';videoLink.textContent='下载实机录像';videoLink.hidden=true;videoLink.style.cssText='color:#dbef89;margin-left:12px';
  const output = document.createElement('output');
  output.id = 'render-review-result';
  output.style.cssText = 'display:block;max-height:30px;overflow:auto;white-space:pre-wrap';
  panel.append(toolbar, status, output, captureLink, videoLink);
  document.body.append(panel);
  const button = (label, fn) => {
    const el = document.createElement('button'); el.textContent = label;
    el.style.cssText = 'font:11px monospace;padding:5px 8px;margin:2px;color:white;background:#283b48;border:1px solid #526774;cursor:pointer;';
    el.onclick = fn; toolbar.append(el);
  };
  let view = null;
  button('开始试车', () => startRace());
  button('追车', () => { view = null; });
  button('前侧', () => { view = { position: [-5.5, 2.25, 6.7], target: [0, .25, 0] }; });
  button('后侧', () => { view = { position: [5.5, 1.8, -6.7], target: [0, .2, 0] }; });
  button('车身近景', () => { view = { position: [-3.4, 1.3, 4.3], target: [0, .3, .25] }; });
  button('车尾字样', () => { view = { position: [0, .95, -4.2], target: [0, .25, -1.1] }; });
  button('字标特写', () => { view = { position: [0, .28, -3.0], target: [0, .12, -2.2] }; });
  button('天空视角', () => { view = { position: [-5.5, 1.5, 6.7], target: [0, 2.2, 0] }; });
  button('路面视角', () => { view = { position: [0, 5, -2], target: [0, 0, 0] }; });
  button('护栏近景', () => { view = { position: [-7, 1.8, -5], target: [-11.6, .65, 8] }; });
  button('护栏远景', () => { view = { position: [0, 3, -7], target: [0, .5, 55] }; });
  for (const [i, car] of cars.entries()) button(car.id, () => selectVehicle(i));
  toolbar.append(document.createElement('br'));
  for (const [name, label] of [['original','原天空'],['clear','程序晴天'],['hdri','HDRI 晴天']]) button(label, async () => {
    try { output.textContent = '准备天空与反射…'; await lighting.setPreset(name, getVehicle()?.visual); output.textContent = '天空：' + name; }
    catch (error) { output.textContent = '天空加载失败：' + error.message; }
  });
  for (const value of [.72, 1, 1.35, 2]) button('分辨率 '+value, () => { scale=value; renderer.setPixelRatio(value); });
  button('原光照覆盖', async () => { lighting.setShadowCoverage(56,0,getVehicle()?.visual);await lighting.setSkyRotation(-.827,getVehicle()?.visual);scene.environmentIntensity=.8; });
  button('基础光照修正', async () => { lighting.setShadowCoverage(112,24,getVehicle()?.visual);await lighting.setSkyRotation(.35,getVehicle()?.visual);scene.environmentIntensity=.8; });
  let shadowEveryFrame=false;
  button('持续更新阴影 开/关', () => { shadowEveryFrame=!shadowEveryFrame; });
  button('只看太阳', () => { lighting.fill.intensity=0;scene.environmentIntensity=0;lighting.sun.intensity=3.5; });
  button('只看环境光', () => { lighting.fill.intensity=.48;scene.environmentIntensity=.8;lighting.sun.intensity=0; });
  button('恢复完整光照', () => { lighting.fill.intensity=.48;scene.environmentIntensity=.8;lighting.sun.intensity=3.5; });
  button('太阳投影 开/关', () => { lighting.sun.shadow.intensity=lighting.sun.shadow.intensity?0:1; });
  button('环境遮蔽 开/关', () => { renderPipeline.ao.blendIntensity=renderPipeline.ao.blendIntensity?0:.75; });
  let captureRequested = false;
  button('保存高清帧', () => { captureLink.hidden=true;captureLink.removeAttribute('href');captureRequested = true; });
  let normalUntil = 0;
  button('正常预览 10 秒', () => { resumePreview(); normalUntil = performance.now() + 10000; });
  toolbar.append(document.createElement('br'));
  const demo = (mode) => {
    if(mode&&getState()==='menu')startRace();
    const car=getVehicle();
    effects.setDemo(mode,{position:car.visual.position,quaternion:car.visual.quaternion,groundY:car.telemetry.wheels.find(w=>w.grounded)?.contactPoint.y??.02});
    car.visual.visible=!mode;
    lighting.sun.shadow.needsUpdate=true;
    if(mode)view={position:mode==='near'?[-2.5,1.1,3.6]:[-4,2.5,5.6],target:[0,.5,0]};
  };
  button('仅轮胎烟',()=>demo('smoke')); button('仅胎痕',()=>demo('marks')); button('烟与胎痕',()=>demo('both')); button('近镜头烟',()=>demo('near'));
  button('暂停特效',()=>{effects.demoPaused=!effects.demoPaused;});
  button('复位特效',()=>{if(effects.demo)demo(effects.demo.mode);else effects.clear();});
  button('恢复车辆',()=>demo(null));
  button('受光开启',()=>{effects.smokeMaterial.uniforms.lightEnabled.value=1;});
  button('受光关闭',()=>{effects.smokeMaterial.uniforms.lightEnabled.value=0;});
  let blocker=null;
  button('遮光板 开/关',()=>{
    if(!blocker){blocker=new THREE.Mesh(new THREE.BoxGeometry(3.6,3.4,.15),new THREE.MeshStandardMaterial({color:0x77848e,roughness:.9}));blocker.castShadow=true;scene.add(blocker);}
    else blocker.visible=!blocker.visible;
    const origin=effects.demo?.position??getVehicle().visual.position;
    blocker.position.copy(origin).addScaledVector(lighting.direction,3.2);
    blocker.rotation.y=Math.atan2(lighting.direction.x,lighting.direction.z);
    lighting.sun.shadow.needsUpdate=true;
  });
  button('旧轮胎效果',async()=>{
    if(!effects.legacy){
      const {LegacyTireEffects}=await import('./dev-tire-effects-legacy.js');
      const legacy=new LegacyTireEffects(scene);
      // Diagnostic material comparison: the original dynamic geometry keeps
      // stale bounds. Disable that culling here so the old effect is visible.
      legacy.marks.frustumCulled=false;legacy.smoke.frustumCulled=false;
      effects.setLegacy(legacy);
    }else{effects.legacyActive=true;effects.clear();}
  });
  button('新轮胎效果',()=>{effects.legacyActive=false;effects.clear();});
  for(const second of [1,2,4,6])button('定格 '+second+' 秒',()=>{
    demo(effects.demo?.mode??'smoke');
    for(let i=0;i<second*60;i++)effects.update(1/60,{},getVehicle().visual.quaternion);
    effects.demoPaused=true;
  });
  button('行驶特效 10 秒',()=>{
    demo(null);view=null;effects.forcePreviewUntil=performance.now()+9000;normalUntil=performance.now()+10000;
    resumePreview();
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true}));
    setTimeout(()=>window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w',bubbles:true})),8000);
  });
  let recording=false;
  button('录制实机 8 秒',()=>{
    if(recording||session)return;
    if(!window.MediaRecorder){output.textContent='当前浏览器不支持实机录像';return;}
    const stream=renderer.domElement.captureStream(30),chunks=[];
    const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
    const recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:5000000}:undefined);
    recording=true;videoLink.hidden=true;normalUntil=performance.now()+8500;
    resumePreview();
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());const reader=new FileReader();reader.onload=()=>{videoLink.href=reader.result;videoLink.download='streetrush-tire-effects.webm';videoLink.hidden=false;recording=false;};reader.readAsDataURL(new Blob(chunks,{type:recorder.mimeType}));};
    recorder.start();setTimeout(()=>recorder.stop(),8000);
  });
  const gl = renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpuInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const pending = [];
  let session = null;
  let previous = 0;
  const stageMeasurement = params.has('reviewstages');
  let timingDepth = 0;
  const timedStage = (name, fn) => {
    if (!stageMeasurement || !session || performance.now()-session.start < 3000 || timingDepth) return fn();
    const owner=session, start=performance.now();let query;
    if (timer && pending.length < 32) {query=gl.createQuery();gl.beginQuery(timer.TIME_ELAPSED_EXT,query);}
    timingDepth++;
    try {return fn();} finally {
      timingDepth--;(owner.stageCpu[name]??=[]).push(performance.now()-start);
      if(query){gl.endQuery(timer.TIME_ELAPSED_EXT);pending.push({query,session:owner,stage:name});}
    }
  };
  const originalSceneRender=renderer.render.bind(renderer);
  const originalAoRender=renderPipeline.ao.render.bind(renderPipeline.ao);
  if(stageMeasurement){
    renderer.render=(...args)=>timedStage(args[0]===scene?'sceneAndShadows':'compositeOrOutput',()=>originalSceneRender(...args));
    renderPipeline.ao.render=(...args)=>timedStage('ambientOcclusion',()=>originalAoRender(...args));
  }
  let restoreStep=null;
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const quantile = (q) => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(3)) : null;
    return { samples: sorted.length, mean: sorted.length ? Number((values.reduce((a,b) => a+b, 0) / sorted.length).toFixed(3)) : null, p50: quantile(.5), p95: quantile(.95), p99: quantile(.99) };
  };
  const measure = (driving = false) => {
    if(recording)return;
    resumePreview();
    restoreStep?.();
    session = { start: performance.now(), driving, released: false, frames: [], cpu: [], gpu: [], calls: [], triangles: [], stageCpu:{},stageGpu:{},vehicleStep:[] }; previous = 0;
    const measuredVehicle=getVehicle(), originalStep=measuredVehicle.fixedUpdate, owner=session;
    measuredVehicle.fixedUpdate=function(...args){const start=performance.now();try{return originalStep.apply(this,args);}finally{if(performance.now()-owner.start>=3000)owner.vehicleStep.push(performance.now()-start);}};
    restoreStep=()=>{measuredVehicle.fixedUpdate=originalStep;restoreStep=null;};
    panel.dataset.status = 'measuring';
    if (driving) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    output.textContent = (measurementCap ? measurementCap + ' FPS 低负载' : '正常刷新率') + '预热 3 秒，再采样 12 秒；随后自动回到 5 FPS。像素比例 ' + scale;
  };
  button('测量 12 秒', () => measure(false));
  button('行驶采样', () => measure(true));
  button('隐藏面板', () => { panel.style.display = 'none'; });
  addEventListener('keydown', (event) => { if (event.code === 'Backquote') panel.style.display = panel.style.display === 'none' ? '' : 'none'; });
  const render = renderPipeline.render.bind(renderPipeline);
  renderPipeline.render = () => {
    const now = performance.now();
    if (!renderPipeline.shouldRender(now)) return false;
    lastDiagnosticDraw = now;
    if(!session&&now>=normalUntil&&getState()!=='paused')pausePreview();
    const countdown=document.getElementById('countdown');
    if(countdown)countdown.style.visibility=!session&&now>=normalUntil?'hidden':'';
    if (view) {
      const car = getVehicle()?.visual;
      if (car) {
        camera.fov = 58;
        camera.updateProjectionMatrix();
        camera.position.copy(new THREE.Vector3(...view.position).applyQuaternion(car.quaternion).add(car.position));
        camera.lookAt(new THREE.Vector3(...view.target).applyQuaternion(car.quaternion).add(car.position));
        camera.updateMatrixWorld();
      }
    }
    while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const item = pending.shift();
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
        const values=item.stage?(item.session.stageGpu[item.stage]??=[]):item.session.gpu;
        values.push(gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6);
      }
      gl.deleteQuery(item.query);
    }
    let query;
    if (!stageMeasurement && session && now - session.start >= 3000 && timer && pending.length < 8) {
      query = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    }
    renderer.info.reset();
    // Negative control: on some tiled backends query boundaries are coarser
    // than a pass. A costly empty interval invalidates stage attribution.
    if(stageMeasurement)timedStage('emptyQueryControl',()=>{});
    if(shadowEveryFrame)lighting.sun.shadow.needsUpdate=true;
    const start = performance.now();
    render();
    status.textContent = `CSS ${innerWidth}×${innerHeight} / 绘制 ${gl.drawingBufferWidth}×${gl.drawingBufferHeight} / 比例 ${scale}（绕过像素预算） / ${lighting.preset} / ${measurementCap ? measurementCap + ' FPS 上限 / ' : ''}${session || now < normalUntil ? '采样运行' : '5 FPS · 车辆模拟暂停'} / 烟 ${effects.info.particles} / 覆盖 ${effects.info.screenCoverage} 屏 / 胎痕 ${effects.info.marks} / ${effects.legacyActive?'旧效果':'新效果'} / 受光 ${effects.smokeMaterial.uniforms.lightEnabled.value}`;
    if (captureRequested) {
      captureLink.href = renderer.domElement.toDataURL('image/png');
      captureLink.download = `streetrush-${lighting.preset}-${gl.drawingBufferWidth}x${gl.drawingBufferHeight}.png`;
      captureLink.hidden = false; captureRequested = false;
    }
    if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push({ query, session }); }
    if (!session) return;
    if (session.driving && !session.released && now - session.start > 11000) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
      session.released = true;
    }
    if (now - session.start < 3000) return;
    session.cpu.push(performance.now() - start);
    if (previous) session.frames.push(now - previous);
    previous = now;
    session.calls.push(renderer.info.render.calls);
    session.triangles.push(renderer.info.render.triangles);
    if (now - session.start < 15000) return;
    const car = getVehicle();
    const materials = new Map();
    car.visual.traverse(o => { for (const m of o.isMesh ? (Array.isArray(o.material) ? o.material : [o.material]) : []) materials.set(m.uuid, { name:m.name, type:m.type, roughness:m.roughness, metalness:m.metalness, clearcoat:m.clearcoat, transmission:m.transmission }); });
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const submissions = [];
    scene.traverseVisible(o => {
      if (!o.isMesh || (o.frustumCulled && !frustum.intersectsObject(o))) return;
      const instances = o.isInstancedMesh ? o.count : 1;
      const triangles = ((o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3) * instances;
      let ancestor=o, isCar=false;
      while (ancestor) { if (ancestor === car.visual) isCar=true; ancestor=ancestor.parent; }
      submissions.push({name:o.name || o.geometry.type, triangles, instances, car:isCar, castShadow:o.castShadow});
    });
    submissions.sort((a,b)=>b.triangles-a.triangles);
    const result = {
      frameRateCap: measurementCap, throughputBenchmark: measurementCap === null, gpuTimerAvailable: Boolean(timer), previewFrameRateCap: 5, driving: session.driving, speedKmh: car.telemetry.speedKmh, car: car.config.id, source: car.visual.userData.source, state: getState(), view: view || 'chase',
      msaaSamples:renderPipeline.msaaSamples, aoQualityTier:renderPipeline.qualityTier, estimatedMainPassTriangles:submissions.reduce((n,o)=>n+o.triangles,0), estimatedCarTriangles:submissions.filter(o=>o.car).reduce((n,o)=>n+o.triangles,0), largestSubmissions:submissions.slice(0,12),
      resolution: [gl.drawingBufferWidth, gl.drawingBufferHeight], renderer: gpuInfo ? gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      sky:lighting.preset,shadow:{everyFrame:shadowEveryFrame,span:lighting.sun.shadow.camera.right*2,direction:lighting.direction.toArray()},effects:{...effects.info,mode:effects.demo?.mode??'gameplay',paused:effects.demoPaused,legacy:effects.legacyActive,lighting:effects.smokeMaterial.uniforms.lightEnabled.value},
      frameMs: summary(session.frames), renderCpuMs: summary(session.cpu), gpuMs: summary(session.gpu),
      stageCpuMs:Object.fromEntries(Object.entries(session.stageCpu).map(([k,v])=>[k,summary(v)])),stageGpuMs:Object.fromEntries(Object.entries(session.stageGpu).map(([k,v])=>[k,summary(v)])),vehicleFixedUpdateWallMs:summary(session.vehicleStep),vehicleTimingScope:'Vehicle.fixedUpdate only; excludes world.step, afterPhysics, HUD and audio; no physics model changes',
      drawCalls: summary(session.calls), triangles: summary(session.triangles), textures: renderer.info.memory.textures, geometries:renderer.info.memory.geometries,
      materials: [...materials.values()],
    };
    output.textContent = JSON.stringify(result);
    panel.dataset.status = 'complete';
    restoreStep?.();
    session = null;
  };
  output.textContent = 'DEV 实机场景 · 5 FPS 预览 / 正常刷新率采样 · 固定像素比例 ' + scale;
  if(params.get('reviewcar')){
    const i=cars.findIndex(c=>c.id===params.get('reviewcar'));if(i>=0)await selectVehicle(i);
  }
  if(params.has('reviewcar')||params.has('reviewdemo'))startRace();
  if(params.get('reviewview')==='rear')view={position:[0,.95,-4.2],target:[0,.25,-1.1]};
  if(params.get('reviewview')==='badge')view={position:[0,.28,-3],target:[0,.12,-2.2]};
  if(params.get('reviewview')==='hero')view={position:[-3.4,1.3,4.3],target:[0,.3,.25]};
  if(params.get('reviewview')==='barrier')view={position:[-7,1.8,-5],target:[-11.6,.65,8]};
  if(params.get('reviewdemo'))demo(params.get('reviewdemo'));
  pausePreview();
  return { get measuring() { return session !== null || performance.now() < normalUntil; }, get scale() { return scale; } };
}
