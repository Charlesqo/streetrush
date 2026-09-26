import { chromium } from '/Users/charles/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const dir=new URL('./',import.meta.url).pathname;
await fs.mkdir(dir+'previews',{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1160},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('file://'+dir+'review.html');
await page.evaluate(()=>document.fonts.ready);
const evidence=[];
for(const theme of ['apex','shift','heritage','arcade','aero']){
 await page.locator(`[data-theme="${theme}"]`).click();
 for(const screen of ['menu','garage','hud']){
  await page.locator(`[data-screen="${screen}"]`).click();
  await page.locator('#sr-focus .sr-frame').screenshot({path:dir+`previews/${theme}-${screen}.png`});
  evidence.push(await page.locator('#sr-focus .sr-frame').evaluate(el=>({label:el.getAttribute('aria-label'),image:el.querySelector('img').naturalWidth,frame:[el.clientWidth,el.clientHeight],contentOverflow:[el.scrollWidth>el.clientWidth,el.scrollHeight>el.clientHeight]})));
 }
 await page.locator('[data-screen="garage"]').click();
 await page.locator('#sr-focus [data-car="3"]').click();
 await page.locator('#sr-focus .sr-frame').screenshot({path:dir+`previews/${theme}-long-car-name.png`});
 await page.locator('#sr-focus [data-car="0"]').click();
}
await page.locator('[data-overview]').click();
await page.setViewportSize({width:2560,height:1800});
await page.addStyleTag({content:'body{max-width:none} .sr-review-controls,.sr-source-note,figcaption button{display:none!important} .sr-overview-heading{font-size:24px} .sr-overview-note{font-size:18px!important} .sr-overview-frames figcaption{font-size:18px!important}'});
await page.locator('#sr-overview').screenshot({path:dir+'previews/all-five-directions.png'});
await page.reload();await page.setViewportSize({width:1024,height:1000});
await page.locator('[data-screen="garage"]').click();
await page.locator('[data-car="3"]').click();
if(!await page.locator('.sr-garage-heading').innerText().then(t=>t.includes('LAMBORGHINI')))throw Error('Car selection failed');
await page.locator('[data-act="prev"]').click();
if(!await page.locator('.sr-garage-heading').innerText().then(t=>t.includes('PORSCHE')))throw Error('Previous car failed');
await page.locator('[data-act="start"]').click();
if(!await page.locator('.sr-scene').getAttribute('alt').then(t=>t.includes('PORSCHE')))throw Error('Selected car lost on start');
await page.locator('[data-act="pause"]').click();
if(!await page.locator('[role="dialog"]').isVisible())throw Error('Pause dialog failed');
await page.locator('[data-act="close"]').click();
await page.locator('[data-act="settings"]').click();
await page.locator('.sr-modal [data-act="mode"]').click();
await page.locator('.sr-modal [data-act="close"]').click();
if(!await page.locator('.sr-gear').innerText().then(t=>t.includes('MT')))throw Error('Shift mode failed');
for(const width of [1024,736,390]){
 await page.setViewportSize({width,height:1000});
 for(const screen of ['menu','garage','hud']){
  await page.locator(`[data-screen="${screen}"]`).click();
  await page.locator('#sr-focus .sr-frame').screenshot({path:dir+`previews/responsive-${width}-${screen}.png`});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Page overflow at '+width);
 }
}
await fs.writeFile(dir+'verification.json',JSON.stringify({checkedAt:new Date().toISOString(),errors,evidence,interactions:['theme switching','scene switching','all 15 screen overview','six-car selection','long car name across all five themes','previous car','selected car preserved on start','pause','resume','settings','shift mode'],widths:[1600,1024,736,390],note:'UI-only visual and interaction checks. No game physics or production completion claim.'},null,2));
console.log(JSON.stringify({errors,screens:evidence.length}));
await browser.close();
