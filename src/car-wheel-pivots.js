import * as THREE from 'three';

const WHEEL_ORDER = Object.freeze(['FL', 'FR', 'RL', 'RR']);
const PART_ROLES = Object.freeze(['rim', 'tire', 'brake-disc-like']);
const SPLIT_BRANCH_ROLES = Object.freeze(['tire-root', 'rim-root']);
const SPLIT_SPIN_ROLES = Object.freeze(['brake-chrome', 'brake-disc', 'brake-detail']);
const SPLIT_CARRIER_ROLES = Object.freeze(['caliper']);

function fail(vehicleId, message) {
  throw new Error(`${vehicleId || '<unknown-vehicle>'}: ${message}`);
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireUniqueObject(root, name, vehicleId, label) {
  if (typeof name !== 'string' || name.length === 0) fail(vehicleId, `${label} runtimeName is missing`);
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  if (matches.length !== 1) fail(vehicleId, `${label} runtimeName ${name} matched ${matches.length} objects`);
  return matches[0];
}

function isDescendantOf(object, ancestor) {
  for (let current = object; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

export function measureMeshWorldVertexCentroid(mesh, target = new THREE.Vector3()) {
  const position = mesh?.geometry?.attributes?.position;
  if (!mesh?.isMesh || !position || position.count === 0) {
    throw new Error(`${mesh?.name || '<unnamed-mesh>'}: missing non-empty POSITION geometry`);
  }
  mesh.updateWorldMatrix(true, false);
  const point = new THREE.Vector3();
  target.set(0, 0, 0);
  for (let index = 0; index < position.count; index += 1) {
    target.add(point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
  }
  return target.multiplyScalar(1 / position.count);
}

function validateManifestContract(manifest) {
  const vehicleId = manifest?.vehicleId;
  if (![1, 2].includes(manifest?.schemaVersion)) fail(vehicleId, `unsupported wheel manifest schema ${manifest?.schemaVersion}`);
  if (!sameArray(manifest.wheelOrder, WHEEL_ORDER)) fail(vehicleId, 'wheelOrder must be FL/FR/RL/RR');
  if (!sameArray(manifest.coordinates?.runtimeSteerAxis, [0, 1, 0])) fail(vehicleId, 'runtime steer axis must be +Y');
  if (!sameArray(manifest.coordinates?.runtimeRollAxis, [1, 0, 0])) fail(vehicleId, 'runtime roll axis must be +X');
  if (!Array.isArray(manifest.wheels) || manifest.wheels.length !== WHEEL_ORDER.length) fail(vehicleId, 'wheel manifest must contain four wheels');
  if (!sameArray(manifest.wheels.map(({ id }) => id), WHEEL_ORDER)) fail(vehicleId, 'wheel entries must follow FL/FR/RL/RR');
  return vehicleId;
}

function collectBindings(host, model, manifest) {
  const vehicleId = validateManifestContract(manifest);
  if (!host?.isObject3D || !model?.isObject3D) fail(vehicleId, 'host and model must be Three Object3D instances');
  if (host === model || !isDescendantOf(model, host)) fail(vehicleId, 'normalized model must be a descendant of its unscaled vehicle host');
  if (host.getObjectByName('calibrated-wheels')) fail(vehicleId, 'vehicle host already has calibrated-wheels');
  if (Math.max(Math.abs(host.scale.x - 1), Math.abs(host.scale.y - 1), Math.abs(host.scale.z - 1)) > 1e-9) {
    fail(vehicleId, 'vehicle host scale must remain unit so suspension offsets stay in metres');
  }
  host.updateMatrixWorld(true);
  const claimedObjects = new Set();
  return manifest.wheels.map((wheel) => {
    if (manifest.schemaVersion === 2) {
      if (!sameArray(wheel.spinBranches?.map(({ role }) => role), SPLIT_BRANCH_ROLES)) {
        fail(vehicleId, `${wheel.id} spinBranches must be tire-root/rim-root`);
      }
      if (!sameArray(wheel.spinParts?.map(({ role }) => role), SPLIT_SPIN_ROLES)) {
        fail(vehicleId, `${wheel.id} spinParts must be brake-chrome/brake-disc/brake-detail`);
      }
      if (!sameArray(wheel.carrierParts?.map(({ role }) => role), SPLIT_CARRIER_ROLES)) {
        fail(vehicleId, `${wheel.id} carrierParts must contain only caliper`);
      }
      const collectPart = (part) => {
        const object = requireUniqueObject(model, part.runtimeName, vehicleId, `${wheel.id} ${part.role}`);
        if (!object.isMesh || !isDescendantOf(object, model)) {
          fail(vehicleId, `${wheel.id} ${part.role} must be a mesh inside the normalized model`);
        }
        if (part.sourceParentRuntimeName && object.parent?.name !== part.sourceParentRuntimeName) {
          fail(vehicleId, `${wheel.id} ${part.role} parent must be ${part.sourceParentRuntimeName}`);
        }
        if (claimedObjects.has(object)) fail(vehicleId, `${wheel.id} ${part.role} is claimed more than once`);
        claimedObjects.add(object);
        return { ...part, object };
      };
      const spinBranches = wheel.spinBranches.map((branch) => {
        const object = requireUniqueObject(model, branch.runtimeName, vehicleId, `${wheel.id} ${branch.role}`);
        if (!isDescendantOf(object, model) || object === model) {
          fail(vehicleId, `${wheel.id} ${branch.role} must be an object inside the normalized model`);
        }
        if (branch.sourceParentRuntimeName && object.parent?.name !== branch.sourceParentRuntimeName) {
          fail(vehicleId, `${wheel.id} ${branch.role} parent must be ${branch.sourceParentRuntimeName}`);
        }
        if (claimedObjects.has(object)) fail(vehicleId, `${wheel.id} ${branch.role} is claimed more than once`);
        claimedObjects.add(object);
        const geometryObjects = branch.geometryRuntimeNames.map((name) => {
          const geometry = requireUniqueObject(object, name, vehicleId, `${wheel.id} ${branch.role} geometry`);
          if (!geometry.isMesh || geometry === object || !isDescendantOf(geometry, object)) {
            fail(vehicleId, `${wheel.id} ${branch.role} geometry ${name} must be a descendant mesh`);
          }
          return geometry;
        });
        return { ...branch, object, geometryObjects };
      });
      const spinParts = wheel.spinParts.map(collectPart);
      const carrierParts = wheel.carrierParts.map(collectPart);
      const ownedObjects = [...spinBranches, ...spinParts, ...carrierParts];
      for (const owner of ownedObjects) {
        for (const candidate of ownedObjects) {
          if (owner !== candidate && isDescendantOf(candidate.object, owner.object)) {
            fail(vehicleId, `${wheel.id} ${owner.role}/${candidate.role} ownership overlaps`);
          }
        }
      }
      const tireBranch = spinBranches.find(({ role }) => role === wheel.pivot?.branchRole);
      const tireGeometry = tireBranch?.geometryObjects.find(({ name }) => name === wheel.pivot?.geometryRuntimeName);
      if (!tireGeometry || wheel.pivot?.method !== 'position-vertex-centroid-world') {
        fail(vehicleId, `${wheel.id} pivot must use the tire POSITION vertex centroid`);
      }
      const centerWorld = measureMeshWorldVertexCentroid(tireGeometry);
      const centerHost = host.worldToLocal(centerWorld.clone());
      if (![centerHost.x, centerHost.y, centerHost.z].every(Number.isFinite)) fail(vehicleId, `${wheel.id} pivot centroid is not finite`);
      return {
        wheel,
        spinBranches,
        spinParts,
        spinObjects: [...spinBranches, ...spinParts],
        carrierParts,
        centerWorld,
        centerHost,
      };
    }
    const root = requireUniqueObject(model, wheel.root?.runtimeName, vehicleId, `${wheel.id} root`);
    if (root === model || !isDescendantOf(root, model)) fail(vehicleId, `${wheel.id} root is outside the normalized model`);
    const roles = wheel.parts?.map(({ role }) => role);
    if (!sameArray(roles, PART_ROLES)) fail(vehicleId, `${wheel.id} parts must be rim/tire/brake-disc-like`);
    const parts = wheel.parts.map((part) => {
      const object = requireUniqueObject(root, part.runtimeName, vehicleId, `${wheel.id} ${part.role}`);
      if (!object.isMesh || object.parent !== root) fail(vehicleId, `${wheel.id} ${part.role} must be a direct mesh child of its wheel root`);
      return { ...part, object };
    });
    const tire = parts.find(({ role }) => role === wheel.pivot?.partRole);
    if (!tire || wheel.pivot?.method !== 'position-vertex-centroid-world') {
      fail(vehicleId, `${wheel.id} pivot must use the tire POSITION vertex centroid`);
    }
    const centerWorld = measureMeshWorldVertexCentroid(tire.object);
    const centerHost = host.worldToLocal(centerWorld.clone());
    if (![centerHost.x, centerHost.y, centerHost.z].every(Number.isFinite)) fail(vehicleId, `${wheel.id} pivot centroid is not finite`);
    return { wheel, root, parts, centerWorld, centerHost };
  });
}

function reparentPreservingWorldMatrix(object, parent) {
  object.updateWorldMatrix(true, false);
  parent.updateWorldMatrix(true, false);
  const localMatrix = parent.matrixWorld.clone().invert().multiply(object.matrixWorld);
  parent.add(object);
  object.matrixAutoUpdate = false;
  object.matrix.copy(localMatrix);
  object.matrixWorldNeedsUpdate = true;
}

export function bindManifestVisualWheels(host, model, manifest) {
  const vehicleId = manifest?.vehicleId;
  const bindings = collectBindings(host, model, manifest);
  const container = new THREE.Group();
  container.name = 'calibrated-wheels';
  container.userData.visualWheelBindingVersion = 1;
  container.userData.visualWheelOrder = [...WHEEL_ORDER];
  container.userData.visualWheelSource = `manifest:${vehicleId}`;
  container.userData.dynamicCarPart = { version: 1, id: `${vehicleId}-wheel-set` };
  host.add(container);
  host.updateMatrixWorld(true);
  for (const binding of bindings) {
    const { wheel, root, centerHost } = binding;
    const steer = new THREE.Group();
    steer.name = `visual-wheel-${wheel.id}-steer`;
    steer.position.copy(centerHost);
    steer.userData.visualWheelId = wheel.id;
    steer.userData.visualWheelRole = 'steer-suspension';
    steer.userData.visualWheelBaseY = centerHost.y;
    const roll = new THREE.Group();
    roll.name = `visual-wheel-${wheel.id}-roll`;
    roll.userData.visualWheelId = wheel.id;
    roll.userData.visualWheelRole = 'roll';
    steer.add(roll);
    container.add(steer);
    host.updateMatrixWorld(true);
    if (manifest.schemaVersion === 1) {
      reparentPreservingWorldMatrix(root, roll);
    } else {
      for (const { object } of binding.spinObjects) reparentPreservingWorldMatrix(object, roll);
      for (const { object } of binding.carrierParts) reparentPreservingWorldMatrix(object, steer);
    }
  }
  host.updateMatrixWorld(true);
  return container;
}
