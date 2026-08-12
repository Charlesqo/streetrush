// Loader contract adapted from:
// E:/Codex/autonomous_runs/multi_car_audio/runtime/vehicle-audio-runtime.js
// Source SHA-256: C60A8CC740913ACFD04D1BE3E976428AA1C0C5B6417829D896277F1818621B2A
// Candidate manifest oracle SHA-256:
// 90BEC41E53072B8AC932EC4C357A5BB37571EB3B2AE9687565AB37A7EA4903D8
// Prototype manifest oracle SHA-256:
// CC4FD3532EA4F29E814978875AB66958DBF4B4CD6A0D907C86E7DE3816E19994

function withQuery(url, query) {
  const entries = Object.entries(query ?? {})
    .filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return url;
  const suffix = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${suffix}`;
}

function appendPath(url, file) {
  const marker = url.search(/[?#]/);
  const pathPart = marker < 0 ? url : url.slice(0, marker);
  const suffix = marker < 0 ? '' : url.slice(marker);
  return `${pathPart.replace(/\/$/, '')}/${file}${suffix}`;
}

export class AudioBankLoadError extends Error {
  constructor(code, message, details = {}, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AudioBankLoadError';
    this.code = code;
    Object.assign(this, details);
  }
}

function bankError(code, bank, message, details = {}, cause = undefined) {
  return new AudioBankLoadError(code, message, { bankId: bank?.id ?? null, ...details }, cause);
}

function abortError(bank, cause = undefined) {
  const error = bankError('audio-bank-aborted', bank, `${bank?.id ?? 'audio bank'} load aborted`, {}, cause);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(bank, signal) {
  if (signal?.aborted) throw abortError(bank, signal.reason);
}

async function fetchResponse(fetchImpl, url, signal, bank, phase, layerFile = null) {
  throwIfAborted(bank, signal);
  try {
    return await fetchImpl(url, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError(bank, error);
    throw bankError(
      `${phase}-fetch`,
      bank,
      `${bank.id}${layerFile ? `/${layerFile}` : ''} fetch failed`,
      { layerFile, url },
      error,
    );
  }
}

function isApprovedLoop(loop) {
  return loop?.status === 'approved' && loop?.loopApproved === true;
}

function validateManifest(bank, manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw bankError('manifest-invalid', bank, `${bank.id} manifest must be an object`);
  }
  if (manifest.id && manifest.id !== bank.id) {
    throw bankError('manifest-id-mismatch', bank, `${bank.id} manifest id is ${manifest.id}`);
  }
  if (manifest.family && bank.family && manifest.family !== bank.family) {
    throw bankError('manifest-family-mismatch', bank, `${bank.id} manifest family is ${manifest.family}`);
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw bankError('manifest-layers-empty', bank, `${bank.id} manifest has no layers`);
  }

  const candidate = bank.id.startsWith('bank.candidate.');
  if (candidate && (
    bank.quality !== 'candidate-loop-approved'
    || manifest.quality !== 'candidate-loop-approved'
    || !isApprovedLoop(manifest.loop)
  )) {
    throw bankError('candidate-loop-unapproved', bank, `${bank.id} candidate bank loop is not approved`);
  }

  const files = new Set();
  for (const layer of manifest.layers) {
    const valid = layer
      && typeof layer === 'object'
      && typeof layer.file === 'string'
      && layer.file.length > 0
      && Number.isFinite(layer.rpm)
      && layer.rpm > 0
      && (layer.mode === 'on' || layer.mode === 'off');
    if (!valid || files.has(layer?.file)) {
      throw bankError('layer-invalid', bank, `${bank.id} has an invalid or duplicate layer`, {
        layerFile: layer?.file ?? null,
      });
    }
    files.add(layer.file);
    if (candidate && !isApprovedLoop(layer.loop)) {
      throw bankError(
        'candidate-layer-loop-unapproved',
        bank,
        `${bank.id}/${layer.file} candidate layer loop is not approved`,
        { layerFile: layer.file },
      );
    }
  }
}

export function createDecodedAudioBankLoader({ context, fetchImpl = globalThis.fetch } = {}) {
  if (!context || typeof context.decodeAudioData !== 'function') {
    throw new TypeError('createDecodedAudioBankLoader requires an audio decode context');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createDecodedAudioBankLoader requires fetchImpl');
  }

  return async function loadDecodedAudioBank(bank, { signal: suppliedSignal } = {}) {
    if (!bank || typeof bank.id !== 'string' || typeof bank.rootUrl !== 'string') {
      throw bankError('bank-invalid', bank, 'audio bank requires id and rootUrl');
    }
    const signal = suppliedSignal ?? new AbortController().signal;
    throwIfAborted(bank, signal);
    const query = { assetVersion: bank.assetVersion };
    const manifestUrl = withQuery(
      appendPath(bank.rootUrl, bank.manifestFile ?? 'bank.json'),
      query,
    );
    const manifestResponse = await fetchResponse(
      fetchImpl,
      manifestUrl,
      signal,
      bank,
      'manifest',
    );
    if (!manifestResponse?.ok) {
      throw bankError(
        'manifest-http',
        bank,
        `${bank.id} manifest HTTP ${manifestResponse?.status ?? 'unknown'}`,
        { status: manifestResponse?.status ?? null, url: manifestUrl },
      );
    }

    let manifest;
    try {
      manifest = await manifestResponse.json();
    } catch (error) {
      throwIfAborted(bank, signal);
      throw bankError('manifest-json', bank, `${bank.id} manifest JSON failed`, { url: manifestUrl }, error);
    }
    throwIfAborted(bank, signal);
    validateManifest(bank, manifest);

    const decodedLayers = [];
    for (const layer of manifest.layers) {
      const layerUrl = withQuery(appendPath(bank.rootUrl, encodeURIComponent(layer.file)), query);
      const layerResponse = await fetchResponse(
        fetchImpl,
        layerUrl,
        signal,
        bank,
        'layer',
        layer.file,
      );
      if (!layerResponse?.ok) {
        throw bankError(
          'layer-http',
          bank,
          `${bank.id}/${layer.file} HTTP ${layerResponse?.status ?? 'unknown'}`,
          { layerFile: layer.file, status: layerResponse?.status ?? null, url: layerUrl },
        );
      }

      let bytes;
      try {
        bytes = await layerResponse.arrayBuffer();
      } catch (error) {
        throwIfAborted(bank, signal);
        throw bankError(
          'layer-body',
          bank,
          `${bank.id}/${layer.file} body failed`,
          { layerFile: layer.file, url: layerUrl },
          error,
        );
      }
      throwIfAborted(bank, signal);

      let buffer;
      try {
        buffer = await context.decodeAudioData(bytes.slice(0));
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') throw abortError(bank, error);
        throw bankError(
          'layer-decode',
          bank,
          `${bank.id}/${layer.file} decode failed`,
          { layerFile: layer.file },
          error,
        );
      }
      // decodeAudioData cannot be cancelled. Never return its result after the
      // request owner has aborted, even if decode completed successfully.
      throwIfAborted(bank, signal);
      decodedLayers.push({ ...layer, buffer });
    }

    const value = {
      id: bank.id,
      family: manifest.family ?? bank.family ?? null,
      sourceVersion: manifest.version ?? null,
      assetVersion: bank.assetVersion ?? null,
      sampleRate: context.sampleRate ?? manifest.sampleRate ?? null,
      quality: manifest.quality ?? bank.quality ?? null,
      loop: manifest.loop ?? null,
      layers: decodedLayers,
      disposed: false,
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.layers.length = 0;
      },
    };
    return value;
  };
}
