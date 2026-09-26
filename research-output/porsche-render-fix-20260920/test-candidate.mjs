import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { refineCarMaterials } from './car-materials.candidate.js';

// Use the real exporter names and shared material graph, not fabricated part
// names. Node has no image decoder; texture rendering is checked in the browser.
const bytes = await readFile(new URL('../../public/cars/porsche-gt3-rs.glb', import.meta.url));
const oldSelf = globalThis.self;
const oldError = console.error;
const errors = [];
globalThis.self = globalThis;
console.error = (...args) => errors.push(args.map(String).join(' '));
let scene;
try {
  ({ scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''));
} finally {
  console.error = oldError;
  if (oldSelf === undefined) delete globalThis.self;
  else globalThis.self = oldSelf;
}
assert.ok(errors.every(message => /GLTFLoader: Couldn't load texture/.test(message)), errors.join('\n'));
const meshes = [];
scene.traverse(object => { if (object.isMesh) meshes.push(object); });
const originals = new Map(meshes.map(object => [object, {
  material: object.material, geometry: object.geometry, matrix: object.matrix.clone(),
  color: object.material.color.clone(), side: object.material.side,
}]));
const carbonSource = meshes.find(object => object.material.name === 'TwiXeR_992_carbon_roof.001').material;
carbonSource.map = new THREE.Texture();
carbonSource.map.colorSpace = THREE.SRGBColorSpace;
const byPrefix = prefix => {
  const found = meshes.filter(object => object.name.startsWith(prefix));
  assert.equal(found.length, 1, `unique real source part: ${prefix}`);
  return found[0];
};
const window = byPrefix('TwiXeR_992_windshield_TwiXeR_992_glass004');
const leftLens = byPrefix('TwiXeR_992_headlightglass_L_led_');
const rightLens = byPrefix('TwiXeR_992_headlightglass_R_led_');
const instrument = byPrefix('TwiXeR_992_dash_clock_TwiXeR_992_glass004');
assert.equal(window.material, leftLens.material);
assert.equal(window.material, instrument.material);

refineCarMaterials(scene, 'gt3rs');
assert.equal(window.material.userData.streetRushRole, 'glass');
assert.equal(leftLens.material.userData.streetRushRole, 'lamp-lens');
assert.equal(instrument.material.userData.streetRushRole, 'instrument-glass');
assert.notEqual(leftLens.material, window.material);
assert.notEqual(instrument.material, window.material);
assert.equal(leftLens.material, rightLens.material, 'left/right lamps retain a shared batch');
for (const object of [window, leftLens, rightLens, instrument]) {
  assert.equal(object.castShadow, false);
  assert.equal(object.material.depthWrite, false);
  assert.equal(object.material.transmission, 0);
}
for (const object of meshes) {
  const old = originals.get(object);
  assert.equal(object.geometry, old.geometry);
  assert.deepEqual(object.matrix, old.matrix);
  assert.deepEqual(old.material.color, old.color, 'source colour is not mutated');
  const material = object.material;
  if (material.userData.streetRushRole === 'paint') {
    assert.equal(material.side, old.side);
    assert.equal(material.shadowSide, THREE.BackSide);
  }
  if (material.userData.streetRushRole === 'carbon') {
    assert.ok(material.isMeshPhysicalMaterial);
    assert.ok(Object.hasOwn(material.defines, 'PHYSICAL'));
    assert.ok(material.clearcoat > 0);
    assert.notEqual(material.map, carbonSource.map);
    assert.equal(material.map.source, carbonSource.map.source);
    assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
    assert.equal(material.map.anisotropy, 8);
    assert.equal(carbonSource.map.anisotropy, 1);
    assert.equal(material.shadowSide, null, 'thin carbon aero parts keep two-sided shadows');
  }
  if (material.userData.streetRushRole === 'glass-trim') {
    assert.deepEqual(material.color, old.color);
    assert.equal(material.opacity, 1);
    assert.equal(material.transparent, false);
    assert.equal(material.metalness, 0);
  }
}
const tires = meshes.filter(object => object.material.name === 'Scene_-_Root.002');
assert.equal(tires.length, 4);
for (const object of tires) {
  assert.equal(object.material.metalness, 0);
  assert.ok(object.material.roughness >= .8);
  assert.ok(object.material.color.r > 0 && object.material.color.r < .02);
}
console.log(`PASS real GT3 asset (${meshes.length} meshes): optical parts split before batching, neutral opaque trim, dielectric tires, coated carbon, body shadow sides, source ownership and geometry preserved`);

