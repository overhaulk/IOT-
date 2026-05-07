from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import pandas as pd

from features import FEATURE_COLUMNS, add_demo_labels, build_student_features


def _require_torch():
    try:
        import torch
        from torch import nn
        from torch.utils.data import DataLoader, TensorDataset
    except ImportError as exc:
        raise SystemExit(
            "PyTorch is not installed. Install dependencies with: "
            "pip install -r ai_model/requirements.txt"
        ) from exc
    return torch, nn, DataLoader, TensorDataset


def _load_training_frame(args: argparse.Namespace) -> pd.DataFrame:
    features = build_student_features(args.attendance)

    if args.demo_labels:
        return add_demo_labels(features)

    labels = pd.read_csv(args.labels)
    if "Enrollment" not in labels.columns or "AtRisk" not in labels.columns:
        raise ValueError("labels.csv must contain Enrollment and AtRisk columns")

    frame = features.merge(labels[["Enrollment", "AtRisk"]], on="Enrollment", how="inner")
    if frame.empty:
        raise ValueError("No training rows matched between attendance data and labels")
    return frame


def _split_indices(y: np.ndarray, seed: int, test_ratio: float = 0.25) -> tuple[np.ndarray, np.ndarray]:
    rng = random.Random(seed)
    train_indices: list[int] = []
    test_indices: list[int] = []

    for label in sorted(set(y.tolist())):
        indices = [i for i, value in enumerate(y.tolist()) if value == label]
        rng.shuffle(indices)
        test_count = max(1, int(round(len(indices) * test_ratio))) if len(indices) > 1 else 0
        test_indices.extend(indices[:test_count])
        train_indices.extend(indices[test_count:])

    if not test_indices:
        test_indices = train_indices[-1:]
        train_indices = train_indices[:-1]

    return np.array(train_indices, dtype=int), np.array(test_indices, dtype=int)


def _classification_metrics(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, float]:
    predictions = (probabilities >= 0.5).astype(int)
    accuracy = float((predictions == y_true).mean())
    tp = int(((predictions == 1) & (y_true == 1)).sum())
    tn = int(((predictions == 0) & (y_true == 0)).sum())
    fp = int(((predictions == 1) & (y_true == 0)).sum())
    fn = int(((predictions == 0) & (y_true == 1)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "true_positive": tp,
        "true_negative": tn,
        "false_positive": fp,
        "false_negative": fn,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a PyTorch student academic-risk classifier.")
    parser.add_argument("--attendance", nargs="+", required=True, help="CSV, JSON, or Apps Script JSON URLs")
    parser.add_argument("--labels", help="CSV with Enrollment and AtRisk columns")
    parser.add_argument("--demo-labels", action="store_true", help="Use transparent demo labels from attendance rules")
    parser.add_argument("--output-dir", default="ai_model/artifacts")
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--learning-rate", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not args.demo_labels and not args.labels:
        raise SystemExit("Provide --labels labels.csv for real training, or use --demo-labels for a demo model.")

    torch, nn, DataLoader, TensorDataset = _require_torch()
    from model import StudentRiskNet

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    frame = _load_training_frame(args)
    if len(frame) < 4:
        raise SystemExit("Need at least 4 labelled students to train a useful demo model.")

    x = frame[FEATURE_COLUMNS].astype(float).to_numpy(dtype=np.float32)
    y = frame["AtRisk"].astype(int).to_numpy(dtype=np.float32)
    train_idx, test_idx = _split_indices(y.astype(int), args.seed)

    mean = x[train_idx].mean(axis=0)
    std = x[train_idx].std(axis=0)
    std[std == 0] = 1.0
    x_scaled = (x - mean) / std

    train_dataset = TensorDataset(
        torch.tensor(x_scaled[train_idx], dtype=torch.float32),
        torch.tensor(y[train_idx], dtype=torch.float32),
    )
    train_loader = DataLoader(train_dataset, batch_size=min(16, len(train_dataset)), shuffle=True)

    model = StudentRiskNet(input_dim=len(FEATURE_COLUMNS))
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    positive_count = max(float(y[train_idx].sum()), 1.0)
    negative_count = max(float(len(train_idx) - y[train_idx].sum()), 1.0)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([negative_count / positive_count]))

    model.train()
    for _ in range(args.epochs):
        for batch_x, batch_y in train_loader:
            optimizer.zero_grad()
            loss = loss_fn(model(batch_x), batch_y)
            loss.backward()
            optimizer.step()

    model.eval()
    with torch.no_grad():
        logits = model(torch.tensor(x_scaled[test_idx], dtype=torch.float32))
        probabilities = torch.sigmoid(logits).numpy()

    metrics = _classification_metrics(y[test_idx].astype(int), probabilities)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    torch.save(model.state_dict(), output_dir / "student_risk_model.pt")
    (output_dir / "scaler.json").write_text(
        json.dumps(
            {
                "feature_columns": FEATURE_COLUMNS,
                "mean": mean.tolist(),
                "std": std.tolist(),
                "threshold": 0.5,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    frame.to_csv(output_dir / "training_features.csv", index=False)
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print("Training complete")
    print(json.dumps(metrics, indent=2))
    print(f"Saved model artifacts to {output_dir}")


if __name__ == "__main__":
    main()
