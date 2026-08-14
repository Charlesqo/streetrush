import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARS } from '../src/config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const salvageRoot = path.join(projectRoot, 'research-salvage');
const audioRoot = path.join(salvageRoot, 'audio');

async function readJson(...parts) {
  const text = await readFile(path.join(...parts), 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function parsePcmWav(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    assert.ok(end <= bytes.length, `${id} chunk stays inside WAV`);
    if (id === 'fmt ') {
      assert.ok(size >= 16, 'PCM fmt chunk has the base fields');
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = { start, size };
    }
    offset = end + (size % 2);
  }
  assert.ok(format, 'WAV has fmt chunk');
  assert.ok(data, 'WAV has data chunk');
  return { ...format, ...data };
}

const selection = await readJson(audioRoot, 'selection.json');
assert.equal(selection.schemaVersion, 1);
assert.equal(selection.status, 'prototype-reference-only');
assert.equal(selection.vehicles.length, CARS.length);
assert.deepEqual(
  [...selection.vehicles.map(({ vehicleId }) => vehicleId)].sort(),
  [...CARS.map(({ id }) => id)].sort(),
);

let wavCount = 0;
let wavBytes = 0;
for (const selected of selection.vehicles) {
  const config = CARS.find(({ id }) => id === selected.vehicleId);
  assert.ok(config, `${selected.vehicleId} maps to a game vehicle`);
  const candidateRoot = path.join(audioRoot, selected.directory);
  const [bank, analysis, loopAnalysis] = await Promise.all([
    readJson(candidateRoot, 'bank.json'),
    readJson(candidateRoot, 'analysis.json'),
    readJson(candidateRoot, 'loop-analysis.json'),
  ]);
  assert.equal(bank.schemaVersion, 2);
  assert.equal(bank.id, selected.bankId);
  assert.equal(bank.scope, 'family');
  assert.equal(bank.family, config.audio.family);
  assert.equal(bank.sampleRate, 44_100);
  assert.equal(bank.channels, 1);
  assert.equal(bank.format, 'PCM16-WAV');
  assert.equal(bank.quality, 'candidate-loop-approved');
  assert.equal(bank.loop?.loopApproved, true);
  assert.equal(bank.layers.length, 6);

  assert.equal(loopAnalysis.bankId, bank.id);
  assert.equal(loopAnalysis.status, 'approved');
  assert.equal(loopAnalysis.pass, true);
  assert.equal(loopAnalysis.layers.length, bank.layers.length);
  const loopLayers = new Map(loopAnalysis.layers.map((layer) => [layer.file, layer]));

  assert.equal(analysis.candidate, bank.id);
  assert.equal(analysis.cylinders, config.audio.cylinders, `${selected.vehicleId} analysis cylinders`);
  assert.equal(analysis.validation?.formatPass, true);
  assert.equal(analysis.validation?.clippingPass, true);
  assert.equal(analysis.validation?.nonSilencePass, true);
  assert.equal(analysis.validation?.sixLayerPass, true);
  assert.equal(analysis.validation?.loopPass, true);
  assert.equal(analysis.layers.length, bank.layers.length);
  const analysisLayers = new Map(analysis.layers.map((layer) => [layer.file, layer]));

  const rpmModes = new Map();
  for (const layer of bank.layers) {
    assert.ok(['on', 'off'].includes(layer.mode));
    assert.equal(layer.loop?.loopApproved, true);
    if (!rpmModes.has(layer.rpm)) rpmModes.set(layer.rpm, new Set());
    rpmModes.get(layer.rpm).add(layer.mode);

    const wav = await readFile(path.join(candidateRoot, layer.file));
    const parsed = parsePcmWav(wav);
    assert.deepEqual(
      {
        audioFormat: parsed.audioFormat,
        channels: parsed.channels,
        sampleRate: parsed.sampleRate,
        blockAlign: parsed.blockAlign,
        bitsPerSample: parsed.bitsPerSample,
      },
      { audioFormat: 1, channels: 1, sampleRate: 44_100, blockAlign: 2, bitsPerSample: 16 },
    );
    assert.equal(parsed.size % parsed.blockAlign, 0);
    const frames = parsed.size / parsed.blockAlign;
    assert.ok(Math.abs(frames / parsed.sampleRate - bank.durationSeconds) < 1 / parsed.sampleRate);
    let peak = 0;
    for (let offset = parsed.start; offset < parsed.start + parsed.size; offset += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    }
    assert.ok(peak > 0, `${bank.id}/${layer.file} is not silent`);
    assert.ok(peak < 32_767, `${bank.id}/${layer.file} has no full-scale sample`);

    const loopLayer = loopLayers.get(layer.file);
    assert.ok(loopLayer, `${layer.file} has loop analysis`);
    assert.equal(loopLayer.rpm, layer.rpm);
    assert.equal(loopLayer.mode, layer.mode);
    assert.equal(loopLayer.pass, true);
    assert.equal(loopLayer.seam?.sampleContinuityPass, true);
    assert.equal(loopLayer.seam?.slopeContinuityPass, true);
    assert.equal(createHash('sha256').update(wav).digest('hex'), loopLayer.preparedSha256);

    const analyzedLayer = analysisLayers.get(layer.file);
    assert.ok(analyzedLayer, `${layer.file} has format analysis`);
    assert.equal(analyzedLayer.decoded, true);
    assert.equal(analyzedLayer.sampleRate, 44_100);
    assert.equal(analyzedLayer.channels, 1);
    assert.equal(analyzedLayer.bitsPerSample, 16);
    assert.equal(analyzedLayer.frames, frames);
    assert.equal(analyzedLayer.seam?.loopApproved, true);
    const expectedFiringFrequency = layer.rpm / 60 * config.audio.cylinders / 2;
    assert.ok(
      Math.abs(analyzedLayer.expectedFiringFrequencyHz - expectedFiringFrequency) <= 0.0005,
      `${selected.vehicleId}/${layer.file} firing frequency matches ${config.audio.cylinders} cylinders`,
    );
    wavCount += 1;
    wavBytes += wav.length;
  }
  assert.equal(rpmModes.size, 3);
  for (const modes of rpmModes.values()) assert.deepEqual([...modes].sort(), ['off', 'on']);
}

assert.equal(wavCount, 36);

const projection = await readJson(salvageRoot, 'physics', 'selected-target-projection.json');
assert.equal(projection.schemaVersion, '1.0.0');
assert.equal(projection.profileCount, CARS.length);
assert.equal(projection.selectedFieldCount, 21);
assert.deepEqual(
  [...projection.vehicles.map(({ vehicleId }) => vehicleId)].sort(),
  [...CARS.map(({ id }) => id)].sort(),
);
assert.equal(projection.vehicles.reduce((sum, vehicle) => sum + vehicle.selectedFieldCount, 0), 21);
for (const vehicle of projection.vehicles) {
  assert.equal(vehicle.fields.length, vehicle.selectedFieldCount);
  for (const field of vehicle.fields) {
    assert.equal(field.vehicleId, vehicle.vehicleId);
    assert.equal(field.targetEligible, true);
    assert.equal(typeof field.modelInterface?.currentOwner, 'string');
  }
}

const spring = await readJson(salvageRoot, 'physics', 'mx5-na-spring-rate-derivation.json');
assert.equal(spring.vehicleId, 'mx5');
assert.match(spring.importantBoundary, /not factory force-displacement curves and not wheel rates/i);
for (const axle of ['front', 'rear']) {
  assert.ok(Number.isFinite(spring.results[axle].derivedCoilRateNPerM));
  assert.ok(spring.results[axle].boundedCoilRateNPerM.low > 0);
  assert.ok(spring.results[axle].boundedCoilRateNPerM.high >= spring.results[axle].boundedCoilRateNPerM.low);
}

console.log(`PASS research salvage vehicles=${CARS.length} banks=${selection.vehicles.length} wavs=${wavCount} bytes=${wavBytes}`);
console.log('PASS approved loop hashes/formats, 21 field-scoped physics inputs, and coil-rate boundary');
