import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.USERPROFILE,
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const variant=process.argv[2]??'fixed', direction=process.argv[3]??'left';
if(!['before','fixed'].includes(variant)||!['straight','left','right'].includes(direction))throw Error('Unknown test');
const dir='research-output/wheel-reaction-fix';
const runtimePath='src/vehicle-v24/runtime.js';
const runtimeHash=createHash('sha256').update(fs.readFileSync(runtimePath)).digest('hex');
const filename=`${variant}-${direction}-browser`;
const oldRuntime=fs.readFileSync(`${dir}/runtime.before.js`,'utf8');
const oldFunction=oldRuntime.slice(oldRuntime.indexOf('function sumBodyTorqueFromHubs('),oldRuntime.indexOf('export class VehicleV24Runtime'));
const observer = function () {
  const probe=window.__wheelFixProbe={samples:[],latest:null,stage:'idle'};
  const fixed=VehicleSystem.prototype.fixedUpdate, after=VehicleSystem.prototype.afterPhysics;
  let context=null;
  VehicleSystem.prototype.fixedUpdate=function(input,locked,dt){
    context={input:structuredClone(input),locked,dt};
    return fixed.apply(this,arguments);
  };
  VehicleSystem.prototype.afterPhysics=function(){
    const result=after.apply(this,arguments);
    if(!context)return result;
    const b=this.body,v=b.linvel(),q=b.rotation(),p=b.translation(),r=this.getVehiclePhysicsReport();
    // Inverse quaternion rotation of velocity, using the conjugate explicitly.
    const ix=q.w*v.x-q.y*v.z+q.z*v.y, iy=q.w*v.y-q.z*v.x+q.x*v.z;
    const iz=q.w*v.z-q.x*v.y+q.y*v.x, iw=q.x*v.x+q.y*v.y+q.z*v.z;
    const lx=ix*q.w+iw*q.x+iy*q.z-iz*q.y, lz=iz*q.w+iw*q.z+ix*q.y-iy*q.x;
    const row={wallMs:performance.now(),...context,stage:probe.stage,car:this.config.id,
      speed:Math.hypot(v.x,v.z)*3.6, beta:Math.atan2(lx,lz)*180/Math.PI,
      yaw:b.angvel().y,position:{...p},rotation:{...q},
      output:r?.output,assists:r?.solver?.assistDiagnostics,status:r?.status};
    probe.latest=row;
    if(probe.stage!=='idle')probe.samples.push(row);
    return result;
  };
};
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
let switched=false;
try{
  await page.addInitScript(()=>{
    window.__wheelFixKeys=[];
    for(const type of ['keydown','keyup'])addEventListener(type,e=>window.__wheelFixKeys.push({type,code:e.code,trusted:e.isTrusted,wallMs:performance.now()}),true);
  });
  await page.route('**/scratch/live-driving-recorder/bootstrap.js*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text())+`\n(${observer.toString()})();\n`});
  });
  if(variant==='before')await page.route('**/src/vehicle-v24/runtime.js*',async route=>{
    const response=await route.fetch(), source=await response.text();
    const begin=source.indexOf('function sumBodyTorqueFromHubs('),end=source.indexOf('export class VehicleV24Runtime');
    if(begin<0||end<begin)throw Error('Baseline comparison seam changed');
    switched=true;
    await route.fulfill({response,body:source.slice(0,begin)+oldFunction+source.slice(end)});
  });
  await page.goto('http://127.0.0.1:5192/',{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#loading.hidden',{state:'attached',timeout:90000});
  await page.waitForFunction(()=>window.__wheelFixProbe&&document.querySelector('#start-button')?.disabled===false);
  for(let i=0;await page.getAttribute('html','data-mounted-car-id')!=='gt3rs';i++){
    if(i>=6)throw Error('Could not select GT3RS');
    const previous=await page.getAttribute('html','data-mounted-car-id');
    await page.click('#next-car');
    await page.waitForFunction(previous=>document.documentElement.dataset.mountedCarId!==previous&&document.querySelector('#start-button')?.disabled===false,previous,{timeout:90000});
  }
  await page.click('#start-button');
  await page.waitForFunction(()=>window.__wheelFixProbe.latest?.locked===false,null,{timeout:30000});
  await page.evaluate(()=>{window.__wheelFixProbe.stage='accelerate';});
  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>window.__wheelFixProbe.latest?.speed>=213.6,null,{timeout:90000});
  await page.keyboard.up('KeyW');
  await page.evaluate(()=>{window.__wheelFixProbe.stage='coast';});
  await page.waitForTimeout(108);
  await page.evaluate(()=>{window.__wheelFixProbe.stage='brake-before-tap';});
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(1675);
  await page.evaluate(()=>{window.__wheelFixProbe.stage='tap';});
  const key=direction==='left'?'KeyA':'KeyD';
  if(direction!=='straight')await page.keyboard.down(key);
  await page.waitForTimeout(158);
  if(direction!=='straight')await page.keyboard.up(key);
  await page.evaluate(()=>{window.__wheelFixProbe.stage='brake-after-tap';});
  const stop=await page.waitForFunction(()=>window.__wheelFixProbe.latest?.speed<0.5,null,{timeout:18000}).then(()=>true,()=>false);
  await page.keyboard.up('KeyS');
  const data=await page.evaluate(()=>({samples:window.__wheelFixProbe.samples,keys:window.__wheelFixKeys}));
  const rows=data.samples.filter(r=>r.stage.startsWith('brake')||r.stage==='tap'),moving=rows.filter(r=>r.speed>20);
  const pathLength=rows.slice(1).reduce((s,r,i)=>s+Math.hypot(r.position.x-rows[i].position.x,r.position.z-rows[i].position.z),0);
  const summary={variant,direction,url:page.url(),scope:'Normal Longwan game, GT3RS selected through garage UI, trusted Chrome keyboard events, original production input/scheduler/Rapier. Fresh maneuver, not exact user-state replay.',
    runtimeHash,baselineFunctionRestoredOnlyInThisBrowser:switched,stopReached:stop,errors,
    samples:rows.length,entrySpeed:rows[0]?.speed,finalSpeed:rows.at(-1)?.speed,
    seconds:rows.reduce((s,r)=>s+r.dt,0),pathLength,maxBeta:Math.max(...moving.map(r=>Math.abs(r.beta))),
    maxYaw:Math.max(...moving.map(r=>Math.abs(r.yaw))),minRear:Math.min(...moving.flatMap(r=>r.output.wheels.slice(2).map(w=>w.load))),
    surfaces:[...new Set(moving.flatMap(r=>r.output.wheels.map(w=>w.surface)))],
    keys:data.keys,sourceUnchanged:runtimeHash===createHash('sha256').update(fs.readFileSync(runtimePath)).digest('hex')};
  fs.writeFileSync(`${dir}/${filename}.json`,JSON.stringify({summary,...data}));
  await page.screenshot({path:`${dir}/${filename}.png`});
  console.log(JSON.stringify(summary));
  if(errors.length||!summary.sourceUnchanged||(variant==='fixed'&&(!stop||summary.maxBeta>5||summary.minRear<=0)))process.exitCode=1;
}catch(e){
  fs.writeFileSync(`${dir}/${filename}-failure.json`,JSON.stringify({error:e.stack,errors}));
  console.error(e);process.exitCode=1;
}finally{await browser.close();}
