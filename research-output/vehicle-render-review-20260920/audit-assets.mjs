import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { carMaterialRole } from '../../src/car-materials.js';
import { CARS } from '../../src/config.js';

// Read-only source audit. All generated evidence stays beside this script.
const out = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(out, '../..');
const records = CARS.map(({ id, file }) => {
  const bytes = fs.readFileSync(path.join(root, 'public/cars', file));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength));
  const uses = gltf.materials.map(() => []);
  let sourceTriangles = 0;
  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    for (const primitive of mesh.primitives) {
      const count = gltf.accessors[primitive.indices ?? primitive.attributes.POSITION].count;
      const triangles = (primitive.mode ?? 4) === 4 ? count / 3 : null;
      sourceTriangles += triangles ?? 0;
      uses[primitive.material]?.push({ node: node.name, mesh: mesh.name, triangles,
        attributes: Object.keys(primitive.attributes) });
    }
  }
  if (id === 'mx5') {
    const binaryStart = 20 + jsonLength + 8;
    const img = gltf.images[0];
    const view = gltf.bufferViews[img.bufferView];
    fs.writeFileSync(path.join(out, 'mx5-source-only-texture.png'),
      bytes.subarray(binaryStart + (view.byteOffset ?? 0), binaryStart + (view.byteOffset ?? 0) + view.byteLength));
  }
  return { id, file, sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceTriangles, meshCount: gltf.meshes.length, materialCount: gltf.materials.length,
    imageCount: gltf.images?.length ?? 0,
    note: 'Source node instances, before runtime wheel replacement or batching. Counts are not a quality score.',
    materials: gltf.materials.map((material, index) => ({ index,
      runtimeRole: carMaterialRole(material.name, id), source: material, uses: uses[index] })) };
});
fs.writeFileSync(path.join(out, 'asset-audit.json'), JSON.stringify(records, null, 2) + '\n');
for (const r of records) console.log(JSON.stringify({id:r.id, triangles:r.sourceTriangles,
  materials:r.materialCount, images:r.imageCount}));
console.log('MX5 material assignment:', JSON.stringify(records[0].materials.map(m=>({
  name:m.source.name,role:m.runtimeRole,uses:m.uses.map(u=>u.node)}))));
