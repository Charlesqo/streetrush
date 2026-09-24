import * as THREE from 'three';
export { TireEffects } from './tire-effects.js';

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.lookTarget = new THREE.Vector3();
    this.positionTarget = new THREE.Vector3();
    this.focusTarget = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.shakePhase = 0;
    this.accelVisual = 0;
  }

  snap(position, quaternion) {
    this.forward.set(0, 0, 1).applyQuaternion(quaternion).normalize();
    this.camera.position.copy(position).addScaledVector(this.forward, -10.2).add(new THREE.Vector3(0, 4.8, 0));
    this.lookTarget.copy(position).addScaledVector(this.forward, 7).add(new THREE.Vector3(0, 1.1, 0));
    this.camera.lookAt(this.lookTarget);
  }

  update(dt, position, quaternion, telemetry, menu = false) {
    this.forward.set(0, 0, 1).applyQuaternion(quaternion).normalize();
    if (menu) {
      this.right.crossVectors(this.up, this.forward).normalize();
      this.positionTarget.copy(position).addScaledVector(this.forward, -7.4).addScaledVector(this.right, 6.2).addScaledVector(this.up, 3.15);
      this.focusTarget.copy(position).addScaledVector(this.up, 0.72);
      this.lookTarget.lerp(this.focusTarget, 1 - Math.exp(-dt * 4));
      this.camera.position.lerp(this.positionTarget, 1 - Math.exp(-dt * 4));
      this.camera.lookAt(this.lookTarget);
      return;
    }
    const speedFactor = Math.min(1, telemetry.speedKmh / 260);
    this.accelVisual = THREE.MathUtils.damp(this.accelVisual, telemetry.longitudinalAcceleration, 3.2, dt);
    const accelPitch = THREE.MathUtils.clamp(this.accelVisual * 0.018, -0.28, 0.22);
    const distance = 9.4 + speedFactor * 2.2;
    this.positionTarget.copy(position).addScaledVector(this.forward, -distance).addScaledVector(this.up, 4.25 - accelPitch);
    this.focusTarget.copy(position).addScaledVector(this.forward, 7.5 + speedFactor * 4).addScaledVector(this.up, 1.05 + accelPitch * 0.25);
    this.lookTarget.lerp(this.focusTarget, 1 - Math.exp(-dt * 10));
    const rough = telemetry.surface === 'kerb' ? 1 : telemetry.surface === 'asphalt' ? 0 : 0.7;
    this.shakePhase += dt * (telemetry.surface === 'kerb' ? 68 : 31);
    const shake = rough * Math.min(1, telemetry.speedKmh / 80) * 0.022;
    this.positionTarget.x += Math.sin(this.shakePhase * 1.7) * shake;
    this.positionTarget.y += Math.sin(this.shakePhase) * shake;
    this.camera.position.lerp(this.positionTarget, 1 - Math.exp(-dt * 8.5));
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, 58 + speedFactor * 11, 5.5, dt);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.lookTarget);
  }
}
