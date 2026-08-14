const MIN_GAIN = 0.0001;
const RPM_RATE_MIN = 0.45;
const RPM_RATE_MAX = 1.55;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function setTarget(param, value, now, timeConstant) {
  if (typeof param?.setTargetAtTime === 'function') param.setTargetAtTime(value, now, timeConstant);
  else if (param) param.value = value;
}

function stopAndDisconnect(layer) {
  try { layer.source.stop(); } catch { /* source may already be stopped */ }
  try { layer.source.disconnect(); } catch { /* optional in test doubles */ }
  try { layer.gain.disconnect(); } catch { /* optional in test doubles */ }
}

function validateDecodedBank(value) {
  if (!value || typeof value.id !== 'string' || !Array.isArray(value.layers) || value.layers.length === 0) {
    throw new TypeError('LayeredEngineBankPlayer requires a decoded bank with layers');
  }
  const candidate = value.id.startsWith('bank.candidate.');
  if (candidate && (
    value.quality !== 'candidate-loop-approved'
    || value.loop?.status !== 'approved'
    || value.loop?.loopApproved !== true
  )) throw new Error(`${value.id} bank loop is not approved`);
  for (const layer of value.layers) {
    const duration = Number(layer?.buffer?.duration);
    if (!layer || !Number.isFinite(layer.rpm) || layer.rpm <= 0
      || !['on', 'off'].includes(layer.mode)
      || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(`${value.id} has an invalid decoded layer`);
    }
    if (candidate && (layer.loop?.status !== 'approved' || layer.loop?.loopApproved !== true)) {
      throw new Error(`${value.id}/${layer.file ?? 'layer'} loop is not approved`);
    }
  }
}

export class LayeredEngineBankPlayer {
  constructor({ context, destination }) {
    if (!context || typeof context.createBufferSource !== 'function' || typeof context.createGain !== 'function') {
      throw new TypeError('LayeredEngineBankPlayer requires an AudioContext-like object');
    }
    if (!destination) throw new TypeError('LayeredEngineBankPlayer requires a destination node');
    this.context = context;
    this.destination = destination;
    this.bus = context.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(destination);
    this.bank = null;
    this.enabled = true;
    this.disposed = false;
    this.lastActiveLayerCount = 0;
  }

  attach(value) {
    if (this.disposed) throw new Error('LayeredEngineBankPlayer is disposed');
    validateDecodedBank(value);
    this.detach();
    const candidate = value.id.startsWith('bank.candidate.');
    const layers = [];
    try {
      for (const layer of value.layers) {
        const source = this.context.createBufferSource();
        const gain = this.context.createGain();
        source.buffer = layer.buffer;
        source.loop = true;
        const loop = candidate ? layer.loop : (layer.loop ?? value.loop);
        source.loopStart = clamp(Number(loop?.loopStart ?? 0), 0, source.buffer.duration);
        source.loopEnd = clamp(
          Number(loop?.loopEnd ?? source.buffer.duration),
          source.loopStart,
          source.buffer.duration,
        );
        gain.gain.value = 0;
        source.connect(gain).connect(this.bus);
        source.start();
        layers.push({ ...layer, source, gain });
      }
    } catch (error) {
      for (const layer of layers) stopAndDisconnect(layer);
      throw error;
    }
    this.bank = {
      id: value.id,
      family: value.family ?? null,
      layers,
    };
    this.lastActiveLayerCount = 0;
    return this.snapshot();
  }

  update({ rpm = 1200, load = 0, enabled = this.enabled } = {}) {
    if (!this.bank || this.disposed) return this.snapshot();
    const finiteRpm = Number.isFinite(rpm) ? Math.max(1, rpm) : 1200;
    const normalizedLoad = clamp(Number.isFinite(load) ? load : 0, 0, 1);
    const anchors = [...new Set(this.bank.layers.map((layer) => layer.rpm))].sort((a, b) => a - b);
    const rpmWeights = new Map();
    if (finiteRpm <= anchors[0]) rpmWeights.set(anchors[0], 1);
    else if (finiteRpm >= anchors.at(-1)) rpmWeights.set(anchors.at(-1), 1);
    else {
      for (let index = 0; index < anchors.length - 1; index += 1) {
        const low = anchors[index];
        const high = anchors[index + 1];
        if (finiteRpm >= low && finiteRpm <= high) {
          const mix = (finiteRpm - low) / (high - low);
          rpmWeights.set(low, Math.cos(mix * Math.PI * 0.5));
          rpmWeights.set(high, Math.sin(mix * Math.PI * 0.5));
          break;
        }
      }
    }
    const audible = Boolean(enabled) && this.enabled;
    const onWeight = Math.sqrt(normalizedLoad);
    const offWeight = Math.sqrt(1 - normalizedLoad);
    const now = this.context.currentTime;
    let activeLayerCount = 0;
    for (const layer of this.bank.layers) {
      const rpmWeight = rpmWeights.get(layer.rpm) ?? 0;
      const loadWeight = layer.mode === 'on' ? onWeight : offWeight;
      const level = audible ? Math.max(0, rpmWeight * loadWeight * 0.72) : 0;
      if (level > MIN_GAIN) activeLayerCount += 1;
      setTarget(layer.gain.gain, level, now, 0.045);
      setTarget(layer.source.playbackRate, clamp(finiteRpm / layer.rpm, RPM_RATE_MIN, RPM_RATE_MAX), now, 0.035);
    }
    this.lastActiveLayerCount = activeLayerCount;
    return this.snapshot();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    setTarget(this.bus.gain, this.enabled ? 1 : MIN_GAIN, this.context.currentTime, 0.04);
    if (!this.enabled) this.update({ enabled: false });
  }

  detach() {
    if (this.bank) {
      for (const layer of this.bank.layers) stopAndDisconnect(layer);
    }
    this.bank = null;
    this.lastActiveLayerCount = 0;
  }

  snapshot() {
    return {
      state: this.disposed ? 'disposed' : this.bank ? 'ready' : 'empty',
      bankId: this.bank?.id ?? null,
      layerCount: this.bank?.layers.length ?? 0,
      activeLayerCount: this.lastActiveLayerCount,
      enabled: this.enabled,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.detach();
    try { this.bus.disconnect(); } catch { /* optional in test doubles */ }
    this.disposed = true;
  }
}
