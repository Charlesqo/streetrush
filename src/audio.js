import { AudioBankCoordinator } from './audio-bank-coordinator.js';
import { createDecodedAudioBankLoader } from './audio-bank-loader.js';
import { LayeredEngineBankPlayer } from './layered-engine-bank.js';

const CONTEXT_RESUME_RETRY_MS = 500;
const AUDIO_MIN_GAIN = 0.0001;
const AUDIO_GATE_TIME_CONSTANT = 0.06;

export class ProceduralAudio {
  constructor({
    bankDocument = { banks: [] },
    resolveBankProfile = null,
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    onBankEvent = () => {},
  } = {}) {
    this.context = null;
    this.enabled = true;
    this.config = null;
    this.nodes = null;
    this.contextResumePromise = null;
    this.lastContextResumeAt = -Infinity;
    this.contextStateChangeHandler = null;
    this.paused = false;
    this.bankDocument = bankDocument;
    this.resolveBankProfile = resolveBankProfile;
    this.fetchImpl = fetchImpl;
    this.onBankEvent = onBankEvent;
    this.bankCoordinator = null;
    this.bankPlayer = null;
    this.bankRequestId = 0;
    this.bankSelectionPromise = Promise.resolve(null);
    this.bankState = {
      state: typeof resolveBankProfile === 'function' ? 'pending-init' : 'disabled',
      resolution: { mode: 'procedural', bankId: null, reason: 'bank runtime not initialized' },
      error: null,
    };
    this.previousTelemetry = {
      gear: null,
      reverse: false,
      lastShiftAt: -Infinity,
    };
  }

  setVehicle(config) {
    this.config = config;
    if (!this.nodes || !config) return Promise.resolve(this.snapshot().bank);
    const now = this.context.currentTime;
    const profile = config.audio;
    this.nodes.osc.type = profile.family === 'i4' ? 'square' : 'sawtooth';
    this.nodes.resonators.forEach((filter, index) => {
      filter.frequency.setTargetAtTime([profile.low, profile.mid, profile.high][index], now, 0.08);
      filter.Q.setTargetAtTime([1.2, 1.45, 1.15][index], now, 0.08);
    });
    this.nodes.drive.curve = this.makeDriveCurve(profile.drive);
    this.previousTelemetry.gear = null;
    this.previousTelemetry.reverse = false;
    return this.selectVehicleBank(config);
  }

  initializeBankRuntime() {
    if (typeof this.resolveBankProfile !== 'function' || !this.bankDocument?.banks?.length) return;
    const loadBank = createDecodedAudioBankLoader({
      context: this.context,
      fetchImpl: this.fetchImpl,
    });
    this.bankPlayer = new LayeredEngineBankPlayer({
      context: this.context,
      destination: this.nodes.master,
    });
    this.bankCoordinator = new AudioBankCoordinator({
      loadBank,
      onEvent: (event) => {
        try { this.onBankEvent(event); } catch { /* observability must not alter audio */ }
      },
    });
    this.bankState = {
      state: 'procedural',
      resolution: { mode: 'procedural', bankId: null, reason: 'no vehicle selected' },
      error: null,
    };
  }

  selectVehicleBank(config) {
    if (!this.bankCoordinator || !this.bankPlayer || typeof this.resolveBankProfile !== 'function') {
      return Promise.resolve(this.snapshot().bank);
    }
    const requestId = ++this.bankRequestId;
    this.bankPlayer.detach();
    this.bankState = {
      state: 'loading',
      resolution: { mode: 'procedural', bankId: null, reason: 'selecting vehicle bank' },
      error: null,
    };
    let profile;
    try {
      profile = this.resolveBankProfile(config);
    } catch (error) {
      this.bankCoordinator.releaseActive();
      this.bankState = {
        state: 'degraded',
        resolution: { mode: 'procedural', bankId: null, reason: 'profile resolution failed' },
        error: String(error),
      };
      this.bankSelectionPromise = Promise.resolve(this.snapshot().bank);
      return this.bankSelectionPromise;
    }
    const selection = this.bankCoordinator.setProfile(profile, this.bankDocument)
      .then((snapshot) => {
        if (requestId !== this.bankRequestId) return this.snapshot().bank;
        if (snapshot.state === 'ready' && this.bankCoordinator.active?.value) {
          try {
            this.bankPlayer.attach(this.bankCoordinator.active.value);
            this.bankPlayer.setEnabled(this.enabled);
            this.bankState = { state: 'ready', resolution: snapshot.resolution, error: null };
          } catch (error) {
            this.bankCoordinator.releaseActive();
            this.bankState = {
              state: 'degraded',
              resolution: { ...snapshot.resolution, mode: 'procedural', reason: 'player attach failed' },
              error: String(error),
            };
          }
        } else {
          this.bankState = {
            state: snapshot.state,
            resolution: snapshot.resolution,
            error: snapshot.resolution?.fallbackError ?? null,
          };
        }
        return this.snapshot().bank;
      }, (error) => {
        if (requestId !== this.bankRequestId) return this.snapshot().bank;
        this.bankState = {
          state: 'degraded',
          resolution: { mode: 'procedural', bankId: null, reason: 'bank selection failed' },
          error: String(error),
        };
        return this.snapshot().bank;
      });
    this.bankSelectionPromise = selection;
    return selection;
  }

  whenBankSettled() {
    return this.bankSelectionPromise;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      paused: this.paused,
      contextState: this.context?.state ?? null,
      bank: {
        ...this.bankState,
        player: this.bankPlayer?.snapshot() ?? null,
        coordinator: this.bankCoordinator?.snapshot() ?? null,
      },
    };
  }

  makeDriveCurve(amount = 1.3) {
    const curve = new Float32Array(512);
    for (let i = 0; i < curve.length; i += 1) {
      const x = i / (curve.length - 1) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  makeNoiseBuffer(context) {
    const length = context.sampleRate * 2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.82 + white * 0.18;
      data[i] = previous;
    }
    return buffer;
  }

  resumeContext(force = false) {
    const context = this.context;
    if (this.contextResumePromise) return this.contextResumePromise;
    if (!context || context.state === 'closed' || context.state === 'running') return Promise.resolve(false);
    const canResume = context.state === 'suspended' || context.state === 'interrupted';
    if (!force && !canResume) return Promise.resolve(false);

    const now = Date.now();
    if (!force && now - this.lastContextResumeAt < CONTEXT_RESUME_RETRY_MS) return Promise.resolve(false);
    this.lastContextResumeAt = now;

    let resumeResult;
    try {
      resumeResult = context.resume();
    } catch {
      return Promise.resolve(false);
    }

    this.contextResumePromise = Promise.resolve(resumeResult)
      .then(() => true, () => false)
      .finally(() => {
        this.contextResumePromise = null;
      });
    return this.contextResumePromise;
  }

  async init() {
    if (this.context) {
      await this.resumeContext();
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor({ latencyHint: 'interactive' });
    this.context = context;
    this.contextStateChangeHandler = () => {
      this.resumeContext();
    };
    context.addEventListener?.('statechange', this.contextStateChangeHandler);
    const master = context.createGain();
    master.gain.value = this.enabled ? 0.28 : AUDIO_MIN_GAIN;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.16;
    const pauseGate = context.createGain();
    pauseGate.gain.value = this.paused ? AUDIO_MIN_GAIN : 1;
    master.connect(compressor).connect(pauseGate).connect(context.destination);

    const sourceBus = context.createGain();
    const osc = context.createOscillator();
    const sub = context.createOscillator();
    const mechanical = context.createOscillator();
    const oscGain = context.createGain();
    const subGain = context.createGain();
    const mechanicalGain = context.createGain();
    oscGain.gain.value = 0.34;
    subGain.gain.value = 0.22;
    mechanicalGain.gain.value = 0.035;
    osc.type = 'sawtooth';
    sub.type = 'triangle';
    mechanical.type = 'square';
    osc.connect(oscGain).connect(sourceBus);
    sub.connect(subGain).connect(sourceBus);
    mechanical.connect(mechanicalGain).connect(sourceBus);

    const engineGain = context.createGain();
    const drive = context.createWaveShaper();
    drive.oversample = '2x';
    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3800;
    tone.Q.value = 0.55;
    sourceBus.connect(drive).connect(tone).connect(engineGain).connect(master);

    const resonators = [0, 1, 2].map(() => {
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      sourceBus.connect(filter);
      return filter;
    });
    const resonanceGains = resonators.map((filter, index) => {
      const gain = context.createGain();
      gain.gain.value = [0.32, 0.14, 0.055][index];
      filter.connect(gain).connect(engineGain);
      return gain;
    });

    const noise = context.createBufferSource();
    noise.buffer = this.makeNoiseBuffer(context);
    noise.loop = true;
    const exhaustNoiseFilter = context.createBiquadFilter();
    exhaustNoiseFilter.type = 'bandpass';
    exhaustNoiseFilter.frequency.value = 1850;
    exhaustNoiseFilter.Q.value = 0.62;
    const exhaustNoiseGain = context.createGain();
    noise.connect(exhaustNoiseFilter).connect(exhaustNoiseGain).connect(master);
    const roadNoiseFilter = context.createBiquadFilter();
    roadNoiseFilter.type = 'highpass';
    roadNoiseFilter.frequency.value = 620;
    const roadNoiseGain = context.createGain();
    noise.connect(roadNoiseFilter).connect(roadNoiseGain).connect(master);
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'highpass';
    windFilter.frequency.value = 2100;
    const windGain = context.createGain();
    noise.connect(windFilter).connect(windGain).connect(master);

    const tireOsc = context.createOscillator();
    tireOsc.type = 'sawtooth';
    const tireFilter = context.createBiquadFilter();
    tireFilter.type = 'bandpass';
    tireFilter.frequency.value = 1180;
    tireFilter.Q.value = 5.5;
    const tireGain = context.createGain();
    tireGain.gain.value = 0.0001;
    tireOsc.connect(tireFilter).connect(tireGain).connect(master);

    engineGain.gain.value = AUDIO_MIN_GAIN;
    exhaustNoiseGain.gain.value = AUDIO_MIN_GAIN;
    roadNoiseGain.gain.value = AUDIO_MIN_GAIN;
    windGain.gain.value = AUDIO_MIN_GAIN;
    osc.start();
    sub.start();
    mechanical.start();
    noise.start();
    tireOsc.start();
    this.nodes = {
      master, pauseGate, osc, sub, mechanical, engineGain, drive, tone, resonators, resonanceGains,
      exhaustNoiseGain, roadNoiseGain, windGain, tireOsc, tireFilter, tireGain,
      noiseBuffer: noise.buffer,
    };
    this.initializeBankRuntime();
    this.setVehicle(this.config);
    await this.resumeContext(true);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.nodes) this.nodes.master.gain.setTargetAtTime(enabled ? 0.28 : AUDIO_MIN_GAIN, this.context.currentTime, 0.04);
    this.bankPlayer?.setEnabled(enabled);
  }

  setPaused(paused) {
    const nextPaused = Boolean(paused);
    if (this.paused === nextPaused) return;
    const wasPaused = this.paused;
    this.paused = nextPaused;
    if (!this.nodes || !this.context) return;
    const now = this.context.currentTime;
    this.nodes.pauseGate.gain.cancelScheduledValues?.(now);
    this.nodes.pauseGate.gain.setTargetAtTime(
      nextPaused ? AUDIO_MIN_GAIN : 1,
      now,
      AUDIO_GATE_TIME_CONSTANT,
    );
    if (wasPaused && !nextPaused) {
      this.previousTelemetry.gear = null;
      this.previousTelemetry.reverse = false;
    }
  }

  playTone(frequency, duration, gain, type = 'sine') {
    if (this.paused || !this.enabled || !this.context || !this.nodes) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(28, frequency * 0.62), now + duration);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + Math.min(0.012, duration * 0.2));
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(envelope).connect(this.nodes.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  playNoiseBurst(duration, gain, centerFrequency = 520) {
    if (this.paused || !this.enabled || !this.context || !this.nodes?.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.nodes.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(centerFrequency, now);
    filter.Q.value = 0.72;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(envelope).connect(this.nodes.master);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  updateTransientEvents(telemetry) {
    if (this.paused) return;
    const now = this.context.currentTime;
    const previous = this.previousTelemetry;
    const shifted = previous.gear !== null
      && (telemetry.gear !== previous.gear || telemetry.reverse !== previous.reverse);
    if (shifted && telemetry.speedKmh > 7 && now - previous.lastShiftAt > 0.12) {
      this.playTone(92 + Math.min(75, telemetry.speedKmh * 0.34), 0.09, 0.026, 'triangle');
      this.playNoiseBurst(0.075, 0.012, 760);
      previous.lastShiftAt = now;
    }

    previous.gear = telemetry.gear;
    previous.reverse = telemetry.reverse;
  }

  update(telemetry) {
    if (this.paused || !this.context || !this.nodes || !this.config || this.context.state === 'closed') return;
    this.resumeContext();
    const now = this.context.currentTime;
    const profile = this.config.audio;
    const rpm = Math.max(this.config.idle, telemetry.rpm);
    const firing = rpm / 60 * profile.cylinders / 2;
    const load = telemetry.throttle;
    const speed = telemetry.speedKmh;
    const averageSlip = telemetry.wheels.reduce((sum, wheel) => sum + Math.abs(wheel.slipRatio) + Math.abs(wheel.slipAngle) * 2, 0) / telemetry.wheels.length;
    const tireDemand = Math.min(1, telemetry.wheels.reduce(
      (peak, wheel) => Math.max(peak, Math.abs(wheel.slipAngle) * 3.8 + wheel.slipPower * 0.42),
      0,
    ));
    const roughSurface = telemetry.surface === 'asphalt' ? 0 : telemetry.surface === 'kerb' ? 0.35 : 0.75;
    this.nodes.osc.frequency.setTargetAtTime(Math.max(24, firing), now, 0.025);
    this.nodes.sub.frequency.setTargetAtTime(Math.max(20, firing * (profile.family === 'flat6' ? 0.66 : 0.5)), now, 0.035);
    this.nodes.mechanical.frequency.setTargetAtTime(Math.max(45, firing * 2.01), now, 0.018);
    this.nodes.tone.frequency.setTargetAtTime(1250 + rpm * 0.31 + load * 950, now, 0.055);
    const idleLevel = speed < 1 ? 0.018 : 0.023;
    const bankActive = this.bankPlayer?.snapshot().state === 'ready';
    this.nodes.engineGain.gain.setTargetAtTime(
      this.enabled && !bankActive ? idleLevel + load * 0.052 : AUDIO_MIN_GAIN,
      now,
      0.045,
    );
    this.bankPlayer?.update({ rpm, load, enabled: this.enabled });
    this.nodes.exhaustNoiseGain.gain.setTargetAtTime(this.enabled ? load * load * 0.011 : 0.0001, now, 0.07);
    this.nodes.roadNoiseGain.gain.setTargetAtTime(this.enabled ? Math.min(0.018, speed / 220 * 0.008 + averageSlip * 0.006 + roughSurface * speed / 180 * 0.009) : 0.0001, now, 0.09);
    this.nodes.windGain.gain.setTargetAtTime(this.enabled && speed > 25 ? Math.pow(speed / 320, 2) * 0.018 : 0.0001, now, 0.12);
    this.nodes.tireOsc.frequency.setTargetAtTime(760 + speed * 4.1 + tireDemand * 520, now, 0.045);
    this.nodes.tireFilter.frequency.setTargetAtTime(1050 + speed * 2.6, now, 0.065);
    this.nodes.tireGain.gain.setTargetAtTime(
      this.enabled && speed > 14 && tireDemand > 0.26
        ? Math.pow((tireDemand - 0.26) / 0.74, 1.35) * 0.018
        : 0.0001,
      now,
      0.035,
    );
    this.updateTransientEvents(telemetry);
  }

  disposeBankRuntime() {
    this.bankRequestId += 1;
    this.bankPlayer?.dispose();
    this.bankPlayer = null;
    this.bankCoordinator?.dispose();
    this.bankCoordinator = null;
    this.bankState = {
      state: 'disposed',
      resolution: { mode: 'procedural', bankId: null, reason: 'audio disposed' },
      error: null,
    };
  }
}
