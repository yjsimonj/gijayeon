"""오차 계산 모듈 — 마우스보정_실험계획서.md 2.2~2.3절 구현.

진행 방향 추정(80ms 규칙 → 3px 미만이면 150ms로 확대 재계산 → 그래도 미만이면 결측),
진행 방향 기준 오차 분해(e_parallel, e_perp), 버튼 반폭 정규화, 원클릭 오차 거리를 제공한다.

부호 규약 (명세서 2.3절):
  E = 클릭좌표 - 버튼중심
  u  = 진행 방향 단위벡터 (cos theta, sin theta)
  u_perp = (-sin theta, cos theta)
  e_parallel = E·u   (+ = 오버슛, - = 언더슛)
  e_perp     = E·u_perp

화면 좌표계는 y축이 아래로 증가하므로, u_perp = (-sin theta, cos theta)의 "왼쪽/오른쪽"은
수학적 직관(반시계 방향 90도 회전)과 반대로 화면상에서는 시계 방향 90도 회전에 해당한다.
e_perp의 부호가 어느 쪽 치우침을 뜻하는지는 반드시 실데이터 시각화로 재확인할 것
(명세서 2.3절 경고).
"""

from __future__ import annotations

import math
from typing import Iterable, Literal, Optional, Sequence, TypedDict


class TrajectoryPoint(TypedDict):
    x: float
    y: float
    t: float  # ms, 단조 증가


DirectionFlag = Literal["ok_80ms", "ok_150ms_expanded", "insufficient_displacement"]

MIN_DISPLACEMENT_PX = 3.0
PRIMARY_WINDOW_MS = 80.0
FALLBACK_WINDOW_MS = 150.0


def _find_reference_point(
    trajectory: Sequence[TrajectoryPoint], click_time: float, window_ms: float
) -> Optional[TrajectoryPoint]:
    """click_time으로부터 window_ms 이상 이전인 샘플 중 가장 최근(=click_time에 가장 가까운) 것.

    "P_(click-80ms)는 클릭 시각으로부터 80ms 이상 이전인 궤적 샘플 중 가장 최근의 것"
    (2.2절)을 그대로 구현: t <= click_time - window_ms 인 샘플 중 t가 최대인 것.
    """
    candidates = [p for p in trajectory if p["t"] <= click_time - window_ms]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p["t"])


def estimate_approach_direction(
    trajectory: Sequence[TrajectoryPoint], click_time: float, click_xy: tuple[float, float]
) -> tuple[Optional[float], DirectionFlag]:
    """클릭 직전 접근 방향 theta(라디안)를 추정한다.

    반환: (theta | None, flag)
      - flag == "insufficient_displacement" 이면 theta는 None (방향 의존 특징 결측 처리 대상).
    """
    for window_ms, flag in (
        (PRIMARY_WINDOW_MS, "ok_80ms"),
        (FALLBACK_WINDOW_MS, "ok_150ms_expanded"),
    ):
        ref = _find_reference_point(trajectory, click_time, window_ms)
        if ref is None:
            continue
        dx = click_xy[0] - ref["x"]
        dy = click_xy[1] - ref["y"]
        displacement = math.hypot(dx, dy)
        if displacement >= MIN_DISPLACEMENT_PX:
            return math.atan2(dy, dx), flag  # type: ignore[return-value]

    return None, "insufficient_displacement"


def decompose_error(
    click_xy: tuple[float, float], center_xy: tuple[float, float], theta: float
) -> tuple[float, float]:
    """오차 벡터 E를 진행 방향 기준(u, u_perp)으로 분해한다. 반환: (e_parallel, e_perp)."""
    ex = click_xy[0] - center_xy[0]
    ey = click_xy[1] - center_xy[1]
    ux, uy = math.cos(theta), math.sin(theta)
    e_parallel = ex * ux + ey * uy
    e_perp = ex * (-uy) + ey * ux
    return e_parallel, e_perp


def normalize_error(e_parallel: float, e_perp: float, button_size_px: float) -> tuple[float, float]:
    """버튼 반폭(r = 크기/2)으로 정규화한다. 버튼 내부가 [-1, 1] 구간이 되도록."""
    r = button_size_px / 2.0
    return e_parallel / r, e_perp / r


def error_distance(click_xy: tuple[float, float], center_xy: tuple[float, float]) -> float:
    """클릭좌표와 버튼중심 사이의 유클리드 거리(px)."""
    return math.hypot(click_xy[0] - center_xy[0], click_xy[1] - center_xy[1])


def compute_trial_error(
    trajectory: Sequence[TrajectoryPoint],
    click_time: float,
    click_xy: tuple[float, float],
    center_xy: tuple[float, float],
    button_size_px: float,
) -> dict:
    """한 시행의 궤적·클릭·버튼 정보로부터 방향/오차 성분/정규화값/원거리를 한 번에 계산."""
    theta, flag = estimate_approach_direction(trajectory, click_time, click_xy)
    dist = error_distance(click_xy, center_xy)

    if theta is None:
        return {
            "theta": None,
            "direction_flag": flag,
            "e_parallel": None,
            "e_perp": None,
            "e_parallel_norm": None,
            "e_perp_norm": None,
            "error_distance_px": dist,
        }

    e_par, e_perp = decompose_error(click_xy, center_xy, theta)
    e_par_norm, e_perp_norm = normalize_error(e_par, e_perp, button_size_px)
    return {
        "theta": theta,
        "direction_flag": flag,
        "e_parallel": e_par,
        "e_perp": e_perp,
        "e_parallel_norm": e_par_norm,
        "e_perp_norm": e_perp_norm,
        "error_distance_px": dist,
    }


if __name__ == "__main__":
    import sys

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    # 자체 점검: 실데이터 없이도 부호 규약이 맞는지 합성 데이터로 확인한다.
    # (명세서 2.3절: "분석 전 시각화로 한 번 검증할 것" — 여기서는 수치로 사전 검증.)

    # 1) 방향 추정: click_time=1000ms, click 직전 80ms(t=920)에 (0,0)에 있었고
    #    클릭은 (100, 0) → 오른쪽으로 곧장 이동 → theta ~= 0
    traj = [
        {"x": 0.0, "y": 0.0, "t": 900.0},
        {"x": 0.0, "y": 0.0, "t": 920.0},
        {"x": 50.0, "y": 0.0, "t": 960.0},
    ]
    theta, flag = estimate_approach_direction(traj, click_time=1000.0, click_xy=(100.0, 0.0))
    assert flag == "ok_80ms", flag
    assert abs(theta - 0.0) < 1e-9, theta
    print(f"[OK] estimate_approach_direction 80ms: theta={theta:.4f} rad, flag={flag}")

    # 2) 오버슛: 진행 방향(오른쪽, theta=0) 그대로 목표 중심을 10px 지나쳐 클릭
    #    E = click - center = (10, 0) → e_parallel = +10 (오버슛), e_perp = 0
    e_par, e_perp = decompose_error(click_xy=(110.0, 0.0), center_xy=(100.0, 0.0), theta=0.0)
    assert abs(e_par - 10.0) < 1e-9 and abs(e_perp - 0.0) < 1e-9, (e_par, e_perp)
    print(f"[OK] decompose_error overshoot: e_parallel={e_par:.3f} (기대 +10, 오버슛)")

    # 3) 언더슛: 목표 중심 10px 못 미쳐 클릭 → e_parallel = -10
    e_par, e_perp = decompose_error(click_xy=(90.0, 0.0), center_xy=(100.0, 0.0), theta=0.0)
    assert abs(e_par - (-10.0)) < 1e-9, e_par
    print(f"[OK] decompose_error undershoot: e_parallel={e_par:.3f} (기대 -10, 언더슛)")

    # 4) 수직 편차: 진행 방향(오른쪽, theta=0)에서 화면상 아래쪽(+y)으로 10px 치우쳐 클릭
    #    u_perp = (-sin0, cos0) = (0, 1) → e_perp = E·u_perp = +10
    #    화면 y축이 아래로 증가하므로 "+e_perp = 화면상 아래쪽 치우침"이라는 뜻.
    e_par, e_perp = decompose_error(click_xy=(100.0, 10.0), center_xy=(100.0, 0.0), theta=0.0)
    assert abs(e_par - 0.0) < 1e-9 and abs(e_perp - 10.0) < 1e-9, (e_par, e_perp)
    print(f"[OK] decompose_error lateral: e_perp={e_perp:.3f} (기대 +10, 화면상 아래쪽 치우침)")

    # 5) 정규화: 버튼 크기 20px(r=10) → 오버슛 10px은 e_parallel_norm = 1.0 (경계)
    e_par_n, e_perp_n = normalize_error(10.0, 0.0, button_size_px=20.0)
    assert abs(e_par_n - 1.0) < 1e-9, e_par_n
    print(f"[OK] normalize_error: e_parallel_norm={e_par_n:.3f} (기대 1.0, 버튼 경계)")

    # 6) 변위 3px 미만 폴백: 80ms 구간 변위(0.5px)는 부족하지만 150ms 구간 변위(10px)는 충분
    traj_small = [
        {"x": 0.0, "y": 0.0, "t": 800.0},   # click-200ms: 150ms 규칙(t<=850)의 참조점
        {"x": 9.0, "y": 0.0, "t": 900.0},   # click-100ms
        {"x": 9.5, "y": 0.0, "t": 920.0},   # click-80ms: 80ms 규칙(t<=920)의 참조점
    ]
    theta, flag = estimate_approach_direction(traj_small, click_time=1000.0, click_xy=(10.0, 0.0))
    assert flag == "ok_150ms_expanded", flag
    print(f"[OK] 80ms 변위 부족(0.5px) 시 150ms 폴백: flag={flag}")

    # 7) 150ms로도 변위 3px 미만이면 결측
    traj_stuck = [{"x": 0.0, "y": 0.0, "t": t} for t in range(700, 1000, 20)]
    theta, flag = estimate_approach_direction(traj_stuck, click_time=1000.0, click_xy=(1.0, 0.0))
    assert theta is None and flag == "insufficient_displacement", (theta, flag)
    print(f"[OK] 150ms로도 변위 부족 시 결측 처리: theta={theta}, flag={flag}")

    print("\nerror_decomposition.py 자체 점검 전부 통과.")
