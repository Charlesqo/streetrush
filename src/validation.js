import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, FIXED_DT } from './config.js';
import { VehicleSystem } from './vehicle.js';
import { updateKeyboardSteer } from './input.js';

await RAPIER.init({});

class LabTrack {
  constructor() {
    this.config = { width: 80 };
    this.samples = Array.from({ length: 1024 }, (_, index) => ({ point: new THREE.Vector3(0, 0, index * 2), index }));
  }
  getResetPose() { return { position: new THREE.Vector3(0, 0.8, 0), yaw: 0, sampleIndex: 0 }; }
  getSurface(position) { return { id: 'asphalt', info: this.nearestInfo(position) }; }
  nearestInfo(position) { return { index: 0, offset: position.x, point: this.samples[0].point, surface: 'asphalt' }; }
}

const input = (patch = {}) => ({
  steer: 0, throttle: 0, brake: 0, handbrake: 0,
  shiftUp: false, shiftDown: false, toggleTransmission: false, reset: false,
  ...patch,
});

function step(vehicle, world, seconds, frame, observe) {
  for (let index = 0; index < Math.round(seconds / FIXED_DT); index += 1) {
    vehicle.fixedUpdate(frame, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
    observe?.();
  }
}

function yaw(rotation) {
  return Math.atan2(2 * (rotation.w * rotation.y + rotation.x * rotation.z), 1 - 2 * (rotation.y ** 2 + rotation.z ** 2));
}

function angleDelta(after, before) {
  return Math.atan2(Math.sin(after - before), Math.cos(after - before));
}

function runCar(config) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.integrationParameters.dt = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(120, 0.3, 1500), ground);
  const vehicle = new VehicleSystem({ RAPIER, world, scene: new THREE.Scene(), track: new LabTrack(), config, visual: new THREE.Group() });

  step(vehicle, world, 2, input());
  let minY = Infinity;
  let maxY = -Infinity;
  step(vehicle, world, 3, input(), () => {
    minY = Math.min(minY, vehicle.body.translation().y);
    maxY = Math.max(maxY, vehicle.body.translation().y);
  });
  const restY = vehicle.body.translation().y;
  let launchY = restY;
  step(vehicle, world, 5, input({ throttle: 0.72 }), () => { launchY = Math.max(launchY, vehicle.body.translation().y); });
  const forward = vehicle.telemetry.signedSpeedKmh;

  const turn = (steer) => {
    vehicle.reset(0);
    step(vehicle, world, 4, input({ throttle: 0.58 }));
    const before = yaw(vehicle.body.rotation());
    step(vehicle, world, 0.75, input({ throttle: 0.12, steer }));
    return angleDelta(yaw(vehicle.body.rotation()), before);
  };
  const left = turn(0.42);
  const right = turn(-0.42);

  vehicle.reset(0);
  step(vehicle, world, 3.5, input({ throttle: 0.55 }));
  step(vehicle, world, 4, input({ brake: 1 }));
  step(vehicle, world, 1.6, input({ brake: 1 }));
  const reverse = vehicle.telemetry.signedSpeedKmh;
  step(vehicle, world, 4, input({ throttle: 1 }));
  const recovery = vehicle.telemetry.signedSpeedKmh;
  const recovered = !vehicle.telemetry.reverse && recovery > 3;
  const heave = maxY - minY;
  const lift = launchY - restY;
  const passed = heave < 0.035 && lift < 0.16 && forward > 20 && left > 0.06 && right < -0.06 && reverse < -3 && recovered;
  vehicle.destroy();
  world.free();
  return { heave, lift, forward, left, right, reverse, recovery, passed };
}

const tbody = document.querySelector('#results');
let passCount = 0;
for (const config of CARS) {
  const result = runCar(config);
  passCount += Number(result.passed);
  const row = document.createElement('tr');
  row.innerHTML = `<td>${config.name}</td><td>${(result.heave * 100).toFixed(1)} cm</td><td>${(result.lift * 100).toFixed(1)} cm</td><td>${result.forward.toFixed(0)} km/h</td><td>${result.left.toFixed(2)} rad</td><td>${result.right.toFixed(2)} rad</td><td>${result.reverse.toFixed(1)} km/h</td><td>${result.recovery.toFixed(1)} km/h</td><td class="${result.passed ? 'pass' : 'fail'}">${result.passed ? 'PASS' : 'FAIL'}</td>`;
  tbody.append(row);
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
document.querySelector('#summary').textContent = `${passCount} / ${CARS.length} 车辆通过基础可驾驶验证`;
let lowSpeedTap = 0;
let highSpeedTap = 0;
for (let index = 0; index < 12; index += 1) {
  lowSpeedTap = updateKeyboardSteer(lowSpeedTap, 1, 0, 1 / 60);
  highSpeedTap = updateKeyboardSteer(highSpeedTap, 1, 160, 1 / 60);
}
let returned = lowSpeedTap;
for (let index = 0; index < 12; index += 1) returned = updateKeyboardSteer(returned, 0, 0, 1 / 60);
const inputPassed = lowSpeedTap > 0 && highSpeedTap > 0 && highSpeedTap < lowSpeedTap && Math.abs(returned) < 0.01;
const inputResult = document.querySelector('#input-result');
inputResult.className = inputPassed ? 'pass' : 'fail';
inputResult.textContent = `虚拟摇杆：${inputPassed ? 'PASS' : 'FAIL'} · 低速短按 ${(lowSpeedTap * 100).toFixed(0)}% · 高速短按 ${(highSpeedTap * 100).toFixed(0)}% · 松键回中 ${(returned * 100).toFixed(0)}%`;
