import * as THREE from 'three';
import { CARS, TRACK_CONFIG } from '../src/config.js';
import { LONGWAN_TIME_ATTACK } from '../src/race-goals.js';

const MEDALS = ['gold', 'silver', 'bronze'];
const MIN_REASONABLE_AVERAGE_KMH = 20;
const MAX_REASONABLE_AVERAGE_KMH = 400;

let warningCount = 0;

function sanityWarning(message) {
  warningCount += 1;
  console.warn(`SANITY WARNING: ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function requireFiniteCoordinate(value, label) {
  if (!Number.isFinite(value)) fail(`${label} must be a finite number`);
}

function calculateTrackLengthMeters() {
  if (!TRACK_CONFIG || typeof TRACK_CONFIG !== 'object') {
    fail('TRACK_CONFIG is missing');
  }
  if (!Array.isArray(TRACK_CONFIG.points) || TRACK_CONFIG.points.length < 3) {
    fail('TRACK_CONFIG.points is missing or has fewer than 3 control points');
  }

  const points = TRACK_CONFIG.points.map((point, index) => {
    if (!Array.isArray(point) || point.length < 3) {
      fail(`TRACK_CONFIG.points[${index}] is missing x/y/z coordinates`);
    }
    const [x, y, z] = point;
    requireFiniteCoordinate(x, `TRACK_CONFIG.points[${index}][0]`);
    requireFiniteCoordinate(y, `TRACK_CONFIG.points[${index}][1]`);
    requireFiniteCoordinate(z, `TRACK_CONFIG.points[${index}][2]`);
    return new THREE.Vector3(x, y, z);
  });

  const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.2);
  const trackLengthMeters = curve.getLength();
  if (!Number.isFinite(trackLengthMeters) || trackLengthMeters <= 0) {
    fail('CatmullRomCurve3 returned an invalid track length');
  }

  return trackLengthMeters;
}

function averageKmhForThreeLapTarget(trackLengthMeters, targetMs) {
  if (!Number.isFinite(targetMs) || targetMs <= 0) {
    fail(`medal target must be a positive finite millisecond value (received ${targetMs})`);
  }
  const distanceMeters = trackLengthMeters * 3;
  const elapsedSeconds = targetMs / 1000;
  const averageKmh = (distanceMeters / elapsedSeconds) * 3.6;
  if (!Number.isFinite(averageKmh) || averageKmh <= 0) {
    fail('average speed calculation produced an invalid value');
  }
  return averageKmh;
}

function formatTargetTime(targetMs) {
  return `${(targetMs / 1000).toFixed(3)} s`;
}

function validateAndWarn(trackLengthMeters) {
  if (!Array.isArray(CARS) || CARS.length === 0) {
    fail('CARS is missing or empty');
  }
  if (!LONGWAN_TIME_ATTACK || typeof LONGWAN_TIME_ATTACK !== 'object') {
    fail('LONGWAN_TIME_ATTACK is missing');
  }
  if (!LONGWAN_TIME_ATTACK.medalTargetsMs || typeof LONGWAN_TIME_ATTACK.medalTargetsMs !== 'object') {
    fail('LONGWAN_TIME_ATTACK.medalTargetsMs is missing');
  }

  if (!Number.isInteger(TRACK_CONFIG.samples) || TRACK_CONFIG.samples <= 0) {
    sanityWarning('TRACK_CONFIG.samples is not a positive integer; length was still calculated from the control points.');
  }
  if (typeof TRACK_CONFIG.name !== 'string' || TRACK_CONFIG.name.trim() === '') {
    sanityWarning('TRACK_CONFIG.name is missing or empty.');
  }

  const carIds = new Set();
  for (const [index, car] of CARS.entries()) {
    if (!car || typeof car !== 'object' || typeof car.id !== 'string' || car.id.trim() === '') {
      fail(`CARS[${index}] is missing a usable id`);
    }
    if (carIds.has(car.id)) fail(`CARS contains duplicate id "${car.id}"`);
    carIds.add(car.id);
  }

  for (const targetId of Object.keys(LONGWAN_TIME_ATTACK.medalTargetsMs)) {
    if (!carIds.has(targetId)) {
      sanityWarning(`medalTargetsMs contains target data for unknown car "${targetId}"; it will not be printed.`);
    }
  }

  const trackLengthKm = trackLengthMeters / 1000;
  if (trackLengthKm < 1 || trackLengthKm > 10) {
    sanityWarning(`calculated lap length is ${trackLengthKm.toFixed(3)} km, outside the broad 1–10 km sanity range.`);
  }
}

function main() {
  const trackLengthMeters = calculateTrackLengthMeters();
  validateAndWarn(trackLengthMeters);

  const trackLengthKm = trackLengthMeters / 1000;
  console.log(`Track: ${TRACK_CONFIG.name ?? '(unnamed)'}`);
  console.log(`CatmullRomCurve3 lap length: ${trackLengthMeters.toFixed(3)} m (${trackLengthKm.toFixed(3)} km)`);
  console.log('Three-lap medal target average speeds:');

  for (const car of CARS) {
    const targets = LONGWAN_TIME_ATTACK.medalTargetsMs[car.id];
    if (!targets || typeof targets !== 'object') {
      fail(`no medal target table exists for car "${car.id}"`);
    }

    const speeds = {};
    for (const medal of MEDALS) {
      if (!Object.hasOwn(targets, medal)) {
        fail(`car "${car.id}" is missing its ${medal} target`);
      }
      speeds[medal] = averageKmhForThreeLapTarget(trackLengthMeters, targets[medal]);
    }

    if (!(targets.gold < targets.silver && targets.silver < targets.bronze)) {
      sanityWarning(`car "${car.id}" target times are not strictly gold < silver < bronze.`);
    }
    if (Number.isFinite(car.speed)) {
      for (const medal of MEDALS) {
        if (speeds[medal] > car.speed) {
          sanityWarning(`car "${car.id}" ${medal} target averages ${speeds[medal].toFixed(2)} km/h, above its configured ${car.speed} km/h speed.`);
        }
      }
    }
    for (const medal of MEDALS) {
      if (speeds[medal] < MIN_REASONABLE_AVERAGE_KMH || speeds[medal] > MAX_REASONABLE_AVERAGE_KMH) {
        sanityWarning(`car "${car.id}" ${medal} target averages ${speeds[medal].toFixed(2)} km/h, outside the broad ${MIN_REASONABLE_AVERAGE_KMH}–${MAX_REASONABLE_AVERAGE_KMH} km/h sanity range.`);
      }
    }

    console.log(
      `- ${car.name ?? car.id} (${car.id}): `
      + `${MEDALS.map((medal) => `${medal} ${speeds[medal].toFixed(2)} km/h [${formatTargetTime(targets[medal])}]`).join(' | ')}`,
    );
  }

  if (warningCount === 0) {
    console.log('SANITY: no warnings.');
  } else {
    console.log(`SANITY: ${warningCount} warning(s); exit code remains 0.`);
  }
}

try {
  main();
} catch (error) {
  console.error(`INPUT/CALCULATION ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
