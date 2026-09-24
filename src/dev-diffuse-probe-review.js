// REJECTED visual experiment, retained only for the historical review record.
// No game or render-review entry point imports this module.
// Samples lit scene radiance; the sparse field spreads colour too broadly.
import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';

export function createDiffuseProbeReview({ renderer, scene, camera, lighting, getVehicle }) {
  const uniforms = {
    streetProbeOn: { value: 0 },
    streetProbeCenter: { value: new THREE.Vector3() },
    streetProbeLow: { value: Array.from({length:9},()=>new THREE.Vector3()) },
    streetProbeHigh: { value: Array.from({length:9},()=>new THREE.Vector3()) },
  };
  const patched = new Set();
  const probeNormal = new THREE.Vector3();
  const coating = new Map();
  let colourCard=null;
  const header = `uniform float streetProbeOn; uniform vec3 streetProbeCenter;
    uniform vec3 streetProbeLow[9], streetProbeHigh[9]; varying vec3 vStreetProbePosition;
    float streetProbeWeight(){return streetProbeOn*(1.-smoothstep(16.,28.,length((vStreetProbePosition-streetProbeCenter).xz)))*(1.-smoothstep(3.,7.,vStreetProbePosition.y-streetProbeCenter.y));}`;
  function patchMaterials() {
    scene.traverse(object=>{
      if(!object.isMesh)return;
      for(const material of Array.isArray(object.material)?object.material:[object.material]) {
        if(!material?.isMeshStandardMaterial||patched.has(material))continue;
        const previous=material.onBeforeCompile, key=material.customProgramCacheKey();
        material.onBeforeCompile=function(shader, activeRenderer){
          previous.call(this,shader,activeRenderer);
          Object.assign(shader.uniforms,uniforms);
          shader.vertexShader='varying vec3 vStreetProbePosition;\n'+shader.vertexShader.replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
            vec4 streetWorld=vec4(transformed,1.);
            #ifdef USE_BATCHING
              streetWorld=batchingMatrix*streetWorld;
            #endif
            #ifdef USE_INSTANCING
              streetWorld=instanceMatrix*streetWorld;
            #endif
            vStreetProbePosition=(modelMatrix*streetWorld).xyz;`);
          shader.fragmentShader=header+'\n'+shader.fragmentShader;
          shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',THREE.ShaderChunk.lights_fragment_begin.replace(
            'getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )',
            '(1.-streetProbeWeight())*getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )'));
          shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_maps>',THREE.ShaderChunk.lights_fragment_maps.replace(
            'iblIrradiance += getIBLIrradiance( geometryNormal );',
            `float streetWeight=streetProbeWeight();
             vec3 streetIrradiance=getIBLIrradiance(geometryNormal);
             if(streetWeight>0.){
               vec3 streetNormal=inverseTransformDirection(geometryNormal,viewMatrix);
               float streetHeight=smoothstep(.25,2.2,vStreetProbePosition.y-streetProbeCenter.y);
               vec3 streetE=max(vec3(0.),mix(shGetIrradianceAt(streetNormal,streetProbeLow),shGetIrradianceAt(streetNormal,streetProbeHigh),streetHeight));
               streetIrradiance=mix(streetIrradiance,streetE*.8,streetWeight);
             }
             iblIrradiance+=streetIrradiance;`));
        };
        material.customProgramCacheKey=()=>key+'|street-diffuse-probe-v1';
        material.needsUpdate=true;patched.add(material);
      }
    });
  }
  function anchorNearCamera() {
    const track=scene.getObjectByName('gp-track');
    const matrix=new THREE.Matrix4(),position=new THREE.Vector3();
    let closest=null,best=Infinity;
    track.traverse(object=>{
      if(!object.isInstancedMesh||object.material?.color?.getHex()!==0x9da2a6)return;
      for(let i=0;i<object.count;i++){
        object.getMatrixAt(i,matrix);matrix.premultiply(object.matrixWorld);position.setFromMatrixPosition(matrix);
        const distance=position.distanceToSquared(camera.position);
        if(distance<best){best=distance;closest={matrix:matrix.clone(),center:position.clone()};}
      }
    });
    if(!closest)throw new Error('当前护栏不匹配此局部测试；没有修改或替换模型');
    const normal=new THREE.Vector3(1,0,0).transformDirection(closest.matrix);
    if(normal.dot(camera.position.clone().sub(closest.center))<0)normal.negate();
    probeNormal.copy(normal);
    const base=closest.center.clone().addScaledVector(normal,.5);base.y=0;
    return base;
  }
  let baking=false,ready=false;
  async function bake() {
    if(baking)return;
    baking=true;uniforms.streetProbeOn.value=0;
    let anchor;
    try {anchor=anchorNearCamera();}catch(error){baking=false;throw error;}
    uniforms.streetProbeCenter.value.copy(anchor);
    const target=new THREE.WebGLCubeRenderTarget(32,{type:THREE.HalfFloatType,generateMipmaps:false,depthBuffer:true});
    const cube=new THREE.CubeCamera(.03,180,target);
    const car=getVehicle()?.visual,visible=car?.visible;
    const sky=scene.children.find(o=>o.material?.name==='photographed-daylight-sky');
    const captureMode=sky?.material.uniforms.captureMode.value;
    const fog=scene.fog,previousTarget=renderer.getRenderTarget();
    try {
      if(car)car.visible=false;
      scene.fog=null;
      if(sky)sky.material.uniforms.captureMode.value=1;
      lighting.sun.shadow.needsUpdate=true;
      for(const [height,destination] of [[.25,uniforms.streetProbeLow],[2.2,uniforms.streetProbeHigh]]) {
        cube.position.copy(anchor);cube.position.y+=height;cube.update(renderer,scene);
        const probe=await LightProbeGenerator.fromCubeRenderTarget(renderer,target);
        probe.sh.coefficients.forEach((coefficient,index)=>destination.value[index].copy(coefficient));
      }
      patchMaterials();ready=true;uniforms.streetProbeOn.value=1;
      return {anchor:anchor.toArray(),low:uniforms.streetProbeLow.value.map(v=>v.toArray()),high:uniforms.streetProbeHigh.value.map(v=>v.toArray())};
    } finally {
      if(car)car.visible=visible;
      scene.fog=fog;if(sky)sky.material.uniforms.captureMode.value=captureMode;
      lighting.sun.shadow.needsUpdate=true;renderer.setRenderTarget(previousTarget);target.dispose();baking=false;
    }
  }
  return {bake,get baking(){return baking;},get enabled(){return uniforms.streetProbeOn.value===1;},toggle(){if(ready)uniforms.streetProbeOn.value=1-uniforms.streetProbeOn.value;},
    toggleCoating(){
      if(coating.size){for(const [material,old] of coating)Object.assign(material,old);coating.clear();return;}
      scene.getObjectByName('gp-track').traverse(object=>{const m=object.material;if(!object.isInstancedMesh||m?.color?.getHex()!==0x9da2a6)return;coating.set(m,{metalness:m.metalness,roughness:m.roughness});m.metalness=.02;m.roughness=.72;});
    },
    toggleColourCard(){
      if(colourCard){colourCard.visible=!colourCard.visible;return;}
      const anchor=anchorNearCamera();colourCard=new THREE.Mesh(new THREE.BoxGeometry(4,.01,6),new THREE.MeshStandardMaterial({color:0xdc421c,roughness:1}));
      colourCard.position.copy(anchor).addScaledVector(probeNormal,2.4);colourCard.position.y=.04;
      colourCard.rotation.y=Math.atan2(probeNormal.x,probeNormal.z);colourCard.receiveShadow=true;scene.add(colourCard);
    },
  };
}
