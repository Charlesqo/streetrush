// Offline inspection only; no game source or asset is changed.
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGameAssetManager } from '../../src/game-assets.js';
import { CARS } from '../../src/config.js';
import { bindManifestVisualWheels } from '../../src/car-wheel-pivots.js';

const root = new URL('../../', import.meta.url);
const bytes = await readFile(new URL('public/cars/porsche-gt3-rs.glb', root));
globalThis.self = globalThis;
const priorError = console.error;
console.error = () => {};
let source;
try {
  source = (await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    new URL('public/cars/', root).href,
  )).scene;
} finally {
  console.error = priorError;
}
const config = CARS.find(car => car.id === 'gt3rs');
const manager = createGameAssetManager(new THREE.Scene(), null);
const aligned = source.clone(true);
let alignedBox = new THREE.Box3().setFromObject(aligned);
let alignedSize = alignedBox.getSize(new THREE.Vector3());
if (alignedSize.x > alignedSize.z) aligned.rotation.y = Math.PI / 2;
aligned.rotation.y += config.model.yaw || 0;
aligned.updateMatrixWorld(true);
alignedBox = new THREE.Box3().setFromObject(aligned);
alignedSize = alignedBox.getSize(new THREE.Vector3());
aligned.scale.setScalar(config.model.targetLength / Math.max(alignedSize.x, alignedSize.z, .001));
aligned.updateMatrixWorld(true);
alignedBox = new THREE.Box3().setFromObject(aligned);
const alignedCenter = alignedBox.getCenter(new THREE.Vector3());
const wheelGround = manager.findWheelGround(aligned, alignedBox, config);
aligned.position.x -= alignedCenter.x;
aligned.position.z -= alignedCenter.z;
aligned.position.y -= wheelGround.y + config.model.groundOffset;
aligned.updateMatrixWorld(true);
const model = manager.normalizeCar(source, config);
model.updateMatrixWorld(true);
const out = { calibration: model.userData.groundCalibration, config: {
  wheelbase: config.wheelbase, trackWidth: config.trackWidth,
  wheelRadius: config.wheelRadius, groundOffset: config.model.groundOffset,
  suspensionTravel: config.suspension.travel,
  suspensionRest: config.suspension.restLength,
  staticSpringCompression: config.mass * 9.81 / (4 * config.suspension.springRate),
}, wheels: [], nearMeshes: [] };
const wheelSet = model.getObjectByName('calibrated-wheels');
for (const id of ['FL', 'FR', 'RL', 'RR']) {
  const steer = wheelSet.getObjectByName(`visual-wheel-${id}-steer`);
  const tire = steer.getObjectByName({FL:'Object_4002_Scene_-_Root002_0',FR:'Object_4003_Scene_-_Root002_0',RL:'Object_4004_Scene_-_Root002_0',RR:'Object_4001_Scene_-_Root002_0'}[id]);
  const box = new THREE.Box3().setFromObject(tire);
  const center = steer.getWorldPosition(new THREE.Vector3());
  out.wheels.push({ id, center: center.toArray(), tireMin: box.min.toArray(), tireMax: box.max.toArray(), tireSize:box.getSize(new THREE.Vector3()).toArray(),
    archNominalCenter:[id.endsWith('L')?-config.trackWidth/2:config.trackWidth/2, center.y, id.startsWith('F')?config.wheelbase/2:-config.wheelbase/2],
    tireTopAtStatic: box.max.y + config.mass * 9.81 / (4 * config.suspension.springRate),
    tireTopAtFullCompression: box.max.y + config.suspension.travel,
  });
}
out.clearanceInputs = {
  measuredVisualRadius: out.wheels[0].tireSize[1] / 2,
  visualMinusPhysicsRadius: out.wheels[0].tireSize[1] / 2 - config.wheelRadius,
  tireBottomBelowConfiguredGroundLine: -config.model.groundOffset - out.wheels[0].tireMin[1],
};
const named = [];
aligned.traverse(object => {
  if (!object.isMesh) return;
  if (/fender|body_gt3rs|wheelhouse|bumper_F|bumper_R|sideskirt|underbody|leg/i.test(object.name)) {
    const box = new THREE.Box3().setFromObject(object);
    named.push({name:object.name, min:box.min.toArray(), max:box.max.toArray()});
  }
});
out.sourceNamedBodyBounds = named;
out.normalization = {rotationY:aligned.rotation.y,scale:aligned.scale.x,position:aligned.position.toArray(),wheelGround};
const fl = out.wheels[0];
const archMeshes = [];
aligned.traverse(object => {
  if (!object.isMesh || !/fender_R|bumper_F|underbody_gt3rs|sideskirts_R/.test(object.name)) return;
  const attribute = object.geometry.attributes.position;
  const bins = new Map();
  const point = new THREE.Vector3();
  for (let i = 0; i < attribute.count; i += 1) {
    point.fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
    if (point.x > -.84) continue;
    const dy = point.y - fl.center[1], dz = point.z - fl.center[2];
    const r = Math.hypot(dy,dz), angle = Math.atan2(dz,dy)*180/Math.PI;
    if (r < .25 || r > .65 || Math.abs(angle)>100) continue;
    const bucket = Math.round(angle/15)*15;
    const prior = bins.get(bucket);
    if (!prior || r<prior.r) bins.set(bucket,{r,x:point.x,y:point.y,z:point.z});
  }
  if (bins.size) archMeshes.push({name:object.name, points:[...bins].sort((a,b)=>a[0]-b[0])});
});
out.archOuterVertexBins = archMeshes;
if (process.argv.includes('--rays')) {
  const state = JSON.parse(await readFile(new URL('./frames/gt3rs-wheel-baseline.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../../data/car-wheel-manifests/gt3rs.json', import.meta.url)));
  const wrapper = new THREE.Group();
  wrapper.add(aligned);
  bindManifestVisualWheels(wrapper, aligned, manifest);
  for (const id of ['FL','FR','RL','RR']) {
    const steer = wrapper.getObjectByName(`visual-wheel-${id}-steer`);
    steer.position.y += .077;
  }
  wrapper.position.fromArray(state.position);
  wrapper.quaternion.fromArray(state.quaternion);
  wrapper.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(state.camera.fov, state.camera.aspect, state.camera.near, state.camera.far);
  camera.position.fromArray(state.camera.position);
  camera.quaternion.fromArray(state.camera.quaternion);
  camera.updateMatrixWorld(true);
  const rays = [];
  for (const [label,x,y] of [
    ['black-fender-top',630,187],['black-fender-left',580,201],['fender-behind-black',682,198],
    ['wheel-front-dark',517,298],['wheel-arch-edge',616,217],['wheel-rim',598,341],
    ['hood-dark-left',835,209],['hood-dark-right',891,211],['bumper',1010,367],
  ]) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(2*x/state.buffer[0]-1,1-2*y/state.buffer[1]),camera);
    rays.push({label,x,y,hits:ray.intersectObject(wrapper,true).slice(0,5).map(hit=>({distance:hit.distance,name:hit.object.name,material:hit.object.material?.name,point:hit.point.toArray()}))});
  }
  console.log(JSON.stringify({rays,positions:out.wheels,normalization:out.normalization},null,2));
} else console.log(JSON.stringify(out, null, 2));
