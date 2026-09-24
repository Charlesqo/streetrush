import * as THREE from 'three';
import { createOutdoorLighting } from './rendering.js';
import { createRenderPipeline } from './render-pipeline.js';
import RAPIER from '@dimforge/rapier3d-compat';
import './style.css';
import { CARS, FIXED_DT, TOTAL_LAPS, TRACK_CONFIG } from './config.js';
import { InputController } from './input.js';
import { TrackSystem } from './track.js';
import { createGameAssetManager } from './game-assets.js';
import { VehicleSystem, disposeOwnedVisual } from './vehicle.js';
import { ProceduralAudio } from './audio.js';
import { createGameAudioProfile, GAME_AUDIO_BANKS } from './game-audio-banks.js';
import { ChaseCamera, TireEffects } from './effects.js';
import { RaceTimingSession, TimingStore, formatRaceDelta, formatRaceTime } from './race-timing.js';
import { getLiveRaceGoal, LONGWAN_TIME_ATTACK, MIN_LIVE_GOAL_CHECKPOINTS } from './race-goals.js';
import { clampFrameDelta } from './physics-scheduling.js';
import { loadSharedCoreCapabilities } from './shared-core-owner.js';
import { initializeRapier } from './rapier-init.js';
import { getOrientationUiState, ORIENTATIONS, shouldFreezeRace } from './orientation.js';
import { createStraightLineDiagnostic, straightLineTrackConfig } from './straight-line-diagnostic.js';

const $ = (id) => document.getElementById(id);
const straightLineParams = new URLSearchParams(location.search);
const straightLineRequested = import.meta.env.DEV && straightLineParams.has('straightline');
const schedulerFault = import.meta.env.DEV
  ? new URLSearchParams(location.search).get('scheduler-fault')
  : null;
const sharedCorePromise = loadSharedCoreCapabilities(
  schedulerFault === 'missing-wasm'
    ? { wasmUrl: '/__streetrush_missing_core.wasm' }
    : undefined,
);
const MEDAL_LABELS = { gold: '金牌', silver: '银牌', bronze: '铜牌' };
const touchCapable = matchMedia('(pointer: coarse)').matches
  || navigator.maxTouchPoints > 0
  || new URLSearchParams(location.search).has('touch');
document.documentElement.classList.toggle('touch-ui', touchCapable);
const standaloneMode = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// Touch support selects controls, not GPU quality. Start with the balanced
// budget on all devices; the performance controller still reduces AO/scale.
const MAX_RENDER_SCALE = 1.35;
const PIXEL_BUDGET = 3_200_000;
const getRenderScaleLimit = () => Math.min(
  devicePixelRatio,
  MAX_RENDER_SCALE,
  Math.max(0.72, Math.sqrt(PIXEL_BUDGET / Math.max(1, innerWidth * innerHeight))),
);
const renderReviewRequested = import.meta.env.DEV && new URLSearchParams(location.search).has('renderreview');
const circuitReviewRequested = import.meta.env.DEV && ['circuitreview', 'pitpreview'].some(key => new URLSearchParams(location.search).has(key));
let lastReviewRender = -Infinity;
let renderReview = null;
let renderScale = getRenderScaleLimit();
renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
const lighting = createOutdoorLighting(renderer, scene);
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 1300);
const renderPipeline = createRenderPipeline(renderer, scene, camera, { maxFps: circuitReviewRequested ? 5 : Infinity });

await initializeRapier(RAPIER);
const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
physicsWorld.integrationParameters.dt = FIXED_DT;
const diagnosticTrackConfig = straightLineRequested ? straightLineTrackConfig(TRACK_CONFIG, {
  extended: straightLineParams.get('straightline') === 'extended',
  accelerationSeconds: Number(straightLineParams.get('accelseconds') ?? 35),
}) : TRACK_CONFIG;
const track = new TrackSystem(diagnosticTrackConfig, scene, renderer, RAPIER, physicsWorld);
const assets = createGameAssetManager(scene, track);
const input = new InputController();
const audio = new ProceduralAudio({
  bankDocument: GAME_AUDIO_BANKS,
  resolveBankProfile: createGameAudioProfile,
  onBankEvent: (event) => recordDevEvent('audio-bank', { event }),
});
document.documentElement.dataset.audioPaused = 'false';
const effects = new TireEffects(scene, { groundRoot: track.group });
renderPipeline.setTireEffects(effects, lighting);
const chaseCamera = new ChaseCamera(camera);
const timingStore = new TimingStore();

let carIndex = straightLineRequested
  ? Math.max(0, CARS.findIndex((car) => car.id === new URLSearchParams(location.search).get('car')))
  : 0;
let vehicle = null;
let vehicleLoadToken = 0;
let vehicleLoadPending = false;
let queuedVehicleIndex = null;
let retryCarIndex = null;
let state = 'menu';
let stateBeforePause = 'race';
let physicsScheduler = null;
let raceProgressCore = null;
let lastFrame = performance.now();
let countdown = 0;
let countdownShown = 0;
let timing = null;
let lastSectorEvent = null;
let lastLapEvent = null;
let startLightsTimer = null;
let performanceVisible = false;
let powerDiagnosticsVisible = false;
let fpsAccumulator = 0;
let lastMeasuredRenderCount = 0;
let slowFrameWindows = 0;
let stableFrameWindows = 0;
let physicsCost = 0;
let inputBlockedLastFrame = false;
let fullscreenHelpShown = false;
let physicsFault = false;
let devTelemetry = null;
let devFixedStepIndex = 0;
let devLastPhysicsTrace = null;
let devLastControlTrace = null;
let devRuntimeOutput = null;
const devKeyboardEvents = [];
const MODAL_DIALOG_IDS = ['orientation-hint', 'fullscreen-help', 'pause-menu', 'finish', 'about'];
const dialogReturnFocus = new Map();

function resetPhysicsScheduler() {
  physicsScheduler?.reset();
}

function setAudioPaused(paused) {
  audio.setPaused(paused);
  document.documentElement.dataset.audioPaused = String(audio.paused);
}

function initializeAudio() {
  return audio.init()
    .then(() => audio.whenBankSettled())
    .finally(() => publishDevVehicleReadiness());
}

const devToolsRequested = import.meta.env.DEV && new URLSearchParams(location.search).has('devtools');
if (devToolsRequested) {
  const { DevTelemetryBuffer } = await import('./dev-telemetry.js');
  devTelemetry = new DevTelemetryBuffer({ capacity: 2048 });
  devRuntimeOutput = document.createElement('output');
  devRuntimeOutput.id = 'streetrush-dev-runtime';
  devRuntimeOutput.hidden = true;
  devRuntimeOutput.setAttribute('aria-hidden', 'true');
  document.body.append(devRuntimeOutput);
  for (const type of ['keydown', 'keyup']) {
    addEventListener(type, (event) => {
      devKeyboardEvents.push({
        type, code: event.code, repeat: event.repeat, trusted: event.isTrusted,
        target: event.target?.tagName ?? null, fixedStepIndex: devFixedStepIndex,
      });
      if (devKeyboardEvents.length > 8) devKeyboardEvents.shift();
    });
  }
}

const straightLineDiagnostic = straightLineRequested ? createStraightLineDiagnostic({
  canvas, startRace, getVehicle: () => vehicle, getState: () => state,
  getReadiness: getDevReadiness, track, fixedDt: FIXED_DT,
  requestedTargetSpeedKmh: Number(straightLineParams.get('targetkmh') ?? 140),
  coastSeconds: Number(straightLineParams.get('coastseconds') ?? 1),
}) : null;

function getDevReadiness() {
  const selectedCar = CARS[carIndex];
  const vehicleMatchesSelection = Boolean(vehicle && selectedCar && vehicle.config.id === selectedCar.id);
  const startableState = state === 'menu' || state === 'finish' || state === 'paused';
  const restartable = state === 'race' && timing?.snapshot().currentLapValid === false;
  const visualWheelSet = vehicle?.visual?.getObjectByName?.('calibrated-wheels');
  const audioBank = audio.snapshot().bank;
  return {
    assetSource: vehicle?.visual?.userData?.source ?? null,
    vehicleLoadPending,
    selectedCarId: selectedCar?.id ?? null,
    mountedCarId: vehicle?.config?.id ?? null,
    visualWheelBindingCount: vehicle?.visualWheelBindings?.length ?? 0,
    visualWheelSource: visualWheelSet?.userData?.visualWheelSource ?? null,
    audioBankState: audioBank.state,
    audioBankId: audioBank.player?.bankId ?? null,
    audioBankMode: audioBank.resolution?.mode ?? null,
    audioBankError: audioBank.error,
    physicsSchedulerOwner: physicsScheduler?.owner ?? null,
    physicsSchedulerFallback: physicsScheduler?.fallbackReason ?? null,
    state,
    restartable,
    startable: Boolean(startableState && !vehicleLoadPending && vehicleMatchesSelection && vehicle?.visual?.userData?.source === 'gltf'),
  };
}

function publishDevVehicleReadiness() {
  if (!import.meta.env.DEV) return;
  const visualWheelSet = vehicle?.visual?.getObjectByName?.('calibrated-wheels');
  const audioBank = audio.snapshot().bank;
  document.documentElement.dataset.mountedCarId = vehicle?.config?.id ?? '';
  document.documentElement.dataset.visualWheelBindingCount = String(vehicle?.visualWheelBindings?.length ?? 0);
  document.documentElement.dataset.visualWheelSource = visualWheelSet?.userData?.visualWheelSource ?? 'none';
  document.documentElement.dataset.audioBankState = audioBank.state;
  document.documentElement.dataset.audioBankId = audioBank.player?.bankId ?? 'none';
  document.documentElement.dataset.audioBankMode = audioBank.resolution?.mode ?? 'procedural';
}

function recordDevEvent(type, details = {}) {
  if (!devTelemetry) return false;
  try {
    return devTelemetry.record({
      type,
      state,
      fixedStepIndex: devFixedStepIndex,
      ...details,
    });
  } catch (error) {
    console.warn('[dev-telemetry] ignored event', error);
    return false;
  }
}

function captureDevPhysicsTrace(phase, frameInput) {
  if (!devToolsRequested || !vehicle) return null;
  const bodyPosition = vehicle.body.translation();
  const bodyRotation = vehicle.body.rotation();
  const report = vehicle.getVehiclePhysicsReport?.() ?? null;
  return {
    phase,
    fixedStepIndex: devFixedStepIndex,
    input: { ...frameInput },
    reportStatus: report?.status ?? null,
    reportAuthority: report?.authority ?? null,
    hostCounters: report?.hostCounters ?? null,
    bodyPose: {
      position: { x: bodyPosition.x, y: bodyPosition.y, z: bodyPosition.z },
      rotation: { x: bodyRotation.x, y: bodyRotation.y, z: bodyRotation.z, w: bodyRotation.w },
    },
    currentPose: {
      position: vehicle.currentPose.position.toArray(),
      rotation: vehicle.currentPose.rotation.toArray(),
    },
    speedKmh: vehicle.telemetry.speedKmh,
    signedSpeedKmh: vehicle.telemetry.signedSpeedKmh,
    steerAngle: vehicle.steerAngle,
    driveIntent: vehicle.telemetry.driveIntent,
    powertrain: { ...vehicle.telemetry.powertrain },
  };
}

function getDevRuntimeSnapshot() {
  const report = vehicle?.getVehiclePhysicsReport?.() ?? null;
  return {
    readiness: getDevReadiness(),
    track: {
      className: track.constructor.name,
      sampleCount: track.samples?.length ?? 0,
      length: track.length ?? track.totalLength ?? null,
    },
    state,
    fixedStepIndex: devFixedStepIndex,
    vehiclePhysicsMode: vehicle?.vehiclePhysicsMode ?? null,
    input: { ...input.frame },
    keyboardEvents: devKeyboardEvents.map((event) => ({ ...event })),
    telemetry: vehicle ? {
      speedKmh: vehicle.telemetry.speedKmh,
      signedSpeedKmh: vehicle.telemetry.signedSpeedKmh,
      driveIntent: vehicle.telemetry.driveIntent,
      steer: vehicle.telemetry.steer,
      throttle: vehicle.telemetry.throttle,
      brake: vehicle.telemetry.brake,
      groundedCount: vehicle.telemetry.wheels.filter((wheel) => wheel.grounded).length,
      powertrain: { ...vehicle.telemetry.powertrain },
    } : null,
    report,
    physicsTrace: devLastPhysicsTrace,
    lastControlTrace: devLastControlTrace,
  };
}

function publishDevRuntimeSnapshot() {
  if (!devRuntimeOutput) return;
  devRuntimeOutput.textContent = JSON.stringify(getDevRuntimeSnapshot());
}

if (devToolsRequested) {
  globalThis.__STREET_RUSH_DEV__ = Object.freeze({
    getReadiness: getDevReadiness,
    getRuntimeSnapshot: getDevRuntimeSnapshot,
    record: (event) => {
      try {
        return devTelemetry.record(event);
      } catch (error) {
        console.warn('[dev-telemetry] ignored event', error);
        return false;
      }
    },
    snapshot: () => devTelemetry.snapshot(),
    clear: () => devTelemetry.clear(),
    serialize: () => devTelemetry.serialize(),
  });
}

function focusVisibleElement(element) {
  if (!(element instanceof HTMLElement)
    || !element.isConnected
    || element.disabled
    || element.closest('.hidden')
    || getComputedStyle(element).visibility === 'hidden'
    || getComputedStyle(element).display === 'none') return false;
  element.focus({ preventScroll: true });
  return true;
}

// Pointer use of an in-race utility returns control to driving. Keyboard
// activation keeps focus so Tab/Enter navigation remains usable.
function withRaceFocus(action) {
  return async (event) => {
    const trigger = event.currentTarget;
    const restore = () => {
      if (event.detail > 0 && (state === 'race' || state === 'countdown')
        && !getOpenModalDialog()
        && [trigger, document.body, document.documentElement].includes(document.activeElement)) {
        focusVisibleElement($('game'));
      }
    };
    try {
      const result = action(event);
      restore();
      await result;
    } finally {
      restore();
    }
  };
}

function openModalDialog(id, trigger = document.activeElement) {
  const dialog = $(id);
  if (!dialog) return;
  for (const otherId of MODAL_DIALOG_IDS) {
    if (otherId !== id) closeModalDialog(otherId, false);
  }
  const returnTarget = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const canRestoreFocus = returnTarget instanceof HTMLElement
    && returnTarget !== dialog
    && !returnTarget.closest('.hidden')
    && getComputedStyle(returnTarget).display !== 'none'
    && getComputedStyle(returnTarget).visibility !== 'hidden';
  if (canRestoreFocus) dialogReturnFocus.set(id, returnTarget);
  dialog.classList.remove('hidden');
  dialog.setAttribute('aria-hidden', 'false');
  const firstFocusable = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
    .find((element) => !element.disabled && getComputedStyle(element).visibility !== 'hidden');
  firstFocusable?.focus({ preventScroll: true });
}

function closeModalDialog(id, restoreFocus = true) {
  const dialog = $(id);
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.setAttribute('aria-hidden', 'true');
  if (id === 'fullscreen-help') {
    fullscreenHelpShown = false;
    input.releaseAll();
    resetPhysicsScheduler();
    lastFrame = performance.now();
  }
  if (id === 'orientation-hint') dialog.setAttribute('inert', '');
  if (!restoreFocus) {
    dialogReturnFocus.delete(id);
    return;
  }
  const returnTarget = dialogReturnFocus.get(id);
  dialogReturnFocus.delete(id);
  focusVisibleElement(returnTarget);
}

function closeAllModalDialogs(restoreFocus = false) {
  for (const id of MODAL_DIALOG_IDS) closeModalDialog(id, restoreFocus);
}

function getOpenModalDialog() {
  return MODAL_DIALOG_IDS
    .map((id) => $(id))
    .find((dialog) => dialog && !dialog.classList.contains('hidden')) ?? null;
}

function trapModalFocus(event) {
  const dialog = getOpenModalDialog();
  if (!dialog || event.code !== 'Tab') return false;
  const focusable = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
    .filter((element) => !element.disabled && getComputedStyle(element).visibility !== 'hidden');
  if (focusable.length === 0) return false;
  const currentIndex = focusable.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
    : currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
  event.preventDefault();
  focusable[nextIndex].focus({ preventScroll: true });
  return true;
}

for (const id of MODAL_DIALOG_IDS) $(id)?.setAttribute('aria-hidden', 'true');

function isAppleTouchDevice() {
  const classicIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);
  const touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return classicIOS || touchMac;
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function syncFullscreenButton() {
  const active = Boolean(fullscreenElement());
  $('fullscreen-button').hidden = isAppleTouchDevice() && standaloneMode;
  $('fullscreen-button').classList.toggle('active', active);
  $('fullscreen-button').setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
  $('orientation-fullscreen').hidden = standaloneMode;
}

function syncOrientationHint() {
  const hint = $('orientation-hint');
  if (!hint) return;
  const orientationState = getOrientationUiState({
    touchCapable,
    raceActive: state === 'race' || state === 'countdown',
    orientation: matchMedia('(orientation: portrait)').matches ? ORIENTATIONS.PORTRAIT : ORIENTATIONS.LANDSCAPE,
    fullscreenHelpOpen: fullscreenHelpShown,
  });
  const raceActive = state === 'race' || state === 'countdown';
  const openModal = getOpenModalDialog();
  const blockedByAnotherModal = openModal && openModal.id !== 'orientation-hint';
  const shouldShow = orientationState.orientationHintVisible && raceActive && !blockedByAnotherModal;
  if (!shouldShow) {
    if (!hint.classList.contains('hidden')) {
      closeModalDialog('orientation-hint');
      input.releaseAll();
      resetPhysicsScheduler();
      lastFrame = performance.now();
    }
    else {
      hint.setAttribute('aria-hidden', 'true');
      hint.setAttribute('inert', '');
    }
    return;
  }
  if (hint.classList.contains('hidden') || hint.getAttribute('aria-hidden') !== 'false') {
    input.releaseAll();
    resetPhysicsScheduler();
    lastFrame = performance.now();
    hint.removeAttribute('inert');
    openModalDialog('orientation-hint', document.activeElement);
  }
}

function isRaceBlockedByModal() {
  const openModal = getOpenModalDialog();
  return shouldFreezeRace({
    touchCapable,
    raceActive: state === 'race' || state === 'countdown',
    orientation: matchMedia('(orientation: portrait)').matches ? ORIENTATIONS.PORTRAIT : ORIENTATIONS.LANDSCAPE,
    modalId: openModal?.id ?? null,
  });
}

function showFullscreenHelp() {
  if (fullscreenHelpShown) return;
  fullscreenHelpShown = true;
  openModalDialog('fullscreen-help');
}

async function lockLandscape() {
  try {
    await screen.orientation?.lock?.('landscape');
  } catch {
    // Orientation lock is best-effort and is not exposed by every browser.
  }
}

async function requestPageFullscreen() {
  if (standaloneMode || fullscreenElement()) {
    if (touchCapable) await lockLandscape();
    return;
  }
  if (isAppleTouchDevice()) {
    showFullscreenHelp();
    return;
  }
  const request = document.documentElement.requestFullscreen
    || document.documentElement.webkitRequestFullscreen;
  if (!request) {
    showFullscreenHelp();
    return;
  }
  try {
    await request.call(document.documentElement);
    if (touchCapable) await lockLandscape();
  } catch (error) {
    console.warn('Fullscreen request failed', error);
    showFullscreenHelp();
  }
}

async function togglePageFullscreen() {
  if (standaloneMode) return;
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      await exit?.call(document);
    } catch (error) {
      console.warn('Fullscreen exit failed', error);
    }
  } else {
    await requestPageFullscreen();
  }
  syncFullscreenButton();
}

function showMessage(text, duration = 760) {
  const element = $('race-message');
  element.textContent = text;
  element.style.opacity = 1;
  element.style.transform = 'translate(-50%, -50%) skew(-5deg) scale(1)';
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    element.style.opacity = 0;
    element.style.transform = 'translate(-50%, -50%) skew(-5deg) scale(1.12)';
  }, duration);
}

function syncInvalidLapRestart(snapshot = timing?.snapshot()) {
  const button = $('invalid-lap-restart-button');
  if (!button) return;
  const visible = state === 'race' && snapshot?.currentLapValid === false;
  button.classList.toggle('hidden', !visible);
  button.setAttribute('aria-hidden', String(!visible));
}

function setStartLights(lightState, autoOffMs = 0) {
  clearTimeout(startLightsTimer);
  track.setStartLights(lightState);
  if (autoOffMs > 0) {
    startLightsTimer = setTimeout(() => track.setStartLights('off'), autoOffMs);
  }
}

function setDeltaUI(element, deltaMs, fallback) {
  const hasDelta = Number.isFinite(deltaMs);
  element.textContent = hasDelta ? formatRaceDelta(deltaMs) : fallback;
  element.classList.toggle('ahead', hasDelta && deltaMs < 0);
  element.classList.toggle('behind', hasDelta && deltaMs > 0);
}

function medalTargetsForCar(carId) {
  return LONGWAN_TIME_ATTACK.medalTargetsMs?.[carId] ?? null;
}

function updateRaceGoalUI(snapshot) {
  const label = $('race-target-label');
  const target = $('race-target');
  const delta = $('race-target-delta');
  const goal = getLiveRaceGoal({
    targets: medalTargetsForCar(vehicle?.config.id),
    checkpointsPassed: snapshot.checkpointsPassed,
    totalCheckpoints: TOTAL_LAPS * TRACK_CONFIG.checkpoints,
    runTimeMs: snapshot.runTimeMs,
    currentLapValid: snapshot.currentLapValid,
    laps: snapshot.laps,
  });
  if (goal?.invalid) {
    label.textContent = '本场已无效';
    target.textContent = '不计奖牌';
    delta.textContent = '完成仍可看单圈';
    delta.classList.remove('ahead', 'behind');
    return;
  }
  if (!goal) {
    label.textContent = '下一目标';
    target.textContent = '--:--.---';
    delta.textContent = '目标待定';
    delta.classList.remove('ahead', 'behind');
    return;
  }

  label.textContent = `下一目标 · ${MEDAL_LABELS[goal.medal]}`;
  target.textContent = formatRaceTime(goal.targetMs);
  const hasDelta = Number.isFinite(goal.deltaMs);
  delta.textContent = hasDelta ? `预测 ${formatRaceDelta(goal.deltaMs)}` : `完成 ${MIN_LIVE_GOAL_CHECKPOINTS} 个检查点后计算`;
  delta.classList.toggle('ahead', hasDelta && goal.deltaMs < 0);
  delta.classList.toggle('behind', hasDelta && goal.deltaMs > 0);
}

function updateCarUI() {
  const config = CARS[carIndex];
  const setTextIfPresent = (id, value) => {
    const element = $(id);
    if (element) element.textContent = value;
  };
  setTextIfPresent('car-index', `${String(carIndex + 1).padStart(2, '0')} / ${String(CARS.length).padStart(2, '0')}`);
  setTextIfPresent('car-name', config.name);
  setTextIfPresent('stat-speed', config.speed);
  setTextIfPresent('stat-accel', config.accel);
  setTextIfPresent('stat-grip', config.grip);
  const targets = medalTargetsForCar(config.id);
  setTextIfPresent('garage-goal', targets
    ? `三圈奖牌目标 · 金 ${formatRaceTime(targets.gold)} / 银 ${formatRaceTime(targets.silver)} / 铜 ${formatRaceTime(targets.bronze)}`
    : '三圈奖牌目标 · 待定');
  const record = timingStore.load(
    { trackId: LONGWAN_TIME_ATTACK.id, carId: config.id },
    LONGWAN_TIME_ATTACK.sectorCheckpoints.length,
  );
  setTextIfPresent('garage-best-lap', formatRaceTime(record.bestLapMs));
  setTextIfPresent('garage-best-race', formatRaceTime(record.bestRaceMsByLaps[String(TOTAL_LAPS)]));
}

async function mountVehicle(index, initial = false) {
  if (vehicleLoadPending) {
    if (state === 'menu') queuedVehicleIndex = index;
    return false;
  }
  const token = ++vehicleLoadToken;
  const config = CARS[index];
  vehicleLoadPending = true;
  $('garage-status').textContent = `LOADING ${config.name}`;
  $('garage-status').classList.add('active');
  $('start-button').disabled = true;
  $('retry-car-button').classList.add('hidden');
  retryCarIndex = null;
  if (initial) $('loading-status').textContent = `载入 ${config.name}…`;
  let visual = null;
  let visualHandedOff = false;
  try {
    visual = await assets.instantiateCar(config, (progress) => {
      if (initial) $('loading-progress').style.width = `${10 + progress * 76}%`;
    });
    if (token !== vehicleLoadToken || state !== 'menu') {
      disposeOwnedVisual(visual);
      return false;
    }
    if (visual.userData?.source !== 'gltf') {
      throw new Error(`Playable vehicle asset unavailable for ${config.id}`);
    }
    const nextVehicle = new VehicleSystem({
      RAPIER,
      world: physicsWorld,
      scene,
      track,
      config,
      visual,
      vehiclePhysicsMode: 'v24-active',
  onAutomaticReset: (reason) => {
    straightLineDiagnostic?.automaticReset(reason);
        if (state === 'race') {
          invalidateCurrentLap(reason, 'RECOVERY · LAP INVALID');
          recordDevEvent('automatic-reset', { reason });
        }
      },
    });
    nextVehicle.body.setEnabled(false);
    const previous = vehicle;
    vehicle = nextVehicle;
    visualHandedOff = true;
    previous?.destroy();
    const audioSelection = audio.setVehicle(config);
    publishDevVehicleReadiness();
    Promise.resolve(audioSelection).then(
      () => { if (vehicle?.config.id === config.id) publishDevVehicleReadiness(); },
      () => { if (vehicle?.config.id === config.id) publishDevVehicleReadiness(); },
    );
    if (visual.userData.source === 'gltf') assets.preloadNeighbors(CARS, index);
    chaseCamera.snap(vehicle.currentPose.position, vehicle.currentPose.rotation);
    return true;
  } catch (error) {
    if (visual && !visualHandedOff) {
      scene.remove(visual);
      disposeOwnedVisual(visual);
    }
    if (token === vehicleLoadToken) {
      retryCarIndex = index;
      const mountedIndex = CARS.findIndex((candidate) => candidate.id === vehicle?.config.id);
      if (mountedIndex >= 0) {
        carIndex = mountedIndex;
        updateCarUI();
      }
      console.warn(`Vehicle load failed for ${config.id}`, error);
    }
    return false;
  } finally {
    if (token === vehicleLoadToken) {
      const nextIndex = queuedVehicleIndex;
      queuedVehicleIndex = null;
      if (state === 'menu' && nextIndex !== null && nextIndex !== index) {
        vehicleLoadPending = false;
        carIndex = nextIndex;
        updateCarUI();
        return mountVehicle(nextIndex, initial);
      }
      vehicleLoadPending = false;
      const selectionReady = vehicle?.config.id === CARS[carIndex].id
        && vehicle.visual?.userData?.source === 'gltf';
      $('garage-status').classList.remove('active');
      $('garage-status').textContent = selectionReady ? 'READY' : 'LOAD FAILED';
      $('start-button').disabled = !selectionReady;
      $('retry-car-button').classList.toggle('hidden', retryCarIndex === null);
    }
  }
}

async function selectCar(direction) {
  if (state !== 'menu') return;
  carIndex = (carIndex + direction + CARS.length) % CARS.length;
  updateCarUI();
  if (vehicleLoadPending) {
    $('garage-status').textContent = `LOADING ${CARS[carIndex].name}`;
    $('garage-status').classList.add('active');
    $('start-button').disabled = true;
    queuedVehicleIndex = carIndex;
    return;
  }
  await mountVehicle(carIndex);
}

function resetRaceState() {
  timing = new RaceTimingSession({
    trackId: LONGWAN_TIME_ATTACK.id,
    carId: vehicle.config.id,
    totalLaps: TOTAL_LAPS,
    checkpointCount: TRACK_CONFIG.checkpoints,
    sectorCheckpoints: LONGWAN_TIME_ATTACK.sectorCheckpoints,
    medalTargetsMs: medalTargetsForCar(vehicle.config.id),
    store: timingStore,
    ...(import.meta.env.DEV && raceProgressCore
      ? { progressCore: raceProgressCore, progressMode: 'owner' }
      : {}),
  });
  document.documentElement.dataset.raceTimingProgressOwner = timing.progressOwner;
  lastSectorEvent = null;
  lastLapEvent = null;
  const snapshot = timing.snapshot();
  $('lap-now').textContent = '1';
  $('checkpoint-now').textContent = '0';
  $('race-time').textContent = '00:00.000';
  $('lap-time').textContent = '00:00.000';
  $('sector-now').textContent = '1';
  $('sector-time').textContent = '00:00.000';
  $('best-lap').textContent = formatRaceTime(snapshot.bestLapMs);
  $('lap-valid-state').textContent = 'VALID';
  $('lap-valid-state').classList.remove('invalid');
  setDeltaUI($('sector-delta'), null, snapshot.bestSectorsMs[0] == null ? 'NO DATA' : 'TARGET SET');
  setDeltaUI($('lap-delta'), null, snapshot.bestLapMs == null ? 'FIRST RUN' : 'PB LOADED');
  updateRaceGoalUI(snapshot);
  syncInvalidLapRestart(snapshot);
  track.setCheckpointHighlight(snapshot.expectedCheckpointIndex);
}

function startRace() {
  const restartingInvalidLap = state === 'race' && timing?.snapshot().currentLapValid === false;
  if (state !== 'menu' && state !== 'finish' && state !== 'paused' && !restartingInvalidLap) return;
  if (
    !vehicle
    || vehicleLoadPending
    || vehicle.config.id !== CARS[carIndex].id
    || vehicle.visual?.userData?.source !== 'gltf'
  ) return;
  closeAllModalDialogs(false);
  input.releaseAll();
  resetPhysicsScheduler();
  lastFrame = performance.now();
  if (standaloneMode && touchCapable) lockLandscape();
  setAudioPaused(false);
  initializeAudio().catch((error) => console.warn('Audio initialization failed', error));
  state = 'countdown';
  physicsFault = false;
  $('resume-button').disabled = false;
  $('pause-menu-title').textContent = '暂停驾驶';
  $('pause-menu-status').classList.add('hidden');
  document.body.classList.add('race-active');
  $('mobile-controls').classList.add('active');
  $('race-menu-button').classList.remove('hidden');
  $('power-diagnostics-button').classList.remove('hidden');
  $('pause-menu').classList.add('hidden');
  input.setTouchEnabled(touchCapable);
  $('menu').classList.add('hidden');
  $('finish').classList.add('hidden');
  $('hud').classList.remove('hidden');
  vehicle.body.setEnabled(true);
  vehicle.reset(0);
  resetRaceState();
  countdown = 3;
  countdownShown = 3;
  setStartLights('three');
  showMessage('3', 650);
  devFixedStepIndex = 0;
  recordDevEvent('run-requested', { carId: vehicle.config.id, trackId: LONGWAN_TIME_ATTACK.id });
  focusVisibleElement($('game'));
  syncOrientationHint();
}

function renderFinishSummary(summary) {
  $('finish-kicker').textContent = summary?.valid ? '环线挑战完成' : '本次成绩未认证';
  $('finish-title').textContent = summary?.newBestRace
    ? '刷新纪录。'
    : summary?.valid
      ? '漂亮收车。'
      : '还有下一圈。';
  $('finish-time').textContent = formatRaceTime(summary?.timeMs);
  $('finish-best-lap').textContent = formatRaceTime(summary?.bestLapMs);
  $('finish-race-best').textContent = formatRaceTime(summary?.bestRaceMs);
  const validLaps = summary?.laps?.filter((lap) => lap.valid).length ?? 0;
  $('finish-valid-laps').textContent = `${validLaps} / ${TOTAL_LAPS}`;

  const medalElement = $('finish-medal');
  const medal = summary?.valid && summary.medal ? summary.medal : null;
  medalElement.textContent = !summary?.valid
    ? '未认证'
    : medal
      ? MEDAL_LABELS[medal]
      : '未达标';
  medalElement.className = `medal-value ${medal ?? (summary?.valid ? 'none' : 'unverified')}`;

  const raceDelta = summary?.valid && Number.isFinite(summary.deltaMs) ? summary.deltaMs : null;
  setDeltaUI($('finish-race-delta'), raceDelta, summary?.valid ? '首次挑战' : '未认证');

  const targets = medalTargetsForCar(vehicle?.config.id);
  if (!summary?.valid) {
    $('finish-target').textContent = '未认证';
  } else if (targets) {
    const targetMedal = summary.medal ?? 'bronze';
    $('finish-target').textContent = `${MEDAL_LABELS[targetMedal]} ${formatRaceTime(targets[targetMedal])}`;
  } else {
    $('finish-target').textContent = '--:--.---';
  }

  const lapList = $('finish-laps');
  lapList.replaceChildren();
  for (const lap of summary?.laps ?? []) {
    const row = document.createElement('li');
    row.className = lap.valid ? 'valid' : 'invalid';
    const label = document.createElement('span');
    const time = document.createElement('span');
    const status = document.createElement('span');
    label.textContent = `LAP ${lap.number}`;
    time.textContent = formatRaceTime(lap.timeMs);
    status.textContent = lap.valid ? (lap.newBest ? 'NEW PB' : formatRaceDelta(lap.deltaMs)) : 'INVALID';
    row.append(label, time, status);
    lapList.append(row);
  }
  $('finish-copy').textContent = !summary?.valid
    ? '本次包含无效圈，总成绩不会写入 PB；其中的有效单圈仍已保存。'
    : summary.newBestRace
      ? '新的三圈个人最佳已保存在本机。按 R 可以立即再跑。'
      : '成绩与有效单圈已保存在本机。按 R 可以立即再跑。';
}

function finishRace(summary = timing?.getSummary()) {
  state = 'finish';
  track.setCheckpointHighlight(null);
  closeAllModalDialogs(false);
  input.releaseAll();
  setStartLights('off');
  document.body.classList.remove('race-active');
  $('mobile-controls').classList.remove('active');
  $('race-menu-button').classList.add('hidden');
  $('power-diagnostics-button').classList.add('hidden');
  $('pause-menu').classList.add('hidden');
  input.setTouchEnabled(false);
  vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  vehicle.body.setEnabled(false);
  vehicle.telemetry.speedKmh = 0;
  vehicle.telemetry.throttle = 0;
  renderFinishSummary(summary);
  $('finish').classList.remove('hidden');
  $('hud').classList.add('hidden');
  syncInvalidLapRestart();
  openModalDialog('finish', $('race-menu-button'));
}

function returnGarage() {
  state = 'menu';
  setAudioPaused(false);
  track.setCheckpointHighlight(null);
  closeAllModalDialogs(false);
  input.releaseAll();
  resetPhysicsScheduler();
  lastFrame = performance.now();
  setStartLights('off');
  document.body.classList.remove('race-active');
  $('mobile-controls').classList.remove('active');
  $('race-menu-button').classList.add('hidden');
  $('power-diagnostics-button').classList.add('hidden');
  $('pause-menu').classList.add('hidden');
  input.setTouchEnabled(false);
  $('finish').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  updateCarUI();
  syncInvalidLapRestart();
  vehicle.reset(0);
  vehicle.body.setEnabled(false);
  vehicle.telemetry.speedKmh = 0;
  vehicle.telemetry.throttle = 0;
  chaseCamera.snap(vehicle.currentPose.position, vehicle.currentPose.rotation);
  timing = null;
  focusVisibleElement($('start-button'));
}

function openRaceMenu() {
  if (state !== 'race' && state !== 'countdown') return;
  stateBeforePause = state;
  state = 'paused';
  setAudioPaused(true);
  input.releaseAll();
  input.setTouchEnabled(false);
  $('mobile-controls').classList.remove('active');
  syncInvalidLapRestart();
  openModalDialog('pause-menu', $('race-menu-button'));
}

function pauseOnLifecycleLoss() {
  if (state !== 'race' && state !== 'countdown') return;
  openRaceMenu();
}

function handleVisibilityChange() {
  if (document.hidden) pauseOnLifecycleLoss();
}

function resumeRace() {
  if (state !== 'paused' || physicsFault) return;
  state = stateBeforePause;
  setAudioPaused(false);
  resetPhysicsScheduler();
  lastFrame = performance.now();
  input.setTouchEnabled(touchCapable);
  $('mobile-controls').classList.add('active');
  closeModalDialog('pause-menu', false);
  syncInvalidLapRestart();
  focusVisibleElement($('game'));
  syncOrientationHint();
}

function handleTimingEvents(events) {
  for (const event of events) {
    recordDevEvent(event.type, { event });
    if (event.type === 'checkpoint-completed') {
      const checkpointLabel = event.checkpointOrdinal === TRACK_CONFIG.checkpoints
        ? 'FINISH GATE'
        : `CHECKPOINT ${String(event.checkpointOrdinal).padStart(2, '0')}`;
      showMessage(checkpointLabel, 520);
    } else if (event.type === 'sector-completed') {
      lastSectorEvent = event;
    } else if (event.type === 'lap-completed') {
      lastLapEvent = event;
      lastSectorEvent = null;
      if (event.lap.number < TOTAL_LAPS) {
        const label = event.lap.valid
          ? event.lap.newBest
            ? 'NEW PERSONAL BEST'
            : `LAP ${event.lap.number} · ${formatRaceTime(event.lap.timeMs)}`
          : `LAP ${event.lap.number} INVALID`;
        showMessage(label, 1100);
      }
    } else if (event.type === 'run-completed') {
      finishRace(event.summary);
    }
  }
  track.setCheckpointHighlight(state === 'race' || state === 'countdown'
    ? timing?.snapshot().expectedCheckpointIndex
    : null);
}

function invalidateCurrentLap(reason, message = 'LAP INVALID') {
  const event = timing?.invalidate(reason);
  syncInvalidLapRestart();
  if (event) {
    recordDevEvent('lap-invalidated', { reason, event });
    showMessage(message, 950);
  }
}

function updateCheckpoints() {
  if (state !== 'race' || !timing) return;
  const expectedCheckpoint = timing.snapshot().expectedCheckpointIndex;
  const sampleCount = track.samples.length;
  const targetIndex = Math.floor((expectedCheckpoint % TRACK_CONFIG.checkpoints) / TRACK_CONFIG.checkpoints * sampleCount);
  let difference = vehicle.trackHint - targetIndex;
  if (difference > sampleCount / 2) difference -= sampleCount;
  if (difference < -sampleCount / 2) difference += sampleCount;
  const checkpointTrackInfo = track.nearestInfo(vehicle.currentPose.position, vehicle.trackHint);
  const onRoad = Math.abs(checkpointTrackInfo.offset) < TRACK_CONFIG.width * 0.5;
  if (Math.abs(difference) > 7 || !onRoad || vehicle.telemetry.signedSpeedKmh < 8) return;
  const events = timing.passCheckpoint(expectedCheckpoint);
  handleTimingEvents(events);
}

function fixedUpdate(frameInput) {
  if (!vehicle) return;
  if (state === 'menu' || state === 'finish' || state === 'paused') {
    input.consumeFixedPulses();
    return;
  }
  devFixedStepIndex += 1;
  if (state === 'race' && frameInput.reset) {
    invalidateCurrentLap('manual-reset', 'RESET · LAP INVALID');
    recordDevEvent('manual-reset', { reason: 'manual-reset' });
    vehicle.reset(vehicle.safeSample);
  }
  if (state === 'countdown') {
    countdown -= FIXED_DT;
    const nextNumber = Math.ceil(countdown);
    if (nextNumber > 0 && nextNumber !== countdownShown) {
      countdownShown = nextNumber;
      setStartLights(nextNumber === 3 ? 'three' : nextNumber === 2 ? 'two' : 'one');
      showMessage(String(nextNumber), 650);
    }
    if (countdown <= 0) {
      state = 'race';
      const runStarted = timing.start();
      recordDevEvent('run-started', { event: runStarted, carId: vehicle.config.id, trackId: LONGWAN_TIME_ATTACK.id });
      setStartLights('go', 1100);
      showMessage('GO!', 800);
    }
  }
  const active = state === 'race';
  if (devToolsRequested) devLastPhysicsTrace = captureDevPhysicsTrace('vehicle-fixed-update', frameInput);
  vehicle.fixedUpdate(frameInput, !active, FIXED_DT);
  if (devToolsRequested) devLastPhysicsTrace = captureDevPhysicsTrace('vehicle-fixed-update-complete', frameInput);
  physicsWorld.step();
  if (devToolsRequested) devLastPhysicsTrace = captureDevPhysicsTrace('rapier-world-step', frameInput);
  vehicle.afterPhysics();
  straightLineDiagnostic?.afterPhysics(frameInput, devFixedStepIndex);
  if (devToolsRequested) {
    devLastPhysicsTrace = captureDevPhysicsTrace('afterPhysics', frameInput);
    if (active && (Math.abs(frameInput.steer) > 0.01
      || (frameInput.rawThrottle ?? frameInput.throttle) > 0.01
      || (frameInput.rawBrake ?? frameInput.brake) > 0.01
      || (frameInput.rawHandbrake ?? frameInput.handbrake) > 0.01
      || frameInput.driveIntent !== 0)) {
      devLastControlTrace = devLastPhysicsTrace;
    }
    if (devFixedStepIndex % 6 === 0) publishDevRuntimeSnapshot();
  }
  if (active) {
    timing.advance(FIXED_DT * 1000);
    const trackInfo = track.nearestInfo(vehicle.currentPose.position, vehicle.trackHint);
    const beyondKerb = Math.abs(trackInfo.offset) > TRACK_CONFIG.width * 0.5 + 1.05;
    if (beyondKerb) invalidateCurrentLap('track-limits');
    updateCheckpoints();
  }
  input.consumeFixedPulses();
}

function normalizedDiagnosticValue(value) {
  return Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0;
}

function diagnosticPercent(value) {
  return `${Math.round(normalizedDiagnosticValue(value) * 100)}%`;
}

function diagnosticRatio(applied, requested) {
  if (!Number.isFinite(requested) || requested <= 0.01) return 1;
  return normalizedDiagnosticValue(applied / requested);
}

function updateDiagnosticPedal(id, value) {
  const element = $(id);
  const normalized = normalizedDiagnosticValue(value);
  element.textContent = diagnosticPercent(normalized);
  element.classList.toggle('maximum', normalized >= 0.995);
}

function updatePowerDiagnostics() {
  if (!powerDiagnosticsVisible || !vehicle) return;
  const frame = input.frame;
  const telemetry = vehicle.telemetry;
  const powertrain = telemetry.powertrain;

  updateDiagnosticPedal('diagnostic-throttle-request', frame.rawThrottle);
  updateDiagnosticPedal('diagnostic-throttle-filtered', frame.throttle);
  updateDiagnosticPedal('diagnostic-throttle-applied', telemetry.throttle);
  updateDiagnosticPedal('diagnostic-brake-request', frame.rawBrake);
  updateDiagnosticPedal('diagnostic-brake-filtered', frame.brake);
  updateDiagnosticPedal('diagnostic-brake-applied', telemetry.brake);
  updateDiagnosticPedal('diagnostic-handbrake-request', frame.rawHandbrake);
  updateDiagnosticPedal('diagnostic-handbrake-filtered', frame.handbrake);
  updateDiagnosticPedal('diagnostic-handbrake-applied', telemetry.handbrake);

  const driveRequested = powertrain.wheelDriveTorqueRequestedNm
    ?? powertrain.driveTorqueRequestedNm;
  const driveApplied = powertrain.wheelDriveTorqueAppliedNm
    ?? powertrain.driveTorqueAppliedNm;
  const brakeRequested = powertrain.driverServiceBrakeTorqueRequestedNm
    ?? powertrain.serviceBrakeTorqueRequestedNm;
  const brakeApplied = powertrain.driverServiceBrakeTorqueAppliedNm
    ?? powertrain.serviceBrakeTorqueAppliedNm;
  const driveRatio = diagnosticRatio(
    driveApplied,
    driveRequested,
  );
  const brakeRatio = diagnosticRatio(
    brakeApplied,
    brakeRequested,
  );
  $('diagnostic-drive-torque').textContent = `${Math.round(driveApplied)} / ${Math.round(driveRequested)} N·m`;
  $('diagnostic-brake-torque').textContent = `${Math.round(brakeApplied)} / ${Math.round(brakeRequested)} N·m`;
  $('diagnostic-handbrake-torque').textContent = `${Math.round(powertrain.handbrakeTorqueAppliedNm)} / ${Math.round(powertrain.handbrakeTorqueRequestedNm)} N·m`;
  $('diagnostic-drive-limit').textContent = diagnosticPercent(driveRatio);
  $('diagnostic-brake-limit').textContent = diagnosticPercent(brakeRatio);
  $('diagnostic-drive-limit').classList.toggle('limited', driveRequested > 0.01 && driveRatio < 0.995);
  $('diagnostic-brake-limit').classList.toggle('limited', brakeRequested > 0.01 && brakeRatio < 0.995);
  $('diagnostic-drive-meter').style.width = diagnosticPercent(driveRatio);
  $('diagnostic-brake-meter').style.width = diagnosticPercent(brakeRatio);

  const maximumPedals = [];
  if (frame.rawThrottle >= 0.995) maximumPedals.push('油门 MAX');
  if (frame.rawBrake >= 0.995) maximumPedals.push('刹车 MAX');
  if (frame.rawHandbrake >= 0.995) maximumPedals.push('手刹 MAX');
  $('diagnostic-max-state').textContent = maximumPedals.length
    ? maximumPedals.join(' · ')
    : 'PEDALS BELOW MAX';
  $('diagnostic-max-state').classList.toggle('maximum', maximumPedals.length > 0);

  const limitStates = [];
  if (frame.directionConflict) limitStates.push('W+S → BRAKE');
  if (telemetry.tcsActive) limitStates.push(`TCS DRIVE ${diagnosticPercent(driveRatio)}`);
  else if (driveRequested > 0.01 && driveRatio < 0.995) {
    limitStates.push(`CONTACT DRIVE ${diagnosticPercent(driveRatio)}`);
  }
  if (telemetry.absActive) limitStates.push(`ABS BRAKE ${diagnosticPercent(brakeRatio)}`);
  else if (brakeRequested > 0.01 && brakeRatio < 0.995) {
    limitStates.push(`CONTACT BRAKE ${diagnosticPercent(brakeRatio)}`);
  }
  const limitState = $('diagnostic-limit-state');
  limitState.textContent = limitStates.length ? limitStates.join(' · ') : 'NO LIMIT';
  limitState.classList.toggle('arbitrated', frame.directionConflict);
  limitState.classList.toggle('limited', !frame.directionConflict && limitStates.length > 0);
}

function setPowerDiagnosticsVisible(visible) {
  powerDiagnosticsVisible = Boolean(visible);
  $('power-diagnostics').classList.toggle('hidden', !powerDiagnosticsVisible);
  $('power-diagnostics').setAttribute('aria-hidden', String(!powerDiagnosticsVisible));
  $('power-diagnostics-button').classList.toggle('active', powerDiagnosticsVisible);
  $('power-diagnostics-button').setAttribute('aria-pressed', String(powerDiagnosticsVisible));
  $('power-diagnostics-button').setAttribute(
    'aria-label',
    powerDiagnosticsVisible ? '隐藏踏板与动力诊断' : '显示踏板与动力诊断',
  );
  $('power-diagnostics-button').textContent = powerDiagnosticsVisible ? '踏板 ON' : '踏板 HUD';
  if (powerDiagnosticsVisible) updatePowerDiagnostics();
}

function updateHUD() {
  if (!vehicle) return;
  const telemetry = vehicle.telemetry;
  const timingSnapshot = timing?.snapshot();
  if (timingSnapshot) {
    $('race-time').textContent = formatRaceTime(timingSnapshot.runTimeMs);
    $('lap-now').textContent = String(timingSnapshot.currentLapNumber);
    $('checkpoint-now').textContent = String(timingSnapshot.checkpointInLap);
    $('lap-time').textContent = formatRaceTime(timingSnapshot.lapTimeMs);
    $('sector-now').textContent = String(timingSnapshot.currentSectorNumber);
    $('sector-time').textContent = formatRaceTime(timingSnapshot.sectorTimeMs);
    $('best-lap').textContent = formatRaceTime(timingSnapshot.bestLapMs);
    $('lap-valid-state').textContent = timingSnapshot.currentLapValid ? 'VALID' : 'INVALID';
    $('lap-valid-state').classList.toggle('invalid', !timingSnapshot.currentLapValid);
    syncInvalidLapRestart(timingSnapshot);
    setDeltaUI(
      $('sector-delta'),
      lastSectorEvent?.deltaMs,
      timingSnapshot.bestSectorsMs[timingSnapshot.currentSectorNumber - 1] == null ? 'NO DATA' : 'TARGET SET',
    );
    const completedLap = lastLapEvent?.lap;
    const lapFallback = completedLap?.newBest
      ? 'NEW PB'
      : completedLap && !completedLap.valid
        ? 'INVALID'
        : timingSnapshot.bestLapMs == null
          ? 'FIRST RUN'
          : 'PB ACTIVE';
    setDeltaUI($('lap-delta'), completedLap?.deltaMs, lapFallback);
    updateRaceGoalUI(timingSnapshot);
  }
  $('speed').textContent = String(Math.round(telemetry.speedKmh));
  $('gear').textContent = telemetry.reverse ? 'R' : String(telemetry.gear);
  $('rpm').textContent = String(Math.round(telemetry.rpm / 100) * 100);
  $('shift-mode').textContent = vehicle.transmissionMode;
  $('mobile-mode').textContent = vehicle.transmissionMode;
  $('mobile-controls').classList.toggle('manual', vehicle.transmissionMode === 'MT');
  $('throttle-bar').style.width = `${telemetry.throttle * 100}%`;
  $('brake-bar').style.width = `${telemetry.brake * 100}%`;
  const assist = telemetry.absActive ? 'ABS' : telemetry.tcsActive ? 'TCS' : telemetry.stabilityActive ? 'ESC' : 'READY';
  $('assist-state').textContent = assist;
  $('drive-mode').textContent = telemetry.reverse ? 'REVERSE' : telemetry.surface.toUpperCase();
  updatePowerDiagnostics();
}

function updatePerformance(frameDt) {
  if (renderReviewRequested) return;
  fpsAccumulator += frameDt;
  if (fpsAccumulator < 0.5) return;
  const count = renderPipeline.renderedFrames;
  const fps = Math.round((count - lastMeasuredRenderCount) / fpsAccumulator);
  $('perf').textContent = `${fps}${Number.isFinite(renderPipeline.maxFps) ? `/${renderPipeline.maxFps}` : ''} FPS · ${canvas.width}×${canvas.height} · MSAA ${renderPipeline.msaaSamples}× · AO ${renderPipeline.qualityTier} · PHYS ${physicsCost.toFixed(2)}ms · ${renderer.info.render.calls} DRAWS · ${renderer.info.render.triangles.toLocaleString()} TRI`;
  lastMeasuredRenderCount = count;
  fpsAccumulator = 0;
  // Preview deliberately runs slowly; normal driving keeps adaptive quality.
  if (circuitReviewRequested) return;
  slowFrameWindows = fps < 48 ? slowFrameWindows + 1 : Math.max(0, slowFrameWindows - 1);
  stableFrameWindows = fps > 57 ? stableFrameWindows + 1 : 0;
  if (slowFrameWindows >= 3) {
    if (renderPipeline.qualityTier > 0) renderPipeline.setQualityTier(renderPipeline.qualityTier - 1);
    else if (renderScale > 0.72) {
      renderScale = Math.max(0.72, renderScale - 0.12);
      renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
    }
    slowFrameWindows = 0;
    stableFrameWindows = 0;
  } else if (stableFrameWindows >= 8) {
    if (renderScale < getRenderScaleLimit()) {
      renderScale = Math.min(getRenderScaleLimit(), renderScale + 0.05);
      renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
    } else if (renderPipeline.qualityTier < 2) renderPipeline.setQualityTier(renderPipeline.qualityTier + 1);
    stableFrameWindows = 0;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  const frameDt = clampFrameDelta((now - lastFrame) / 1000);
  lastFrame = now;
  if (!vehicle) return;
  if (input.consumeGamepadMenuPulse()) {
    if (state === 'menu' || state === 'finish') startRace();
    else if (state === 'paused') resumeRace();
    else if (state === 'race' || state === 'countdown') openRaceMenu();
  }
  const inputBlocked = state === 'paused' || isRaceBlockedByModal();
  if (inputBlocked) {
    setAudioPaused(true);
    if (!inputBlockedLastFrame) input.releaseAll();
    inputBlockedLastFrame = true;
    resetPhysicsScheduler();
    if (renderReviewRequested && !renderReview?.measuring && now - lastReviewRender < 200) return;
    const reviewFrameDt = Math.min(.25, (now - lastReviewRender) / 1000);
    vehicle.syncVisual(1);
    chaseCamera.update(frameDt, vehicle.visual.position, vehicle.visual.quaternion, vehicle.telemetry, false);
    if (renderReviewRequested && effects.demo) effects.update(reviewFrameDt, vehicle.telemetry, vehicle.visual.quaternion);
    updateHUD();
    updatePerformance(frameDt);
    lastReviewRender = now;
    if (!renderPipeline.shouldRender(now)) return;
    lighting.update(vehicle.visual, now);
    renderPipeline.render();
    return;
  }
  inputBlockedLastFrame = false;
  straightLineDiagnostic?.beforeInput();
  const frameInput = input.update(frameDt, vehicle.telemetry.speedKmh, { deferFixedPulses: true });
  if (input.consumePulse('KeyP')) {
    performanceVisible = !performanceVisible;
    $('perf').classList.toggle('hidden', !performanceVisible);
  }
  const physicsStart = performance.now();
  const physicsPlan = physicsScheduler.advance(frameDt);
  for (let physicsStep = 0; physicsStep < physicsPlan.steps; physicsStep += 1) {
    try {
      fixedUpdate(frameInput);
    } catch (error) {
      if (error.code !== 'V24_ACTIVE_STEP_ABORTED' || (state !== 'race' && state !== 'countdown')) throw error;
      console.error('[Street Rush] vehicle simulation paused', error);
      physicsFault = true;
      openRaceMenu();
      resetPhysicsScheduler();
      $('pause-menu-title').textContent = '车辆模拟已暂停';
      $('pause-menu-status').classList.remove('hidden');
      $('resume-button').disabled = true;
      focusVisibleElement($('race-restart-button'));
      return;
    }
  }
  physicsCost = THREE.MathUtils.damp(physicsCost, performance.now() - physicsStart, 5, frameDt);
  vehicle.syncVisual(physicsPlan.alpha);
  const menuMode = state === 'menu';
  chaseCamera.update(frameDt, vehicle.visual.position, vehicle.visual.quaternion, vehicle.telemetry, menuMode);
  if (!menuMode) effects.update(frameDt, vehicle.telemetry, vehicle.visual.quaternion);
  setAudioPaused(false);
  audio.update(vehicle.telemetry);
  if (!menuMode) updateHUD();
  updatePerformance(frameDt);
  if (renderReviewRequested && !renderReview?.measuring && now - lastReviewRender < 200) return;
  lastReviewRender = now;
  if (!renderPipeline.shouldRender(now)) return;
  lighting.update(vehicle.visual, now);
  renderPipeline.render();
}

$('prev-car').onclick = () => selectCar(-1);
$('next-car').onclick = () => selectCar(1);
$('start-button').onclick = startRace;
$('restart-button').onclick = startRace;
$('invalid-lap-restart-button').onclick = startRace;
$('garage-button').onclick = returnGarage;
$('race-menu-button').onclick = openRaceMenu;
$('resume-button').onclick = resumeRace;
$('race-restart-button').onclick = startRace;
$('race-garage-button').onclick = returnGarage;
$('power-diagnostics-button').onclick = withRaceFocus(() => setPowerDiagnosticsVisible(!powerDiagnosticsVisible));
$('fullscreen-button').onclick = withRaceFocus(togglePageFullscreen);
$('orientation-fullscreen').onclick = requestPageFullscreen;
$('retry-car-button').onclick = () => {
  const index = retryCarIndex ?? carIndex;
  carIndex = index;
  updateCarUI();
  mountVehicle(index);
};
$('fullscreen-help-close').onclick = () => {
  closeModalDialog('fullscreen-help');
  syncOrientationHint();
};
$('fullscreen-help').onclick = (event) => {
  if (event.target === $('fullscreen-help')) {
    closeModalDialog('fullscreen-help');
    syncOrientationHint();
  }
};
$('about-button').onclick = (event) => {
  if (state !== 'menu') return;
  openModalDialog('about', event.currentTarget);
};
$('about-close').onclick = () => closeModalDialog('about');
$('about').onclick = (event) => {
  if (event.target === $('about')) closeModalDialog('about');
};
$('sound-button').onclick = withRaceFocus(() => {
  initializeAudio().catch((error) => console.warn('Audio initialization failed', error));
  audio.setEnabled(!audio.enabled);
  $('sound-button').textContent = audio.enabled ? 'SOUND ON' : 'SOUND OFF';
  $('sound-button').setAttribute('aria-pressed', String(audio.enabled));
});
addEventListener('keydown', (event) => {
  if (trapModalFocus(event)) return;
  const target = event.target;
  const isInteractiveTarget = target instanceof HTMLElement
    && (target.matches('button, a, input, textarea, select, [contenteditable="true"]')
      || target.isContentEditable);
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  const isRestartShortcutTarget = target instanceof HTMLElement
    && Boolean(target.closest('#restart-button, #race-restart-button, #invalid-lap-restart-button'));
  if (event.code === 'Enter' && state === 'menu' && !isInteractiveTarget && !hasModifier) startRace();
  if (event.code === 'KeyR'
    && (!isInteractiveTarget || isRestartShortcutTarget)
    && (state === 'finish'
      || state === 'paused'
      || (state === 'race' && timing?.snapshot().currentLapValid === false))
    && !hasModifier) {
    event.preventDefault();
    startRace();
    return;
  }
  if (event.code === 'Escape') {
    const openDialog = getOpenModalDialog();
    if (openDialog) {
      if (openDialog.id === 'orientation-hint') {
        openRaceMenu();
      } else if (openDialog.id === 'pause-menu') {
        resumeRace();
      } else if (openDialog.id === 'finish') {
        returnGarage();
      } else {
        closeModalDialog(openDialog.id);
        if (openDialog.id === 'fullscreen-help') syncOrientationHint();
      }
    } else if (state === 'paused') {
      resumeRace();
    } else if (state === 'race' || state === 'countdown') {
      openRaceMenu();
    }
  }
});
window.addEventListener('blur', pauseOnLifecycleLoss);
window.addEventListener('pagehide', pauseOnLifecycleLoss);
document.addEventListener('visibilitychange', handleVisibilityChange);
function resizeRenderer() {
  renderScale = Math.min(renderScale, getRenderScaleLimit());
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(renderReviewRequested ? (renderReview?.scale ?? Number(new URLSearchParams(location.search).get('reviewscale') || 1)) : Math.min(devicePixelRatio, renderScale));
  syncOrientationHint();
}
addEventListener('resize', resizeRenderer);
window.visualViewport?.addEventListener('resize', resizeRenderer);
addEventListener('fullscreenchange', syncFullscreenButton);
addEventListener('webkitfullscreenchange', syncFullscreenButton);
addEventListener('orientationchange', syncOrientationHint);
matchMedia('(orientation: portrait)').addEventListener?.('change', syncOrientationHint);
syncFullscreenButton();
syncOrientationHint();

updateCarUI();
$('loading-status').textContent = '建立赛道与车辆物理…';
const sceneryPromise = assets.loadScenery().catch((error) => console.warn('Scenery failed to load', error));
await mountVehicle(carIndex, true);
await sceneryPromise;
if (import.meta.env.DEV && circuitReviewRequested && new URLSearchParams(location.search).has('straightart')) {
  $('loading-status').textContent = '铺设主直道与扫描素材…';
  const { installStraightArt } = await import('./dev-straight-art.js');
  await installStraightArt({ track, renderer });
}
lighting.prepareScenery(track.group);
lighting.prepareScenery(assets.cityGroup);
try {
  await lighting.setSkyRotation(-1.1, vehicle?.visual);
} catch (error) {
  console.warn('HDR sky unavailable; using procedural daylight.', error);
  await lighting.setPreset('clear', vehicle?.visual);
}
$('loading-status').textContent = '预编译光照与材质…';
await renderPipeline.warmup();
const sharedCore = await sharedCorePromise;
physicsScheduler = sharedCore.scheduler;
raceProgressCore = sharedCore.raceProgress;
document.documentElement.dataset.physicsSchedulerOwner = physicsScheduler.owner;
document.documentElement.dataset.raceProgressCoreOwner = raceProgressCore.owner;
if (physicsScheduler.fallbackReason) {
  document.documentElement.dataset.physicsSchedulerFallback = physicsScheduler.fallbackReason.code;
} else {
  delete document.documentElement.dataset.physicsSchedulerFallback;
}
recordDevEvent('physics-scheduler-ready', {
  owner: physicsScheduler.owner,
  fallbackReason: physicsScheduler.fallbackReason,
});
recordDevEvent('race-progress-core-ready', {
  owner: raceProgressCore.owner,
  available: raceProgressCore.available,
  fallbackReason: raceProgressCore.fallbackReason,
});
if (physicsScheduler.fallbackReason) {
  console.warn('[physics-scheduler] using JavaScript fallback', physicsScheduler.fallbackReason);
}
if (raceProgressCore.fallbackReason) {
  console.warn('[race-progress-core] Rust shadow capability unavailable', raceProgressCore.fallbackReason);
}
$('loading-progress').style.width = '100%';
setTimeout(() => $('loading').classList.add('hidden'), 320);
lastFrame = performance.now();
requestAnimationFrame(animate);

if (renderReviewRequested) {
  const { installRenderReview } = await import('./render-review.js');
  renderReview = await installRenderReview({
    renderer, camera, scene, renderPipeline, lighting, effects, cars: CARS,
    getVehicle: () => vehicle, getState: () => state, startRace,
    pausePreview: () => { openRaceMenu(); if (state === 'paused') closeModalDialog('pause-menu', false); },
    resumePreview: resumeRace,
    selectVehicle: async (index) => {
      returnGarage();
      await selectCar(index - carIndex);
    },
  });
}

if(import.meta.env.DEV && (new URLSearchParams(location.search).has('pitpreview') || new URLSearchParams(location.search).has('circuitreview'))) {
  const {installCircuitReview}=await import('./dev-circuit-review.js');
  installCircuitReview({scene,camera,renderer,renderPipeline,lighting,track,startRace,getVehicle:()=>vehicle,getState:()=>state});
}
