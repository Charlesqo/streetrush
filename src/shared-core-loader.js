export const DEFAULT_CORE_WASM_URL = new URL('./generated/streetrush_core.wasm', import.meta.url);

export class SharedCoreLoadError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SharedCoreLoadError';
    this.code = code;
  }
}

async function instantiateFromFetch(wasmUrl, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(wasmUrl, { signal });
  } catch (error) {
    throw new SharedCoreLoadError('wasm-fetch-failed', `Failed to fetch ${wasmUrl}`, error);
  }
  if (!response?.ok) {
    throw new SharedCoreLoadError(
      'wasm-fetch-failed',
      `Failed to fetch ${wasmUrl}: HTTP ${response?.status ?? 'unknown'}`,
    );
  }
  try {
    return await WebAssembly.instantiate(await response.arrayBuffer());
  } catch (error) {
    throw new SharedCoreLoadError(
      'wasm-instantiate-failed',
      `Failed to instantiate ${wasmUrl}`,
      error,
    );
  }
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new SharedCoreLoadError(
        'wasm-load-timeout',
        `WASM shared core did not initialize within ${timeoutMs}ms`,
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

function readExports(source) {
  const exports = source?.instance?.exports ?? source?.exports;
  if (!exports || typeof exports !== 'object') {
    throw new SharedCoreLoadError(
      'wasm-export-missing',
      'WASM instance did not expose an exports object',
    );
  }
  return { exports };
}

export function fallbackReasonFromError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'wasm-instantiate-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function instantiateSharedCore({
  wasmUrl = DEFAULT_CORE_WASM_URL,
  fetchImpl = globalThis.fetch,
  instantiate,
  timeoutMs = 1500,
} = {}) {
  const abortController = instantiate ? null : new AbortController();
  try {
    const sourcePromise = instantiate
      ? Promise.resolve().then(() => instantiate(wasmUrl))
      : instantiateFromFetch(wasmUrl, fetchImpl, abortController.signal);
    const source = await withTimeout(sourcePromise, timeoutMs, () => abortController?.abort());
    return readExports(source);
  } catch (error) {
    if (error instanceof SharedCoreLoadError) throw error;
    throw new SharedCoreLoadError(
      'wasm-instantiate-failed',
      `Failed to instantiate ${wasmUrl}`,
      error,
    );
  }
}
