import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const WHEEL_PATTERN = /wheel|tyre|tire|rim|brake[_. -]?disc|caliper|circle\.00[2-5]/i;
const LIGHT_PATTERN = /head[_. -]?light|tail[_. -]?light|brake[_. -]?light|lamp|reflector|emissive/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(9)) : value;
}

function roundVector(vector) {
  return vector.map(round);
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(left, right) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
      }
    }
  }
  return result;
}

function composeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return [...node.matrix];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function expandBounds(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function expandAccessorBounds(bounds, matrix, accessor) {
  if (!Array.isArray(accessor?.min) || !Array.isArray(accessor?.max)) return false;
  for (const x of [accessor.min[0], accessor.max[0]]) {
    for (const y of [accessor.min[1], accessor.max[1]]) {
      for (const z of [accessor.min[2], accessor.max[2]]) {
        expandBounds(bounds, transformPoint(matrix, [x, y, z]));
      }
    }
  }
  return true;
}

function finalizeBounds(bounds) {
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return null;
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const center = bounds.max.map((value, axis) => (value + bounds.min[axis]) * 0.5);
  return { min: roundVector(bounds.min), max: roundVector(bounds.max), size: roundVector(size), center: roundVector(center) };
}

function candidateSummary(values) {
  const names = [...new Set(values.map(({ name }) => name).filter(Boolean))].sort();
  return {
    count: values.length,
    digest: sha256(values.map(({ kind, index, name }) => `${kind}:${index}:${name}`).join('\n')),
    names: names.slice(0, 8),
    truncated: names.length > 8,
  };
}

function countTriangles(primitive, accessors) {
  const accessor = accessors[primitive.indices ?? primitive.attributes?.POSITION];
  const count = accessor?.count || 0;
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

export function parseGlb(buffer, label = '<buffer>') {
  if (buffer.length < 20) throw new Error(`${label}: GLB is shorter than its header and JSON chunk`);
  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  if (magic !== GLB_MAGIC) throw new Error(`${label}: invalid GLB magic`);
  if (version !== 2) throw new Error(`${label}: unsupported GLB version ${version}`);
  if (declaredLength !== buffer.length) throw new Error(`${label}: declared ${declaredLength} bytes, found ${buffer.length}`);
  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.readUInt32LE(16);
  if (jsonType !== GLB_JSON_CHUNK) throw new Error(`${label}: first GLB chunk is not JSON`);
  const jsonEnd = 20 + jsonLength;
  if (jsonEnd > buffer.length) throw new Error(`${label}: JSON chunk exceeds file length`);
  const jsonText = buffer.toString('utf8', 20, jsonEnd).replace(/[\u0000 ]+$/u, '');
  return { json: JSON.parse(jsonText), version, declaredLength, jsonLength };
}

export async function analyzeCarModel({
  filePath,
  file,
  config,
  researchSha256 = null,
  researchRelationship = 'unclassified',
}) {
  const buffer = await readFile(filePath);
  const fileSha256 = sha256(buffer);
  const { json, version, declaredLength, jsonLength } = parseGlb(buffer, file);
  const scenes = json.scenes || [];
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const accessors = json.accessors || [];
  const materials = json.materials || [];
  const primitives = meshes.flatMap((mesh) => mesh.primitives || []);
  const positionAccessors = primitives
    .map((primitive) => primitive.attributes?.POSITION)
    .filter((index) => Number.isInteger(index));
  const totalVertices = positionAccessors.reduce((sum, index) => sum + (accessors[index]?.count || 0), 0);
  const totalTriangles = primitives.reduce((sum, primitive) => sum + countTriangles(primitive, accessors), 0);

  const nodeLabels = nodes.map((node, index) => ({ kind: 'node', index, name: node.name || '' }));
  const meshLabels = meshes.map((mesh, index) => ({ kind: 'mesh', index, name: mesh.name || '' }));
  const materialLabels = materials.map((material, index) => ({ kind: 'material', index, name: material.name || '' }));
  const allLabels = [...nodeLabels, ...meshLabels, ...materialLabels];
  const wheelCandidates = allLabels.filter(({ name }) => WHEEL_PATTERN.test(name));
  const lightCandidates = allLabels.filter(({ name }) => LIGHT_PATTERN.test(name));

  const selectedSceneIndex = Number.isInteger(json.scene) ? json.scene : 0;
  const selectedScene = scenes[selectedSceneIndex] || null;
  const sceneRoots = [...(selectedScene?.nodes || [])];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let meshInstances = 0;
  let boundedPrimitives = 0;
  let missingPositionBounds = 0;
  const visit = (nodeIndex, parentMatrix, ancestors) => {
    if (ancestors.has(nodeIndex)) throw new Error(`${file}: node cycle at ${nodeIndex}`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`${file}: scene references missing node ${nodeIndex}`);
    const worldMatrix = multiplyMatrices(parentMatrix, composeMatrix(node));
    if (Number.isInteger(node.mesh)) {
      meshInstances += 1;
      for (const primitive of meshes[node.mesh]?.primitives || []) {
        const accessor = accessors[primitive.attributes?.POSITION];
        if (expandAccessorBounds(bounds, worldMatrix, accessor)) boundedPrimitives += 1;
        else missingPositionBounds += 1;
      }
    }
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const child of node.children || []) visit(child, worldMatrix, nextAncestors);
  };
  for (const root of sceneRoots) visit(root, identityMatrix(), new Set());
  const staticBounds = finalizeBounds(bounds);
  const sourceSize = staticBounds?.size || [0, 0, 0];
  const autoRotateY90 = sourceSize[0] > sourceSize[2];
  const orientedSize = autoRotateY90
    ? [sourceSize[2], sourceSize[1], sourceSize[0]]
    : [...sourceSize];
  const scale = config.model.targetLength / Math.max(orientedSize[2], 0.001);
  const normalizedSize = orientedSize.map((value) => value * scale);
  const extensionsUsed = [...new Set(json.extensionsUsed || [])].sort();
  const punctualLights = json.extensions?.KHR_lights_punctual?.lights || [];
  const lightNodes = nodes.filter((node) => node.extensions?.KHR_lights_punctual).length;

  return {
    id: config.id,
    file,
    bytes: buffer.length,
    sha256: fileSha256,
    researchOracle: {
      sha256: researchSha256,
      exactByteMatch: researchSha256 === fileSha256,
      relationship: researchRelationship,
    },
    glb: { version, declaredLength, jsonLength },
    asset: {
      version: json.asset?.version || null,
      generator: json.asset?.generator || null,
    },
    counts: {
      scenes: scenes.length,
      nodes: nodes.length,
      namedNodes: nodes.filter((node) => Boolean(node.name)).length,
      meshes: meshes.length,
      meshInstances,
      primitives: primitives.length,
      vertices: totalVertices,
      triangles: totalTriangles,
      materials: materials.length,
      textures: (json.textures || []).length,
      images: (json.images || []).length,
      skins: (json.skins || []).length,
      animations: (json.animations || []).length,
      accessors: accessors.length,
      bufferViews: (json.bufferViews || []).length,
      buffers: (json.buffers || []).length,
    },
    extensions: {
      used: extensionsUsed,
      required: [...new Set(json.extensionsRequired || [])].sort(),
      draco: extensionsUsed.includes('KHR_draco_mesh_compression'),
      meshopt: extensionsUsed.includes('EXT_meshopt_compression'),
      ktx2: extensionsUsed.includes('KHR_texture_basisu'),
    },
    names: {
      nodes: sha256(nodeLabels.map(({ index, name }) => `${index}:${name}`).join('\n')),
      meshes: sha256(meshLabels.map(({ index, name }) => `${index}:${name}`).join('\n')),
      materials: sha256(materialLabels.map(({ index, name }) => `${index}:${name}`).join('\n')),
    },
    wheelCandidates: candidateSummary(wheelCandidates),
    lightCandidates: candidateSummary(lightCandidates),
    embeddedLights: { definitions: punctualLights.length, nodes: lightNodes },
    staticScene: {
      selectedScene: selectedSceneIndex,
      rootCount: sceneRoots.length,
      rootsDigest: sha256(sceneRoots.map((index) => `${index}:${nodes[index]?.name || ''}`).join('\n')),
      rootNames: sceneRoots.slice(0, 8).map((index) => nodes[index]?.name || ''),
      rootsTruncated: sceneRoots.length > 8,
      boundedPrimitives,
      missingPositionBounds,
      bounds: staticBounds,
    },
    productionNormalization: {
      targetLength: config.model.targetLength,
      configuredYaw: config.model.yaw || 0,
      groundOffset: config.model.groundOffset,
      autoRotateY90,
      scale: round(scale),
      normalizedSize: roundVector(normalizedSize),
      wheelbase: config.wheelbase,
      trackWidth: config.trackWidth,
      wheelRadius: config.wheelRadius,
    },
  };
}
