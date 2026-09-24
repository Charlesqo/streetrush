import * as THREE from 'three';

// Road-only preview. Keep the previous DFG path in the same shader so A/B
// changes only a uniform, not the environment capture or shader program.
export function patchRoadEnvironmentChunk(chunk, width, height) {
  const start = chunk.indexOf('vec2 DFGApprox(');
  if (start < 0) throw new Error('Road reflection trial: Three.js DFG signature changed');
  const open = chunk.indexOf('{', start);
  let end = open, depth = 0;
  for (; end < chunk.length; end++) {
    if (chunk[end] === '{') depth++;
    if (chunk[end] === '}' && --depth === 0) break;
  }
  if (end === chunk.length) throw new Error('Road reflection trial: incomplete DFG function');
  const original = chunk.slice(start, end + 1).replace('DFGApprox(', 'roadLegacyDFG(');
  const replacement = `${original}
uniform sampler2D roadDfgLut;
uniform bool roadDfgEnabled;
vec2 DFGApprox(const in vec3 n, const in vec3 v, const in float r) {
  if (!roadDfgEnabled) return roadLegacyDFG(n, v, r);
  // Denser table samples near grazing angles; inverse of Nv = gridX squared.
  vec2 p = vec2(sqrt(clamp(dot(n,v),0.0,1.0)),clamp(r,0.0,1.0));
  vec2 size = vec2(${width.toFixed(1)},${height.toFixed(1)});
  return texture2D(roadDfgLut,(p*(size-1.0)+0.5)/size).rg;
}`;
  return chunk.slice(0, start) + replacement + chunk.slice(end + 1);
}

export async function createRoadEnvironmentResponse() {
  const response = await fetch(new URL('./data/road-dfg-lut.json', import.meta.url));
  if (!response.ok) throw new Error(`Road reflection LUT: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.type !== 'float16' || payload.grid?.x !== 'sqrt(NdotV)'
      || payload.grid?.y !== 'perceptualRoughness' || payload.byteOrder !== 'little-endian'
      || !Number.isInteger(payload.width) || payload.width < 2
      || !Number.isInteger(payload.height) || payload.height < 2) {
    throw new Error('Road reflection LUT: unsupported layout');
  }
  const bytes = Uint8Array.from(atob(payload.base64), c => c.charCodeAt(0));
  // Asset metadata and decoding are checked by the generator's validation.
  const count = payload.width * payload.height * 2;
  if (bytes.length !== count * 2) throw new Error('Road reflection LUT: unexpected length');
  const data = new Uint16Array(count);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) data[i] = view.getUint16(i * 2, true);
  const texture = new THREE.DataTexture(data, payload.width, payload.height, THREE.RGFormat, THREE.HalfFloatType);
  texture.name = 'Road GGX environment response';
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const enabled = { value: false };
  const chunk = patchRoadEnvironmentChunk(THREE.ShaderChunk.lights_physical_pars_fragment, payload.width, payload.height);
  return {
    get enabled() { return enabled.value; },
    setEnabled(value) { enabled.value = Boolean(value); },
    install(material) {
      const before = material.onBeforeCompile;
      const key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        before.call(material, shader, renderer);
        shader.uniforms.roadDfgLut = { value: texture };
        shader.uniforms.roadDfgEnabled = enabled;
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk);
      };
      material.customProgramCacheKey = () => `${key}-road-dfg-full-v1`;
      material.needsUpdate = true;
    },
  };
}
