import { chromium } from '/Users/charles/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const [url='http://127.0.0.1:5176/',label='before',car='mx5',seconds='8'] = process.argv.slice(2);
const dir=new URL('./',import.meta.url).pathname;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.route('**/src/main.js*',async route=>{
 const response=await route.fetch();let body=await response.text();
 body=body.replace(/function updatePerformance\(frameDt\) \{/,'function updatePerformance(frameDt) { return;');
 body+=`\nwindow.__review={scene,renderer,camera,track,assets,CARS,get vehicle(){return vehicle},get state(){return state},mount:mountVehicle,start:startRace,frames:[],cpu:[],gpu:[],draws:[],triangles:[],view:null};
 const review=window.__review;const original=renderer.render.bind(renderer);let previous=0;const gl=renderer.getContext();const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');const pending=[];
 renderer.render=(s,c)=>{const now=performance.now(); if(previous)review.frames.push(now-previous);previous=now;
 if(review.view){ const v=vehicle.visual; c.position.copy(new THREE.Vector3(...review.view.position).applyQuaternion(v.quaternion).add(v.position));c.lookAt(new THREE.Vector3(...review.view.target).applyQuaternion(v.quaternion).add(v.position));c.updateMatrixWorld();}
 let q;if(ext&&pending.length<8){q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);}const t=performance.now();original(s,c);review.cpu.push(performance.now()-t);review.draws.push(renderer.info.render.calls);review.triangles.push(renderer.info.render.triangles);if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);pending.push(q);}while(pending.length&&gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)){const n=pending.shift();if(!gl.getParameter(ext.GPU_DISJOINT_EXT)) review.gpu.push(gl.getQueryParameter(n,gl.QUERY_RESULT)/1e6);gl.deleteQuery(n);}};`;
 await route.fulfill({response,body});
});
await page.goto(url);await page.waitForFunction(()=>window.__review?.vehicle?.visual?.userData?.source==='gltf',{},{timeout:45000});
await page.evaluate(async id=>{const r=window.__review;await r.mount(r.CARS.findIndex(c=>c.id===id),true)},car);
await page.waitForTimeout(2500);await page.locator('#start-button').click();await page.waitForTimeout(5000);
await page.screenshot({path:`${dir}${label}-${car}-chase.png`});
await page.evaluate(()=>{const r=window.__review;for(const k of ['frames','cpu','gpu','draws','triangles'])r[k]=[];});
await page.waitForTimeout(Number(seconds)*1000);
const stats=await page.evaluate(()=>{const r=window.__review;const gl=r.renderer.getContext();const d=gl.getExtension('WEBGL_debug_renderer_info');const summary=a=>{const s=[...a].sort((a,b)=>a-b);return {n:s.length,mean:a.reduce((a,b)=>a+b,0)/a.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],p99:s[Math.floor(s.length*.99)]}};return {state:r.state,car:r.vehicle.config.id,source:r.vehicle.visual.userData.source,renderer:d&&gl.getParameter(d.UNMASKED_RENDERER_WEBGL),resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],frames:summary(r.frames),renderCpu:summary(r.cpu),gpu:summary(r.gpu),draws:summary(r.draws),triangles:summary(r.triangles),textures:r.renderer.info.memory.textures,geometries:r.renderer.info.memory.geometries,programs:r.renderer.info.programs.length,pose:{position:r.vehicle.visual.position.toArray(),quaternion:r.vehicle.visual.quaternion.toArray()}}});
await page.evaluate(()=>window.__review.view={position:[-5.5,2.25,6.7],target:[0,.25,0]});await page.waitForTimeout(800);await page.screenshot({path:`${dir}${label}-${car}-hero.png`});
await fs.writeFile(`${dir}${label}-${car}.json`,JSON.stringify({...stats,errors},null,2));console.log(JSON.stringify({...stats,errors}));await browser.close();
