//! Canonical numeric encoding shared by telemetry and deterministic replays.

/// Version of the byte-level replay contract.
pub const REPLAY_FORMAT_VERSION: u32 = 1;

/// Default resolution used by the existing JavaScript replay baseline.
pub const REPLAY_QUANTUM: f64 = 1.0e-6;

/// FNV-1a offset basis used to start a replay digest.
pub const REPLAY_DIGEST_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;

const REPLAY_DIGEST_PRIME: u64 = 0x0000_0100_0000_01b3;
const CANONICAL_NAN_BITS: u64 = 0x7ff8_0000_0000_0000;
const FIRST_NON_CONSECUTIVE_INTEGER: f64 = 4_503_599_627_370_496.0;

/// Return the stable IEEE-754 representation used by the replay format.
///
/// All NaN payloads collapse to one quiet NaN. Signed zero and infinities are
/// deliberately preserved because the JavaScript baseline hashes their raw
/// `Float64` representations.
#[must_use]
pub fn canonical_f64_bits(value: f64) -> u64 {
    if value.is_nan() {
        CANONICAL_NAN_BITS
    } else {
        value.to_bits()
    }
}

/// Quantize a value with JavaScript `Math.round` tie and signed-zero semantics.
///
/// Invalid inputs and finite values whose scaling would overflow are returned
/// unchanged. This keeps the boundary total and prevents extreme telemetry
/// from becoming an infinity merely because quantization was requested.
#[must_use]
pub fn quantize_replay_value(value: f64, quantum: f64) -> f64 {
    if !value.is_finite() || !quantum.is_finite() || quantum <= 0.0 {
        return value;
    }

    let scaled = value / quantum;
    if !scaled.is_finite() {
        return value;
    }
    if scaled == 0.0 {
        return scaled;
    }

    let rounded = if scaled.abs() >= FIRST_NON_CONSECUTIVE_INTEGER {
        scaled
    } else {
        let lower = scaled.floor();
        if scaled - lower < 0.5 {
            lower
        } else {
            lower + 1.0
        }
    };

    if rounded == 0.0 && scaled.is_sign_negative() {
        return -0.0;
    }

    let result = rounded * quantum;
    if result.is_finite() { result } else { value }
}

/// Add one canonical big-endian `f64` to a stateless FNV-1a digest.
#[must_use]
pub fn replay_digest_push_f64(mut state: u64, value: f64) -> u64 {
    for byte in canonical_f64_bits(value).to_be_bytes() {
        state ^= u64::from(byte);
        state = state.wrapping_mul(REPLAY_DIGEST_PRIME);
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_same_bits(actual: f64, expected: f64) {
        assert_eq!(actual.to_bits(), expected.to_bits());
    }

    #[test]
    fn canonicalizes_nan_payloads() {
        let positive = f64::from_bits(0x7ff0_0000_0000_0001);
        let negative = f64::from_bits(0xfff8_1234_5678_9abc);

        assert_eq!(canonical_f64_bits(positive), CANONICAL_NAN_BITS);
        assert_eq!(canonical_f64_bits(negative), CANONICAL_NAN_BITS);
    }

    #[test]
    fn preserves_signed_zero_and_infinities() {
        assert_eq!(canonical_f64_bits(0.0), 0x0000_0000_0000_0000);
        assert_eq!(canonical_f64_bits(-0.0), 0x8000_0000_0000_0000);
        assert_eq!(canonical_f64_bits(f64::INFINITY), 0x7ff0_0000_0000_0000);
        assert_eq!(canonical_f64_bits(f64::NEG_INFINITY), 0xfff0_0000_0000_0000);
    }

    #[test]
    fn quantizes_with_javascript_rounding_semantics() {
        assert_same_bits(quantize_replay_value(1.5, 1.0), 2.0);
        assert_same_bits(quantize_replay_value(-1.5, 1.0), -1.0);
        assert_same_bits(quantize_replay_value(-0.6, 1.0), -1.0);

        let negative_half = quantize_replay_value(-0.5, 1.0);
        assert_eq!(negative_half.to_bits(), (-0.0_f64).to_bits());

        let negative_fraction = quantize_replay_value(-0.1, 1.0);
        assert_eq!(negative_fraction.to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn leaves_invalid_or_unrepresentable_quantization_unchanged() {
        assert_same_bits(quantize_replay_value(f64::MAX, f64::MIN_POSITIVE), f64::MAX);
        assert_same_bits(quantize_replay_value(12.5, 0.0), 12.5);
        assert_same_bits(quantize_replay_value(12.5, f64::INFINITY), 12.5);
        assert!(quantize_replay_value(f64::NAN, REPLAY_QUANTUM).is_nan());
        assert_same_bits(
            quantize_replay_value(f64::NEG_INFINITY, REPLAY_QUANTUM),
            f64::NEG_INFINITY,
        );
    }

    #[test]
    fn quantization_underflow_becomes_signed_zero() {
        assert_eq!(
            quantize_replay_value(f64::MIN_POSITIVE, f64::MAX).to_bits(),
            0.0_f64.to_bits()
        );
        assert_eq!(
            quantize_replay_value(-f64::MIN_POSITIVE, f64::MAX).to_bits(),
            (-0.0_f64).to_bits()
        );
    }

    #[test]
    fn hashes_canonical_big_endian_bytes() {
        let positive_zero = replay_digest_push_f64(REPLAY_DIGEST_OFFSET_BASIS, 0.0);
        let negative_zero = replay_digest_push_f64(REPLAY_DIGEST_OFFSET_BASIS, -0.0);

        assert_eq!(positive_zero, 0xa8c7_f832_281a_39c5);
        assert_eq!(negative_zero, 0x262b_7cb7_9fbf_4a45);
        assert_ne!(positive_zero, negative_zero);
    }

    #[test]
    fn digest_collapses_nan_payloads() {
        let first = replay_digest_push_f64(
            REPLAY_DIGEST_OFFSET_BASIS,
            f64::from_bits(0x7ff0_0000_0000_0001),
        );
        let second = replay_digest_push_f64(
            REPLAY_DIGEST_OFFSET_BASIS,
            f64::from_bits(0xfff8_1234_5678_9abc),
        );

        assert_eq!(first, second);
    }
}
