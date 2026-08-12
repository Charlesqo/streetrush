import { FIXED_DT } from './config.js';
import {
  MAX_FRAME_DT,
  MAX_PHYSICS_STEPS,
  accumulatePhysicsTime,
} from './physics-scheduling.js';

export const DEFAULT_CORE_WASM_URL = new URL('./generated/streetrush_core.wasm', import.meta.url);

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

async function instantiateFromFetch(wasmUrl, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(wasmUrl, { signal });
  } catch (error) {
    throw new SchedulerLoadError('wasm-fetch-failed', `Failed to fetch ${wasmUrl}`, error);
  }
  if (!response?.ok) {
    throw new SchedulerLoadError(
      'wasm-fetch-failed',
      `Failed to fetch ${wasmUrl}: HTTP ${response?.status ?? 'unknown'}`,
    );
  }
  try {
    return await WebAssembly.instantiate(await response.arrayBuffer());
  } catch (error) {
    throw new SchedulerLoadError('wasm-instantiate-failed', `Failed to instantiate ${wasmUrl}`, error);
  }
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new SchedulerLoadError(
        'wasm-load-timeout',
        `WASM scheduler did not initialize within ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function fallbackReason(error) {
  return {
    code: error instanceof SchedulerLoadError ? error.code : 'wasm-instantiate-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function loadPhysicsScheduler({
  wasmUrl = DEFAULT_CORE_WASM_URL,
  fetchImpl = globalThis.fetch,
  instantiate,
  timeoutMs = 1500,
} = {}) {
  try {
    const abortController = instantiate ? null : new AbortController();
    const sourcePromise = instantiate
      ? instantiate(wasmUrl)
      : instantiateFromFetch(wasmUrl, fetchImpl, abortController.signal);
    const source = await withTimeout(sourcePromise, timeoutMs, () => abortController?.abort());
    return createWasmPhysicsScheduler(source);
  } catch (error) {
    return createJavaScriptPhysicsScheduler({ fallbackReason: fallbackReason(error) });
  }
}
