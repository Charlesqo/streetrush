import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAudioSelection } from '../src/audio-bank-coordinator.js';
import {
  createGameAudioProfile,
  GAME_AUDIO_BANK_IDS,
  GAME_AUDIO_BANKS,
} from '../src/game-audio-banks.js';
import { CARS } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selectionPath = path.join(root, 'research-salvage', 'audio', 'selection.json');
const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
const selectedByVehicle = new Map(selection.vehicles.map((entry) => [entry.vehicleId, entry]));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

assert.equal(CARS.length, 6);
assert.equal(GAME_AUDIO_BANKS.banks.length, CARS.length);
assert.deepEqual(Object.keys(GAME_AUDIO_BANK_IDS).sort(), CARS.map(({ id }) => id).sort());

let copiedFileCount = 0;
let copiedByteCount = 0;
for (const car of CARS) {
  const selected = selectedByVehicle.get(car.id);
  assert.ok(selected, `${car.id} has a salvage selection`);
  assert.equal(GAME_AUDIO_BANK_IDS[car.id], selected.bankId);

  const profile = createGameAudioProfile(car);
  const resolution = resolveAudioSelection(profile, GAME_AUDIO_BANKS);
  assert.equal(resolution.mode, 'family', `${car.id} uses an explicit candidate family bank`);
  assert.equal(resolution.bank.id, selected.bankId);
  assert.equal(resolution.bank.family, car.audio.family);

  const productionRoot = path.join(root, 'public', 'audio-banks', car.id);
  const archiveRoot = path.join(root, 'research-salvage', 'audio', selected.directory);
  const productionNames = (await readdir(productionRoot)).sort();
  const archiveNames = (await readdir(archiveRoot))
    .filter((name) => name === 'bank.json' || name.endsWith('.wav'))
    .sort();
  assert.deepEqual(productionNames, archiveNames, `${car.id} production bank copies only runtime files`);

  const manifest = JSON.parse(await readFile(path.join(productionRoot, 'bank.json'), 'utf8'));
  assert.equal(manifest.id, resolution.bank.id);
  assert.equal(manifest.family, resolution.bank.family);
  assert.equal(manifest.version, resolution.bank.assetVersion);
  assert.equal(manifest.quality, resolution.bank.quality);
  assert.equal(manifest.layers.length, 6);

  for (const name of productionNames) {
    const productionBytes = await readFile(path.join(productionRoot, name));
    const archiveBytes = await readFile(path.join(archiveRoot, name));
    assert.equal(sha256(productionBytes), sha256(archiveBytes), `${car.id}/${name} archive hash`);
    copiedFileCount += 1;
    copiedByteCount += productionBytes.length;
  }
}

assert.equal(copiedFileCount, 42);
console.log(`PASS production audio banks cars=6 files=${copiedFileCount} bytes=${copiedByteCount}`);
