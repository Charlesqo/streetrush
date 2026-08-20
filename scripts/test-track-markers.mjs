import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TRACK_CONFIG } from '../src/config.js';
import { TrackSystem } from '../src/track.js';

function makeMarker(index) {
  const group = {
    scale: {
      value: null,
      setScalar(value) {
        this.value = value;
      },
    },
  };
  const inactiveMaterial = { id: `inactive-${index}` };
  const activeMaterial = { id: `active-${index}` };
  const meshes = [{ material: inactiveMaterial }, { material: inactiveMaterial }];
  return { index, group, meshes, inactiveMaterial, activeMaterial };
}

const gate = makeMarker(0);
const regularMarkers = Array.from({ length: 9 }, (_, index) => makeMarker(index + 1));
const markers = { checkpointMarkers: [gate, ...regularMarkers] };

function assertMarkerState(marker, active) {
  assert.equal(marker.group.scale.value, active ? 1.08 : 1);
  const expectedMaterial = active ? marker.activeMaterial : marker.inactiveMaterial;
  assert.deepEqual(marker.meshes.map(({ material }) => material), [expectedMaterial, expectedMaterial]);
}

TrackSystem.prototype.setCheckpointHighlight.call(markers, 2);
assertMarkerState(gate, false);
for (const marker of regularMarkers) assertMarkerState(marker, marker.index === 2);

TrackSystem.prototype.setCheckpointHighlight.call(markers, 0);
assertMarkerState(gate, true);
for (const marker of regularMarkers) assertMarkerState(marker, false);

TrackSystem.prototype.setCheckpointHighlight.call(markers, null);
for (const marker of markers.checkpointMarkers) assertMarkerState(marker, false);

console.log('PASS checkpoint highlight activates checkpoint 0 gate and keeps markers mutually exclusive');

const curve = new THREE.CatmullRomCurve3(
  TRACK_CONFIG.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true,
  'catmullrom',
  0.2,
);
const resetTrack = {
  config: TRACK_CONFIG,
  curve,
  length: curve.getLength(),
  lastIndex: 0,
  surfaceForOffset: TrackSystem.prototype.surfaceForOffset,
  samples: Array.from({ length: TRACK_CONFIG.samples }, (_, index) => {
    const t = index / TRACK_CONFIG.samples;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
    return { index, t, point, tangent, side };
  }),
};
const startPose = TrackSystem.prototype.getResetPose.call(resetTrack, 0);
const straightAhead = startPose.position.clone().add(new THREE.Vector3(
  Math.sin(startPose.yaw) * 100,
  0,
  Math.cos(startPose.yaw) * 100,
));
const straightInfo = TrackSystem.prototype.nearestInfo.call(resetTrack, straightAhead, 0);
assert.ok(
  Math.abs(straightInfo.offset) <= TRACK_CONFIG.width * 0.5,
  `start heading leaves the ${TRACK_CONFIG.width}m track after 100m: offset=${straightInfo.offset.toFixed(2)}m`,
);
console.log(`PASS start heading stays on track after 100m offset=${straightInfo.offset.toFixed(2)}m`);
