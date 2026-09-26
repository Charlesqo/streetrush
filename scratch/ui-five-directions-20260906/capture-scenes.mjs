import { chromium } from '/Users/charles/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const out = new URL('./', import.meta.url).pathname;
await fs.mkdir(out+'scenes', {recursive:true});
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const drivingOnly=process.argv.includes('--driving');
const page = await browser.newPage({viewport:drivingOnly?{width:960,height:540}:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror', e => console.log('PAGE',e.message));
await page.route('**/src/main.js*',async route=>{
 const response=await route.fetch();
 let body=await response.text();
 body+=`\nwindow.__uiReview={get vehicle(){return vehicle},get state(){return state},cars:CARS,mount:async(i)=>{carIndex=i;return mountVehicle(i,true)},start:startRace,back:returnGarage,view:null};
 const uiRender=renderPipeline.render.bind(renderPipeline);
 renderPipeline.render=()=>{const v=window.__uiReview.view;if(v&&vehicle){camera.position.copy(new THREE.Vector3(...v.position).applyQuaternion(vehicle.visual.quaternion).add(vehicle.visual.position));camera.lookAt(new THREE.Vector3(...v.target).applyQuaternion(vehicle.visual.quaternion).add(vehicle.visual.position));camera.updateMatrixWorld();}uiRender();};`;
 await route.fulfill({response,body});
});
await page.goto('http://127.0.0.1:5176/?renderreview&reviewscale=1');
await page.waitForFunction(()=>window.__uiReview?.vehicle?.visual?.userData?.source==='gltf',null,{timeout:60000});
await page.addStyleTag({content:'body > :not(canvas):not(script):not(style) { visibility:hidden!important; } canvas {visibility:visible!important;}'});
for (const id of (drivingOnly?['m3e30','gt3rs','lp700','amggt3','m5g90']:['mx5','m3e30','gt3rs','lp700','amggt3','m5g90'])) {
 if(drivingOnly){
  await page.evaluate(async id=>{let r=window.__uiReview;r.back();await r.mount(r.cars.findIndex(c=>c.id===id),true);r.view=null;r.start();},id);
  await page.waitForTimeout(4500);
  if(await page.evaluate(()=>window.__uiReview.state)==='menu')throw Error('Driving scene did not start for '+id);
  await page.keyboard.down('w');await page.waitForTimeout(4500);await page.keyboard.up('w');
  await page.screenshot({path:out+'scenes/drive-'+id+'.jpg',type:'jpeg',quality:63});console.log('captured drive',id);continue;
 }
 await page.evaluate(async id=>{let r=window.__uiReview;await r.mount(r.cars.findIndex(c=>c.id===id),true);r.view={position:[-5.8,2.6,7.2],target:[-1.6,.5,0]};},id);
 await page.waitForTimeout(1800);
 await page.screenshot({path:out+'scenes/'+id+'.jpg',type:'jpeg',quality:76});
 console.log('captured',id);
}
if(!drivingOnly){
await page.evaluate(async()=>{let r=window.__uiReview;await r.mount(0,true);r.view=null;r.start();});
await page.waitForTimeout(5000);
await page.keyboard.down('w');
await page.waitForTimeout(5500);
await page.keyboard.up('w');
await page.screenshot({path:out+'scenes/drive.jpg',type:'jpeg',quality:80});
await fs.writeFile(out+'scenes/provenance.json',JSON.stringify({capturedAt:new Date().toISOString(),source:'Local StreetRush renderer at http://127.0.0.1:5176/',viewport:[1600,900],notes:'Existing game scene, cars, track, materials and lighting. DOM UI hidden. Hero camera changed in this isolated browser session only. Driving scene captured via game controls. No generated imagery. Displayed UI timing values in concepts are shared sample data.'},null,2));
}
await browser.close();
