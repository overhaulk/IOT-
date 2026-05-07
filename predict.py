from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from features import build_student_features


def _require_torch():
    try:
        import torch
    except ImportError as exc:
        raise SystemExit(
            "PyTorch is not installed. Install dependencies with: "
            "pip install -r ai_model/requirements.txt"
        ) from exc
    return torch


def _risk_reason(row, probability: float) -> str:
    reasons: list[str] = []
    if row["avg_attendance_rate"] < 0.75:
        reasons.append("low attendance")
    if row["max_absence_streak"] >= 3:
        reasons.append("consecutive absences")
    if row["avg_recent_absence_rate"] >= 0.4:
        reasons.append("recent absence trend")
    if row["avg_mid_sem"] and row["avg_mid_sem"] < 25:
        reasons.append("low mid-sem score")
    if row["avg_internal"] and row["avg_internal"] < 12:
        reasons.append("low internal score")
    if not reasons:
        reasons.append("model confidence")
    return ", ".join(reasons) if probability >= 0.5 else "attendance and marks currently stable"


def main() -> None:
    parser = argparse.ArgumentParser(description="Predict student academic-risk from attendance sheets.")
    parser.add_argument("--attendance", nargs="+", required=True, help="CSV, JSON, or Apps Script JSON URLs")
    parser.add_argument("--artifacts-dir", default="ai_model/artifacts")
    parser.add_argument("--output", default="ai_model/artifacts/risk_predictions.json")
    args = parser.parse_args()

    torch = _require_torch()
    from model import StudentRiskNet

    artifacts_dir = Path(args.artifacts_dir)
    scaler = json.loads((artifacts_dir / "scaler.json").read_text(encoding="utf-8"))
    feature_columns = scaler["feature_columns"]

    features = build_student_features(args.attendance)
    x = features[feature_columns].astype(float).to_numpy(dtype=np.float32)
    x_scaled = (x - np.array(scaler["mean"], dtype=np.float32)) / np.array(scaler["std"], dtype=np.float32)

    model = StudentRiskNet(input_dim=len(feature_columns))
    model.load_state_dict(torch.load(artifacts_dir / "student_risk_model.pt", map_location="cpu"))
    model.eval()

    with torch.no_grad():
        probabilities = torch.sigmoid(model(torch.tensor(x_scaled, dtype=torch.float32))).numpy()

    threshold = float(scaler.get("threshold", 0.5))
    results = []
    for (_, row), probability in zip(features.iterrows(), probabilities):
        probability_value = float(probability)
        results.append(
            {
                "enrollment": int(row["Enrollment"]),
                "name": row["Name"],
                "riskStatus": "At Risk" if probability_value >= threshold else "Not At Risk",
                "confidence": round(probability_value if probability_value >= threshold else 1 - probability_value, 3),
                "riskProbability": round(probability_value, 3),
                "reason": _risk_reason(row, probability_value),
            }
        )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Wrote {len(results)} predictions to {output_path}")


if __name__ == "__main__":
    main()
