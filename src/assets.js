import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export class AssetManager {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.loader = new GLTFLoader();
    this.carCache = new Map();
    this.pendingCars = new Map();
    this.visualCache = new Map();
    this.pendingVisuals = new Map();
    this.preloadScheduled = new Set();
    this.carLoadTimeoutMs = 15_000;
    this.cityGroup = new THREE.Group();
    this.cityGroup.name = 'safe-scenery';
    scene.add(this.cityGroup);
  }

  fetchCar(config, onProgress) {
    if (this.carCache.has(config.id)) return Promise.resolve(this.carCache.get(config.id));
    if (this.pendingCars.has(config.id)) return this.pendingCars.get(config.id);
    let request;
    const loadPromise = Promise.resolve()
      .then(() => this.loader.loadAsync(`/cars/${config.file}`, (event) => {
        if (event.total) onProgress?.(event.loaded / event.total);
      }));
    let timeoutId;
    const timeoutMs = Math.max(1, Number.isFinite(this.carLoadTimeoutMs) ? this.carLoadTimeoutMs : 15_000);
    const timedLoad = Promise.race([
      loadPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            this.loader.manager?.abort?.();
          } catch {
            // A custom test/deployment loader may not expose an abortable manager.
          }
          reject(new Error(`Timed out loading car ${config.id}`));
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timeoutId));
    request = timedLoad
      .then((gltf) => {
        if (this.pendingCars.get(config.id) === request) {
          this.carCache.set(config.id, gltf.scene);
          this.pendingCars.delete(config.id);
        }
        return gltf.scene;
      })
      .catch((error) => {
        if (this.pendingCars.get(config.id) === request) {
          this.pendingCars.delete(config.id);
          this.carCache.delete(config.id);
        }
        throw error;
      });
    this.pendingCars.set(config.id, request);
    return request;
  }

  createFallback(config) {
    const root = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.82, 0.62, 4.25),
      new THREE.MeshStandardMaterial({ color: config.id === 'mx5' ? 0xe5352f : 0xebff00, metalness: 0.58, roughness: 0.25 }),
    );
    body.position.y = 0.68;
    body.castShadow = true;
    root.add(body);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.52, 0.52, 1.75),
      new THREE.MeshStandardMaterial({ color: 0x111722, metalness: 0.75, roughness: 0.16 }),
    );
    cabin.position.set(0, 1.13, -0.18);
    root.add(cabin);
    return root;
  }

  normalizeCar(template, config) {
    const wrapper = new THREE.Group();
    const model = template.clone(true);
    let box = new THREE.Box3().setFromObject(model);
    let size = box.getSize(new THREE.Vector3());
    if (size.x > size.z) model.rotation.y = Math.PI / 2;
    model.rotation.y += config.model.yaw || 0;
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    size = box.getSize(new THREE.Vector3());
    const scale = config.model.targetLength / Math.max(size.x, size.z, 0.001);
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const wheelGround = this.findWheelGround(model, box, config);
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= wheelGround.y + config.model.groundOffset;
    model.position.y += config.model.groundAdjust || 0;
    if (config.id === 'm3e30') {
      model.traverse((object) => {
        if (object.isMesh && /BMW_E30_M3_(RIM|TIRE)/i.test(object.name)) object.visible = false;
      });
    }
    const optimized = this.mergeStaticCarMeshes(model);
    optimized.traverse((object) => {
      if (!object.isMesh) return;
      object.receiveShadow = true;
      object.frustumCulled = true;
    });
    wrapper.add(optimized);
    if (config.id === 'm3e30') wrapper.add(this.createCalibratedWheelSet(config));
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 28),
      new THREE.MeshBasicMaterial({
        color: 0x101316, transparent: true, opacity: 0.3, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1,
      }),
    );
    contactShadow.name = 'contact-shadow';
    contactShadow.rotation.x = -Math.PI * 0.5;
    contactShadow.position.y = -config.model.groundOffset + 0.025;
    contactShadow.scale.set(config.trackWidth * 0.72, config.model.targetLength * 0.39, 1);
    contactShadow.renderOrder = 2;
    wrapper.add(contactShadow);
    wrapper.userData.configId = config.id;
    wrapper.userData.source = 'gltf';
    wrapper.userData.groundCalibration = wheelGround.source;
    return wrapper;
  }

  createCalibratedWheelSet(config) {
    const group = new THREE.Group();
    group.name = 'calibrated-wheels';
    const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.82 });
    const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xaeb2b5, metalness: 0.78, roughness: 0.28 });
    const tireGeometry = new THREE.CylinderGeometry(config.wheelRadius, config.wheelRadius, 0.205, 24, 1, true);
    const rimGeometry = new THREE.CylinderGeometry(config.wheelRadius * 0.58, config.wheelRadius * 0.58, 0.214, 18);
    tireGeometry.rotateZ(Math.PI * 0.5);
    rimGeometry.rotateZ(Math.PI * 0.5);
    const wheelY = -config.model.groundOffset + config.wheelRadius;
    for (const x of [-config.trackWidth * 0.5, config.trackWidth * 0.5]) {
      for (const z of [-config.wheelbase * 0.5, config.wheelbase * 0.5]) {
        const tire = new THREE.Mesh(tireGeometry, tireMaterial);
        const rim = new THREE.Mesh(rimGeometry, rimMaterial);
        tire.position.set(x, wheelY, z);
        rim.position.copy(tire.position);
        group.add(tire, rim);
      }
    }
    return group;
  }

  findWheelGround(model, overallBox, config) {
    const carSize = overallBox.getSize(new THREE.Vector3());
    const carCenter = overallBox.getCenter(new THREE.Vector3());
    const tireBoxes = [];
    const wheelBoxes = [];
    const shapeBoxes = [];
    model.traverse((object) => {
      if (!object.isMesh || !object.visible) return;
      const bounds = new THREE.Box3().setFromObject(object);
      if (bounds.isEmpty()) return;
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const atCorner = Math.abs(center.x - carCenter.x) > carSize.x * 0.22
        && Math.abs(center.z - carCenter.z) > carSize.z * 0.17;
      const lowEnough = center.y < overallBox.min.y + carSize.y * 0.58;
      if (!atCorner || !lowEnough) return;
      const name = object.name.toLowerCase();
      if (/tyre|tire/.test(name)) tireBoxes.push(bounds);
      else if (/wheel|rim|circle\.00[2-5]/.test(name) && !/wheelhouse|steering|hub/.test(name)) wheelBoxes.push(bounds);
      const expectedDiameter = config.wheelRadius * 2;
      const roundInProfile = Math.abs(size.y - size.z) < expectedDiameter * 0.42;
      const plausibleDiameter = size.y > expectedDiameter * 0.62 && size.y < expectedDiameter * 1.48;
      const plausibleWidth = size.x < expectedDiameter * 0.72;
      if (roundInProfile && plausibleDiameter && plausibleWidth) shapeBoxes.push(bounds);
    });
    const choose = (boxes, source) => boxes.length >= 2
      ? { y: Math.min(...boxes.map((bounds) => bounds.min.y)), source: `${source}:${boxes.length}` }
      : null;
    return choose(tireBoxes, 'tire')
      || choose(wheelBoxes, 'wheel')
      || choose(shapeBoxes, 'shape')
      || { y: overallBox.min.y, source: 'fallback-box' };
  }

  mergeStaticCarMeshes(model) {
    model.updateMatrixWorld(true);
    const sourceMeshes = [];
    let unsupported = false;
    model.traverse((object) => {
      if (!object.isMesh || !object.visible) return;
      if (object.isSkinnedMesh || object.morphTargetInfluences || Array.isArray(object.material)) unsupported = true;
      sourceMeshes.push(object);
    });
    if (unsupported || sourceMeshes.length < 8) return model;

    const batches = new Map();
    for (const mesh of sourceMeshes) {
      const geometry = mesh.geometry;
      const signature = `${Boolean(geometry.index)}|${Object.entries(geometry.attributes)
        .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`)
        .sort().join(',')}`;
      const key = `${mesh.material.uuid}|${signature}`;
      if (!batches.has(key)) batches.set(key, { material: mesh.material, geometries: [] });
      const clone = geometry.clone();
      clone.applyMatrix4(mesh.matrixWorld);
      batches.get(key).geometries.push(clone);
    }

    const optimized = new THREE.Group();
    optimized.name = `${model.name || 'car'}-batched`;
    for (const batch of batches.values()) {
      const geometry = batch.geometries.length > 1
        ? mergeGeometries(batch.geometries, false)
        : batch.geometries[0];
      if (!geometry) {
        for (const fallbackGeometry of batch.geometries) optimized.add(new THREE.Mesh(fallbackGeometry, batch.material));
        continue;
      }
      geometry.computeBoundingSphere();
      optimized.add(new THREE.Mesh(geometry, batch.material));
      if (batch.geometries.length > 1) {
        for (const sourceGeometry of batch.geometries) sourceGeometry.dispose();
      }
    }
    optimized.userData.sourceDrawCalls = sourceMeshes.length;
    optimized.userData.batchedDrawCalls = optimized.children.length;
    return optimized;
  }

  prepareCar(config, onProgress) {
    if (this.visualCache.has(config.id)) return Promise.resolve(this.visualCache.get(config.id));
    if (this.pendingVisuals.has(config.id)) return this.pendingVisuals.get(config.id);
    const carRequest = this.fetchCar(config, onProgress);
    let template;
    let pending;
    pending = carRequest.then((loadedTemplate) => {
      template = loadedTemplate;
      const normalized = this.normalizeCar(loadedTemplate, config);
      this.visualCache.set(config.id, normalized);
      // The batched visual is the canonical cached form. Keeping the thousands of
      // source meshes as well doubled memory and caused long garbage-collection
      // stalls after changing cars.
      if (this.carCache.get(config.id) === loadedTemplate) this.carCache.delete(config.id);
      if (this.pendingVisuals.get(config.id) === pending) this.pendingVisuals.delete(config.id);
      return normalized;
    }).catch((error) => {
      if (this.pendingVisuals.get(config.id) === pending) {
        this.pendingVisuals.delete(config.id);
        if (this.pendingCars.get(config.id) === carRequest) this.pendingCars.delete(config.id);
        if (this.carCache.get(config.id) === template) this.carCache.delete(config.id);
        // visualCache contains the shared canonical visual; leave it untouched.
      }
      throw error;
    });
    this.pendingVisuals.set(config.id, pending);
    return pending;
  }

  async instantiateCar(config, onProgress) {
    try {
      const prepared = await this.prepareCar(config, onProgress);
      const instance = prepared.clone(true);
      instance.userData.source = 'gltf';
      return instance;
    } catch (error) {
      console.warn(`Car model ${config.id} failed; using fallback`, error);
      const fallback = this.createFallback(config);
      const wrapper = new THREE.Group();
      fallback.position.y = -config.model.groundOffset;
      wrapper.add(fallback);
      wrapper.userData.configId = config.id;
      wrapper.userData.source = 'fallback';
      wrapper.userData.fallback = true;
      wrapper.userData.fallbackError = {
        name: error?.name ? String(error.name) : 'Error',
        message: error?.message ? String(error.message) : String(error),
      };
      return wrapper;
    }
  }

  preloadNeighbors(configs, index) {
    const neighbors = [index - 1, index + 1].map((value) => (value + configs.length) % configs.length);
    const schedule = globalThis.requestIdleCallback || ((callback) => setTimeout(callback, 220));
    for (const neighbor of neighbors) {
      const config = configs[neighbor];
      if (
        this.preloadScheduled.has(config.id)
        || this.carCache.has(config.id)
        || this.pendingCars.has(config.id)
        || this.visualCache.has(config.id)
        || this.pendingVisuals.has(config.id)
      ) continue;
      this.preloadScheduled.add(config.id);
      schedule(() => {
        if (
          this.carCache.has(config.id)
          || this.pendingCars.has(config.id)
          || this.visualCache.has(config.id)
          || this.pendingVisuals.has(config.id)
        ) {
          this.preloadScheduled.delete(config.id);
          return;
        }
        fetch(`/cars/${config.file}`, { cache: 'force-cache' })
          .catch(() => {})
          .finally(() => this.preloadScheduled.delete(config.id));
      });
    }
  }

  async loadScenery() {
    const candidates = [
      [-515, -300], [-505, 160], [-180, -425], [135, -430], [505, -280], [505, 145],
    ];
    const bodyMaterial = new THREE.MeshLambertMaterial({ color: 0x7f8588 });
    const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x203746, metalness: 0.18, roughness: 0.22 });
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const bodies = new THREE.InstancedMesh(unitBox, bodyMaterial, candidates.length);
    const windows = new THREE.InstancedMesh(unitBox, glassMaterial, candidates.length);
    const dummy = new THREE.Object3D();
    let added = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const [x, z] = candidates[i];
      const position = new THREE.Vector3(x, 0, z);
      if (!this.track.isSafeSceneryPosition(position, 58)) continue;
      const width = 34 + (i % 3) * 8;
      const depth = 28 + (i % 2) * 9;
      const height = 42 + (i % 4) * 11;
      const yaw = Math.atan2(-x, -z);
      dummy.position.set(x, height * 0.5, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(width, height, depth);
      dummy.updateMatrix();
      bodies.setMatrixAt(added, dummy.matrix);
      const towardTrack = new THREE.Vector3(-x, 0, -z).normalize();
      dummy.position.set(x, height * 0.58, z).addScaledVector(towardTrack, depth * 0.5 + 0.18);
      dummy.scale.set(width * 0.82, height * 0.34, 0.32);
      dummy.updateMatrix();
      windows.setMatrixAt(added, dummy.matrix);
      added += 1;
    }
    bodies.count = added;
    windows.count = added;
    bodies.instanceMatrix.needsUpdate = true;
    windows.instanceMatrix.needsUpdate = true;
    bodies.receiveShadow = true;
    this.cityGroup.add(bodies, windows);
    return added;
  }
}
