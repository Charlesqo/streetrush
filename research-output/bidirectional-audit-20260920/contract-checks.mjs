import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { refineCarMaterials } from '../../src/car-materials.js';

const dir = new URL('./', import.meta.url);
const sources = JSON.parse(await readFile(new URL('source-materials.json', dir)));
const cases = [ ['gt3rs','TwiXeR_992_blackGlass.001'], ['lp700','Vitre_noir'], ['gt3rs','TwiXeR_992_ID08_fabric_002.001'], ['gt3rs','TwiXeR_992_carbon_roof.001'] ];
const materialResults = cases.map(([car,name]) => {
  const source = sources.find(c=>c.car===car).materials.find(m=>m.name===name);
  const m = new THREE.MeshStandardMaterial({name,roughness:source.pbr?.roughnessFactor??1,metalness:source.pbr?.metallicFactor??1,transparent:source.alphaMode==='BLEND'});
  m.color.fromArray(source.pbr?.baseColorFactor??[1,1,1]);
  if(source.pbr?.baseColorTexture)m.map=new THREE.Texture();
  const root=new THREE.Group(), mesh=new THREE.Mesh(new THREE.BoxGeometry(),m);root.add(mesh);
  refineCarMaterials(root,car);
  const out=mesh.material;
  const result={car,name,source:{color:m.color.toArray(),roughness:m.roughness,metalness:m.metalness,transparent:m.transparent},runtime:{role:out.userData.streetRushRole,color:out.color.toArray(),roughness:out.roughness,metalness:out.metalness,transparent:out.transparent,clearcoat:out.clearcoat,type:out.type}};
  m.dispose();out.dispose();mesh.geometry.dispose();return result;
});
assert.equal(materialResults[0].runtime.transparent,false);
assert.notDeepEqual(materialResults[0].source.color,materialResults[0].runtime.color);
assert.equal(materialResults[2].runtime.role,'plastic');
assert.equal(materialResults[3].runtime.type,'MeshStandardMaterial');
assert.equal(materialResults[3].runtime.clearcoat,undefined);

// Execute the actual counter body, with only its UI and quality-controller
// dependencies stubbed. Use the same frame clamp extracted from main's dependency.
const main=await readFile('src/main.js','utf8');
const body=main.slice(main.indexOf('function updatePerformance(frameDt) {'),main.indexOf('\nfunction animate(now)'));
const timingSource=await readFile('src/physics-scheduling.js','utf8');
const limit=Number(timingSource.match(/export const MAX_FRAME_DT = ([\d.]+);/)[1]);
const counterResults=[];
for(const inputFps of [60,30,20,10,5]) {
  const measure=new Function('inputFps','limit', `
    const renderReviewRequested=false,circuitReviewRequested=false;
    let fpsAccumulator=0,lastMeasuredRenderCount=0,slowFrameWindows=0,stableFrameWindows=0,physicsCost=0,renderScale=1;
    const el={textContent:''}, $=()=>el, canvas={width:1280,height:720}, devicePixelRatio=1;
    const getRenderScaleLimit=()=>1;
    const renderer={info:{render:{calls:1,triangles:1}},setPixelRatio(){}};
    const renderPipeline={renderedFrames:0,maxFps:Infinity,msaaSamples:4,qualityTier:2,setQualityTier(v){this.qualityTier=v}};
    ${body}
    for(let i=0;i<inputFps*4;i++){renderPipeline.renderedFrames++;updatePerformance(Math.min(limit,1/inputFps));}
    return {inputFps,reportedFps:Number(el.textContent.split(' ')[0]),display:el.textContent};
  `);
  counterResults.push(measure(inputFps,limit));
}
assert.equal(counterResults.find(r=>r.inputFps===10).reportedFps,20);
assert.equal(counterResults.find(r=>r.inputFps===5).reportedFps,20);
await writeFile(new URL('contract-checks.json',dir),JSON.stringify({materials:materialResults,fpsCounter:counterResults,note:'Material source parameters come from real GLBs; textures are presence markers in this CPU test. FPS executes the source function with deterministic frame intervals. These checks reproduce behavior, not visual acceptance.'},null,2));
console.log(JSON.stringify({materials:materialResults,fpsCounter:counterResults},null,2));
