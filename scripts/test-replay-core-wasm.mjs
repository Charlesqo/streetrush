import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  REPLAY_DIGEST_OFFSET_BASIS as OFFSET_BASIS,
  REPLAY_FORMAT_VERSION as FORMAT_VERSION,
  REPLAY_QUANTUM as QUANTUM,
  asU64,
  canonicalBits,
  digest,
  numberFromBits,
  pushDigest,
  quantize,
} from './replay-digest-oracle.mjs';

function assertSameNumber(actual, expected, label) {
  if (Number.isNaN(expected)) {
    assert.ok(Number.isNaN(actual), label);
  } else {
    assert.ok(Object.is(actual, expected), `${label}: expected ${expected}, got ${actual}`);
  }
}

const wasmPath = fileURLToPath(new URL('../src/generated/streetrush_core.wasm', import.meta.url));
const wasmBytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes);
const core = instance.exports;

for (const name of [
  'streetrush_replay_format_version',
  'streetrush_replay_quantum',
  'streetrush_replay_digest_offset_basis',
  'streetrush_replay_canonical_f64_bits',
  'streetrush_quantize_replay_value',
  'streetrush_replay_digest_push_f64',
]) {
  assert.equal(typeof core[name], 'function', `missing replay export ${name}`);
}

assert.equal(core.streetrush_replay_format_version(), FORMAT_VERSION);
assert.equal(core.streetrush_replay_quantum(), QUANTUM);
assert.equal(asU64(core.streetrush_replay_digest_offset_basis()), OFFSET_BASIS);

const nanPayloads = [
  numberFromBits(0x7ff0000000000001n),
  numberFromBits(0xfff8123456789abcn),
];
const values = [
  0,
  -0,
  1.5,
  -1.5,
  QUANTUM / 2,
  -QUANTUM / 2,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Infinity,
  -Infinity,
  ...nanPayloads,
];

for (const [index, value] of values.entries()) {
  assert.equal(
    asU64(core.streetrush_replay_canonical_f64_bits(value)),
    canonicalBits(value),
    `canonical bits ${index}`,
  );
  assertSameNumber(
    core.streetrush_quantize_replay_value(value, QUANTUM),
    quantize(value, QUANTUM),
    `quantized value ${index}`,
  );
}

for (const [index, [value, quantum]] of [
  [12.5, 0],
  [12.5, -1],
  [12.5, Infinity],
  [12.5, NaN],
  [Number.MAX_VALUE, Number.MIN_VALUE],
  [Number.MIN_VALUE, Number.MAX_VALUE],
  [-Number.MIN_VALUE, Number.MAX_VALUE],
].entries()) {
  assertSameNumber(
    core.streetrush_quantize_replay_value(value, quantum),
    quantize(value, quantum),
    `quantization boundary ${index}`,
  );
}

let wasmExact = OFFSET_BASIS;
let wasmQuantized = OFFSET_BASIS;
for (const value of values) {
  wasmExact = asU64(core.streetrush_replay_digest_push_f64(wasmExact, value));
  wasmQuantized = asU64(core.streetrush_replay_digest_push_f64(
    wasmQuantized,
    core.streetrush_quantize_replay_value(value, QUANTUM),
  ));
}

const jsExact = digest(values, false);
const jsQuantized = digest(values, true);
assert.equal(jsExact, 0x0248d9354f126505n);
assert.equal(jsQuantized, 0x0603ecb87904c881n);
assert.equal(wasmExact, jsExact);
assert.equal(wasmQuantized, jsQuantized);

console.log(`PASS Rust WASM replay format ${FORMAT_VERSION} matches independent JS numeric oracle`);
console.log(`PASS canonical exact=${jsExact.toString(16).padStart(16, '0')} quantized=${jsQuantized.toString(16).padStart(16, '0')}`);
