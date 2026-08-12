import assert from 'node:assert/strict';

import { ProceduralAudio } from '../src/audio.js';
import {
  FakeAudioContext,
  installFakeAudioWindow,
  telemetry,
  vehicleConfig,
} from './audio-test-harness.mjs';

const restoreWindow = installFakeAudioWindow();
const previousDateNow = Date.now;
let now = 0;
Date.now = () => now;

try {
  FakeAudioContext.reset();
  const dormant = new ProceduralAudio();
  dormant.update(telemetry);
  assert.equal(FakeAudioContext.instances.length, 0, 'update stays gesture-gated');

  FakeAudioContext.reset();
  let resolveResume;
  FakeAudioContext.resumeBehaviorFactory = () => new Promise((resolve) => {
    resolveResume = resolve;
  });
  const concurrent = new ProceduralAudio();
  concurrent.setVehicle(vehicleConfig);
  const firstInit = concurrent.init();
  const secondInit = concurrent.init();
  assert.equal(FakeAudioContext.instances.length, 1, 'concurrent init shares one context');
  assert.equal(FakeAudioContext.instances[0].resumeCalls, 1, 'concurrent init shares one resume request');
  const concurrentNodes = concurrent.nodes;
  FakeAudioContext.instances[0].state = 'running';
  resolveResume();
  await Promise.all([firstInit, secondInit]);
  assert.equal(concurrent.nodes, concurrentNodes, 'resume preserves the node graph');
  assert.equal(concurrentNodes.osc.startCalls, 1, 'resume does not restart oscillators');

  FakeAudioContext.reset();
  FakeAudioContext.resumeBehaviorFactory = () => Promise.reject(new Error('initial resume denied'));
  const denied = new ProceduralAudio();
  denied.setVehicle(vehicleConfig);
  await assert.doesNotReject(() => denied.init(), 'resume denial does not reject init');
  assert.equal(FakeAudioContext.instances[0].resumeCalls, 1, 'initial resume is attempted once');

  FakeAudioContext.reset();
  const recovery = new ProceduralAudio();
  recovery.setVehicle(vehicleConfig);
  await recovery.init();
  const context = recovery.context;
  const recoveryNodes = recovery.nodes;
  const initialResumeCalls = context.resumeCalls;
  recovery.setEnabled(false);
  const mutedMasterLevel = recoveryNodes.master.gain.value;
  context.resumeBehavior = () => Promise.reject(new Error('system resume denied'));
  now = 1000;
  context.suspendForTest();
  await Promise.resolve();
  recovery.update(telemetry);
  recovery.update(telemetry);
  await Promise.resolve();
  assert.equal(context.resumeCalls, initialResumeCalls + 1, 'statechange starts one recovery attempt');
  assert.equal(recovery.enabled, false, 'recovery preserves the mute switch');
  assert.equal(recoveryNodes.master.gain.value, mutedMasterLevel, 'recovery preserves master mute gain');
  assert.equal(recovery.nodes, recoveryNodes, 'recovery preserves the node graph');

  now = 1200;
  recovery.update(telemetry);
  assert.equal(context.resumeCalls, initialResumeCalls + 1, 'repeated updates are throttled');
  now = 1501;
  recovery.update(telemetry);
  await Promise.resolve();
  assert.equal(context.resumeCalls, initialResumeCalls + 2, 'failed recovery retries after throttle window');

  console.log('PASS audio context init/recovery is gesture-gated, single-flight, throttled, and mute-safe');
} finally {
  Date.now = previousDateNow;
  restoreWindow();
}
