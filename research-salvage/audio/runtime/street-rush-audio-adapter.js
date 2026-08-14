import {VehicleAudioRuntime} from './vehicle-audio-runtime.js';

async function loadDocument(value, url, fetchImpl) {
  if (value && typeof value === 'object') return value;
  const response = await fetchImpl(url, {cache: 'no-store'});
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

/**
 * Small compatibility layer for street-rush/src/main.js.
 *
 * Existing call sites can keep setVehicle/init/update/setEnabled. The adapter
 * owns only data loading and the pending-before-init state; all audio policy,
 * bank selection, lifecycle, and teardown stay in VehicleAudioRuntime.
 */
export class StreetRushAudioAdapter {
  constructor({
    profiles = null,
    banks = null,
    profileUrl = '/audio-data/vehicle-audio-profiles.json',
    bankUrl = '/audio-data/audio-bank-manifest.json',
    AudioContextCtor = globalThis.AudioContext,
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    onEvent = () => {},
  } = {}) {
    this.profiles = profiles;
    this.banks = banks;
    this.profileUrl = profileUrl;
    this.bankUrl = bankUrl;
    this.AudioContextCtor = AudioContextCtor;
    this.fetchImpl = fetchImpl;
    this.onEvent = onEvent;
    this.runtime = null;
    this.pendingConfig = null;
    this.enabled = true;
    this.initPromise = null;
    this.teardownTarget = null;
    this.teardownCleanup = null;
  }

  setVehicle(config) {
    this.pendingConfig = config;
    if (!this.runtime) return Promise.resolve({state: 'pending', profileId: config?.id ?? null});
    return this.runtime.setVehicle(config);
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const [profiles, banks] = await Promise.all([
        loadDocument(this.profiles, this.profileUrl, this.fetchImpl),
        loadDocument(this.banks, this.bankUrl, this.fetchImpl),
      ]);
      this.profiles = profiles;
      this.banks = banks;
      this.runtime = new VehicleAudioRuntime({
        AudioContextCtor: this.AudioContextCtor,
        fetchImpl: this.fetchImpl,
        profiles,
        banks,
        onEvent: this.onEvent,
      });
      if (this.teardownTarget) this.teardownCleanup = this.runtime.bindPageTeardown(this.teardownTarget);
      const state = await this.runtime.init();
      this.runtime.setEnabled(this.enabled);
      if (this.pendingConfig) await this.runtime.setVehicle(this.pendingConfig);
      return state;
    })();
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  update(telemetry) {
    return this.runtime?.update(telemetry) ?? null;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.runtime?.setEnabled(this.enabled);
  }

  enterGarage(id = 'player') {
    return this.runtime?.enterGarage(id);
  }

  reenter(id = 'player') {
    return this.runtime?.reenter(id);
  }

  bindPageTeardown(target = globalThis) {
    this.teardownCleanup?.();
    this.teardownCleanup = null;
    this.teardownTarget = target;
    if (this.runtime) {
      this.teardownCleanup = this.runtime.bindPageTeardown(target);
      return this.teardownCleanup;
    }
    return () => {
      if (this.teardownTarget === target) this.teardownTarget = null;
    };
  }

  async dispose() {
    this.teardownCleanup?.();
    this.teardownCleanup = null;
    this.teardownTarget = null;
    await this.runtime?.dispose();
    this.runtime = null;
    this.initPromise = null;
  }

  snapshot() {
    return this.runtime?.snapshot() ?? {context: null, registry: null, vehicles: [], disposed: false};
  }
}
