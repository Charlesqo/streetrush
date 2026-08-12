import assert from 'node:assert/strict';
import {
  ORIENTATIONS,
  createOrientationController,
  getOrientationUiState,
  normalizeOrientation,
  resolveOrientation,
  shouldFreezeRace,
} from '../src/orientation.js';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event });
  }
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(id, tagName = 'div', { parentElement = null, classes = [] } = {}) {
    super();
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.parentElement = parentElement;
    this.classList = new FakeClassList(classes);
    this.attributes = new Map();
    this.children = [];
    this.disabled = false;
    this.inert = false;
    this.isConnected = true;
    this.focusCalls = 0;
    if (parentElement) parentElement.children.push(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  focus() {
    this.focusCalls += 1;
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  querySelectorAll(selector) {
    if (selector !== 'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])') {
      throw new Error(`Unexpected selector in test fake: ${selector}`);
    }
    const result = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.tagName === 'BUTTON'
          || child.tagName === 'A'
          || ['INPUT', 'TEXTAREA', 'SELECT'].includes(child.tagName)
          || child.tabIndex >= 0) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class FakeDocument {
  constructor(elements) {
    this.elements = new Map(elements.map((element) => [element.id, element]));
    this.activeElement = null;
    for (const element of elements) element.ownerDocument = this;
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

class FakeMediaQuery extends FakeEventTarget {
  constructor(matches) {
    super();
    this.matches = matches;
  }
}

function makeFixture() {
  const game = new FakeElement('game', 'canvas');
  const hint = new FakeElement('orientation-hint', 'div', { classes: ['orientation-hint', 'hidden'] });
  hint.setAttribute('role', 'dialog');
  hint.setAttribute('aria-modal', 'true');
  hint.setAttribute('aria-live', 'polite');
  hint.setAttribute('aria-labelledby', 'orientation-hint-title');
  const trigger = new FakeElement('orientation-fullscreen', 'button', { parentElement: hint });
  const help = new FakeElement('fullscreen-help', 'section', { classes: ['fullscreen-help', 'hidden'] });
  const panel = new FakeElement('fullscreen-help-panel', 'div', { parentElement: help });
  const close = new FakeElement('fullscreen-help-close', 'button', { parentElement: panel });
  const document = new FakeDocument([game, hint, trigger, help, panel, close]);
  const view = new FakeEventTarget();
  const mediaQuery = new FakeMediaQuery(true);
  view.matchMedia = () => mediaQuery;
  view.screen = { orientation: new FakeEventTarget() };
  view.innerWidth = 390;
  view.innerHeight = 844;
  return { close, document, game, help, hint, mediaQuery, trigger, view };
}

assert.equal(normalizeOrientation('portrait-primary'), ORIENTATIONS.PORTRAIT);
assert.equal(normalizeOrientation('LANDSCAPE-SECONDARY'), ORIENTATIONS.LANDSCAPE);
assert.equal(normalizeOrientation('sideways'), ORIENTATIONS.UNKNOWN);
assert.equal(resolveOrientation({ width: 390, height: 844 }), ORIENTATIONS.PORTRAIT);
assert.equal(resolveOrientation({ width: 844, height: 390 }), ORIENTATIONS.LANDSCAPE);
assert.equal(resolveOrientation({ width: 400, height: 400 }), ORIENTATIONS.UNKNOWN);
assert.equal(resolveOrientation({ orientationType: 'landscape-primary', width: 390, height: 844 }), ORIENTATIONS.LANDSCAPE);

const visibleState = getOrientationUiState({
  touchCapable: true,
  raceActive: true,
  orientation: 'portrait-primary',
});
assert.equal(visibleState.orientationHintEligible, true);
assert.equal(visibleState.orientationHintVisible, true);
assert.equal(visibleState.orientationHintAriaHidden, false);
assert.equal(visibleState.orientationHintInert, false);

const blockedState = getOrientationUiState({
  touchCapable: true,
  raceActive: true,
  orientation: 'portrait',
  fullscreenHelpOpen: true,
});
assert.equal(blockedState.orientationHintEligible, true);
assert.equal(blockedState.orientationHintVisible, false);
assert.equal(blockedState.orientationHintAriaHidden, true);
assert.equal(blockedState.orientationHintInert, true);
assert.equal(shouldFreezeRace({
  touchCapable: true,
  raceActive: true,
  orientation: 'portrait',
  modalId: 'orientation-hint',
}), true);
assert.equal(shouldFreezeRace({
  touchCapable: true,
  raceActive: true,
  orientation: 'landscape',
  modalId: 'fullscreen-help',
}), true);
assert.equal(shouldFreezeRace({
  touchCapable: true,
  raceActive: true,
  orientation: 'landscape',
  modalId: 'orientation-hint',
}), false);

const fixture = makeFixture();
const controller = createOrientationController({
  document: fixture.document,
  view: fixture.view,
  touchCapable: true,
  raceActive: true,
});
const initialState = controller.start();
assert.equal(initialState.orientationHintVisible, true);
assert.equal(fixture.hint.classList.contains('hidden'), false);
assert.equal(fixture.hint.getAttribute('aria-hidden'), 'false');
assert.equal(fixture.hint.inert, false);
assert.equal(fixture.hint.hasAttribute('inert'), false);
assert.equal(fixture.hint.getAttribute('role'), 'dialog');
assert.equal(fixture.hint.getAttribute('aria-modal'), 'true');
assert.equal(fixture.hint.getAttribute('aria-live'), 'polite');
assert.equal(fixture.hint.getAttribute('aria-labelledby'), 'orientation-hint-title');

fixture.trigger.focus();
assert.equal(controller.openFullscreenHelp(), true);
assert.equal(controller.openFullscreenHelp(), false);
assert.equal(fixture.help.classList.contains('hidden'), false);
assert.equal(fixture.help.getAttribute('aria-hidden'), 'false');
assert.equal(fixture.help.inert, false);
assert.equal(fixture.document.activeElement, fixture.close);
assert.equal(fixture.hint.classList.contains('hidden'), true);
assert.equal(fixture.hint.getAttribute('aria-hidden'), 'true');
assert.equal(fixture.hint.inert, true);
assert.equal(fixture.hint.hasAttribute('inert'), true);

assert.equal(controller.closeFullscreenHelp(), true);
assert.equal(fixture.help.classList.contains('hidden'), true);
assert.equal(fixture.help.getAttribute('aria-hidden'), 'true');
assert.equal(fixture.help.inert, true);
assert.equal(fixture.hint.classList.contains('hidden'), false);
assert.equal(fixture.hint.getAttribute('aria-hidden'), 'false');
assert.equal(fixture.hint.inert, false);
assert.equal(fixture.document.activeElement, fixture.trigger);

fixture.trigger.focus();
controller.setOrientation('landscape');
assert.equal(controller.getState().orientationHintVisible, false);
assert.equal(fixture.hint.classList.contains('hidden'), true);
assert.equal(fixture.hint.getAttribute('aria-hidden'), 'true');
assert.equal(fixture.hint.inert, true);
assert.equal(fixture.document.activeElement, fixture.game);

fixture.mediaQuery.matches = true;
fixture.mediaQuery.dispatch('change');
assert.equal(controller.getState().orientationHintVisible, true);
assert.equal(fixture.hint.classList.contains('hidden'), false);
assert.equal(fixture.document.activeElement, fixture.game);

fixture.trigger.focus();
assert.equal(controller.openFullscreenHelp(), true);
controller.setRaceActive(false);
assert.equal(controller.getState().fullscreenHelpOpen, false);
assert.equal(fixture.help.classList.contains('hidden'), true);
assert.equal(fixture.document.activeElement, fixture.game);

controller.destroy();
fixture.mediaQuery.matches = false;
fixture.mediaQuery.dispatch('change');
assert.equal(controller.getState().orientation, ORIENTATIONS.PORTRAIT);

console.log('PASS orientation state derives touch race and viewport orientation');
console.log('PASS orientation hint and fullscreen-help keep aria-hidden/inert/focus consistent');
console.log('PASS fullscreen-help is idempotent and closes on race end');
