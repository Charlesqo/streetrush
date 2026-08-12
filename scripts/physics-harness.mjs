import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT } from '../src/config.js';
import { initializeRapier } from '../src/rapier-init.js';
import { GRAVITY } from '../src/vehicle-physics.js';
import { VehicleSystem } from '../src/vehicle.js';

await initializeRapier(RAPIER);

export const zeroInput = (patch = {}) => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  shiftUp: false,
  shiftDown: false,
  toggleTransmission: false,
  reset: false,
  ...patch,
});

export class FlatTrack {
  constructor({ width = 10000, sampleSpacing = 2 } = {}) {
    this.config = { width };
    this.sampleSpacing = sampleSpacing;
  }

  getResetPose(index = 0) {
    return {
      position: new THREE.Vector3(0, 0.8, index * this.sampleSpacing),
      yaw: 0,
      sampleIndex: index,
    };
  }

  getSurface(position) {
    return { id: 'asphalt', grip: 1, rolling: 1, info: this.nearestInfo(position) };
  }

  nearestInfo(position) {
    return {
      index: Math.max(0, Math.round(position.z / this.sampleSpacing)),
      offset: position.x,
      point: new THREE.Vector3(0, 0, position.z),
      surface: 'asphalt',
    };
  }
}

export function createVehicleRig(config, { groundHalfExtent = 12000, trackWidth = 10000 } = {}) {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.integrationParameters.dt = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(groundHalfExtent, 0.3, groundHalfExtent).setFriction(0.2),
    ground,
  );
  const scene = new THREE.Scene();
  const visual = new THREE.Group();
  visual.userData.wheelNodes = [];
  const vehicle = new VehicleSystem({
    RAPIER,
    world,
    scene,
    track: new FlatTrack({ width: trackWidth }),
    config,
    visual,
  });
  return { vehicle, world };
}

export function stepVehicle(rig, input = zeroInput()) {
  rig.vehicle.fixedUpdate(input, false, FIXED_DT);
  rig.world.step();
  rig.vehicle.afterPhysics();
}

export function runFor(rig, seconds, input = zeroInput(), onStep) {
  const steps = Math.round(seconds / FIXED_DT);
  for (let index = 0; index < steps; index += 1) {
    stepVehicle(rig, input);
    onStep?.({ index, elapsed: (index + 1) * FIXED_DT, ...rig });
  }
}

export function settleVehicle(rig, seconds = 2) {
  runFor(rig, seconds, zeroInput());
}

export function destroyVehicleRig(rig) {
  rig.vehicle.destroy();
  rig.world.free();
}

export function yawOf(rotation) {
  return Math.atan2(
    2 * (rotation.w * rotation.y + rotation.x * rotation.z),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
  );
}
