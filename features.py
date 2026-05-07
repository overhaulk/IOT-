from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Iterable
from urllib.request import urlopen

import numpy as np
import pandas as pd


FEATURE_COLUMNS = [
    "course_count",
    "total_sessions",
    "total_absences",
    "avg_attendance_rate",
    "min_attendance_rate",
    "avg_recent_absence_rate",
    "max_absence_streak",
    "avg_required_remaining",
    "avg_can_skip",
    "avg_mid_sem",
    "avg_internal",
]


SPECIAL_HEADER_PATTERNS = {
    "required": re.compile(r"required", re.IGNORECASE),
    "can_skip": re.compile(r"skip", re.IGNORECASE),
    "mid_sem": re.compile(r"mid|sem", re.IGNORECASE),
    "internal": re.compile(r"internal", re.IGNORECASE),
}


def _read_json_source(source: str) -> pd.DataFrame:
    if source.startswith(("http://", "https://")):
        with urlopen(source, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    else:
        payload = json.loads(Path(source).read_text(encoding="utf-8"))

    headers = payload.get("headers")
    data = payload.get("data")
    if not isinstance(headers, list) or not isinstance(data, list):
        raise ValueError(f"{source} must contain JSON keys 'headers' and 'data'")

    return pd.DataFrame(data, columns=headers)


def read_attendance_source(source: str) -> pd.DataFrame:
    if source.startswith(("http://", "https://")) or source.lower().endswith(".json"):
        return _read_json_source(source)
    return pd.read_csv(source)


def _find_special_columns(columns: Iterable[str]) -> dict[str, str | None]:
    result: dict[str, str | None] = {key: None for key in SPECIAL_HEADER_PATTERNS}
    for column in columns:
        column_text = str(column)
        for key, pattern in SPECIAL_HEADER_PATTERNS.items():
            if result[key] is None and pattern.search(column_text):
                result[key] = column
    return result


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        if value is None or pd.isna(value):
            return default
        text = str(value).strip().replace("%", "")
        if not text or text == "-":
            return default
        return float(text)
    except (TypeError, ValueError):
        return default


def _attendance_values(row: pd.Series, attendance_columns: list[str]) -> list[str]:
    values: list[str] = []
    for column in attendance_columns:
        value = str(row.get(column, "")).strip().upper()
        if value in {"P", "A"}:
            values.append(value)
    return values


def _longest_absence_streak(values: list[str]) -> int:
    longest = 0
    current = 0
    for value in values:
        if value == "A":
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def build_course_features(df: pd.DataFrame, course_name: str) -> pd.DataFrame:
    if len(df.columns) < 3:
        raise ValueError("Attendance data needs at least Name, Enrollment, and attendance columns")

    df = df.copy()
    name_col = df.columns[0]
    enrollment_col = df.columns[1]
    special = _find_special_columns(df.columns)
    excluded = {name_col, enrollment_col, *[column for column in special.values() if column]}
    attendance_columns = [column for column in df.columns if column not in excluded]

    records: list[dict[str, object]] = []
    for _, row in df.iterrows():
        enrollment = _to_float(row.get(enrollment_col), default=np.nan)
        if np.isnan(enrollment):
            continue

        values = _attendance_values(row, attendance_columns)
        total_sessions = len(values)
        total_present = values.count("P")
        total_absent = values.count("A")
        attendance_rate = total_present / total_sessions if total_sessions else 0.0
        recent_values = values[-5:]
        recent_absence_rate = recent_values.count("A") / len(recent_values) if recent_values else 0.0

        records.append(
            {
                "Enrollment": int(enrollment),
                "Name": str(row.get(name_col, "")).strip(),
                "Course": course_name,
                "total_sessions": total_sessions,
                "total_absences": total_absent,
                "attendance_rate": attendance_rate,
                "recent_absence_rate": recent_absence_rate,
                "longest_absence_streak": _longest_absence_streak(values),
                "required_remaining": _to_float(row.get(special["required"])) if special["required"] else 0.0,
                "can_skip": _to_float(row.get(special["can_skip"])) if special["can_skip"] else 0.0,
                "mid_sem": _to_float(row.get(special["mid_sem"])) if special["mid_sem"] else 0.0,
                "internal": _to_float(row.get(special["internal"])) if special["internal"] else 0.0,
            }
        )

    return pd.DataFrame.from_records(records)


def build_student_features(sources: list[str]) -> pd.DataFrame:
    course_frames: list[pd.DataFrame] = []
    for source in sources:
        course_name = Path(source.split("?")[0]).stem or "Course"
        course_frames.append(build_course_features(read_attendance_source(source), course_name))

    if not course_frames:
        raise ValueError("At least one attendance source is required")

    course_data = pd.concat(course_frames, ignore_index=True)
    grouped = course_data.groupby("Enrollment", as_index=False)
    features = grouped.agg(
        Name=("Name", "first"),
        course_count=("Course", "nunique"),
        total_sessions=("total_sessions", "sum"),
        total_absences=("total_absences", "sum"),
        avg_attendance_rate=("attendance_rate", "mean"),
        min_attendance_rate=("attendance_rate", "min"),
        avg_recent_absence_rate=("recent_absence_rate", "mean"),
        max_absence_streak=("longest_absence_streak", "max"),
        avg_required_remaining=("required_remaining", "mean"),
        avg_can_skip=("can_skip", "mean"),
        avg_mid_sem=("mid_sem", "mean"),
        avg_internal=("internal", "mean"),
    )

    return features[["Enrollment", "Name", *FEATURE_COLUMNS]].fillna(0)


def add_demo_labels(features: pd.DataFrame) -> pd.DataFrame:
    """Create transparent demo labels when real academic-result labels are unavailable."""
    labelled = features.copy()
    risk_score = (
        (labelled["avg_attendance_rate"] < 0.75).astype(int)
        + (labelled["avg_recent_absence_rate"] >= 0.4).astype(int)
        + (labelled["max_absence_streak"] >= 3).astype(int)
        + (labelled["avg_mid_sem"] < 25).astype(int)
        + (labelled["avg_internal"] < 12).astype(int)
    )
    labelled["AtRisk"] = (risk_score >= 2).astype(int)
    return labelled


def main() -> None:
    parser = argparse.ArgumentParser(description="Build student-level AI features from attendance sheets.")
    parser.add_argument("--attendance", nargs="+", required=True, help="CSV, JSON, or Apps Script JSON URLs")
    parser.add_argument("--output", default="ai_model/artifacts/features.csv")
    parser.add_argument("--demo-labels", action="store_true", help="Add rule-based demo AtRisk labels")
    args = parser.parse_args()

    features = build_student_features(args.attendance)
    if args.demo_labels:
        features = add_demo_labels(features)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    features.to_csv(output_path, index=False)
    print(f"Wrote {len(features)} student feature rows to {output_path}")


if __name__ == "__main__":
    main()
