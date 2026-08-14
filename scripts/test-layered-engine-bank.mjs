import assert from 'node:assert/strict';

import { LayeredEngineBankPlayer } from '../src/layered-engine-bank.js';
import { FakeAudioContext, FakeAudioNode } from './audio-test-harness.mjs';

const approvedLoop = {
  status: 'approved',
  loopApproved: true,
  loopStart: 0,
  loopEnd: 2.5,
};

function makeBank(overrides = {}) {
  const layers = [];
  for (const rpm of [1800, 4200, 6800]) {
    for (const mode of ['off', 'on']) {
      layers.push({
        rpm,
        mode,
        file: `${rpm}-${mode}.wav`,
        loop: { ...approvedLoop },
        buffer: { duration: 2.5 },
      });
    }
  }
  return {
    id: 'bank.candidate.i4.fixture',
    family: 'i4',
    quality: 'candidate-loop-approved',
    loop: { ...approvedLoop },
    layers,
    ...overrides,
  };
}

const context = new FakeAudioContext();
context.currentTime = 4;
const destination = new FakeAudioNode();
const player = new LayeredEngineBankPlayer({ context, destination });
assert.equal(player.snapshot().state, 'empty');
assert.equal(player.bus.connections[0], destination);

const bank = makeBank();
assert.equal(player.attach(bank).layerCount, 6);
assert.equal(context.createdBufferSources.length, 6);
for (const source of context.createdBufferSources) {
  assert.equal(source.startCalls, 1);
  assert.equal(source.loop, true);
  assert.equal(source.loopStart, 0);
  assert.equal(source.loopEnd, 2.5);
}

let snapshot = player.update({ rpm: 4200, load: 1 });
assert.equal(snapshot.activeLayerCount, 1);
const middleOn = player.bank.layers.find((layer) => layer.rpm === 4200 && layer.mode === 'on');
const middleOff = player.bank.layers.find((layer) => layer.rpm === 4200 && layer.mode === 'off');
assert.equal(middleOn.gain.gain.value, 0.72);
assert.equal(middleOff.gain.gain.value, 0);
assert.equal(middleOn.source.playbackRate.value, 1);

snapshot = player.update({ rpm: 3000, load: 0.25 });
assert.equal(snapshot.activeLayerCount, 4);
const lowOn = player.bank.layers.find((layer) => layer.rpm === 1800 && layer.mode === 'on');
const lowOff = player.bank.layers.find((layer) => layer.rpm === 1800 && layer.mode === 'off');
const highOn = player.bank.layers.find((layer) => layer.rpm === 4200 && layer.mode === 'on');
assert.ok(lowOn.gain.gain.value > 0);
assert.ok(lowOff.gain.gain.value > lowOn.gain.gain.value);
assert.ok(highOn.gain.gain.value > 0);
assert.equal(lowOn.source.playbackRate.value, 1.55);

player.setEnabled(false);
assert.equal(player.bus.gain.value, 0.0001);
assert.equal(player.snapshot().activeLayerCount, 0);
player.setEnabled(true);
assert.equal(player.bus.gain.value, 1);

const firstSources = [...context.createdBufferSources];
player.attach(makeBank({ id: 'bank.candidate.i4.replacement' }));
for (const source of firstSources) {
  assert.equal(source.stopCalls, 1);
  assert.equal(source.disconnectCalls, 1);
}
assert.equal(player.snapshot().bankId, 'bank.candidate.i4.replacement');

assert.throws(
  () => player.attach(makeBank({ loop: { status: 'unapproved', loopApproved: false } })),
  /bank loop is not approved/,
);
assert.equal(player.snapshot().bankId, 'bank.candidate.i4.replacement', 'failed validation is atomic');

const replacementSources = context.createdBufferSources.slice(6);
player.dispose();
player.dispose();
for (const source of replacementSources) assert.equal(source.stopCalls, 1);
assert.deepEqual(player.snapshot(), {
  state: 'disposed', bankId: null, layerCount: 0, activeLayerCount: 0, enabled: true,
});

console.log('PASS layered engine bank attach, RPM/load blend, mute, replacement, atomic validation, and dispose');
