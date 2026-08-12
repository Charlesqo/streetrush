import * as THREE from 'three';

const WHEEL_ORDER = Object.freeze(['FL', 'FR', 'RL', 'RR']);
const PART_ROLES = Object.freeze(['rim', 'tire', 'brake-disc-like']);

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
  if (manifest?.schemaVersion !== 1) fail(vehicleId, `unsupported wheel manifest schema ${manifest?.schemaVersion}`);
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
  return manifest.wheels.map((wheel) => {
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
    reparentPreservingWorldMatrix(root, roll);
  }
  host.updateMatrixWorld(true);
  return container;
}
