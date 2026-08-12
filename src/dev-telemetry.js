const FORMAT_VERSION = 1;
const DEFAULT_CAPACITY = 256;

function requireCapacity(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('capacity must be a non-negative integer');
  }
  return value;
}

function cloneSerializableEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('event must be a non-null object');
  }

  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw new TypeError('event must be JSON-serializable');
  }
  let copy;
  try {
    copy = JSON.parse(serialized);
  } catch {
    throw new TypeError('event must be JSON-serializable');
  }
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new TypeError('event must serialize to an object');
  }
  return copy;
}

/**
 * Pure in-memory event storage for development telemetry and replay capture.
 * It is intentionally not connected to the production race loop, browser
 * storage, a clock, or a network transport. Callers can include their own
 * deterministic timestamp/frame fields in each event.
 */
export class DevTelemetryBuffer {
  #capacity;

  #events = [];

  #dropped = 0;

  constructor({ capacity = DEFAULT_CAPACITY } = {}) {
    this.#capacity = requireCapacity(capacity);
  }

  /**
   * Store one event and keep the newest `capacity` events when full.
   * Returns false when capacity is zero; otherwise returns true.
   */
  record(event) {
    const copy = cloneSerializableEvent(event);
    if (this.#capacity === 0) {
      this.#dropped += 1;
      return false;
    }

    if (this.#events.length >= this.#capacity) {
      this.#events.shift();
      this.#dropped += 1;
    }
    this.#events.push(copy);
    return true;
  }

  /** Return an isolated, JSON-compatible view of the current buffer. */
  snapshot() {
    return {
      version: FORMAT_VERSION,
      capacity: this.#capacity,
      size: this.#events.length,
      dropped: this.#dropped,
      events: JSON.parse(JSON.stringify(this.#events)),
    };
  }

  /** Remove captured events and reset the overflow count. */
  clear() {
    this.#events.length = 0;
    this.#dropped = 0;
  }

  /** Serialize the same stable shape returned by snapshot(). */
  serialize() {
    return JSON.stringify(this.snapshot());
  }
}
