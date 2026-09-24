import * as THREE from 'three';
import { FIXED_DT, SURFACES } from './config.js';
import {
  GRAVITY,
  SHIFT_DURATION,
  SHIFT_TORQUE_FACTOR,
  aerodynamicDragScale,
  drivetrainEfficiency,
  frictionLimitedYawRate,
  integrateWheelOmegaWithBrakeCapacity,
  roadWheelRpm,
  torqueCurveFactor,
} from './vehicle-physics.js';
import { VehicleV24AbortError, VehicleV24Runtime } from './vehicle-v24/index.js';

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const MIN_SAFE_UPDATE_DT = FIXED_DT * 0.25;
const MAX_SAFE_UPDATE_DT = 0.05;
const REVERSE_ENGAGE_HOLD_SECONDS = 0.45;
const HANDBRAKE_ACTIVE_THRESHOLD = 0.05;
const HANDBRAKE_REAR_TORQUE_FACTOR = 0.72;

const finiteOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function hasFiniteVector(value) {
  return value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z);
}

function hasFiniteBodyState(translation, rotation, linearVelocity, angularVelocity) {
  return hasFiniteVector(translation)
    && hasFiniteVector(rotation)
    && Number.isFinite(rotation.w)
    && hasFiniteVector(linearVelocity)
    && hasFiniteVector(angularVelocity);
}

function safeUpdateDt(dt) {
  if (!Number.isFinite(dt) || dt <= 0) return FIXED_DT;
  return clamp(dt, MIN_SAFE_UPDATE_DT, MAX_SAFE_UPDATE_DT);
}

function sanitizeInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const numberInRange = (value, minimum, maximum) => clamp(
    finiteOr(value),
    minimum,
    maximum,
  );
  const safeInput = {
    steer: numberInRange(source.steer, -1, 1),
    throttle: numberInRange(source.throttle, 0, 1),
    brake: numberInRange(source.brake, 0, 1),
    handbrake: numberInRange(source.handbrake, 0, 1),
    directionConflict: source.directionConflict === true,
    shiftUp: source.shiftUp === true,
    shiftDown: source.shiftDown === true,
    toggleTransmission: source.toggleTransmission === true,
    reset: source.reset === true,
  };
  if (Number.isFinite(source.driveIntent)) {
    safeInput.driveIntent = clamp(source.driveIntent, -1, 1);
  }
  return safeInput;
}

export function disposeOwnedVisual(root) {
  if (!root || root.userData?.source !== 'fallback') return false;
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  return true;
}

export class VehicleSystem {
  constructor({
    RAPIER,
    world,
    scene,
    track,
    config,
    visual,
    onAutomaticReset = null,
    vehiclePhysicsMode = 'legacy',
    vehicleV24Options = null,
  }) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.track = track;
    this.config = config;
    this.visual = visual;
    this.onAutomaticReset = typeof onAutomaticReset === 'function' ? onAutomaticReset : null;
    if (!['legacy', 'v24-shadow', 'v24-active'].includes(vehiclePhysicsMode)) {
      throw new Error(`Unknown vehicle physics mode: ${vehiclePhysicsMode}`);
    }
    this.vehiclePhysicsMode = vehiclePhysicsMode;
    this.vehiclePhysicsReport = null;
    this.visual.name = `vehicle-${config.id}`;
    scene.add(this.visual);
    this.transmissionMode = 'AT';
    this.gear = 1;
    this.reverse = false;
    this.reverseHold = 0;
    this.shiftTimer = 0;
    this.engineRpm = config.idle;
    this.engineLoad = 0;
    this.previousLongSpeed = 0;
    this.smoothedLongAcceleration = 0;
    this.safeSample = 0;
    this.trackHint = 0;
    this.stuckTimer = 0;
    this.steerAngle = 0;
    this.wheelInertia = 1.25;
    this.currentPose = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
    this.previousPose = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
    this.tmp = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(),
      right: new THREE.Vector3(), up: new THREE.Vector3(), origin: new THREE.Vector3(),
      worldUp: new THREE.Vector3(0, 1, 0),
      down: new THREE.Vector3(), point: new THREE.Vector3(),
      bodyVelocity: new THREE.Vector3(), velocity: new THREE.Vector3(),
      force: new THREE.Vector3(), wheelForward: new THREE.Vector3(), wheelRight: new THREE.Vector3(),
    };
    this.createBody();
    this.createWheels();
    this.visualWheelBindings = this.bindVisualWheels();
    this.drivenWheels = this.wheels.filter((wheel) => wheel.driven);
    this.lockedInput = {
      steer: 0, throttle: 0, brake: 0, handbrake: 0,
      directionConflict: false,
      shiftUp: false, shiftDown: false, toggleTransmission: false, reset: false, driveIntent: 0,
    };
    this.telemetry = {
      speedKmh: 0, signedSpeedKmh: 0, rpm: config.idle, gear: 1, reverse: false, driveIntent: 0,
      throttle: 0, brake: 0, handbrake: 0, steer: 0, longitudinalAcceleration: 0, lateralAcceleration: 0,
      surface: 'asphalt', absActive: false, tcsActive: false, stabilityActive: false,
      powertrain: {
        driveTorqueRequestedNm: 0,
        driveTorqueAppliedNm: 0,
        wheelDriveTorqueRequestedNm: 0,
        wheelDriveTorqueAppliedNm: 0,
        serviceBrakeTorqueRequestedNm: 0,
        serviceBrakeTorqueAppliedNm: 0,
        driverServiceBrakeTorqueRequestedNm: 0,
        driverServiceBrakeTorqueAppliedNm: 0,
        assistBrakeTorqueRequestedNm: 0,
        assistBrakeTorqueAppliedNm: 0,
        handbrakeTorqueRequestedNm: 0,
        handbrakeTorqueAppliedNm: 0,
      },
      wheels: this.wheels.map(() => ({
        grounded: false, load: 0, suspension: 0, slipRatio: 0, slipAngle: 0,
        slipPower: 0, surface: 'asphalt', contactPoint: new THREE.Vector3(),
      })),
      vehiclePhysics: null,
    };
    this.vehicleV24 = vehiclePhysicsMode === 'legacy'
      ? null
      : new VehicleV24Runtime({
        RAPIER,
        world,
        body: this.body,
        track,
        config,
        wheels: this.wheels,
        options: vehicleV24Options ?? {},
      });
  }

  createBody() {
    const pose = this.track.getResetPose(0);
    pose.position.y = this.config.model.groundOffset + 0.025;
    const yawRotation = { x: 0, y: Math.sin(pose.yaw * 0.5), z: 0, w: Math.cos(pose.yaw * 0.5) };
    const desc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.position.x, pose.position.y, pose.position.z)
      .setRotation(yawRotation)
      // Rolling resistance and aerodynamic drag are modeled explicitly below.
      // Rapier damping is mass-scaled, so enabling it here adds a second hidden
      // speed-dependent resistance and disproportionately slows heavier cars.
      .setLinearDamping(0)
      .setAngularDamping(0.72)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = this.world.createRigidBody(desc);
    const configuredLength = Number(this.config.model?.targetLength);
    const halfLength = Number.isFinite(configuredLength) && configuredLength > 0
      ? configuredLength * 0.5
      : Math.max(1.75, this.config.wheelbase * 0.72);
    const collider = this.RAPIER.ColliderDesc.cuboid(this.config.trackWidth * 0.52, 0.28, halfLength)
      .setTranslation(0, -0.09, 0)
      .setMass(this.config.mass)
      .setFriction(0.28)
      .setRestitution(0.04);
    this.collider = this.world.createCollider(collider, this.body);
    this.currentPose.position.copy(pose.position);
    this.previousPose.position.copy(pose.position);
    this.currentPose.rotation.set(yawRotation.x, yawRotation.y, yawRotation.z, yawRotation.w);
    this.previousPose.rotation.copy(this.currentPose.rotation);
  }

  createWheels() {
    const halfTrack = this.config.trackWidth * 0.5;
    const halfBase = this.config.wheelbase * 0.5;
    const anchorHeight = this.config.wheelRadius + this.config.suspension.restLength
      - this.config.mass * GRAVITY / (4 * this.config.suspension.springRate)
      - this.config.model.groundOffset;
    const drivenFront = this.config.drivetrain === 'AWD' || this.config.drivetrain === 'FWD';
    const drivenRear = this.config.drivetrain === 'AWD' || this.config.drivetrain === 'RWD';
    this.wheels = [
      { id: 'FL', anchor: new THREE.Vector3(-halfTrack, anchorHeight, halfBase), front: true, driven: drivenFront, omega: 0 },
      { id: 'FR', anchor: new THREE.Vector3(halfTrack, anchorHeight, halfBase), front: true, driven: drivenFront, omega: 0 },
      { id: 'RL', anchor: new THREE.Vector3(-halfTrack, anchorHeight, -halfBase), front: false, driven: drivenRear, omega: 0 },
      { id: 'RR', anchor: new THREE.Vector3(halfTrack, anchorHeight, -halfBase), front: false, driven: drivenRear, omega: 0 },
    ].map((wheel) => ({
      ...wheel,
      grounded: false,
      compression: 0,
      springForce: 0,
      hit: null,
      surface: 'asphalt',
      previousVisualAngle: 0,
      visualAngle: 0,
    }));
  }

  bindVisualWheels() {
    const wheelSet = this.visual.getObjectByName('calibrated-wheels');
    if (wheelSet?.userData?.visualWheelBindingVersion !== 1) return [];
    const bindings = this.wheels.map(({ id }) => {
      const steer = wheelSet.getObjectByName(`visual-wheel-${id}-steer`);
      const roll = wheelSet.getObjectByName(`visual-wheel-${id}-roll`);
      if (!steer || !roll || roll.parent !== steer) return null;
      return { id, steer, roll, baseY: steer.position.y };
    });
    return bindings.every(Boolean) ? bindings : [];
  }

  advanceVisualWheelAngles(dt) {
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const wheel of this.wheels) {
      if (!Number.isFinite(wheel.visualAngle)) wheel.visualAngle = 0;
      if (!Number.isFinite(wheel.previousVisualAngle)) wheel.previousVisualAngle = wheel.visualAngle;
      wheel.previousVisualAngle = wheel.visualAngle;
      wheel.visualAngle += finiteOr(wheel.omega) * safeDt;
      if (Math.abs(wheel.visualAngle) > Math.PI * 4096) {
        const offset = Math.trunc(wheel.visualAngle / (Math.PI * 2)) * Math.PI * 2;
        wheel.visualAngle -= offset;
        wheel.previousVisualAngle -= offset;
      }
    }
  }

  requestShift(delta) {
    const next = clamp(this.gear + delta, 1, this.config.gears.length);
    if (next !== this.gear && this.shiftTimer <= 0) {
      this.gear = next;
      this.shiftTimer = SHIFT_DURATION;
    }
  }

  setReverseState(reverse) {
    if (this.reverse === reverse) return;
    this.reverse = reverse;
    this.reverseHold = 0;
    this.gear = 1;
    this.shiftTimer = 0.08;
    this.engineRpm = Math.max(this.config.idle, Math.min(this.engineRpm, this.config.idle * 1.35));
  }

  reset(sampleIndex = this.safeSample) {
    const pose = this.track.getResetPose(sampleIndex);
    pose.position.y = this.config.model.groundOffset + 0.025;
    const rotation = { x: 0, y: Math.sin(pose.yaw * 0.5), z: 0, w: Math.cos(pose.yaw * 0.5) };
    this.body.setTranslation(pose.position, true);
    this.body.setRotation(rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    for (const wheel of this.wheels) {
      wheel.omega = 0;
      wheel.grounded = false;
      wheel.compression = 0;
      wheel.springForce = 0;
      wheel.hit = null;
      wheel.surface = 'asphalt';
      wheel.previousVisualAngle = 0;
      wheel.visualAngle = 0;
    }
    this.gear = 1;
    this.reverse = false;
    this.reverseHold = 0;
    this.shiftTimer = 0;
    this.engineRpm = this.config.idle;
    this.engineLoad = 0;
    this.steerAngle = 0;
    this.trackHint = pose.sampleIndex;
    this.previousLongSpeed = 0;
    this.smoothedLongAcceleration = 0;
    this.safeSample = pose.sampleIndex;
    this.stuckTimer = 0;
    this.vehicleV24?.reset();
    this.vehiclePhysicsReport = null;
    this.afterPhysics();
    this.previousPose.position.copy(this.currentPose.position);
    this.previousPose.rotation.copy(this.currentPose.rotation);
    this.resetTelemetry();
  }

  resetTelemetry() {
    this.telemetry.speedKmh = 0;
    this.telemetry.signedSpeedKmh = 0;
    this.telemetry.rpm = this.config.idle;
    this.telemetry.gear = 1;
    this.telemetry.reverse = false;
    this.telemetry.driveIntent = 0;
    this.telemetry.throttle = 0;
    this.telemetry.brake = 0;
    this.telemetry.handbrake = 0;
    this.telemetry.steer = 0;
    this.telemetry.longitudinalAcceleration = 0;
    this.telemetry.lateralAcceleration = 0;
    this.telemetry.surface = 'asphalt';
    this.telemetry.absActive = false;
    this.telemetry.tcsActive = false;
    this.telemetry.stabilityActive = false;
    this.telemetry.vehiclePhysics = null;
    for (const field of Object.keys(this.telemetry.powertrain)) {
      this.telemetry.powertrain[field] = 0;
    }
    for (const wheel of this.telemetry.wheels) {
      wheel.grounded = false;
      wheel.load = 0;
      wheel.suspension = 0;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      wheel.slipPower = 0;
      wheel.surface = 'asphalt';
      wheel.contactPoint.set(0, 0, 0);
    }
  }

  torqueCurve(rpm) {
    return torqueCurveFactor(this.config, rpm);
  }

  updateTransmission(input, dt, longSpeed) {
    if (input.toggleTransmission) this.transmissionMode = this.transmissionMode === 'AT' ? 'MT' : 'AT';
    if (this.transmissionMode === 'MT') {
      if (input.shiftUp) this.requestShift(1);
      if (input.shiftDown) this.requestShift(-1);
    }
    // W and S are directional requests, not two pedals whose meaning depends on
    // a sticky mode. W always asks for forward; S brakes a forward-moving car,
    // then selects reverse only once the driveline is almost stationary.
    const switchSpeed = 0.22;
    const explicitIntent = Number.isFinite(input.driveIntent);
    const driveIntent = explicitIntent
      ? Math.sign(input.driveIntent)
      : (input.throttle > 0.055 ? 1 : input.brake > 0.055 ? -1 : 0);
    const wantsForward = driveIntent > 0;
    const wantsReverse = driveIntent < 0;
    let driveThrottle = 0;
    let serviceBrake = 0;

    if (input.directionConflict) {
      this.reverseHold = 0;
      if (longSpeed > switchSpeed) serviceBrake = input.brake;
      else if (longSpeed < -switchSpeed) serviceBrake = input.throttle;
      else serviceBrake = this.reverse ? input.throttle : input.brake;
    } else if (wantsForward) {
      this.reverseHold = 0;
      if (longSpeed < -switchSpeed) {
        serviceBrake = input.throttle;
      } else {
        if (this.reverse) this.setReverseState(false);
        driveThrottle = input.throttle;
      }
    } else if (wantsReverse) {
      if (longSpeed > switchSpeed) {
        this.reverseHold = 0;
        serviceBrake = input.brake;
      } else if (this.reverse) {
        driveThrottle = input.brake;
      } else {
        serviceBrake = input.brake;
        this.reverseHold += dt;
        if (this.reverseHold >= REVERSE_ENGAGE_HOLD_SECONDS) {
          this.setReverseState(true);
          serviceBrake = 0;
          driveThrottle = input.brake;
        }
      }
    } else {
      this.reverseHold = 0;
    }
    return { driveThrottle, serviceBrake };
  }

  fixedUpdate(input, controlsLocked = false, dt = FIXED_DT) {
    if (this.vehiclePhysicsMode === 'legacy') {
      return this.fixedUpdateLegacy(input, controlsLocked, dt);
    }
    if (this.vehiclePhysicsMode === 'v24-shadow') {
      const legacyResult = this.fixedUpdateLegacy(input, controlsLocked, dt);
      const legacySnapshot = {
        speedKmh: this.telemetry.speedKmh,
        signedSpeedKmh: this.telemetry.signedSpeedKmh,
        rpm: this.telemetry.rpm,
        gear: this.telemetry.gear,
        reverse: this.telemetry.reverse,
        wheels: this.telemetry.wheels.map((wheel) => ({
          grounded: wheel.grounded,
          load: wheel.load,
          slipRatio: wheel.slipRatio,
          slipAngle: wheel.slipAngle,
        })),
      };
      try {
        const shadow = this.vehicleV24.step({
          input: sanitizeInput(controlsLocked ? this.lockedInput : input),
          dt: safeUpdateDt(dt),
          applyForces: false,
          mode: 'v24-shadow',
        });
        const comparison = {
          schema: 'streetrush.vehicle-v24.shadow-comparison.v1',
          legacy: legacySnapshot,
          v24: shadow.output,
          delta: {
            speedKmh: shadow.output.speedKmh - legacySnapshot.speedKmh,
            signedSpeedKmh: shadow.output.signedSpeed * 3.6 - legacySnapshot.signedSpeedKmh,
            rpm: shadow.output.engineRpm - legacySnapshot.rpm,
            wheelLoad: shadow.output.wheels.map((wheel, index) => (
              wheel.load - legacySnapshot.wheels[index].load
            )),
          },
        };
        this.vehiclePhysicsReport = { ...shadow.report, shadowComparison: comparison };
      } catch (error) {
        if (!(error instanceof VehicleV24AbortError)) throw error;
        this.vehiclePhysicsReport = {
          ...error.audit,
          shadowComparison: { schema: 'streetrush.vehicle-v24.shadow-comparison.v1', legacy: legacySnapshot },
        };
      }
      this.telemetry.vehiclePhysics = this.vehiclePhysicsReport;
      return legacyResult;
    }
    return this.fixedUpdateV24Active(input, controlsLocked, dt);
  }

  fixedUpdateV24Active(input, controlsLocked = false, dt = FIXED_DT) {
    const safeDt = safeUpdateDt(dt);
    const activeInput = sanitizeInput(controlsLocked ? this.lockedInput : input);
    let output;
    let report;
    try {
      ({ output, report } = this.vehicleV24.step({
        input: activeInput,
        dt: safeDt,
        applyForces: true,
        mode: 'v24-active',
      }));
    } catch (error) {
      if (error instanceof VehicleV24AbortError) {
        this.vehiclePhysicsReport = error.audit;
        this.telemetry.vehiclePhysics = error.audit;
      }
      throw error;
    }
    this.vehiclePhysicsReport = report;
    this.transmissionMode = output.transmissionMode;
    this.gear = output.gear;
    this.reverse = output.reverse;
    this.engineRpm = output.engineRpm;
    this.engineLoad = output.engineLoad;
    this.steerAngle = output.steerAngle;

    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      const source = output.wheels[index];
      const telemetry = this.telemetry.wheels[index];
      wheel.omega = output.wheelOmega[index];
      wheel.grounded = source.grounded;
      wheel.compression = source.suspension;
      wheel.springForce = source.load;
      wheel.surface = source.surface;
      wheel.contactPoint = wheel.contactPoint || new THREE.Vector3();
      wheel.contactPoint.set(source.contactPoint.x, source.contactPoint.y, source.contactPoint.z);
      telemetry.grounded = source.grounded;
      telemetry.load = source.load;
      telemetry.suspension = source.suspension;
      telemetry.slipRatio = source.slipRatio;
      telemetry.slipAngle = source.slipAngle;
      telemetry.slipPower = source.slipPower;
      telemetry.surface = source.surface;
      telemetry.contactPoint.copy(wheel.contactPoint);
    }

    this.telemetry.speedKmh = output.speedKmh;
    this.telemetry.signedSpeedKmh = output.signedSpeed * 3.6;
    this.telemetry.rpm = output.engineRpm;
  this.telemetry.gear = output.gear;
  this.telemetry.reverse = output.reverse;
  this.telemetry.driveIntent = output.driveIntent;
    this.telemetry.throttle = output.throttle;
    this.telemetry.brake = output.brake;
    this.telemetry.handbrake = output.handbrake;
    this.telemetry.steer = activeInput.steer;
    this.smoothedLongAcceleration = damp(
      this.smoothedLongAcceleration,
      (output.signedSpeed - this.previousLongSpeed) / safeDt,
      5,
      safeDt,
    );
    this.telemetry.longitudinalAcceleration = this.smoothedLongAcceleration;
    const angularVelocity = this.body.angvel();
    this.telemetry.lateralAcceleration = output.signedSpeed * angularVelocity.y;
    this.telemetry.surface = output.surface;
    this.telemetry.absActive = output.absActive;
    this.telemetry.tcsActive = output.tcsActive;
    this.telemetry.stabilityActive = output.stabilityActive;
    Object.assign(this.telemetry.powertrain, output.powertrain);
    this.telemetry.vehiclePhysics = report;
    this.previousLongSpeed = output.signedSpeed;
    this.advanceVisualWheelAngles(safeDt);

    const translation = this.body.translation();
    const rotation = this.body.rotation();
    this.tmp.position.set(translation.x, translation.y, translation.z);
    const trackInfo = this.track.nearestInfo(this.tmp.position, this.trackHint);
    this.trackHint = trackInfo.index;
    if (output.groundedCount >= 3
      && Math.abs(trackInfo.offset) < this.track.config.width * 0.5
      && Math.abs(rotation.x) < 0.42
      && Math.abs(rotation.z) < 0.42) {
      this.safeSample = trackInfo.index;
    }
    const nearlyStoppedWithInput = output.speedKmh < 1.2 && output.throttle > 0.5;
    this.stuckTimer = nearlyStoppedWithInput ? this.stuckTimer + safeDt : 0;
    const resetReason = this.tmp.position.y < -4
      ? 'fell-below-world'
      : Math.abs(rotation.x) > 0.78 || Math.abs(rotation.z) > 0.78
        ? 'vehicle-overturned'
        : this.stuckTimer > 8
          ? 'vehicle-stuck'
          : null;
    if (resetReason) {
      this.reset(this.safeSample);
      this.onAutomaticReset?.(resetReason);
    }
  }

  getVehiclePhysicsReport() {
    return this.vehiclePhysicsReport;
  }

  fixedUpdateLegacy(input, controlsLocked = false, dt = FIXED_DT) {
    const safeDt = safeUpdateDt(dt);
    const activeInput = sanitizeInput(controlsLocked ? this.lockedInput : input);
    if (!Number.isFinite(this.steerAngle)) this.steerAngle = 0;
    else this.steerAngle = clamp(this.steerAngle, -this.config.steer, this.config.steer);
    if (!Number.isFinite(this.engineLoad)) this.engineLoad = 0;
    else this.engineLoad = clamp(this.engineLoad, 0, 1);
    if (!Number.isFinite(this.engineRpm)) this.engineRpm = this.config.idle;
    if (!Number.isFinite(this.reverseHold) || this.reverseHold < 0) this.reverseHold = 0;
    if (!Number.isFinite(this.shiftTimer) || this.shiftTimer < 0) this.shiftTimer = 0;
    if (!Number.isFinite(this.previousLongSpeed)) this.previousLongSpeed = 0;
    if (!Number.isFinite(this.smoothedLongAcceleration)) this.smoothedLongAcceleration = 0;
    if (!Number.isFinite(this.stuckTimer) || this.stuckTimer < 0) this.stuckTimer = 0;
    if (!Number.isInteger(this.gear) || this.gear < 1 || this.gear > this.config.gears.length) this.gear = 1;
    this.reverse = this.reverse === true;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      if (!Number.isFinite(wheel.omega)) wheel.omega = 0;
      const wheelTelemetry = this.telemetry.wheels[index];
      if (!hasFiniteVector(wheelTelemetry.contactPoint)) wheelTelemetry.contactPoint.set(0, 0, 0);
    }
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const t = this.body.translation();
    const r = this.body.rotation();
    const linvel = this.body.linvel();
    const angularVelocity = this.body.angvel();
    if (!hasFiniteBodyState(t, r, linvel, angularVelocity)) {
      this.reset(this.safeSample);
      return;
    }
    const tmp = this.tmp;
    tmp.position.set(t.x, t.y, t.z);
    tmp.quaternion.set(r.x, r.y, r.z, r.w);
    tmp.forward.set(0, 0, 1).applyQuaternion(tmp.quaternion);
    tmp.forward.y = 0;
    tmp.forward.normalize();
    tmp.right.set(1, 0, 0).applyQuaternion(tmp.quaternion);
    tmp.right.y = 0;
    tmp.right.normalize();
    tmp.up.set(0, 1, 0).applyQuaternion(tmp.quaternion).normalize();
    tmp.down.set(0, -1, 0);
    // Keep the center-of-mass velocity separate. tmp.velocity is reused below
    // for contact-point velocities and must never become the aerodynamic input.
    tmp.bodyVelocity.set(linvel.x, linvel.y, linvel.z);
    if (!Number.isFinite(tmp.bodyVelocity.lengthSq())) {
      this.reset(this.safeSample);
      return;
    }
    const longSpeed = tmp.bodyVelocity.dot(tmp.forward);
    const lateralSpeed = tmp.bodyVelocity.dot(tmp.right);
    const speedKmh = Math.abs(longSpeed) * 3.6;
    const pedals = this.updateTransmission(activeInput, safeDt, longSpeed);
    this.steerAngle = damp(this.steerAngle, activeInput.steer * this.config.steer * THREE.MathUtils.lerp(1, 0.28, clamp(speedKmh / 190, 0, 1)), 9, safeDt);
    this.shiftTimer = Math.max(0, this.shiftTimer - safeDt);

    const ratio = this.reverse ? 3.25 : this.config.gears[this.gear - 1];
    const drivenWheels = this.drivenWheels;
    // The road speed determines driveline RPM. Reading it from simulated wheel
    // spin made every launch or kerb strike look like an impossible gear change.
    const roadWheelRpmValue = roadWheelRpm(longSpeed, this.config.wheelRadius);
    const coupledRpm = roadWheelRpmValue * ratio * this.config.finalDrive;
    const freeRpm = this.config.idle + pedals.driveThrottle * (this.config.redline - this.config.idle) * 0.38;
    const clutchDemand = clamp(0.18 + speedKmh / 11 + pedals.driveThrottle * 0.32, 0.18, 1);
    let clutchCoupling = clutchDemand;
    if (!this.reverse && this.transmissionMode === 'AT' && this.gear === 1 && pedals.driveThrottle > 0) {
      // The automatic clutch may carry torque while it is still slipping, but
      // it must not kinematically lock before road speed can sustain launch RPM.
      const launchRpm = this.config.idle
        + pedals.driveThrottle * (this.config.redline - this.config.idle) * 0.24;
      if (coupledRpm < launchRpm) {
        const launchClutchLimit = (freeRpm - launchRpm) / Math.max(1, freeRpm - coupledRpm);
        clutchCoupling = Math.min(clutchDemand, clamp(launchClutchLimit, 0.18, 1));
      }
    }
    const targetRpm = Math.max(this.config.idle, THREE.MathUtils.lerp(freeRpm, coupledRpm, clutchCoupling));
    this.engineRpm = damp(this.engineRpm, targetRpm, this.shiftTimer > 0 ? 5 : 13, safeDt);
    if (!this.reverse && this.transmissionMode === 'AT' && this.shiftTimer <= 0) {
      const throttleDemand = pedals.driveThrottle;
      const upshiftRpm = this.config.redline * THREE.MathUtils.lerp(0.68, 0.91, throttleDemand);
      const downshiftRpm = this.config.redline * THREE.MathUtils.lerp(0.31, 0.43, throttleDemand);
      const lowerRatio = this.config.gears[Math.max(0, this.gear - 2)];
      const lowerGearRpm = roadWheelRpmValue * lowerRatio * this.config.finalDrive;
      if (speedKmh < 5 && this.gear > 1) this.requestShift(1 - this.gear);
      else if (this.engineRpm > upshiftRpm && this.gear < this.config.gears.length) this.requestShift(1);
      else if (this.gear > 1 && this.engineRpm < downshiftRpm && lowerGearRpm < this.config.redline * 0.92) this.requestShift(-1);
    }
    const engineTorque = this.config.torque * this.torqueCurve(this.engineRpm) * pedals.driveThrottle;
    const efficiency = drivetrainEfficiency(this.config.drivetrain);
    let totalDriveTorque = engineTorque * ratio * this.config.finalDrive * efficiency * clutchDemand;
    if (this.reverse) {
      totalDriveTorque *= -0.72;
      if (speedKmh > 38) totalDriveTorque *= clamp((43 - speedKmh) / 5, 0, 1);
    }
    if (this.shiftTimer > 0) totalDriveTorque *= SHIFT_TORQUE_FACTOR;
    const driveTorquePerWheel = totalDriveTorque / Math.max(1, drivenWheels.length);
    const driveTorqueRequestedNm = Math.abs(totalDriveTorque);
    const serviceBrakeTorqueRequestedNm = pedals.serviceBrake * this.config.brakeTorque;
    const handbrakeTorqueRequestedNm = activeInput.handbrake
      * this.config.brakeTorque
      * HANDBRAKE_REAR_TORQUE_FACTOR
      * 2;

    const suspension = this.config.suspension;
    const maxRay = suspension.restLength + suspension.travel + this.config.wheelRadius;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      tmp.origin.copy(wheel.anchor).applyQuaternion(tmp.quaternion).add(tmp.position);
      const ray = new this.RAPIER.Ray(tmp.origin, tmp.down);
      const hit = this.world.castRayAndGetNormal(ray, maxRay, false, undefined, undefined, undefined, this.body);
      wheel.hit = hit;
      wheel.grounded = Boolean(hit);
      wheel.compression = 0;
      wheel.springForce = 0;
      if (!hit) continue;
      const suspensionLength = hit.timeOfImpact - this.config.wheelRadius;
      wheel.compression = clamp(suspension.restLength - suspensionLength, 0, suspension.travel);
      tmp.point.copy(tmp.origin).addScaledVector(tmp.down, hit.timeOfImpact);
      const pointVelocity = this.body.velocityAtPoint(tmp.point);
      const compressionVelocity = -pointVelocity.y;
      const damper = compressionVelocity >= 0 ? suspension.damperBump : suspension.damperRebound;
      const rawSpringForce = wheel.compression * suspension.springRate + compressionVelocity * damper;
      const maximumWheelLoad = this.config.mass * GRAVITY * 0.72;
      wheel.springForce = clamp(rawSpringForce, 0, maximumWheelLoad);
      wheel.contactPoint = wheel.contactPoint || new THREE.Vector3();
      wheel.contactPoint.copy(tmp.point);
      wheel.surface = this.track.getSurface(tmp.point, this.trackHint).id;
    }

    for (const [leftIndex, rightIndex] of [[0, 1], [2, 3]]) {
      const left = this.wheels[leftIndex];
      const right = this.wheels[rightIndex];
      if (!left.grounded || !right.grounded) continue;
      const antiRoll = (left.compression - right.compression) * suspension.antiRoll;
      const maximumWheelLoad = this.config.mass * GRAVITY * 0.72;
      left.springForce = clamp(left.springForce + antiRoll, 0, maximumWheelLoad);
      right.springForce = clamp(right.springForce - antiRoll, 0, maximumWheelLoad);
    }

    let absActive = false;
    let tcsActive = false;
    let driveTorqueAppliedNm = 0;
    let serviceBrakeTorqueAppliedNm = 0;
    let handbrakeTorqueAppliedNm = 0;
    let groundedCount = 0;
    let supportedLoad = 0;
    let gripWeightedLoad = 0;
    let averageSurface = 'asphalt';
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      const telemetry = this.telemetry.wheels[index];
      telemetry.grounded = wheel.grounded;
      telemetry.load = 0;
      telemetry.suspension = wheel.compression;
      telemetry.slipRatio = 0;
      telemetry.slipAngle = 0;
      telemetry.slipPower = 0;
      if (!wheel.grounded) {
        wheel.omega *= 0.998;
        continue;
      }
      groundedCount += 1;
      averageSurface = wheel.surface;
      const normal = wheel.springForce;
      telemetry.load = normal;
      telemetry.surface = wheel.surface;
      telemetry.contactPoint.copy(wheel.contactPoint);
      tmp.force.set(0, normal, 0);
      this.body.addForceAtPoint(tmp.force, wheel.contactPoint, true);

      tmp.wheelForward.copy(tmp.forward);
      if (wheel.front) tmp.wheelForward.applyAxisAngle(tmp.worldUp, this.steerAngle);
      tmp.wheelRight.crossVectors(tmp.worldUp, tmp.wheelForward).normalize();
      const pointVelocity = this.body.velocityAtPoint(wheel.contactPoint);
      tmp.velocity.set(pointVelocity.x, pointVelocity.y, pointVelocity.z);
      const wheelLongSpeed = tmp.velocity.dot(tmp.wheelForward);
      const wheelLateralSpeed = tmp.velocity.dot(tmp.wheelRight);
      const slipRatio = (wheel.omega * this.config.wheelRadius - wheelLongSpeed) / Math.max(3.5, Math.abs(wheelLongSpeed));
      const slipAngle = Math.atan2(wheelLateralSpeed, Math.max(2.2, Math.abs(wheelLongSpeed)));
      const surface = SURFACES[wheel.surface];
      supportedLoad += normal;
      gripWeightedLoad += normal * surface.grip;
      const muLoad = normal * this.config.tire.mu * surface.grip;
      let longitudinalForce = Math.tanh(slipRatio * this.config.tire.longStiffness) * muLoad;
      let lateralForce = -Math.tanh(slipAngle * this.config.tire.lateralStiffness) * muLoad;
      const magnitude = Math.hypot(longitudinalForce, lateralForce);
      if (magnitude > muLoad && magnitude > 0) {
        const scale = muLoad / magnitude;
        longitudinalForce *= scale;
        lateralForce *= scale;
      }
      const rolling = Math.abs(wheelLongSpeed) > 0.25
        ? -Math.sign(wheelLongSpeed) * normal * this.config.tire.rollingResistance * surface.rolling
        : 0;
      longitudinalForce += rolling;
      tmp.force.copy(tmp.wheelForward).multiplyScalar(longitudinalForce).addScaledVector(tmp.wheelRight, lateralForce);
      this.body.addForceAtPoint(tmp.force, wheel.contactPoint, true);

      let wheelDriveTorque = wheel.driven ? driveTorquePerWheel : 0;
      const drivenSlip = slipRatio * Math.sign(wheelDriveTorque);
      if (pedals.driveThrottle > 0.05 && drivenSlip > 0.11) {
        wheelDriveTorque *= clamp(0.11 / drivenSlip, 0.16, 1);
        tcsActive = true;
      }
      if (wheel.driven) driveTorqueAppliedNm += Math.abs(wheelDriveTorque);
      let serviceBrakeTorque = pedals.serviceBrake
        * this.config.brakeTorque
        * (wheel.front ? 0.31 : 0.19);
      const travelDirection = Math.sign(Math.abs(wheelLongSpeed) > 0.05 ? wheelLongSpeed : longSpeed);
      const brakingSlip = slipRatio * travelDirection;
      if (serviceBrakeTorque > 0 && brakingSlip < -0.17) {
        serviceBrakeTorque *= clamp(0.17 / Math.abs(brakingSlip), 0.2, 1);
        absActive = true;
      }
      const handbrakeTorque = wheel.front
        ? 0
        : activeInput.handbrake * this.config.brakeTorque * HANDBRAKE_REAR_TORQUE_FACTOR;
      serviceBrakeTorqueAppliedNm += serviceBrakeTorque;
      handbrakeTorqueAppliedNm += handbrakeTorque;
      const brakeCapacity = serviceBrakeTorque + handbrakeTorque;
      const nonBrakeTorque = wheelDriveTorque - longitudinalForce * this.config.wheelRadius;
      // Keep an already locked contact constrained until an applied drive torque
      // actually exceeds the finite brake capacity. Treating the explicit tire
      // reaction as breakaway torque here reintroduces the known low-speed
      // omega/slip sign oscillation; that integration issue is tracked separately.
      const brakeHoldsStoppedWheel = wheel.omega === 0
        && brakeCapacity > 0
        && Math.abs(wheelDriveTorque) <= brakeCapacity;
      wheel.omega = brakeHoldsStoppedWheel
        ? 0
        : integrateWheelOmegaWithBrakeCapacity(
          wheel.omega,
          nonBrakeTorque,
          brakeCapacity,
          this.wheelInertia,
          safeDt,
        );
      wheel.omega = clamp(wheel.omega, -420, 420);
      telemetry.slipRatio = slipRatio;
      telemetry.slipAngle = slipAngle;
      telemetry.slipPower = (Math.abs(longitudinalForce * (wheel.omega * this.config.wheelRadius - wheelLongSpeed)) + Math.abs(lateralForce * wheelLateralSpeed)) / 10000;
    }
    const dragScale = aerodynamicDragScale(this.config.cdA, tmp.bodyVelocity.lengthSq());
    if (dragScale !== 0) {
      tmp.force.copy(tmp.bodyVelocity).multiplyScalar(dragScale);
      this.body.addForce(tmp.force, true);
    }
    const kinematicYawRate = longSpeed / Math.max(2, this.config.wheelbase) * Math.tan(this.steerAngle);
    const supportedGrip = supportedLoad > 1 ? gripWeightedLoad / supportedLoad : 0;
    const targetYawRate = frictionLimitedYawRate(
      kinematicYawRate,
      longSpeed,
      this.config.tire.mu,
      supportedGrip,
    );
    const stabilityError = targetYawRate - angularVelocity.y;
    const stabilityActive = groundedCount >= 2
      && Math.abs(stabilityError) > 0.16
      && speedKmh > 14
      && activeInput.handbrake <= HANDBRAKE_ACTIVE_THRESHOLD;
    if (stabilityActive) {
      const correctionLimit = this.config.mass * 8 * supportedGrip;
      const correctionTorque = clamp(
        stabilityError * this.config.mass * this.config.wheelbase * 1.65,
        -correctionLimit,
        correctionLimit,
      );
      this.body.addTorque({ x: 0, y: correctionTorque, z: 0 }, true);
    }

    this.engineLoad = damp(this.engineLoad, pedals.driveThrottle, 7, safeDt);
    this.telemetry.speedKmh = Math.abs(longSpeed) * 3.6;
    this.telemetry.signedSpeedKmh = longSpeed * 3.6;
    this.telemetry.rpm = this.engineRpm;
    this.telemetry.gear = this.gear;
    this.telemetry.reverse = this.reverse;
    this.telemetry.throttle = pedals.driveThrottle;
    this.telemetry.brake = pedals.serviceBrake;
    this.telemetry.handbrake = activeInput.handbrake;
    this.telemetry.steer = activeInput.steer;
    this.smoothedLongAcceleration = damp(this.smoothedLongAcceleration, (longSpeed - this.previousLongSpeed) / safeDt, 5, safeDt);
    this.telemetry.longitudinalAcceleration = this.smoothedLongAcceleration;
    this.telemetry.lateralAcceleration = longSpeed * angularVelocity.y;
    this.telemetry.surface = averageSurface;
    this.telemetry.absActive = absActive;
    this.telemetry.tcsActive = tcsActive;
    this.telemetry.stabilityActive = stabilityActive;
    this.telemetry.powertrain.driveTorqueRequestedNm = driveTorqueRequestedNm;
    this.telemetry.powertrain.driveTorqueAppliedNm = driveTorqueAppliedNm;
    this.telemetry.powertrain.serviceBrakeTorqueRequestedNm = serviceBrakeTorqueRequestedNm;
    this.telemetry.powertrain.serviceBrakeTorqueAppliedNm = serviceBrakeTorqueAppliedNm;
    this.telemetry.powertrain.handbrakeTorqueRequestedNm = handbrakeTorqueRequestedNm;
    this.telemetry.powertrain.handbrakeTorqueAppliedNm = handbrakeTorqueAppliedNm;
    this.previousLongSpeed = longSpeed;

    const telemetryFinite = [
      this.engineRpm,
      this.engineLoad,
      this.telemetry.speedKmh,
      this.telemetry.signedSpeedKmh,
      this.telemetry.rpm,
      this.telemetry.throttle,
      this.telemetry.brake,
      this.telemetry.handbrake,
      this.telemetry.steer,
      this.telemetry.longitudinalAcceleration,
      this.telemetry.lateralAcceleration,
      ...Object.values(this.telemetry.powertrain),
    ].every(Number.isFinite)
      && this.telemetry.wheels.every((wheelTelemetry) => [
        wheelTelemetry.load,
        wheelTelemetry.suspension,
        wheelTelemetry.slipRatio,
        wheelTelemetry.slipAngle,
        wheelTelemetry.slipPower,
      ].every(Number.isFinite) && hasFiniteVector(wheelTelemetry.contactPoint));
    if (!telemetryFinite) {
      this.reset(this.safeSample);
      return;
    }
    this.advanceVisualWheelAngles(safeDt);

    const trackInfo = this.track.nearestInfo(tmp.position, this.trackHint);
    this.trackHint = trackInfo.index;
    if (groundedCount >= 3 && Math.abs(trackInfo.offset) < this.track.config.width * 0.5 && Math.abs(r.x) < 0.42 && Math.abs(r.z) < 0.42) {
      this.safeSample = trackInfo.index;
    }
    const nearlyStoppedWithInput = this.telemetry.speedKmh < 1.2 && pedals.driveThrottle > 0.5;
    this.stuckTimer = nearlyStoppedWithInput ? this.stuckTimer + safeDt : 0;
    const resetReason = tmp.position.y < -4
      ? 'fell-below-world'
      : Math.abs(r.x) > 0.78 || Math.abs(r.z) > 0.78
        ? 'vehicle-overturned'
        : this.stuckTimer > 8
          ? 'vehicle-stuck'
          : null;
    if (resetReason) {
      this.reset(this.safeSample);
      this.onAutomaticReset?.(resetReason);
    }
  }

  afterPhysics() {
    this.previousPose.position.copy(this.currentPose.position);
    this.previousPose.rotation.copy(this.currentPose.rotation);
    const translation = this.body.translation();
    const rotation = this.body.rotation();
    this.currentPose.position.set(translation.x, translation.y, translation.z);
    this.currentPose.rotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
  }

  syncVisual(alpha = 1) {
    this.visual.position.lerpVectors(this.previousPose.position, this.currentPose.position, alpha);
    this.visual.quaternion.slerpQuaternions(this.previousPose.rotation, this.currentPose.rotation, alpha);
    for (let index = 0; index < this.visualWheelBindings.length; index += 1) {
      const binding = this.visualWheelBindings[index];
      const wheel = this.wheels[index];
      binding.steer.position.y = binding.baseY + wheel.compression;
      binding.steer.rotation.y = wheel.front ? this.steerAngle : 0;
      binding.roll.rotation.x = THREE.MathUtils.lerp(wheel.previousVisualAngle, wheel.visualAngle, alpha);
    }
  }

  destroy() {
    this.vehicleV24?.dispose();
    this.scene.remove(this.visual);
    this.world.removeRigidBody(this.body);
    disposeOwnedVisual(this.visual);
  }
}
