"""궤적 → 특징 벡터. 명세서 4.1절의 입력 6차원 + 멈칫(pause) 기반 추가 특징.

**추론 제약 (명세서 1.3절)**: 여기서 만드는 모든 특징은 궤적과 클릭 좌표만으로
계산된다. 버튼 중심·크기를 쓰는 것은 라벨(e∥/e⊥) 쪽이며 특징에는 들어가지 않는다.
단 하나 예외가 `button_radius`인데, 이는 명세서 4.1절이 입력으로 명시한 값이다
(추론 시 커서 아래 UI 요소의 크기는 알 수 있다는 전제 — 어떤 버튼을 노렸는지는
몰라도 된다).

멈칫 탐지 근거 (1단계 375시행 실측):
  - 멈칫은 경로의 80~105% 지점에 72~74% 집중, 클릭 약 228ms 전
  - 최소 속도가 양옆 봉우리의 5% 수준까지 떨어지는 거의 완전한 정지
  - 독립된 두 절반(150/230)에서 빈도·위치가 재현됨
"""

from __future__ import annotations

import math
from typing import Optional, Sequence, TypedDict

import numpy as np

from error_decomposition import (
    TrajectoryPoint,
    decompose_error,
    error_distance,
    estimate_approach_direction,
    normalize_error,
)

# --- 멈칫 탐지 파라미터 ---
SPEED_SMOOTH_SAMPLES = 5      # 8ms 샘플 5개 ≈ 40ms 이동평균
PAUSE_DEPTH_RATIO = 0.40      # 국소 최소가 양옆 봉우리의 이 비율 미만이면 멈칫
MIN_FLANK_PEAK_SPEED = 0.05   # px/ms. 이보다 느린 봉우리는 봉우리로 보지 않음
PAUSE_MERGE_MS = 40.0         # 이보다 가까운 멈칫은 하나로 합침
MIN_SEGMENT_DISPLACEMENT_PX = 2.0
MIN_PATH_LENGTH_PX = 30.0
TURN_DEADBAND_DEG = 15.0      # 지그재그 판정 시 무시할 방향 변화 크기


class Pause(TypedDict):
    index: int
    time: float
    speed: float
    depth: float
    progress: float          # 시작점→클릭점 축에서의 진행률 (1.0 = 클릭점)
    perpendicular: float     # 같은 축 기준 횡방향 이탈 (비율)
    time_from_start: float
    time_to_click: float
    turn_deg: Optional[float]


def _smooth(values: np.ndarray, window: int = SPEED_SMOOTH_SAMPLES) -> np.ndarray:
    if len(values) < window:
        return values.copy()
    kernel = np.ones(window) / window
    return np.convolve(values, kernel, mode="same")


def _speed_profile(points: np.ndarray, times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """구간 속도(px/ms)와 그 구간의 끝 시각."""
    dt = np.diff(times)
    step = np.linalg.norm(np.diff(points, axis=0), axis=1)
    valid = dt > 0
    speed = np.zeros(len(dt))
    speed[valid] = step[valid] / dt[valid]
    return speed, times[1:]


def _find_pauses(smoothed: np.ndarray, speed_times: np.ndarray) -> list[dict]:
    """속도 프로파일의 국소 최소 중 양옆 봉우리 대비 충분히 낮은 것.

    부호 반전만 세면 완전히 멈추지 않는 '멈칫'을 놓치므로 국소 최소를 쓴다.
    """
    if len(smoothed) < 5:
        return []

    maxima = [i for i in range(1, len(smoothed) - 1)
              if smoothed[i] >= smoothed[i - 1] and smoothed[i] > smoothed[i + 1]]
    minima = [i for i in range(1, len(smoothed) - 1)
              if smoothed[i] <= smoothed[i - 1] and smoothed[i] < smoothed[i + 1]]

    found = []
    for mi in minima:
        left = [i for i in maxima if i < mi]
        right = [i for i in maxima if i > mi]
        if not left or not right:
            continue
        flank = min(smoothed[left[-1]], smoothed[right[0]])
        if flank < MIN_FLANK_PEAK_SPEED:
            continue
        if smoothed[mi] < PAUSE_DEPTH_RATIO * flank:
            found.append({
                "index": mi + 1,   # points 인덱스로 보정 (속도는 구간값)
                "time": float(speed_times[mi]),
                "speed": float(smoothed[mi]),
                "depth": float(smoothed[mi] / flank),
            })

    merged: list[dict] = []
    for p in found:
        if merged and p["time"] - merged[-1]["time"] < PAUSE_MERGE_MS:
            if p["speed"] < merged[-1]["speed"]:
                merged[-1] = p
        else:
            merged.append(p)
    return merged


def analyze_trajectory(trajectory: Sequence[TrajectoryPoint], click: dict) -> Optional[dict]:
    """궤적의 형태·멈칫 구조를 계산한다. 계산 불가하면 None.

    축은 **궤적 시작점 → 클릭점**으로 잡는다. 버튼 위치를 쓰지 않으므로 추론 시에도
    동일하게 계산된다.
    """
    if len(trajectory) < 8:
        return None

    points = np.array([[p["x"], p["y"]] for p in trajectory], dtype=float)
    times = np.array([p["t"] for p in trajectory], dtype=float)
    click_point = np.array([click["x"], click["y"]], dtype=float)

    origin = points[0]
    to_click = click_point - origin
    straight_line = float(np.linalg.norm(to_click))
    if straight_line < MIN_PATH_LENGTH_PX:
        return None

    axis = to_click / straight_line
    axis_perp = np.array([-axis[1], axis[0]])
    relative = points - origin
    progress = relative @ axis / straight_line
    perpendicular = relative @ axis_perp / straight_line

    speed, speed_times = _speed_profile(points, times)
    smoothed = _smooth(speed)

    path_length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
    straightness = straight_line / path_length if path_length > 0 else 0.0

    pauses = _find_pauses(smoothed, speed_times)
    for p in pauses:
        i = min(p["index"], len(points) - 1)
        p["progress"] = float(progress[i])
        p["perpendicular"] = float(perpendicular[i])
        p["time_from_start"] = float(times[i] - times[0])
        p["time_to_click"] = float(times[-1] - times[i])

    # 멈칫 전후 조각의 방향 변화
    bounds = [0] + [min(p["index"], len(points) - 1) for p in pauses] + [len(points) - 1]
    segment_dirs: list[Optional[float]] = []
    for a, b in zip(bounds, bounds[1:]):
        if b <= a:
            segment_dirs.append(None)
            continue
        d = points[b] - points[a]
        segment_dirs.append(math.atan2(d[1], d[0])
                            if np.linalg.norm(d) >= MIN_SEGMENT_DISPLACEMENT_PX else None)

    turns: list[Optional[float]] = []
    for a, b in zip(segment_dirs, segment_dirs[1:]):
        if a is None or b is None:
            turns.append(None)
            continue
        diff = (b - a + math.pi) % (2 * math.pi) - math.pi
        turns.append(math.degrees(diff))
    for p, turn in zip(pauses, turns):
        p["turn_deg"] = turn

    signs = [0 if t is None or abs(t) <= TURN_DEADBAND_DEG else (1 if t > 0 else -1)
             for t in turns]
    nonzero = [s for s in signs if s != 0]
    alternations = sum(1 for a, b in zip(nonzero, nonzero[1:]) if a != b)

    # 탄도 방향: 시작점 → 첫 멈칫(없으면 최고속도 시점)
    if pauses:
        ballistic_end = min(pauses[0]["index"], len(points) - 1)
    else:
        ballistic_end = min(max(int(np.argmax(smoothed)) + 1, 1), len(points) - 1)
    bd = points[ballistic_end] - origin
    theta_ballistic = (math.atan2(bd[1], bd[0])
                       if np.linalg.norm(bd) >= 3.0 else None)

    return {
        "straight_line_px": straight_line,
        "path_length_px": path_length,
        "straightness": straightness,
        "progress_max": float(progress.max()),
        "overshoot_ratio": float(progress.max() - 1.0),
        "perpendicular_max": float(np.abs(perpendicular).max()),
        "n_pauses": len(pauses),
        "pauses": pauses,
        "turn_alternations": alternations,
        "theta_ballistic": theta_ballistic,
        "max_speed": float(smoothed.max()),
        "decel_onset_before_click_ms": _decel_onset(smoothed, speed_times, times[-1]),
        "first_pause_progress": pauses[0]["progress"] if pauses else None,
        "last_pause_progress": pauses[-1]["progress"] if pauses else None,
        "last_pause_to_click_ms": pauses[-1]["time_to_click"] if pauses else None,
    }


def _decel_onset(smoothed: np.ndarray, speed_times: np.ndarray, click_time: float) -> float:
    """감속 시작 시점 — 속도가 최대치의 50%로 떨어진 시점 (명세서 4.1절).

    클릭 시각 기준 역산 ms. 뒤에서부터 훑어 마지막으로 50%를 넘었던 시각을 쓴다.
    """
    if len(smoothed) == 0:
        return 0.0
    peak = smoothed.max()
    if peak <= 0:
        return 0.0
    onset_time = speed_times[-1]
    for t, s in zip(reversed(speed_times), reversed(smoothed)):
        if s >= 0.5 * peak:
            onset_time = t
            break
    return float(click_time - onset_time)


# 명세서 4.1절이 지정한 6차원. 순서를 고정해 모델 계수 해석이 가능하게 한다.
BASE_FEATURE_NAMES = [
    "sin_theta",
    "cos_theta",
    "max_speed",
    "decel_onset_before_click_ms",
    "movement_distance_px",
    "button_radius_px",
]

# 1단계 탐색에서 나온 멈칫 기반 후보. 기본은 사용하지 않는다
# (375시행에서 e⊥의 교차검증 R²를 -1.7% → -3.2%로 악화시켰다 = 과적합).
PAUSE_FEATURE_NAMES = [
    "n_pauses",
    "straightness",
    "overshoot_ratio",
    "perpendicular_max",
]


def extract_trial(trial: dict, include_pause_features: bool = False) -> Optional[dict]:
    """시행 레코드 하나 → 특징·라벨 묶음. 계산 불가하면 None.

    반환 딕셔너리:
      features        : dict (이름 → 값)
      feature_names   : list[str]  (순서 고정)
      labels          : e_parallel/e_perp 및 정규화값, dx/dy, 오차거리
      meta            : 시행번호·플래그 등
    """
    click = trial.get("click")
    if click is None:
        return None

    trajectory = trial.get("trajectory") or []
    shape = analyze_trajectory(trajectory, click)
    if shape is None:
        return None

    theta, direction_flag = estimate_approach_direction(
        trajectory, click["time"], (click["x"], click["y"]))
    if theta is None:
        return None

    button = trial["button"]
    radius = button["size"] / 2.0
    center = (button["center_x"], button["center_y"])
    click_xy = (click["x"], click["y"])

    features = {
        "sin_theta": math.sin(theta),
        "cos_theta": math.cos(theta),
        "max_speed": shape["max_speed"],
        "decel_onset_before_click_ms": shape["decel_onset_before_click_ms"],
        "movement_distance_px": shape["straight_line_px"],
        "button_radius_px": radius,
    }
    names = list(BASE_FEATURE_NAMES)
    if include_pause_features:
        features.update({
            "n_pauses": float(shape["n_pauses"]),
            "straightness": shape["straightness"],
            "overshoot_ratio": shape["overshoot_ratio"],
            "perpendicular_max": shape["perpendicular_max"],
        })
        names += PAUSE_FEATURE_NAMES

    e_par, e_perp = decompose_error(click_xy, center, theta)
    e_par_norm, e_perp_norm = normalize_error(e_par, e_perp, button["size"])

    return {
        "features": features,
        "feature_names": names,
        "labels": {
            "e_parallel": e_par,
            "e_perp": e_perp,
            "e_parallel_norm": e_par_norm,
            "e_perp_norm": e_perp_norm,
            "dx": click_xy[0] - center[0],
            "dy": click_xy[1] - center[1],
            "error_distance_px": error_distance(click_xy, center),
        },
        "meta": {
            "trial_index": trial["trial_index"],
            "phase": trial["phase"],
            "button_size": button["size"],
            "button_radius": radius,
            "button_center": center,
            "click": click_xy,
            "gap": button.get("gap"),
            "grid_positions": button.get("grid_positions"),
            "timeout": trial.get("timeout", False),
            "insufficient_trajectory": trial.get("insufficient_trajectory_flag", False),
            "direction_flag": direction_flag,
            "theta": theta,
            "theta_ballistic": shape["theta_ballistic"],
            "n_pauses": shape["n_pauses"],
            "movement_time_ms": click["time"] - trial["target_onset_time"],
        },
        "shape": shape,
    }


def build_dataset(trials: Sequence[dict], warmup_to_exclude: int = 20,
                  include_pause_features: bool = False) -> dict:
    """시행 목록 → 학습용 배열. 워밍업 앞 N회 제외 (명세서 4.3절).

    timeout 시행은 제외하지 않는다 (4.3절: 플래그만 남기고 속도-정확도 교환의 일부).
    """
    ordered = sorted(trials, key=lambda t: t["trial_index"])
    kept = [t for t in ordered if t["trial_index"] >= warmup_to_exclude]

    rows = [extract_trial(t, include_pause_features) for t in kept]
    rows = [r for r in rows if r is not None]
    if not rows:
        raise ValueError("특징을 추출할 수 있는 시행이 없습니다")

    names = rows[0]["feature_names"]
    X = np.array([[r["features"][n] for n in names] for r in rows], dtype=float)
    Y_norm = np.array([[r["labels"]["e_parallel_norm"], r["labels"]["e_perp_norm"]]
                       for r in rows], dtype=float)
    Y_px = np.array([[r["labels"]["e_parallel"], r["labels"]["e_perp"]]
                     for r in rows], dtype=float)

    return {
        "X": X,
        "Y_norm": Y_norm,
        "Y_px": Y_px,
        "feature_names": names,
        "rows": rows,
        "n_input_trials": len(ordered),
        "n_after_warmup": len(kept),
        "n_usable": len(rows),
    }


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if len(sys.argv) < 2:
        print("사용법: python feature_extraction.py <phase*_export.json>")
        raise SystemExit(1)

    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    ds = build_dataset(data["trials"], include_pause_features=True)

    print(f"입력 {ds['n_input_trials']}시행 → 워밍업 제외 {ds['n_after_warmup']} "
          f"→ 특징 추출 성공 {ds['n_usable']}")
    print(f"특징 {len(ds['feature_names'])}개: {', '.join(ds['feature_names'])}")
    print()
    print("특징 분포:")
    for i, name in enumerate(ds["feature_names"]):
        col = ds["X"][:, i]
        print(f"  {name:>28}: 평균 {col.mean():+10.3f}  SD {col.std(ddof=1):9.3f}  "
              f"범위 {col.min():+9.2f}~{col.max():+9.2f}")

    from collections import Counter
    flags = Counter(r["meta"]["direction_flag"] for r in ds["rows"])
    print()
    print("방향 추정 플래그:", dict(flags))
    pauses = Counter(r["meta"]["n_pauses"] for r in ds["rows"])
    print("멈칫 횟수 분포:", dict(sorted(pauses.items())))
