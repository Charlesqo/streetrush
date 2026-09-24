export const EPSILON = 1e-12;

export const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
export const lerp = (start, end, alpha) => start + (end - start) * alpha;
export const signOrZero = (value) => value > 0 ? 1 : value < 0 ? -1 : 0;

export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function cloneVec3(value) {
  return vec3(value.x, value.y, value.z);
}

export function addVec3(a, b) {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function subVec3(a, b) {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scaleVec3(value, scalar) {
  return vec3(value.x * scalar, value.y * scalar, value.z * scalar);
}

export function addScaledVec3(a, b, scalar) {
  return vec3(a.x + b.x * scalar, a.y + b.y * scalar, a.z + b.z * scalar);
}

export function dotVec3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossVec3(a, b) {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

export function lengthSqVec3(value) {
  return dotVec3(value, value);
}

export function lengthVec3(value) {
  return Math.sqrt(lengthSqVec3(value));
}

export function normalizeVec3(value, fallback = vec3(0, 1, 0)) {
  const length = lengthVec3(value);
  return length > EPSILON ? scaleVec3(value, 1 / length) : cloneVec3(fallback);
}

export function projectOnPlane(value, normal) {
  return addScaledVec3(value, normal, -dotVec3(value, normal));
}

export function rotateVector(quaternion, value) {
  const qv = vec3(quaternion.x, quaternion.y, quaternion.z);
  const t = scaleVec3(crossVec3(qv, value), 2);
  return addVec3(value, addVec3(scaleVec3(t, quaternion.w), crossVec3(qv, t)));
}

export function rotateAroundAxis(value, axis, angle) {
  const n = normalizeVec3(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return addVec3(
    addVec3(scaleVec3(value, cosine), scaleVec3(crossVec3(n, value), sine)),
    scaleVec3(n, dotVec3(n, value) * (1 - cosine)),
  );
}

export function matrixVector3(matrix, value) {
  if (!matrix) return vec3();
  return vec3(
    matrix.m11 * value.x + matrix.m12 * value.y + matrix.m13 * value.z,
    matrix.m21 * value.x + matrix.m22 * value.y + matrix.m23 * value.z,
    matrix.m31 * value.x + matrix.m32 * value.y + matrix.m33 * value.z,
  );
}

export function spatialInverseMass(bodySample, point, directionA, directionB = directionA) {
  if (!bodySample || bodySample.dynamic !== true) return 0;
  const arm = subVec3(point, bodySample.worldCom);
  const angularA = crossVec3(arm, directionA);
  const angularB = crossVec3(arm, directionB);
  const inertiaResponse = matrixVector3(bodySample.effectiveWorldInvInertia, angularB);
  return bodySample.invMass * dotVec3(directionA, directionB)
    + dotVec3(angularA, inertiaResponse);
}

export function solveSymmetric2x2(matrix, rhs) {
  const determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  if (Math.abs(determinant) <= EPSILON) {
    const regularization = 1e-8;
    const adjusted = [
      [matrix[0][0] + regularization, matrix[0][1]],
      [matrix[1][0], matrix[1][1] + regularization],
    ];
    return solveSymmetric2x2(adjusted, rhs);
  }
  return [
    (rhs[0] * matrix[1][1] - matrix[0][1] * rhs[1]) / determinant,
    (matrix[0][0] * rhs[1] - rhs[0] * matrix[1][0]) / determinant,
  ];
}

export function norm2(value) {
  return Math.hypot(value[0], value[1]);
}

export function finiteDeep(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(finiteDeep);
  return Object.values(value).every(finiteDeep);
}

export function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

