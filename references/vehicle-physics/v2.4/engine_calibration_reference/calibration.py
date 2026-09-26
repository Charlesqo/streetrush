"""Global calibration and validation contracts for the vehicle baseline."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
import hashlib
import json
import math
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

import numpy as np


class DataSplit(str, Enum):
    CALIBRATION = "CALIBRATION"
    VALIDATION = "VALIDATION"
    HOLDOUT = "HOLDOUT"


class GateStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    XFAIL = "XFAIL"
    XPASS = "XPASS"
    SKIP = "SKIP"
    DOMAIN_ERROR = "DOMAIN_ERROR"


class CalibrationStage(str, Enum):
    FOUNDATIONS = "FOUNDATIONS"
    COMPONENT = "COMPONENT"
    SUBSYSTEM = "SUBSYSTEM"
    WHOLE_VEHICLE = "WHOLE_VEHICLE"
    HOLDOUT = "HOLDOUT"


class SourceKind(str, Enum):
    MEASURED = "MEASURED"
    MANUFACTURER = "MANUFACTURER"
    IDENTIFIED = "IDENTIFIED"
    ESTIMATED = "ESTIMATED"
    GAMEPLAY = "GAMEPLAY"
    SYNTHETIC = "SYNTHETIC"


class ParameterStatus(str, Enum):
    FIXED = "FIXED"
    CALIBRATABLE = "CALIBRATABLE"
    VALIDATED = "VALIDATED"
    PROVISIONAL = "PROVISIONAL"
    SKIP_TARGET_DATA = "SKIP_TARGET_DATA"


class RegressionTier(str, Enum):
    L0_CONFIG = "L0_CONFIG"
    L1_INVARIANT = "L1_INVARIANT"
    L2_COMPONENT = "L2_COMPONENT"
    L3_COUPLED_SYNTHETIC = "L3_COUPLED_SYNTHETIC"
    L4_TARGET_MEASURED = "L4_TARGET_MEASURED"
    L5_SCENARIO = "L5_SCENARIO"


@dataclass(frozen=True)
class DatasetManifest:
    dataset_id: str
    source_uri: str
    source_hash: str
    source_kind: str
    split: DataSplit
    signals_units: Mapping[str, str]
    frame_convention: str
    timebase: str
    environment: Mapping[str, float | str]
    uncertainty_1sigma: Mapping[str, float]
    valid_domain: Mapping[str, tuple[float, float]]
    preprocessing: tuple[str, ...] = ()
    fit_code_hash: str = ""
    synthetic: bool = False
    lineage_root_id: str = ""
    acquisition_id: str = ""
    parent_dataset_ids: tuple[str, ...] = ()
    channel_semantics: Mapping[str, str] = field(default_factory=dict)
    sample_rate_hz: float | None = None
    sensor_frames: Mapping[str, str] = field(default_factory=dict)
    vehicle_conditions: Mapping[str, float | str] = field(default_factory=dict)
    calibration_date: str = ""
    missing_data_policy: str = "REJECT"
    processing_code_hash: str = ""
    latency_correction_s: Mapping[str, float] = field(default_factory=dict)

    def validate(self) -> None:
        if not self.dataset_id or not self.source_uri or not self.source_kind:
            raise ValueError("dataset identity/source fields are required")
        if len(self.source_hash) != 64 or any(c not in "0123456789abcdef" for c in self.source_hash):
            raise ValueError("source_hash must be a lowercase SHA-256")
        if not self.signals_units or any(not k or not v for k, v in self.signals_units.items()):
            raise ValueError("every recorded signal requires an explicit unit")
        if not self.frame_convention or not self.timebase:
            raise ValueError("frame convention and timebase are required")
        if self.sample_rate_hz is not None and (
            not math.isfinite(self.sample_rate_hz) or self.sample_rate_hz <= 0.0
        ):
            raise ValueError("sample rate must be finite and positive when present")
        if self.channel_semantics and set(self.channel_semantics) != set(self.signals_units):
            raise ValueError("channel semantics must cover exactly the declared signals")
        if self.sensor_frames and not set(self.sensor_frames).issubset(self.signals_units):
            raise ValueError("sensor-frame keys must refer to declared signals")
        if not self.missing_data_policy:
            raise ValueError("missing-data policy is required")
        for digest in (self.fit_code_hash, self.processing_code_hash):
            if digest and (len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)):
                raise ValueError("code hashes must be lowercase SHA-256 when present")
        for name, sigma in self.uncertainty_1sigma.items():
            if name not in self.signals_units or not math.isfinite(sigma) or sigma <= 0.0:
                raise ValueError("uncertainty must be positive and refer to a declared signal")
        for lo, hi in self.valid_domain.values():
            if not (math.isfinite(lo) and math.isfinite(hi) and lo < hi):
                raise ValueError("valid-domain bounds must be finite and ordered")
        for signal, latency in self.latency_correction_s.items():
            if signal not in self.signals_units or not math.isfinite(latency):
                raise ValueError("latency correction must be finite and refer to a declared signal")

    @property
    def lineage_key(self) -> str:
        return self.lineage_root_id or self.dataset_id

    @staticmethod
    def sha256_file(path: str | Path) -> str:
        digest = hashlib.sha256()
        with Path(path).open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        return digest.hexdigest()


@dataclass(frozen=True)
class ParameterPassport:
    parameter_id: str
    owner_system: str
    nominal: float
    bounds: tuple[float, float]
    units: str
    stage: CalibrationStage
    asset_version: str
    physical_meaning: str
    frame_convention: str
    source_kind: SourceKind
    source_dataset_id: str
    source_hash: str
    fit_code_hash: str
    valid_domain: Mapping[str, tuple[float, float]]
    operating_conditions: Mapping[str, float | str]
    uncertainty_1sigma: float
    status: ParameterStatus
    covariance_group: str = ""
    dependencies: tuple[str, ...] = ()
    transforms: tuple[str, ...] = ()
    description: str = ""

    def validate(self) -> None:
        lo, hi = self.bounds
        required = (
            self.parameter_id,
            self.owner_system,
            self.units,
            self.asset_version,
            self.physical_meaning,
            self.frame_convention,
        )
        if any(not value for value in required):
            raise ValueError("parameter passport identity/meaning/owner fields are required")
        if not (math.isfinite(lo) and math.isfinite(hi) and lo <= self.nominal <= hi):
            raise ValueError(f"parameter {self.parameter_id} value/bounds are invalid")
        if not math.isfinite(self.uncertainty_1sigma) or self.uncertainty_1sigma < 0.0:
            raise ValueError("parameter uncertainty must be finite and non-negative")
        for digest in (self.source_hash, self.fit_code_hash):
            if digest and (len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)):
                raise ValueError("parameter provenance hashes must be lowercase SHA-256")
        if self.source_kind in (SourceKind.MEASURED, SourceKind.IDENTIFIED) and (
            not self.source_dataset_id or not self.source_hash
        ):
            raise ValueError("measured/identified parameter requires dataset and source hash")
        if self.status is ParameterStatus.VALIDATED and self.source_kind in (
            SourceKind.ESTIMATED,
            SourceKind.GAMEPLAY,
            SourceKind.SYNTHETIC,
        ):
            raise ValueError("estimated/gameplay/synthetic parameter cannot be marked VALIDATED")
        for domain_lo, domain_hi in self.valid_domain.values():
            if not (math.isfinite(domain_lo) and math.isfinite(domain_hi) and domain_lo < domain_hi):
                raise ValueError("parameter valid domain is invalid")

    @property
    def name(self) -> str:
        return self.parameter_id

    @property
    def owner(self) -> str:
        return self.owner_system

    @property
    def value(self) -> float:
        return self.nominal

    @property
    def unit(self) -> str:
        return self.units

    @property
    def evidence_dataset_ids(self) -> tuple[str, ...]:
        return (self.source_dataset_id,) if self.source_dataset_id else ()


# Backward-compatible name for the initial half-implementation.
ParameterSpec = ParameterPassport


class DatasetRegistry:
    """Enforce identity, provenance lineage, and calibration/holdout separation."""

    def __init__(self) -> None:
        self._datasets: dict[str, DatasetManifest] = {}
        self._lineage_splits: dict[str, DataSplit] = {}
        self._hash_splits: dict[str, DataSplit] = {}

    def register(self, manifest: DatasetManifest) -> None:
        manifest.validate()
        if manifest.dataset_id in self._datasets:
            raise ValueError(f"duplicate dataset id {manifest.dataset_id}")
        existing_split = self._lineage_splits.get(manifest.lineage_key)
        if existing_split is not None and existing_split is not manifest.split:
            raise ValueError("one data lineage cannot cross calibration/validation/holdout splits")
        hash_split = self._hash_splits.get(manifest.source_hash)
        if hash_split is not None and hash_split is not manifest.split:
            raise ValueError("identical source data cannot be reused under another split")
        for parent in manifest.parent_dataset_ids:
            if parent not in self._datasets:
                raise ValueError(f"processed dataset parent {parent} is not registered")
            parent_manifest = self._datasets[parent]
            if parent_manifest.split is not manifest.split:
                raise ValueError("processed data must inherit its parent split")
        self._datasets[manifest.dataset_id] = manifest
        self._lineage_splits[manifest.lineage_key] = manifest.split
        self._hash_splits[manifest.source_hash] = manifest.split

    def ids(self) -> tuple[str, ...]:
        return tuple(self._datasets)

    def get(self, dataset_id: str) -> DatasetManifest:
        return self._datasets[dataset_id]


class PhenomenonAuthorityRegistry:
    """Prevent two runtime owners from absorbing the same physical effect."""

    def __init__(self) -> None:
        self._claims: dict[str, tuple[str, str]] = {}

    def claim(self, phenomenon_id: str, owner_system: str, representation: str) -> None:
        if not phenomenon_id or not owner_system or not representation:
            raise ValueError("authority claim requires phenomenon, owner and representation")
        if phenomenon_id in self._claims:
            old_owner, old_representation = self._claims[phenomenon_id]
            raise ValueError(
                f"duplicate phenomenon authority {phenomenon_id}: "
                f"{old_owner}/{old_representation} vs {owner_system}/{representation}"
            )
        self._claims[phenomenon_id] = (owner_system, representation)


class ParameterRegistry:
    def __init__(self) -> None:
        self._specs: dict[str, ParameterPassport] = {}

    def register(self, spec: ParameterPassport) -> None:
        spec.validate()
        if spec.name in self._specs:
            existing = self._specs[spec.name]
            raise ValueError(
                f"duplicate parameter authority for {spec.name}: {existing.owner} vs {spec.owner}"
            )
        self._specs[spec.name] = spec

    def by_stage(self, stage: CalibrationStage) -> tuple[ParameterPassport, ...]:
        return tuple(p for p in self._specs.values() if p.stage is stage)

    def missing_evidence(self, available_dataset_ids: Iterable[str]) -> tuple[str, ...]:
        available = set(available_dataset_ids)
        return tuple(
            p.name
            for p in self._specs.values()
            if p.evidence_dataset_ids and not set(p.evidence_dataset_ids).issubset(available)
        )


@dataclass(frozen=True)
class IdentifiabilityReport:
    singular_values: tuple[float, ...]
    rank: int
    parameter_count: int
    condition_number: float
    right_singular_vectors: tuple[tuple[float, ...], ...]
    verdict: str


def finite_difference_sensitivity(
    model: Callable[[np.ndarray], np.ndarray],
    parameters: Sequence[float],
    parameter_scales: Sequence[float] | None = None,
    output_sigma: Sequence[float] | float = 1.0,
    relative_step: float = 1e-5,
) -> np.ndarray:
    p = np.asarray(parameters, dtype=float)
    scales = np.ones_like(p) if parameter_scales is None else np.asarray(parameter_scales, dtype=float)
    if p.ndim != 1 or scales.shape != p.shape or np.any(scales <= 0.0):
        raise ValueError("parameters/scales must be one-dimensional, matching, and positive")
    y0 = np.asarray(model(p), dtype=float).reshape(-1)
    sigma = np.asarray(output_sigma, dtype=float)
    if sigma.ndim == 0:
        sigma = np.full_like(y0, float(sigma))
    sigma = sigma.reshape(-1)
    if sigma.shape != y0.shape or np.any(sigma <= 0.0):
        raise ValueError("output sigma must be positive and match model output")
    jac = np.empty((len(y0), len(p)), dtype=float)
    for j in range(len(p)):
        h = relative_step * max(abs(p[j]), scales[j], 1.0)
        plus = p.copy()
        minus = p.copy()
        plus[j] += h
        minus[j] -= h
        derivative = (np.asarray(model(plus)).reshape(-1) - np.asarray(model(minus)).reshape(-1)) / (
            2.0 * h
        )
        jac[:, j] = derivative * scales[j] / sigma
    if not np.all(np.isfinite(jac)):
        raise ValueError("sensitivity contains non-finite entries")
    return jac


def analyze_identifiability(jacobian: np.ndarray, relative_rank_tol: float = 1e-8) -> IdentifiabilityReport:
    j = np.asarray(jacobian, dtype=float)
    if j.ndim != 2 or j.shape[1] == 0:
        raise ValueError("jacobian must be a non-empty matrix")
    _, singular, vt = np.linalg.svd(j, full_matrices=False)
    threshold = relative_rank_tol * singular[0] if singular.size and singular[0] > 0.0 else 0.0
    rank = int(np.sum(singular > threshold))
    if rank < j.shape[1] or singular[-1] <= 0.0:
        condition = math.inf
        verdict = "NON_IDENTIFIABLE"
    else:
        condition = float(singular[0] / singular[-1])
        verdict = "WEAK" if condition > 1e4 else "IDENTIFIABLE"
    return IdentifiabilityReport(
        singular_values=tuple(map(float, singular)),
        rank=rank,
        parameter_count=j.shape[1],
        condition_number=condition,
        right_singular_vectors=tuple(tuple(map(float, row)) for row in vt),
        verdict=verdict,
    )


def robust_weighted_residuals(
    prediction: Sequence[float],
    observation: Sequence[float],
    sigma: Sequence[float],
    huber_delta: float = 2.5,
) -> np.ndarray:
    pred = np.asarray(prediction, dtype=float)
    obs = np.asarray(observation, dtype=float)
    std = np.asarray(sigma, dtype=float)
    if pred.shape != obs.shape or pred.shape != std.shape or np.any(std <= 0.0):
        raise ValueError("prediction, observation and positive sigma must have matching shapes")
    z = (pred - obs) / std
    magnitude = np.abs(z)
    # Signed square-root of twice the Huber loss, preserving least-squares use.
    residual = z.copy()
    tail = magnitude > huber_delta
    # Do not use np.where here: both branches are evaluated, which would take
    # sqrt of a negative expression for inlier entries and emit a false runtime
    # warning even though those values are subsequently discarded.
    residual[tail] = np.sign(z[tail]) * np.sqrt(
        2.0 * huber_delta * magnitude[tail] - huber_delta**2
    )
    return residual


@dataclass(frozen=True)
class GateResult:
    case_id: str
    status: GateStatus
    metric_value: float | None
    threshold: float | None
    message: str
    dataset_ids: tuple[str, ...] = ()
    evidence: Mapping[str, float | str | list[float]] = field(default_factory=dict)
    tier: RegressionTier = RegressionTier.L0_CONFIG
    reason_code: str = ""
    acquisition_path: str = ""
    impact_scope: str = ""


def metric_gate(
    case_id: str,
    value: float,
    maximum: float,
    dataset_ids: Sequence[str] = (),
    expected_failure: bool = False,
    message: str = "",
    tier: RegressionTier = RegressionTier.L0_CONFIG,
    reason_code: str = "",
    evidence: Mapping[str, float | str | list[float]] | None = None,
) -> GateResult:
    if not math.isfinite(value):
        return GateResult(
            case_id,
            GateStatus.DOMAIN_ERROR,
            value,
            maximum,
            message or "metric is non-finite",
            tuple(dataset_ids),
            evidence or {},
            tier,
            reason_code or "NON_FINITE_METRIC",
        )
    passed = value <= maximum
    if expected_failure:
        status = GateStatus.XPASS if passed else GateStatus.XFAIL
    else:
        status = GateStatus.PASS if passed else GateStatus.FAIL
    return GateResult(
        case_id,
        status,
        value,
        maximum,
        message,
        tuple(dataset_ids),
        evidence or {},
        tier,
        reason_code,
    )


def missing_fixture_gate(
    case_id: str,
    missing: Sequence[str],
    reason: str,
    acquisition_path: str,
    impact_scope: str,
    tier: RegressionTier = RegressionTier.L4_TARGET_MEASURED,
) -> GateResult:
    return GateResult(
        case_id=case_id,
        status=GateStatus.SKIP,
        metric_value=None,
        threshold=None,
        message=f"{reason}; missing: {', '.join(missing)}",
        dataset_ids=tuple(missing),
        tier=tier,
        reason_code="MISSING_EXTERNAL_FIXTURE",
        acquisition_path=acquisition_path,
        impact_scope=impact_scope,
    )


@dataclass(frozen=True)
class RunManifest:
    run_id: str
    baseline_version: str
    config_hash: str
    code_hash: str
    dataset_hashes: Mapping[str, str]
    deterministic_seed: int
    runtime: str
    command: str

    def validate(self) -> None:
        if not self.run_id or not self.baseline_version or not self.runtime or not self.command:
            raise ValueError("run manifest identity/runtime/command fields are required")
        for digest in (self.config_hash, self.code_hash, *self.dataset_hashes.values()):
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("run manifest hashes must be lowercase SHA-256")

    def content_hash(self) -> str:
        self.validate()
        encoded = json.dumps(asdict(self), sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class ReleaseDecision:
    reference_executable_ready: bool
    target_vehicle_validated: bool
    decision: str
    blockers: tuple[str, ...]
    warnings: tuple[str, ...]
    status_counts: Mapping[str, int]
    run_manifest_hash: str


def evaluate_release(
    results: Sequence[GateResult],
    run_manifest: RunManifest,
    required_reference_tiers: Sequence[RegressionTier] = (
        RegressionTier.L0_CONFIG,
        RegressionTier.L1_INVARIANT,
        RegressionTier.L2_COMPONENT,
        RegressionTier.L3_COUPLED_SYNTHETIC,
    ),
) -> ReleaseDecision:
    """Evaluate reference close-out separately from target-vehicle validation."""
    manifest_hash = run_manifest.content_hash()
    blockers: list[str] = []
    warnings: list[str] = []
    mandatory = set(required_reference_tiers)
    counts = {status.value: sum(r.status is status for r in results) for status in GateStatus}

    present_tiers = {result.tier for result in results}
    for tier in mandatory:
        if tier not in present_tiers:
            blockers.append(f"missing mandatory regression tier {tier.value}")
    for result in results:
        if result.status in (GateStatus.XFAIL, GateStatus.XPASS) and not result.reason_code:
            blockers.append(f"{result.case_id}: expected-status result lacks reason_code")
        if result.status is GateStatus.XPASS:
            blockers.append(f"{result.case_id}: XPASS requires model-boundary review")
        if result.status is GateStatus.SKIP and (
            not result.acquisition_path or not result.impact_scope or not result.reason_code
        ):
            blockers.append(f"{result.case_id}: SKIP accounting is incomplete")
        if result.tier in mandatory and result.status in (
            GateStatus.FAIL,
            GateStatus.DOMAIN_ERROR,
            GateStatus.XPASS,
        ):
            blockers.append(f"{result.case_id}: {result.status.value} in mandatory {result.tier.value}")
        elif result.status in (GateStatus.FAIL, GateStatus.DOMAIN_ERROR):
            # A non-mandatory failure does not invalidate the structural
            # executable, but it must remain visible.  This is how a measured
            # target/scenario can honestly fail while L0-L3 reference
            # contracts still close.
            warnings.append(
                f"{result.case_id}: {result.status.value} outside mandatory reference tiers"
            )
        if result.status in (GateStatus.XFAIL, GateStatus.SKIP):
            warnings.append(f"{result.case_id}: {result.status.value} — {result.message}")

    reference_ready = not blockers
    target_results = [r for r in results if r.tier is RegressionTier.L4_TARGET_MEASURED]
    target_ready = bool(target_results) and all(r.status is GateStatus.PASS for r in target_results)
    if reference_ready and target_ready:
        decision = "REFERENCE_READY_AND_TARGET_VALIDATED"
    elif reference_ready:
        decision = "REFERENCE_READY_TARGET_NOT_VALIDATED"
    else:
        decision = "RELEASE_BLOCKED"
    return ReleaseDecision(
        reference_executable_ready=reference_ready,
        target_vehicle_validated=target_ready,
        decision=decision,
        blockers=tuple(blockers),
        warnings=tuple(warnings),
        status_counts=counts,
        run_manifest_hash=manifest_hash,
    )


def write_ledger(
    path: str | Path,
    results: Sequence[GateResult],
    metadata: Mapping[str, object],
    release_decision: ReleaseDecision | None = None,
) -> None:
    payload = {
        "schema": "vehicle-validation-ledger-v2",
        "metadata": dict(metadata),
        "summary": {status.value: sum(r.status is status for r in results) for status in GateStatus},
        "results": [
            {
                **asdict(result),
                "status": result.status.value,
                "tier": result.tier.value,
            }
            for result in results
        ],
    }
    if release_decision is not None:
        payload["release_decision"] = asdict(release_decision)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
