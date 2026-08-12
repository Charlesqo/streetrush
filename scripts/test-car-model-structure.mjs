import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARS } from '../src/config.js';
import { analyzeCarModel } from './car-model-structure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'data', 'car-model-structure-baseline.json');
const RESEARCH_ORACLE = {
  mx5: { sha256: 'a17b3b9edc0997ba77837ae4358e3dfe7b7aa7f59364d7c15b6fb01a3452d26b', relationship: 'public-byte-identical' },
  m3e30: { sha256: '4af350460ea34b7901c8512adafd2c04faa632629ab6b2bcbbbb48694f902738', relationship: 'public-byte-identical' },
  gt3rs: { sha256: 'e1cf7d3e04aaaf27cfec6363de5f6427b87c997993f9de0f54ec5549b68b8f96', relationship: 'public-byte-identical' },
  lp700: { sha256: '6489a80970e15eaa4dcc9aab7e2f43f8f9021bfc15cd9d1081563540f8c85d8a', relationship: 'public-byte-identical' },
  amggt3: { sha256: '649ec8573d8c26311fed80f3ca3ada6d6e0e39e458fca7f93552cfcd3a027451', relationship: 'public-optimized-derivative-of-source-model' },
  m5g90: { sha256: 'd6b0b22a1eb4547dbabad925e565a590b2a109c4770358a0ef913328cf68c9b5', relationship: 'public-optimized-derivative-of-source-model' },
};

const candidate = {
  formatVersion: 1,
  measurement: 'default-scene accessor bounds transformed by static node TRS; no skin, morph, or animation evaluation',
  researchRoot: 'E:/Codex/autonomous_runs/multi_car_model_research',
  models: [],
};

for (const config of CARS) {
  const researchOracle = RESEARCH_ORACLE[config.id];
  candidate.models.push(await analyzeCarModel({
    filePath: path.join(root, 'public', 'cars', config.file),
    file: `public/cars/${config.file}`,
    config,
    researchSha256: researchOracle.sha256,
    researchRelationship: researchOracle.relationship,
  }));
}

if (process.argv.includes('--print')) {
  process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
assert.deepEqual(candidate, baseline);
const exactResearchMatches = candidate.models.filter((model) => model.researchOracle.exactByteMatch).length;
const wheelNamed = candidate.models.filter((model) => model.wheelCandidates.count > 0).length;
console.log(`PASS car model structure cars=${candidate.models.length} researchExact=${exactResearchMatches} wheelNamed=${wheelNamed}`);
console.log('PASS GLB hashes, static bounds, structure, candidate names, and production normalization match baseline');
