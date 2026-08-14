import * as THREE from 'three';

const WHEEL_ORDER = Object.freeze(['FL', 'FR', 'RL', 'RR']);
const SOURCE_PART_ROLES = Object.freeze(['brake-disc', 'brake-detail', 'rim', 'tire']);

function fail(vehicleId, message) {
  throw new Error(`${vehicleId || '<unknown-vehicle>'}: ${message}`);
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isDescendantOf(object, ancestor) {
  for (let current = object; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function requireUniqueObject(root, name, vehicleId, label) {
  if (typeof name !== 'string' || name.length === 0) fail(vehicleId, `${label} runtimeName is missing`);
  const matches = [];
  root.traverse((object) => { if (object.name === name) matches.push(object); });
  if (matches.length !== 1) fail(vehicleId, `${label} runtimeName ${name} matched ${matches.length} objects`);
  return matches[0];
}

function materialName(mesh) {
  return Array.isArray(mesh.material) ? mesh.material[0]?.name ?? '' : mesh.material?.name ?? '';
}

function nearestMeanIndex(x, z, means) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < means.length; index += 1) {
    const dx = x - means[index].x;
    const dz = z - means[index].y;
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function nearestClusterIndex(point, clusters) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < clusters.length; index += 1) {
    const distance = point.distanceToSquared(clusters[index].world);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function toNonIndexedClone(mesh, vehicleId, role) {
  if (!mesh.geometry?.attributes?.position) fail(vehicleId, `${role} source has no POSITION geometry`);
  if (mesh.isSkinnedMesh || mesh.morphTargetInfluences || Object.keys(mesh.geometry.morphAttributes ?? {}).length) {
    fail(vehicleId, `${role} source cannot be skinned or morphed`);
  }
  const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  if (geometry.attributes.position.count % 3 !== 0) {
    geometry.dispose();
    fail(vehicleId, `${role} source is not a triangle list`);
  }
  for (const attribute of Object.values(geometry.attributes)) {
    if (attribute.isInterleavedBufferAttribute) {
      geometry.dispose();
      fail(vehicleId, `${role} source has unsupported interleaved attributes`);
    }
  }
  return geometry;
}

function validateContract(host, model, manifest) {
  const vehicleId = manifest?.vehicleId;
  if (manifest?.schemaVersion !== 3) fail(vehicleId, `unsupported geometry-split wheel manifest schema ${manifest?.schemaVersion}`);
  if (!sameArray(manifest.wheelOrder, WHEEL_ORDER)) fail(vehicleId, 'wheelOrder must be FL/FR/RL/RR');
  if (!sameArray(manifest.coordinates?.runtimeSteerAxis, [0, 1, 0])) fail(vehicleId, 'runtime steer axis must be +Y');
  if (!sameArray(manifest.coordinates?.runtimeRollAxis, [1, 0, 0])) fail(vehicleId, 'runtime roll axis must be +X');
  if (!Array.isArray(manifest.wheels) || !sameArray(manifest.wheels.map(({ id }) => id), WHEEL_ORDER)) {
    fail(vehicleId, 'wheel entries must follow FL/FR/RL/RR');
  }
  if (!host?.isObject3D || !model?.isObject3D) fail(vehicleId, 'host and model must be Three Object3D instances');
  if (host === model || !isDescendantOf(model, host)) fail(vehicleId, 'normalized model must be a descendant of its unscaled vehicle host');
  if (host.getObjectByName('calibrated-wheels')) fail(vehicleId, 'vehicle host already has calibrated-wheels');
  if (Math.max(Math.abs(host.scale.x - 1), Math.abs(host.scale.y - 1), Math.abs(host.scale.z - 1)) > 1e-9) {
    fail(vehicleId, 'vehicle host scale must remain unit so suspension offsets stay in metres');
  }
  return vehicleId;
}

function deriveTireClusters(tireMesh, manifest, vehicleId) {
  const split = manifest.geometrySplit;
  if (split?.method !== 'tire-triangle-centroid-kmeans-then-nearest-cluster') {
    fail(vehicleId, 'geometrySplit method is unsupported');
  }
  if (split.frontRule !== '+Z' || split.leftRule !== '-X') {
    fail(vehicleId, 'geometrySplit requires front +Z and left -X');
  }
  const iterations = split.iterations;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
    fail(vehicleId, 'geometrySplit iterations must be an integer from 1 to 100');
  }
  const geometry = toNonIndexedClone(tireMesh, vehicleId, 'tire');
  try {
    const position = geometry.attributes.position;
    const centers = [];
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 3) {
      p0.fromBufferAttribute(position, index);
      p1.fromBufferAttribute(position, index + 1);
      p2.fromBufferAttribute(position, index + 2);
      centers.push(p0.clone().add(p1).add(p2).multiplyScalar(1 / 3).applyMatrix4(tireMesh.matrixWorld));
    }
    const xs = centers.map(({ x }) => x);
    const zs = centers.map(({ z }) => z);
    let means = [
      new THREE.Vector2(Math.min(...xs), Math.min(...zs)),
      new THREE.Vector2(Math.max(...xs), Math.min(...zs)),
      new THREE.Vector2(Math.min(...xs), Math.max(...zs)),
      new THREE.Vector2(Math.max(...xs), Math.max(...zs)),
    ];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const sums = means.map(() => new THREE.Vector2());
      const counts = means.map(() => 0);
      for (const center of centers) {
        const index = nearestMeanIndex(center.x, center.z, means);
        sums[index].x += center.x;
        sums[index].y += center.z;
        counts[index] += 1;
      }
      if (counts.some((count) => count === 0)) fail(vehicleId, 'tire clustering produced an empty wheel');
      means = means.map((mean, index) => sums[index].multiplyScalar(1 / counts[index]));
    }
    const assigned = means.map(() => []);
    for (const center of centers) assigned[nearestMeanIndex(center.x, center.z, means)].push(center);
    const entries = assigned.map((values) => ({
      world: values.reduce((sum, value) => sum.add(value), new THREE.Vector3()).multiplyScalar(1 / values.length),
      triangleCount: values.length,
    }));
    const midX = entries.reduce((sum, { world }) => sum + world.x, 0) / entries.length;
    const midZ = entries.reduce((sum, { world }) => sum + world.z, 0) / entries.length;
    const labeled = entries.map((entry) => ({
      ...entry,
      label: `${entry.world.z > midZ ? 'F' : 'R'}${entry.world.x < midX ? 'L' : 'R'}`,
    }));
    if (new Set(labeled.map(({ label }) => label)).size !== WHEEL_ORDER.length) {
      fail(vehicleId, 'tire clustering did not produce unique FL/FR/RL/RR labels');
    }
    return labeled.sort((left, right) => WHEEL_ORDER.indexOf(left.label) - WHEEL_ORDER.indexOf(right.label));
  } finally {
    geometry.dispose();
  }
}

function splitGeometryByClusters(sourceMesh, clusters, vehicleId, role) {
  const source = toNonIndexedClone(sourceMesh, vehicleId, role);
  const created = [];
  try {
    const position = source.attributes.position;
    const buckets = clusters.map(() => []);
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const center = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 3) {
      p0.fromBufferAttribute(position, index);
      p1.fromBufferAttribute(position, index + 1);
      p2.fromBufferAttribute(position, index + 2);
      center.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3).applyMatrix4(sourceMesh.matrixWorld);
      buckets[nearestClusterIndex(center, clusters)].push(index, index + 1, index + 2);
    }
    for (let clusterIndex = 0; clusterIndex < buckets.length; clusterIndex += 1) {
      const indices = buckets[clusterIndex];
      if (indices.length === 0) fail(vehicleId, `${role} split ${clusters[clusterIndex].label} is empty`);
      const geometry = new THREE.BufferGeometry();
      created.push(geometry);
      for (const [name, attribute] of Object.entries(source.attributes)) {
        const values = new attribute.array.constructor(indices.length * attribute.itemSize);
        let offset = 0;
        for (const sourceIndex of indices) {
          for (let component = 0; component < attribute.itemSize; component += 1) {
            values[offset] = attribute.array[sourceIndex * attribute.itemSize + component];
            offset += 1;
          }
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized));
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    return created;
  } catch (error) {
    for (const geometry of created) geometry.dispose();
    throw error;
  } finally {
    source.dispose();
  }
}

function collectBindings(host, model, manifest, vehicleId) {
  const split = manifest.geometrySplit;
  if (split?.pivotMethod !== 'split-tire-world-bounds-center') fail(vehicleId, 'geometrySplit pivot method is unsupported');
  if (!sameArray(split?.sourceParts?.map(({ role }) => role), SOURCE_PART_ROLES)) {
    fail(vehicleId, 'geometrySplit sourceParts must be brake-disc/brake-detail/rim/tire');
  }
  const sources = split.sourceParts.map((part) => {
    const object = requireUniqueObject(model, part.runtimeName, vehicleId, `${part.role} source`);
    if (!object.isMesh || !isDescendantOf(object, model) || Array.isArray(object.material)) {
      fail(vehicleId, `${part.role} source must be a single-material mesh inside the normalized model`);
    }
    if (materialName(object) !== part.materialName) fail(vehicleId, `${part.role} source material must be ${part.materialName}`);
    if (!Number.isInteger(part.expectedSplitVertexCountPerWheel) || part.expectedSplitVertexCountPerWheel <= 0) {
      fail(vehicleId, `${part.role} expected split vertex count is invalid`);
    }
    return { part, object };
  });
  if (new Set(sources.map(({ object }) => object)).size !== sources.length) fail(vehicleId, 'geometrySplit source meshes must be unique');
  const clusters = deriveTireClusters(sources.find(({ part }) => part.role === 'tire').object, manifest, vehicleId);
  const createdGeometries = [];
  try {
    const splitSources = sources.map(({ part, object }) => {
      const geometries = splitGeometryByClusters(object, clusters, vehicleId, part.role);
      createdGeometries.push(...geometries);
      return { part, object, geometries };
    });
    const bindings = manifest.wheels.map((wheel, wheelIndex) => {
      const cluster = clusters[wheelIndex];
      if (cluster.label !== wheel.id) fail(vehicleId, `${wheel.id} cluster order mismatch`);
      if (cluster.triangleCount !== wheel.expectedTireTriangles) {
        fail(vehicleId, `${wheel.id} tire triangle count ${cluster.triangleCount} != ${wheel.expectedTireTriangles}`);
      }
      const pieces = splitSources.map(({ part, object, geometries }) => {
        const geometry = geometries[wheelIndex];
        const actualCount = geometry.attributes.position.count;
        if (actualCount !== part.expectedSplitVertexCountPerWheel) {
          fail(vehicleId, `${wheel.id} ${part.materialName} split vertex count ${actualCount} != ${part.expectedSplitVertexCountPerWheel}`);
        }
        return { part, source: object, geometry };
      });
      const tire = pieces.find(({ part }) => part.role === 'tire');
      const centerWorld = tire.geometry.boundingBox.clone().applyMatrix4(tire.source.matrixWorld).getCenter(new THREE.Vector3());
      const centerHost = host.worldToLocal(centerWorld.clone());
      const tolerance = split.pivotToleranceMeters;
      if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 0.001) fail(vehicleId, 'geometrySplit pivot tolerance is invalid');
      if (!Array.isArray(wheel.expectedPivot) || wheel.expectedPivot.length !== 3 || !wheel.expectedPivot.every(Number.isFinite)) {
        fail(vehicleId, `${wheel.id} expected pivot is invalid`);
      }
      const error = centerHost.distanceTo(new THREE.Vector3(...wheel.expectedPivot));
      if (error > tolerance) fail(vehicleId, `${wheel.id} split tire pivot error ${error} > ${tolerance}`);
      return { wheel, pieces, centerHost };
    });
    return { bindings, sources, createdGeometries };
  } catch (error) {
    for (const geometry of createdGeometries) geometry.dispose();
    throw error;
  }
}

export function bindGeometrySplitVisualWheels(host, model, manifest) {
  const vehicleId = validateContract(host, model, manifest);
  host.updateMatrixWorld(true);
  const { bindings, sources, createdGeometries } = collectBindings(host, model, manifest, vehicleId);
  try {
    const container = new THREE.Group();
    container.name = 'calibrated-wheels';
    container.userData.visualWheelBindingVersion = 1;
    container.userData.visualWheelOrder = [...WHEEL_ORDER];
    container.userData.visualWheelSource = `manifest:${vehicleId}`;
    container.userData.dynamicCarPart = { version: 1, id: `${vehicleId}-wheel-set` };
    for (const { wheel, pieces, centerHost } of bindings) {
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
      const rollWorld = host.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(centerHost.x, centerHost.y, centerHost.z));
      const worldToRoll = rollWorld.invert();
      for (const { part, source, geometry } of pieces) {
        const piece = new THREE.Mesh(geometry, source.material);
        piece.name = `${wheel.id}-${part.materialName}-split`;
        piece.castShadow = source.castShadow;
        piece.receiveShadow = source.receiveShadow;
        piece.renderOrder = source.renderOrder;
        piece.frustumCulled = source.frustumCulled;
        piece.layers.mask = source.layers.mask;
        piece.matrixAutoUpdate = false;
        piece.matrix.copy(worldToRoll).multiply(source.matrixWorld);
        roll.add(piece);
      }
    }
    host.add(container);
    for (const { object } of sources) object.visible = false;
    host.updateMatrixWorld(true);
    return container;
  } catch (error) {
    for (const geometry of createdGeometries) geometry.dispose();
    throw error;
  }
}
