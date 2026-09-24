import * as THREE from 'three';

export function straightLineTrackConfig(base, { extended = false, accelerationSeconds = 35 } = {}) {
  const config = {
    ...base,
    name: '直线高速制动诊断',
    sceneryLayout: null,
    kerbSections: undefined,
    width: 80,
    runoff: 5,
    barrierOffset: 46,
    routeGuidance: { brakePoints: [], turns: [] },
    // The first 1,250 m is collinear and flat, inside TrackSystem's existing ground.
    // The remote return leg only satisfies its closed-curve interface.
    points: [
      [0, 0, -650], [0, 0, -250], [0, 0, 200], [0, 0, 600], [0, 0, 700],
      [400, 0, 700], [600, 0, 400], [600, 0, -400], [400, 0, -700], [0, 0, -750],
    ],
  };
  if (!extended) return config;
  return {
    ...config,
    name: '持续加速高速制动诊断',
    groundHalfExtent: 4000,
    straightLineDiagnostic: {
      accelerationSeconds: Math.min(60, Math.max(20, Number(accelerationSeconds) || 35)),
      straightLaneLimitM: 5500,
    },
    // First 5.8 km is collinear. The recorded maneuver ends before the return bend.
    points: [
      [0, 0, -2900], [0, 0, -1500], [0, 0, 0], [0, 0, 2200], [0, 0, 2900],
      [0, 0, 3200], [600, 0, 3400], [2000, 0, 3100], [2000, 0, -2800],
      [600, 0, -3400], [0, 0, -3200],
    ],
  };
}

const copyVector = (v) => ({ x: v.x, y: v.y, z: v.z });
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// No alternate physics loop: main calls beforeInput before InputController.update,
// and afterPhysics after its normal VehicleSystem/Rapier/afterPhysics sequence.
export function createStraightLineDiagnostic({ canvas, startRace, getVehicle, getState, getReadiness, track, fixedDt,
  requestedTargetSpeedKmh = 140, coastSeconds = 1 }) {
  if (!Number.isFinite(requestedTargetSpeedKmh) || requestedTargetSpeedKmh <= 0
    || !Number.isFinite(coastSeconds) || coastSeconds < 0) throw new Error('Invalid straight-line diagnostic protocol');
  const accelerationSeconds = track.config.straightLineDiagnostic?.accelerationSeconds ?? null;
  const straightLaneLimitM = track.config.straightLineDiagnostic?.straightLaneLimitM ?? 1120;
  let targetSpeedKmh = requestedTargetSpeedKmh;
  const held = new Set();
  let run = null;
  let phase = 'idle';
  let nextPhase = null;
  let phaseStart = 0;
  let elapsed = 0;
  let standstillTime = 0;
  let origin = null;
  let initialForward = null;
  let initialRight = null;
  let initialHeading = 0;
  let stopping = false;
  let automaticResetReason = null;

  const panel = document.createElement('section');
  panel.id = 'straight-line-diagnostic';
  panel.setAttribute('aria-label', '直线高速制动诊断');
  Object.assign(panel.style, {
    position: 'fixed', left: '18px', bottom: '18px', zIndex: '100', maxWidth: '540px',
    padding: '14px', background: '#10222eee', color: '#fff', font: '14px monospace',
  });
  const label = document.createElement('div');
  label.textContent = accelerationSeconds
    ? `实车直线：静止 → W 持续 ${accelerationSeconds} s（不提前收油）→ 松油 1 s → S 刹停`
    : `实车直线：静止 → W 加速到 ${targetSpeedKmh} km/h → 松油 ${coastSeconds} s → S 刹停`;
  const status = document.createElement('output');
  status.id = 'straight-line-status';
  status.style.display = 'block';
  const button = document.createElement('button');
  button.textContent = '开始直线高速刹车测试';
  const stopButton = document.createElement('button');
  stopButton.textContent = '停止并保存数据';
  stopButton.disabled = true;
  panel.append(label, status, button, stopButton);
  document.body.append(panel);

  function setKey(code, down) {
    if (held.has(code) === down) return;
    if (down) held.add(code); else held.delete(code);
    const type = down ? 'keydown' : 'keyup';
    canvas.dispatchEvent(new KeyboardEvent(type, {
      code, key: code === 'KeyW' ? 'w' : 's', bubbles: true, cancelable: true,
    }));
    run?.events.push({ time: elapsed, phase, type, code, isTrusted: false });
  }

  function releaseKeys() {
    setKey('KeyW', false);
    setKey('KeyS', false);
  }

  function publish(extra = {}) {
    const last = run?.samples.at(-1);
    const value = {
      runId: run?.runId ?? null, phase, targetSpeedKmh, accelerationSeconds,
      time: elapsed, sampleCount: run?.samples.length ?? 0,
      speedKmh: last?.body.speedKmh ?? 0,
      headingChangeDeg: last?.body.headingChangeDeg ?? 0,
      lateralDisplacementM: last?.body.lateralDisplacementM ?? 0,
      ...extra,
    };
    status.textContent = JSON.stringify(value);
  }

  async function finish(reason) {
    if (!run || stopping) return;
    stopping = true;
    releaseKeys();
    run.endReason = reason;
    run.readinessAtEnd = getReadiness();
    run.summary = {
      targetReached: run.samples.some((s) => s.phase === 'accelerate' && s.body.signedSpeedKmh >= targetSpeedKmh),
      accelerationSeconds: run.samples.filter((s) => s.phase === 'accelerate').length * fixedDt,
      samples: run.samples.length,
      durationSeconds: elapsed,
      maximumSpeedKmh: Math.max(0, ...run.samples.map((s) => s.body.speedKmh)),
      maximumAbsYawRate: Math.max(0, ...run.samples.map((s) => Math.abs(s.body.angularVelocity.y))),
      maximumAbsLateralDisplacementM: Math.max(0, ...run.samples.map((s) => Math.abs(s.body.lateralDisplacementM))),
      finalSpeedKmh: run.samples.at(-1)?.body.speedKmh ?? null,
    };
    phase = 'saving';
    publish({ endReason: reason });
    try {
      const response = await fetch('/__streetrush/straight-line-recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(run),
      });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      const saved = await response.json();
      phase = 'saved';
      publish({ endReason: reason, ...saved, summary: run.summary });
    } catch (error) {
      phase = 'save-failed';
      publish({ error: error.message, endReason: reason });
    }
    stopButton.disabled = true;
  }

  button.addEventListener('click', () => {
    if (run) return;
    if (!getReadiness().startable) {
      publish({ error: '请先返回主菜单，等待车辆 READY。' });
      return;
    }
    startRace(); // Explicit normal start/reset, once, before the recorded maneuver.
    if (getState() !== 'countdown') return;
    const vehicle = getVehicle();
    // A coverage floor, not a physical speed cap. The timed protocol always keeps
    // W held for its full duration, even after this speed has been reached.
    targetSpeedKmh = accelerationSeconds ? Math.min(250, vehicle.config.speed * 0.9) : requestedTargetSpeedKmh;
    run = {
      schema: 'streetrush.straight-line-recording.v1', runId: crypto.randomUUID(),
      createdAt: new Date().toISOString(), targetSpeedKmh, fixedDt,
      protocol: {
        name: accelerationSeconds ? 'continuous-throttle-high-speed-v1' : `speed-target-${targetSpeedKmh}-v1`,
        accelerationSeconds, straightLaneLimitM, targetSpeedKmh, coastSeconds,
        speedFloorPolicy: accelerationSeconds
          ? 'Diagnostic coverage only: min(250 km/h, 90% of garage display). Not a physical limiter or a target-data certification.'
          : `${targetSpeedKmh} km/h diagnostic coverage only`,
      },
      chain: 'KeyboardEvent → InputController.update → main scheduler → VehicleSystem.fixedUpdate → v24-active → Rapier.step → afterPhysics',
      eventTrust: 'Automated DOM keyboard events, isTrusted=false; not hardware certification',
      samplePolicy: 'Every physical step, no decimation or ring-buffer truncation',
      coordinatePolicy: 'Driver-right is forward × world-up; raw legacy wheel labels are not used as driver-left/right',
      configuration: JSON.parse(JSON.stringify(vehicle.config)),
      readinessAtStart: getReadiness(),
      track: { className: track.constructor.name, config: track.config, length: track.length },
      events: [], samples: [],
    };
    phase = 'settle';
    button.disabled = true;
    stopButton.disabled = false;
    canvas.focus();
    publish();
  });
  stopButton.addEventListener('click', () => finish('USER_STOP'));
  addEventListener('keydown', (event) => {
    if (run && !stopping && event.isTrusted) finish(`USER_KEY_${event.code}`);
  });
  addEventListener('error', (event) => {
    if (run && !stopping) finish(`RUNTIME_ERROR: ${event.message}`);
  });
  publish();

  return {
    automaticReset(reason) {
      if (!run || stopping) return;
      automaticResetReason = reason;
      run.events.push({ time: elapsed, phase, type: 'automatic-reset', reason });
    },
    beforeInput() {
      if (!run || stopping) return;
      const state = getState();
      if (state === 'paused' || state === 'menu' || state === 'finish') {
        finish(`STATE_${state}`);
        return;
      }
      if (nextPhase && state === 'race') {
        phase = nextPhase;
        nextPhase = null;
        phaseStart = elapsed;
        run.events.push({ time: elapsed, phase, type: 'phase' });
      }
      setKey('KeyW', state === 'race' && phase === 'accelerate');
      setKey('KeyS', state === 'race' && phase === 'brake');
    },
    afterPhysics(frameInput, fixedStepIndex) {
      if (!run || stopping) return;
      const vehicle = getVehicle();
      const report = vehicle.getVehiclePhysicsReport();
      const body = vehicle.body;
      const p = body.translation();
      const q = body.rotation();
      const velocity = body.linvel();
      const omega = body.angvel();
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      const heading = Math.atan2(forward.x, forward.z);
      if (!origin) {
        origin = new THREE.Vector3(p.x, p.y, p.z);
        initialForward = forward.clone().setY(0).normalize();
        initialRight = new THREE.Vector3().crossVectors(initialForward, new THREE.Vector3(0, 1, 0)).normalize();
        initialHeading = heading;
      }
      const displacement = new THREE.Vector3(p.x, p.y, p.z).sub(origin);
      const speedKmh = Math.hypot(velocity.x, velocity.z) * 3.6;
      const signedSpeedKmh = forward.dot(new THREE.Vector3(velocity.x, velocity.y, velocity.z)) * 3.6;
      const sample = {
        fixedStepIndex, time: elapsed, dt: fixedDt,
        phase: getState() === 'race' ? phase : getState(),
        input: { ...frameInput },
        body: {
          position: copyVector(p), rotation: { ...copyVector(q), w: q.w },
          velocity: copyVector(velocity), angularVelocity: copyVector(omega),
          speedKmh, signedSpeedKmh, headingRad: heading,
          headingChangeDeg: wrapAngle(heading - initialHeading) * 180 / Math.PI,
          lateralDisplacementM: displacement.dot(initialRight),
          forwardDisplacementM: displacement.dot(initialForward),
        },
        reportStatus: report?.status ?? (automaticResetReason ? 'CLEARED_BY_AUTO_RESET' : 'NO_REPORT'),
        authority: report?.authority ?? null,
        // The output includes wheel loads, omega, surface, contact normals and power.
        vehicle: report?.output ?? null,
        wheelBrakes: report?.solver?.brakeDiagnostics ?? null,
        tireImpulses: report?.solver?.tireDiagnostics ?? null,
        geometry: report?.solver?.geometryDiagnostics ?? null,
        assists: report?.solver?.assistDiagnostics ?? null,
        wheelWrenches: report?.actionReaction ?? null,
        solver: { scaledResidual: report?.solver?.scaledResidual, activeSet: report?.solver?.activeSet },
      };
      // Output objects are per-step values; copy once so later updates cannot mutate history.
      run.samples.push(JSON.parse(JSON.stringify(sample)));
      elapsed += fixedDt;
      if (run.samples.length % 30 === 0) publish();
      if (getState() !== 'race') {
        phaseStart = elapsed;
        return;
      }
      if (automaticResetReason) {
        finish(`AUTOMATIC_RESET: ${automaticResetReason}`);
      } else if (Math.abs(frameInput.steer) > 0.001 || frameInput.rawHandbrake > 0) {
        finish('NONZERO_STEERING_OR_HANDBRAKE');
      } else if (report?.status !== 'COMMITTED') {
        finish(`SOLVER_${report?.status ?? 'NO_REPORT'}`);
      } else if (elapsed > 100 || displacement.dot(initialForward) > straightLaneLimitM
        || Math.abs(displacement.dot(initialRight)) > 37 || p.y < -0.5) {
        finish('TIME_OR_STRAIGHT_LANE_LIMIT');
      } else if (phase === 'settle' && elapsed - phaseStart >= 1) {
        nextPhase = 'accelerate';
      } else if (phase === 'accelerate' && (accelerationSeconds
        ? elapsed - phaseStart >= accelerationSeconds : signedSpeedKmh >= targetSpeedKmh)) {
        nextPhase = coastSeconds === 0 ? 'brake' : 'coast';
      } else if (phase === 'accelerate' && !accelerationSeconds && elapsed - phaseStart >= 50) {
        finish('TARGET_SPEED_NOT_REACHED');
      } else if (phase === 'coast' && elapsed - phaseStart >= coastSeconds) {
        nextPhase = 'brake';
      } else if (phase === 'brake') {
        standstillTime = speedKmh < 0.5 ? standstillTime + fixedDt : 0;
        if (standstillTime >= 0.1) nextPhase = 'stopped';
        else if (elapsed - phaseStart >= 30) finish('BRAKING_DID_NOT_STOP');
      } else if (phase === 'stopped' && elapsed - phaseStart >= 0.75) {
        finish('STOPPED');
      }
    },
  };
}
