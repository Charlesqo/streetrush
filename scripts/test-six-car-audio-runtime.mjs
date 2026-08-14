import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProceduralAudio } from '../src/audio.js';
import { createGameAudioProfile, GAME_AUDIO_BANKS, GAME_AUDIO_BANK_IDS } from '../src/game-audio-banks.js';
import { CARS } from '../src/config.js';
import { FakeAudioContext, installFakeAudioWindow } from './audio-test-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failNextLp700Manifest = true;
let abortedFetchCount = 0;
let successfulFetchCount = 0;

async function fetchProductionAsset(url, { signal } = {}) {
  if (signal?.aborted) {
    abortedFetchCount += 1;
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
  const parsed = new URL(String(url), 'http://streetrush.local');
  const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  assert.ok(relativePath.startsWith('audio-banks/'), `audio fetch stays in audio-banks: ${relativePath}`);
  if (failNextLp700Manifest && relativePath === 'audio-banks/lp700/bank.json') {
    failNextLp700Manifest = false;
    return { ok: false, status: 503 };
  }
  const bytes = await readFile(path.join(root, 'public', relativePath));
  successfulFetchCount += 1;
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(bytes.toString('utf8')),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const restoreWindow = installFakeAudioWindow();
try {
  FakeAudioContext.reset();
  const events = [];
  const audio = new ProceduralAudio({
    bankDocument: GAME_AUDIO_BANKS,
    resolveBankProfile: createGameAudioProfile,
    fetchImpl: fetchProductionAsset,
    onBankEvent: (event) => events.push(event),
  });

  await audio.setVehicle(CARS[0]);
  await audio.init();
  let bank = await audio.whenBankSettled();
  assert.equal(bank.state, 'ready');
  assert.equal(bank.player.bankId, GAME_AUDIO_BANK_IDS.mx5);
  let successfulAttachCount = 1;

  for (let round = 0; round < 4; round += 1) {
    for (const car of CARS) {
      bank = await audio.setVehicle(car);
      if (round === 0 && car.id === 'lp700') {
        assert.equal(bank.state, 'degraded');
        assert.equal(bank.resolution.mode, 'procedural');
        assert.match(bank.error, /manifest HTTP 503/);
        assert.equal(bank.player.state, 'empty');
        bank = await audio.setVehicle(car);
      }
      assert.equal(bank.state, 'ready', `${car.id} round ${round} publishes`);
      assert.equal(bank.resolution.mode, 'family');
      assert.equal(bank.player.bankId, GAME_AUDIO_BANK_IDS[car.id]);
      assert.equal(bank.player.layerCount, 6);
      audio.update({
        gear: 2,
        reverse: false,
        rpm: Math.min(car.redline, car.idle + (car.redline - car.idle) * 0.58),
        throttle: (round + 1) / 5,
        speedKmh: 72,
        surface: 'asphalt',
        wheels: [{ slipRatio: 0.02, slipAngle: 0.01, slipPower: 0 }],
      });
      assert.ok(audio.bankPlayer.snapshot().activeLayerCount >= 2);
      successfulAttachCount += 1;
    }
  }

  const activeLayer = audio.bankPlayer.bank.layers[0];
  const targetsBeforePause = activeLayer.gain.gain.targets.length;
  audio.setPaused(true);
  audio.update({ rpm: 4000, throttle: 1, speedKmh: 100, wheels: [] });
  assert.equal(activeLayer.gain.gain.targets.length, targetsBeforePause);
  assert.equal(audio.snapshot().bank.state, 'ready');
  audio.setPaused(false);
  audio.update({ rpm: 4000, throttle: 1, speedKmh: 100, wheels: [] });
  assert.ok(activeLayer.gain.gain.targets.length > targetsBeforePause);

  assert.equal(successfulAttachCount, 25);
  assert.equal(successfulFetchCount, successfulAttachCount * 7);
  assert.equal(abortedFetchCount, 0);
  assert.equal(events.filter(({ type }) => type === 'bank-published').length, successfulAttachCount);
  assert.equal(events.filter(({ type }) => type === 'bank-failed').length, 1);

  const context = FakeAudioContext.instances[0];
  const bankSources = context.createdBufferSources.slice(1);
  assert.equal(bankSources.length, successfulAttachCount * 6);
  assert.equal(bankSources.filter(({ stopCalls }) => stopCalls === 1).length, bankSources.length - 6);
  assert.equal(bankSources.filter(({ stopCalls }) => stopCalls === 0).length, 6);
  audio.disposeBankRuntime();
  assert.ok(bankSources.every(({ stopCalls, disconnectCalls }) => stopCalls === 1 && disconnectCalls === 1));
  assert.equal(audio.snapshot().bank.state, 'disposed');

  console.log(`PASS six-car audio runtime rounds=4 attaches=${successfulAttachCount} fetches=${successfulFetchCount} sources=${bankSources.length} fallback=1`);
} finally {
  restoreWindow();
}
