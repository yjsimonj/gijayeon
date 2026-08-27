"""릿지 회귀 학습 + 5-fold 교차검증 (명세서 4.1~4.4절). 참가자별 개별 모델.

명세서 7.3절이 요구한 **3단 베이스라인**을 모두 적합해 비교한다:
  ① 보정 없음
  ② 상수 보정 — 개인 평균 오차만 차감
  ③ 궤적 조건부 릿지 회귀

핵심 주의 (1단계 375시행에서 실측된 사항):
  - e∥/e⊥ 로 회전하면 화면 좌표계의 고정 편향이 8방향 평균에서 상쇄된다.
    실측 Δy = -1.18px (t=-3.28) 이 회전 후 e∥/e⊥ 에서는 사라졌다.
    그래서 예측 대상을 **화면 좌표 (dx, dy)** 로도 학습해 함께 보고한다.
  - 멈칫 특징 4개를 추가하면 e⊥ 의 교차검증 R²가 -1.7% → -3.2% 로 악화됐다.
    기본값은 명세서 4.1절 6특징만 사용한다.

사용법:
    python train_model.py <phase1_export.json> [--out model.json] [--pause-features]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feature_extraction import build_dataset  # noqa: E402

RIDGE_ALPHAS = [0.1, 1.0, 3.0, 10.0, 30.0, 100.0]
N_FOLDS = 5
CV_REPEATS = 20            # 분할 난수에 따른 요동을 줄이기 위해 반복 평균
DEFAULT_WARMUP = 20

# 명세서 4.5절 — 예측 오차 크기가 버튼 반폭 대비 이 값 이하이면 보정하지 않는다
GATING_THRESHOLD_NORM = 0.5


@dataclass
class CVResult:
    target: str            # 'rotated' (e∥/e⊥) 또는 'screen' (dx/dy)
    alpha: float
    r2_first: float        # e∥ 또는 dx
    r2_second: float       # e⊥ 또는 dy
    rmse_first: float
    rmse_second: float


def _cv_predict(X: np.ndarray, Y: np.ndarray, alpha: float,
                n_folds: int = N_FOLDS, repeats: int = CV_REPEATS) -> np.ndarray:
    """반복 k-fold 의 out-of-fold 예측 평균. 각 fold 안에서만 표준화·적합."""
    preds = np.zeros((repeats, *Y.shape))
    for r in range(repeats):
        kf = KFold(n_splits=n_folds, shuffle=True, random_state=r)
        for train_idx, test_idx in kf.split(X):
            model = make_pipeline(StandardScaler(), Ridge(alpha=alpha))
            model.fit(X[train_idx], Y[train_idx])
            preds[r, test_idx] = model.predict(X[test_idx])
    return preds.mean(axis=0)


def _r2_against_mean(Y: np.ndarray, pred: np.ndarray) -> np.ndarray:
    """베이스라인은 '전체 평균'(=상수 보정). 음수면 상수 보정보다 나쁘다는 뜻."""
    ss_res = ((Y - pred) ** 2).sum(axis=0)
    ss_tot = ((Y - Y.mean(axis=0)) ** 2).sum(axis=0)
    return 1.0 - ss_res / ss_tot


def cross_validate(X: np.ndarray, Y: np.ndarray, target_name: str) -> list[CVResult]:
    out = []
    for alpha in RIDGE_ALPHAS:
        pred = _cv_predict(X, Y, alpha)
        r2 = _r2_against_mean(Y, pred)
        rmse = np.sqrt(((Y - pred) ** 2).mean(axis=0))
        out.append(CVResult(target_name, alpha, float(r2[0]), float(r2[1]),
                            float(rmse[0]), float(rmse[1])))
    return out


def evaluate_corrections(ds: dict, alpha: float, use_screen_target: bool) -> dict:
    """① 보정없음 ② 상수보정 ③ 릿지 를 교차검증으로 비교 (명세서 7.3절).

    성공 판정은 원형: |클릭 - 중심| <= 반폭. 보정은 클릭 좌표를 이동시킨다.
    """
    X = ds["X"]
    rows = ds["rows"]
    n = len(rows)

    dxdy = np.array([[r["labels"]["dx"], r["labels"]["dy"]] for r in rows], float)
    radii = np.array([r["meta"]["button_radius"] for r in rows], float)
    thetas = np.array([r["meta"]["theta"] for r in rows], float)

    Y = dxdy if use_screen_target else ds["Y_px"]

    pred_ridge = _cv_predict(X, Y, alpha)

    # 상수 보정도 같은 방식으로 out-of-fold 추정 (학습셋 평균을 평가셋에 적용)
    pred_const = np.zeros_like(Y)
    counts = np.zeros(n)
    for r in range(CV_REPEATS):
        kf = KFold(n_splits=N_FOLDS, shuffle=True, random_state=r)
        for train_idx, test_idx in kf.split(X):
            pred_const[test_idx] += Y[train_idx].mean(axis=0)
            counts[test_idx] += 1
    pred_const /= counts[:, None]

    def to_screen(pred: np.ndarray) -> np.ndarray:
        """예측을 화면 좌표 보정 벡터로 변환."""
        if use_screen_target:
            return pred
        # 회전 좌표계 → 화면 좌표 (명세서 2.3절 역변환)
        ux, uy = np.cos(thetas), np.sin(thetas)
        sx = pred[:, 0] * ux + pred[:, 1] * (-uy)
        sy = pred[:, 0] * uy + pred[:, 1] * ux
        return np.column_stack([sx, sy])

    def summarize(correction: Optional[np.ndarray], gate: bool = False) -> dict:
        if correction is None:
            resid = dxdy
        else:
            applied = correction.copy()
            if gate:
                # 예측 크기가 반폭의 0.5 이하이면 보정하지 않음 (명세서 4.5절)
                mag = np.linalg.norm(applied, axis=1) / radii
                applied[mag <= GATING_THRESHOLD_NORM] = 0.0
            resid = dxdy - applied
        dist = np.linalg.norm(resid, axis=1)
        hit = dist <= radii
        return {
            "mean_error_px": float(dist.mean()),
            "median_error_px": float(np.median(dist)),
            "success_rate": float(hit.mean()),
            "hits": hit.astype(int).tolist(),
        }

    return {
        "none": summarize(None),
        "constant": summarize(to_screen(pred_const)),
        "ridge": summarize(to_screen(pred_ridge)),
        "ridge_gated": summarize(to_screen(pred_ridge), gate=True),
        "alpha": alpha,
        "target": "screen" if use_screen_target else "rotated",
    }


def fit_final(X: np.ndarray, Y: np.ndarray, alpha: float):
    model = make_pipeline(StandardScaler(), Ridge(alpha=alpha))
    model.fit(X, Y)
    return model


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export_path", type=Path, help="1단계 내보내기 JSON")
    ap.add_argument("--out", type=Path, default=None, help="모델 저장 경로(JSON)")
    ap.add_argument("--pause-features", action="store_true",
                    help="멈칫 기반 특징 4개 추가 (기본은 명세서 6특징만)")
    ap.add_argument("--warmup", type=int, default=DEFAULT_WARMUP)
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    data = json.loads(args.export_path.read_text(encoding="utf-8"))
    if data.get("phase") != 1:
        print(f"경고: phase={data.get('phase')} 입니다. 학습은 1단계 로그로 하는 것이 원칙입니다.")

    ds = build_dataset(data["trials"], warmup_to_exclude=args.warmup,
                       include_pause_features=args.pause_features)
    X = ds["X"]
    print(f"참가자 {data['participant_id']} | 입력 {ds['n_input_trials']}시행 "
          f"→ 워밍업 제외 {ds['n_after_warmup']} → 사용 {ds['n_usable']}")
    print(f"특징 {len(ds['feature_names'])}개: {', '.join(ds['feature_names'])}")

    print()
    print("=" * 72)
    print("교차검증 (5-fold × 20회 반복). R² 베이스라인 = 상수 보정")
    print("=" * 72)
    dxdy = np.array([[r["labels"]["dx"], r["labels"]["dy"]] for r in ds["rows"]], float)

    results = {}
    for target_name, Y, labels in [
        ("rotated", ds["Y_px"], ("e∥", "e⊥")),
        ("screen", dxdy, ("Δx", "Δy")),
    ]:
        print(f"\n[예측 대상: {labels[0]} / {labels[1]}]")
        print(f'{"alpha":>8} {"R²(" + labels[0] + ")":>12} {"R²(" + labels[1] + ")":>12} '
              f'{"RMSE1":>9} {"RMSE2":>9}')
        cv = cross_validate(X, Y, target_name)
        results[target_name] = cv
        for r in cv:
            print(f"{r.alpha:>8.1f} {r.r2_first:>+12.4f} {r.r2_second:>+12.4f} "
                  f"{r.rmse_first:>9.3f} {r.rmse_second:>9.3f}")

    # 두 성분 R² 합이 가장 큰 alpha 를 선택
    best = {}
    for name, cv in results.items():
        best[name] = max(cv, key=lambda r: r.r2_first + r.r2_second)
        print(f"\n{name} 최적 alpha = {best[name].alpha} "
              f"(R² {best[name].r2_first:+.4f} / {best[name].r2_second:+.4f})")

    print()
    print("=" * 72)
    print("명세서 7.3절 3단 베이스라인 비교 (교차검증)")
    print("=" * 72)
    comparisons = {}
    for target_name in ("rotated", "screen"):
        use_screen = target_name == "screen"
        ev = evaluate_corrections(ds, best[target_name].alpha, use_screen)
        comparisons[target_name] = ev
        lab = "화면좌표 Δx/Δy" if use_screen else "회전좌표 e∥/e⊥"
        print(f"\n[{lab}, alpha={ev['alpha']}]")
        print(f'{"방식":>22} {"평균오차":>10} {"성공률":>10}')
        for key, name in [("none", "① 보정 없음"), ("constant", "② 상수 보정"),
                          ("ridge", "③ 릿지 회귀"), ("ridge_gated", "③+게이팅(4.5절)")]:
            s = ev[key]
            delta = (s["success_rate"] - ev["none"]["success_rate"]) * 100
            print(f'{name:>22} {s["mean_error_px"]:>9.3f}px {s["success_rate"]*100:>9.2f}%'
                  + (f'  ({delta:+.2f}pt)' if key != "none" else ""))

    # 최종 모델 (전체 데이터로 재적합) — 계수 해석용
    print()
    print("=" * 72)
    print("최종 모델 계수 (표준화 특징 기준, 화면좌표 Δx/Δy)")
    print("=" * 72)
    final = fit_final(X, dxdy, best["screen"].alpha)
    ridge: Ridge = final.named_steps["ridge"]
    print(f'{"특징":>28} {"Δx 계수":>12} {"Δy 계수":>12}')
    for i, name in enumerate(ds["feature_names"]):
        print(f"{name:>28} {ridge.coef_[0][i]:>+12.4f} {ridge.coef_[1][i]:>+12.4f}")
    print(f'{"(절편)":>28} {ridge.intercept_[0]:>+12.4f} {ridge.intercept_[1]:>+12.4f}')

    if args.out:
        payload = {
            "participant_id": data["participant_id"],
            "trained_on_phase": data.get("phase"),
            "n_trials_used": ds["n_usable"],
            "warmup_excluded": args.warmup,
            "feature_names": ds["feature_names"],
            "target": "screen_dxdy",
            "alpha": best["screen"].alpha,
            "scaler_mean": final.named_steps["standardscaler"].mean_.tolist(),
            "scaler_scale": final.named_steps["standardscaler"].scale_.tolist(),
            "coef": ridge.coef_.tolist(),
            "intercept": ridge.intercept_.tolist(),
            "gating_threshold_norm": GATING_THRESHOLD_NORM,
            "cv": {k: [asdict(r) for r in v] for k, v in results.items()},
            "baseline_comparison": {
                k: {kk: {m: vv[m] for m in ("mean_error_px", "median_error_px", "success_rate")}
                    for kk, vv in v.items() if isinstance(vv, dict)}
                for k, v in comparisons.items()
            },
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n모델 저장됨: {args.out}")


if __name__ == "__main__":
    main()
