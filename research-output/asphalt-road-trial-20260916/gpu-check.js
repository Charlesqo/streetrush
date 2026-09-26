import * as THREE from 'three';
import { createRoadEnvironmentResponse } from '/src/road-environment-response.js';
import { installScanSurfaceSampling } from '/src/scan-surface-sampling.js';
const $=id=>document.getElementById(id);
const renderer=new THREE.WebGLRenderer({canvas:$('canvas')});
const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-.01,.01,.01,-.01,.01,100);
const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType});
const mat=new THREE.MeshStandardMaterial({roughness:.837,metalness:0});
installScanSurfaceSampling(mat);
const road=new THREE.Mesh(new THREE.PlaneGeometry(10,10),mat);road.rotation.x=-Math.PI/2;scene.add(road);
const px=new Float32Array(4);
let shaderBeforeCheck,response;
$('run').onclick=async()=>{try{
  $('run').disabled=true;$('status').textContent='GPU验证中';
  response=await createRoadEnvironmentResponse();response.install(mat);shaderBeforeCheck=mat.onBeforeCompile;
  mat.onBeforeCompile=(s,r)=>{shaderBeforeCheck(s,r);s.fragmentShader=s.fragmentShader.replace('#include <opaque_fragment>',`outgoingLight=vec3(DFGApprox(normal,geometryViewDir,material.roughness),0.0);\n#include <opaque_fragment>`);};
  mat.customProgramCacheKey=()=> 'road-response-actual-gpu-probe';
  const rows=[];
  for(const roughness of [.0525,.25,.6,.837,1])for(const nv of [.001,.025,.1,.5,1]){
    mat.roughness=roughness;camera.position.set(-Math.sqrt(1-nv*nv)*10,nv*10,0);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
    const row={roughness,nv};
    for(const [name,enabled]of[['original',false],['trial',true],['restored',false]]){
      response.setEnabled(enabled);renderer.setRenderTarget(target);renderer.render(scene,camera);await renderer.readRenderTargetPixelsAsync(target,0,0,1,1,px);row[name]=Array.from(px.slice(0,2));
    }
    if(row.original.some((v,i)=>v!==row.restored[i]))throw Error('Original response did not restore');
    if(row.trial.some(v=>!Number.isFinite(v)||v<0))throw Error('Nonfinite/negative response');
    rows.push(row);
  }
  const result={three:THREE.REVISION,description:'Actual material shader and shipped texture. Flat surface, float RG output of DFG function. Scan-sampling hook installed before road hook. Off/on/off exact restoration. No scene-appearance/performance claim.',rows};
  $('result').textContent=JSON.stringify(result,null,2);$('status').textContent='完成：25组GPU查表与原版恢复';
}catch(e){$('status').textContent=e.stack;console.error(e);}};
