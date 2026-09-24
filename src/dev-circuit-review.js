import * as THREE from 'three';
export function installCircuitReview({scene,camera,renderer,renderPipeline,lighting,track,startRace,getVehicle,getState}){
  const panel=document.createElement('aside');panel.id='circuit-review';panel.style.cssText='position:fixed;left:18px;bottom:18px;z-index:500;padding:12px;background:#112022eb;color:#eee;font:13px system-ui;border-radius:8px;max-width:95vw';
  const heading=document.createElement('div');heading.textContent='龙湾 · 全赛道检查';heading.style.marginBottom='8px';panel.append(heading);
  const controls=document.createElement('div');panel.append(controls);
  const metrics=document.createElement('output');metrics.id='circuit-render-metrics';metrics.style.cssText='display:block;margin-top:8px;color:#bec7bb;font-size:11px';panel.append(metrics);
  const positions=[['主直道',.055],['一号弯',.325],['连续弯',.43],['发卡弯',.505],['S 弯',.602],['南段',.715],['西段',.875],['最后一弯',.95]];
  let view={t:.055},tour=null,idleAt=performance.now()+8000,idleLabelShown=false,paused=false;
  const button=(name,fn)=>{const b=document.createElement('button');b.textContent=name;b.style.cssText='margin:2px;padding:7px 9px;border:1px solid #60716d;border-radius:4px;color:#fff;background:#344640;cursor:pointer';b.onclick=fn;controls.append(b);return b;};
  const reset=()=>{tour=null;paused=false;idleAt=performance.now()+8000;idleLabelShown=false;frames=[];previous=null;metrics.textContent='测量当前视角…';document.body.classList.add('circuit-art-camera');};
  if(!track.straightArt)for(const [name,t] of positions)button(name,()=>{reset();view={t};});
  if(track.straightArt){
    heading.textContent=`龙湾主直道 · ${Math.round(track.straightArt.length)} m 扫描素材检查`;
    panel.style.maxWidth='min(900px,95vw)';
    button('直道起点',()=>{reset();view={t:.006};});
    button('直道中段',()=>{reset();view={t:.145};});
    button('直道末端',()=>{reset();view={t:.275};});
    button('路面近看',()=>{reset();view={t:.145,height:.28,lookAhead:3};});
    button('围界与草带',()=>{reset();view={t:.085,offset:9.3,height:1.35,lookAhead:18,lookOffset:14};});
    button('草带近看',()=>{reset();view={t:.11,offset:13.1,height:.65,lookAhead:8,lookOffset:17};});
    button('护栏根部',()=>{reset();view={t:.09,offset:10.7,height:.28,lookAhead:3,lookOffset:11.45};});
    button('路肩补片',()=>{reset();view={t:.044,offset:-8.9,height:.65,lookAhead:2.1,lookOffset:-9.6};});
    button('主直道全貌',()=>{reset();view={position:[-340,165,-155],target:[30,0,0]};});
    button('原场景 / 新素材',()=>{reset();track.straightArt.setEnabled(!track.straightArt.enabled);heading.textContent=track.straightArt.enabled?'主直道 · 新素材':'主直道 · 原场景';track.straightArt.withOriginalResponse(()=>lighting.captureVenue(new THREE.Vector3(-55,2.5,12),getVehicle()?.visual));lighting.sun.shadow.needsUpdate=true;syncResponse();});
    button('切换沥青',()=>{reset();heading.textContent='主直道 · '+track.straightArt.toggleAsphalt();});
    button('沿主直道查看',()=>{reset();tour=performance.now();view={straightTour:true};});
    const responseRow=document.createElement('div');responseRow.style.cssText='margin-top:8px;padding-top:7px;border-top:1px solid #52635f';controls.append(responseRow);
    const responseLabel=document.createElement('span');responseRow.append(responseLabel);
    const responseButtons=[
      button('路面反射 · 原版',()=>setResponse(false)),
      button('路面反射 · 试验版',()=>setResponse(true)),
    ];
    responseButtons.forEach(b=>responseRow.append(b));
    function syncResponse(){
      const art=track.straightArt;
      responseLabel.textContent=art.enabled?'同机位对比：':'当前为原场景：';
      responseButtons.forEach((b,i)=>{const selected=art.responseEnabled===Boolean(i);b.setAttribute('aria-pressed',String(selected));b.disabled=!art.enabled;b.style.background=selected?'#356d68':'#344640';});
      panel.dataset.roadResponse=art.enabled?(art.responseEnabled?'reference':'original'):'inactive';
      panel.dataset.roadResponseEnvironment=scene.environment?.uuid??'';
    }
    function setResponse(value){
      // Keep a running camera tour moving, so A/B also works during motion.
      paused=false;idleAt=performance.now()+8000;idleLabelShown=false;frames=[];previous=null;
      metrics.textContent='更新路面反射对照…';
      track.straightArt.setResponseEnabled(value);syncResponse();
    }
    // main.js has already captured the venue using the original response.
    track.straightArt.setResponseEnabled(true);syncResponse();
    panel.dataset.straightArt=JSON.stringify({length:track.straightArt.length,grass:track.straightArt.grassCount,guardrails:track.straightArt.guardrailModules,plants:track.straightArt.plants});
    heading.style.cursor='pointer';heading.title='点击收起或展开控制';
    heading.onclick=()=>{controls.hidden=!controls.hidden;metrics.hidden=controls.hidden;};
  }
  button('路肩近看',()=>{reset();view={t:.630,offset:4.8,height:.45,lookAhead:6,lookOffset:7.3};});
  button('维修区',()=>{reset();view={position:[-249,2.4,13.7],target:[-207,3,22]};});
  button('鸟瞰',()=>{reset();view={position:[-560,365,360],target:[-15,0,-120]};});
  button('沿整圈查看',()=>{reset();tour=performance.now();});
  button('暂停绘制',()=>{paused=true;metrics.textContent='已暂停绘制 · 切换视角或点击刷新可恢复';});
  button('刷新画面',()=>{reset();});
  button('实车起跑',()=>{paused=false;tour=null;view=null;camera.near=.1;camera.updateProjectionMatrix();document.body.classList.remove('circuit-art-camera');startRace();});
  button('直道试车 6 秒',()=>{paused=false;tour=null;view=null;camera.near=.1;camera.updateProjectionMatrix();document.body.classList.remove('circuit-art-camera');startRace();setTimeout(()=>window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true})),3300);setTimeout(()=>window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w',bubbles:true})),9300);});
  document.body.append(panel);document.body.classList.add('circuit-art-camera');
  const style=document.createElement('style');style.textContent='.circuit-art-camera #menu,.circuit-art-camera #hud,.circuit-art-camera #loading{display:none!important}';document.head.append(style);
  const allowed=renderPipeline.shouldRender.bind(renderPipeline);
  renderPipeline.shouldRender=(now=performance.now())=>{
    // Static inspection is quiet; tours and real driving use normal render cadence.
    const moving=tour!==null || (!view && ['race','countdown'].includes(getState?.()));
    renderPipeline.setMaxFps(moving ? Infinity : 5);
    if(paused)return false;
    if(view && tour===null && now>=idleAt){
      if(!idleLabelShown){metrics.textContent+=' · 已停绘，切换视角可更新';idleLabelShown=true;}
      return false;
    }
    return allowed(now);
  };
  const focus=new THREE.Object3D();const render=renderPipeline.render.bind(renderPipeline);let previous=null,frames=[];
  renderPipeline.render=(...args)=>{
    const now=performance.now();
    if(!renderPipeline.shouldRender(now))return false;
    if(tour!==null)view=view?.straightTour?{t:((now-tour)/40000)%1*.301,straightTour:true}:{t:((now-tour)/90000)%1};
    if(view){
      const near=view.position?.[1]>100?2:.1;if(camera.near!==near){camera.near=near;camera.updateProjectionMatrix();}
      if(view.t!==undefined){const s=track.pointAt(view.t,view.offset??0),ahead=track.pointAt(view.t+(view.lookAhead??24)/track.length,view.lookOffset??0);camera.position.copy(s.point).add(new THREE.Vector3(0,view.height??1.7,0));camera.lookAt(ahead.point.clone().add(new THREE.Vector3(0,view.height===undefined?1:.05,0)));focus.position.copy(s.point);}
      else{camera.position.fromArray(view.position);camera.lookAt(new THREE.Vector3(...view.target));focus.position.fromArray(view.target);}
      lighting.update(focus,now);
    }
    const started=performance.now();const result=render(...args);if(!result)return false;
    if(track.straightArt){panel.dataset.roadResponseCamera=JSON.stringify([...camera.position.toArray(),...camera.quaternion.toArray()]);panel.dataset.roadResponseRendered=track.straightArt.enabled?(track.straightArt.responseEnabled?'reference':'original'):'inactive';}
    metrics.dataset.renderedFrames=String(renderPipeline.renderedFrames);if(previous!==null)frames.push({frame:now-previous,submit:performance.now()-started});previous=now;
    if(frames.length>=20){const sorted=frames.map(f=>f.frame).sort((a,b)=>a-b);const avg=frames.reduce((n,f)=>n+f.frame,0)/frames.length;metrics.textContent=`${(1000/avg).toFixed(1)} FPS · ${Number.isFinite(renderPipeline.maxFps)?'静止限帧':'动态不限帧'} · ${renderer.domElement.width}×${renderer.domElement.height} · 帧间隔 P95 ${sorted[Math.floor(sorted.length*.95)].toFixed(1)} ms`;metrics.dataset.drawCalls=String(renderer.info.render.calls);metrics.dataset.triangles=String(renderer.info.render.triangles);frames=[];}
    return result;
  };
}
