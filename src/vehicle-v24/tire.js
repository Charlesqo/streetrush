import {
  EPSILON,
  clamp,
  norm2,
  solveSymmetric2x2,
} from './math.js';
import { VehicleV24DomainError } from './contract.js';

export const TIRE_REGIME = Object.freeze({
  AIRBORNE: 'AIRBORNE',
  FRICTION_CONTACT: 'FRICTION_CONTACT',
  HANDLING: 'HANDLING',
});

export const FRICTION_ACTIVE_SET = Object.freeze({
  STICK: 'STICK',
  SLIDE: 'SLIDE',
});

const DEG = Math.PI / 180;
const LOAD_NODES = Object.freeze([2000, 4000, 6000, 8000]);
const ZERO_AT_ZERO = new Set([
  'kx0', 'ky0', 'fxPeak', 'fyPeak', 'fxSlide', 'fySlide', 'kGamma', 'mxGamma',
]);
const LOAD_FIELDS = Object.freeze({
  kx0: [65000, 105000, 135000, 155000],
  ky0: [55000, 90000, 112000, 125000],
  fxPeak: [2400, 4600, 6500, 8200],
  fyPeak: [2500, 4700, 6500, 8100],
  sxPeak: [0.095, 0.105, 0.115, 0.125],
  syPeak: [5.5, 6.2, 6.8, 7.4].map((value) => Math.tan(value * DEG)),
  fxSlide: [2050, 3900, 5450, 6800],
  fySlide: [2200, 4100, 5550, 6900],
  sxSlide: [0.42, 0.45, 0.48, 0.52],
  sySlide: [17, 18, 19, 20].map((value) => Math.tan(value * DEG)),
  kGamma: [9000, 17000, 23500, 28500],
  mxGamma: [45, 85, 120, 150],
  trail0: [0.047, 0.043, 0.039, 0.036],
  trailZeroSy: [7.5, 8, 8.5, 9].map((value) => Math.tan(value * DEG)),
  trailEndSy: [15, 16, 17, 18].map((value) => Math.tan(value * DEG)),
  sigmaX: [0.24, 0.29, 0.34, 0.39],
  sigmaY: [0.32, 0.40, 0.49, 0.58],
});

function pchipEndpoint(h0, h1, delta0, delta1) {
  let slope = ((2 * h0 + h1) * delta0 - h0 * delta1) / (h0 + h1);
  if (Math.sign(slope) !== Math.sign(delta0)) slope = 0;
  else if (Math.sign(delta0) !== Math.sign(delta1) && Math.abs(slope) > Math.abs(3 * delta0)) {
    slope = 3 * delta0;
  }
  return slope;
}

function pchipSlopes(x, y) {
  const count = x.length;
  if (count === 2) {
    const slope = (y[1] - y[0]) / (x[1] - x[0]);
    return [slope, slope];
  }
  const h = Array.from({ length: count - 1 }, (_, index) => x[index + 1] - x[index]);
  const delta = h.map((span, index) => (y[index + 1] - y[index]) / span);
  const slopes = new Array(count).fill(0);
  slopes[0] = pchipEndpoint(h[0], h[1], delta[0], delta[1]);
  slopes[count - 1] = pchipEndpoint(
    h[count - 2], h[count - 3], delta[count - 2], delta[count - 3],
  );
  for (let index = 1; index < count - 1; index += 1) {
    if (delta[index - 1] === 0 || delta[index] === 0
      || Math.sign(delta[index - 1]) !== Math.sign(delta[index])) {
      slopes[index] = 0;
      continue;
    }
    const weight1 = 2 * h[index] + h[index - 1];
    const weight2 = h[index] + 2 * h[index - 1];
    slopes[index] = (weight1 + weight2)
      / (weight1 / delta[index - 1] + weight2 / delta[index]);
  }
  return slopes;
}

function pchipEvaluate(x, y, value) {
  if (value <= x[0]) return y[0];
  if (value >= x[x.length - 1]) return y[y.length - 1];
  let index = 0;
  while (index + 1 < x.length && value > x[index + 1]) index += 1;
  const slopes = pchipSlopes(x, y);
  const span = x[index + 1] - x[index];
  const t = (value - x[index]) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * y[index] + h10 * span * slopes[index]
    + h01 * y[index + 1] + h11 * span * slopes[index + 1];
}

export function acceptedCharacteristicAtLoad(normalLoad) {
  const load = clamp(normalLoad, 0, LOAD_NODES[LOAD_NODES.length - 1]);
  const result = {};
  for (const [name, values] of Object.entries(LOAD_FIELDS)) {
    if (ZERO_AT_ZERO.has(name)) {
      result[name] = pchipEvaluate([0, ...LOAD_NODES], [0, ...values], load);
    } else {
      result[name] = pchipEvaluate(LOAD_NODES, values, Math.max(LOAD_NODES[0], load));
    }
  }
  result.loadWasClamped = normalLoad > LOAD_NODES[LOAD_NODES.length - 1];
  return result;
}

export function createTireState() {
  return { sx: 0, sy: 0, sGamma: 0, mode: TIRE_REGIME.AIRBORNE };
}

export function effectiveTireRadius({
  unloadedRadius,
  normalLoad = 0,
  loadedRadius = null,
  omega = 0,
  radiusGrowthQ = 0,
}) {
  const compression = loadedRadius === null
    ? Math.max(0, normalLoad / 220000)
    : Math.max(0, unloadedRadius - loadedRadius);
  const speedRatio = omega * unloadedRadius / 30;
  const freeRadius = unloadedRadius * (1 + radiusGrowthQ * speedRatio * speedRatio);
  return Math.max(0.2 * unloadedRadius, freeRadius - compression / 3);
}

export function selectTireRegime(previousMode, inContact, longitudinalSpeed, transportSpeed) {
  if (!inContact) return TIRE_REGIME.AIRBORNE;
  const road = Math.abs(longitudinalSpeed);
  const tread = Math.abs(transportSpeed);
  if (previousMode === TIRE_REGIME.HANDLING) {
    return road < 1.2 || tread < 1.2 ? TIRE_REGIME.FRICTION_CONTACT : TIRE_REGIME.HANDLING;
  }
  return road > 2 && tread > 2 ? TIRE_REGIME.HANDLING : TIRE_REGIME.FRICTION_CONTACT;
}

function smoothstep01(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function scalarCharacteristic(slip, initialSlope, peakSlip, peakForce, slideSlip, slideForce) {
  if (slip <= 0 || initialSlope <= 0 || peakSlip <= 0 || peakForce <= 0) return 0;
  const slope = Math.max(2 * peakForce / peakSlip, initialSlope);
  if (slip >= slideSlip) return slideForce;
  if (slip < peakSlip) {
    const p = slope * peakSlip / peakForce - 2;
    const normalized = slip / peakSlip;
    return slope * peakSlip * normalized / Math.max(1 + (normalized + p) * normalized, EPSILON);
  }
  const a = (peakForce / peakSlip) ** 2 / (slope * peakSlip);
  const starredSlip = peakSlip + (peakForce - slideForce) / (a * (slideSlip - peakSlip));
  if (starredSlip <= slideSlip) {
    if (slip <= starredSlip) return peakForce - a * (slip - peakSlip) ** 2;
    const b = a * (starredSlip - peakSlip) / (slideSlip - starredSlip);
    return slideForce + b * (slideSlip - slip) ** 2;
  }
  const normalized = (slip - peakSlip) / (slideSlip - peakSlip);
  return peakForce - (peakForce - slideForce) * normalized * normalized * (3 - 2 * normalized);
}

function ellipseRadius(xCapacity, yCapacity, direction) {
  const denominator = (direction[0] / Math.max(xCapacity, EPSILON)) ** 2
    + (direction[1] / Math.max(yCapacity, EPSILON)) ** 2;
  return denominator <= 0 ? 0 : 1 / Math.sqrt(denominator);
}

function combinedForce(characteristic, sx, sy, muScale) {
  const radius = Math.hypot(sx, sy);
  if (radius <= 1e-15 || muScale <= 0) return [0, 0];
  const slipDirection = [sx / radius, sy / radius];
  const linear = [characteristic.kx0 * sx, characteristic.ky0 * sy];
  const linearMagnitude = norm2(linear);
  if (linearMagnitude <= 1e-15) return [0, 0];
  const linearDirection = [linear[0] / linearMagnitude, linear[1] / linearMagnitude];
  const directionalSlope = linearMagnitude / radius;
  const peakSlip = Math.max(
    muScale * ellipseRadius(characteristic.sxPeak, characteristic.syPeak, slipDirection),
    1e-8,
  );
  const slideSlip = Math.max(
    muScale * ellipseRadius(characteristic.sxSlide, characteristic.sySlide, slipDirection),
    peakSlip + 1e-8,
  );
  const slideRaw = [
    characteristic.fxSlide ** 2 * sx,
    characteristic.fySlide ** 2 * sy,
  ];
  const slideMagnitude = norm2(slideRaw);
  const slideDirection = slideMagnitude <= 1e-15
    ? linearDirection
    : [slideRaw[0] / slideMagnitude, slideRaw[1] / slideMagnitude];
  const weight = smoothstep01(radius / peakSlip);
  const directionRaw = [
    (1 - weight) * linearDirection[0] + weight * slideDirection[0],
    (1 - weight) * linearDirection[1] + weight * slideDirection[1],
  ];
  const directionMagnitude = norm2(directionRaw);
  const forceDirection = directionMagnitude <= 1e-15
    ? linearDirection
    : [directionRaw[0] / directionMagnitude, directionRaw[1] / directionMagnitude];
  const peakForce = muScale * ellipseRadius(
    characteristic.fxPeak, characteristic.fyPeak, forceDirection,
  );
  const slideForce = muScale * ellipseRadius(
    characteristic.fxSlide, characteristic.fySlide, forceDirection,
  );
  const magnitude = scalarCharacteristic(
    radius, directionalSlope, peakSlip, peakForce, slideSlip, slideForce,
  );
  return [magnitude * forceDirection[0], magnitude * forceDirection[1]];
}

function pneumaticTrail(characteristic, sy) {
  const magnitude = Math.abs(sy);
  const zero = Math.max(characteristic.trailZeroSy, 1e-9);
  const end = Math.max(characteristic.trailEndSy, zero + 1e-9);
  if (magnitude >= end) return 0;
  if (magnitude <= zero) return characteristic.trail0 * (1 - smoothstep01(magnitude / zero));
  const x = (magnitude - zero) / (end - zero);
  return -0.15 * characteristic.trail0 * 16 * x * x * (1 - x) * (1 - x);
}

function rollingResistanceTorque(normalLoad, radius, omega, coefficient = 0.012) {
  if (normalLoad <= 0 || radius <= 0) return 0;
  const magnitude = coefficient * normalLoad * radius;
  const omegaScale = 0.25 / Math.max(radius, EPSILON);
  return -magnitude * Math.tanh(omega / Math.max(omegaScale, 1e-9));
}

export function evaluateAcceptedTireState({
  state,
  normalLoad,
  camber,
  muScale,
  omega,
  unloadedRadius,
  loadedRadius = null,
}) {
  const characteristic = acceptedCharacteristicAtLoad(normalLoad);
  const radius = effectiveTireRadius({ unloadedRadius, normalLoad, loadedRadius, omega });
  const force = combinedForce(characteristic, state.sx, state.sy + state.sGamma, muScale);
  const trail = pneumaticTrail(characteristic, state.sy + state.sGamma);
  const rollingTorque = rollingResistanceTorque(normalLoad, radius, omega);
  return {
    forceX: force[0],
    forceY: force[1],
    forceZ: Math.max(0, normalLoad),
    momentX: -characteristic.mxGamma * camber,
    momentY: rollingTorque,
    momentZ: -force[1] * trail,
    effectiveRadius: radius,
    wheelContactTorque: -radius * force[0] + rollingTorque,
    pneumaticTrail: trail,
    loadWasClamped: characteristic.loadWasClamped,
    peakAxes: [Math.max(muScale * characteristic.fxPeak, EPSILON), Math.max(muScale * characteristic.fyPeak, EPSILON)],
    slideAxes: [Math.max(muScale * characteristic.fxSlide, EPSILON), Math.max(muScale * characteristic.fySlide, EPSILON)],
  };
}

export function evaluateAcceptedHandlingTrial({
  previousState,
  normalLoad,
  velocityX,
  velocityY,
  omega,
  camber = 0,
  muScale = 1,
  dt,
  unloadedRadius,
  loadedRadius = null,
}) {
  const radius = effectiveTireRadius({ unloadedRadius, normalLoad, loadedRadius, omega });
  const transport = Math.abs(omega * radius);
  if (transport <= 0) throw new VehicleV24DomainError('HANDLING requires non-zero tread transport');
  const characteristic = acceptedCharacteristicAtLoad(normalLoad);
  const targetX = (omega * radius - velocityX) / transport;
  const targetY = -velocityY / transport;
  const decayX = Math.exp(-transport * dt / Math.max(characteristic.sigmaX, 1e-9));
  const decayY = Math.exp(-transport * dt / Math.max(characteristic.sigmaY, 1e-9));
  const nextState = {
    sx: decayX * previousState.sx + (1 - decayX) * targetX,
    sy: decayY * previousState.sy + (1 - decayY) * targetY,
    sGamma: characteristic.kGamma / Math.max(characteristic.ky0, EPSILON) * camber,
    mode: TIRE_REGIME.HANDLING,
  };
  const output = evaluateAcceptedTireState({
    state: nextState,
    normalLoad,
    camber,
    muScale,
    omega,
    unloadedRadius,
    loadedRadius,
  });
  const rawSlipX = omega * output.effectiveRadius - velocityX;
  const rawSlipY = -velocityY;
  const contactPower = -output.forceX * rawSlipX - output.forceY * rawSlipY
    + output.momentY * omega;
  return {
    ...output,
    nextState,
    regime: TIRE_REGIME.HANDLING,
    rawSlipX,
    rawSlipY,
    transportSpeed: transport,
    observableKappa: targetX,
    observableAlpha: Math.atan(targetY),
    contactPower,
    grossContactLoss: Math.max(0, -contactPower),
    forceUtilization: Math.hypot(
      output.forceX / output.peakAxes[0],
      output.forceY / output.peakAxes[1],
    ),
  };
}

function maxDissipationForce(characteristic, velocity, muScale, sliding) {
  const axes = sliding
    ? [muScale * characteristic.fxSlide, muScale * characteristic.fySlide]
    : [muScale * characteristic.fxPeak, muScale * characteristic.fyPeak];
  const denominator = Math.hypot(axes[0] * velocity[0], axes[1] * velocity[1]);
  if (denominator <= 1e-15) return [0, 0];
  return [
    axes[0] ** 2 * velocity[0] / denominator,
    axes[1] ** 2 * velocity[1] / denominator,
  ];
}

function solveSlidingEllipseImpulse(characteristic, uFree, delassus, muScale, dt) {
  const axes = [
    Math.max(muScale * characteristic.fxSlide, EPSILON),
    Math.max(muScale * characteristic.fySlide, EPSILON),
  ];
  let evaluations = 0;
  const normalizeAngle = (angle) => {
    let normalized = angle;
    while (normalized < -Math.PI) normalized += 2 * Math.PI;
    while (normalized >= Math.PI) normalized -= 2 * Math.PI;
    return normalized;
  };
  const evaluate = (angle) => {
    evaluations += 1;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const force = [axes[0] * cosine, axes[1] * sine];
    const impulse = [dt * force[0], dt * force[1]];
    const post = [
      uFree[0] - delassus[0][0] * impulse[0] - delassus[0][1] * impulse[1],
      uFree[1] - delassus[1][0] * impulse[0] - delassus[1][1] * impulse[1],
    ];
    const scaledPost = [axes[0] * post[0], axes[1] * post[1]];
    const cross = sine * scaledPost[0] - cosine * scaledPost[1];
    const alignment = cosine * scaledPost[0] + sine * scaledPost[1];
    const maximumDissipation = maxDissipationForce(characteristic, post, muScale, true);
    const residual = [
      impulse[0] - dt * maximumDissipation[0],
      impulse[1] - dt * maximumDissipation[1],
    ];
    return {
      angle,
      impulse,
      residual,
      cross,
      alignment,
      scaledResidual: norm2(residual) / Math.max(1, norm2(impulse)),
    };
  };
  const isPhysicalRoot = (candidate) => (
    candidate.alignment > 0 && Number.isFinite(candidate.scaledResidual)
  );

  const initialAngle = Math.atan2(axes[1] * uFree[1], axes[0] * uFree[0]);
  let current = evaluate(initialAngle);
  for (let iteration = 1; iteration <= 10; iteration += 1) {
    if (isPhysicalRoot(current) && current.scaledResidual <= 1e-8) {
      return {
        value: current.impulse,
        residual: current.residual,
        scaledResidual: current.scaledResidual,
        method: 'ELLIPSE_ANGLE',
        iterations: iteration,
        evaluations,
      };
    }
    const derivativeStep = 1e-6;
    const plus = evaluate(normalizeAngle(current.angle + derivativeStep));
    const minus = evaluate(normalizeAngle(current.angle - derivativeStep));
    const derivative = (plus.cross - minus.cross) / (2 * derivativeStep);
    if (!Number.isFinite(derivative) || Math.abs(derivative) <= 1e-12) break;
    const rawStep = clamp(-current.cross / derivative, -Math.PI / 2, Math.PI / 2);
    let accepted = false;
    for (let line = 0, fraction = 1; line < 10; line += 1, fraction *= 0.5) {
      const candidate = evaluate(normalizeAngle(current.angle + fraction * rawStep));
      if (Math.abs(candidate.cross) < Math.abs(current.cross)) {
        current = candidate;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  if (isPhysicalRoot(current) && current.scaledResidual <= 2e-8) {
    return {
      value: current.impulse,
      residual: current.residual,
      scaledResidual: current.scaledResidual,
      method: 'ELLIPSE_ANGLE',
      iterations: 10,
      evaluations,
    };
  }

  const segmentCount = 24;
  const samples = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    samples.push(evaluate(-Math.PI + 2 * Math.PI * index / segmentCount));
  }
  const brackets = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const left = samples[index];
    const right = samples[index + 1];
    if (left.cross === 0 || left.cross * right.cross < 0) {
      const midpoint = normalizeAngle((left.angle + right.angle) * 0.5);
      const distance = Math.abs(normalizeAngle(midpoint - initialAngle));
      brackets.push({ left, right, distance });
    }
  }
  brackets.sort((a, b) => a.distance - b.distance);
  let best = null;
  for (const bracket of brackets) {
    let left = bracket.left;
    let right = bracket.right;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const middle = evaluate((left.angle + right.angle) * 0.5);
      if (left.cross === 0) {
        right = left;
        break;
      }
      if (left.cross * middle.cross <= 0) right = middle;
      else left = middle;
    }
    const candidate = evaluate((left.angle + right.angle) * 0.5);
    if (!isPhysicalRoot(candidate)) continue;
    if (!best || candidate.scaledResidual < best.scaledResidual) best = candidate;
    if (candidate.scaledResidual <= 1e-10) break;
  }
  if (!best) return null;
  return {
    value: best.impulse,
    residual: best.residual,
    scaledResidual: best.scaledResidual,
    method: 'ELLIPSE_ANGLE',
    iterations: 40,
    evaluations,
  };
}

function nonlinearSolve2(residualAt, initial, tolerance = 2e-8) {
  let evaluations = 0;
  const evaluate = (value) => {
    evaluations += 1;
    return residualAt(value);
  };
  let value = [...initial];
  let residual = evaluate(value);
  let best = { value: [...value], residual: [...residual], norm: norm2(residual) };
  const scaled = () => best.norm / Math.max(1, norm2(best.value));
  for (let iteration = 1; iteration <= 12 && evaluations < 120; iteration += 1) {
    const currentNorm = norm2(residual);
    if (currentNorm / Math.max(1, norm2(value)) <= tolerance) {
      return { value, residual, scaledResidual: currentNorm / Math.max(1, norm2(value)), method: 'ROOT_NEWTON', iterations: iteration, evaluations };
    }
    const columns = [];
    for (let axis = 0; axis < 2; axis += 1) {
      const h = 1e-6 * Math.max(1, Math.abs(value[axis]));
      const sample = [...value];
      sample[axis] += h;
      const shifted = evaluate(sample);
      columns.push([(shifted[0] - residual[0]) / h, (shifted[1] - residual[1]) / h]);
    }
    const jacobian = [[columns[0][0], columns[1][0]], [columns[0][1], columns[1][1]]];
    let step;
    try {
      step = solveSymmetric2x2(jacobian, [-residual[0], -residual[1]]);
    } catch {
      step = [-residual[0], -residual[1]];
    }
    let accepted = false;
    for (let line = 0, alpha = 1; line < 12 && evaluations < 120; line += 1, alpha *= 0.5) {
      const candidate = [value[0] + alpha * step[0], value[1] + alpha * step[1]];
      const candidateResidual = evaluate(candidate);
      const candidateNorm = norm2(candidateResidual);
      if (candidateNorm < currentNorm) {
        value = candidate;
        residual = candidateResidual;
        accepted = true;
        if (candidateNorm < best.norm) best = { value: [...value], residual: [...residual], norm: candidateNorm };
        break;
      }
    }
    if (!accepted) break;
  }

  value = [...best.value];
  residual = [...best.residual];
  let damping = 1e-3;
  for (let iteration = 1; iteration <= 36 && evaluations < 120; iteration += 1) {
    const currentNorm = norm2(residual);
    if (currentNorm / Math.max(1, norm2(value)) <= tolerance) {
      return { value, residual, scaledResidual: currentNorm / Math.max(1, norm2(value)), method: 'BOUNDED_LS', iterations: iteration, evaluations };
    }
    const columns = [];
    for (let axis = 0; axis < 2; axis += 1) {
      const h = 1e-6 * Math.max(1, Math.abs(value[axis]));
      const sample = [...value];
      sample[axis] += h;
      const shifted = evaluate(sample);
      columns.push([(shifted[0] - residual[0]) / h, (shifted[1] - residual[1]) / h]);
    }
    const a = columns[0][0] ** 2 + columns[0][1] ** 2 + damping;
    const b = columns[0][0] * columns[1][0] + columns[0][1] * columns[1][1];
    const d = columns[1][0] ** 2 + columns[1][1] ** 2 + damping;
    const gradient = [
      columns[0][0] * residual[0] + columns[0][1] * residual[1],
      columns[1][0] * residual[0] + columns[1][1] * residual[1],
    ];
    const step = solveSymmetric2x2([[a, b], [b, d]], [-gradient[0], -gradient[1]]);
    const candidate = [value[0] + step[0], value[1] + step[1]];
    const candidateResidual = evaluate(candidate);
    if (norm2(candidateResidual) < currentNorm) {
      value = candidate;
      residual = candidateResidual;
      damping = Math.max(1e-9, damping * 0.35);
      if (norm2(residual) < best.norm) best = { value: [...value], residual: [...residual], norm: norm2(residual) };
    } else {
      damping = Math.min(1e9, damping * 8);
    }
  }
  return {
    value: best.value,
    residual: best.residual,
    scaledResidual: scaled(),
    method: 'BOUNDED_LS',
    iterations: 36,
    evaluations,
  };
}

export function solveAcceptedTireContact({
  previousState,
  inContact,
  normalLoad,
  velocityX,
  velocityY,
  omega,
  camber = 0,
  muScale = 1,
  dt,
  unloadedRadius,
  loadedRadius = null,
  delassus,
}) {
  const radius = effectiveTireRadius({ unloadedRadius, normalLoad, loadedRadius, omega });
  if (!inContact || normalLoad <= 0) {
    const nextState = createTireState();
    return {
      forceX: 0, forceY: 0, forceZ: 0,
      momentX: 0, momentY: 0, momentZ: 0,
      effectiveRadius: radius,
      wheelContactTorque: 0,
      rawSlipX: 0,
      rawSlipY: 0,
      observableKappa: 0,
      observableAlpha: 0,
      contactPower: 0,
      grossContactLoss: 0,
      forceUtilization: 0,
      nextState,
      regime: TIRE_REGIME.AIRBORNE,
      activeSet: 'AIRBORNE',
      impulse: [0, 0],
      scaledResidual: 0,
      solver: { method: 'ANALYTIC', iterations: 0, evaluations: 0 },
    };
  }
  if (!Array.isArray(delassus) || delassus.length !== 2
    || delassus.some((row) => !Array.isArray(row) || row.length !== 2)) {
    throw new VehicleV24DomainError('low-speed/handling Tire solve requires a 2x2 host Delassus operator');
  }
  const transport = Math.abs(omega * radius);
  const regime = selectTireRegime(previousState.mode, true, velocityX, transport);
  const characteristic = acceptedCharacteristicAtLoad(normalLoad);
  const uFree = [omega * radius - velocityX, -velocityY];

  if (regime === TIRE_REGIME.FRICTION_CONTACT) {
    const stickImpulse = solveSymmetric2x2(delassus, uFree);
    const stickForce = [stickImpulse[0] / dt, stickImpulse[1] / dt];
    const peakQ = (stickForce[0] / Math.max(muScale * characteristic.fxPeak, EPSILON)) ** 2
      + (stickForce[1] / Math.max(muScale * characteristic.fyPeak, EPSILON)) ** 2;
    let impulse;
    let solve;
    let activeSet;
    if (peakQ <= 1 + 1e-10) {
      impulse = stickImpulse;
      const post = [
        uFree[0] - delassus[0][0] * impulse[0] - delassus[0][1] * impulse[1],
        uFree[1] - delassus[1][0] * impulse[0] - delassus[1][1] * impulse[1],
      ];
      solve = {
        value: impulse,
        residual: post,
        scaledResidual: norm2(post),
        method: 'ANALYTIC',
        iterations: 1,
        evaluations: 1,
      };
      activeSet = FRICTION_ACTIVE_SET.STICK;
    } else {
      const initialForce = maxDissipationForce(characteristic, uFree, muScale, true);
      solve = solveSlidingEllipseImpulse(characteristic, uFree, delassus, muScale, dt)
        ?? nonlinearSolve2((candidate) => {
        const post = [
          uFree[0] - delassus[0][0] * candidate[0] - delassus[0][1] * candidate[1],
          uFree[1] - delassus[1][0] * candidate[0] - delassus[1][1] * candidate[1],
        ];
        const direction = norm2(post) > 1e-12 ? post : uFree;
        const force = maxDissipationForce(characteristic, direction, muScale, true);
        return [candidate[0] - dt * force[0], candidate[1] - dt * force[1]];
      }, [dt * initialForce[0], dt * initialForce[1]]);
      impulse = solve.value;
      activeSet = FRICTION_ACTIVE_SET.SLIDE;
    }
    const rawImpulse = [...impulse];
    const rawForce = rawImpulse.map((value) => value / dt);
    const previousFrictionForce = previousState.mode === TIRE_REGIME.FRICTION_CONTACT
      && Array.isArray(previousState.frictionForce)
      && previousState.frictionForce.length === 2
      && previousState.frictionForce.every(Number.isFinite)
      ? previousState.frictionForce
      : [0, 0];
    // Four independent 2x2 contact solves share one rigid body snapshot. A
    // first-order force commit prevents their simultaneous Jacobi correction
    // from forming the observed exact two-step chassis limit cycle, while the
    // constitutive solve and its active set remain unchanged. At 120 Hz this
    // reaches 94% of a steady request in four fixed steps.
    const frictionForceCommit = 0.5;
    const appliedForce = rawForce.map((value, index) => (
      previousFrictionForce[index]
        + frictionForceCommit * (value - previousFrictionForce[index])
    ));
    const appliedPeakQ = (appliedForce[0] / Math.max(muScale * characteristic.fxPeak, EPSILON)) ** 2
      + (appliedForce[1] / Math.max(muScale * characteristic.fyPeak, EPSILON)) ** 2;
    if (appliedPeakQ > 1) {
      const capacityScale = 1 / Math.sqrt(appliedPeakQ);
      appliedForce[0] *= capacityScale;
      appliedForce[1] *= capacityScale;
    }
    const forceX = appliedForce[0];
    const forceY = appliedForce[1];
    impulse = appliedForce.map((value) => value * dt);
    const trail = pneumaticTrail(characteristic, 0);
    const rollingTorque = rollingResistanceTorque(normalLoad, radius, omega);
    const nextState = {
      sx: 0,
      sy: 0,
      sGamma: 0,
      mode: TIRE_REGIME.FRICTION_CONTACT,
      frictionForce: [...appliedForce],
    };
    const contactPower = -forceX * uFree[0] - forceY * uFree[1] + rollingTorque * omega;
    const appliedResidual = [
      uFree[0] - delassus[0][0] * impulse[0] - delassus[0][1] * impulse[1],
      uFree[1] - delassus[1][0] * impulse[0] - delassus[1][1] * impulse[1],
    ];
    return {
      forceX,
      forceY,
      forceZ: normalLoad,
      momentX: -characteristic.mxGamma * camber,
      momentY: rollingTorque,
      momentZ: -forceY * trail,
      effectiveRadius: radius,
      wheelContactTorque: -radius * forceX + rollingTorque,
      rawSlipX: uFree[0],
      rawSlipY: uFree[1],
      observableKappa: 0,
      observableAlpha: 0,
      contactPower,
      grossContactLoss: Math.max(0, -contactPower),
      forceUtilization: Math.hypot(
        forceX / Math.max(muScale * characteristic.fxPeak, EPSILON),
        forceY / Math.max(muScale * characteristic.fyPeak, EPSILON),
      ),
      nextState,
      regime,
      activeSet,
      impulse,
      scaledResidual: solve.scaledResidual,
      solver: {
        method: solve.method,
        iterations: solve.iterations,
        evaluations: solve.evaluations,
        residual: [...solve.residual],
        delassus: delassus.map((row) => [...row]),
        rawImpulse,
        frictionForceCommit,
        appliedResidual,
      },
    };
  }

  const convection = transport;
  const decayX = Math.exp(-convection * dt / Math.max(characteristic.sigmaX, 1e-9));
  const decayY = Math.exp(-convection * dt / Math.max(characteristic.sigmaY, 1e-9));
  const camberTarget = characteristic.kGamma / Math.max(characteristic.ky0, EPSILON) * camber;
  const evaluateImpulse = (impulse) => {
    const uPost = [
      uFree[0] - delassus[0][0] * impulse[0] - delassus[0][1] * impulse[1],
      uFree[1] - delassus[1][0] * impulse[0] - delassus[1][1] * impulse[1],
    ];
    const trialState = {
      sx: decayX * previousState.sx + (1 - decayX) * uPost[0] / convection,
      sy: decayY * previousState.sy + (1 - decayY) * uPost[1] / convection,
      sGamma: camberTarget,
      mode: TIRE_REGIME.HANDLING,
    };
    const output = evaluateAcceptedTireState({
      state: trialState,
      normalLoad,
      camber,
      muScale,
      omega,
      unloadedRadius,
      loadedRadius,
    });
    return { uPost, trialState, output };
  };
  const explicit = evaluateAcceptedHandlingTrial({
    previousState,
    normalLoad,
    velocityX,
    velocityY,
    omega,
    camber,
    muScale,
    dt,
    unloadedRadius,
    loadedRadius,
  });
  const solve = nonlinearSolve2((impulse) => {
    const evaluation = evaluateImpulse(impulse);
    return [
      impulse[0] - dt * evaluation.output.forceX,
      impulse[1] - dt * evaluation.output.forceY,
    ];
  }, [dt * explicit.forceX, dt * explicit.forceY]);
  const accepted = evaluateImpulse(solve.value);
  const rawSlipX = uFree[0];
  const rawSlipY = uFree[1];
  const contactPower = -accepted.output.forceX * rawSlipX
    - accepted.output.forceY * rawSlipY + accepted.output.momentY * omega;
  return {
    ...accepted.output,
    nextState: accepted.trialState,
    regime,
    activeSet: TIRE_REGIME.HANDLING,
    impulse: solve.value,
    rawSlipX,
    rawSlipY,
    observableKappa: rawSlipX / convection,
    observableAlpha: Math.atan(rawSlipY / convection),
    contactPower,
    grossContactLoss: Math.max(0, -contactPower),
    forceUtilization: Math.hypot(
      accepted.output.forceX / accepted.output.peakAxes[0],
      accepted.output.forceY / accepted.output.peakAxes[1],
    ),
    scaledResidual: solve.scaledResidual,
    solver: {
      method: solve.method,
      iterations: solve.iterations,
      evaluations: solve.evaluations,
      residual: [...solve.residual],
      delassus: delassus.map((row) => [...row]),
    },
  };
}
