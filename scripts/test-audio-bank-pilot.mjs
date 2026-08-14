import assert from 'node:assert/strict';

import { ProceduralAudio } from '../src/audio.js';
import { createGameAudioProfile, MX5_CANDIDATE_BANK_ID } from '../src/game-audio-banks.js';
import { CARS } from '../src/config.js';
import { FakeAudioContext, installFakeAudioWindow } from './audio-test-harness.mjs';

const approvedLoop = {
  status: 'approved',
  loopApproved: true,
  loopStart: 0,
  loopEnd: 2.5,
};

const candidateBank = {
  id: MX5_CANDIDATE_BANK_ID,
  scope: 'family',
  family: 'i4',
  quality: 'candidate-loop-approved',
  assetVersion: 'fixture-v1',
  rootUrl: '/fixture/mx5',
  manifestFile: 'bank.json',
};

const layers = [];
for (const rpm of [1800, 4200, 6800]) {
  for (const mode of ['off', 'on']) {
    layers.push({
      rpm,
      load: mode === 'on' ? 1 : 0.06,
      mode,
      file: `${rpm}-${mode}.wav`,
      loop: { ...approvedLoop },
    });
  }
}

const manifest = {
  schemaVersion: 2,
  version: 'fixture-v1',
  id: candidateBank.id,
  family: 'i4',
  sampleRate: 44_100,
  quality: 'candidate-loop-approved',
  loop: { ...approvedLoop },
  layers,
};

function makeFetch({ manifestStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, { signal } = {}) {
      calls.push({ url: String(url), signal });
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (String(url).includes('/bank.json')) {
        return {
          ok: manifestStatus >= 200 && manifestStatus < 300,
          status: manifestStatus,
          json: async () => structuredClone(manifest),
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer,
      };
    },
  };
}

const mx5 = CARS.find(({ id }) => id === 'mx5');
const gt3 = CARS.find(({ id }) => id === 'gt3rs');
const telemetry = {
  gear: 2,
  reverse: false,
  rpm: 4200,
  throttle: 1,
  speedKmh: 70,
  surface: 'asphalt',
  wheels: [{ slipRatio: 0, slipAngle: 0, slipPower: 0 }],
};

const restoreWindow = installFakeAudioWindow();
try {
  FakeAudioContext.reset();
  const successFetch = makeFetch();
  const events = [];
  const audio = new ProceduralAudio({
    bankDocument: { banks: [candidateBank] },
    resolveBankProfile: createGameAudioProfile,
    fetchImpl: successFetch.fetchImpl,
    onBankEvent: (event) => events.push(event),
  });
  await audio.setVehicle(mx5);
  await audio.init();
  let bankState = await audio.whenBankSettled();
  assert.equal(bankState.state, 'ready');
  assert.equal(bankState.resolution.mode, 'family');
  assert.equal(bankState.player.bankId, candidateBank.id);
  assert.equal(bankState.player.layerCount, 6);
  assert.equal(successFetch.calls.length, 7);
  assert.ok(successFetch.calls.every(({ signal }) => signal instanceof AbortSignal));
  assert.ok(events.some(({ type }) => type === 'bank-published'));

  audio.update(telemetry);
  assert.equal(audio.nodes.engineGain.gain.value, 0.0001, 'sample bank mutes only the procedural engine path');
  const middleOn = audio.bankPlayer.bank.layers.find((layer) => layer.rpm === 4200 && layer.mode === 'on');
  assert.equal(middleOn.gain.gain.value, 0.72);
  assert.equal(middleOn.source.playbackRate.value, 1);
  assert.equal(audio.bankPlayer.snapshot().activeLayerCount, 1);

  const bankTargetsBeforePause = middleOn.gain.gain.targets.length;
  audio.setPaused(true);
  audio.update({ ...telemetry, rpm: 6800, throttle: 0 });
  assert.equal(middleOn.gain.gain.targets.length, bankTargetsBeforePause, 'paused telemetry cannot retarget bank layers');
  assert.equal(audio.nodes.pauseGate.gain.value, 0.0001);
  audio.setPaused(false);
  audio.update({ ...telemetry, rpm: 6800, throttle: 0 });
  assert.ok(middleOn.gain.gain.targets.length > bankTargetsBeforePause);

  const decodedValue = audio.bankCoordinator.active.value;
  bankState = await audio.setVehicle(gt3);
  assert.equal(bankState.state, 'procedural');
  assert.equal(bankState.player.state, 'empty');
  assert.equal(decodedValue.disposed, true);
  assert.equal(decodedValue.layers.length, 0);
  audio.update({ ...telemetry, rpm: 6000, throttle: 0.5 });
  assert.ok(audio.nodes.engineGain.gain.value > 0.0001, 'non-pilot cars retain procedural engine audio');
  audio.disposeBankRuntime();
  assert.equal(audio.snapshot().bank.state, 'disposed');

  FakeAudioContext.reset();
  const failureFetch = makeFetch({ manifestStatus: 503 });
  const fallback = new ProceduralAudio({
    bankDocument: { banks: [candidateBank] },
    resolveBankProfile: createGameAudioProfile,
    fetchImpl: failureFetch.fetchImpl,
  });
  await fallback.setVehicle(mx5);
  await fallback.init();
  bankState = await fallback.whenBankSettled();
  assert.equal(bankState.state, 'degraded');
  assert.equal(bankState.resolution.mode, 'procedural');
  assert.match(bankState.error, /manifest HTTP 503/);
  fallback.update(telemetry);
  assert.ok(fallback.nodes.engineGain.gain.value > 0.0001, 'failed sample load deterministically keeps procedural audio');
  assert.equal(fallback.bankPlayer.snapshot().state, 'empty');
  fallback.disposeBankRuntime();

  console.log('PASS MX-5 bank pilot load/publish, RPM-load playback, pause freeze, switch release, and procedural fallback');
} finally {
  restoreWindow();
}
