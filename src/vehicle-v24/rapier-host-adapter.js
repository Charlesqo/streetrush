import {
  addVec3,
  addScaledVec3,
  cloneVec3,
  crossVec3,
  dotVec3,
  normalizeVec3,
  projectOnPlane,
  rotateAroundAxis,
  rotateVector,
  scaleVec3,
  spatialInverseMass,
  subVec3,
  vec3,
} from './math.js';
import { VehicleV24HostCapabilityError } from './contract.js';

function copyMatrix(matrix) {
  if (!matrix) return null;
  return {
    m11: matrix.m11, m12: matrix.m12, m13: matrix.m13,
    m21: matrix.m21, m22: matrix.m22, m23: matrix.m23,
    m31: matrix.m31, m32: matrix.m32, m33: matrix.m33,
  };
}

function sampleRigidBody(body) {
  if (!body) return null;
  const worldCom = body.worldCom();
  const linvel = body.linvel();
  const angvel = body.angvel();
  return {
    body,
    dynamic: body.isDynamic(),
    kinematic: body.isKinematic(),
    mass: body.mass(),
    invMass: body.invMass(),
    worldCom: cloneVec3(worldCom),
    linvel: cloneVec3(linvel),
    angvel: cloneVec3(angvel),
    effectiveWorldInvInertia: copyMatrix(body.effectiveWorldInvInertia()),
  };
}

function pointVelocity(body, point) {
  if (!body) return vec3();
  const velocity = body.velocityAtPoint(point);
  return cloneVec3(velocity);
}

export class RapierVehicleV24HostAdapter {
  constructor({ RAPIER, world, body, track, config, wheels }) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.body = body;
    this.track = track;
    this.config = config;
    this.wheels = wheels;
    this.appliedBodies = new Set();
    this.groundReactionWrenches = new Map();
    this.counters = {
      queryCount: 0,
      bodyForceWrites: 0,
      bodyTorqueWrites: 0,
      groundReactionWrites: 0,
    };
  }

  resetCounters() {
    for (const key of Object.keys(this.counters)) this.counters[key] = 0;
  }

  resetVehicleForces() {
    this.removeGroundReactions();
    this.body.resetForces(false);
    this.body.resetTorques(false);
  }

  removeGroundReactions() {
    for (const [body, wrench] of this.groundReactionWrenches) {
      body.addForce(scaleVec3(wrench.force, -1), false);
      body.addTorque(scaleVec3(wrench.torque, -1), false);
    }
    this.groundReactionWrenches.clear();
  }

  sampleBody() {
    const translation = this.body.translation();
    const rotation = this.body.rotation();
    const sample = sampleRigidBody(this.body);
    sample.translation = cloneVec3(translation);
    sample.rotation = { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
    sample.axes = {
      forward: normalizeVec3(rotateVector(sample.rotation, vec3(0, 0, 1)), vec3(0, 0, 1)),
      right: normalizeVec3(rotateVector(sample.rotation, vec3(1, 0, 0)), vec3(1, 0, 0)),
      up: normalizeVec3(rotateVector(sample.rotation, vec3(0, 1, 0)), vec3(0, 1, 0)),
    };
    sample.axes.left = scaleVec3(sample.axes.right, -1);
    return sample;
  }

  queryWheel({ wheelIndex, streetRushSteerAngle, effectiveRadius, bodySample }) {
    const wheel = this.wheels[wheelIndex];
    const origin = addVec3(
      bodySample.translation,
      rotateVector(bodySample.rotation, wheel.anchor),
    );
    const suspensionDirection = scaleVec3(bodySample.axes.up, -1);
    const maximumDistance = this.config.suspension.restLength
      + this.config.suspension.travel + effectiveRadius;
    const ray = new this.RAPIER.Ray(origin, suspensionDirection);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maximumDistance,
      false,
      undefined,
      undefined,
      undefined,
      this.body,
    );
    this.counters.queryCount += 1;
    if (!hit) {
      return {
        wheelIndex,
        inContact: false,
        origin,
        suspensionDirection,
        rawToi: maximumDistance,
        point: addScaledVec3(origin, suspensionDirection, maximumDistance),
        normal: cloneVec3(bodySample.axes.up),
        forward: cloneVec3(bodySample.axes.forward),
        lateral: cloneVec3(bodySample.axes.left),
        bodyPointVelocity: pointVelocity(this.body, origin),
        groundVelocity: vec3(),
        relativeVelocity: pointVelocity(this.body, origin),
        velocityX: 0,
        velocityY: 0,
        compression: 0,
        compressionRate: 0,
        gap: maximumDistance - effectiveRadius - this.config.suspension.restLength,
        surface: 'asphalt',
        surfaceGrip: 1,
        groundBody: null,
        groundBodySample: null,
        collider: null,
        normalSource: 'NO_HIT',
      };
    }
    const point = addScaledVec3(origin, suspensionDirection, hit.timeOfImpact);
    let normal = normalizeVec3(hit.normal, bodySample.axes.up);
    if (dotVec3(normal, suspensionDirection) > 0) normal = scaleVec3(normal, -1);
    let forward = normalizeVec3(
      projectOnPlane(rotateAroundAxis(bodySample.axes.forward, normal, streetRushSteerAngle), normal),
      bodySample.axes.forward,
    );
    if (Math.abs(dotVec3(forward, normal)) > 1e-7) {
      forward = normalizeVec3(projectOnPlane(forward, normal), bodySample.axes.forward);
    }
    // Physical left is the negative of StreetRush's local +X/right direction.
    const lateral = scaleVec3(normalizeVec3(crossVec3(normal, forward), bodySample.axes.right), -1);
    const groundBody = hit.collider.parent();
    const groundVelocity = pointVelocity(groundBody, point);
    const bodyPointVelocity = pointVelocity(this.body, point);
    const relativeVelocity = subVec3(bodyPointVelocity, groundVelocity);
    const suspensionLength = hit.timeOfImpact - effectiveRadius;
    const compression = Math.max(0, Math.min(
      this.config.suspension.travel,
      this.config.suspension.restLength - suspensionLength,
    ));
    const surface = this.track.getSurface(point, 0)?.id ?? 'asphalt';
    return {
      wheelIndex,
      inContact: true,
      origin,
      suspensionDirection,
      rawToi: hit.timeOfImpact,
      point,
      normal,
      forward,
      lateral,
      bodyPointVelocity,
      groundVelocity,
      relativeVelocity,
      velocityX: dotVec3(relativeVelocity, forward),
      velocityY: dotVec3(relativeVelocity, lateral),
      compression,
      compressionRate: -dotVec3(relativeVelocity, normal),
      gap: Math.max(0, suspensionLength - this.config.suspension.restLength),
      surface,
      surfaceGrip: 1,
      groundBody,
      groundBodySample: sampleRigidBody(groundBody),
      collider: hit.collider,
      normalSource: 'RAPIER_RAY_HIT_NORMAL_WORLD',
    };
  }

  reframeContact(contact, streetRushSteerAngle, bodySample) {
    if (!contact.inContact) return contact;
    const forward = normalizeVec3(
      projectOnPlane(
        rotateAroundAxis(bodySample.axes.forward, contact.normal, streetRushSteerAngle),
        contact.normal,
      ),
      bodySample.axes.forward,
    );
    const lateral = scaleVec3(
      normalizeVec3(crossVec3(contact.normal, forward), bodySample.axes.right),
      -1,
    );
    return {
      ...contact,
      forward,
      lateral,
      velocityX: dotVec3(contact.relativeVelocity, forward),
      velocityY: dotVec3(contact.relativeVelocity, lateral),
    };
  }

  contactDelassus(contact, effectiveRadius, wheelInertia) {
    if (!contact.inContact) {
      throw new VehicleV24HostCapabilityError(
        'contact Delassus requested for an airborne wheel',
        'RAPIER_CONTACT_RESPONSE',
      );
    }
    const vehicleSample = sampleRigidBody(this.body);
    const response = (directionA, directionB) => (
      spatialInverseMass(vehicleSample, contact.point, directionA, directionB)
      + spatialInverseMass(contact.groundBodySample, contact.point, directionA, directionB)
    );
    const xx = response(contact.forward, contact.forward) + effectiveRadius ** 2 / wheelInertia;
    const yy = response(contact.lateral, contact.lateral);
    const xyA = response(contact.forward, contact.lateral);
    const xyB = response(contact.lateral, contact.forward);
    const xy = 0.5 * (xyA + xyB);
    if (![xx, yy, xy].every(Number.isFinite) || xx <= 0 || yy <= 0) {
      throw new VehicleV24HostCapabilityError(
        'Rapier returned an invalid contact response operator',
        'RAPIER_CONTACT_RESPONSE',
        { xx, yy, xy },
      );
    }
    return [[xx, xy], [xy, yy]];
  }

  applyWrenchBatch(batch) {
    this.removeGroundReactions();
    this.appliedBodies.clear();
    const actionReaction = [];
    for (const contact of batch.contacts) {
      this.body.addForceAtPoint(contact.forceWorld, contact.point, true);
      this.counters.bodyForceWrites += 1;
      this.appliedBodies.add(this.body);
      if (contact.momentWorld) {
        this.body.addTorque(contact.momentWorld, true);
        this.counters.bodyTorqueWrites += 1;
      }
      const reactionForce = scaleVec3(contact.forceWorld, -1);
      const reactionMoment = contact.momentWorld ? scaleVec3(contact.momentWorld, -1) : vec3();
      if (contact.groundBody?.isDynamic()) {
        const forceBefore = cloneVec3(contact.groundBody.userForce());
        const torqueBefore = cloneVec3(contact.groundBody.userTorque());
        contact.groundBody.addForceAtPoint(reactionForce, contact.point, true);
        if (contact.momentWorld) contact.groundBody.addTorque(reactionMoment, true);
        const incrementalForce = subVec3(contact.groundBody.userForce(), forceBefore);
        const incrementalTorque = subVec3(contact.groundBody.userTorque(), torqueBefore);
        const previous = this.groundReactionWrenches.get(contact.groundBody) ?? {
          force: vec3(),
          torque: vec3(),
        };
        this.groundReactionWrenches.set(contact.groundBody, {
          force: addVec3(previous.force, incrementalForce),
          torque: addVec3(previous.torque, incrementalTorque),
        });
        this.counters.groundReactionWrites += 1;
      }
      actionReaction.push({
        wheelIndex: contact.wheelIndex,
        vehicleForce: cloneVec3(contact.forceWorld),
        groundForce: reactionForce,
        vehicleMoment: contact.momentWorld ? cloneVec3(contact.momentWorld) : vec3(),
        groundMoment: reactionMoment,
        groundBodyType: contact.groundBody
          ? contact.groundBody.isDynamic()
            ? 'DYNAMIC'
            : contact.groundBody.isKinematic()
              ? 'KINEMATIC'
              : 'FIXED'
          : 'FIXED',
      });
    }
    if (batch.bodyForce) {
      this.body.addForce(batch.bodyForce, true);
      this.counters.bodyForceWrites += 1;
    }
    if (batch.bodyTorque) {
      this.body.addTorque(batch.bodyTorque, true);
      this.counters.bodyTorqueWrites += 1;
    }
    return actionReaction;
  }

  rollbackAppliedBatch() {
    for (const body of this.appliedBodies) {
      body.resetForces(false);
      body.resetTorques(false);
    }
    this.removeGroundReactions();
    this.appliedBodies.clear();
  }

  dispose() {
    this.removeGroundReactions();
    this.appliedBodies.clear();
  }
}

export function contactForceWorld(contact, tireOutput, normalLoad) {
  return addVec3(
    addVec3(
      scaleVec3(contact.forward, tireOutput.forceX),
      scaleVec3(contact.lateral, tireOutput.forceY),
    ),
    scaleVec3(contact.normal, normalLoad),
  );
}

export function contactMomentWorld(contact, tireOutput) {
  return scaleVec3(addVec3(
    addVec3(
      scaleVec3(contact.forward, tireOutput.momentX),
      scaleVec3(contact.lateral, tireOutput.momentY),
    ),
    scaleVec3(contact.normal, tireOutput.momentZ),
  ), -1);
}
