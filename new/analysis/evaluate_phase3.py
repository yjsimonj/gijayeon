"""3단계 평가 — A/B/C/D 4조건 오프라인 재평가 (명세서 3.5절).

참가자는 시행당 한 번만 클릭했고, 같은 로그에 계산만 네 번 적용한다:
  A. 보정 없음 — 원본 좌표를 포함하는 버튼
  B. AI 보정  — 보정 좌표를 포함하는 버튼
  C. 스냅     — 원본 좌표 기준 최근접 버튼 (반경 제한 없음 → 항상 하나 선택)
  D. 결합     — 보정 좌표 기준 최근접 버튼

지표 (명세서 2.5절): 성공률 / 오선택률 / 미스율.  성공률+오선택률+미스율 = 100%
  C·D 는 항상 버튼을 선택하므로 미스율이 구조적으로 0이고, 미스가 전부 오선택으로
  전환된다 — 이것이 7.2절이 지적한 스냅의 구조적 약점이며 오선택률을 주 지표로
  삼는 이유다. 오차 거리는 C·D 에 적용하지 않는다(2.5절).

검정 (명세서 6장): 4조건 동시 Cochran's Q → 사후 McNemar + Bonferroni 보정.
간격 수준별로 따로 계산해 "간격에 따라 유불리가 뒤집히는" 핵심 결과를 낸다.

사용법:
    python evaluate_phase3.py <phase3_export.json> --model <model.json> [--out result.json]
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
from pathlib import Path

import numpy as np
from statsmodels.stats.contingency_tables import cochrans_q, mcnemar

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feature_extraction import build_dataset  # noqa: E402
from model_io import CorrectionModel, containing_button, nearest_button  # noqa: E402

CONDITIONS = ["A. 보정 없음", "B. AI 보정", "C. 스냅", "D. 결합"]
SNAP_CONDITIONS = {"C. 스냅", "D. 결합"}


def judge(point: tuple[float, float], centers: list[dict], radius: float,
          target_index: int, snap: bool) -> str:
    """한 조건의 판정 결과: 'success' | 'misdirect' | 'miss'."""
    if snap:
        chosen, _, _ = nearest_button(point, centers)
        return "success" if chosen == target_index else "misdirect"
    idx = containing_button(point, centers, radius)
    if idx is None:
        return "miss"
    return "success" if idx == target_index else "misdirect"


def target_index_of(row: dict) -> int:
    """grid_positions 안에서 목표 버튼의 인덱스를 찾는다."""
    centers = row["meta"]["grid_positions"]
    cx, cy = row["meta"]["button_center"]
    for i, c in enumerate(centers):
        if math.isclose(c["center_x"], cx, abs_tol=1e-6) and \
           math.isclose(c["center_y"], cy, abs_tol=1e-6):
            return i
    # 부동소수 오차 대비 최근접으로 대체
    return min(range(len(centers)),
               key=lambda i: math.hypot(centers[i]["center_x"] - cx,
                                        centers[i]["center_y"] - cy))


def gap_label(gap: float, sigma: float | None) -> str:
    if sigma is None or sigma <= 0:
        return f"{gap:.1f}px"
    ratio = gap / sigma
    for target, name in [(0.0, "0 (맞붙음)"), (1.0, "1σ"), (3.0, "3σ")]:
        if math.isclose(ratio, target, abs_tol=0.15):
            return name
    return f"{ratio:.2f}σ"


def summarize(outcomes: dict[str, list[str]], n: int) -> dict:
    out = {}
    for cond, res in outcomes.items():
        arr = np.array(res)
        out[cond] = {
            "success_rate": float((arr == "success").mean()),
            "misdirect_rate": float((arr == "misdirect").mean()),
            "miss_rate": float((arr == "miss").mean()),
            "n": n,
        }
    return out


def print_table(summary: dict, title: str) -> None:
    print(f"\n[{title}]")
    print(f'{"조건":>14} {"성공률":>9} {"오선택률":>10} {"미스율":>9}   합')
    for cond in CONDITIONS:
        if cond not in summary:
            continue
        s = summary[cond]
        total = s["success_rate"] + s["misdirect_rate"] + s["miss_rate"]
        print(f'{cond:>14} {s["success_rate"]*100:>8.2f}% {s["misdirect_rate"]*100:>9.2f}% '
              f'{s["miss_rate"]*100:>8.2f}%   {total*100:.1f}%')


def run_tests(outcomes: dict[str, list[str]], label: str) -> dict:
    """성공 여부에 대한 Cochran's Q + 사후 McNemar (Bonferroni)."""
    conds = [c for c in CONDITIONS if c in outcomes]
    success = {c: (np.array(outcomes[c]) == "success").astype(int) for c in conds}
    misdirect = {c: (np.array(outcomes[c]) == "misdirect").astype(int) for c in conds}

    result = {}
    print(f"\n[{label}] 4조건 동시 비교")
    for metric_name, table in [("성공률", success), ("오선택률", misdirect)]:
        M = np.column_stack([table[c] for c in conds])
        if M.shape[0] < 2 or np.all(M.sum(axis=0) == M.shape[0]) or np.all(M.sum(axis=0) == 0):
            print(f"  {metric_name}: 변동이 없어 검정 불가")
            continue
        q = cochrans_q(M)
        print(f"  {metric_name} Cochran's Q = {q.statistic:.3f}, p = {q.pvalue:.4g}")
        pairs = list(itertools.combinations(conds, 2))
        bonf = len(pairs)
        pair_out = {}
        for a, b in pairs:
            va, vb = table[a].astype(bool), table[b].astype(bool)
            a_only = int(np.sum(va & ~vb))
            b_only = int(np.sum(~va & vb))
            disc = a_only + b_only
            if disc == 0:
                continue
            exact = disc < 25
            r = mcnemar([[int(np.sum(va & vb)), a_only],
                         [b_only, int(np.sum(~va & ~vb))]],
                        exact=exact, correction=not exact)
            p_adj = min(1.0, r.pvalue * bonf)
            pair_out[f"{a} vs {b}"] = {
                "rate_a": float(va.mean()), "rate_b": float(vb.mean()),
                "p_raw": float(r.pvalue), "p_bonferroni": float(p_adj),
            }
            if p_adj < 0.05:
                print(f"    {a} {va.mean()*100:.1f}% vs {b} {vb.mean()*100:.1f}%  "
                      f"p={r.pvalue:.4g} → 보정 후 {p_adj:.4g} *")
        result[metric_name] = {"cochran_q": float(q.statistic),
                               "cochran_p": float(q.pvalue),
                               "pairwise": pair_out}
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export_path", type=Path, help="3단계 내보내기 JSON")
    ap.add_argument("--model", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    data = json.loads(args.export_path.read_text(encoding="utf-8"))
    if data.get("phase") != 3:
        print(f"경고: phase={data.get('phase')} — 3단계 로그가 아닙니다.")

    model = CorrectionModel.load(args.model)
    if model.participant_id != data["participant_id"]:
        raise SystemExit(f"참가자 불일치: 모델={model.participant_id}, "
                         f"데이터={data['participant_id']}")

    ds = build_dataset(data["trials"], warmup_to_exclude=0)
    rows = ds["rows"]
    print(f"참가자 {data['participant_id']} | 3단계 {ds['n_input_trials']}시행 "
          f"→ 사용 {ds['n_usable']}")

    sigma = next((t.get("gap_sigma_px") for t in data["trials"]
                  if t.get("gap_sigma_px")), None)
    if sigma:
        print(f"간격 산출에 쓰인 σ = {sigma:.3f}px")

    # 조건별 판정
    records = []
    for r in rows:
        centers = r["meta"]["grid_positions"]
        if not centers:
            continue
        radius = r["meta"]["button_radius"]
        ti = target_index_of(r)
        raw = r["meta"]["click"]
        corrected = model.correct(raw, r["features"], radius, gate=False)

        records.append({
            "gap": r["meta"]["gap"],
            "size": r["meta"]["button_size"],
            "outcomes": {
                "A. 보정 없음": judge(raw, centers, radius, ti, snap=False),
                "B. AI 보정": judge(corrected, centers, radius, ti, snap=False),
                "C. 스냅": judge(raw, centers, radius, ti, snap=True),
                "D. 결합": judge(corrected, centers, radius, ti, snap=True),
            },
            "snap_gap_raw": nearest_button(raw, centers)[2],
            "error_px": math.hypot(raw[0] - r["meta"]["button_center"][0],
                                   raw[1] - r["meta"]["button_center"][1]),
        })

    if not records:
        raise SystemExit("grid_positions 가 있는 시행이 없습니다 — 3단계 로그인지 확인하세요.")

    print()
    print("=" * 72)
    print("전체 (간격 통합)")
    print("=" * 72)
    all_out = {c: [rec["outcomes"][c] for rec in records] for c in CONDITIONS}
    overall = summarize(all_out, len(records))
    print_table(overall, f"전체 n={len(records)}")
    overall_tests = run_tests(all_out, "전체")

    print()
    print("=" * 72)
    print("간격별 — 명세서 7.1절 핵심 결과")
    print("=" * 72)
    by_gap: dict[float, list[dict]] = {}
    for rec in records:
        by_gap.setdefault(round(rec["gap"], 3), []).append(rec)

    per_gap = {}
    gap_tests = {}
    for gap in sorted(by_gap):
        sub = by_gap[gap]
        lbl = gap_label(gap, sigma)
        out = {c: [rec["outcomes"][c] for rec in sub] for c in CONDITIONS}
        s = summarize(out, len(sub))
        per_gap[lbl] = s
        print_table(s, f"간격 {lbl} ({gap:.1f}px), n={len(sub)}")
        gap_tests[lbl] = run_tests(out, f"간격 {lbl}")

    print()
    print("=" * 72)
    print("오선택률 추이 (7.1절 그래프의 수치)")
    print("=" * 72)
    print(f'{"간격":>14} ' + ' '.join(f'{c:>13}' for c in CONDITIONS))
    for lbl, s in per_gap.items():
        print(f'{lbl:>14} ' + ' '.join(
            f'{s[c]["misdirect_rate"]*100:>12.2f}%' for c in CONDITIONS))
    print("\nC(스냅)와 D(결합)의 오선택률 격차:")
    for lbl, s in per_gap.items():
        d = (s["C. 스냅"]["misdirect_rate"] - s["D. 결합"]["misdirect_rate"]) * 100
        print(f'  {lbl:>14}: {d:+.2f}pt  '
              f'{"(D가 개선)" if d > 0 else "(D가 악화)" if d < 0 else "(동일)"}')

    if args.out:
        payload = {
            "participant_id": data["participant_id"],
            "phase": 3,
            "n_trials": len(records),
            "sigma_px": sigma,
            "model": str(args.model),
            "overall": overall,
            "overall_tests": overall_tests,
            "per_gap": per_gap,
            "per_gap_tests": gap_tests,
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n결과 저장됨: {args.out}")


if __name__ == "__main__":
    main()
