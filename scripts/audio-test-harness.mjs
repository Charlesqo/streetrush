export class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.targets = [];
    this.cancelCalls = [];
  }

  setTargetAtTime(value, startTime, timeConstant) {
    this.value = value;
    this.targets.push({ value, startTime, timeConstant });
  }

  setValueAtTime(value, startTime) {
    this.value = value;
    this.targets.push({ value, startTime });
  }

  exponentialRampToValueAtTime(value, endTime) {
    this.value = value;
    this.targets.push({ value, endTime });
  }

  cancelScheduledValues(startTime) {
    this.cancelCalls.push(startTime);
  }
}

export class FakeAudioNode {
  constructor() {
    this.connections = [];
    this.gain = new FakeAudioParam();
    this.frequency = new FakeAudioParam();
    this.playbackRate = new FakeAudioParam(1);
    this.Q = new FakeAudioParam();
    this.threshold = new FakeAudioParam();
    this.knee = new FakeAudioParam();
    this.ratio = new FakeAudioParam();
    this.attack = new FakeAudioParam();
    this.release = new FakeAudioParam();
    this.startCalls = 0;
    this.stopCalls = 0;
    this.disconnectCalls = 0;
  }

  connect(node) {
    this.connections.push(node);
    return node;
  }

  start() {
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connections.length = 0;
  }
}

class FakeAudioBuffer {
  constructor(length, sampleRate) {
    this.data = new Float32Array(length);
    this.duration = length / sampleRate;
  }

  getChannelData() {
    return this.data;
  }
}

export class FakeAudioContext {
  static instances = [];
  static resumeBehaviorFactory = null;

  constructor() {
    this.state = 'suspended';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = new FakeAudioNode();
    this.listeners = new Map();
    this.resumeCalls = 0;
    this.createdOscillators = [];
    this.createdBufferSources = [];
    const resumeBehaviorFactory = FakeAudioContext.resumeBehaviorFactory;
    FakeAudioContext.resumeBehaviorFactory = null;
    this.resumeBehavior = resumeBehaviorFactory
      ? () => resumeBehaviorFactory(this)
      : () => {
        this.state = 'running';
        this.dispatch('statechange');
        return Promise.resolve();
      };
    FakeAudioContext.instances.push(this);
  }

  static reset() {
    FakeAudioContext.instances.length = 0;
    FakeAudioContext.resumeBehaviorFactory = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this });
  }

  suspendForTest() {
    this.state = 'suspended';
    this.dispatch('statechange');
  }

  resume() {
    this.resumeCalls += 1;
    return this.resumeBehavior();
  }

  createGain() {
    return new FakeAudioNode();
  }

  createDynamicsCompressor() {
    return new FakeAudioNode();
  }

  createOscillator() {
    const oscillator = new FakeAudioNode();
    this.createdOscillators.push(oscillator);
    return oscillator;
  }

  createWaveShaper() {
    return new FakeAudioNode();
  }

  createBiquadFilter() {
    return new FakeAudioNode();
  }

  createBufferSource() {
    const source = new FakeAudioNode();
    source.loop = false;
    source.buffer = null;
    this.createdBufferSources.push(source);
    return source;
  }

  createBuffer(_channels, length) {
    return new FakeAudioBuffer(length, this.sampleRate);
  }

  async decodeAudioData(bytes) {
    return {
      duration: 2.5,
      byteLength: bytes.byteLength,
    };
  }
}

export const vehicleConfig = {
  idle: 900,
  audio: {
    family: 'i4',
    cylinders: 4,
    low: 120,
    mid: 900,
    high: 2400,
    drive: 1.3,
  },
};

export const telemetry = {
  gear: 1,
  reverse: false,
  rpm: 1600,
  throttle: 0.35,
  speedKmh: 24,
  surface: 'asphalt',
  wheels: [{ slipRatio: 0, slipAngle: 0, slipPower: 0 }],
};

export function installFakeAudioWindow() {
  const previousWindow = globalThis.window;
  globalThis.window = { AudioContext: FakeAudioContext };
  return () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  };
}
