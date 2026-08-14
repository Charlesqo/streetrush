import mx5WheelManifest from '../data/car-wheel-manifests/mx5.json' with { type: 'json' };
import gt3WheelManifest from '../data/car-wheel-manifests/gt3rs.json' with { type: 'json' };
import lp700WheelManifest from '../data/car-wheel-manifests/lp700.json' with { type: 'json' };
import { AssetManager } from './assets.js';
import { bindGeometrySplitVisualWheels } from './car-wheel-geometry-split.js';
import { bindManifestVisualWheels } from './car-wheel-pivots.js';

// Keep production adoption explicit. A researched manifest only affects the game
// after it is listed here and has passed the real-loader lifecycle test.
export const PRODUCTION_WHEEL_MANIFESTS = Object.freeze({
  mx5: mx5WheelManifest,
  gt3rs: gt3WheelManifest,
  lp700: lp700WheelManifest,
});

export function bindProductionVisualWheels(host, model, manifest) {
  return manifest.schemaVersion === 3
    ? bindGeometrySplitVisualWheels(host, model, manifest)
    : bindManifestVisualWheels(host, model, manifest);
}

export function createGameAssetManager(scene, track) {
  return new AssetManager(scene, track, {
    wheelManifests: PRODUCTION_WHEEL_MANIFESTS,
    bindVisualWheels: bindProductionVisualWheels,
  });
}
