export class ProceduralAudio {
  constructor() {
    this.context = null;
    this.enabled = true;
    this.config = null;
    this.nodes = null;
    this.previousTelemetry = {
      gear: null,
      reverse: false,
      lastShiftAt: -Infinity,
    };
  }

  setVehicle(config) {
    this.config = config;
    if (!this.nodes) return;
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

  async init() {
    if (this.context) {
      await this.context.resume();
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor({ latencyHint: 'interactive' });
    this.context = context;
    const master = context.createGain();
    master.gain.value = 0.28;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.16;
    master.connect(compressor).connect(context.destination);

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

    engineGain.gain.value = 0.0001;
    exhaustNoiseGain.gain.value = 0.0001;
    roadNoiseGain.gain.value = 0.0001;
    windGain.gain.value = 0.0001;
    osc.start();
    sub.start();
    mechanical.start();
    noise.start();
    tireOsc.start();
    this.nodes = {
      master, osc, sub, mechanical, engineGain, drive, tone, resonators, resonanceGains,
      exhaustNoiseGain, roadNoiseGain, windGain, tireOsc, tireFilter, tireGain,
      noiseBuffer: noise.buffer,
    };
    this.setVehicle(this.config);
    await context.resume();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.nodes) this.nodes.master.gain.setTargetAtTime(enabled ? 0.28 : 0.0001, this.context.currentTime, 0.04);
  }

  playTone(frequency, duration, gain, type = 'sine') {
    if (!this.enabled || !this.context || !this.nodes) return;
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
    if (!this.enabled || !this.context || !this.nodes?.noiseBuffer) return;
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
    if (!this.context || !this.nodes || !this.config) return;
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
    this.nodes.engineGain.gain.setTargetAtTime(this.enabled ? idleLevel + load * 0.052 : 0.0001, now, 0.045);
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
}
