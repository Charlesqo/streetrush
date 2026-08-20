const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function requireFinite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

export function computeDevRaceDriverInput(state) {
  const positionX = requireFinite(state?.positionX, 'positionX');
  const positionZ = requireFinite(state?.positionZ, 'positionZ');
  const forwardX = requireFinite(state?.forwardX, 'forwardX');
  const forwardZ = requireFinite(state?.forwardZ, 'forwardZ');
  const targetX = requireFinite(state?.targetX, 'targetX');
  const targetZ = requireFinite(state?.targetZ, 'targetZ');
  const trackOffset = requireFinite(state?.trackOffset, 'trackOffset');
  const curvatureRadians = Math.abs(requireFinite(state?.curvatureRadians, 'curvatureRadians'));
  const speedKmh = Math.max(0, requireFinite(state?.speedKmh, 'speedKmh'));

  const targetDeltaX = targetX - positionX;
  const targetDeltaZ = targetZ - positionZ;
  const targetLength = Math.hypot(targetDeltaX, targetDeltaZ);
  if (targetLength < 1e-6) throw new RangeError('target must differ from position');
  const forwardLength = Math.hypot(forwardX, forwardZ);
  if (forwardLength < 1e-6) throw new RangeError('forward vector must be non-zero');

  const desiredX = targetDeltaX / targetLength;
  const desiredZ = targetDeltaZ / targetLength;
  const normalizedForwardX = forwardX / forwardLength;
  const normalizedForwardZ = forwardZ / forwardLength;
  const headingError = Math.atan2(
    normalizedForwardZ * desiredX - normalizedForwardX * desiredZ,
    normalizedForwardX * desiredX + normalizedForwardZ * desiredZ,
  );
  const steer = clamp(headingError * 1.7 - trackOffset * 0.065, -1, 1);
  let targetSpeedKmh = clamp(62 - curvatureRadians * 72 - Math.abs(trackOffset) * 3.2, 24, 62);
  if (Math.abs(headingError) > 0.62) targetSpeedKmh = Math.min(targetSpeedKmh, 28);

  const overspeed = speedKmh - targetSpeedKmh;
  const brake = overspeed > 2 ? clamp(overspeed / 18, 0, 0.82) : 0;
  const throttle = brake > 0
    ? 0
    : clamp((targetSpeedKmh + 4 - speedKmh) / 12, 0.18, 1);

  return {
    steer,
    throttle,
    brake,
    handbrake: 0,
    shiftUp: false,
    shiftDown: false,
    toggleTransmission: false,
    reset: false,
    driveIntent: throttle - brake,
    targetSpeedKmh,
  };
}
