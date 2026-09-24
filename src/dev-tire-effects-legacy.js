import * as THREE from 'three';

export class LegacyTireEffects {
  constructor(scene) {
    this.random = Math.random;
    this.scene = scene;
    this.markCapacity = 420;
    this.markCursor = 0;
    this.markCooldown = [0, 0, 0, 0];
    this.dummy = new THREE.Object3D();
    const markGeometry = new THREE.BoxGeometry(1, 0.012, 1);
    const markMaterial = new THREE.MeshBasicMaterial({ color: 0x17191b, transparent: true, opacity: 0.56, depthWrite: false });
    this.marks = new THREE.InstancedMesh(markGeometry, markMaterial, this.markCapacity);
    this.marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dummy.position.set(0, -50, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.markCapacity; i += 1) this.marks.setMatrixAt(i, this.dummy.matrix);
    this.marks.instanceMatrix.needsUpdate = true;
    scene.add(this.marks);

    this.particleCapacity = 180;
    this.particles = Array.from({ length: this.particleCapacity }, () => ({
      life: 0, maxLife: 1, position: new THREE.Vector3(0, -100, 0), velocity: new THREE.Vector3(), color: new THREE.Color(),
    }));
    this.particleCursor = 0;
    const positions = new Float32Array(this.particleCapacity * 3);
    const colors = new Float32Array(this.particleCapacity * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry = geometry;
    this.smoke = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ size: 1.15, transparent: true, opacity: 0.34, depthWrite: false, vertexColors: true, sizeAttenuation: true }),
    );
    scene.add(this.smoke);
  }

  addMark(point, yaw, intensity) {
    this.dummy.position.set(point.x, point.y + 0.024, point.z);
    this.dummy.rotation.set(0, yaw, 0);
    this.dummy.scale.set(0.17 + intensity * 0.06, 1, 0.42 + intensity * 0.22);
    this.dummy.updateMatrix();
    this.marks.setMatrixAt(this.markCursor, this.dummy.matrix);
    this.markCursor = (this.markCursor + 1) % this.markCapacity;
    this.marks.instanceMatrix.needsUpdate = true;
  }

  spawnParticle(point, surface, power) {
    const particle = this.particles[this.particleCursor];
    this.particleCursor = (this.particleCursor + 1) % this.particleCapacity;
    particle.position.copy(point).add(new THREE.Vector3((this.random() - 0.5) * 0.25, 0.12, (this.random() - 0.5) * 0.25));
    particle.velocity.set((this.random() - 0.5) * 0.55, 0.45 + this.random() * 0.7, (this.random() - 0.5) * 0.55);
    particle.maxLife = particle.life = 0.55 + this.random() * 0.55;
    if (surface === 'grass') particle.color.setRGB(0.32, 0.30, 0.21);
    else if (surface === 'gravel') particle.color.setRGB(0.48, 0.43, 0.34);
    else particle.color.setRGB(0.72 + power * 0.05, 0.73 + power * 0.05, 0.74 + power * 0.05);
  }

  update(dt, telemetry, vehicleQuaternion) {
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(vehicleQuaternion);
    const yaw = Math.atan2(forward.x, forward.z);
    for (let index = 0; index < telemetry.wheels.length; index += 1) {
      const wheel = telemetry.wheels[index];
      this.markCooldown[index] = Math.max(0, this.markCooldown[index] - dt);
      if (!wheel.grounded) continue;
      const paved = wheel.surface === 'asphalt' || wheel.surface === 'kerb';
      if (paved && telemetry.speedKmh > 16 && wheel.slipPower > 0.16 && this.markCooldown[index] <= 0) {
        this.addMark(wheel.contactPoint, yaw, Math.min(1, wheel.slipPower));
        this.markCooldown[index] = 0.055;
      }
      const rough = wheel.surface === 'grass' || wheel.surface === 'gravel';
      const shouldSmoke = paved && telemetry.speedKmh > 20 && wheel.slipPower > 0.24;
      if ((rough && telemetry.speedKmh > 12) || shouldSmoke) {
        const count = wheel.slipPower > 0.8 ? 2 : 1;
        for (let i = 0; i < count; i += 1) this.spawnParticle(wheel.contactPoint, wheel.surface, wheel.slipPower);
      }
    }

    const positions = this.particleGeometry.attributes.position.array;
    const colors = this.particleGeometry.attributes.color.array;
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      if (particle.life > 0) {
        particle.life -= dt;
        particle.position.addScaledVector(particle.velocity, dt);
        particle.velocity.y += dt * 0.08;
        particle.velocity.multiplyScalar(Math.pow(0.975, dt * 60));
      } else {
        particle.position.set(0, -100, 0);
      }
      const alpha = Math.max(0, particle.life / particle.maxLife);
      positions[i * 3] = particle.position.x;
      positions[i * 3 + 1] = particle.position.y;
      positions[i * 3 + 2] = particle.position.z;
      colors[i * 3] = particle.color.r * alpha;
      colors[i * 3 + 1] = particle.color.g * alpha;
      colors[i * 3 + 2] = particle.color.b * alpha;
    }
    this.particleGeometry.attributes.position.needsUpdate = true;
    this.particleGeometry.attributes.color.needsUpdate = true;
  }
}

