import assert from 'node:assert/strict';

import { AudioBankCoordinator } from '../src/audio-bank-coordinator.js';
import { createDecodedAudioBankLoader } from '../src/audio-bank-loader.js';

const approvedLoop = {
  status: 'approved',
  loopApproved: true,
  loopStart: 0,
  loopEnd: 1,
};

const candidateBank = {
  id: 'bank.candidate.i4.fixture',
  scope: 'family',
  family: 'i4',
  quality: 'candidate-loop-approved',
  assetVersion: 'fixture-v1',
  rootUrl: '/candidate-audio/i4-fixture',
  manifestFile: 'bank.json',
};

function makeManifest(overrides = {}) {
  return {
    version: 'fixture-v1',
    id: candidateBank.id,
    family: 'i4',
    sampleRate: 44100,
    quality: 'candidate-loop-approved',
    loop: { ...approvedLoop },
    layers: [{
      rpm: 1800,
      load: 1,
      mode: 'on',
      file: '1800-on.wav',
      loop: { ...approvedLoop },
    }],
    ...overrides,
  };
}

function abortError() {
  const error = new Error('fixture fetch aborted');
  error.name = 'AbortError';
  return error;
}

function makeFetch({
  manifest = makeManifest(),
  manifestStatus = 200,
  manifestJsonError = null,
  layerStatus = 200,
  layerBytes = new Uint8Array([82, 73, 70, 70]).buffer,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, { signal } = {}) => {
    calls.push({ url: String(url), signal });
    if (signal?.aborted) throw abortError();
    if (String(url).includes('/bank.json')) {
      return {
        ok: manifestStatus >= 200 && manifestStatus < 300,
        status: manifestStatus,
        json: async () => {
          if (manifestJsonError) throw manifestJsonError;
          return structuredClone(manifest);
        },
      };
    }
    return {
      ok: layerStatus >= 200 && layerStatus < 300,
      status: layerStatus,
      arrayBuffer: async () => layerBytes.slice(0),
    };
  };
  return { calls, fetchImpl };
}

function makeContext({ decode = async (bytes) => ({ duration: 1, byteLength: bytes.byteLength }) } = {}) {
  return {
    sampleRate: 48000,
    decodeCalls: 0,
    async decodeAudioData(bytes) {
      this.decodeCalls += 1;
      return decode(bytes);
    },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

const successFetch = makeFetch();
const successContext = makeContext();
const successLoader = createDecodedAudioBankLoader({
  context: successContext,
  fetchImpl: successFetch.fetchImpl,
});
const loaded = await successLoader(candidateBank);
assert.equal(loaded.id, candidateBank.id);
assert.equal(loaded.sampleRate, 48000);
assert.equal(loaded.layers.length, 1);
assert.equal(loaded.layers[0].file, '1800-on.wav');
assert.equal(successContext.decodeCalls, 1);
assert.deepEqual(
  successFetch.calls.map((call) => call.url),
  [
    '/candidate-audio/i4-fixture/bank.json?assetVersion=fixture-v1',
    '/candidate-audio/i4-fixture/1800-on.wav?assetVersion=fixture-v1',
  ],
);
assert.ok(successFetch.calls.every((call) => call.signal instanceof AbortSignal));
loaded.dispose();
loaded.dispose();
assert.equal(loaded.disposed, true);
assert.equal(loaded.layers.length, 0);

const failures = [
  ['manifest HTTP', makeFetch({ manifestStatus: 503 }), makeContext(), 'manifest-http'],
  ['manifest JSON', makeFetch({ manifestJsonError: new SyntaxError('bad JSON') }), makeContext(), 'manifest-json'],
  ['empty layers', makeFetch({ manifest: makeManifest({ layers: [] }) }), makeContext(), 'manifest-layers-empty'],
  ['candidate quality', makeFetch({ manifest: makeManifest({ quality: 'candidate-unapproved' }) }), makeContext(), 'candidate-loop-unapproved'],
  ['candidate bank loop', makeFetch({ manifest: makeManifest({ loop: { status: 'unapproved', loopApproved: false } }) }), makeContext(), 'candidate-loop-unapproved'],
  ['candidate layer loop', makeFetch({ manifest: makeManifest({ layers: [{
    rpm: 1800,
    load: 1,
    mode: 'on',
    file: '1800-on.wav',
    loop: { status: 'unapproved', loopApproved: false },
  }] }) }), makeContext(), 'candidate-layer-loop-unapproved'],
  ['invalid layer', makeFetch({ manifest: makeManifest({ layers: [{ rpm: 0, mode: 'on', file: '' }] }) }), makeContext(), 'layer-invalid'],
  ['layer HTTP', makeFetch({ layerStatus: 404 }), makeContext(), 'layer-http'],
  ['decode', makeFetch(), makeContext({ decode: async () => { throw new Error('decode failed'); } }), 'layer-decode'],
];

for (const [label, fixture, context, code] of failures) {
  const loader = createDecodedAudioBankLoader({ context, fetchImpl: fixture.fetchImpl });
  await expectCode(loader(candidateBank), code);
  if (label.includes('loop') || label === 'empty layers' || label === 'invalid layer') {
    assert.equal(fixture.calls.length, 1, `${label} must fail before fetching WAV bytes`);
    assert.equal(context.decodeCalls, 0, `${label} must fail before decode`);
  }
}

// Prototype/source banks remain valid without candidate-only loop metadata.
const prototypeBank = {
  id: 'bank.source.engine-sim.v8',
  scope: 'family',
  family: 'v8',
  quality: 'prototype',
  assetVersion: 'source-v1',
  rootUrl: '/audio/engine-sim/v8',
};
const prototypeFetch = makeFetch({
  manifest: {
    version: 1,
    family: 'v8',
    layers: [{ rpm: 1800, load: 1, mode: 'on', file: '1800-on.wav' }],
  },
});
const prototypeLoaded = await createDecodedAudioBankLoader({
  context: makeContext(),
  fetchImpl: prototypeFetch.fetchImpl,
})(prototypeBank);
assert.equal(prototypeLoaded.layers.length, 1);

// Abort before fetch and after an uncancellable decode must have the same
// externally visible AbortError and must never return a decoded bank.
const preAbort = new AbortController();
preAbort.abort();
const preAbortFetch = makeFetch();
await assert.rejects(
  createDecodedAudioBankLoader({ context: makeContext(), fetchImpl: preAbortFetch.fetchImpl })(candidateBank, { signal: preAbort.signal }),
  (error) => error.name === 'AbortError' && error.code === 'audio-bank-aborted',
);
assert.equal(preAbortFetch.calls.length, 0);

let finishDecode;
const postAbort = new AbortController();
const postAbortFetch = makeFetch();
const postAbortLoader = createDecodedAudioBankLoader({
  context: makeContext({
    decode: () => new Promise((resolve) => {
      finishDecode = resolve;
    }),
  }),
  fetchImpl: postAbortFetch.fetchImpl,
});
const postAbortPromise = postAbortLoader(candidateBank, { signal: postAbort.signal });
while (!finishDecode) await new Promise((resolve) => setTimeout(resolve, 0));
postAbort.abort();
finishDecode({ duration: 1 });
await assert.rejects(
  postAbortPromise,
  (error) => error.name === 'AbortError' && error.code === 'audio-bank-aborted',
);

// Exercise the real boundary: coordinator owns publication; loader owns
// fetch/decode validation and the active value's reference release.
const integratedFetch = makeFetch();
const integratedLoader = createDecodedAudioBankLoader({
  context: makeContext(),
  fetchImpl: integratedFetch.fetchImpl,
});
const coordinator = new AudioBankCoordinator({ loadBank: integratedLoader });
const profile = {
  id: 'mx5',
  engine: { family: 'i4' },
  audio: { familyFallbackBankIds: [candidateBank.id], proceduralFallback: true },
};
assert.equal((await coordinator.setProfile(profile, { banks: [candidateBank] })).state, 'ready');
const activeValue = coordinator.active.value;
assert.equal((await coordinator.setProfile({
  id: 'gt3rs',
  engine: { family: 'flat6' },
  audio: { familyFallbackBankIds: [], proceduralFallback: true },
}, { banks: [candidateBank] })).state, 'procedural');
assert.equal(activeValue.disposed, true);
assert.equal(activeValue.layers.length, 0);

console.log('Audio bank loader: strict manifest, candidate loop gates, decode, abort, and coordinator release passed.');
