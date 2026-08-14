import mx5WheelManifest from '../data/car-wheel-manifests/mx5.json' with { type: 'json' };
import gt3WheelManifest from '../data/car-wheel-manifests/gt3rs.json' with { type: 'json' };
import { AssetManager } from './assets.js';
import { bindManifestVisualWheels } from './car-wheel-pivots.js';

// Keep production adoption explicit. A researched manifest only affects the game
// after it is listed here and has passed the real-loader lifecycle test.
export const PRODUCTION_WHEEL_MANIFESTS = Object.freeze({
  mx5: mx5WheelManifest,
  gt3rs: gt3WheelManifest,
});

export function createGameAssetManager(scene, track) {
  return new AssetManager(scene, track, {
    wheelManifests: PRODUCTION_WHEEL_MANIFESTS,
    bindVisualWheels: bindManifestVisualWheels,
  });
}
