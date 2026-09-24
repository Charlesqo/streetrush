import { deepClone, finiteDeep } from './math.js';

export const VEHICLE_V24_VERSION = '2.4-streetrush-js';
export const VEHICLE_V24_OWNER_NAMES = Object.freeze([
  'engine',
  'gearbox',
  'steering',
  'tires',
  'mechanics',
]);

export const VEHICLE_V24_COORDINATE_CONTRACT = Object.freeze({
  streetRush: Object.freeze({ forward: '+Z', right: '+X', up: '+Y', units: 'SI' }),
  pythonOracle: Object.freeze({ forward: '+X', left: '+Y', up: '+Z', units: 'SI' }),
  wheelOrder: Object.freeze(['FL', 'FR', 'RL', 'RR']),
  pythonToStreetRushLocal: Object.freeze([
    Object.freeze([0, -1, 0]),
    Object.freeze([0, 0, 1]),
    Object.freeze([1, 0, 0]),
  ]),
});

export class VehicleV24Error extends Error {
  constructor(message, code = 'VEHICLE_V24_ERROR', details = undefined) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class VehicleV24DomainError extends VehicleV24Error {
  constructor(message, details) {
    super(message, 'V24_DOMAIN_ERROR', details);
  }
}

export class VehicleV24HostCapabilityError extends VehicleV24Error {
  constructor(message, capability, details) {
    super(message, 'V24_HOST_CAPABILITY_REQUIRED', { capability, ...details });
    this.capability = capability;
  }
}

export class VehicleV24AbortError extends VehicleV24Error {
  constructor(message, audit, cause = undefined) {
    super(message, 'V24_ACTIVE_STEP_ABORTED', { audit });
    this.audit = audit;
    this.cause = cause;
  }
}

export function assertVehicleV24StepInput({ input, dt }) {
  if (!Number.isFinite(dt) || dt <= 0 || dt > 0.05) {
    throw new VehicleV24DomainError('v2.4 dt must be finite and lie in (0, 0.05]', { dt });
  }
  const values = [
    input?.steer ?? 0,
    input?.throttle ?? 0,
    input?.brake ?? 0,
    input?.handbrake ?? 0,
  ];
  if (!values.every(Number.isFinite)) {
    throw new VehicleV24DomainError('v2.4 driver input contains a non-finite value');
  }
}

class TransactionOwner {
  constructor(name, initialState) {
    this.name = name;
    this.state = deepClone(initialState);
    this.openToken = null;
  }

  begin(token) {
    if (this.openToken !== null) throw new Error(`${this.name} already owns an open transaction`);
    this.openToken = token;
    return deepClone(this.state);
  }

  validateCommit(token, nextState) {
    if (this.openToken !== token) throw new Error(`stale or duplicate ${this.name}.commit`);
    if (!finiteDeep(nextState)) throw new Error(`${this.name} trial contains non-finite state`);
  }

  commit(token, nextState) {
    this.validateCommit(token, nextState);
    this.state = deepClone(nextState);
    this.openToken = null;
  }

  abort(token) {
    if (this.openToken !== token) throw new Error(`stale or duplicate ${this.name}.abort`);
    this.openToken = null;
  }

  restore(snapshot) {
    this.state = deepClone(snapshot);
    this.openToken = null;
  }
}

export class FiveOwnerState {
  constructor(initialStates) {
    this.owners = new Map();
    for (const name of VEHICLE_V24_OWNER_NAMES) {
      if (!(name in initialStates)) throw new Error(`missing v2.4 owner state: ${name}`);
      this.owners.set(name, new TransactionOwner(name, initialStates[name]));
    }
    this.nextToken = 1;
  }

  snapshot() {
    return Object.fromEntries(
      VEHICLE_V24_OWNER_NAMES.map((name) => [name, deepClone(this.owners.get(name).state)]),
    );
  }

  replaceAll(states) {
    for (const name of VEHICLE_V24_OWNER_NAMES) this.owners.get(name).restore(states[name]);
  }

  begin() {
    const token = this.nextToken;
    this.nextToken += 1;
    const snapshots = {};
    for (const name of VEHICLE_V24_OWNER_NAMES) snapshots[name] = this.owners.get(name).begin(token);
    return new FiveOwnerTransaction(this, token, snapshots);
  }
}

class FiveOwnerTransaction {
  constructor(group, token, snapshots) {
    this.group = group;
    this.token = token;
    this.snapshots = snapshots;
    this.trials = {};
    this.closed = false;
    this.audit = {
      token,
      status: 'OPEN',
      preflightPassed: false,
      commitCounts: Object.fromEntries(VEHICLE_V24_OWNER_NAMES.map((name) => [name, 0])),
      rollbackCounts: Object.fromEntries(VEHICLE_V24_OWNER_NAMES.map((name) => [name, 0])),
      residual: null,
      activeSet: null,
      error: null,
    };
  }

  snapshot(name) {
    return deepClone(this.snapshots[name]);
  }

  stage(name, state) {
    if (this.closed) throw new Error('cannot stage a closed v2.4 transaction');
    if (!VEHICLE_V24_OWNER_NAMES.includes(name)) throw new Error(`unknown v2.4 owner ${name}`);
    if (name in this.trials) throw new Error(`${name} trial was staged more than once`);
    this.trials[name] = deepClone(state);
  }

  preflight({ scaledResidual, tolerance, activeSet }) {
    if (this.closed) throw new Error('cannot preflight a closed v2.4 transaction');
    const missing = VEHICLE_V24_OWNER_NAMES.filter((name) => !(name in this.trials));
    if (missing.length) throw new Error(`missing v2.4 owner trials: ${missing.join(', ')}`);
    if (!finiteDeep(this.trials)) throw new Error('v2.4 transaction contains non-finite trial data');
    if (!Number.isFinite(scaledResidual) || scaledResidual > tolerance) {
      throw new Error(`v2.4 scaled residual ${scaledResidual} exceeds ${tolerance}`);
    }
    for (const name of VEHICLE_V24_OWNER_NAMES) {
      this.group.owners.get(name).validateCommit(this.token, this.trials[name]);
    }
    this.audit.preflightPassed = true;
    this.audit.residual = { scaled: scaledResidual, tolerance };
    this.audit.activeSet = deepClone(activeSet);
  }

  commit({ applyHost, rollbackHost, faultInjector } = {}) {
    if (!this.audit.preflightPassed) throw new Error('v2.4 transaction cannot commit before preflight');
    const committed = [];
    try {
      for (const name of VEHICLE_V24_OWNER_NAMES) {
        faultInjector?.('before-owner-commit', name);
        this.group.owners.get(name).commit(this.token, this.trials[name]);
        this.audit.commitCounts[name] += 1;
        committed.push(name);
        faultInjector?.('after-owner-commit', name);
      }
      applyHost?.();
      faultInjector?.('after-host-apply', null);
      this.audit.status = 'COMMITTED';
      this.closed = true;
      return deepClone(this.audit);
    } catch (error) {
      try {
        rollbackHost?.();
      } catch {
        // The original commit error remains authoritative in the audit.
      }
      for (const name of [...VEHICLE_V24_OWNER_NAMES].reverse()) {
        const owner = this.group.owners.get(name);
        const wasCommitted = committed.includes(name);
        owner.restore(this.snapshots[name]);
        if (wasCommitted) this.audit.rollbackCounts[name] += 1;
      }
      this.audit.status = committed.length ? 'ROLLED_BACK' : 'ABORTED';
      this.audit.error = { name: error.name, message: error.message };
      this.closed = true;
      throw error;
    }
  }

  abort(error) {
    if (this.closed) return deepClone(this.audit);
    for (const name of VEHICLE_V24_OWNER_NAMES) {
      const owner = this.group.owners.get(name);
      if (owner.openToken === this.token) owner.abort(this.token);
    }
    this.audit.status = 'ABORTED';
    this.audit.error = error ? { name: error.name, message: error.message } : null;
    this.closed = true;
    return deepClone(this.audit);
  }
}

