import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ROUTE_GUIDANCE, TRACK_CONFIG } from '../src/config.js';
import {
  normalizeRouteGuidance,
  resolveRouteMarkerOffset,
  ROUTE_MARKER_MAX_LATERAL_OFFSET,
  TrackSystem,
} from '../src/track.js';

const trackLength = 2129.954296679656;
const guidance = normalizeRouteGuidance(TRACK_CONFIG, trackLength, TRACK_CONFIG.samples);
const brakePoints = guidance.filter((event) => event.kind === 'brake');
const turns = guidance.filter((event) => event.kind === 'turn');

assert.equal(brakePoints.length, ROUTE_GUIDANCE.brakePoints.length);
assert.equal(turns.length, ROUTE_GUIDANCE.turns.length);
assert.deepEqual(new Set(turns.map((event) => event.direction)), new Set(['left', 'right']));
assert.ok(guidance.every((event) => event.progress >= 0 && event.progress < 1));
assert.ok(guidance.every((event) => event.sampleIndex >= 0 && event.sampleIndex < TRACK_CONFIG.samples));
assert.ok(guidance.every((event) => event.distance >= 0 && event.distance < trackLength));

const halfWidth = TRACK_CONFIG.width * 0.5;
const runoffOuterEdge = halfWidth + TRACK_CONFIG.runoff;
const configuredMarkerOffset = TRACK_CONFIG.routeGuidance.markers.lateralOffset;
assert.ok(configuredMarkerOffset > halfWidth, 'guidance signs stay outside the asphalt');
assert.ok(configuredMarkerOffset <= runoffOuterEdge, 'guidance signs stay inside the runoff');
assert.ok(configuredMarkerOffset <= ROUTE_MARKER_MAX_LATERAL_OFFSET, 'guidance signs stay before the barrier-safe cap');
assert.equal(resolveRouteMarkerOffset(TRACK_CONFIG), configuredMarkerOffset);
const clampedConfig = {
  ...TRACK_CONFIG,
  routeGuidance: {
    ...TRACK_CONFIG.routeGuidance,
    markers: { ...TRACK_CONFIG.routeGuidance.markers, lateralOffset: 14.4 },
  },
};
assert.ok(resolveRouteMarkerOffset(clampedConfig) <= runoffOuterEdge);
assert.ok(resolveRouteMarkerOffset(clampedConfig) <= ROUTE_MARKER_MAX_LATERAL_OFFSET);

for (const brake of brakePoints) {
  const turn = turns.find((event) => event.id === brake.turnId);
  assert.ok(turn, `${brake.id} points to a known turn`);
  assert.ok(brake.progress < turn.progress, `${brake.id} is before ${turn.id}`);
}

const samples = Array.from({ length: TRACK_CONFIG.samples }, (_, index) => ({
  index,
  point: new THREE.Vector3(index, 0, index * 0.01),
  tangent: new THREE.Vector3(0, 0, 1),
  side: new THREE.Vector3(1, 0, 0),
}));
const fakeTrack = {
  config: TRACK_CONFIG,
  length: trackLength,
  samples,
  lastIndex: 0,
  routeGuidance: guidance,
  group: new THREE.Group(),
  getUpcomingGuidance: TrackSystem.prototype.getUpcomingGuidance,
};

const copiedGuidance = TrackSystem.prototype.getRouteGuidance.call(fakeTrack);
assert.notEqual(copiedGuidance, guidance);
copiedGuidance[0].progress = 0;
assert.notEqual(copiedGuidance[0].progress, guidance[0].progress);

const upcoming = TrackSystem.prototype.getUpcomingGuidance.call(fakeTrack, 0, 3);
assert.deepEqual(upcoming.map((event) => event.id), ['brake-01', 'turn-01', 'brake-02']);
assert.equal(TrackSystem.prototype.getNextGuidance.call(fakeTrack, 0).id, 'brake-01');

TrackSystem.prototype.buildRouteGuidanceMarkers.call(fakeTrack);
const markers = fakeTrack.routeGuidanceMarkers;
assert.ok(markers.poles instanceof THREE.InstancedMesh);
assert.equal(markers.poles.count, guidance.length);
assert.deepEqual(Object.keys(markers.signs).sort(), ['brake', 'left', 'right']);
assert.equal(markers.signs.brake.count, brakePoints.length);
assert.equal(markers.signs.left.count, turns.filter((event) => event.direction === 'left').length);
assert.equal(markers.signs.right.count, turns.filter((event) => event.direction === 'right').length);
assert.ok(Object.values(markers.signs).every((mesh) => mesh instanceof THREE.InstancedMesh));
assert.equal(markers.signs.left.userData.routeGuidanceShape, 'arrow');
assert.equal(markers.signs.right.userData.routeGuidanceShape, 'arrow');
assert.equal(markers.signs.left.userData.routeGuidanceDirection, 'left');
assert.equal(markers.signs.right.userData.routeGuidanceDirection, 'right');
assert.notEqual(markers.signs.left.geometry, markers.signs.right.geometry, 'left/right signs use distinct arrow geometry');
assert.equal(markers.signs.brake.userData.routeGuidanceShape, 'panel');
assert.equal(fakeTrack.group.children.length, 4, 'one pole mesh plus one instanced mesh per marker kind');
assert.ok(markers.events.every((event) => ['left', 'right'].includes(event.markerSide)));

const disabledTrack = {
  ...fakeTrack,
  config: {
    ...TRACK_CONFIG,
    routeGuidance: {
      ...TRACK_CONFIG.routeGuidance,
      markers: { ...TRACK_CONFIG.routeGuidance.markers, enabled: false },
    },
  },
  group: new THREE.Group(),
};
TrackSystem.prototype.buildRouteGuidanceMarkers.call(disabledTrack);
assert.equal(disabledTrack.routeGuidanceMarkers.poles, null);
assert.equal(disabledTrack.group.children.length, 0);

console.log(`PASS route guidance: ${brakePoints.length} brake points, ${turns.length} turns, instanced roadside markers`);
