import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PropertyBinding } from 'three';
import {
  composeMatrix,
  multiplyMatrices,
  parseGlb,
  transformPoint,
} from './car-model-structure.mjs';

const GLB_BIN_CHUNK = 0x004e4942;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(vehicleId, message) {
  throw new Error(`${vehicleId}: ${message}`);
}

function expectEqual(vehicleId, actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(vehicleId, `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function roundVector(vector) {
  return vector.map((value) => Number(value.toFixed(9)));
}

function normalize(vector, vehicleId, label) {
  const length = Math.hypot(...vector);
  if (!(length > 0) || !Number.isFinite(length)) fail(vehicleId, `${label} is not a finite non-zero vector`);
  return vector.map((value) => value / length);
}

function expectVectorNear(vehicleId, actual, expected, tolerance, label) {
  if (!Array.isArray(expected) || expected.length !== actual.length) {
    fail(vehicleId, `${label}: expected vector is missing or has the wrong length`);
  }
  const maxError = Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
  if (!(maxError <= tolerance)) fail(vehicleId, `${label}: max error ${maxError} exceeds ${tolerance}`);
  return maxError;
}

function findBinaryChunk(buffer, vehicleId) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end > buffer.length) fail(vehicleId, `GLB chunk at ${offset} exceeds file length`);
    if (type === GLB_BIN_CHUNK) return { dataOffset, length };
    offset = end;
  }
  fail(vehicleId, 'GLB has no BIN chunk');
}

function collectSceneGraph(json, vehicleId) {
  const nodes = json.nodes || [];
  const sceneIndex = Number.isInteger(json.scene) ? json.scene : 0;
  const roots = json.scenes?.[sceneIndex]?.nodes || [];
  const worldMatrices = new Map();
  const parents = new Map();
  const visit = (nodeIndex, parentMatrix, parentIndex, ancestors) => {
    if (ancestors.has(nodeIndex)) fail(vehicleId, `node cycle at ${nodeIndex}`);
    if (worldMatrices.has(nodeIndex)) fail(vehicleId, `node ${nodeIndex} has multiple scene parents`);
    const node = nodes[nodeIndex];
    if (!node) fail(vehicleId, `scene references missing node ${nodeIndex}`);
    const worldMatrix = multiplyMatrices(parentMatrix, composeMatrix(node));
    worldMatrices.set(nodeIndex, worldMatrix);
    parents.set(nodeIndex, parentIndex);
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const child of node.children || []) visit(child, worldMatrix, nodeIndex, nextAncestors);
  };
  for (const root of roots) visit(root, IDENTITY_MATRIX, null, new Set());
  return { parents, worldMatrices };
}

function readFloatPosition(buffer, json, binaryChunk, accessorIndex, vertexIndex, vehicleId) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) fail(vehicleId, `missing POSITION accessor ${accessorIndex}`);
  if (accessor.type !== 'VEC3' || accessor.componentType !== 5126 || accessor.normalized || accessor.sparse) {
    fail(vehicleId, `POSITION accessor ${accessorIndex} is not a non-sparse FLOAT VEC3`);
  }
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) fail(vehicleId, `POSITION accessor ${accessorIndex} has an unsupported buffer view`);
  const stride = view.byteStride || 12;
  if (stride < 12) fail(vehicleId, `POSITION accessor ${accessorIndex} byteStride ${stride} is too small`);
  const viewRelativeOffset = (accessor.byteOffset || 0) + vertexIndex * stride;
  if (viewRelativeOffset + 12 > view.byteLength) {
    fail(vehicleId, `POSITION accessor ${accessorIndex} exceeds bufferView ${accessor.bufferView}`);
  }
  const byteOffset = binaryChunk.dataOffset + (view.byteOffset || 0) + viewRelativeOffset;
  if (byteOffset + 12 > binaryChunk.dataOffset + binaryChunk.length) {
    fail(vehicleId, `POSITION accessor ${accessorIndex} exceeds the BIN chunk`);
  }
  return [buffer.readFloatLE(byteOffset), buffer.readFloatLE(byteOffset + 4), buffer.readFloatLE(byteOffset + 8)];
}

function measurePart(buffer, json, binaryChunk, graph, part, vehicleId, validateExpected) {
  const node = json.nodes?.[part.node];
  if (!node) fail(vehicleId, `${part.role} node ${part.node} is missing`);
  expectEqual(vehicleId, node.name || '', part.nodeName, `${part.role} node name`);
  expectEqual(vehicleId, node.mesh, part.mesh, `${part.role} node mesh`);
  const mesh = json.meshes?.[part.mesh];
  if (!mesh) fail(vehicleId, `${part.role} mesh ${part.mesh} is missing`);
  expectEqual(vehicleId, mesh.name || '', part.meshName, `${part.role} mesh name`);
  const primitive = mesh.primitives?.[part.primitive];
  if (!primitive) fail(vehicleId, `${part.role} primitive ${part.primitive} is missing`);
  expectEqual(vehicleId, primitive.material, part.material, `${part.role} material index`);
  expectEqual(vehicleId, json.materials?.[part.material]?.name || '', part.materialName, `${part.role} material name`);
  const positionAccessor = primitive.attributes?.POSITION;
  if (validateExpected) expectEqual(vehicleId, positionAccessor, part.positionAccessor, `${part.role} POSITION accessor`);
  const accessor = json.accessors?.[positionAccessor];
  if (validateExpected) expectEqual(vehicleId, accessor?.count, part.vertexCount, `${part.role} vertex count`);
  const matrix = graph.worldMatrices.get(part.node);
  if (!matrix) fail(vehicleId, `${part.role} node ${part.node} is outside the default scene`);
  const sum = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < accessor.count; index += 1) {
    const point = transformPoint(matrix, readFloatPosition(buffer, json, binaryChunk, positionAccessor, index, vehicleId));
    for (let axis = 0; axis < 3; axis += 1) {
      sum[axis] += point[axis];
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  const rawWorldBounds = {
    min,
    max,
    size: max.map((value, axis) => value - min[axis]),
    center: max.map((value, axis) => (value + min[axis]) * 0.5),
  };
  if (validateExpected) {
    expectVectorNear(vehicleId, min, part.expectedRawWorldBounds?.min, 1e-6, `${part.role} bounds min`);
    expectVectorNear(vehicleId, max, part.expectedRawWorldBounds?.max, 1e-6, `${part.role} bounds max`);
  }
  return {
    positionAccessor,
    vertexCount: accessor.count,
    rawWorldCentroid: sum.map((value) => value / accessor.count),
    rawWorldBounds,
  };
}

export async function inspectCarWheelManifest({ filePath, manifest, validateExpected = true }) {
  const vehicleId = manifest.vehicleId || '<unknown-vehicle>';
  if (manifest.schemaVersion !== 1) fail(vehicleId, `unsupported schemaVersion ${manifest.schemaVersion}`);
  const buffer = await readFile(filePath);
  expectEqual(vehicleId, buffer.length, manifest.source.bytes, 'source byte length');
  expectEqual(vehicleId, sha256(buffer), manifest.source.sha256, 'source sha256');
  const { json } = parseGlb(buffer, manifest.source.file);
  const binaryChunk = findBinaryChunk(buffer, vehicleId);
  const graph = collectSceneGraph(json, vehicleId);
  expectEqual(vehicleId, manifest.wheelOrder, ['FL', 'FR', 'RL', 'RR'], 'game wheel order');
  expectEqual(vehicleId, manifest.wheels.length, 4, 'wheel count');
  expectEqual(vehicleId, manifest.coordinates.runtimeSteerAxis, [0, 1, 0], 'runtime steer axis');
  expectEqual(vehicleId, manifest.coordinates.runtimeRollAxis, [1, 0, 0], 'runtime roll axis');
  expectEqual(vehicleId, manifest.coordinates.sourceParentRollAxis, 'local-Z', 'source parent roll axis');
  const order = manifest.wheels.map(({ id }) => id);
  expectEqual(vehicleId, order, manifest.wheelOrder, 'wheel order');
  expectEqual(vehicleId, new Set(order).size, 4, 'unique wheel count');
  const tolerance = manifest.coordinates.axisTolerance;
  if (!(tolerance > 0 && tolerance <= 1e-6)) fail(vehicleId, `axisTolerance ${tolerance} is outside (0, 1e-6]`);
  const wheels = [];
  let maxAxisError = 0;
  let maxPivotError = 0;
  for (const wheel of manifest.wheels) {
    const rootNode = json.nodes?.[wheel.root.node];
    if (!rootNode) fail(vehicleId, `${wheel.id} root node ${wheel.root.node} is missing`);
    expectEqual(vehicleId, rootNode.name || '', wheel.root.name, `${wheel.id} root name`);
    expectEqual(vehicleId, wheel.root.runtimeName, PropertyBinding.sanitizeNodeName(wheel.root.name), `${wheel.id} runtime root name`);
    expectEqual(vehicleId, rootNode.children || [], wheel.root.children, `${wheel.id} root children`);
    const rootMatrix = graph.worldMatrices.get(wheel.root.node);
    if (!rootMatrix) fail(vehicleId, `${wheel.id} root is outside the default scene`);
    const rollAxisWorld = normalize([rootMatrix[8], rootMatrix[9], rootMatrix[10]], vehicleId, `${wheel.id} roll axis`);
    maxAxisError = Math.max(maxAxisError, expectVectorNear(
      vehicleId,
      rollAxisWorld,
      manifest.coordinates.expectedSourceParentRollAxisWorld,
      tolerance,
      `${wheel.id} source parent roll axis`,
    ));
    const roles = wheel.parts.map(({ role }) => role);
    expectEqual(vehicleId, roles, ['rim', 'tire', 'brake-disc-like'], `${wheel.id} part roles`);
    const parts = [];
    for (const part of wheel.parts) {
      expectEqual(vehicleId, part.runtimeName, PropertyBinding.sanitizeNodeName(part.nodeName), `${wheel.id} ${part.role} runtime name`);
      expectEqual(vehicleId, graph.parents.get(part.node), wheel.root.node, `${wheel.id} ${part.role} parent`);
      parts.push({ ...part, ...measurePart(buffer, json, binaryChunk, graph, part, vehicleId, validateExpected) });
    }
    const pivotPart = parts.find(({ role }) => role === wheel.pivot.partRole);
    if (!pivotPart) fail(vehicleId, `${wheel.id} pivot part role ${wheel.pivot.partRole} is missing`);
    if (wheel.pivot.method !== 'position-vertex-centroid-world') {
      fail(vehicleId, `${wheel.id} unsupported pivot method ${wheel.pivot.method}`);
    }
    if (validateExpected) {
      maxPivotError = Math.max(maxPivotError, expectVectorNear(
        vehicleId,
        pivotPart.rawWorldCentroid,
        wheel.pivot.expectedRawWorldCentroid,
        1e-6,
        `${wheel.id} pivot centroid`,
      ));
    }
    wheels.push({
      id: wheel.id,
      rootNode: wheel.root.node,
      rollAxisWorld: roundVector(rollAxisWorld),
      pivotRawWorldCentroid: roundVector(pivotPart.rawWorldCentroid),
      parts: parts.map((part) => ({
        role: part.role,
        node: part.node,
        positionAccessor: part.positionAccessor,
        vertexCount: part.vertexCount,
        rawWorldCentroid: roundVector(part.rawWorldCentroid),
        rawWorldBounds: {
          min: roundVector(part.rawWorldBounds.min),
          max: roundVector(part.rawWorldBounds.max),
          size: roundVector(part.rawWorldBounds.size),
          center: roundVector(part.rawWorldBounds.center),
        },
      })),
    });
  }
  return {
    schemaVersion: manifest.schemaVersion,
    vehicleId,
    sourceSha256: manifest.source.sha256,
    order,
    maxAxisError,
    maxPivotError,
    centroidDigest: sha256(wheels.map((wheel) => `${wheel.id}:${wheel.pivotRawWorldCentroid.join(',')}`).join('\n')),
    wheels,
  };
}
