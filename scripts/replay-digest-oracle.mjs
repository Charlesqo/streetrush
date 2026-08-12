export const REPLAY_FORMAT_VERSION = 1;
export const REPLAY_QUANTUM = 1e-6;
export const REPLAY_DIGEST_OFFSET_BASIS = 0xcbf29ce484222325n;
export const REPLAY_DIGEST_ALGORITHM = 'fnv1a64-canonical-f64-be';

const FNV_PRIME = 0x100000001b3n;
const CANONICAL_NAN_BITS = 0x7ff8000000000000n;
const U64_MASK = 0xffffffffffffffffn;
const bytes = new ArrayBuffer(8);
const view = new DataView(bytes);

export function numberFromBits(bits) {
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

export function canonicalBits(value) {
  if (Number.isNaN(value)) return CANONICAL_NAN_BITS;
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

export function quantize(value, quantum = REPLAY_QUANTUM) {
  if (!Number.isFinite(value) || !Number.isFinite(quantum) || quantum <= 0) {
    return value;
  }
  const scaled = value / quantum;
  if (!Number.isFinite(scaled)) return value;
  const result = Math.round(scaled) * quantum;
  return Number.isFinite(result) ? result : value;
}

export function pushDigest(state, value) {
  let next = state;
  const bits = canonicalBits(value);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    next ^= (bits >> shift) & 0xffn;
    next = (next * FNV_PRIME) & U64_MASK;
  }
  return next;
}

export function digest(values, shouldQuantize = false) {
  return values.reduce(
    (state, value) => pushDigest(
      state,
      shouldQuantize ? quantize(value) : value,
    ),
    REPLAY_DIGEST_OFFSET_BASIS,
  );
}

export function asU64(value) {
  return BigInt.asUintN(64, value);
}

export function digestHex(value) {
  return asU64(value).toString(16).padStart(16, '0');
}
