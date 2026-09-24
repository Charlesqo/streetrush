import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CARS, FIXED_DT } from '../src/config.js';
import { createVehicleRig, destroyVehicleRig, zeroInput } from './physics-harness.mjs';
import {
  REPLAY_DIGEST_ALGORITHM,
  REPLAY_DIGEST_OFFSET_BASIS,
  REPLAY_FORMAT_VERSION,
  REPLAY_QUANTUM,
  asU64,
  digestHex,
  pushDigest,
  quantize,
} from './replay-digest-oracle.mjs';

const FORMAT_VERSION = 2;
const QUANTIZATION = 1e-6;
const REPEATS = 3;
const baselineUrl = new URL('../data/vehicle-replay-baseline.json', import.meta.url);
const fnvBaselineUrl = new URL('../data/vehicle-replay-fnv-baseline.json', import.meta.url);
const wasmUrl = new URL('../src/generated/streetrush_core.wasm', import.meta.url);

async function loadReplayCore(location = wasmUrl) {
  let wasmBytes;
  try {
    wasmBytes = await readFile(location);
  } catch (error) {
    throw new Error('Replay core WASM is required; run pnpm build:core-wasm first', { cause: error });
  }
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const core = instance.exports;
  for (const name of [
    'streetrush_replay_format_version',
    'streetrush_replay_quantum',
    'streetrush_replay_digest_offset_basis',
    'streetrush_quantize_replay_value',
    'streetrush_replay_digest_push_f64',
  ]) {
    assert.equal(typeof core[name], 'function', `missing replay export ${name}`);
  }
  assert.equal(core.streetrush_replay_format_version(), REPLAY_FORMAT_VERSION);
  assert.equal(core.streetrush_replay_quantum(), REPLAY_QUANTUM);
  assert.equal(
    asU64(core.streetrush_replay_digest_offset_basis()),
    REPLAY_DIGEST_OFFSET_BASIS,
  );
  return core;
}

await assert.rejects(
  () => loadReplayCore(new URL('../src/generated/__missing__/streetrush_core.wasm', import.meta.url)),
  { message: 'Replay core WASM is required; run pnpm build:core-wasm first' },
);
const replayCore = await loadReplayCore();

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function piecewiseSeededInputs({ seed, ticks, resetTicks = [] }) {
  const random = xorshift32(seed);
  const resetSet = new Set(resetTicks);
  const phases = Array.from({ length: Math.ceil(ticks / 30) }, () => ({
    throttle: 0.28 + random() * 0.68,
    steer: (random() * 2 - 1) * 0.42,
    handbrake: random() > 0.94 ? 0.45 : 0,
  }));
  return Array.from({ length: ticks }, (_, tick) => {
    const phase = phases[Math.floor(tick / 30)];
    return zeroInput({
      throttle: phase.throttle,
      steer: phase.steer,
      handbrake: phase.handbrake,
      driveIntent: 1,
      reset: resetSet.has(tick),
    });
  });
}

function shiftDirectionInputs({ seed, ticks }) {
  const random = xorshift32(seed);
  const steerPhases = Array.from({ length: Math.ceil(ticks / 40) }, () => (random() * 2 - 1) * 0.22);
  return Array.from({ length: ticks }, (_, tick) => {
    const forward = tick < 500;
    return zeroInput({
      toggleTransmission: tick === 0,
      shiftUp: tick === 180 || tick === 340,
      shiftDown: tick === 620,
      throttle: forward ? 0.82 : 0,
      brake: forward ? 0 : 0.78,
      driveIntent: forward ? 1 : -1,
      steer: steerPhases[Math.floor(tick / 40)],
      handbrake: tick >= 450 && tick < 475 ? 0.35 : 0,
    });
  });
}

const scenarios = [
  {
    id: 'seeded-steady-v1',
    seed: 0x5eed_0001,
    ticks: 720,
    inputs(options) {
      return piecewiseSeededInputs(options);
    },
  },
  {
    id: 'shift-direction-v1',
    seed: 0x5eed_0002,
    ticks: 960,
    inputs(options) {
      return shiftDirectionInputs(options);
    },
  },
  {
    id: 'reset-replay-v1',
    seed: 0x5eed_0003,
    ticks: 900,
    inputs(options) {
      return piecewiseSeededInputs({ ...options, resetTicks: [300, 600] });
    },
  },
];

const FRAME_FIELDS = [
  'body.translation.x', 'body.translation.y', 'body.translation.z',
  'body.rotation.x', 'body.rotation.y', 'body.rotation.z', 'body.rotation.w',
  'body.linvel.x', 'body.linvel.y', 'body.linvel.z',
  'body.angvel.x', 'body.angvel.y', 'body.angvel.z',
  'gear', 'reverse', 'transmissionMode', 'engineRpm', 'engineLoad', 'steerAngle',
  'safeSample', 'trackHint',
  ...Array.from({ length: 4 }, (_, index) => `wheel.${index}.omega`),
  'telemetry.speedKmh', 'telemetry.signedSpeedKmh', 'telemetry.rpm',
  'telemetry.longitudinalAcceleration', 'telemetry.lateralAcceleration',
  ...Array.from({ length: 4 }, (_, index) => [
    `telemetry.wheel.${index}.load`,
    `telemetry.wheel.${index}.suspension`,
    `telemetry.wheel.${index}.slipRatio`,
    `telemetry.wheel.${index}.slipAngle`,
    `telemetry.wheel.${index}.slipPower`,
  ]).flat(),
];

const INPUT_FIELDS = [
  'steer', 'throttle', 'brake', 'handbrake', 'directionConflict', 'shiftUp', 'shiftDown',
  'toggleTransmission', 'reset', 'driveIntent',
];

function captureInput(input) {
  return [
    input.steer,
    input.throttle,
    input.brake,
    input.handbrake,
    input.directionConflict ? 1 : 0,
    input.shiftUp ? 1 : 0,
    input.shiftDown ? 1 : 0,
    input.toggleTransmission ? 1 : 0,
    input.reset ? 1 : 0,
    input.driveIntent,
  ];
}

function captureFrame(vehicle) {
  const translation = vehicle.body.translation();
  const rotation = vehicle.body.rotation();
  const linvel = vehicle.body.linvel();
  const angvel = vehicle.body.angvel();
  return [
    translation.x, translation.y, translation.z,
    rotation.x, rotation.y, rotation.z, rotation.w,
    linvel.x, linvel.y, linvel.z,
    angvel.x, angvel.y, angvel.z,
    vehicle.gear,
    vehicle.reverse ? 1 : 0,
    vehicle.transmissionMode === 'MT' ? 1 : 0,
    vehicle.engineRpm,
    vehicle.engineLoad,
    vehicle.steerAngle,
    vehicle.safeSample,
    vehicle.trackHint,
    ...vehicle.wheels.map((wheel) => wheel.omega),
    vehicle.telemetry.speedKmh,
    vehicle.telemetry.signedSpeedKmh,
    vehicle.telemetry.rpm,
    vehicle.telemetry.longitudinalAcceleration,
    vehicle.telemetry.lateralAcceleration,
    ...vehicle.telemetry.wheels.flatMap((wheel) => [
      wheel.load,
      wheel.suspension,
      wheel.slipRatio,
      wheel.slipAngle,
      wheel.slipPower,
    ]),
  ];
}

function hashFrames(frames, quantization = null) {
  const hash = createHash('sha256');
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  for (const frame of frames) {
    for (const original of frame) {
      assert.ok(Number.isFinite(original), `replay frame contains ${original}`);
      const value = quantization === null
        ? original
        : Math.round(original / quantization) * quantization;
      view.setFloat64(0, value, false);
      hash.update(new Uint8Array(bytes));
    }
  }
  return hash.digest('hex');
}

function digestFrames(frames, label) {
  let jsExact = REPLAY_DIGEST_OFFSET_BASIS;
  let wasmExact = REPLAY_DIGEST_OFFSET_BASIS;
  let jsQuantized = REPLAY_DIGEST_OFFSET_BASIS;
  let wasmQuantized = REPLAY_DIGEST_OFFSET_BASIS;

  for (let tick = 0; tick < frames.length; tick += 1) {
    for (let field = 0; field < FRAME_FIELDS.length; field += 1) {
      const value = frames[tick][field];
      const location = `${label} tick=${tick} field=${FRAME_FIELDS[field]}`;
      const jsQuantizedValue = quantize(value, QUANTIZATION);
      const wasmQuantizedValue = replayCore.streetrush_quantize_replay_value(
        value,
        QUANTIZATION,
      );
      assert.ok(
        Object.is(wasmQuantizedValue, jsQuantizedValue),
        `${location} quantized JS=${jsQuantizedValue} WASM=${wasmQuantizedValue}`,
      );

      jsExact = pushDigest(jsExact, value);
      wasmExact = asU64(replayCore.streetrush_replay_digest_push_f64(wasmExact, value));
      assert.equal(
        wasmExact,
        jsExact,
        `${location} exact JS=${digestHex(jsExact)} WASM=${digestHex(wasmExact)}`,
      );

      jsQuantized = pushDigest(jsQuantized, jsQuantizedValue);
      wasmQuantized = asU64(replayCore.streetrush_replay_digest_push_f64(
        wasmQuantized,
        wasmQuantizedValue,
      ));
      assert.equal(
        wasmQuantized,
        jsQuantized,
        `${location} quantized JS=${digestHex(jsQuantized)} WASM=${digestHex(wasmQuantized)}`,
      );
    }
  }

  return {
    exactFnv1a64: digestHex(jsExact),
    quantizedFnv1a64: digestHex(jsQuantized),
  };
}

function firstDivergence(actual, expected) {
  for (let tick = 0; tick < Math.min(actual.length, expected.length); tick += 1) {
    for (let field = 0; field < FRAME_FIELDS.length; field += 1) {
      if (!Object.is(actual[tick][field], expected[tick][field])) {
        return {
          tick,
          field: FRAME_FIELDS[field],
          expected: expected[tick][field],
          actual: actual[tick][field],
        };
      }
    }
  }
  if (actual.length !== expected.length) return { tick: Math.min(actual.length, expected.length), field: 'frame-count' };
  return null;
}

function runTrace(config, inputs) {
  const rig = createVehicleRig(config);
  const frames = [];
  const resetSamples = [];
  try {
    for (let tick = 0; tick < inputs.length; tick += 1) {
      const input = inputs[tick];
      if (input.reset) {
        resetSamples.push({ tick, sampleIndex: rig.vehicle.safeSample });
        rig.vehicle.reset(rig.vehicle.safeSample);
      }
      rig.vehicle.fixedUpdate(input, false, FIXED_DT);
      rig.world.step();
      rig.vehicle.afterPhysics();
      frames.push(captureFrame(rig.vehicle));
    }
    return { frames, resetSamples };
  } finally {
    destroyVehicleRig(rig);
  }
}

let baseline = null;
try {
  baseline = JSON.parse(await readFile(baselineUrl, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

let fnvBaseline = null;
try {
  fnvBaseline = JSON.parse(await readFile(fnvBaselineUrl, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const generated = {
  formatVersion: FORMAT_VERSION,
  fixedDt: FIXED_DT,
  quantization: QUANTIZATION,
  inputFields: INPUT_FIELDS,
  frameFields: FRAME_FIELDS,
  traces: {},
};
const generatedFnv = {
  formatVersion: REPLAY_FORMAT_VERSION,
  algorithm: REPLAY_DIGEST_ALGORITHM,
  quantization: REPLAY_QUANTUM,
  frameFieldsSha256: createHash('sha256').update(JSON.stringify(FRAME_FIELDS)).digest('hex'),
  traces: {},
};

for (const config of CARS) {
  generated.traces[config.id] = {};
  generatedFnv.traces[config.id] = {};
  for (const scenario of scenarios) {
    const inputs = scenario.inputs(scenario);
    const runs = Array.from({ length: REPEATS }, () => runTrace(config, inputs));
    const reference = runs[0];
    for (let repeat = 1; repeat < runs.length; repeat += 1) {
      const divergence = firstDivergence(runs[repeat].frames, reference.frames);
      assert.equal(divergence, null, `${config.id}/${scenario.id}/repeat-${repeat}: ${JSON.stringify(divergence)}`);
      assert.deepEqual(
        runs[repeat].resetSamples,
        reference.resetSamples,
        `${config.id}/${scenario.id}/reset samples`,
      );
    }
    generated.traces[config.id][scenario.id] = {
      seed: scenario.seed,
      ticks: scenario.ticks,
      inputSha256: hashFrames(inputs.map(captureInput)),
      exactSha256: hashFrames(reference.frames),
      quantizedSha256: hashFrames(reference.frames, QUANTIZATION),
      resetSamples: reference.resetSamples,
    };
    generatedFnv.traces[config.id][scenario.id] = digestFrames(
      reference.frames,
      `${config.id}/${scenario.id}`,
    );
  }
}

if (process.argv.includes('--print-candidate')) {
  console.log(JSON.stringify(generated, null, 2));
} else if (!baseline) {
  console.error('Replay baseline is missing. Generated candidate follows:');
  console.error(JSON.stringify(generated, null, 2));
  process.exitCode = 2;
} else {
  assert.deepEqual(generated, baseline, 'vehicle replay baseline changed');
  if (process.argv.includes('--print-fnv-candidate')) {
    console.log(JSON.stringify(generatedFnv, null, 2));
  } else if (!fnvBaseline) {
    console.error('Replay FNV baseline is missing. Generated candidate follows:');
    console.error(JSON.stringify(generatedFnv, null, 2));
    process.exitCode = 2;
  } else {
    assert.deepEqual(generatedFnv, fnvBaseline, 'vehicle replay FNV baseline changed');
    console.log(
      `PASS vehicle determinism cars=${CARS.length} scenarios=${scenarios.length} `
      + `repeats=${REPEATS} traces=${CARS.length * scenarios.length} wasmFnv=${CARS.length * scenarios.length}`,
    );
  }
}
