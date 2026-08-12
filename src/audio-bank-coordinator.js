// Adapted from the selection and request-ownership rules in:
// E:/Codex/autonomous_runs/multi_car_audio/runtime/vehicle-audio-runtime.js
// Source SHA-256: C60A8CC740913ACFD04D1BE3E976428AA1C0C5B6417829D896277F1818621B2A
//
// This module deliberately owns no WebAudio nodes. It is the small contract
// between today's procedural renderer and a future decoded-bank loader.

function normalizedBanks(document) {
  return new Map((document?.banks ?? []).map((bank) => [bank.id, { ...bank }]));
}

// Candidate WAVs are selectable only after their offline loop gate approves
// the bank. Non-candidate source/prototype banks remain explicit fallbacks.
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

  // Compatibility configs are intentionally procedural-only. A family name
  // alone is not enough evidence to select a candidate recording.
  return {
    id: id ?? 'anonymous',
    displayName: config.name ?? id ?? 'anonymous',
    modelFile: config.file ?? null,
    engine: {
      family: config.audio.family,
      cylinders: { value: config.audio.cylinders ?? 4, status: 'unknown' },
      idleRpm: { value: config.idle ?? 900, status: 'unknown' },
      redlineRpm: { value: config.redline ?? 7000, status: 'unknown' },
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
      resolutionNote: 'Compatibility config without an adopted VehicleAudioProfile; procedural fallback only.',
    },
  };
}

export function resolveAudioSelection(profile, bankDocument) {
  const banks = normalizedBanks(bankDocument);
  const rejectedBankIds = [];
  const exactId = profile?.audio?.exactBankId;
  const exact = exactId ? banks.get(exactId) : null;
  if (exact && exact.scope === 'exact' && exact.vehicleId === profile.id) {
    if (isRuntimeEligibleBank(exact)) {
      return { mode: 'exact', bank: exact, reason: 'profile exactBankId', rejectedBankIds };
    }
    rejectedBankIds.push(exact.id);
  }

  for (const bankId of profile?.audio?.familyFallbackBankIds ?? []) {
    const bank = banks.get(bankId);
    if (bank && bank.scope === 'family' && bank.family === profile?.engine?.family) {
      if (isRuntimeEligibleBank(bank)) {
        return { mode: 'family', bank, reason: 'profile familyFallbackBankIds', rejectedBankIds };
      }
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

function disposeLoadedBank(value) {
  try {
    value?.dispose?.();
  } catch {
    // Cleanup failures must not publish a stale bank or hide its outcome.
  }
}

export class AudioBankCoordinator {
  constructor({ loadBank, onEvent = () => {} } = {}) {
    if (typeof loadBank !== 'function') throw new TypeError('AudioBankCoordinator requires loadBank');
    this.loadBank = loadBank;
    this.onEvent = onEvent;
    this.requestId = 0;
    this.profileId = null;
    this.state = 'procedural';
    this.resolution = { mode: 'procedural', bankId: null, reason: 'not selected' };
    this.pending = null;
    this.active = null;
    this.disposed = false;
  }

  emit(event) {
    try {
      this.onEvent({ ...event, requestId: event.requestId ?? this.requestId });
    } catch {
      // Observability must not change audio lifecycle behavior.
    }
  }

  cancelPending() {
    if (!this.pending) return;
    this.pending.controller.abort();
    this.pending = null;
  }

  releaseActive() {
    if (!this.active) return;
    const { bankId, value } = this.active;
    this.active = null;
    disposeLoadedBank(value);
    this.emit({ type: 'bank-released', bankId });
  }

  async setProfile(profile, bankDocument) {
    if (this.disposed) throw new Error('AudioBankCoordinator is disposed');
    const requestId = ++this.requestId;
    this.cancelPending();
    this.releaseActive();
    this.profileId = profile?.id ?? null;

    const selection = resolveAudioSelection(profile, bankDocument);
    const selectedResolution = {
      mode: selection.mode,
      bankId: selection.bank?.id ?? null,
      reason: selection.reason,
      rejectedBankIds: [...selection.rejectedBankIds],
    };
    this.resolution = selectedResolution;
    this.state = selection.mode === 'procedural' ? 'procedural' : 'loading';
    this.emit({
      type: 'bank-selection',
      requestId,
      profileId: this.profileId,
      ...selectedResolution,
    });
    if (!selection.bank) return this.snapshot();

    const controller = new AbortController();
    this.pending = { requestId, bankId: selection.bank.id, controller };
    try {
      const value = await this.loadBank(selection.bank, { signal: controller.signal });
      if (requestId !== this.requestId || controller.signal.aborted || this.disposed) {
        disposeLoadedBank(value);
        this.emit({ type: 'bank-stale-discarded', requestId, bankId: selection.bank.id });
        return { state: 'stale', resolution: selectedResolution, activeBankId: null };
      }
      this.pending = null;
      this.active = { bankId: selection.bank.id, value };
      this.state = 'ready';
      this.emit({ type: 'bank-published', requestId, bankId: selection.bank.id });
      return this.snapshot();
    } catch (error) {
      if (requestId !== this.requestId || controller.signal.aborted || this.disposed) {
        this.emit({ type: 'bank-stale-discarded', requestId, bankId: selection.bank.id });
        return { state: 'stale', resolution: selectedResolution, activeBankId: null };
      }
      this.pending = null;
      const fallback = profile?.audio?.proceduralFallback !== false;
      this.state = fallback ? 'degraded' : 'failed';
      this.resolution = {
        ...selectedResolution,
        mode: fallback ? 'procedural' : selectedResolution.mode,
        fallbackError: String(error),
      };
      this.emit({
        type: 'bank-failed',
        requestId,
        bankId: selection.bank.id,
        fallback,
        error: String(error),
      });
      return this.snapshot();
    }
  }

  snapshot() {
    return {
      profileId: this.profileId,
      state: this.state,
      resolution: { ...this.resolution },
      pendingBankId: this.pending?.bankId ?? null,
      activeBankId: this.active?.bankId ?? null,
      requestId: this.requestId,
      disposed: this.disposed,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.requestId += 1;
    this.cancelPending();
    this.releaseActive();
    this.state = 'disposed';
    this.emit({ type: 'coordinator-disposed' });
  }
}
