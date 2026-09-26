// Offline source/runtime wheel measurements. Does not modify game assets.
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGameAssetManager } from '../../src/game-assets.js';
import { CARS } from '../../src/config.js';

globalThis.self = globalThis;
const manager = createGameAssetManager(new THREE.Scene(), null);
const result = [];
for (const id of ['mx5', 'm3e30', 'gt3rs', 'lp700']) {
  const config = CARS.find(car => car.id === id);
  const url = new URL(`../../public/cars/${config.file}`, import.meta.url);
  const bytes = await readFile(url);
  const oldError = console.error;
  console.error = () => {};
  let source;
  try {
    source = (await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      url.href,
    )).scene;
  } finally {
    console.error = oldError;
  }
  const normalized = manager.normalizeCar(source, config);
  normalized.updateMatrixWorld(true);
  const steer = normalized.getObjectByName('visual-wheel-FL-steer');
  const tireMeshes = [];
  const rimMeshes = [];
  steer.traverse(object => {
    if (!object.isMesh || !object.visible) return;
    const role = object.material?.userData?.streetRushRole;
    if (/tire|tyre|pneu/i.test(object.name) || /tire|tyre|pneu/i.test(object.material?.name) || role === 'rubber'
      || (id === 'gt3rs' && object.name === 'Object_4002_Scene_-_Root002_0')) tireMeshes.push(object);
    if (/rim|jante/i.test(object.name) || /rim|jante/i.test(object.material?.name)) rimMeshes.push(object);
  });
  const boxOf = meshes => meshes.reduce((box, mesh) => box.union(new THREE.Box3().setFromObject(mesh)), new THREE.Box3());
  const tireBox = boxOf(tireMeshes);
  const center = steer.getWorldPosition(new THREE.Vector3());
  const staticCompression = config.mass * 9.81 / (4 * config.suspension.springRate);
  const entry = {
    id,
    groundCalibration: normalized.userData.groundCalibration,
    physicsRadius: config.wheelRadius,
    staticCompression,
    groundOffset: config.model.groundOffset,
    wheelCenter: center.toArray(),
    tireMeshes: tireMeshes.map(m => m.name),
    rimMeshes: rimMeshes.map(m => m.name),
  };
  if (tireMeshes.length && !tireBox.isEmpty()) {
    const size = tireBox.getSize(new THREE.Vector3());
    entry.visualRadiusFromY = size.y / 2;
    entry.tireBottom = tireBox.min.y;
    entry.tireTop = tireBox.max.y;
    entry.radiusGap = entry.visualRadiusFromY - config.wheelRadius;
    entry.localTireBottomAfterStaticCompression = tireBox.min.y + staticCompression;
  }
  if (id === 'm3e30') {
    const sourceNames = { matchingHideRule: [], originalRims: [], originalTires: [] };
    source.traverse(object => {
      if (!object.isMesh) return;
      if (/BMW_E30_M3_(RIM|TIRE)/i.test(object.name)) sourceNames.matchingHideRule.push(object.name);
      if (object.material?.name === 'BMW_E30_M3_RIM') sourceNames.originalRims.push(object.name);
      if (object.material?.name === 'BMW_E30_M3_TIRE') sourceNames.originalTires.push(object.name);
    });
    entry.sourceWheelNames = sourceNames;
    const runtimeNames = { originalRimBatches: [], originalTireBatches: [] };
    normalized.traverse(object => {
      if (!object.isMesh || !object.visible) return;
      if (object.material?.name === 'BMW_E30_M3_RIM') runtimeNames.originalRimBatches.push(object.name);
      if (object.material?.name === 'BMW_E30_M3_TIRE') runtimeNames.originalTireBatches.push(object.name);
    });
    entry.runtimeOriginalWheelBatches = runtimeNames;
    const rim = rimMeshes[0];
    const tire = tireMeshes[0];
    entry.proceduralRim = rim && {
      type: rim.geometry.type,
      radius: rim.geometry.parameters.radiusTop,
      openEnded: rim.geometry.parameters.openEnded,
      axialLength: rim.geometry.parameters.height,
      widthFromTire: rim.geometry.parameters.height - tire.geometry.parameters.height,
    };
    entry.proceduralTire = tire && {
      type: tire.geometry.type,
      radius: tire.geometry.parameters.radiusTop,
      openEnded: tire.geometry.parameters.openEnded,
      axialLength: tire.geometry.parameters.height,
    };
  }
  result.push(entry);
}
console.log(JSON.stringify(result, null, 2));
