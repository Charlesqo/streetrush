import assert from 'node:assert/strict';

import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  zeroInput,
} from './physics-harness.mjs';

const BRAKE_HOLD_BEFORE_REVERSE = 0.35;
const REVERSE_ENGAGE_MAXIMUM = 0.6;
const reverseRequest = zeroInput({ brake: 1, driveIntent: -1 });

for (const id of ['mx5', 'gt3rs']) {
  const config = CARS.find((candidate) => candidate.id === id);
  const rig = createVehicleRig(config);
  try {
    let pedals = rig.vehicle.updateTransmission(reverseRequest, FIXED_DT, 10);
    assert.equal(rig.vehicle.reverse, false, `${id} remains forward while moving`);
    assert.equal(pedals.serviceBrake, 1, `${id} uses S as a service brake while moving`);

    let stoppedHold = 0;
    while (stoppedHold < BRAKE_HOLD_BEFORE_REVERSE) {
      pedals = rig.vehicle.updateTransmission(reverseRequest, FIXED_DT, 0);
      stoppedHold += FIXED_DT;
      assert.equal(rig.vehicle.reverse, false, `${id} does not snap into reverse after braking to a stop`);
      assert.equal(pedals.serviceBrake, 1, `${id} keeps the service brake applied during reverse confirmation`);
      assert.equal(pedals.driveThrottle, 0, `${id} does not apply reverse torque during confirmation`);
    }

    while (!rig.vehicle.reverse && stoppedHold < REVERSE_ENGAGE_MAXIMUM) {
      pedals = rig.vehicle.updateTransmission(reverseRequest, FIXED_DT, 0);
      stoppedHold += FIXED_DT;
    }
    assert.equal(rig.vehicle.reverse, true, `${id} still enters reverse after a deliberate hold`);
    assert.equal(pedals.driveThrottle, 1, `${id} applies reverse throttle after engagement`);
  } finally {
    destroyVehicleRig(rig);
  }
}

console.log('PASS MX-5 and GT3 RS brake-to-reverse confirmation keeps braking before deliberate reverse');
