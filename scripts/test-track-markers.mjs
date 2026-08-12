import assert from 'node:assert/strict';
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
