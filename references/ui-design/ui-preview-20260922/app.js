'use strict';
const cars = [
  {id:'mx5',brand:'MAZDA',model:'MX-5',edition:'NA',full:'MAZDA MX-5 NA',drive:'后轮驱动',power:116,mass:990,gears:5},
  {id:'m3e30',brand:'BMW',model:'M3',edition:'E30',full:'BMW M3 E30',drive:'后轮驱动',power:200,mass:1200,gears:5},
  {id:'gt3rs',brand:'PORSCHE',model:'GT3 RS',edition:'911',full:'PORSCHE GT3 RS',drive:'后轮驱动',power:525,mass:1450,gears:7},
  {id:'lp700',brand:'LAMBORGHINI',model:'LP700',edition:'AVENTADOR',full:'LAMBORGHINI LP700',drive:'四轮驱动',power:700,mass:1680,gears:7},
  {id:'amggt3',brand:'MERCEDES',model:'AMG GT3',edition:'GT',full:'MERCEDES AMG GT3',drive:'后轮驱动',power:550,mass:1285,gears:6},
  {id:'m5g90',brand:'BMW',model:'M5',edition:'G90',full:'BMW M5 G90',drive:'四轮驱动',power:727,mass:2435,gears:8},
];
let selected = 0;
let current = 'garage';
let gear = 'AT';
let paused = false;
const $ = id => document.getElementById(id);
const views = ['garage','drive','results'];
const descriptions = {garage:'01 — 选车与比赛准备',drive:'02 — MX-5 驾驶界面 · 静态示例',results:'03 — 完赛与圈速 · 演示数据'};
const roster = $('car-roster');
cars.forEach((car,index) => {
  const button = document.createElement('button');
  button.className = 'car-choice';
  button.setAttribute('aria-label',`选择 ${car.full}`);
  button.setAttribute('aria-pressed',index===0?'true':'false');
  button.innerHTML = `<span class="roster-num">0${index+1}</span><small>${car.brand}</small><strong>${car.model}</strong>`;
  button.addEventListener('click',()=>selectCar(index));
  roster.append(button);
  const preload = new Image(); preload.src = `assets/${car.id}.png`;
});
function selectCar(index) {
  selected = (index + cars.length) % cars.length;
  const car = cars[selected];
  $('garage-image').src = `assets/${car.id}.png`;
  $('garage-image').alt = `项目中 ${car.full} 的赛道渲染`;
  $('result-image').src = `assets/${car.id}.png`;
  $('result-image').alt = `项目中 ${car.full} 的赛道渲染`;
  $('car-brand').textContent = car.brand;
  $('car-name').textContent = car.model;
  $('car-name').classList.toggle('long-name',car.model.length>5);
  $('car-edition').textContent = car.edition;
  $('car-index').textContent = `0${selected+1} / 06`;
  $('car-drive').textContent = car.drive;
  $('car-power').textContent = car.power;
  $('car-mass').textContent = car.mass.toLocaleString('en-US');
  $('car-gears').textContent = car.gears;
  $('car-fullname').textContent = car.full;
  $('result-brand').textContent = car.brand;
  $('result-car-name').textContent = `${car.model}${['mx5','m3e30','m5g90'].includes(car.id)?' '+car.edition:''}`;
  [...roster.children].forEach((button,i)=>button.setAttribute('aria-pressed',String(i===selected)));
}
function show(view,updateHash=true) {
  if(!views.includes(view)) return;
  setPaused(false,false);
  current = view;
  views.forEach(id => $(id).hidden=id!==view);
  $('stage').dataset.screen = view;
  document.querySelectorAll('[data-view]').forEach(button => {
    if(button.dataset.view===view) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  $('screen-description').textContent = descriptions[view];
  $('preview-note').textContent = view==='drive'?'MX-5 静态示例 · HUD 为演示数据':'独立预览 · 静态场景 / 演示数据';
  $('next-screen').firstChild.textContent = view==='results'?'返回选车 ':'下一画面 ';
  if(updateHash && location.hash!==`#${view}`) history.replaceState(null,'',`#${view}`);
}
function setPaused(value,moveFocus=true) {
  paused = value;
  $('pause-layer').hidden = !value;
  for(const element of [...$('drive').children]) {
    if(element !== $('pause-layer')) element.inert=value;
  }
  if(moveFocus) (value?$('resume'):$('pause')).focus();
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>show(button.dataset.view)));
document.querySelectorAll('[data-gear]').forEach(button=>button.addEventListener('click',()=>{
  gear=button.dataset.gear;
  document.querySelectorAll('[data-gear]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.gear===gear)));
  $('hud-gear').textContent=gear;
  $('result-transmission').textContent=gear==='AT'?'自动换挡 / AT':'手动换挡 / MT';
}));
$('start').addEventListener('click',()=>show('drive'));
$('pause').addEventListener('click',()=>setPaused(true));
$('resume').addEventListener('click',()=>setPaused(false));
$('restart').addEventListener('click',()=>{show('drive');$('pause').focus()});
$('back-garage').addEventListener('click',()=>{show('garage');$('start').focus()});
$('choose-car').addEventListener('click',()=>{show('garage');$('start').focus()});
$('retry').addEventListener('click',()=>show('drive'));
$('next-screen').addEventListener('click',()=>show(views[(views.indexOf(current)+1)%views.length]));
document.addEventListener('keydown',event=>{
  if(event.altKey||event.ctrlKey||event.metaKey) return;
  if(current==='garage' && (event.key==='ArrowRight'||event.key==='ArrowLeft')) {
    event.preventDefault();selectCar(selected+(event.key==='ArrowRight'?1:-1));
    if(roster.contains(document.activeElement)) roster.children[selected].focus();
  }
  if(event.key==='Escape'&&current==='drive'){event.preventDefault();setPaused(!paused)}
  if(event.key==='Tab'&&paused){
    const items=[...$('pause-layer').querySelectorAll('button')];
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  }
});
window.addEventListener('hashchange',()=>show(location.hash.slice(1),false));
show(views.includes(location.hash.slice(1))?location.hash.slice(1):'garage');
