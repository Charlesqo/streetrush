import assert from 'node:assert/strict';

import { CARS } from '../src/config.js';
import {
  AudioBankCoordinator,
  isRuntimeEligibleBank,
  resolveAudioSelection,
  resolveVehicleAudioProfile,
} from '../src/audio-bank-coordinator.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function abortError() {
  const error = new Error('fixture load aborted');
  error.name = 'AbortError';
  return error;
}

function profile(id, family, fallbackIds = [], exactBankId = null) {
  return {
    id,
    engine: { family },
    audio: {
      exactBankId,
      familyFallbackBankIds: fallbackIds,
      proceduralFallback: true,
    },
  };
}

const approvedI4 = {
  id: 'bank.candidate.i4.approved',
  scope: 'family',
  family: 'i4',
  quality: 'candidate-loop-approved',
};
const approvedV8 = {
  id: 'bank.candidate.v8.approved',
  scope: 'family',
  family: 'v8',
  quality: 'candidate-loop-approved',
};
const unapprovedI4 = {
  id: 'bank.candidate.i4.unapproved',
  scope: 'family',
  family: 'i4',
  quality: 'candidate-unapproved',
};
const prototypeV6 = {
  id: 'bank.source.v6',
  scope: 'family',
  family: 'v6',
  quality: 'prototype',
};
const banks = { banks: [approvedI4, approvedV8, unapprovedI4, prototypeV6] };

assert.equal(isRuntimeEligibleBank(approvedI4), true);
assert.equal(isRuntimeEligibleBank(unapprovedI4), false);
assert.equal(isRuntimeEligibleBank(prototypeV6), true);

const exact = {
  id: 'bank.exact.mx5',
  scope: 'exact',
  vehicleId: 'mx5',
  family: 'i4',
  quality: 'production',
};
assert.equal(
  resolveAudioSelection(profile('mx5', 'i4', [approvedI4.id], exact.id), { banks: [exact, approvedI4] }).mode,
  'exact',
);
assert.equal(resolveAudioSelection(profile('mx5', 'i4', [approvedI4.id]), banks).mode, 'family');
const rejected = resolveAudioSelection(profile('mx5', 'i4', [unapprovedI4.id]), banks);
assert.equal(rejected.mode, 'procedural');
assert.deepEqual(rejected.rejectedBankIds, [unapprovedI4.id]);

// Until the detailed source profiles are deliberately adopted, every current
// six-car config must remain procedural-only instead of guessing by family.
for (const car of CARS) {
  const compatibilityProfile = resolveVehicleAudioProfile(car, { profiles: [] });
  assert.equal(compatibilityProfile.id, car.id);
  assert.equal(resolveAudioSelection(compatibilityProfile, banks).mode, 'procedural');
}

const events = [];
let failOnce = true;
const disposedBanks = [];
const coordinator = new AudioBankCoordinator({
  onEvent: (event) => events.push(event),
  loadBank: async (bank, { signal }) => {
    if (bank.id === approvedI4.id && failOnce) {
      failOnce = false;
      throw new Error('fixture HTTP 503');
    }
    if (signal.aborted) throw abortError();
    return {
      id: bank.id,
      dispose: () => disposedBanks.push(bank.id),
    };
  },
});

const i4Profile = profile('mx5', 'i4', [approvedI4.id]);
const failed = await coordinator.setProfile(i4Profile, banks);
assert.equal(failed.state, 'degraded');
assert.equal(failed.resolution.mode, 'procedural');
const retried = await coordinator.setProfile(i4Profile, banks);
assert.equal(retried.state, 'ready');
assert.equal(retried.activeBankId, approvedI4.id);

const missing = await coordinator.setProfile(profile('gt3rs', 'flat6'), banks);
assert.equal(missing.state, 'procedural');
assert.equal(missing.activeBankId, null);
assert.deepEqual(disposedBanks, [approvedI4.id]);

let slowSignal = null;
let releaseSlow;
const staleDisposals = [];
const switchCoordinator = new AudioBankCoordinator({
  loadBank: (bank, { signal }) => {
    if (bank.id === approvedI4.id) {
      slowSignal = signal;
      // Simulate decodeAudioData: it cannot be cancelled and completes later.
      return new Promise((resolve) => {
        releaseSlow = () => resolve({
          id: bank.id,
          dispose: () => staleDisposals.push(bank.id),
        });
      });
    }
    return Promise.resolve({ id: bank.id });
  },
});

const slow = switchCoordinator.setProfile(i4Profile, banks);
while (!releaseSlow) await sleep(0);
const fast = switchCoordinator.setProfile(profile('amggt3', 'v8', [approvedV8.id]), banks);
assert.equal(slowSignal.aborted, true);
releaseSlow();
const [slowResult, fastResult] = await Promise.all([slow, fast]);
assert.equal(slowResult.state, 'stale');
assert.equal(fastResult.state, 'ready');
assert.equal(switchCoordinator.snapshot().profileId, 'amggt3');
assert.equal(switchCoordinator.snapshot().activeBankId, approvedV8.id);
assert.deepEqual(staleDisposals, [approvedI4.id]);

const abortCoordinator = new AudioBankCoordinator({
  loadBank: (bank, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  }),
});
const pending = abortCoordinator.setProfile(i4Profile, banks);
await sleep(0);
abortCoordinator.dispose();
assert.equal((await pending).state, 'stale');
assert.equal(abortCoordinator.snapshot().state, 'disposed');

assert.ok(events.some((event) => event.type === 'bank-failed'));
assert.ok(events.some((event) => event.type === 'bank-published'));
console.log('Audio bank coordinator: eligibility, six-car fallback, retry, stale decode, abort, and dispose passed.');
