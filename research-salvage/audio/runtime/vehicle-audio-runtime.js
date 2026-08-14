function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function withQuery(url, query) {
  const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return url;
  const suffix = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${suffix}`;
}

function appendPath(url, file) {
  const marker = url.search(/[?#]/);
  const pathPart = marker < 0 ? url : url.slice(0, marker);
  const suffix = marker < 0 ? '' : url.slice(marker);
  return `${pathPart.replace(/\/$/, '')}/${file}${suffix}`;
}

function abortError(message = 'audio bank load aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function stopDisconnect(source, gain) {
  try { source.stop(); } catch (_) { /* already stopped */ }
  try { source.disconnect(); } catch (_) { /* already disconnected */ }
  try { gain?.disconnect(); } catch (_) { /* already disconnected */ }
}

function setParamValue(param, value, time = 0) {
  try { param.cancelScheduledValues?.(time); } catch (_) { /* optional in test doubles */ }
  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(value, time);
  } else {
    param.value = value;
  }
  // Keep the observable current value in sync with an immediate route change.
  // Chrome can retain the previous .value briefly when a setValueAtTime event
  // is scheduled at the current time during garage -> reenter, which would
  // report a connected bank route as silent even though its sources are active.
  try { param.value = value; } catch (_) { /* read-only test doubles */ }
}

function setParamTarget(param, value, time, timeConstant) {
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, time, timeConstant);
  } else {
    param.value = value;
  }
}

function normalizeCompatibilitySignalLayer(layer = null) {
  const source = layer ?? {};
  return {
    mode: ['none', 'runtime'].includes(source.mode) ? source.mode : 'none',
    runtimeEnabled: source.runtimeEnabled === true,
    physical: source.physical === true,
    signals: Array.isArray(source.signals) ? [...new Set(source.signals.filter((signal) => signal === 'turbo' || signal === 'electricMotor'))] : [],
    signalGains: {
      turbo: clamp(Number(source.signalGains?.turbo ?? 0), 0, 0.12),
      electricMotor: clamp(Number(source.signalGains?.electricMotor ?? 0), 0, 0.12),
    },
    frequencies: {
      turbo: clamp(Number(source.frequencies?.turbo ?? 180), 25, 2400),
      electricMotor: clamp(Number(source.frequencies?.electricMotor ?? 520), 25, 2400),
    },
    activation: source.activation ?? 'bank-ready-only',
    evidence: typeof source.evidence === 'string' ? source.evidence : 'No compatibility-layer evidence recorded.',
  };
}

function compatibilityOverlayMode(bank) {
  return bank?.compatibilityOverlay?.mode ?? 'none';
}

function normalizedBanks(document) {
  return new Map((document?.banks ?? []).map((bank) => [bank.id, {...bank}]));
}

// Candidate WAVs are publishable only after the offline loop gate has marked
// both the bank and every layer approved. Source prototype banks are kept
// available as explicit family fallbacks; they are not candidate publications.
export function isRuntimeEligibleBank(bank) {
  if (!bank || typeof bank.id !== 'string') return false;
  if (!bank.id.startsWith('bank.candidate.')) return true;
  return bank.quality === 'candidate-loop-approved';
}

export function resolveVehicleAudioProfile(config, profileDocument) {
  const id = config?.audioProfileId ?? config?.audio?.profileId ?? config?.id;
  const profile = (profileDocument?.profiles ?? []).find((candidate) => candidate.id === id);
  if (profile) return profile;
  if (!config?.audio?.family) throw new Error(`No VehicleAudioProfile for ${id ?? 'unknown vehicle'}`);
  // Compatibility adapter for an older config: it is deliberately procedural-only
  // unless a data profile exists. The player core still does not know family names.
  return {
    id: id ?? 'anonymous',
    displayName: config.name ?? id ?? 'anonymous',
    modelFile: config.file ?? null,
    engine: {
      family: config.audio.family,
      cylinders: {value: config.audio.cylinders ?? 4, status: 'unknown'},
      idleRpm: {value: config.idle ?? 900, status: 'unknown'},
      redlineRpm: {value: config.redline ?? 7000, status: 'unknown'},
    },
    audio: {
      exactBankId: null,
      familyFallbackBankIds: [],
      proceduralFallback: true,
      proceduralTimbre: {
        family: config.audio.family,
        lowHz: config.audio.low,
        midHz: config.audio.mid,
        highHz: config.audio.high,
        drive: config.audio.drive,
      },
      resolutionNote: 'Compatibility config without a VehicleAudioProfile; procedural fallback only.',
    },
  };
}

export function resolveAudioSelection(profile, bankDocument) {
  const banks = normalizedBanks(bankDocument);
  const rejectedBankIds = [];
  const exactId = profile.audio?.exactBankId;
  const exact = exactId ? banks.get(exactId) : null;
  if (exact && exact.scope === 'exact' && exact.vehicleId === profile.id) {
    if (isRuntimeEligibleBank(exact)) return {mode: 'exact', bank: exact, reason: 'profile exactBankId'};
    rejectedBankIds.push(exact.id);
  }
  for (const bankId of profile.audio?.familyFallbackBankIds ?? []) {
    const bank = banks.get(bankId);
    if (bank && bank.scope === 'family' && bank.family === profile.engine.family) {
      if (isRuntimeEligibleBank(bank)) return {mode: 'family', bank, reason: 'profile familyFallbackBankIds'};
      rejectedBankIds.push(bank.id);
    }
  }
  return {
    mode: 'procedural',
    bank: null,
    reason: rejectedBankIds.length > 0
      ? 'no eligible exact or family bank in manifest'
      : 'no compatible exact or family bank in manifest',
    rejectedBankIds,
  };
}

export class DecodedBankRegistry {
  constructor({context, fetchImpl = globalThis.fetch, onEvent = () => {}}) {
    this.context = context;
    this.fetchImpl = fetchImpl;
    this.onEvent = onEvent;
    this.entries = new Map();
    this.metrics = {
      acquires: 0,
      releases: 0,
      inFlightReuses: 0,
      readyReuses: 0,
      manifestFetches: 0,
      wavFetches: 0,
      decodeCalls: 0,
      decodeCompletions: 0,
      failures: 0,
      aborts: 0,
      evictions: 0,
      staleDiscards: 0,
    };
  }

  makeKey(bank, tier = 'full') {
    return [
      bank.id,
      bank.assetVersion ?? 'unversioned',
      this.context.sampleRate,
      bank.channels ?? 'mono',
      tier,
    ].join('|');
  }

  acquire(bank, {tier = 'full', layerFiles} = {}) {
    const key = this.makeKey(bank, tier);
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        key,
        bank,
        tier,
        refs: 0,
        state: 'loading',
        controller,
        value: null,
        promise: null,
        released: false,
      };
      entry.promise = this.load(bank, {tier, layerFiles, signal: controller.signal})
        .then((value) => {
          if (entry.state !== 'loading' || controller.signal.aborted || entry.refs === 0) {
            this.metrics.staleDiscards += 1;
            this.onEvent({type: 'stale-discard', key, bankId: bank.id});
            return value;
          }
          entry.state = 'ready';
          entry.value = value;
          this.onEvent({type: 'bank-ready', key, bankId: bank.id, layers: value.layers.length});
          return value;
        })
        .catch((error) => {
          this.metrics.failures += 1;
          if (error?.name === 'AbortError') this.metrics.aborts += 1;
          if (this.entries.get(key) === entry) this.entries.delete(key);
          this.onEvent({type: error?.name === 'AbortError' ? 'bank-aborted' : 'bank-failed', key, bankId: bank.id, error: String(error)});
          throw error;
        });
      this.entries.set(key, entry);
      this.onEvent({type: 'bank-loading', key, bankId: bank.id, family: bank.family});
    } else if (entry.state === 'loading') {
      this.metrics.inFlightReuses += 1;
    } else if (entry.state === 'ready') {
      this.metrics.readyReuses += 1;
    }
    entry.refs += 1;
    this.metrics.acquires += 1;
    let released = false;
    return {
      key,
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        this.release(key, entry);
      },
    };
  }

  release(key, expectedEntry = null) {
    const entry = this.entries.get(key);
    if (!entry || (expectedEntry && entry !== expectedEntry)) return;
    entry.refs = Math.max(0, entry.refs - 1);
    this.metrics.releases += 1;
    if (entry.refs !== 0) return;
    if (entry.state === 'loading') {
      entry.state = 'aborting';
      entry.released = true;
      entry.controller.abort();
      this.entries.delete(key);
      this.onEvent({type: 'bank-abort-requested', key, bankId: entry.bank.id});
    } else if (entry.state === 'ready') {
      entry.state = 'evicted';
      entry.value = null;
      this.entries.delete(key);
      this.metrics.evictions += 1;
      this.onEvent({type: 'bank-evicted', key, bankId: entry.bank.id});
    }
  }

  async load(bank, {tier, layerFiles, signal}) {
    if (signal.aborted) throw abortError();
    const base = bank.rootUrl.replace(/\/$/, '');
    const query = {assetVersion: bank.assetVersion};
    this.metrics.manifestFetches += 1;
    const response = await this.fetchImpl(withQuery(appendPath(base, bank.manifestFile ?? 'bank.json'), query), {signal});
    if (!response.ok) throw new Error(`${bank.id} manifest HTTP ${response.status}`);
    const manifest = await response.json();
    let layers = Array.isArray(manifest.layers) ? manifest.layers.slice() : [];
    if (tier !== 'full' && Array.isArray(layerFiles) && layerFiles.length > 0) {
      layers = layers.filter((layer) => layerFiles.includes(layer.file));
    }
    if (layers.length === 0) throw new Error(`${bank.id} has no selected layers`);
    const decodedLayers = [];
    for (const layer of layers) {
      if (signal.aborted) throw abortError();
      this.metrics.wavFetches += 1;
      // Chrome 151 may return a synthetic 204/empty body for a media-file
      // fetch without a byte-range request in the isolated harness. A full
      // range is compatible with ordinary static servers (they may answer
      // 200 or 206) and keeps the fetch stage deterministic before decode.
      const wavResponse = await this.fetchImpl(withQuery(appendPath(base, encodeURIComponent(layer.file)), query), {
        signal,
        headers: {Range: 'bytes=0-'},
      });
      if (!wavResponse.ok) throw new Error(`${bank.id}/${layer.file} HTTP ${wavResponse.status}`);
      const bytes = await wavResponse.arrayBuffer();
      this.metrics.decodeCalls += 1;
      // decodeAudioData has no cancellation signal. The post-decode check is
      // intentionally separate: abort stops future fetches and stale data is
      // never published after a decode that was already in flight.
      const buffer = await this.context.decodeAudioData(bytes.slice(0));
      this.metrics.decodeCompletions += 1;
      if (signal.aborted) {
        this.metrics.staleDiscards += 1;
        this.onEvent({type: 'stale-discard', key: this.makeKey(bank, tier), bankId: bank.id, phase: 'post-decode'});
        throw abortError('audio decode completed after abort');
      }
      decodedLayers.push({...layer, buffer});
    }
    return {
      id: bank.id,
      family: manifest.family ?? bank.family,
      sourceVersion: manifest.version ?? null,
      assetVersion: bank.assetVersion ?? null,
      tier,
      sampleRate: this.context.sampleRate,
      quality: manifest.quality ?? bank.quality ?? null,
      registration: manifest.registration ?? null,
      loop: manifest.loop ?? null,
      compatibilityOverlay: manifest.compatibilityOverlay ?? bank.compatibilityOverlay ?? {mode: 'none', signals: [], physical: false, evidence: 'No bank-level compatibility overlay declared.'},
      layers: decodedLayers,
    };
  }

  snapshot() {
    return {
      metrics: {...this.metrics},
      entries: [...this.entries.values()].map((entry) => ({
        key: entry.key,
        state: entry.state,
        refs: entry.refs,
        bankId: entry.bank.id,
        family: entry.bank.family,
        tier: entry.tier,
        layerCount: entry.value?.layers?.length ?? null,
      })),
    };
  }

  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.state === 'loading') entry.controller.abort();
    }
    this.entries.clear();
  }
}

class AudioVehicleNode {
  constructor(runtime, id, profile = null) {
    this.runtime = runtime;
    this.context = runtime.context;
    this.id = id;
    this.profile = profile;
    this.requestId = 0;
    this.state = 'procedural';
    this.resolution = {mode: 'procedural', bankId: null, reason: 'not selected'};
    this.bank = null;
    this.bankLease = null;
    this.pendingLease = null;
    this.enabled = true;
    this.proceduralSources = [];
    this.proceduralGains = [];
    this.proceduralBaseGains = [];
    this.proceduralBus = null;
    this.proceduralBusConnected = false;
    this.proceduralRouteEnabled = false;
    this.bankBus = this.context.createGain();
    this.bankBus.gain.value = 1;
    this.bankBusConnected = false;
    this.bankRouteEnabled = false;
    this.compatibilitySources = [];
    this.compatibilityGains = [];
    this.compatibilityBaseGains = [];
    this.compatibilitySourceSignals = [];
    this.compatibilityBus = null;
    this.compatibilityBusConnected = false;
    this.compatibilityRouteEnabled = false;
    this.compatibilityRouteReason = 'disabled-by-profile-or-lifecycle';
    this.compatibilityConfig = normalizeCompatibilitySignalLayer();
    this.compatibilityOverlay = {mode: 'none', signals: [], physical: false};
    this.lastProceduralActiveSourceCount = 0;
    this.lastBankActiveLayerCount = 0;
    this.lastCompatibilityActiveSourceCount = 0;
    this.outputGain = this.context.createGain();
    this.outputGain.gain.value = 0.18;
    this.outputGain.connect(runtime.master);
    this.createProceduralGraph();
    this.setProceduralRoute(true);
  }

  createProceduralGraph() {
    const sourceBus = this.context.createGain();
    sourceBus.gain.value = 1;
    this.proceduralBus = sourceBus;
    ['sawtooth', 'triangle', 'square'].forEach((type, index) => {
      const source = this.context.createOscillator();
      const gain = this.context.createGain();
      source.type = type;
      source.frequency.value = 50 + index * 25;
      gain.gain.value = [0.08, 0.04, 0.012][index];
      this.proceduralBaseGains.push(gain.gain.value);
      source.connect(gain).connect(sourceBus);
      source.start();
      this.proceduralSources.push(source);
      this.proceduralGains.push(gain);
    });
    const noise = this.context.createBufferSource();
    const noiseBuffer = this.context.createBuffer(1, Math.max(1, Math.floor(this.context.sampleRate)), this.context.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < noiseData.length; index += 1) {
      previous = previous * 0.82 + Math.sin(index * 0.17) * 0.18;
      noiseData[index] = previous;
    }
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const noiseGain = this.context.createGain();
    noiseGain.gain.value = 0.006;
    this.proceduralBaseGains.push(noiseGain.gain.value);
    noise.connect(noiseGain).connect(sourceBus);
    noise.start();
    this.proceduralSources.push(noise);
    this.proceduralGains.push(noiseGain);
  }

  ensureCompatibilityGraph(profile = this.profile) {
    this.compatibilityConfig = normalizeCompatibilitySignalLayer(profile?.audio?.compatibilitySignalLayer);
    if (this.compatibilityConfig.mode !== 'runtime' || !this.compatibilityConfig.runtimeEnabled) return;
    if (this.compatibilityBus) return;
    const sourceBus = this.context.createGain();
    sourceBus.gain.value = 1;
    this.compatibilityBus = sourceBus;
    const definitions = [
      {signal: 'turbo', type: 'sine', harmonic: 1},
      {signal: 'turbo', type: 'sawtooth', harmonic: 1.97},
      {signal: 'electricMotor', type: 'triangle', harmonic: 1},
      {signal: 'electricMotor', type: 'sine', harmonic: 1.91},
    ];
    for (const definition of definitions) {
      const source = this.context.createOscillator();
      const gain = this.context.createGain();
      source.type = definition.type;
      source.frequency.value = this.compatibilityConfig.frequencies[definition.signal] * definition.harmonic;
      gain.gain.value = 0;
      source.connect(gain).connect(sourceBus);
      source.start();
      this.compatibilitySources.push(source);
      this.compatibilityGains.push(gain);
      this.compatibilityBaseGains.push(this.compatibilityConfig.signalGains[definition.signal]);
      this.compatibilitySourceSignals.push({...definition});
    }
  }

  setCompatibilityRoute(enabled) {
    const config = this.compatibilityConfig;
    const overlayMode = compatibilityOverlayMode(this.compatibilityOverlay);
    const shouldEnable = Boolean(enabled)
      && this.enabled
      && this.state === 'ready'
      && Boolean(this.bank)
      && Boolean(this.compatibilityBus)
      && config.mode === 'runtime'
      && config.runtimeEnabled === true
      && config.physical === false
      && config.activation === 'bank-ready-only'
      && overlayMode === 'none';
    this.compatibilityRouteEnabled = shouldEnable;
    this.compatibilityRouteReason = shouldEnable
      ? 'runtime-layer-with-non-baked-bank'
      : (overlayMode === 'baked' ? 'bank-overlay-already-baked' : 'disabled-by-profile-or-lifecycle');
    if (shouldEnable) {
      if (!this.compatibilityBusConnected) {
        this.compatibilityBus.connect(this.outputGain);
        this.compatibilityBusConnected = true;
      }
      setParamValue(this.compatibilityBus.gain, 1, this.context.currentTime);
      this.compatibilityGains.forEach((gain, index) => setParamValue(gain.gain, this.compatibilityBaseGains[index] ?? 0, this.context.currentTime));
      this.lastCompatibilityActiveSourceCount = this.compatibilityGains.filter((gain) => Number(gain.gain.value) > 0.0001).length;
    } else {
      setParamValue(this.compatibilityBus?.gain, 0, this.context.currentTime);
      if (this.compatibilityBusConnected) {
        try { this.compatibilityBus.disconnect(this.outputGain); } catch (_) { try { this.compatibilityBus.disconnect(); } catch (_) {} }
        this.compatibilityBusConnected = false;
      }
      this.compatibilityGains.forEach((gain) => setParamValue(gain.gain, 0, this.context.currentTime));
      this.lastCompatibilityActiveSourceCount = 0;
    }
  }

  updateCompatibility({rpm = 1200, load = 0, speedKmh = 0} = {}) {
    const engine = this.profile?.engine ?? {};
    const idle = Number(engine.idleRpm?.value ?? 700);
    const redline = Math.max(idle + 1, Number(engine.redlineRpm?.value ?? 7000));
    const rpmMix = clamp((Number(rpm) - idle) / (redline - idle), 0, 1);
    const normalizedLoad = clamp(Number(load ?? 0), 0, 1);
    const speedMix = clamp(Number(speedKmh ?? 0) / 300, 0, 1);
    let activeCount = 0;
    this.compatibilitySources.forEach((source, index) => {
      const definition = this.compatibilitySourceSignals[index];
      const signalMix = definition.signal === 'turbo'
        ? clamp(normalizedLoad * 0.82 + rpmMix * 0.18, 0, 1)
        : clamp(normalizedLoad * 0.55 + speedMix * 0.30 + rpmMix * 0.15, 0, 1);
      const baseGain = this.compatibilityBaseGains[index] ?? 0;
      const level = this.compatibilityRouteEnabled ? baseGain * (0.25 + signalMix * 0.75) : 0;
      const frequency = this.compatibilityConfig.frequencies[definition.signal] * definition.harmonic * (0.72 + rpmMix * 0.78);
      setParamTarget(source.frequency, frequency, this.context.currentTime, 0.04);
      setParamTarget(this.compatibilityGains[index]?.gain, level, this.context.currentTime, 0.06);
      if (level > 0.0001) activeCount += 1;
    });
    this.lastCompatibilityActiveSourceCount = activeCount;
  }

  setProceduralRoute(enabled) {
    const shouldEnable = Boolean(enabled)
      && this.enabled
      && this.state !== 'garage'
      && this.state !== 'disposed'
      && !this.bank;
    this.proceduralRouteEnabled = shouldEnable;
    if (shouldEnable) {
      if (!this.proceduralBusConnected) {
        this.proceduralBus.connect(this.outputGain);
        this.proceduralBusConnected = true;
      }
      setParamValue(this.proceduralBus.gain, 1, this.context.currentTime);
      this.proceduralGains.forEach((gain, index) => setParamValue(gain.gain, this.proceduralBaseGains[index] ?? 0, this.context.currentTime));
      this.lastProceduralActiveSourceCount = this.proceduralSources.length;
    } else {
      setParamValue(this.proceduralBus?.gain, 0, this.context.currentTime);
      if (this.proceduralBusConnected) {
        try { this.proceduralBus.disconnect(this.outputGain); } catch (_) { try { this.proceduralBus.disconnect(); } catch (_) {} }
        this.proceduralBusConnected = false;
      }
      this.proceduralGains.forEach((gain) => setParamValue(gain.gain, 0, this.context.currentTime));
      this.lastProceduralActiveSourceCount = 0;
    }
  }

  setBankRoute(enabled) {
    const shouldEnable = Boolean(enabled)
      && this.enabled
      && this.state === 'ready'
      && Boolean(this.bank);
    this.bankRouteEnabled = shouldEnable;
    if (shouldEnable) {
      if (!this.bankBusConnected) {
        this.bankBus.connect(this.outputGain);
        this.bankBusConnected = true;
      }
      setParamValue(this.bankBus.gain, 1, this.context.currentTime);
    } else {
      setParamValue(this.bankBus.gain, 0, this.context.currentTime);
      if (this.bankBusConnected) {
        try { this.bankBus.disconnect(this.outputGain); } catch (_) { try { this.bankBus.disconnect(); } catch (_) {} }
        this.bankBusConnected = false;
      }
      this.lastBankActiveLayerCount = 0;
    }
  }

  detachBank() {
    if (this.bank) {
      for (const layer of this.bank.layers) stopDisconnect(layer.source, layer.gain);
      this.bank = null;
    }
    this.setBankRoute(false);
    this.setCompatibilityRoute(false);
    this.compatibilityOverlay = {mode: 'none', signals: [], physical: false};
    if (this.bankLease) {
      this.bankLease.release();
      this.bankLease = null;
    }
  }

  cancelPending() {
    if (this.pendingLease) {
      this.pendingLease.release();
      this.pendingLease = null;
    }
  }

  async setProfile(profile, bankDocument) {
    const requestId = ++this.requestId;
    this.profile = profile;
    this.cancelPending();
    this.detachBank();
    this.compatibilityConfig = normalizeCompatibilitySignalLayer(profile?.audio?.compatibilitySignalLayer);
    this.ensureCompatibilityGraph(profile);
    const selection = resolveAudioSelection(profile, bankDocument);
    this.resolution = {mode: selection.mode, bankId: selection.bank?.id ?? null, reason: selection.reason};
    this.state = selection.mode === 'procedural' ? 'procedural' : 'loading';
    this.setProceduralRoute(profile.audio?.proceduralFallback !== false);
    this.setCompatibilityRoute(false);
    this.runtime.emit({type: 'vehicle-resolution', vehicleId: this.id, profileId: profile.id, ...this.resolution});
    if (selection.mode === 'procedural') return {state: this.state, resolution: this.resolution};
    const lease = this.runtime.registry.acquire(selection.bank);
    this.pendingLease = lease;
    try {
      const value = await lease.promise;
      if (requestId !== this.requestId || !this.enabled && this.state === 'garage') {
        lease.release();
        return {state: 'stale', resolution: this.resolution};
      }
      this.pendingLease = null;
      this.bankLease = lease;
      this.attachBank(value);
      this.compatibilityOverlay = value.compatibilityOverlay ?? selection.bank.compatibilityOverlay ?? {mode: 'none', signals: [], physical: false};
      this.state = 'ready';
      this.setProceduralRoute(false);
      this.setBankRoute(true);
      this.setCompatibilityRoute(true);
      this.runtime.emit({type: 'vehicle-bank-published', vehicleId: this.id, bankId: selection.bank.id});
      return {state: this.state, resolution: this.resolution};
    } catch (error) {
      if (requestId !== this.requestId) return {state: 'stale', resolution: this.resolution};
      this.pendingLease = null;
      lease.release();
      if (this.bankLease === lease) this.bankLease = null;
      this.state = profile.audio?.proceduralFallback ? 'degraded' : 'failed';
      this.resolution = {...this.resolution, mode: 'procedural', fallbackError: String(error)};
      this.setProceduralRoute(this.state === 'degraded');
      this.setCompatibilityRoute(false);
      this.runtime.emit({type: 'vehicle-procedural-fallback', vehicleId: this.id, error: String(error)});
      return {state: this.state, resolution: this.resolution, error: String(error)};
    }
  }

  attachBank(value) {
    const candidateLoopRequired = value.id?.startsWith('bank.candidate.');
    const candidateLoopInvalid = candidateLoopRequired && (
      value.quality !== 'candidate-loop-approved'
      ||
      value.loop?.status !== 'approved'
      || value.loop?.loopApproved !== true
      || !Array.isArray(value.layers)
      || value.layers.some((layer) => layer.loop?.status !== 'approved' || layer.loop?.loopApproved !== true)
    );
    if (candidateLoopInvalid) {
      throw new Error(`${value.id} bank or layer loop gate is not approved`);
    }
    const layers = value.layers.map((layer) => {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = layer.buffer;
      source.loop = !candidateLoopRequired || layer.loop?.status === 'approved';
      const loop = candidateLoopRequired ? layer.loop : (value.loop?.status === 'approved' ? value.loop : layer.loop);
      source.loopStart = clamp(Number(loop?.loopStart ?? 0), 0, source.buffer.duration);
      source.loopEnd = clamp(Number(loop?.loopEnd ?? source.buffer.duration), source.loopStart, source.buffer.duration);
      gain.gain.value = 0;
      source.connect(gain).connect(this.bankBus);
      source.start();
      return {...layer, source, gain};
    });
    this.bank = {id: value.id, family: value.family, tier: value.tier, loop: value.loop, layers};
  }

  update({rpm = 1200, load = null, throttle = null, speedKmh = null, speed = null, enabled = this.enabled} = {}) {
    const now = this.context.currentTime;
    const profile = this.profile;
    const engine = profile?.engine ?? {};
    const bank = this.bank;
    const anchors = bank ? [...new Set(bank.layers.map((layer) => layer.rpm))].sort((a, b) => a - b) : [];
    const rpmWeights = new Map();
    if (anchors.length > 0) {
      if (rpm <= anchors[0]) rpmWeights.set(anchors[0], 1);
      else if (rpm >= anchors.at(-1)) rpmWeights.set(anchors.at(-1), 1);
      else {
        for (let index = 0; index < anchors.length - 1; index += 1) {
          const low = anchors[index];
          const high = anchors[index + 1];
          if (rpm >= low && rpm <= high) {
            const mix = (rpm - low) / (high - low);
            rpmWeights.set(low, Math.cos(mix * Math.PI * 0.5));
            rpmWeights.set(high, Math.sin(mix * Math.PI * 0.5));
            break;
          }
        }
      }
    }
    const normalizedLoad = clamp(load ?? throttle ?? 0, 0, 1);
    const normalizedSpeedKmh = Number(speedKmh ?? speed ?? 0);
    if (bank) {
      this.setProceduralRoute(false);
      this.setBankRoute(this.enabled && this.state === 'ready');
      this.setCompatibilityRoute(this.enabled && this.state === 'ready');
      const onWeight = Math.sqrt(normalizedLoad);
      const offWeight = Math.sqrt(1 - normalizedLoad);
      let activeLayerCount = 0;
      for (const layer of bank.layers) {
        const rpmWeight = rpmWeights.get(layer.rpm) ?? 0;
        const loadWeight = layer.mode === 'on' ? onWeight : offWeight;
        const level = enabled && this.bankRouteEnabled ? Math.max(0, rpmWeight * loadWeight * 0.72) : 0;
        if (level > 0.0001) activeLayerCount += 1;
        setParamTarget(layer.gain.gain, level, now, 0.045);
        setParamTarget(layer.source.playbackRate, clamp(rpm / layer.rpm, 0.45, 1.55), now, 0.035);
      }
      this.lastBankActiveLayerCount = activeLayerCount;
    } else {
      this.setProceduralRoute(this.enabled && this.state !== 'garage' && this.state !== 'disposed');
      this.setCompatibilityRoute(false);
    }
    const timbre = profile?.audio?.proceduralTimbre ?? {};
    const cylinders = Math.max(1, Number(engine.cylinders?.value ?? 4));
    const frequency = Math.max(25, rpm / 60 * cylinders / 2);
    if (this.proceduralRouteEnabled) {
      this.proceduralSources.slice(0, 3).forEach((source, index) => {
        setParamTarget(source.frequency, frequency * (index === 0 ? 1 : index === 1 ? 0.5 : 2.01), now, 0.04);
      });
      setParamTarget(this.proceduralGains[0]?.gain, clamp(Number(timbre.lowHz ?? 100) / 3000, 0.02, 0.18), now, 0.08);
    }
    this.updateCompatibility({rpm, load: normalizedLoad, speedKmh: normalizedSpeedKmh});
    setParamTarget(this.outputGain.gain, enabled ? (bank ? 0.18 : 0.12) : 0.0001, now, 0.04);
    return {rpm, load: normalizedLoad, speedKmh: normalizedSpeedKmh, bankLayers: bank?.layers.length ?? 0, state: this.state, routing: this.routingSnapshot()};
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.bank) {
      this.setBankRoute(this.enabled && this.state === 'ready');
      this.setCompatibilityRoute(this.enabled && this.state === 'ready');
    } else {
      this.setProceduralRoute(this.enabled && this.state !== 'garage' && this.state !== 'disposed');
      this.setCompatibilityRoute(false);
    }
    this.update({enabled: this.enabled});
  }

  enterGarage() {
    this.requestId += 1;
    this.cancelPending();
    this.detachBank();
    this.state = 'garage';
    this.setEnabled(false);
    this.runtime.emit({type: 'vehicle-garage', vehicleId: this.id});
  }

  async reenter() {
    this.enabled = this.runtime.enabled;
    if (!this.profile) {
      this.state = 'procedural';
      this.resolution = {mode: 'procedural', bankId: null, reason: 'no selected profile'};
      this.setProceduralRoute(this.enabled);
      return {state: this.state, resolution: this.resolution};
    }
    return this.setProfile(this.profile, this.runtime.bankDocument);
  }

  snapshot() {
    return {
      id: this.id,
      profileId: this.profile?.id ?? null,
      state: this.state,
      resolution: {...this.resolution},
      bankId: this.bank?.id ?? null,
      bankFamily: this.bank?.family ?? null,
      bankLayerCount: this.bank?.layers.length ?? 0,
      proceduralSourceCount: this.proceduralSources.length,
      compatibilitySourceCount: this.compatibilitySources.length,
      routing: this.routingSnapshot(),
      pending: Boolean(this.pendingLease),
      requestId: this.requestId,
    };
  }

  routingSnapshot() {
    return {
      procedural: {
        connected: this.proceduralBusConnected,
        enabled: this.proceduralRouteEnabled,
        busGain: Number(this.proceduralBus?.gain?.value ?? 0),
        sourceCount: this.proceduralSources.length,
        audibleSourceCount: this.lastProceduralActiveSourceCount,
      },
      bank: {
        connected: this.bankBusConnected,
        enabled: this.bankRouteEnabled,
        busGain: Number(this.bankBus?.gain?.value ?? 0),
        sourceCount: this.bank?.layers.length ?? 0,
        audibleSourceCount: this.lastBankActiveLayerCount,
      },
      compatibility: {
        connected: this.compatibilityBusConnected,
        enabled: this.compatibilityRouteEnabled,
        busGain: Number(this.compatibilityBus?.gain?.value ?? 0),
        sourceCount: this.compatibilitySources.length,
        audibleSourceCount: this.lastCompatibilityActiveSourceCount,
        overlayMode: this.compatibilityOverlay?.mode ?? 'none',
        reason: this.compatibilityRouteReason,
        physical: this.compatibilityConfig.physical,
        signals: [...this.compatibilityConfig.signals],
      },
      effectiveAudibleSourceCount: this.lastProceduralActiveSourceCount + this.lastBankActiveLayerCount + this.lastCompatibilityActiveSourceCount,
    };
  }

  dispose() {
    this.requestId += 1;
    this.cancelPending();
    this.setProceduralRoute(false);
    this.setBankRoute(false);
    this.detachBank();
    for (const source of this.proceduralSources) {
      try { source.stop(); } catch (_) { /* already stopped */ }
      try { source.disconnect(); } catch (_) { /* already disconnected */ }
    }
    for (const gain of this.proceduralGains) {
      try { gain.disconnect(); } catch (_) { /* already disconnected */ }
    }
    this.setCompatibilityRoute(false);
    for (const source of this.compatibilitySources) {
      try { source.stop(); } catch (_) { /* already stopped */ }
      try { source.disconnect(); } catch (_) { /* already disconnected */ }
    }
    for (const gain of this.compatibilityGains) {
      try { gain.disconnect(); } catch (_) { /* already disconnected */ }
    }
    try { this.compatibilityBus?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this.bankBus.disconnect(); } catch (_) { /* already disconnected */ }
    try { this.outputGain.disconnect(); } catch (_) { /* already disconnected */ }
    this.state = 'disposed';
  }
}

export class VehicleAudioRuntime {
  constructor({AudioContextCtor = globalThis.AudioContext, fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined, profiles, banks, onEvent = () => {}} = {}) {
    this.AudioContextCtor = AudioContextCtor;
    this.fetchImpl = fetchImpl;
    this.profileDocument = profiles ?? {profiles: []};
    this.bankDocument = banks ?? {banks: []};
    this.onEvent = onEvent;
    this.context = null;
    this.master = null;
    this.registry = null;
    this.vehicles = new Map();
    this.primaryConfig = null;
    this.primary = null;
    this.enabled = true;
    this.lastTelemetry = null;
    this.disposed = false;
  }

  emit(event) {
    try { this.onEvent({...event, at: Date.now()}); } catch (_) { /* telemetry must not break audio */ }
  }

  async init() {
    if (this.disposed) throw new Error('VehicleAudioRuntime is disposed');
    if (!this.context) {
      if (!this.AudioContextCtor) throw new Error('AudioContext is unavailable');
      this.context = new this.AudioContextCtor({latencyHint: 'interactive'});
      this.master = this.context.createGain();
      this.master.gain.value = 0.12;
      this.master.connect(this.context.destination);
      this.registry = new DecodedBankRegistry({context: this.context, fetchImpl: this.fetchImpl, onEvent: (event) => this.emit(event)});
      if (!this.primary) {
        this.primary = new AudioVehicleNode(this, 'player');
        this.vehicles.set('player', this.primary);
      }
      this.emit({type: 'context-created', sampleRate: this.context.sampleRate});
    }
    if (this.context.state !== 'running') await this.context.resume();
    if (this.primaryConfig && !this.primary.profile) {
      await this._setPrimaryVehicle(this.primaryConfig);
    }
    return this.context.state;
  }

  setVehicle(config) {
    this.primaryConfig = config;
    if (!this.context) return Promise.resolve({state: 'pending', profileId: config?.id ?? null});
    return this._setPrimaryVehicle(config);
  }

  async _setPrimaryVehicle(config) {
    const profile = resolveVehicleAudioProfile(config, this.profileDocument);
    if (!this.primary) {
      this.primary = new AudioVehicleNode(this, 'player', profile);
      this.vehicles.set('player', this.primary);
    }
    this.primaryConfig = config;
    this.primary.enabled = this.enabled;
    const result = await this.primary.setProfile(profile, this.bankDocument);
    if (this.lastTelemetry) this.primary.update(this.lastTelemetry);
    return result;
  }

  async setVehicleFor(id, config) {
    await this.init();
    let vehicle = this.vehicles.get(id);
    if (!vehicle) {
      vehicle = new AudioVehicleNode(this, id);
      this.vehicles.set(id, vehicle);
    }
    vehicle.enabled = this.enabled;
    return vehicle.setProfile(resolveVehicleAudioProfile(config, this.profileDocument), this.bankDocument);
  }

  update(telemetry) {
    this.lastTelemetry = telemetry;
    if (!this.primary || !this.context) return null;
    return this.primary.update(telemetry);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    for (const vehicle of this.vehicles.values()) vehicle.setEnabled(this.enabled);
  }

  enterGarage(id = 'player') {
    if (id === null) {
      for (const vehicle of this.vehicles.values()) vehicle.enterGarage();
      return;
    }
    this.vehicles.get(id)?.enterGarage();
  }

  async reenter(id = 'player') {
    await this.init();
    if (id === null) {
      return Promise.all([...this.vehicles.values()].map((vehicle) => vehicle.reenter()));
    }
    return this.vehicles.get(id)?.reenter();
  }

  bindPageTeardown(target = globalThis) {
    if (!target?.addEventListener) return () => {};
    const handler = () => { this.dispose(); };
    target.addEventListener('pagehide', handler, {once: true});
    target.addEventListener('beforeunload', handler, {once: true});
    return () => {
      target.removeEventListener?.('pagehide', handler);
      target.removeEventListener?.('beforeunload', handler);
    };
  }

  snapshot() {
    return {
      context: this.context ? {state: this.context.state, sampleRate: this.context.sampleRate, baseLatency: this.context.baseLatency ?? null} : null,
      registry: this.registry?.snapshot() ?? null,
      vehicles: [...this.vehicles.values()].map((vehicle) => vehicle.snapshot()),
      disposed: this.disposed,
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const vehicle of this.vehicles.values()) vehicle.dispose();
    this.vehicles.clear();
    this.registry?.dispose();
    try { this.master?.disconnect(); } catch (_) { /* already disconnected */ }
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.emit({type: 'runtime-disposed'});
  }
}
