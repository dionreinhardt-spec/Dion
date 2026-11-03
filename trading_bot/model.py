from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.ensemble import RandomForestClassifier, VotingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .config import ModelConfig
from .features import FEATURE_COLUMNS


@dataclass(slots=True)
class ModelDiagnostics:
    validation_rows: int
    base_rate: float
    brier_score: float
    baseline_brier: float
    accuracy: float
    roc_auc: float | None
    calibration_error: float
    quality_pass: bool
    reason: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _estimator() -> VotingClassifier:
    linear = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("model", LogisticRegression(C=0.35, class_weight="balanced", max_iter=2_000, random_state=17)),
        ]
    )
    nonlinear = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="median")),
            (
                "model",
                RandomForestClassifier(
                    n_estimators=180,
                    max_depth=5,
                    min_samples_leaf=20,
                    max_features=0.70,
                    class_weight="balanced_subsample",
                    n_jobs=1,
                    random_state=29,
                ),
            ),
        ]
    )
    return VotingClassifier(
        estimators=[("linear", linear), ("nonlinear", nonlinear)],
        voting="soft",
        weights=[0.60, 0.40],
        n_jobs=1,
    )


def _calibration_error(y_true: np.ndarray, probability: np.ndarray, bins: int) -> float:
    edges = np.linspace(0, 1, bins + 1)
    errors = []
    weights = []
    for lower, upper in zip(edges[:-1], edges[1:]):
        mask = (probability >= lower) & (probability < upper if upper < 1 else probability <= upper)
        if mask.any():
            errors.append(abs(float(probability[mask].mean()) - float(y_true[mask].mean())))
            weights.append(int(mask.sum()))
    return float(np.average(errors, weights=weights)) if weights else float("nan")


class ProbabilityModel:
    """Regularized linear/nonlinear ensemble with a time-validation abstention gate."""

    def __init__(self, config: ModelConfig, horizon_days: int) -> None:
        self.config = config
        self.horizon_days = horizon_days
        self.model = _estimator()
        self.base_rate = 0.5
        self.diagnostics: ModelDiagnostics | None = None

    def _usable(self, panel: pd.DataFrame) -> pd.DataFrame:
        return panel.dropna(subset=FEATURE_COLUMNS + ["target_up"]).copy()

    def walk_forward_validate(self, panel: pd.DataFrame) -> pd.DataFrame:
        data = self._usable(panel)
        dates = np.array(sorted(data["date"].unique()))
        minimum = self.config.minimum_training_days
        if len(dates) < minimum + self.horizon_days + 35:
            raise ValueError("Not enough dated observations for walk-forward validation")

        first_test = minimum
        remaining = len(dates) - first_test
        fold_width = max(14, remaining // 4)
        predictions: list[pd.DataFrame] = []
        cursor = first_test
        while cursor < len(dates):
            test_dates = dates[cursor : min(cursor + fold_width, len(dates))]
            if not len(test_dates):
                break
            test_start = test_dates[0]
            purge_before = test_start - np.timedelta64(self.horizon_days, "D")
            train = data[data["date"] < purge_before]
            test = data[data["date"].isin(test_dates)]
            if train["date"].nunique() < minimum or test.empty or train["target_up"].nunique() < 2:
                cursor += fold_width
                continue
            model = _estimator()
            model.fit(train[FEATURE_COLUMNS], train["target_up"].astype(int))
            raw = model.predict_proba(test[FEATURE_COLUMNS])[:, 1]
            base_rate = float(train["target_up"].mean())
            probability = (1 - self.config.shrinkage_to_base_rate) * raw + self.config.shrinkage_to_base_rate * base_rate
            probability = np.clip(probability, self.config.probability_cap_low, self.config.probability_cap_high)
            context = [
                column
                for column in ["market_regime", "chart_strategy", "strategy_signal_strength"]
                if column in test.columns
            ]
            fold = test[["date", "asset_id", "symbol", "close", "forward_return", "target_up", *context]].copy()
            fold["probability_up"] = probability
            fold["train_max_date"] = train["date"].max()
            predictions.append(fold)
            cursor += fold_width

        if not predictions:
            raise ValueError("Walk-forward validation produced no predictions")
        result = pd.concat(predictions, ignore_index=True).sort_values(["date", "probability_up"], ascending=[True, False])
        self.diagnostics = self._diagnose(result)
        return result

    def _diagnose(self, predictions: pd.DataFrame) -> ModelDiagnostics:
        y = predictions["target_up"].astype(int).to_numpy()
        p = predictions["probability_up"].to_numpy()
        base_rate = float(y.mean())
        brier = float(brier_score_loss(y, p))
        baseline_brier = float(brier_score_loss(y, np.full(len(y), base_rate)))
        accuracy = float(accuracy_score(y, p >= 0.5))
        auc = float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else None
        calibration_error = _calibration_error(y, p, self.config.calibration_bins)
        enough_rows = len(y) >= self.config.minimum_validation_rows
        beats_baseline = brier < baseline_brier
        acceptable_calibration = calibration_error <= 0.12
        quality_pass = enough_rows and beats_baseline and acceptable_calibration
        reasons = []
        if not enough_rows:
            reasons.append("too few validation rows")
        if not beats_baseline:
            reasons.append("probabilities do not beat the base-rate Brier score")
        if not acceptable_calibration:
            reasons.append("calibration error exceeds 0.12")
        return ModelDiagnostics(
            validation_rows=len(y),
            base_rate=base_rate,
            brier_score=brier,
            baseline_brier=baseline_brier,
            accuracy=accuracy,
            roc_auc=auc,
            calibration_error=calibration_error,
            quality_pass=quality_pass,
            reason="quality gate passed" if quality_pass else "; ".join(reasons),
        )

    def fit(self, panel: pd.DataFrame) -> None:
        data = self._usable(panel)
        if data.empty or data["target_up"].nunique() < 2:
            raise ValueError("Training data needs both positive and negative outcomes")
        self.base_rate = float(data["target_up"].mean())
        self.model.fit(data[FEATURE_COLUMNS], data["target_up"].astype(int))

    def predict(self, latest_rows: pd.DataFrame) -> np.ndarray:
        raw = self.model.predict_proba(latest_rows[FEATURE_COLUMNS])[:, 1]
        probability = (1 - self.config.shrinkage_to_base_rate) * raw + self.config.shrinkage_to_base_rate * self.base_rate
        return np.clip(probability, self.config.probability_cap_low, self.config.probability_cap_high)
