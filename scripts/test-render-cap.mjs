import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as THREE from 'three';
import { createRenderPipeline, getSceneSamples } from '../src/render-pipeline.js';

let clock = 0;
mock.method(performance, 'now', () => clock);
const calls = [];
let supportedColourSamples = new Int32Array([8, 4, 2]);
let supportedDepthSamples = new Int32Array([4, 2]);
const gl = {
  RENDERBUFFER: 1, RGBA16F: 2, DEPTH_COMPONENT24: 3, SAMPLES: 4,
  getInternalformatParameter: (_, format) => format === 2 ? supportedColourSamples : supportedDepthSamples,
};
const renderer = {
  getContext: () => gl,
  getDrawingBufferSize: v => { calls.push('size'); return v.set(800, 600); },
  info: { reset() { calls.push('reset'); } },
  setRenderTarget() { calls.push('target'); }, clear() { calls.push('clear'); },
  render() { calls.push('draw'); },
  toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
};
assert.equal(getSceneSamples(renderer), 4, 'Use common HDR/depth support, capped at 4x');
supportedDepthSamples = new Int32Array([2]);
assert.equal(getSceneSamples(renderer), 2, 'Do not request unsupported depth samples');
supportedColourSamples = new Int32Array([]);
assert.equal(getSceneSamples(renderer), 0, 'No unsupported multisampled framebuffer on limited devices');
supportedColourSamples = supportedDepthSamples = new Int32Array([4, 2]);
const touchPipeline = createRenderPipeline(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { mobile: true });
assert.equal(touchPipeline.msaaSamples, 4, 'Touch mode must retain supported scene antialiasing');
touchPipeline.dispose();
const pipeline = createRenderPipeline(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { maxFps: 5 });
assert.equal(pipeline.msaaSamples, 4);
pipeline.ao.render = () => calls.push('ao');
pipeline.setTireEffects({ renderSmoke() { calls.push('smoke'); } });
assert.equal(pipeline.render(), true);
assert.ok(calls.includes('draw') && calls.includes('ao') && calls.includes('smoke'));
const firstPass = [...calls];
for (clock = 1; clock < 200; clock++) assert.equal(pipeline.render(), false);
assert.deepEqual(calls, firstPass, 'Skipped frames must submit no scene, AO, smoke, output or resize work');
clock = 200;
assert.equal(pipeline.render(), true);
assert.equal(pipeline.renderedFrames, 2);
const timestamps = [];
for (clock = 201; clock < 1201; clock++) if (pipeline.render()) timestamps.push(clock);
assert.equal(timestamps.length, 5, 'A 1000 Hz caller still submits at most 5 frames per second');
clock = 60_000;
assert.equal(pipeline.render(), true);
assert.equal(pipeline.render(), false, 'Returning from a suspended tab must not trigger catch-up renders');
assert.equal(pipeline.shouldRender(60_199), false);
assert.equal(pipeline.shouldRender(60_200), true);
clock = 60_010;
pipeline.setMaxFps(Infinity);
assert.equal(pipeline.render(), true, 'Starting motion releases the previous static-frame wait immediately');
for (let i = 0; i < 30; i++) { clock += 1000 / 60; pipeline.setMaxFps(Infinity); assert.equal(pipeline.render(), true); }
pipeline.setMaxFps(5);
assert.equal(pipeline.render(), true, 'Stopping motion permits one final settled frame');
clock += 16;
pipeline.setMaxFps(5);
assert.equal(pipeline.render(), false, 'Repeated static-state updates must not reset the limiter');
pipeline.dispose();
const normal = createRenderPipeline(renderer, new THREE.Scene(), new THREE.PerspectiveCamera());
normal.ao.render = () => {};
assert.equal(normal.maxFps, Infinity);
for (let i = 0; i < 60; i++) { clock += 1000 / 60; assert.equal(normal.render(), true); }
assert.equal(normal.renderedFrames, 60, 'Normal game is not subject to preview cap');
normal.dispose();
mock.restoreAll();
console.log('PASS actual render pipeline: preview-only 5 FPS ceiling; normal 60 Hz caller unthrottled, no GPU passes on skipped frames, no catch-up burst');
