const PORTRAIT_MEDIA_QUERY = '(orientation: portrait)';
const HIDDEN_CLASS = 'hidden';
const FOCUSABLE_SELECTOR = 'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

export const ORIENTATION_HINT_ID = 'orientation-hint';
export const FULLSCREEN_HELP_ID = 'fullscreen-help';
export const ORIENTATIONS = Object.freeze({
  PORTRAIT: 'portrait',
  LANDSCAPE: 'landscape',
  UNKNOWN: 'unknown',
});

export function normalizeOrientation(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === ORIENTATIONS.PORTRAIT || normalized.startsWith('portrait-')) {
    return ORIENTATIONS.PORTRAIT;
  }
  if (normalized === ORIENTATIONS.LANDSCAPE || normalized.startsWith('landscape-')) {
    return ORIENTATIONS.LANDSCAPE;
  }
  return ORIENTATIONS.UNKNOWN;
}

export function resolveOrientation({ orientationType, width, height } = {}) {
  const fromScreen = normalizeOrientation(orientationType);
  if (fromScreen !== ORIENTATIONS.UNKNOWN) return fromScreen;

  const viewportWidth = Number(width);
  const viewportHeight = Number(height);
  if (!(viewportWidth > 0) || !(viewportHeight > 0) || viewportWidth === viewportHeight) {
    return ORIENTATIONS.UNKNOWN;
  }
  return viewportWidth < viewportHeight
    ? ORIENTATIONS.PORTRAIT
    : ORIENTATIONS.LANDSCAPE;
}

export function getOrientationUiState({
  touchCapable = false,
  raceActive = false,
  orientation = ORIENTATIONS.UNKNOWN,
  fullscreenHelpOpen = false,
} = {}) {
  const normalizedOrientation = normalizeOrientation(orientation);
  const orientationHintEligible = Boolean(touchCapable)
    && Boolean(raceActive)
    && normalizedOrientation === ORIENTATIONS.PORTRAIT;
  const orientationHintVisible = orientationHintEligible && !Boolean(fullscreenHelpOpen);

  return Object.freeze({
    touchCapable: Boolean(touchCapable),
    raceActive: Boolean(raceActive),
    orientation: normalizedOrientation,
    fullscreenHelpOpen: Boolean(fullscreenHelpOpen),
    orientationHintEligible,
    orientationHintVisible,
    orientationHintAriaHidden: !orientationHintVisible,
    orientationHintInert: !orientationHintVisible,
  });
}

export function shouldFreezeRace({
  touchCapable = false,
  raceActive = false,
  orientation = ORIENTATIONS.UNKNOWN,
  modalId = null,
} = {}) {
  if (!Boolean(raceActive) || modalId === null) return false;
  if (modalId === FULLSCREEN_HELP_ID) return true;
  const uiState = getOrientationUiState({ touchCapable, raceActive, orientation });
  return modalId === ORIENTATION_HINT_ID && uiState.orientationHintEligible;
}

function hasClass(element, className) {
  return Boolean(element?.classList?.contains?.(className));
}

function setClass(element, className, present) {
  if (present) element?.classList?.add?.(className);
  else element?.classList?.remove?.(className);
}

function getAttribute(element, name) {
  return element?.getAttribute?.(name) ?? null;
}

function setAriaHiddenAndInert(element, hidden) {
  if (!element) return;
  element.setAttribute?.('aria-hidden', hidden ? 'true' : 'false');
  try {
    element.inert = hidden;
  } catch {
    // Older engines may expose inert only through the attribute/polyfill.
  }
  if (hidden) element.setAttribute?.('inert', '');
  else element.removeAttribute?.('inert');
}

function parentOf(element) {
  return element?.parentElement ?? element?.parentNode ?? null;
}

function containsNode(root, node) {
  if (!root || !node) return false;
  let current = node;
  while (current) {
    if (current === root) return true;
    current = parentOf(current);
  }
  return false;
}

function isHiddenOrInert(element) {
  let current = element;
  while (current) {
    if (current.hidden === true
      || hasClass(current, HIDDEN_CLASS)
      || getAttribute(current, 'aria-hidden') === 'true'
      || current.inert === true
      || current.hasAttribute?.('inert')) {
      return true;
    }
    current = parentOf(current);
  }
  return false;
}

function isUsableFocusTarget(element) {
  return Boolean(element)
    && typeof element.focus === 'function'
    && element.disabled !== true
    && element.isConnected !== false
    && !isHiddenOrInert(element);
}

function focusElement(element) {
  if (!isUsableFocusTarget(element)) return false;
  element.focus({ preventScroll: true });
  return true;
}

function getFocusableElements(element) {
  return Array.from(element?.querySelectorAll?.(FOCUSABLE_SELECTOR) ?? [])
    .filter(isUsableFocusTarget);
}

function focusFirstElement(element) {
  return focusElement(getFocusableElements(element)[0]);
}

function readOrientation(view, mediaQuery) {
  const media = mediaQuery ?? view?.matchMedia?.(PORTRAIT_MEDIA_QUERY);
  if (media && typeof media.matches === 'boolean') {
    return media.matches ? ORIENTATIONS.PORTRAIT : ORIENTATIONS.LANDSCAPE;
  }
  return resolveOrientation({
    orientationType: view?.screen?.orientation?.type,
    width: view?.innerWidth,
    height: view?.innerHeight,
  });
}

function addListener(target, type, listener, registrations) {
  if (typeof target?.addEventListener !== 'function') return;
  target.addEventListener(type, listener);
  registrations.push(() => target.removeEventListener?.(type, listener));
}

function isOpenLayer(element) {
  return Boolean(element)
    && !hasClass(element, HIDDEN_CLASS)
    && getAttribute(element, 'aria-hidden') !== 'true';
}

/**
 * Owns only the orientation hint and fullscreen-help layer. The host supplies
 * race/touch state and may use beforeOpenFullscreenHelp to close its other
 * modal layer before this controller opens its one owned layer.
 */
export function createOrientationController({
  document: documentRef = globalThis.document,
  view = globalThis.window ?? globalThis,
  orientationHint = null,
  fullscreenHelp = null,
  touchCapable = false,
  raceActive = false,
  orientation,
  fallbackFocus = null,
  beforeOpenFullscreenHelp = null,
  onStateChange = null,
} = {}) {
  const document = documentRef;
  const hint = orientationHint ?? document?.getElementById?.(ORIENTATION_HINT_ID) ?? null;
  const help = fullscreenHelp ?? document?.getElementById?.(FULLSCREEN_HELP_ID) ?? null;
  const initialOrientation = orientation === undefined
    ? readOrientation(view)
    : normalizeOrientation(orientation);
  const state = {
    touchCapable: Boolean(touchCapable),
    raceActive: Boolean(raceActive),
    orientation: initialOrientation,
    fullscreenHelpOpen: isOpenLayer(help),
  };
  let rememberedFocus = null;
  let mediaQuery = null;
  let started = false;
  let registrations = [];

  function getFallbackFocus() {
    const candidate = typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus;
    return candidate ?? document?.getElementById?.('game') ?? null;
  }

  function moveFocusOutOf(layer) {
    const activeElement = document?.activeElement;
    if (!containsNode(layer, activeElement)) return;
    if (!focusElement(getFallbackFocus())) activeElement.blur?.();
  }

  function render() {
    const uiState = getOrientationUiState(state);
    const hintVisible = uiState.orientationHintVisible;

    if (!hintVisible) moveFocusOutOf(hint);
    if (!uiState.fullscreenHelpOpen) moveFocusOutOf(help);

    if (hint) {
      setClass(hint, HIDDEN_CLASS, !hintVisible);
      setAriaHiddenAndInert(hint, !hintVisible);
    }
    if (help) {
      setClass(help, HIDDEN_CLASS, !uiState.fullscreenHelpOpen);
      setAriaHiddenAndInert(help, !uiState.fullscreenHelpOpen);
    }
    return uiState;
  }

  function snapshot() {
    return getOrientationUiState(state);
  }

  function renderAndNotify() {
    const uiState = render();
    onStateChange?.(uiState);
    return uiState;
  }

  function restoreRememberedFocus() {
    const returnTarget = rememberedFocus;
    rememberedFocus = null;
    if (focusElement(returnTarget)) return true;
    return focusElement(getFallbackFocus());
  }

  function sync(patch = {}) {
    if ('touchCapable' in patch) state.touchCapable = Boolean(patch.touchCapable);
    if ('raceActive' in patch) state.raceActive = Boolean(patch.raceActive);
    if ('orientation' in patch) state.orientation = normalizeOrientation(patch.orientation);
    else if (started) state.orientation = readOrientation(view, mediaQuery);

    if (state.fullscreenHelpOpen && !state.raceActive) {
      closeFullscreenHelp();
      return snapshot();
    }
    return renderAndNotify();
  }

  function start() {
    if (started) return snapshot();
    started = true;
    mediaQuery = view?.matchMedia?.(PORTRAIT_MEDIA_QUERY) ?? null;
    const refresh = () => sync();
    addListener(view, 'resize', refresh, registrations);
    addListener(view, 'orientationchange', refresh, registrations);
    addListener(mediaQuery, 'change', refresh, registrations);
    addListener(view?.screen?.orientation, 'change', refresh, registrations);
    return sync(orientation === undefined ? {} : { orientation });
  }

  function destroy() {
    for (const unregister of registrations) unregister();
    registrations = [];
    mediaQuery = null;
    started = false;
  }

  function setTouchCapable(nextValue) {
    return sync({ touchCapable: nextValue });
  }

  function setRaceActive(nextValue) {
    return sync({ raceActive: nextValue });
  }

  function setOrientation(nextValue) {
    return sync({ orientation: nextValue });
  }

  function openFullscreenHelp() {
    if (!help || state.fullscreenHelpOpen || !state.touchCapable || !state.raceActive) return false;
    beforeOpenFullscreenHelp?.();
    const activeElement = document?.activeElement;
    rememberedFocus = isUsableFocusTarget(activeElement) ? activeElement : null;
    state.fullscreenHelpOpen = true;
    renderAndNotify();
    focusFirstElement(help);
    return true;
  }

  function closeFullscreenHelp({ restoreFocus = true } = {}) {
    if (!state.fullscreenHelpOpen) return false;
    state.fullscreenHelpOpen = false;
    renderAndNotify();
    if (restoreFocus) restoreRememberedFocus();
    else rememberedFocus = null;
    return true;
  }

  return Object.freeze({
    start,
    destroy,
    sync,
    setTouchCapable,
    setRaceActive,
    setOrientation,
    openFullscreenHelp,
    closeFullscreenHelp,
    getState: snapshot,
  });
}
