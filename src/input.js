import * as THREE from 'three';

const INTERACTIVE_KEYBOARD_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
const GAMEPLAY_PREVENT_DEFAULT_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
const GAMEPAD_STICK_DEADZONE = 0.08;
const GAMEPAD_BUTTON_DEADZONE = 0.05;
const GAMEPAD_INPUT_BUTTONS = [0, 3, 4, 5, 6, 7];
const FIXED_PULSE_CODES = [
  'KeyE',
  'KeyQ',
  'KeyC',
  'KeyR',
  'PadShiftUp',
  'PadShiftDown',
  'PadReset',
  'TouchShiftUp',
  'TouchShiftDown',
  'TouchTransmission',
  'TouchReset',
];

function gamepadButtonIsActive(pad, index) {
  const button = pad?.buttons?.[index];
  return Boolean(button?.pressed) || (button?.value || 0) > GAMEPAD_BUTTON_DEADZONE;
}

function gamepadHasInput(pad) {
  const axis = pad?.axes?.[0] || 0;
  return Math.abs(axis) > GAMEPAD_STICK_DEADZONE
    || GAMEPAD_INPUT_BUTTONS.some((index) => gamepadButtonIsActive(pad, index));
}

function isInteractiveKeyboardTarget(target) {
  if (!target) return false;
  if (target.isContentEditable || target.contentEditable === 'true' || target.contentEditable === 'plaintext-only') {
    return true;
  }

  const tagName = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
  if (INTERACTIVE_KEYBOARD_TAGS.has(tagName)) return true;

  return typeof target.closest === 'function'
    && Boolean(target.closest('button, a, input, textarea, select, [contenteditable]'));
}

function shouldIgnoreKeyboardShortcut(event) {
  return Boolean(event.ctrlKey || event.metaKey || event.altKey || isInteractiveKeyboardTarget(event.target));
}

export function updateKeyboardSteer(current, rawSteer, speedKmh, dt) {
  const highSpeed = THREE.MathUtils.clamp(speedKmh / 240, 0, 1);
  const keyboardTravel = THREE.MathUtils.lerp(1, 0.48, THREE.MathUtils.clamp(speedKmh / 190, 0, 1));
  const targetSteer = rawSteer * keyboardTravel;
  const turningRate = THREE.MathUtils.lerp(1.75, 0.72, highSpeed);
  const centeringRate = THREE.MathUtils.lerp(3.4, 2.25, highSpeed);
  const reversingDirection = targetSteer !== 0 && Math.sign(targetSteer) !== Math.sign(current);
  const rate = targetSteer === 0 || reversingDirection ? centeringRate : turningRate;
  const maximumChange = rate * dt;
  return current + THREE.MathUtils.clamp(targetSteer - current, -maximumChange, maximumChange);
}

export function updatePedal(current, target, riseRate, releaseRate, dt) {
  return THREE.MathUtils.damp(current, target, target > current ? riseRate : releaseRate, dt);
}

export function resolveDriveIntent(rawThrottle, rawBrake) {
  const forward = rawThrottle > 0.05;
  const reverse = rawBrake > 0.05;
  if (forward && !reverse) return 1;
  if (reverse && !forward) return -1;
  if (forward && reverse) {
    if (rawThrottle > rawBrake + 0.05) return 1;
    if (rawBrake > rawThrottle + 0.05) return -1;
  }
  return 0;
}

export class InputController {
  constructor() {
    this.keys = new Set();
    this.keyboardRearm = new Set();
    this.frame = {
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: 0,
      shiftUp: false,
      shiftDown: false,
      toggleTransmission: false,
      reset: false,
      driveIntent: 0,
    };
    this.pulses = new Set();
    this.padButtons = { up: false, down: false, reset: false };
    this.gamepadRearmPending = false;
    this.gamepadConnected = false;
    this.gamepad = null;
    this.touchPointerResets = new Set();
    this.pointerCaptures = new Map();
    this.touchPointerRearm = new Set();
    this.touchKeyboardReleases = new Set();
    this.touch = {
      enabled: false,
      steerLeft: 0,
      steerRight: 0,
      throttle: 0,
      brake: 0,
      handbrake: 0,
    };
    this.onKeyDown = (event) => {
      if (shouldIgnoreKeyboardShortcut(event)) {
        this.keys.delete(event.code);
        this.pulses.delete(event.code);
        return;
      }
      if (GAMEPLAY_PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
      if (this.keyboardRearm.has(event.code)) return;
      const alreadyDown = this.keys.has(event.code);
      if (event.repeat && !alreadyDown) return;
      this.keys.add(event.code);
      if (!event.repeat && !alreadyDown) this.pulses.add(event.code);
    };
    this.onKeyUp = (event) => {
      this.keys.delete(event.code);
      this.keyboardRearm.delete(event.code);
      for (const release of this.touchKeyboardReleases) release(event.code);
    };
    this.releaseAll = () => {
      for (const code of this.keys) this.keyboardRearm.add(code);
      this.keys.clear();
      this.pulses.clear();
      this.frame.steer = 0;
      this.frame.throttle = 0;
      this.frame.brake = 0;
      this.frame.handbrake = 0;
      this.frame.shiftUp = false;
      this.frame.shiftDown = false;
      this.frame.toggleTransmission = false;
      this.frame.reset = false;
      this.frame.driveIntent = 0;
      this.padButtons = { up: false, down: false, reset: false };
      this.gamepadRearmPending = true;
      this.releaseTouch();
    };
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    const clearPointerRearm = (event) => {
      if (event.pointerId !== undefined && event.pointerId !== null) {
        this.touchPointerRearm.delete(event.pointerId);
      }
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      addEventListener(type, clearPointerRearm);
      document.addEventListener(type, clearPointerRearm);
    }
    addEventListener('blur', this.releaseAll);
    addEventListener('pagehide', this.releaseAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    this.setupTouchControls();
  }

  registerPointerCapture(element, pointerId) {
    if (this.touchPointerRearm.has(pointerId)) return false;
    let pointerIds = this.pointerCaptures.get(element);
    if (!pointerIds) {
      pointerIds = new Set();
      this.pointerCaptures.set(element, pointerIds);
    }
    pointerIds.add(pointerId);

    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      pointerIds.delete(pointerId);
      if (pointerIds.size === 0) this.pointerCaptures.delete(element);
      return false;
    }
    return true;
  }

  releasePointerCapture(element, pointerId) {
    const pointerIds = this.pointerCaptures.get(element);
    if (!pointerIds?.has(pointerId)) return;
    pointerIds.delete(pointerId);
    if (pointerIds.size === 0) this.pointerCaptures.delete(element);

    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      // The browser may already have released the capture.
    }
  }

  releaseAllPointerCaptures() {
    const captures = [];
    for (const [element, pointerIds] of this.pointerCaptures) {
      for (const pointerId of pointerIds) captures.push({ element, pointerId });
    }
    this.pointerCaptures.clear();

    for (const { element, pointerId } of captures) {
      try {
        element.releasePointerCapture?.(pointerId);
      } catch {
        // The browser may already have released the capture.
      }
    }
  }

  setupTouchControls() {
    const root = document.getElementById('mobile-controls');
    if (!root) return;

    const vibrate = (duration = 8) => navigator.vibrate?.(duration);

    const bindHold = (id, field) => {
      const element = document.getElementById(id);
      if (!element) return;
      const activePointers = new Set();
      const activeKeyboardCodes = new Set();
      const keyboardRearm = new Set();
      const keyboardPointerId = (code) => `keyboard:${id}:${code}`;
      const clearKeyboardPointers = () => {
        for (const code of activeKeyboardCodes) keyboardRearm.add(code);
        for (const code of activeKeyboardCodes) activePointers.delete(keyboardPointerId(code));
        activeKeyboardCodes.clear();
      };
      const clearPointers = () => {
        clearKeyboardPointers();
        activePointers.clear();
        this.touch[field] = 0;
        element.classList.remove('pressed');
      };
      const releaseKeyboard = (code) => {
        if (!activeKeyboardCodes.has(code) && !keyboardRearm.has(code)) return;
        activeKeyboardCodes.delete(code);
        keyboardRearm.delete(code);
        activePointers.delete(keyboardPointerId(code));
        if (activePointers.size === 0) clearPointers();
      };
      this.touchKeyboardReleases.add(releaseKeyboard);
      const keyboardPress = (event) => {
        if (!this.touch.enabled || !['Enter', 'Space'].includes(event.code)) return;
        event.preventDefault();
        if (event.repeat || keyboardRearm.has(event.code) || activeKeyboardCodes.has(event.code)) return;
        activeKeyboardCodes.add(event.code);
        activePointers.add(keyboardPointerId(event.code));
        this.touch[field] = 1;
        element.classList.add('pressed');
      };
      const keyboardRelease = (event) => {
        if (!['Enter', 'Space'].includes(event.code)) return;
        releaseKeyboard(event.code);
      };
      this.touchPointerResets.add(clearPointers);
      const release = (event) => {
        const awaitingRelease = this.touchPointerRearm.has(event.pointerId);
        if (event.type === 'pointerup' || event.type === 'pointercancel' || !awaitingRelease) {
          this.touchPointerRearm.delete(event.pointerId);
        }
        activePointers.delete(event.pointerId);
        this.releasePointerCapture(element, event.pointerId);
        if (activePointers.size > 0) return;
        clearPointers();
      };
      element.addEventListener('pointerdown', (event) => {
        if (!this.touch.enabled || this.touchPointerRearm.has(event.pointerId)) return;
        event.preventDefault();
        if (!this.registerPointerCapture(element, event.pointerId)) return;
        activePointers.add(event.pointerId);
        this.touch[field] = 1;
        element.classList.add('pressed');
        vibrate(field === 'handbrake' ? 12 : field.startsWith('steer') ? 5 : 6);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        element.addEventListener(type, release);
      }
      element.addEventListener('keydown', keyboardPress);
      element.addEventListener('keyup', keyboardRelease);
      element.addEventListener('blur', () => {
        clearKeyboardPointers();
        if (activePointers.size === 0) {
          this.touch[field] = 0;
          element.classList.remove('pressed');
        }
      });
    };

    const bindPulse = (id, pulse) => {
      const element = document.getElementById(id);
      if (!element) return;
      const activePointers = new Set();
      const clearPointers = () => {
        activePointers.clear();
        element.classList.remove('pressed');
      };
      this.touchPointerResets.add(clearPointers);
      const release = (event) => {
        const awaitingRelease = this.touchPointerRearm.has(event.pointerId);
        if (event.type === 'pointerup' || event.type === 'pointercancel' || !awaitingRelease) {
          this.touchPointerRearm.delete(event.pointerId);
        }
        activePointers.delete(event.pointerId);
        this.releasePointerCapture(element, event.pointerId);
        if (activePointers.size === 0) element.classList.remove('pressed');
      };
      element.addEventListener('pointerdown', (event) => {
        if (!this.touch.enabled || this.touchPointerRearm.has(event.pointerId)) return;
        event.preventDefault();
        if (!this.registerPointerCapture(element, event.pointerId)) return;
        activePointers.add(event.pointerId);
        this.pulses.add(pulse);
        element.classList.add('pressed');
        vibrate(10);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        element.addEventListener(type, release);
      }
      element.addEventListener('click', (event) => {
        if (!this.touch.enabled || event.detail !== 0) return;
        this.pulses.add(pulse);
        element.classList.add('pressed');
        vibrate(10);
        setTimeout(() => element.classList.remove('pressed'), 80);
      });
    };

    bindHold('touch-left', 'steerLeft');
    bindHold('touch-right', 'steerRight');
    bindHold('touch-throttle', 'throttle');
    bindHold('touch-brake', 'brake');
    bindHold('touch-handbrake', 'handbrake');
    bindPulse('touch-reset', 'TouchReset');
    bindPulse('touch-mode', 'TouchTransmission');
    bindPulse('touch-shift-up', 'TouchShiftUp');
    bindPulse('touch-shift-down', 'TouchShiftDown');
    root.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  setTouchEnabled(enabled) {
    this.touch.enabled = enabled;
    if (!enabled) this.releaseTouch();
  }

  releaseTouch() {
    for (const pointerIds of this.pointerCaptures.values()) {
      for (const pointerId of pointerIds) this.touchPointerRearm.add(pointerId);
    }
    this.releaseAllPointerCaptures();
    for (const clearPointers of this.touchPointerResets) clearPointers();
    this.touch.steerLeft = 0;
    this.touch.steerRight = 0;
    this.touch.throttle = 0;
    this.touch.brake = 0;
    this.touch.handbrake = 0;
    document.querySelectorAll('.mobile-controls .pressed').forEach((element) => element.classList.remove('pressed'));
  }

  consumePulse(code) {
    const hit = this.pulses.has(code);
    this.pulses.delete(code);
    return hit;
  }

  consumeFixedPulses() {
    for (const code of FIXED_PULSE_CODES) this.pulses.delete(code);
    this.frame.shiftUp = false;
    this.frame.shiftDown = false;
    this.frame.toggleTransmission = false;
    this.frame.reset = false;
  }

  update(dt, speedKmh = 0, { deferFixedPulses = false } = {}) {
    let rawSteer = (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0)
      - (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0);
    let rawThrottle = this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0;
    let rawBrake = this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0;
    let rawHandbrake = this.keys.has('Space') ? 1 : 0;

    let analogSteer = null;
    if (this.touch.enabled) {
      rawSteer = THREE.MathUtils.clamp(rawSteer + this.touch.steerLeft - this.touch.steerRight, -1, 1);
      rawThrottle = Math.max(rawThrottle, this.touch.throttle);
      rawBrake = Math.max(rawBrake, this.touch.brake);
      rawHandbrake = Math.max(rawHandbrake, this.touch.handbrake);
    }
    const pads = navigator.getGamepads?.() || [];
    const pad = Array.from(pads).find((candidate) => candidate && candidate.connected !== false);
    const gamepadReplaced = Boolean(pad && this.gamepad && pad !== this.gamepad);
    if ((this.gamepadConnected && !pad) || gamepadReplaced) {
      this.gamepadRearmPending = true;
      this.padButtons = { up: false, down: false, reset: false };
    }
    this.gamepadConnected = Boolean(pad);
    this.gamepad = pad || null;
    const activePad = pad && (!this.gamepadRearmPending || !gamepadHasInput(pad)) ? pad : null;
    if (activePad) {
      if (this.gamepadRearmPending) this.gamepadRearmPending = false;
      const stick = Math.abs(activePad.axes[0] || 0) > GAMEPAD_STICK_DEADZONE ? activePad.axes[0] : 0;
      const shaped = Math.sign(stick) * Math.pow(Math.abs(stick), 1.45);
      if (Math.abs(shaped) > 0 && analogSteer === null) analogSteer = -shaped;
      rawThrottle = Math.max(rawThrottle, activePad.buttons[7]?.value || 0);
      rawBrake = Math.max(rawBrake, activePad.buttons[6]?.value || 0);
      rawHandbrake = Math.max(rawHandbrake, activePad.buttons[0]?.value || 0);
      const padUp = Boolean(activePad.buttons[5]?.pressed);
      const padDown = Boolean(activePad.buttons[4]?.pressed);
      const padReset = Boolean(activePad.buttons[3]?.pressed);
      if (padUp && !this.padButtons.up) this.pulses.add('PadShiftUp');
      if (padDown && !this.padButtons.down) this.pulses.add('PadShiftDown');
      if (padReset && !this.padButtons.reset) this.pulses.add('PadReset');
      this.padButtons = { up: padUp, down: padDown, reset: padReset };
    } else {
      this.padButtons = { up: false, down: false, reset: false };
    }

    if (analogSteer !== null) {
      this.frame.steer = THREE.MathUtils.damp(this.frame.steer, analogSteer, 15, dt);
    } else {
      this.frame.steer = updateKeyboardSteer(this.frame.steer, rawSteer, speedKmh, dt);
    }
    this.frame.driveIntent = resolveDriveIntent(rawThrottle, rawBrake);
    this.frame.throttle = updatePedal(this.frame.throttle, rawThrottle, 4.3, 7.5, dt);
    this.frame.brake = updatePedal(this.frame.brake, rawBrake, 7.5, 11, dt);
    this.frame.handbrake = THREE.MathUtils.damp(this.frame.handbrake, rawHandbrake, 14, dt);
    const pulse = (code) => deferFixedPulses ? this.pulses.has(code) : this.consumePulse(code);
    this.frame.shiftUp = pulse('KeyE') || pulse('PadShiftUp') || pulse('TouchShiftUp');
    this.frame.shiftDown = pulse('KeyQ') || pulse('PadShiftDown') || pulse('TouchShiftDown');
    this.frame.toggleTransmission = pulse('KeyC') || pulse('TouchTransmission');
    this.frame.reset = pulse('KeyR') || pulse('PadReset') || pulse('TouchReset');
    return this.frame;
  }
}
