import assert from 'node:assert/strict';

import { ProceduralAudio } from '../src/audio.js';
import {
  FakeAudioContext,
  installFakeAudioWindow,
  telemetry,
  vehicleConfig,
} from './audio-test-harness.mjs';

const restoreWindow = installFakeAudioWindow();

try {
  FakeAudioContext.reset();
  const audio = new ProceduralAudio();
  audio.setVehicle(vehicleConfig);
  await audio.init();
  const context = audio.context;
  const nodes = audio.nodes;

  audio.update(telemetry);
  const targetsBeforePause = {
    engine: nodes.engineGain.gain.targets.length,
    road: nodes.roadNoiseGain.gain.targets.length,
    wind: nodes.windGain.gain.targets.length,
    oscillator: nodes.osc.frequency.targets.length,
  };
  const sourcesBeforePause = {
    oscillators: context.createdOscillators.length,
    buffers: context.createdBufferSources.length,
  };

  audio.setPaused(true);
  assert.equal(audio.paused, true, 'pause owner records the frozen state');
  assert.equal(nodes.pauseGate.gain.value, 0.0001, 'pause gate fades to silence');
  assert.equal(nodes.pauseGate.gain.targets.at(-1).timeConstant, 0.06, 'pause gate uses a short fade');
  const pauseTargetCount = nodes.pauseGate.gain.targets.length;
  audio.setPaused(true);
  assert.equal(nodes.pauseGate.gain.targets.length, pauseTargetCount, 'repeated pause is idempotent');

  const staleTelemetry = {
    ...telemetry,
    gear: 4,
    rpm: 7200,
    throttle: 1,
    speedKmh: 220,
    wheels: [{ slipRatio: 0.9, slipAngle: 0.4, slipPower: 1 }],
  };
  audio.update(staleTelemetry);
  audio.playTone(440, 0.1, 0.05);
  audio.playNoiseBurst(0.1, 0.05);
  assert.deepEqual({
    engine: nodes.engineGain.gain.targets.length,
    road: nodes.roadNoiseGain.gain.targets.length,
    wind: nodes.windGain.gain.targets.length,
    oscillator: nodes.osc.frequency.targets.length,
  }, targetsBeforePause, 'paused updates do not follow stale RPM, slip, or speed');
  assert.deepEqual({
    oscillators: context.createdOscillators.length,
    buffers: context.createdBufferSources.length,
  }, sourcesBeforePause, 'paused owner creates no transient sources');

  audio.setPaused(false);
  assert.equal(audio.paused, false, 'resume clears the pause state');
  assert.equal(nodes.pauseGate.gain.value, 1, 'resume opens the gate');
  assert.equal(nodes.pauseGate.gain.targets.at(-1).timeConstant, 0.06, 'resume smooths the gate');
  const resumeTargetCount = nodes.pauseGate.gain.targets.length;
  audio.setPaused(false);
  assert.equal(nodes.pauseGate.gain.targets.length, resumeTargetCount, 'repeated resume is idempotent');

  audio.update(staleTelemetry);
  assert.deepEqual({
    oscillators: context.createdOscillators.length,
    buffers: context.createdBufferSources.length,
  }, sourcesBeforePause, 'first resumed telemetry cannot synthesize a stale gear-shift transient');

  console.log('PASS audio pause gate freezes telemetry and transients with idempotent resume');
} finally {
  restoreWindow();
}
