import assert from 'node:assert/strict';
import { DevTelemetryBuffer } from '../src/dev-telemetry.js';

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

test('records ordered events without retaining caller references', () => {
  const buffer = new DevTelemetryBuffer({ capacity: 2 });
  const event = {
    type: 'run-started',
    frame: 12,
    snapshot: { status: 'running' },
  };

  assert.equal(buffer.record(event), true);
  event.snapshot.status = 'mutated-after-record';

  const snapshot = buffer.snapshot();
  assert.deepEqual(snapshot.events, [{
    type: 'run-started',
    frame: 12,
    snapshot: { status: 'running' },
  }]);

  snapshot.events[0].snapshot.status = 'mutated-after-snapshot';
  assert.equal(buffer.snapshot().events[0].snapshot.status, 'running');
});

test('keeps the newest events at capacity and reports overflow', () => {
  const buffer = new DevTelemetryBuffer({ capacity: 2 });
  buffer.record({ type: 'run-started', frame: 1 });
  buffer.record({ type: 'checkpoint-completed', frame: 2 });
  buffer.record({ type: 'run-completed', frame: 3 });

  assert.deepEqual(buffer.snapshot(), {
    version: 1,
    capacity: 2,
    size: 2,
    dropped: 1,
    events: [
      { type: 'checkpoint-completed', frame: 2 },
      { type: 'run-completed', frame: 3 },
    ],
  });
});

test('serializes the snapshot as valid JSON', () => {
  const buffer = new DevTelemetryBuffer({ capacity: 3 });
  buffer.record({ type: 'sector-completed', timeMs: 1234 });

  assert.deepEqual(JSON.parse(buffer.serialize()), buffer.snapshot());
});

test('clear removes events and resets the dropped count', () => {
  const buffer = new DevTelemetryBuffer({ capacity: 1 });
  buffer.record({ type: 'first' });
  buffer.record({ type: 'second' });
  buffer.clear();

  assert.deepEqual(buffer.snapshot(), {
    version: 1,
    capacity: 1,
    size: 0,
    dropped: 0,
    events: [],
  });
});

test('supports a zero-capacity buffer and validates inputs', () => {
  const buffer = new DevTelemetryBuffer({ capacity: 0 });
  assert.equal(buffer.record({ type: 'discarded' }), false);
  assert.deepEqual(buffer.snapshot(), {
    version: 1,
    capacity: 0,
    size: 0,
    dropped: 1,
    events: [],
  });

  assert.throws(() => new DevTelemetryBuffer({ capacity: -1 }), /non-negative integer/);
  assert.throws(() => new DevTelemetryBuffer({ capacity: 1.5 }), /non-negative integer/);
  assert.throws(() => new DevTelemetryBuffer({ capacity: Number.MAX_SAFE_INTEGER + 1 }), /non-negative integer/);
  assert.throws(() => buffer.record(null), /non-null object/);
  assert.throws(() => buffer.record([]), /non-null object/);
  assert.throws(() => buffer.record({ toJSON: () => 42 }), /serialize to an object/);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => buffer.record(cyclic), /JSON-serializable/);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${tests.length} dev telemetry tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS ${tests.length} dev telemetry tests`);
}
