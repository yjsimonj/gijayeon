"""저장된 모델을 불러와 보정 벡터를 예측한다. 2·3단계 평가에서 공용으로 쓴다.

명세서 1.3절을 코드로 강제한다: 예측 입력은 궤적 특징뿐이며, 버튼 중심 좌표는
받지 않는다. `predict_correction` 이 쓰는 값은 특징 벡터와 버튼 반폭(4.1절이
입력으로 명시한 값)이다.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional

import numpy as np


class CorrectionModel:
    def __init__(self, payload: dict):
        self.participant_id = payload["participant_id"]
        self.feature_names: list[str] = payload["feature_names"]
        self.target = payload["target"]           # 'screen_dxdy'
        self.alpha = payload["alpha"]
        self.mean = np.array(payload["scaler_mean"], float)
        self.scale = np.array(payload["scaler_scale"], float)
        self.coef = np.array(payload["coef"], float)          # (2, n_features)
        self.intercept = np.array(payload["intercept"], float)  # (2,)
        self.gating_threshold_norm = payload.get("gating_threshold_norm", 0.5)

    @classmethod
    def load(cls, path: Path | str) -> "CorrectionModel":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def predict_error(self, features: dict) -> tuple[float, float]:
        """모델이 예측한 '오차 벡터' (클릭 - 중심). 화면 좌표 기준."""
        x = np.array([features[n] for n in self.feature_names], float)
        xs = (x - self.mean) / self.scale
        pred = self.coef @ xs + self.intercept
        return float(pred[0]), float(pred[1])

    def correct(self, click_xy: tuple[float, float], features: dict,
                button_radius_px: float, gate: bool = False) -> tuple[float, float]:
        """보정 좌표 = 클릭좌표 - 예측오차 (명세서 2.3절 역변환).

        gate=True 이면 명세서 4.5절 게이팅 적용: 예측 크기가 반폭 대비
        임계값 이하이면 보정하지 않는다.
        """
        ex, ey = self.predict_error(features)
        if gate and math.hypot(ex, ey) / button_radius_px <= self.gating_threshold_norm:
            return click_xy
        return click_xy[0] - ex, click_xy[1] - ey


def nearest_button(point: tuple[float, float],
                   centers: list[dict]) -> tuple[int, float, float]:
    """최근접 버튼 스냅 (UI 인식 방식). 반경 제한 없이 항상 하나를 고른다.

    반환: (선택된 인덱스, 최근접 거리, 1위-2위 거리차)
    거리차는 '동률에 가까웠는지'를 사후에 분석할 수 있게 함께 돌려준다.
    """
    dists = [math.hypot(point[0] - c["center_x"], point[1] - c["center_y"]) for c in centers]
    order = sorted(range(len(dists)), key=lambda i: dists[i])
    best = order[0]
    gap = dists[order[1]] - dists[best] if len(order) > 1 else float("inf")
    return best, dists[best], gap


def containing_button(point: tuple[float, float], centers: list[dict],
                      radius_px: float) -> Optional[int]:
    """점을 포함하는 원형 버튼의 인덱스. 없으면 None (= 미스)."""
    for i, c in enumerate(centers):
        if math.hypot(point[0] - c["center_x"], point[1] - c["center_y"]) <= radius_px:
            return i
    return None
