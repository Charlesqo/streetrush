import { FIXED_DT } from './config.js';

// Keep the largest accepted render delta and the catch-up budget aligned. A
// 50ms frame contains six 120Hz simulation steps; allowing only five steps
// would silently make races slower on a 20 FPS device.
export const MAX_FRAME_DT = 0.05;
export const MAX_PHYSICS_STEPS = Math.ceil(MAX_FRAME_DT / FIXED_DT);

export function clampFrameDelta(deltaSeconds) {
  return Math.min(MAX_FRAME_DT, Math.max(0, deltaSeconds));
}

export function accumulatePhysicsTime(accumulator, deltaSeconds) {
  return Math.min(
    accumulator + clampFrameDelta(deltaSeconds),
    FIXED_DT * MAX_PHYSICS_STEPS,
  );
}
