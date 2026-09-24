import { ShaderChunk } from 'three';

// Blend translated samples on triangular cells, with explicit derivatives.
// All PBR channels use the same offsets; normals are not rotated or mirrored.
const sampling = `
vec2 scanHash(vec2 p) {
  return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
}
vec4 scanSample(sampler2D tex, vec2 uv) {
  vec2 p=mat2(1.0,0.0,-0.57735027,1.15470054)*uv;
  vec2 cell=floor(p), f=fract(p), a,b,c;
  vec3 w;
  if(f.x+f.y>1.0){
    a=cell+vec2(1.,1.);b=cell+vec2(1.,0.);c=cell+vec2(0.,1.);
    w=vec3(f.x+f.y-1.,1.-f.y,1.-f.x);
  }else{
    a=cell;b=cell+vec2(1.,0.);c=cell+vec2(0.,1.);
    w=vec3(1.-f.x-f.y,f.x,f.y);
  }
  w=pow(max(w,vec3(0.)),vec3(3.));w/=max(dot(w,vec3(1.)),.00001);
  vec2 dx=dFdx(uv),dy=dFdy(uv);
  return textureGrad(tex,uv+scanHash(a)*7.17,dx,dy)*w.x
       + textureGrad(tex,uv+scanHash(b)*7.17,dx,dy)*w.y
       + textureGrad(tex,uv+scanHash(c)*7.17,dx,dy)*w.z;
}
`;

export function installScanSurfaceSampling(material, { neutral = .8, gain = 1 } = {}) {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = sampling + shader.fragmentShader;
    for (const name of ['map_fragment','normal_fragment_maps','roughnessmap_fragment','aomap_fragment']) {
      let chunk = ShaderChunk[name];
      for (const [sampler, uv] of [['map','vMapUv'],['normalMap','vNormalMapUv'],['roughnessMap','vRoughnessMapUv'],['aoMap','vAoMapUv']]) {
        chunk = chunk.replaceAll(`texture2D( ${sampler}, ${uv} )`, `scanSample(${sampler},${uv})`);
      }
      if (name === 'map_fragment') chunk += `\n diffuseColor.rgb=mix(diffuseColor.rgb,vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),${neutral.toFixed(4)})*${gain.toFixed(4)};`;
      shader.fragmentShader = shader.fragmentShader.replace(`#include <${name}>`, chunk);
    }
  };
  material.customProgramCacheKey = () => `scan-surface-v1-${neutral}-${gain}`;
}
