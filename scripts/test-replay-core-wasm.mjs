import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FORMAT_VERSION = 1;
const QUANTUM = 1e-6;
const OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const CANONICAL_NAN_BITS = 0x7ff8000000000000n;
const U64_MASK = 0xffffffffffffffffn;

const bytes = new ArrayBuffer(8);
const view = new DataView(bytes);

function numberFromBits(bits) {
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function canonicalBits(value) {
  if (Number.isNaN(value)) return CANONICAL_NAN_BITS;
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

function quantize(value, quantum) {
  if (!Number.isFinite(value) || !Number.isFinite(quantum) || quantum <= 0) {
    return value;
  }
  const scaled = value / quantum;
  if (!Number.isFinite(scaled)) return value;
  const result = Math.round(scaled) * quantum;
  return Number.isFinite(result) ? result : value;
}

function pushDigest(state, value) {
  let next = state;
  const bits = canonicalBits(value);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    next ^= (bits >> shift) & 0xffn;
    next = (next * FNV_PRIME) & U64_MASK;
  }
  return next;
}

function digest(values, shouldQuantize) {
  return values.reduce(
    (state, value) => pushDigest(
      state,
      shouldQuantize ? quantize(value, QUANTUM) : value,
    ),
    OFFSET_BASIS,
  );
}

function asU64(value) {
  return BigInt.asUintN(64, value);
}

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
