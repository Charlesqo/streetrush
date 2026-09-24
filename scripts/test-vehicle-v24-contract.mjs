import assert from 'node:assert/strict';
import {
  FiveOwnerState,
  VEHICLE_V24_COORDINATE_CONTRACT,
} from '../src/vehicle-v24/index.js';

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

assert.deepEqual(VEHICLE_V24_COORDINATE_CONTRACT.streetRush, {
  forward: '+Z', right: '+X', up: '+Y', units: 'SI',
});
checks += 1;
assert.deepEqual(VEHICLE_V24_COORDINATE_CONTRACT.wheelOrder, ['FL', 'FR', 'RL', 'RR']);
checks += 1;
assert.deepEqual(
  VEHICLE_V24_COORDINATE_CONTRACT.pythonToStreetRushLocal,
  [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
);
checks += 1;

const initial = {
  engine: { value: 1 },
  gearbox: { value: 2 },
  steering: { value: 3 },
  tires: { value: 4 },
  mechanics: { value: 5 },
};
const group = new FiveOwnerState(initial);
const committed = group.begin();
for (const [name, state] of Object.entries(initial)) committed.stage(name, { value: state.value + 10 });
committed.preflight({ scaledResidual: 1e-12, tolerance: 2e-6, activeSet: { clutch: 'LOCKED' } });
const committedAudit = committed.commit();
check(committedAudit.status === 'COMMITTED', 'five-owner transaction did not commit');
check(
  Object.values(committedAudit.commitCounts).every((count) => count === 1),
  'every owner must commit exactly once',
);
assert.deepEqual(group.snapshot(), {
  engine: { value: 11 },
  gearbox: { value: 12 },
  steering: { value: 13 },
  tires: { value: 14 },
  mechanics: { value: 15 },
});
checks += 1;

const beforeFault = group.snapshot();
const faulted = group.begin();
for (const [name, state] of Object.entries(beforeFault)) faulted.stage(name, { value: state.value + 10 });
faulted.preflight({ scaledResidual: 0, tolerance: 2e-6, activeSet: {} });
let injectedError = null;
try {
  faulted.commit({
    faultInjector: (phase, owner) => {
      if (phase === 'after-owner-commit' && owner === 'steering') throw new Error('injected commit fault');
    },
  });
} catch (error) {
  injectedError = error;
}
check(injectedError?.message === 'injected commit fault', 'commit fault was not surfaced');
assert.deepEqual(group.snapshot(), beforeFault, 'group rollback did not restore every owner snapshot');
checks += 1;
check(faulted.audit.status === 'ROLLED_BACK', 'post-commit fault must be classified as rolled back');
check(faulted.audit.rollbackCounts.engine === 1, 'engine rollback was not audited');
check(faulted.audit.rollbackCounts.gearbox === 1, 'gearbox rollback was not audited');
check(faulted.audit.rollbackCounts.steering === 1, 'steering rollback was not audited');
check(faulted.audit.rollbackCounts.tires === 0, 'uncommitted tire owner must not claim rollback');
check(faulted.audit.rollbackCounts.mechanics === 0, 'uncommitted mechanics owner must not claim rollback');

const residualFailure = group.begin();
for (const [name, state] of Object.entries(beforeFault)) residualFailure.stage(name, state);
assert.throws(
  () => residualFailure.preflight({ scaledResidual: 3e-6, tolerance: 2e-6, activeSet: {} }),
  /exceeds/,
);
checks += 1;
const abortedAudit = residualFailure.abort(new Error('residual gate'));
check(abortedAudit.status === 'ABORTED', 'preflight failure must abort without commit');
check(
  Object.values(abortedAudit.commitCounts).every((count) => count === 0),
  'aborted preflight must not commit any owner',
);

console.log(`vehicle-v24 contract: PASS (${checks} checks)`);

