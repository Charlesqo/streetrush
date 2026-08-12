import {
  createJavaScriptPhysicsScheduler,
  createWasmPhysicsScheduler,
} from './physics-scheduler-owner.js';
import {
  createJavaScriptRaceProgressCore,
  createWasmRaceProgressCore,
} from './race-progress-core.js';
import {
  fallbackReasonFromError,
  instantiateSharedCore,
} from './shared-core-loader.js';

function createCapability(factory, fallback) {
  try {
    return factory();
  } catch (error) {
    return fallback(fallbackReasonFromError(error));
  }
}

export async function loadSharedCoreCapabilities(options) {
  let source;
  try {
    source = await instantiateSharedCore(options);
  } catch (error) {
    const loadFallbackReason = fallbackReasonFromError(error);
    return {
      loadFallbackReason,
      scheduler: createJavaScriptPhysicsScheduler({ fallbackReason: loadFallbackReason }),
      raceProgress: createJavaScriptRaceProgressCore({ fallbackReason: loadFallbackReason }),
    };
  }

  return {
    loadFallbackReason: null,
    scheduler: createCapability(
      () => createWasmPhysicsScheduler(source),
      (fallbackReason) => createJavaScriptPhysicsScheduler({ fallbackReason }),
    ),
    raceProgress: createCapability(
      () => createWasmRaceProgressCore(source),
      (fallbackReason) => createJavaScriptRaceProgressCore({ fallbackReason }),
    ),
  };
}
