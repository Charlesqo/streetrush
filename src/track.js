import { kerbAt, KERB_WIDTH, pavedRunoffAt } from './longwan-layout.js';
import { installTrackKerbs } from './track-kerbs.js';
import { buildCircuitEnvironment } from './track-environment.js';
import * as THREE from 'three';
import { SURFACES } from './config.js';
import { createAsphaltMaterial } from './rendering.js';

const V3 = () => new THREE.Vector3();

const GUIDANCE_KINDS = new Set(['brake', 'turn']);
export const ROUTE_MARKER_MAX_LATERAL_OFFSET = 9.2;
const START_HEADING_LOOKAHEAD_METERS = 60;

function wrapProgress(value) {
  return ((value % 1) + 1) % 1;
}

function markerSideFor(event) {
  if (event.markerSide === 'left' || event.markerSide === 'right') return event.markerSide;
  if (event.kind === 'turn') return event.direction === 'left' ? 'right' : 'left';
  return event.ordinal % 2 === 0 ? 'right' : 'left';
}

export function normalizeRouteGuidance(config, trackLength = 1, sampleCount = config?.samples ?? 1) {
  const source = config?.routeGuidance ?? config?.guidance ?? config ?? {};
  const length = Number.isFinite(trackLength) && trackLength > 0 ? trackLength : 1;
  const count = Math.max(1, Math.floor(Number.isFinite(sampleCount) ? sampleCount : 1));
  const events = [];
  const append = (items, kind) => {
    if (!Array.isArray(items)) return;
    items.forEach((item, sourceIndex) => {
      if (!item || typeof item !== 'object') return;
      const rawProgress = Number.isFinite(item.progress)
        ? item.progress
        : Number.isFinite(item.t)
          ? item.t
          : Number.isFinite(item.distance)
            ? item.distance / length
            : Number.isFinite(item.sampleIndex)
              ? item.sampleIndex / count
              : null;
      if (!Number.isFinite(rawProgress)) return;
      const direction = kind === 'turn' ? String(item.direction ?? '').toLowerCase() : null;
      if (kind === 'turn' && !['left', 'right'].includes(direction)) return;
      const progress = wrapProgress(rawProgress);
      events.push({
        ...item,
        id: item.id ?? `${kind}-${String(sourceIndex + 1).padStart(2, '0')}`,
        kind,
        progress,
        t: progress,
        sampleIndex: Math.round(progress * count) % count,
        distance: progress * length,
        direction,
        label: item.label ?? (kind === 'brake' ? 'BRAKE' : direction.toUpperCase()),
        markerSide: item.markerSide ?? item.side ?? null,
      });
    });
  };

  append(source.brakePoints, 'brake');
  append(source.turns, 'turn');
  return events
    .filter((event) => GUIDANCE_KINDS.has(event.kind))
    .sort((a, b) => {
      if (a.progress !== b.progress) return a.progress - b.progress;
      if (a.kind === b.kind) return 0;
      return a.kind === 'brake' ? -1 : 1;
    })
    .map((event, ordinal) => ({ ...event, ordinal }));
}

export function resolveRouteMarkerOffset(config = {}) {
  const guidance = config?.routeGuidance ?? config?.guidance ?? config ?? {};
  const markerConfig = guidance.markers ?? {};
  const halfWidth = Number.isFinite(config?.width) ? Math.max(0, config.width * 0.5) : 0;
  const runoff = Number.isFinite(config?.runoff) ? Math.max(0, config.runoff) : 0;
  const barrierOffset = Number.isFinite(config?.barrierOffset) ? config.barrierOffset : halfWidth + runoff;
  const minimum = halfWidth + Math.min(0.25, runoff);
  const maximum = Math.min(
    halfWidth + runoff,
    barrierOffset - 2.4,
    ROUTE_MARKER_MAX_LATERAL_OFFSET,
  );
  const safeMaximum = Math.max(minimum, maximum);
  const requested = Number.isFinite(markerConfig.lateralOffset) ? markerConfig.lateralOffset : safeMaximum;
  return Math.min(safeMaximum, Math.max(minimum, requested));
}

function createGuidanceSignGeometry(type) {
  if (type === 'brake') return new THREE.BoxGeometry(1, 1, 1);
  const directionSign = type === 'left' ? -1 : 1;
  const shape = new THREE.Shape();
  const points = [
    [-0.58, -0.15], [0.05, -0.15], [0.05, -0.42], [0.58, 0],
    [0.05, 0.42], [0.05, 0.15], [-0.58, 0.15],
  ].map(([x, y]) => [x * directionSign, y]);
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.center();
  return geometry;
}

export class TrackSystem {
  constructor(config, scene, renderer, RAPIER, physicsWorld) {
    this.config = config;
    this.scene = scene;
    this.renderer = renderer;
    this.RAPIER = RAPIER;
    this.physicsWorld = physicsWorld;
    this.group = new THREE.Group();
    this.group.name = 'gp-track';
    scene.add(this.group);
    this.curve = new THREE.CatmullRomCurve3(
      config.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      true,
      'catmullrom',
      0.2,
    );
    this.length = this.curve.getLength();
    this.samples = Array.from({ length: config.samples }, (_, index) => {
      const t = index / config.samples;
      const point = this.curve.getPointAt(t);
      const tangent = this.curve.getTangentAt(t).normalize();
      const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
      return { index, t, point, tangent, side };
    });
    this.lastIndex = 0;
    this.checkpointIndices = Array.from({ length: config.checkpoints }, (_, index) => Math.floor(index / config.checkpoints * config.samples));
    this.routeGuidance = normalizeRouteGuidance(config, this.length, this.samples.length);
    this.routeGuidanceMarkers = null;
    this.checkpointMarkers = [];
    this.startLights = [];
    this.buildVisuals();
    this.buildPhysics();
  }

  pointAt(t, offset = 0) {
    const wrapped = ((t % 1) + 1) % 1;
    const point = this.curve.getPointAt(wrapped);
    const tangent = this.curve.getTangentAt(wrapped).normalize();
    const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
    point.addScaledVector(side, offset);
    return { point, tangent, side, t: wrapped };
  }

  nearestInfo(position, hint = this.lastIndex) {
    const count = this.samples.length;
    let bestIndex = hint == null ? 0 : ((hint % count) + count) % count;
    let bestDistSq = Infinity;
    const inspect = (index) => {
      const sample = this.samples[(index + count) % count];
      const dx = position.x - sample.point.x;
      const dz = position.z - sample.point.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < bestDistSq) {
        bestDistSq = distanceSq;
        bestIndex = sample.index;
      }
    };
    if (hint == null) {
      for (let i = 0; i < count; i += 1) inspect(i);
    } else {
      for (let delta = -48; delta <= 48; delta += 1) inspect(hint + delta);
      if (bestDistSq > 80 * 80) {
        bestDistSq = Infinity;
        for (let i = 0; i < count; i += 1) inspect(i);
      }
    }
    this.lastIndex = bestIndex;
    const best = this.samples[bestIndex];
    const offset = (position.x - best.point.x) * best.side.x + (position.z - best.point.z) * best.side.z;
    const surface = this.surfaceForOffset(offset, best.t);
    return { ...best, offset, distance: Math.sqrt(bestDistSq), surface };
  }

  surfaceForOffset(offset, progress = 0) {
    const distance = Math.abs(offset);
    if (distance <= this.config.width * 0.5) return 'asphalt';
    if (this.config.kerbSections) {
      if (distance <= this.config.width*.5+KERB_WIDTH && kerbAt(this.config.kerbSections,progress,Math.sign(offset))) return 'kerb';
      if (this.config.sceneryLayout==='longwan-v1' && pavedRunoffAt(progress) && distance<=this.config.width*.5+this.config.runoff) return 'asphalt';
    } else if (distance <= this.config.width * 0.5 + 1.05) return 'kerb';
    if (distance <= this.config.width * 0.5 + this.config.runoff) return 'gravel';
    return 'grass';
  }

  getSurface(position, hint) {
    const info = this.nearestInfo(position, hint);
    return { ...SURFACES[info.surface], id: info.surface, info };
  }

  getRouteGuidance() {
    return this.routeGuidance.map((event) => ({ ...event }));
  }

  getUpcomingGuidance(sampleIndex = this.lastIndex, limit = 1) {
    if (this.routeGuidance.length === 0) return [];
    const count = this.samples.length;
    const currentProgress = wrapProgress((Number.isFinite(sampleIndex) ? sampleIndex : 0) / count);
    const result = this.routeGuidance
      .map((event) => {
        const progressAhead = wrapProgress(event.progress - currentProgress);
        return { ...event, distanceAhead: progressAhead * this.length };
      })
      .sort((a, b) => a.distanceAhead - b.distanceAhead);
    return result.slice(0, Math.max(0, Math.floor(limit)));
  }

  getNextGuidance(sampleIndex = this.lastIndex) {
    return this.getUpcomingGuidance(sampleIndex, 1)[0] ?? null;
  }

  getResetPose(sampleIndex = 0) {
    const sample = this.samples[((sampleIndex % this.samples.length) + this.samples.length) % this.samples.length];
    let heading = sample.tangent;
    const [startPoint, nextPoint] = this.config.points ?? [];
    const startDirection = startPoint && nextPoint
      ? new THREE.Vector3().fromArray(nextPoint).sub(new THREE.Vector3().fromArray(startPoint)).setY(0)
      : null;
    if (sample.index === 0 && startDirection?.lengthSq() > 1e-8) {
      // Align the grid to its authored first straight. The closed spline's last
      // corner bends even the 60 m lookahead slightly toward the previous turn.
      heading = startDirection.normalize();
    } else if (sample.index === 0 && this.samples.length > 1) {
      const metresPerSample = this.length / this.samples.length;
      const lookahead = Math.max(1, Math.round(START_HEADING_LOOKAHEAD_METERS / metresPerSample));
      const target = this.samples[lookahead % this.samples.length];
      const forward = target.point.clone().sub(sample.point);
      forward.y = 0;
      if (forward.lengthSq() > 1e-8) heading = forward.normalize();
    }
    return {
      position: sample.point.clone().add(new THREE.Vector3(0, 0.78, 0)),
      yaw: Math.atan2(heading.x, heading.z),
      sampleIndex: sample.index,
    };
  }

  isSafeSceneryPosition(position, clearance = 44) {
    return this.nearestInfo(position, null).distance > clearance;
  }

  createStrip(halfWidth, y, material) {
    const positions = [];
    const uvs = [];
    const indices = [];
    let textureDistance = 0;
    const previousPoint = new THREE.Vector3();
    for (let i = 0; i <= this.config.samples; i += 1) {
      const sample = this.pointAt(i / this.config.samples);
      const left = sample.point.clone().addScaledVector(sample.side, -halfWidth);
      const right = sample.point.clone().addScaledVector(sample.side, halfWidth);
      positions.push(left.x, left.y + y, left.z, right.x, right.y + y, right.z);
      // Measure the actual rendered centreline: curve arc-length lookup is
      // approximate, and its raw parameter spacing stretches short corners.
      if (i > 0) textureDistance += previousPoint.distanceTo(sample.point);
      previousPoint.copy(sample.point);
      const u = textureDistance / 12;
      uvs.push(u, 0, u, 1);
      if (i < this.config.samples) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  createBand(innerHalfWidth, outerHalfWidth, y, material) {
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= this.config.samples; i += 1) {
      const sample = this.pointAt(i / this.config.samples);
      const leftOuter = sample.point.clone().addScaledVector(sample.side, -outerHalfWidth);
      const leftInner = sample.point.clone().addScaledVector(sample.side, -innerHalfWidth);
      const rightInner = sample.point.clone().addScaledVector(sample.side, innerHalfWidth);
      const rightOuter = sample.point.clone().addScaledVector(sample.side, outerHalfWidth);
      for (const point of [leftOuter, leftInner, rightInner, rightOuter]) positions.push(point.x, point.y + y, point.z);
      const u = i / this.config.samples * this.length / 12;
      uvs.push(u, 0, u, 1, u, 0, u, 1);
      if (i < this.config.samples) {
        const a = i * 4;
        indices.push(a, a + 4, a + 1, a + 4, a + 5, a + 1);
        indices.push(a + 2, a + 6, a + 3, a + 6, a + 7, a + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  setStartLights(state = 'off') {
    const activeCount = state === 'ready'
      ? this.startLights.length
      : state === 'three'
        ? 3
        : state === 'two'
          ? 2
          : state === 'one'
            ? 1
            : 0;
    for (let index = 0; index < this.startLights.length; index += 1) {
      const light = this.startLights[index];
      const go = state === 'go';
      const active = index < activeCount;
      light.material.color.setHex(go ? 0x64ff6a : active ? 0xff2e24 : 0x301819);
      light.material.emissive.setHex(go ? 0x28ff35 : active ? 0xff160d : 0x000000);
      light.material.emissiveIntensity = go ? 3.4 : active ? 2.8 : 0;
    }
  }

  setCheckpointHighlight(expectedCheckpointIndex = null) {
    for (const marker of this.checkpointMarkers) {
      const active = marker.index === expectedCheckpointIndex;
      for (const mesh of marker.meshes) mesh.material = active ? marker.activeMaterial : marker.inactiveMaterial;
      marker.group.scale.setScalar(active ? 1.08 : 1);
    }
  }

  buildVisuals() {
    const textureLoader = new THREE.TextureLoader();
    const base = '/textures/';
    const dirtMap = textureLoader.load(`${base}T_Dirt_BaseColor.png`);
    for (const texture of [dirtMap]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    }
    dirtMap.colorSpace = THREE.SRGBColorSpace;
    dirtMap.repeat.set(36, 36);

    const roadMaterial = createAsphaltMaterial(this.renderer, this.config.width);
    const runoffMaterial = new THREE.MeshStandardMaterial({ color: 0x777468, roughness: 0.95 });
    this.group.add(this.createBand(this.config.width * 0.5 + 0.04, this.config.width * 0.5 + this.config.runoff, 0.005, runoffMaterial));
    this.group.add(this.createStrip(this.config.width * 0.5, 0.015, roadMaterial));

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(this.config.groundHalfExtent ?? 850, 160),
      new THREE.MeshStandardMaterial({ map: dirtMap, color: 0xa7b18a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    this.group.add(ground);

    const segmentCount = 384;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const curbRed = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xb92429, roughness: 0.78 }), segmentCount);
    const curbWhite = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xe8e5dc, roughness: 0.82 }), segmentCount);
    const edgeLines = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xf0eee7, roughness: 0.75 }), segmentCount * 2);
    const barriers = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x9da2a6, roughness: 0.38, metalness: 0.72 }), segmentCount * 2);
    const dummy = new THREE.Object3D();
    const segmentLength = this.length / segmentCount * 0.96;
    let redIndex = 0;
    let whiteIndex = 0;
    let edgeIndex = 0;
    let barrierIndex = 0;
    for (let i = 0; i < segmentCount; i += 1) {
      const { point, tangent, side } = this.pointAt(i / segmentCount);
      const yaw = Math.atan2(tangent.x, tangent.z);
      for (const sign of [-1, 1]) {
        dummy.position.copy(point).addScaledVector(side, sign * (this.config.width * 0.5 + 0.32));
        dummy.position.y += 0.06;
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(0.78, 0.12, segmentLength);
        dummy.updateMatrix();
        if (!this.config.kerbSections) {
          if (i % 2) curbRed.setMatrixAt(redIndex++, dummy.matrix);
          else curbWhite.setMatrixAt(whiteIndex++, dummy.matrix);
        }

        dummy.position.copy(point).addScaledVector(side, sign * (this.config.width * 0.5 - 0.22));
        dummy.position.y += 0.028;
        dummy.scale.set(0.11, 0.025, segmentLength);
        dummy.updateMatrix();
        edgeLines.setMatrixAt(edgeIndex++, dummy.matrix);

        dummy.position.copy(point).addScaledVector(side, sign * this.config.barrierOffset);
        dummy.position.y += 0.72;
        dummy.scale.set(0.24, 1.45, segmentLength);
        dummy.updateMatrix();
        barriers.setMatrixAt(barrierIndex++, dummy.matrix);
      }
    }
    curbRed.count=redIndex;curbWhite.count=whiteIndex;
    this.legacyBoundaryMeshes={curbRed,curbWhite,edgeLines,barriers};
    for (const mesh of [curbRed, curbWhite, edgeLines, barriers]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    const checkpointPostGeometry = new THREE.BoxGeometry(0.14, 3.6, 0.14);
    const checkpointBeamGeometry = new THREE.BoxGeometry(this.config.width - 1.4, 0.16, 0.16);
    const checkpointInactiveMaterial = new THREE.MeshStandardMaterial({
      color: 0x4ca7b8, emissive: 0x072a36, emissiveIntensity: 0.35, transparent: true, opacity: 0.58,
      roughness: 0.38, metalness: 0.18,
    });
    const checkpointActiveMaterial = new THREE.MeshStandardMaterial({
      color: 0xebff00, emissive: 0x9eb500, emissiveIntensity: 2.3, roughness: 0.3, metalness: 0.2,
    });
    this.checkpointIndices.forEach((sampleIndex, checkpoint) => {
      if (checkpoint !== 0) return;
      const sample = this.samples[sampleIndex];
      const gate = new THREE.Group();
      gate.name = 'checkpoint-00';
      gate.userData.checkpointIndex = 0;
      gate.position.copy(sample.point);
      gate.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
      const gateMeshes = [];
      for (const x of [-this.config.width * 0.5 + 0.6, this.config.width * 0.5 - 0.6]) {
        const post = new THREE.Mesh(checkpointPostGeometry, checkpointInactiveMaterial);
        post.position.set(x, 2.6, 0);
        post.scale.set(0.16 / 0.14, 5.2 / 3.6, 0.16 / 0.14);
        gateMeshes.push(post);
        gate.add(post);
      }
      const beam = new THREE.Mesh(checkpointBeamGeometry, checkpointInactiveMaterial);
      beam.position.y = 5.05;
      beam.scale.set(
        (this.config.width - 1) / (this.config.width - 1.4),
        0.3 / 0.16,
        0.3 / 0.16,
      );
      gateMeshes.push(beam);
      gate.add(beam);
      const banner = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.78, 0.14), new THREE.MeshStandardMaterial({ color: 0xd8bf28, roughness: 0.48 }));
      banner.position.y = 4.8;
      gate.add(banner);
      const lightHousing = new THREE.Mesh(
        new THREE.BoxGeometry(4.4, 0.78, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x101318, metalness: 0.35, roughness: 0.55 }),
      );
      lightHousing.position.set(0, 4.05, 0);
      gate.add(lightHousing);
      const lightGeometry = new THREE.SphereGeometry(0.23, 16, 10);
      for (let index = 0; index < 5; index += 1) {
        const light = new THREE.Mesh(
          lightGeometry,
          new THREE.MeshStandardMaterial({
            color: 0x301819,
            emissive: 0x000000,
            emissiveIntensity: 0,
            roughness: 0.28,
          }),
        );
        light.position.set((index - 2) * 0.78, 4.05, 0.24);
        gate.add(light);
        this.startLights.push(light);
      }
      this.checkpointMarkers.push({
        index: 0,
        group: gate,
        meshes: gateMeshes,
        inactiveMaterial: checkpointInactiveMaterial,
        activeMaterial: checkpointActiveMaterial,
      });
      this.group.add(gate);
    });
    this.checkpointIndices.forEach((sampleIndex, checkpoint) => {
      if (checkpoint === 0) return;
      const sample = this.samples[sampleIndex];
      const marker = new THREE.Group();
      marker.name = `checkpoint-${String(checkpoint).padStart(2, '0')}`;
      marker.position.copy(sample.point);
      marker.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
      const meshes = [];
      for (const x of [-this.config.width * 0.5 + 0.7, this.config.width * 0.5 - 0.7]) {
        const post = new THREE.Mesh(checkpointPostGeometry, checkpointInactiveMaterial);
        post.position.set(x, 1.8, 0);
        meshes.push(post);
        marker.add(post);
      }
      const beam = new THREE.Mesh(checkpointBeamGeometry, checkpointInactiveMaterial);
      beam.position.y = 3.48;
      meshes.push(beam);
      marker.add(beam);
      marker.userData.checkpointIndex = checkpoint;
      this.checkpointMarkers.push({
        index: checkpoint,
        group: marker,
        meshes,
        inactiveMaterial: checkpointInactiveMaterial,
        activeMaterial: checkpointActiveMaterial,
      });
      this.group.add(marker);
    });
    this.setCheckpointHighlight(null);
    this.setStartLights('off');
    this.buildTrackFurniture();
    this.buildRouteGuidanceMarkers();
    if(this.config.sceneryLayout==='longwan-v1')buildCircuitEnvironment(this);
  }

  buildRouteGuidanceMarkers() {
    const markerConfig = this.config.routeGuidance?.markers ?? {};
    const configuredEvents = Array.isArray(this.routeGuidance) ? this.routeGuidance : [];
    const events = configuredEvents.map((event) => ({ ...event, markerSide: markerSideFor(event) }));
    this.routeGuidanceMarkers = { poles: null, signs: {}, events };
    if (markerConfig.enabled === false || events.length === 0) return;

    const lateralOffset = resolveRouteMarkerOffset(this.config);
    const poleHeight = Number.isFinite(markerConfig.poleHeight) ? markerConfig.poleHeight : 2.2;
    const boardWidth = Number.isFinite(markerConfig.boardWidth) ? markerConfig.boardWidth : 1.9;
    const boardHeight = Number.isFinite(markerConfig.boardHeight) ? markerConfig.boardHeight : 0.9;
    const boardDepth = Number.isFinite(markerConfig.boardDepth) ? markerConfig.boardDepth : 0.12;
    const grouped = { brake: [], left: [], right: [] };
    for (const event of events) {
      const type = event.kind === 'brake' ? 'brake' : event.direction;
      if (grouped[type]) grouped[type].push(event);
    }
    const visibleEvents = Object.values(grouped).flat().filter((event) => this.samples[event.sampleIndex]);
    if (visibleEvents.length === 0) return;

    const poleGeometry = new THREE.BoxGeometry(1, 1, 1);
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x343a40, metalness: 0.68, roughness: 0.42 });
    const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, visibleEvents.length);
    poles.name = 'route-guidance-poles';
    poles.userData.routeGuidance = true;
    poles.castShadow = false;
    poles.receiveShadow = false;

    const signMaterials = {
      brake: new THREE.MeshStandardMaterial({ color: 0xff633f, emissive: 0x5c160a, emissiveIntensity: 0.7, roughness: 0.48, side: THREE.DoubleSide }),
      left: new THREE.MeshStandardMaterial({ color: 0x4ed7ff, emissive: 0x0b4e68, emissiveIntensity: 0.55, roughness: 0.48, side: THREE.DoubleSide }),
      right: new THREE.MeshStandardMaterial({ color: 0xebff00, emissive: 0x727f00, emissiveIntensity: 0.55, roughness: 0.48, side: THREE.DoubleSide }),
    };
    const signGeometries = {
      brake: createGuidanceSignGeometry('brake'),
      left: createGuidanceSignGeometry('left'),
      right: createGuidanceSignGeometry('right'),
    };
    const signs = {};
    for (const [type, typeEvents] of Object.entries(grouped)) {
      if (typeEvents.length === 0) continue;
      const sign = new THREE.InstancedMesh(signGeometries[type], signMaterials[type], typeEvents.length);
      sign.name = `route-guidance-${type}`;
      sign.userData.routeGuidance = true;
      sign.userData.routeGuidanceKind = type;
      sign.userData.routeGuidanceShape = type === 'brake' ? 'panel' : 'arrow';
      sign.userData.routeGuidanceDirection = type === 'brake' ? null : type;
      sign.userData.routeGuidanceIds = typeEvents.map((event) => event.id);
      sign.castShadow = false;
      sign.receiveShadow = false;
      signs[type] = sign;
    }

    const dummy = new THREE.Object3D();
    const signIndices = { brake: 0, left: 0, right: 0 };
    visibleEvents.forEach((event, poleIndex) => {
      const sample = this.samples[event.sampleIndex];
      if (!sample) return;
      const sideSign = event.markerSide === 'left' ? -1 : 1;
      const position = sample.point.clone().addScaledVector(sample.side, sideSign * lateralOffset);
      const yaw = Math.atan2(sample.tangent.x, sample.tangent.z);

      dummy.position.copy(position);
      dummy.position.y = poleHeight * 0.5;
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(0.1, poleHeight, 0.1);
      dummy.updateMatrix();
      poles.setMatrixAt(poleIndex, dummy.matrix);

      const type = event.kind === 'brake' ? 'brake' : event.direction;
      const sign = signs[type];
      if (!sign) return;
      dummy.position.y = poleHeight + boardHeight * 0.5 - 0.04;
      dummy.scale.set(boardWidth, boardHeight, boardDepth);
      dummy.updateMatrix();
      sign.setMatrixAt(signIndices[type]++, dummy.matrix);
    });
    poles.instanceMatrix.needsUpdate = true;
    for (const sign of Object.values(signs)) sign.instanceMatrix.needsUpdate = true;
    this.routeGuidanceMarkers = { poles, signs, events };
    this.group.add(poles, ...Object.values(signs));
  }

  buildTrackFurniture() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x343a40, metalness: 0.72, roughness: 0.38 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x253b4c, metalness: 0.22, roughness: 0.16 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb6b3aa, roughness: 0.88 });
    const gridMaterial = new THREE.MeshStandardMaterial({ color: 0xf1efe7, roughness: 0.75 });

    const gridGeometry = new THREE.BoxGeometry(5.2, 0.018, 0.16);
    for (let row = 0; row < 10; row += 1) {
      const line = new THREE.Mesh(gridGeometry, gridMaterial);
      line.position.set(-275 + row * 9.5, 0.035, row % 2 ? 2.2 : -2.2);
      line.rotation.y = Math.PI / 2;
      this.group.add(line);
    }

    const finish = this.pointAt(0);
    const finishYaw = Math.atan2(finish.tangent.x, finish.tangent.z);
    const finishSquare = new THREE.BoxGeometry(this.config.width / 12, 0.022, 0.46);
    const finishWhite = new THREE.MeshStandardMaterial({ color: 0xf4f1e7, roughness: 0.72 });
    const finishDark = new THREE.MeshStandardMaterial({ color: 0x121519, roughness: 0.76 });
    const finishWhiteSquares = new THREE.InstancedMesh(finishSquare, finishWhite, 12);
    const finishDarkSquares = new THREE.InstancedMesh(finishSquare, finishDark, 12);
    const finishDummy = new THREE.Object3D();
    let finishWhiteIndex = 0;
    let finishDarkIndex = 0;
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        finishDummy.position.copy(finish.point)
          .addScaledVector(finish.side, (column + 0.5) * this.config.width / 12 - this.config.width * 0.5)
          .addScaledVector(finish.tangent, (row - 0.5) * 0.46);
        finishDummy.position.y += 0.048;
        finishDummy.rotation.set(0, finishYaw, 0);
        finishDummy.updateMatrix();
        if ((row + column) % 2) finishDarkSquares.setMatrixAt(finishDarkIndex++, finishDummy.matrix);
        else finishWhiteSquares.setMatrixAt(finishWhiteIndex++, finishDummy.matrix);
      }
    }
    finishWhiteSquares.instanceMatrix.needsUpdate = true;
    finishDarkSquares.instanceMatrix.needsUpdate = true;
    this.group.add(finishWhiteSquares, finishDarkSquares);

    const pit = new THREE.Group();
    pit.position.set(-30, 0, 31);
    const base = new THREE.Mesh(new THREE.BoxGeometry(245, 7.5, 13), concrete);
    base.position.y = 3.75;
    base.receiveShadow = true;
    pit.add(base);
    const windowBand = new THREE.Mesh(new THREE.BoxGeometry(238, 2.15, 0.28), glass);
    windowBand.position.set(0, 5.2, -6.58);
    pit.add(windowBand);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(252, 0.28, 5.5), metal);
    canopy.position.set(0, 7.65, -5.4);
    pit.add(canopy);
    for (let i = -5; i <= 5; i += 1) {
      const garage = new THREE.Mesh(new THREE.BoxGeometry(0.18, 4.2, 0.25), metal);
      garage.position.set(i * 20.5, 2.2, -6.7);
      pit.add(garage);
    }
    if(this.config.sceneryLayout!=='longwan-v1')this.group.add(pit);

    const poleCount = 28;
    const poleGeometry = new THREE.CylinderGeometry(0.08, 0.11, 1, 8);
    const lampGeometry = new THREE.BoxGeometry(1, 1, 1);
    const poles = new THREE.InstancedMesh(poleGeometry, metal, poleCount);
    const lamps = new THREE.InstancedMesh(lampGeometry, new THREE.MeshStandardMaterial({ color: 0xd7d9cf, emissive: 0x6e7255, emissiveIntensity: 0.2, roughness: 0.38 }), poleCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < poleCount; i += 1) {
      const sample = this.pointAt(i / poleCount);
      const sign = i % 2 ? 1 : -1;
      const position = sample.point.clone().addScaledVector(sample.side, sign * (this.config.barrierOffset + 3.2));
      dummy.position.copy(position);
      dummy.position.y = 4.25;
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 8.5, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 8.52;
      dummy.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
      dummy.scale.set(1.2, 0.18, 0.42);
      dummy.updateMatrix();
      lamps.setMatrixAt(i, dummy.matrix);
    }
    poles.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    this.group.add(poles, lamps);
  }

  buildPhysics() {
    const RAPIER = this.RAPIER;
    const groundHalfExtent = this.config.groundHalfExtent ?? 850;
    const groundBody = this.physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.33, 0));
    this.physicsWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(groundHalfExtent, 0.33, groundHalfExtent).setFriction(0.15).setRestitution(0),
      groundBody,
    );

    // All barriers belong to one static body. Hundreds of separate rigid bodies made
    // the broad phase needlessly expensive even though none of them ever move.
    for(const mesh of this.kerbMeshes??[]) {
      this.physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(mesh.geometry.attributes.position.array, Uint32Array.from(mesh.geometry.index.array)).setTranslation(0,.33,0).setFriction(.8).setRestitution(0),groundBody);
    }
    const barrierBody = this.physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const colliderSegments = 192;
    const halfLength = this.length / colliderSegments * 0.51;
    for (let i = 0; i < colliderSegments; i += 1) {
      const { point, tangent, side } = this.pointAt(i / colliderSegments);
      const yaw = Math.atan2(tangent.x, tangent.z);
      const rotation = { x: 0, y: Math.sin(yaw * 0.5), z: 0, w: Math.cos(yaw * 0.5) };
      for (const sign of [-1, 1]) {
        const position = point.clone().addScaledVector(side, sign * this.config.barrierOffset);
        this.physicsWorld.createCollider(
          RAPIER.ColliderDesc.cuboid(0.18, 0.75, halfLength)
            .setTranslation(position.x, 0.75, position.z)
            .setRotation(rotation)
            .setFriction(0.35)
            .setRestitution(0.04),
          barrierBody,
        );
      }
    }
  }
}
