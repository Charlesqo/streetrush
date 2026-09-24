import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TrackSystem } from '../src/track.js';
import { TRACK_CONFIG } from '../src/config.js';
import { refineCarMaterials } from '../src/car-materials.js';

// The real track has very unequal Catmull-Rom segment lengths. Check texture
// distance against the actual geometry, especially short corner segments.
const track = Object.create(TrackSystem.prototype);
track.config = TRACK_CONFIG;
track.curve = new THREE.CatmullRomCurve3(TRACK_CONFIG.points.map(p => new THREE.Vector3(...p)), true, 'catmullrom', .2);
const strip = track.createStrip(7, .015, new THREE.MeshStandardMaterial());
const uv = strip.geometry.attributes.uv;
const positions = strip.geometry.attributes.position;
const center = (i) => new THREE.Vector3().fromBufferAttribute(positions, i * 2).add(new THREE.Vector3().fromBufferAttribute(positions, i * 2 + 1)).multiplyScalar(.5);
for (let i = 0; i < TRACK_CONFIG.samples; i++) {
  const worldDistance = center(i + 1).distanceTo(center(i));
  const textureDistance = (uv.getX((i + 1) * 2) - uv.getX(i * 2)) * 12;
  assert.ok(Math.abs(textureDistance - worldDistance) / worldDistance < .025, `Texture scale drift at sample ${i}`);
}
console.log('PASS real-track asphalt UV scale follows rendered arc length, including corners');

const source = new THREE.MeshStandardMaterial({ color: 0xe34020, roughness: .92, metalness: 0 });
source.name = 'Body';
source.map = new THREE.Texture();
source.roughnessMap = new THREE.Texture();
const root = new THREE.Group();
const geometry = new THREE.BoxGeometry();
root.add(new THREE.Mesh(geometry, source), new THREE.Mesh(geometry, source));
const matrix = root.children[0].matrix.clone();
refineCarMaterials(root, 'lp700');
assert.equal(source.roughness, .92);
assert.equal(source.isMeshPhysicalMaterial, undefined);
assert.equal(root.children[0].material, root.children[1].material);
assert.notEqual(root.children[0].material, source);
assert.ok(Object.hasOwn(root.children[0].material.defines, 'PHYSICAL'));
assert.equal(root.children[0].material.map, source.map);
assert.equal(root.children[0].material.roughnessMap, source.roughnessMap);
assert.deepEqual(root.children[0].material.color, source.color);
assert.equal(root.children[0].geometry, geometry);
assert.deepEqual(root.children[0].matrix, matrix);
console.log('PASS material refinement preserves source ownership, shared batches, maps, colour and geometry');

const glass = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: .35, transmission: .5 });
glass.name = 'Vitre';
const pane = new THREE.Mesh(geometry, glass);
root.add(pane);
refineCarMaterials(root, 'lp700');
assert.equal(glass.transmission, .5);
assert.equal(pane.material.transmission, 0);
assert.equal(pane.material.opacity, .35);
assert.equal(pane.castShadow, false);
assert.equal(pane.material.depthWrite, false);
console.log('PASS thin glass retains opacity, avoids opaque sun shadows and the full-scene transmission prepass');
