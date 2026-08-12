import { FIXED_DT } from './config.js';
import {
  MAX_FRAME_DT,
  MAX_PHYSICS_STEPS,
  accumulatePhysicsTime,
} from './physics-scheduling.js';
import {
  DEFAULT_CORE_WASM_URL,
  fallbackReasonFromError,
  instantiateSharedCore,
} from './shared-core-loader.js';

export { DEFAULT_CORE_WASM_URL } from './shared-core-loader.js';

class SchedulerLoadError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SchedulerLoadError';
    this.code = code;
  }
}

function result(steps, remainderSeconds) {
  return {
    steps,
    remainderSeconds,
    alpha: remainderSeconds / FIXED_DT,
  };
}

function createScheduler({ owner, fallbackReason = null, planFrame }) {
  let accumulatorSeconds = 0;
  return {
    owner,
    fallbackReason,
    fixedDtSeconds: FIXED_DT,
    maxFrameDtSeconds: MAX_FRAME_DT,
    maxPhysicsSteps: MAX_PHYSICS_STEPS,
    get accumulatorSeconds() {
      return accumulatorSeconds;
    },
    reset() {
      accumulatorSeconds = 0;
    },
    advance(deltaSeconds) {
      const plan = planFrame(accumulatorSeconds, deltaSeconds);
      accumulatorSeconds = plan.remainderSeconds;
      return result(plan.steps, accumulatorSeconds);
    },
  };
}

export function createJavaScriptPhysicsScheduler({ fallbackReason = null } = {}) {
  return createScheduler({
    owner: 'javascript',
    fallbackReason,
    planFrame(accumulatorSeconds, deltaSeconds) {
      let remainderSeconds = accumulatePhysicsTime(accumulatorSeconds, deltaSeconds);
      let steps = 0;
      while (remainderSeconds >= FIXED_DT && steps < MAX_PHYSICS_STEPS) {
        remainderSeconds -= FIXED_DT;
        steps += 1;
      }
      return { steps, remainderSeconds };
    },
  });
}

const requiredWasmFunctions = [
  'streetrush_fixed_dt_seconds',
  'streetrush_max_frame_dt_seconds',
  'streetrush_max_physics_steps',
  'streetrush_plan_physics_steps',
  'streetrush_plan_remainder_seconds',
];

function readExports(source) {
  const exports = source?.instance?.exports ?? source?.exports;
  if (!exports || typeof exports !== 'object') {
    throw new SchedulerLoadError('wasm-export-missing', 'WASM instance did not expose an exports object');
  }
  for (const name of requiredWasmFunctions) {
    if (typeof exports[name] !== 'function') {
      throw new SchedulerLoadError('wasm-export-missing', `WASM export is missing: ${name}`);
    }
  }
  return exports;
}

function assertContract(exports) {
  const contract = {
    fixedDtSeconds: exports.streetrush_fixed_dt_seconds(),
    maxFrameDtSeconds: exports.streetrush_max_frame_dt_seconds(),
    maxPhysicsSteps: exports.streetrush_max_physics_steps(),
  };
  if (
    contract.fixedDtSeconds !== FIXED_DT
    || contract.maxFrameDtSeconds !== MAX_FRAME_DT
    || contract.maxPhysicsSteps !== MAX_PHYSICS_STEPS
  ) {
    throw new SchedulerLoadError(
      'wasm-contract-mismatch',
      `WASM scheduler contract mismatch: ${JSON.stringify(contract)}`,
    );
  }
}

export function createWasmPhysicsScheduler(source) {
  const exports = readExports(source);
  assertContract(exports);
  return createScheduler({
    owner: 'rust-wasm',
    planFrame(accumulatorSeconds, deltaSeconds) {
      const steps = exports.streetrush_plan_physics_steps(accumulatorSeconds, deltaSeconds);
      const remainderSeconds = exports.streetrush_plan_remainder_seconds(accumulatorSeconds, deltaSeconds);
      if (
        !Number.isInteger(steps)
        || steps < 0
        || steps > MAX_PHYSICS_STEPS
        || !Number.isFinite(remainderSeconds)
        || remainderSeconds < 0
        || remainderSeconds >= FIXED_DT
      ) {
        throw new SchedulerLoadError(
          'wasm-plan-invalid',
          `WASM scheduler returned an invalid plan: steps=${steps}, remainder=${remainderSeconds}`,
        );
      }
      return { steps, remainderSeconds };
    },
  });
}

export async function loadPhysicsScheduler({
  wasmUrl = DEFAULT_CORE_WASM_URL,
  fetchImpl = globalThis.fetch,
  instantiate,
  timeoutMs = 1500,
} = {}) {
  try {
    const source = await instantiateSharedCore({ wasmUrl, fetchImpl, instantiate, timeoutMs });
    return createWasmPhysicsScheduler(source);
  } catch (error) {
    return createJavaScriptPhysicsScheduler({
      fallbackReason: fallbackReasonFromError(error),
    });
  }
}
