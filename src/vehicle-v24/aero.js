import {
  addVec3,
  crossVec3,
  lengthVec3,
  rotateVector,
  scaleVec3,
  vec3,
} from './math.js';

const AIR_DENSITY = 1.225;

export function evaluateAeroWrench({ bodySample, axes, config, asset = null }) {
  const velocity = bodySample.linvel;
  const speed = lengthVec3(velocity);
  if (speed <= 1e-12) {
    return {
      forceWorld: vec3(),
      momentWorldAtCom: vec3(),
      forceBodyOracle: [0, 0, 0],
      momentBodyOracle: [0, 0, 0],
      coefficients: [0, 0, 0, 0, 0, 0],
      dynamicPressure: 0,
      beta: 0,
      backend: 'QSS_FORWARD',
    };
  }
  const velocityBody = [
    velocity.x * axes.forward.x + velocity.y * axes.forward.y + velocity.z * axes.forward.z,
    velocity.x * axes.left.x + velocity.y * axes.left.y + velocity.z * axes.left.z,
    velocity.x * axes.up.x + velocity.y * axes.up.y + velocity.z * axes.up.z,
  ];
  const dynamicPressure = 0.5 * AIR_DENSITY * speed * speed;
  const area = asset?.area ?? 1;
  const length = asset?.length ?? config.wheelbase;
  const normalizedVelocity = velocityBody.map((value) => value / speed);
  const forceCoefficients = asset?.forceCoefficients
    ?? normalizedVelocity.map((value) => -config.cdA / area * value);
  const momentCoefficients = asset?.momentCoefficients ?? [0, 0, 0];
  const forceBodyOracle = forceCoefficients.map((coefficient) => dynamicPressure * area * coefficient);
  const momentBodyOracle = momentCoefficients.map((coefficient) => (
    dynamicPressure * area * length * coefficient
  ));
  const forceWorld = addVec3(
    addVec3(
      scaleVec3(axes.forward, forceBodyOracle[0]),
      scaleVec3(axes.left, forceBodyOracle[1]),
    ),
    scaleVec3(axes.up, forceBodyOracle[2]),
  );
  // The oracle-to-StreetRush basis is a reflection. Force is a polar vector,
  // while moment is axial, so moments receive the determinant (-1) factor.
  const momentWorldAtReference = scaleVec3(addVec3(
    addVec3(
      scaleVec3(axes.forward, momentBodyOracle[0]),
      scaleVec3(axes.left, momentBodyOracle[1]),
    ),
    scaleVec3(axes.up, momentBodyOracle[2]),
  ), -1);
  const referenceOffsetLocal = asset?.referenceOffsetLocal ?? vec3();
  const referenceOffsetWorld = rotateVector(bodySample.rotation, referenceOffsetLocal);
  const momentWorldAtCom = addVec3(
    momentWorldAtReference,
    crossVec3(referenceOffsetWorld, forceWorld),
  );
  return {
    forceWorld,
    momentWorldAtCom,
    forceBodyOracle,
    momentBodyOracle,
    coefficients: [...forceCoefficients, ...momentCoefficients],
    dynamicPressure,
    beta: Math.atan2(velocityBody[1], velocityBody[0]),
    backend: velocityBody[0] > 0 ? 'QSS_FORWARD' : 'ISOTROPIC_REVERSE_FALLBACK',
  };
}
