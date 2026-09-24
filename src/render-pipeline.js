import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Colour and depth attachments must support the same sample count. Touch
// input is unrelated to MSAA support; use a modest 4x on either input mode.
export function getSceneSamples(renderer) {
  const gl = renderer.getContext();
  const colourSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
  const depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES);
  return Math.max(0, ...Array.from(colourSamples).filter(n => n > 1 && n <= 4 && depthSamples.includes(n)));
}

export function createRenderPipeline(renderer, scene, camera, { mobile = false, maxFps = Infinity } = {}) {
  let frameInterval = Number.isFinite(maxFps) ? 1000 / Math.max(1, maxFps) : 0;
  let lastRenderAt = -Infinity;
  let renderedFrames = 0;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Only the scene colour target is multisampled. Full-screen AO/compositing
  // targets do not need MSAA. Reuse its depth instead of redrawing every car
  // with an override material for a separate normal/depth prepass.
  const colour = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType, samples: getSceneSamples(renderer),
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType),
  });
  const composite = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType, depthBuffer: false,
  });
  const ao = new GTAOPass(scene, camera, Math.ceil(size.x / 2), Math.ceil(size.y / 2), undefined,
    { radius: .65, thickness: .8, distanceFallOff: .65, scale: 1, samples: mobile ? 8 : 16 },
    { radius: 4, depthPhi: 3, normalPhi: 4, samples: 8 });
  ao.setGBuffer(colour.depthTexture);
  ao.blendIntensity = .75;
  const output = new OutputPass();
  output.renderToScreen = true;
  let width = size.x;
  let height = size.y;
  let tireEffects = null;
  let lightRig = null;
  let qualityTier = 2;
  return {
    ao,
    get msaaSamples() { return colour.samples; },
    get maxFps() { return 1000 / frameInterval; },
    setMaxFps(value) {
      const next = Number.isFinite(value) ? 1000 / Math.max(1, value) : 0;
      if (next !== frameInterval) { frameInterval = next; lastRenderAt = -Infinity; }
    },
    get renderedFrames() { return renderedFrames; },
    shouldRender(now = performance.now()) { return now - lastRenderAt >= frameInterval; },
    setTireEffects(effects, lighting) { tireEffects=effects; lightRig=lighting; },
    get qualityTier() { return qualityTier; },
    setQualityTier(value) { qualityTier=THREE.MathUtils.clamp(Math.round(value),0,2); width=-1; },
    async warmup() {
      // Compile the same linear HDR/shadow/fog variants used by the colour
      // pass, including scenery outside the initial camera frustum.
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(colour);
      try {
        await renderer.compileAsync(scene, camera);
      } finally {
        renderer.setRenderTarget(previous);
      }
    },
    render() {
      const now = performance.now();
      if (now - lastRenderAt < frameInterval) return false;
      lastRenderAt = now;
      renderer.getDrawingBufferSize(size);
      if (size.x !== width || size.y !== height) {
        width = size.x; height = size.y;
        colour.setSize(width, height);
        composite.setSize(width, height);
        const fraction=[.25,.375,.5][qualityTier];
        ao.setSize(Math.max(1, Math.ceil(width * fraction)), Math.max(1, Math.ceil(height * fraction)));
      }
      renderer.info.autoReset = false;
      renderer.info.reset();
      renderer.setRenderTarget(colour);
      renderer.clear();
      renderer.render(scene, camera);
      ao.render(renderer, composite, colour);
      // Smoke is absent from the opaque colour/depth capture, and therefore
      // from GTAO. It reads resolved opaque depth and blends in linear HDR.
      tireEffects?.renderSmoke(renderer, camera, composite, colour.depthTexture, lightRig);
      output.render(renderer, null, composite);
      renderedFrames += 1;
      return true;
    },
    dispose() {
      colour.dispose(); composite.dispose(); ao.dispose(); output.dispose();
      // r180 GTAOPass.dispose omits these two shader materials.
      ao.gtaoMaterial.dispose(); ao.blendMaterial.dispose();
    },
  };
}
