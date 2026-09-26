// Reconstructs the 2026-09-20 DEV hero camera to identify visible meshes.
// The archived six-car captures were paused at the start pose.
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGameAssetManager } from '../../src/game-assets.js';
import { CARS } from '../../src/config.js';

globalThis.self = globalThis;
const manager = createGameAssetManager(new THREE.Scene(), null);
const configById = new Map(CARS.map(car => [car.id, car]));
const picks = {
  m3e30: [['front-grey-disc', 767, 878], ['front-black-tyre', 808, 934], ['rear-wheel', 461, 764]],
  m5g90: [['windscreen', 831, 463], ['headlamp-green-left', 945, 605], ['headlamp-green-right', 1011, 620], ['near-headlamp', 1002, 665], ['near-body', 699, 612]],
};
const output = [];
for (const [id, pixels] of Object.entries(picks)) {
  const config = configById.get(id);
  const url = new URL(`../../public/cars/${config.file}`, import.meta.url);
  const bytes = await readFile(url);
  const originalError = console.error;
  console.error = () => {};
  let source;
  try {
    source = (await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), url.href,
    )).scene;
  } finally {
    console.error = originalError;
  }
  const car = manager.normalizeCar(source, config);
  car.position.set(-320, config.model.groundOffset + .025, 0);
  car.rotation.y = Math.PI / 2;
  car.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(58, 1524 / 1304, .1, 1300);
  const transform = point => new THREE.Vector3(...point).applyQuaternion(car.quaternion).add(car.position);
  camera.position.copy(transform([-3.4, 1.3, 4.3]));
  camera.lookAt(transform([0, .3, .25]));
  camera.updateMatrixWorld(true);
  const rays = pixels.map(([label, x, y]) => {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x / 762 - 1, 1 - y / 652), camera);
    const hits = ray.intersectObject(car, true).filter(hit => hit.object.visible);
    return { label, pixel: [x, y], hits: hits.slice(0, 4).map(hit => ({
      name: hit.object.name,
      material: hit.object.material?.name,
      role: hit.object.material?.userData?.streetRushRole,
      transparent: hit.object.material?.transparent,
      opacity: hit.object.material?.opacity,
      depthWrite: hit.object.material?.depthWrite,
      color: hit.object.material?.color?.toArray(),
      distance: hit.distance,
      point: hit.point.toArray(),
      uv: hit.uv?.toArray(),
    })) };
  });
  output.push({ id, camera: camera.position.toArray(), rays });
}
console.log(JSON.stringify(output, null, 2));
