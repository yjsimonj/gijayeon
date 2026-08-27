"""오차 계산 모듈 — 마우스보정_실험계획서.md 2.2~2.3절 구현.

진행 방향 추정(기본 창 → 3px 미만이면 확대 창으로 재계산 → 그래도 미만이면 결측),
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


# 방향 추정 결과 플래그. 창 길이가 이름에 들어가므로 아래 상수에서 생성해
# 값과 이름이 어긋나지 않게 한다.
#   "ok_150ms"            기본 창으로 추정 성공
#   "ok_250ms_expanded"   기본 창 변위 부족 → 확대 창으로 재계산 성공
#   "insufficient_displacement"  확대 창으로도 부족 → 방향 결측
DirectionFlag = str

MIN_DISPLACEMENT_PX = 3.0

# 명세서 원안은 기본 80ms / 폴백 150ms였다. 그러나 실측 결과 사람은 커서를 목표에
# 세운 뒤에 버튼을 누르므로, 클릭 직전 80~100ms가 사실상 정지 구간이다
# (예비 15시행: 80ms 변위 중앙값 1.41px, 73%가 3px 미만 → 폴백이 기본 경로가 됨).
# 명세서 2.2절이 "마지막 한 샘플(16ms)은 감속 구간"이라 지적한 문제가 16ms가 아니라
# 80~100ms까지 이어지는 것이다. 그래서 기본 창을 150ms로 올리고 폴백을 250ms로 둔다.
# (실측 변위 중앙값: 80ms 1.41px / 120ms 9.22px / 150ms 16.28px / 250ms 37.22px)
PRIMARY_WINDOW_MS = 150.0
FALLBACK_WINDOW_MS = 250.0

PRIMARY_FLAG = f"ok_{PRIMARY_WINDOW_MS:.0f}ms"
FALLBACK_FLAG = f"ok_{FALLBACK_WINDOW_MS:.0f}ms_expanded"
INSUFFICIENT_FLAG = "insufficient_displacement"


def _find_reference_point(
    trajectory: Sequence[TrajectoryPoint], click_time: float, window_ms: float
) -> Optional[TrajectoryPoint]:
    """click_time으로부터 window_ms 이상 이전인 샘플 중 가장 최근(=click_time에 가장 가까운) 것.

    "P_(click-Xms)는 클릭 시각으로부터 X ms 이상 이전인 궤적 샘플 중 가장 최근의 것"
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
      - flag == INSUFFICIENT_FLAG 이면 theta는 None (방향 의존 특징 결측 처리 대상).
    """
    for window_ms, flag in (
        (PRIMARY_WINDOW_MS, PRIMARY_FLAG),
        (FALLBACK_WINDOW_MS, FALLBACK_FLAG),
    ):
        ref = _find_reference_point(trajectory, click_time, window_ms)
        if ref is None:
            continue
        dx = click_xy[0] - ref["x"]
        dy = click_xy[1] - ref["y"]
        displacement = math.hypot(dx, dy)
        if displacement >= MIN_DISPLACEMENT_PX:
            return math.atan2(dy, dx), flag

    return None, INSUFFICIENT_FLAG


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

    # 창 길이를 바꿔도 점검이 따라가도록, 합성 궤적을 상수에서 만든다.
    CLICK_T = 1000.0
    PRIMARY_REF_T = CLICK_T - PRIMARY_WINDOW_MS       # 기본 창의 참조점 시각
    FALLBACK_REF_T = CLICK_T - FALLBACK_WINDOW_MS     # 확대 창의 참조점 시각

    # 1) 방향 추정: 기본 창 참조점에 (0,0), 클릭은 (100,0) → 오른쪽으로 직진 → theta ~= 0
    traj = [
        {"x": 0.0, "y": 0.0, "t": FALLBACK_REF_T},
        {"x": 0.0, "y": 0.0, "t": PRIMARY_REF_T},
        {"x": 50.0, "y": 0.0, "t": PRIMARY_REF_T + 40},
    ]
    theta, flag = estimate_approach_direction(traj, click_time=CLICK_T, click_xy=(100.0, 0.0))
    assert flag == PRIMARY_FLAG, flag
    assert abs(theta - 0.0) < 1e-9, theta
    print(f"[OK] estimate_approach_direction 기본 창: theta={theta:.4f} rad, flag={flag}")

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

    # 6) 폴백: 기본 창 변위(0.5px)는 부족하지만 확대 창 변위(10px)는 충분
    #    → 실제 데이터에서 클릭 직전 정지 구간이 기본 창을 삼킬 때 일어나는 상황
    traj_small = [
        {"x": 0.0, "y": 0.0, "t": FALLBACK_REF_T},   # 확대 창의 참조점
        {"x": 9.5, "y": 0.0, "t": PRIMARY_REF_T},    # 기본 창의 참조점 (여기서 클릭까지 0.5px)
    ]
    theta, flag = estimate_approach_direction(traj_small, click_time=CLICK_T, click_xy=(10.0, 0.0))
    assert flag == FALLBACK_FLAG, flag
    print(f"[OK] 기본 창 변위 부족(0.5px) 시 확대 창 폴백: flag={flag}")

    # 7) 확대 창으로도 변위 3px 미만이면 결측
    traj_stuck = [
        {"x": 0.0, "y": 0.0, "t": t}
        for t in range(int(CLICK_T - FALLBACK_WINDOW_MS * 2), int(CLICK_T), 20)
    ]
    theta, flag = estimate_approach_direction(traj_stuck, click_time=CLICK_T, click_xy=(1.0, 0.0))
    assert theta is None and flag == INSUFFICIENT_FLAG, (theta, flag)
    print(f"[OK] 확대 창으로도 변위 부족 시 결측 처리: theta={theta}, flag={flag}")

    print("\nerror_decomposition.py 자체 점검 전부 통과.")
