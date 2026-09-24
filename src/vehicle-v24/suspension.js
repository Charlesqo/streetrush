import { clamp, deepClone } from './math.js';

export const SUSPENSION_BACKEND = Object.freeze({
  MAPPED_KC_MASSLESS: 'MAPPED_KC_MASSLESS',
  DYNAMIC_UNSPRUNG: 'DYNAMIC_UNSPRUNG',
});

export const CONTACT_CLASS = Object.freeze({
  CONTACT: 'CONTACT',
  AIRBORNE: 'AIRBORNE',
});

export function createSuspensionState(config) {
  const staticCompression = config.mass * 9.81 / (4 * config.suspension.springRate);
  return {
    backend: SUSPENSION_BACKEND.MAPPED_KC_MASSLESS,
    corners: Array.from({ length: 4 }, () => ({
      compression: staticCompression,
      compressionRate: 0,
      jounce: 0,
      mode: CONTACT_CLASS.AIRBORNE,
    })),
  };
}

export function evaluateSyntheticKcMap(jounce, steer) {
  const q = clamp(jounce, -0.08, 0.08);
  const s = clamp(steer, -0.45, 0.45);
  return {
    position: {
      x: 0.018 * q + 0.22 * q * q + 0.0025 * q * s,
      y: -0.025 * q + 0.0015 * Math.sin(2 * s) + 0.004 * q * s,
      z: q + 0.10 * q * q - 0.0015 * s * s,
    },
    rotationVector: {
      x: -0.17 * q + 0.03 * q * s,
      y: 0.015 * q * s,
      z: 0.075 * q + 0.06 * s + 0.025 * q * s,
    },
    springLength: 0.31 - 0.74 * q + 0.28 * q * q + 0.004 * s * s,
    damperLength: 0.29 - 0.69 * q + 0.18 * q * q + 0.003 * q * s,
    antiRollCoordinate: 2.6 * q + 0.35 * q * q + 0.02 * s,
    domainClamped: q !== jounce || s !== steer,
  };
}

function airborneMasslessStep(previousCompression, staticCompression, springRate, damper, dt, externalLoad) {
  if (damper <= 0) return clamp(staticCompression + externalLoad / springRate, 0, staticCompression + 0.08);
  const denominator = springRate + damper / dt;
  return clamp(
    (springRate * staticCompression + damper / dt * previousCompression + externalLoad) / denominator,
    0,
    staticCompression + 0.08,
  );
}

export function solveMappedKcSuspension({
  previousState,
  contacts,
  steeringTrial,
  config,
  dt,
}) {
  const snapshot = deepClone(previousState);
  const suspension = config.suspension;
  const staticCompression = config.mass * 9.81 / (4 * suspension.springRate);
  const compressions = contacts.map((contact, index) => (
    contact.inContact
      ? clamp(contact.compression, 0, suspension.travel)
      : snapshot.corners[index].compression
  ));

  // The anti-roll bar remains an internal cross-corner owner even when one corner is airborne.
  for (const [leftIndex, rightIndex] of [[0, 1], [2, 3]]) {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const antiRollLeft = -suspension.antiRoll * (compressions[leftIndex] - compressions[rightIndex]);
      const antiRollRight = -antiRollLeft;
      if (!contacts[leftIndex].inContact) {
        compressions[leftIndex] = airborneMasslessStep(
          snapshot.corners[leftIndex].compression,
          staticCompression,
          suspension.springRate,
          suspension.damperRebound,
          dt,
          antiRollLeft,
        );
      }
      if (!contacts[rightIndex].inContact) {
        compressions[rightIndex] = airborneMasslessStep(
          snapshot.corners[rightIndex].compression,
          staticCompression,
          suspension.springRate,
          suspension.damperRebound,
          dt,
          antiRollRight,
        );
      }
    }
  }

  const candidates = compressions.map((compression, index) => {
    const contact = contacts[index];
    const prior = snapshot.corners[index];
    const measuredRate = contact.inContact
      ? contact.compressionRate
      : (compression - prior.compression) / dt;
    const compressionRate = Number.isFinite(measuredRate)
      ? clamp(measuredRate, -8, 8)
      : (compression - prior.compression) / dt;
    const damper = compressionRate >= 0 ? suspension.damperBump : suspension.damperRebound;
    return {
      compression,
      compressionRate,
      elasticDamperForce: suspension.springRate * compression + damper * compressionRate,
    };
  });
  for (const [leftIndex, rightIndex] of [[0, 1], [2, 3]]) {
    const antiRoll = (compressions[leftIndex] - compressions[rightIndex]) * suspension.antiRoll;
    candidates[leftIndex].elasticDamperForce += antiRoll;
    candidates[rightIndex].elasticDamperForce -= antiRoll;
  }

  const maximumWheelLoad = config.mass * 9.81 * 0.72;
  const corners = candidates.map((candidate, index) => {
    const contact = contacts[index];
    const oracleSteer = index === 0
      ? steeringTrial.oracleWheelAngles.left
      : index === 1
        ? steeringTrial.oracleWheelAngles.right
        : 0;
    const jounce = candidate.compression - staticCompression;
    // The active unified_vehicle_fixture applies one canonical KC asset by side:
    // camber = side * rx; toe = side * (rz(q, steer) - rz(0, steer)).
    // Without this, equal left/right jounce steers both tires in the same direction.
    const side = index % 2 === 0 ? 1 : -1;
    const kc = evaluateSyntheticKcMap(jounce, oracleSteer);
    const zeroKc = evaluateSyntheticKcMap(0, oracleSteer);
    const normalLoad = contact.inContact
      ? clamp(candidate.elasticDamperForce, 0, maximumWheelLoad)
      : 0;
    return {
      compression: candidate.compression,
      compressionRate: candidate.compressionRate,
      jounce,
      mode: contact.inContact && normalLoad > 0 ? CONTACT_CLASS.CONTACT : CONTACT_CLASS.AIRBORNE,
      normalLoad,
      normalImpulse: normalLoad * dt,
      gap: contact.inContact ? contact.gap : Math.max(0, contact.gap),
      camber: side * kc.rotationVector.x,
      toe: side * (kc.rotationVector.z - zeroKc.rotationVector.z),
      kc,
    };
  });
  const nextState = {
    backend: SUSPENSION_BACKEND.MAPPED_KC_MASSLESS,
    corners: corners.map(({ compression, compressionRate, jounce, mode }) => ({
      compression, compressionRate, jounce, mode,
    })),
  };
  const complementarityResidual = Math.max(...corners.map((corner) => {
    if (corner.mode === CONTACT_CLASS.AIRBORNE) return Math.abs(corner.normalLoad);
    return Math.max(0, -corner.normalLoad, -corner.gap);
  }));
  return {
    snapshot,
    nextState,
    corners,
    complementarityResidual,
    normalAuthority: 'MAPPED_KC_RIGID_NORMAL',
  };
}
