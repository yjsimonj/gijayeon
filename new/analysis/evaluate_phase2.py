"""2단계 평가 — 1단계로 학습한 모델을 새로 수집한 단일 버튼 120회에 적용 (명세서 3.4절).

같은 시행에 보정 전/후를 모두 계산하므로 대응 검정을 쓴다:
  성공 여부(이진)  → McNemar 검정
  오차 거리(연속)  → 대응표본 t-검정, 정규성 위반 시 Wilcoxon (명세서 6장)

명세서 7.3절의 3단 베이스라인(보정 없음 / 상수 보정 / 릿지)을 함께 보고한다.
스냅은 이 단계에 없다 — 버튼이 하나이므로 정의상 100%.

사용법:
    python evaluate_phase2.py <phase2_export.json> --model <model.json> \
        [--phase1 <phase1_export.json>]

--phase1 을 주면 상수 보정의 오프셋을 1단계에서 학습해 적용한다(정직한 비교).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import stats
from statsmodels.stats.contingency_tables import mcnemar

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feature_extraction import build_dataset  # noqa: E402
from model_io import CorrectionModel  # noqa: E402

WARMUP_PHASE2 = 0  # 2단계는 평가용이므로 워밍업을 따로 빼지 않는다(명세서에 규정 없음)


def paired_report(before: np.ndarray, after: np.ndarray, label: str) -> dict:
    """오차 거리 대응 비교. 정규성(Shapiro)에 따라 t-검정 또는 Wilcoxon."""
    diff = after - before
    n = len(diff)
    mean_b, mean_a = before.mean(), after.mean()

    if np.allclose(diff, 0):
        print(f"  {label}: 변화 없음 (모든 시행에서 동일)")
        return {"n": n, "test": "none", "p": 1.0}

    sh_p = stats.shapiro(diff).pvalue if 3 <= n <= 5000 else 0.0
    if sh_p > 0.05:
        res = stats.ttest_rel(after, before)
        test_name, stat, p = "대응표본 t-검정", res.statistic, res.pvalue
    else:
        res = stats.wilcoxon(after, before)
        test_name, stat, p = "Wilcoxon 부호순위", res.statistic, res.pvalue

    # Cohen's d (대응)
    d = diff.mean() / diff.std(ddof=1) if diff.std(ddof=1) > 0 else 0.0
    print(f"  {label}: {mean_b:.3f} → {mean_a:.3f}px "
          f"({(mean_a-mean_b)/mean_b*100:+.2f}%, {mean_a-mean_b:+.3f}px)")
    print(f"      {test_name}: stat={stat:.3f}, p={p:.4g}, Cohen's d={d:+.3f}, "
          f"정규성 p={sh_p:.3g}")
    return {"n": n, "mean_before": float(mean_b), "mean_after": float(mean_a),
            "test": test_name, "stat": float(stat), "p": float(p), "cohens_d": float(d)}


def mcnemar_report(hit_before: np.ndarray, hit_after: np.ndarray, label: str) -> dict:
    """성공률 대응 비교 (명세서 6장). 불일치 셀이 적으면 정확검정."""
    b_only = int(np.sum(hit_before & ~hit_after))   # 보정 때문에 실패로 바뀜
    a_only = int(np.sum(~hit_before & hit_after))   # 보정 덕에 성공으로 바뀜
    table = [[int(np.sum(hit_before & hit_after)), b_only],
             [a_only, int(np.sum(~hit_before & ~hit_after))]]

    discordant = b_only + a_only
    if discordant == 0:
        print(f"  {label}: 성공/실패가 바뀐 시행이 없음")
        return {"p": 1.0, "gained": 0, "lost": 0}

    exact = discordant < 25
    res = mcnemar(table, exact=exact, correction=not exact)
    rate_b, rate_a = hit_before.mean(), hit_after.mean()
    print(f"  {label}: {rate_b*100:.2f}% → {rate_a*100:.2f}% "
          f"({(rate_a-rate_b)*100:+.2f}pt)")
    print(f"      성공으로 바뀜 {a_only}건 / 실패로 바뀜 {b_only}건, "
          f"McNemar({'정확' if exact else '근사'}) p={res.pvalue:.4g}")
    return {"rate_before": float(rate_b), "rate_after": float(rate_a),
            "gained": a_only, "lost": b_only, "p": float(res.pvalue)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export_path", type=Path, help="2단계 내보내기 JSON")
    ap.add_argument("--model", type=Path, required=True, help="train_model.py 로 만든 모델")
    ap.add_argument("--phase1", type=Path, default=None,
                    help="상수 보정 오프셋을 학습할 1단계 로그")
    ap.add_argument("--out", type=Path, default=None, help="결과 JSON 저장 경로")
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    data = json.loads(args.export_path.read_text(encoding="utf-8"))
    if data.get("phase") != 2:
        print(f"경고: phase={data.get('phase')} — 2단계 로그가 아닙니다.")

    model = CorrectionModel.load(args.model)
    if model.participant_id != data["participant_id"]:
        raise SystemExit(f"참가자 불일치: 모델={model.participant_id}, "
                         f"데이터={data['participant_id']}")

    ds = build_dataset(data["trials"], warmup_to_exclude=WARMUP_PHASE2)
    rows = ds["rows"]
    print(f"참가자 {data['participant_id']} | 2단계 {ds['n_input_trials']}시행 "
          f"→ 사용 {ds['n_usable']}")

    # 상수 보정 오프셋: 1단계에서 학습 (없으면 생략)
    const_offset = None
    if args.phase1:
        p1 = json.loads(args.phase1.read_text(encoding="utf-8"))
        ds1 = build_dataset(p1["trials"], warmup_to_exclude=20)
        dx1 = np.array([r["labels"]["dx"] for r in ds1["rows"]], float)
        dy1 = np.array([r["labels"]["dy"] for r in ds1["rows"]], float)
        const_offset = (float(dx1.mean()), float(dy1.mean()))
        print(f"1단계에서 학습한 상수 오프셋: Δx={const_offset[0]:+.3f}, "
              f"Δy={const_offset[1]:+.3f} (n={ds1['n_usable']})")

    radii = np.array([r["meta"]["button_radius"] for r in rows], float)
    dxdy = np.array([[r["labels"]["dx"], r["labels"]["dy"]] for r in rows], float)

    variants: dict[str, np.ndarray] = {"보정 없음": np.zeros_like(dxdy)}
    if const_offset is not None:
        variants["상수 보정"] = np.tile(np.array(const_offset), (len(rows), 1))
    variants["AI 보정"] = np.array(
        [model.predict_error(r["features"]) for r in rows], float)
    variants["AI 보정+게이팅"] = np.array(
        [(0.0, 0.0) if math.hypot(*model.predict_error(r["features"])) / r["meta"]["button_radius"]
         <= model.gating_threshold_norm else model.predict_error(r["features"])
         for r in rows], float)

    metrics = {}
    print()
    print("=" * 70)
    print("조건별 성적")
    print("=" * 70)
    print(f'{"방식":>18} {"평균오차":>10} {"중앙오차":>10} {"성공률":>10} {"여유(margin)":>13}')
    for name, corr in variants.items():
        resid = dxdy - corr
        dist = np.linalg.norm(resid, axis=1)
        hit = dist <= radii
        margin = radii - dist   # 양수면 버튼 안, 경계까지 거리 (명세서 2.5절)
        metrics[name] = {"dist": dist, "hit": hit, "margin": margin}
        print(f'{name:>18} {dist.mean():>9.3f}px {np.median(dist):>9.3f}px '
              f'{hit.mean()*100:>9.2f}% {margin.mean():>12.3f}px')

    print()
    print("=" * 70)
    print("보정 없음 대비 대응 검정 (명세서 6장)")
    print("=" * 70)
    stats_out = {}
    base = metrics["보정 없음"]
    for name in variants:
        if name == "보정 없음":
            continue
        print(f"\n[{name}]")
        m = metrics[name]
        stats_out[name] = {
            "success": mcnemar_report(base["hit"], m["hit"], "성공률"),
            "error_distance": paired_report(base["dist"], m["dist"], "오차 거리"),
        }

    if args.out:
        payload = {
            "participant_id": data["participant_id"],
            "phase": 2,
            "n_trials": ds["n_usable"],
            "model": str(args.model),
            "constant_offset": const_offset,
            "summary": {k: {"mean_error_px": float(v["dist"].mean()),
                            "median_error_px": float(np.median(v["dist"])),
                            "success_rate": float(v["hit"].mean()),
                            "mean_margin_px": float(v["margin"].mean())}
                        for k, v in metrics.items()},
            "tests": stats_out,
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n결과 저장됨: {args.out}")


if __name__ == "__main__":
    main()
