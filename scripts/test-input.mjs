import assert from 'node:assert/strict';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(id, tagName = 'div', { parentElement = null, isContentEditable = false } = {}) {
    super();
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.parentElement = parentElement;
    this.isContentEditable = isContentEditable;
    this.classList = {
      values: new Set(),
      add: (name) => this.classList.values.add(name),
      remove: (name) => this.classList.values.delete(name),
      contains: (name) => this.classList.values.has(name),
    };
    this.capturedPointers = new Set();
    this.setPointerCaptureCalls = [];
    this.releasePointerCaptureCalls = [];
  }

  closest() {
    let current = this;
    while (current) {
      const tagName = current.tagName.toLowerCase();
      if (['button', 'a', 'input', 'textarea', 'select'].includes(tagName) || current.isContentEditable) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  setPointerCapture(pointerId) {
    this.capturedPointers.add(pointerId);
    this.setPointerCaptureCalls.push(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.capturedPointers.delete(pointerId);
    this.releasePointerCaptureCalls.push(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId);
  }
}

const ids = [
  'mobile-controls',
  'touch-left',
  'touch-right',
  'touch-throttle',
  'touch-brake',
  'touch-handbrake',
  'touch-reset',
  'touch-mode',
  'touch-shift-up',
  'touch-shift-down',
];
const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
const documentTarget = new FakeEventTarget();
let gamepads = [];
globalThis.windowTarget = new FakeEventTarget();
globalThis.addEventListener = (...args) => globalThis.windowTarget.addEventListener(...args);
globalThis.document = {
  hidden: false,
  addEventListener: (...args) => documentTarget.addEventListener(...args),
  getElementById: (id) => elements.get(id) ?? null,
  querySelectorAll: () => [...elements.values()].filter((element) => element.classList.contains('pressed')),
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { getGamepads: () => gamepads, vibrate: () => {} },
});

const { InputController } = await import('../src/input.js');
const controller = new InputController();
controller.setTouchEnabled(true);

const frameStep = () => controller.update(1 / 60);

function makeGamepad({ axis = 0, throttle = 0, brake = 0, handbrake = 0, shiftUp = false, shiftDown = false, reset = false, menu = false } = {}) {
  const buttons = Array.from({ length: 10 }, () => ({ value: 0, pressed: false }));
  buttons[0] = { value: handbrake, pressed: handbrake > 0.5 };
  buttons[3] = { value: reset ? 1 : 0, pressed: reset };
  buttons[4] = { value: shiftDown ? 1 : 0, pressed: shiftDown };
  buttons[5] = { value: shiftUp ? 1 : 0, pressed: shiftUp };
  buttons[6] = { value: brake, pressed: brake > 0.5 };
  buttons[7] = { value: throttle, pressed: throttle > 0.5 };
  buttons[9] = { value: menu ? 1 : 0, pressed: menu };
  return { axes: [axis], buttons };
}

function makeKeyEvent(code, options = {}) {
  const event = {
    type: 'keydown',
    code,
    repeat: false,
    target: null,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    ...options,
  };
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  return event;
}

function makePointerEvent(type, pointerId) {
  return { type, pointerId, preventDefault() {} };
}

function makeKeyboardEvent(type, code, options = {}) {
  return {
    type,
    code,
    repeat: false,
    detail: 0,
    preventDefault() {},
    ...options,
  };
}

const canvas = new FakeElement('canvas');
const keyboardButton = new FakeElement('keyboard-button', 'button');
const keyboardLink = new FakeElement('keyboard-link', 'a');
const keyboardInput = new FakeElement('keyboard-input', 'input');
const keyboardTextarea = new FakeElement('keyboard-textarea', 'textarea');
const keyboardSelect = new FakeElement('keyboard-select', 'select');
const keyboardEditable = new FakeElement('keyboard-editable', 'div', { isContentEditable: true });
const buttonChild = new FakeElement('button-child', 'span', { parentElement: keyboardButton });

for (const target of [
  keyboardButton,
  keyboardLink,
  keyboardInput,
  keyboardTextarea,
  keyboardSelect,
  keyboardEditable,
  buttonChild,
]) {
  const event = makeKeyEvent('KeyR', { target });
  windowTarget.dispatchEvent(event);
  assert.equal(controller.keys.has('KeyR'), false);
  assert.equal(controller.pulses.has('KeyR'), false);
  assert.equal(event.defaultPrevented, false);
}

for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
  const event = makeKeyEvent('KeyR', { target: canvas, [modifier]: true });
  windowTarget.dispatchEvent(event);
  assert.equal(controller.keys.has('KeyR'), false);
  assert.equal(controller.pulses.has('KeyR'), false);
  assert.equal(event.defaultPrevented, false);
}

const gameplayKey = makeKeyEvent('ArrowUp', { target: canvas });
windowTarget.dispatchEvent(gameplayKey);
assert.equal(controller.keys.has('ArrowUp'), true);
assert.equal(controller.pulses.has('ArrowUp'), true);
assert.equal(gameplayKey.defaultPrevented, true);
windowTarget.dispatchEvent({ type: 'keyup', code: 'ArrowUp', target: canvas });
assert.equal(controller.keys.has('ArrowUp'), false);
controller.releaseAll();

windowTarget.dispatchEvent(makeKeyEvent('KeyE'));
assert.equal(controller.keys.has('KeyE'), true);
assert.equal(frameStep().shiftUp, true);
windowTarget.dispatchEvent(makeKeyEvent('KeyE'));
windowTarget.dispatchEvent(makeKeyEvent('KeyE', { repeat: true }));
assert.equal(frameStep().shiftUp, false);
windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyE', target: canvas });

windowTarget.dispatchEvent(makeKeyEvent('KeyW'));
assert.ok(frameStep().throttle > 0);
controller.releaseAll();
assert.equal(controller.keys.has('KeyW'), false);
assert.equal(controller.frame.throttle, 0);
windowTarget.dispatchEvent(makeKeyEvent('KeyW', { repeat: true }));
assert.equal(controller.keys.has('KeyW'), false);
windowTarget.dispatchEvent(makeKeyEvent('KeyW'));
assert.equal(controller.keys.has('KeyW'), false);
assert.equal(frameStep().throttle, 0);
windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyW', target: canvas });
windowTarget.dispatchEvent(makeKeyEvent('KeyW'));
assert.equal(controller.keys.has('KeyW'), true);
assert.ok(frameStep().throttle > 0);
windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyW', target: canvas });
controller.releaseAll();

const pad = makeGamepad();
gamepads = [pad];
assert.equal(frameStep().throttle, 0);
pad.axes[0] = 0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
assert.equal(controller.frame.shiftUp, true);
controller.releaseAll();
assert.equal(controller.frame.throttle, 0);
assert.equal(controller.frame.steer, 0);
pad.axes[0] = 0.72;
assert.equal(frameStep().throttle, 0);
assert.equal(controller.frame.steer, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = 0;
pad.buttons[5] = { value: 0, pressed: false };
pad.buttons[7] = { value: 0, pressed: false };
assert.equal(frameStep().throttle, 0);
pad.axes[0] = -0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
assert.ok(controller.frame.steer > 0);
assert.equal(controller.frame.shiftUp, true);
gamepads = [];
frameStep();
assert.equal(controller.frame.driveIntent, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = 0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
gamepads = [pad];
frameStep();
assert.equal(controller.frame.driveIntent, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = 0;
pad.buttons[5] = { value: 0, pressed: false };
pad.buttons[7] = { value: 0, pressed: false };
frameStep();
assert.equal(controller.frame.driveIntent, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = -0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
assert.ok(controller.frame.steer > 0);
assert.equal(controller.frame.shiftUp, true);
gamepads = [];
controller.releaseAll();

const replacementPad = makeGamepad({ axis: 0.72, throttle: 1, shiftUp: true });
gamepads = [pad];
pad.axes[0] = 0;
pad.buttons[5] = { value: 0, pressed: false };
pad.buttons[7] = { value: 0, pressed: false };
assert.equal(frameStep().driveIntent, 0);
pad.axes[0] = -0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
gamepads = [replacementPad];
assert.equal(frameStep().driveIntent, 0, 'replacement gamepad waits for a neutral handshake');
assert.equal(controller.frame.shiftUp, false);
replacementPad.axes[0] = 0;
replacementPad.buttons[5] = { value: 0, pressed: false };
replacementPad.buttons[7] = { value: 0, pressed: false };
assert.equal(frameStep().driveIntent, 0);
replacementPad.axes[0] = 0.72;
replacementPad.buttons[5] = { value: 1, pressed: true };
replacementPad.buttons[7] = { value: 1, pressed: true };
assert.equal(frameStep().driveIntent, 1);
assert.equal(controller.frame.shiftUp, true);
gamepads = [];
controller.releaseAll();

const menuPad = makeGamepad();
gamepads = [menuPad];
assert.equal(controller.consumeGamepadMenuPulse(), false, 'neutral gamepad rearms the menu button');
menuPad.buttons[9] = { value: 1, pressed: true };
assert.equal(controller.consumeGamepadMenuPulse(), true, 'gamepad menu button emits a rising-edge pulse');
assert.equal(controller.consumeGamepadMenuPulse(), false, 'held gamepad menu button does not repeat');
menuPad.buttons[9] = { value: 0, pressed: false };
assert.equal(controller.consumeGamepadMenuPulse(), false);
menuPad.buttons[9] = { value: 1, pressed: true };
assert.equal(controller.consumeGamepadMenuPulse(), true, 'gamepad menu button rearms after release');
controller.releaseAll();
assert.equal(controller.consumeGamepadMenuPulse(), false, 'pause entry waits for the held menu button to release');
menuPad.buttons[9] = { value: 0, pressed: false };
assert.equal(controller.consumeGamepadMenuPulse(), false);
menuPad.buttons[9] = { value: 1, pressed: true };
assert.equal(controller.consumeGamepadMenuPulse(), true, 'a fresh press can resume after pause');
gamepads = [];
controller.releaseAll();

const throttle = elements.get('touch-throttle');
const brake = elements.get('touch-brake');
const left = elements.get('touch-left');
const reset = elements.get('touch-reset');

const FIXED_DT = 1 / 120;
function assertPulseSurvivesSubFixedFrames({ label, field, prepare, trigger, release }) {
  controller.releaseAll();
  gamepads = [];
  controller.update(0, 0, { deferFixedPulses: true });
  prepare?.();
  trigger();

  const renderDt = FIXED_DT * 0.4;
  for (const frameNumber of [1, 2]) {
    const frame = controller.update(renderDt, 0, { deferFixedPulses: true });
    assert.equal(frame[field], true, `${label}: sub-fixed frame ${frameNumber} retains pulse`);
  }

  const fixedStepFrame = controller.update(renderDt, 0, { deferFixedPulses: true });
  assert.equal(fixedStepFrame[field], true, `${label}: next fixed step receives pulse`);
  controller.consumeFixedPulses();
  assert.equal(controller.frame[field], false, `${label}: fixed step consumes pulse once`);
  assert.equal(
    controller.update(renderDt, 0, { deferFixedPulses: true })[field],
    false,
    `${label}: consumed pulse does not repeat`,
  );

  release?.();
  gamepads = [];
  controller.releaseAll();
}

assertPulseSurvivesSubFixedFrames({
  label: 'keyboard shift-up',
  field: 'shiftUp',
  trigger: () => windowTarget.dispatchEvent(makeKeyEvent('KeyE')),
  release: () => windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyE', target: canvas }),
});

assertPulseSurvivesSubFixedFrames({
  label: 'touch reset',
  field: 'reset',
  trigger: () => reset.dispatchEvent(makePointerEvent('pointerdown', 'deferred-touch-reset')),
  release: () => reset.dispatchEvent(makePointerEvent('pointerup', 'deferred-touch-reset')),
});

let pulsePad;
assertPulseSurvivesSubFixedFrames({
  label: 'gamepad reset',
  field: 'reset',
  prepare: () => {
    pulsePad = makeGamepad();
    gamepads = [pulsePad];
    controller.update(0, 0, { deferFixedPulses: true });
  },
  trigger: () => {
    pulsePad.buttons[3] = { value: 1, pressed: true };
  },
});

throttle.dispatchEvent(makePointerEvent('pointerdown', 1));
assert.equal(controller.touch.throttle, 1);
assert.equal(throttle.classList.contains('pressed'), true);
assert.equal(throttle.hasPointerCapture(1), true);

throttle.dispatchEvent(makePointerEvent('pointerup', 1));
assert.equal(controller.touch.throttle, 0);
assert.equal(throttle.classList.contains('pressed'), false);
assert.equal(throttle.hasPointerCapture(1), false);
assert.deepEqual(throttle.releasePointerCaptureCalls, [1]);

throttle.dispatchEvent(makePointerEvent('pointerdown', 'rearm-pointer'));
controller.releaseAll();
throttle.dispatchEvent(makePointerEvent('pointerdown', 'rearm-pointer'));
assert.equal(controller.touch.throttle, 0);
assert.equal(throttle.hasPointerCapture('rearm-pointer'), false);
throttle.dispatchEvent(makePointerEvent('pointerup', 'rearm-pointer'));
throttle.dispatchEvent(makePointerEvent('pointerdown', 'rearm-pointer'));
assert.equal(controller.touch.throttle, 1);
throttle.dispatchEvent(makePointerEvent('pointercancel', 'rearm-pointer'));
assert.equal(controller.touch.throttle, 0);

for (const type of ['pointercancel', 'lostpointercapture']) {
  const pointerId = `terminal-${type}`;
  throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
  assert.equal(controller.touch.throttle, 1);
  throttle.dispatchEvent(makePointerEvent(type, pointerId));
  assert.equal(controller.touch.throttle, 0);
}

for (const [target, name] of [[documentTarget, 'document'], [windowTarget, 'window']]) {
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const pointerId = `global-${name}-${type}`;
    throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
    controller.releaseAll();
    throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
    assert.equal(controller.touch.throttle, 0);
    target.dispatchEvent(makePointerEvent(type, pointerId));
    throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
    assert.equal(controller.touch.throttle, 1);
    throttle.dispatchEvent(makePointerEvent('pointercancel', pointerId));
    assert.equal(controller.touch.throttle, 0);
  }
}

reset.dispatchEvent(makePointerEvent('pointerdown', 2));
assert.equal(controller.pulses.has('TouchReset'), true);
assert.equal(reset.classList.contains('pressed'), true);
assert.equal(reset.hasPointerCapture(2), true);
reset.dispatchEvent(makePointerEvent('pointerup', 2));
assert.equal(reset.classList.contains('pressed'), false);
assert.equal(reset.hasPointerCapture(2), false);
assert.equal(controller.pulses.has('TouchReset'), true);
controller.releaseAll();

throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space'));
assert.equal(controller.touch.throttle, 1);
assert.equal(throttle.classList.contains('pressed'), true);
throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space', { repeat: true }));
assert.equal(controller.touch.throttle, 1);
controller.releaseAll();
assert.equal(controller.touch.throttle, 0);
throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space', { repeat: true }));
assert.equal(controller.touch.throttle, 0);
windowTarget.dispatchEvent({ type: 'keyup', code: 'Space' });
throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space'));
assert.equal(controller.touch.throttle, 1);
throttle.dispatchEvent(makeKeyboardEvent('keyup', 'Space'));
assert.equal(controller.touch.throttle, 0);

controller.setTouchEnabled(true);
throttle.dispatchEvent(makePointerEvent('pointerdown', 'multi-gas-1'));
throttle.dispatchEvent(makePointerEvent('pointerdown', 'multi-gas-2'));
brake.dispatchEvent(makePointerEvent('pointerdown', 'multi-brake'));
left.dispatchEvent(makePointerEvent('pointerdown', 'multi-left'));
assert.equal(controller.touch.throttle, 1);
assert.equal(controller.touch.brake, 1);
assert.equal(controller.touch.steerLeft, 1);
assert.equal(throttle.hasPointerCapture('multi-gas-1'), true);
assert.equal(throttle.hasPointerCapture('multi-gas-2'), true);

throttle.dispatchEvent({ type: 'blur' });
assert.equal(controller.touch.throttle, 1, 'element blur preserves active touch pointers');
assert.equal(controller.touch.brake, 1);
assert.equal(controller.touch.steerLeft, 1);
assert.equal(throttle.hasPointerCapture('multi-gas-1'), true);
assert.equal(throttle.hasPointerCapture('multi-gas-2'), true);

throttle.dispatchEvent(makePointerEvent('pointerup', 'multi-gas-1'));
assert.equal(controller.touch.throttle, 1);
assert.equal(throttle.hasPointerCapture('multi-gas-1'), false);
assert.equal(throttle.hasPointerCapture('multi-gas-2'), true);
brake.dispatchEvent(makePointerEvent('pointerup', 'multi-brake'));
left.dispatchEvent(makePointerEvent('pointerup', 'multi-left'));
throttle.dispatchEvent(makePointerEvent('pointerup', 'multi-gas-2'));
assert.equal(controller.touch.throttle, 0);
assert.equal(controller.touch.brake, 0);
assert.equal(controller.touch.steerLeft, 0);
assert.equal(controller.pointerCaptures.size, 0);

reset.dispatchEvent(makePointerEvent('pointerdown', 'pulse-blur'));
assert.equal(reset.classList.contains('pressed'), true);
assert.equal(reset.hasPointerCapture('pulse-blur'), true);
reset.dispatchEvent({ type: 'blur' });
assert.equal(reset.classList.contains('pressed'), true, 'pulse blur preserves active pointer styling');
assert.equal(reset.hasPointerCapture('pulse-blur'), true);
reset.dispatchEvent(makePointerEvent('pointerup', 'pulse-blur'));
assert.equal(reset.classList.contains('pressed'), false);
assert.equal(reset.hasPointerCapture('pulse-blur'), false);
controller.consumeFixedPulses();

reset.dispatchEvent(makeKeyboardEvent('click', 'Enter'));
assert.equal(controller.pulses.has('TouchReset'), true);
controller.releaseAll();

const lifecycleReleases = [
  ['releaseAll', () => controller.releaseAll()],
  ['blur', () => windowTarget.dispatchEvent({ type: 'blur' })],
  ['visibilitychange', () => {
    document.hidden = true;
    documentTarget.dispatchEvent({ type: 'visibilitychange' });
    document.hidden = false;
  }],
  ['pagehide', () => windowTarget.dispatchEvent({ type: 'pagehide' })],
];

for (const [name, trigger] of lifecycleReleases) {
  controller.setTouchEnabled(true);
  throttle.dispatchEvent(makePointerEvent('pointerdown', name));
  reset.dispatchEvent(makePointerEvent('pointerdown', name + '-pulse'));
  assert.equal(controller.pointerCaptures.size, 2);
  assert.equal(throttle.capturedPointers.size, 1);
  assert.equal(reset.capturedPointers.size, 1);

  trigger();

  assert.equal(controller.touch.throttle, 0, name + ' clears hold state');
  assert.equal(controller.frame.throttle, 0, name + ' clears frame throttle');
  assert.equal(controller.frame.brake, 0, name + ' clears frame brake');
  assert.equal(controller.frame.steer, 0, name + ' clears frame steer');
  assert.equal(controller.pulses.has('TouchReset'), false, name + ' clears pulse state');
  assert.equal(throttle.classList.contains('pressed'), false, name + ' clears hold styling');
  assert.equal(reset.classList.contains('pressed'), false, name + ' clears pulse styling');
  assert.equal(controller.pointerCaptures.size, 0, name + ' clears registry');
  assert.equal(throttle.capturedPointers.size, 0, name + ' releases hold capture');
  assert.equal(reset.capturedPointers.size, 0, name + ' releases pulse capture');

  throttle.dispatchEvent(makePointerEvent('pointerup', name));
  reset.dispatchEvent(makePointerEvent('pointercancel', name + '-pulse'));
}

console.log('PASS keyboard shortcuts respect interactive targets and modifiers');
console.log('PASS releaseAll and gamepad reconnects rearm keyboard and gamepad sources');
console.log('PASS gamepad menu button emits one pulse per neutral-to-pressed transition');
console.log('PASS gamepad identity replacements require a neutral handshake');
console.log('PASS fixed-step pulse handoff retains keyboard, touch, and gamepad pulses across sub-fixed render frames');
console.log('PASS hold and pulse pointer captures release on pointerup and lifecycle events');
console.log('PASS touch hold controls rearm after local and global pointer and keyboard terminal events');
console.log('PASS multi-pointer holds and pulse styling survive element blur until terminal pointer events');
