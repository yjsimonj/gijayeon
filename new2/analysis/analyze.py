#!/usr/bin/env python
"""
마우스 보정 실험 v3 — 수집 완료 후 분석 (계획서 §6)

  주 지표: 성공률 (데이터를 보기 전에 확정. §6.3)
  보조   : 오차 거리, 반복측정 ANOVA

세 조건 (평가 = 뒤 200회)
  A 보정 없음   클릭 좌표 그대로
  B 남의 편향   클릭 − (본인 제외 나머지 참가자 벡터의 평균)
  C 본인 편향   클릭 − 본인 벡터

부호 규약(§5): error = click − target,  보정좌표 = 클릭좌표 − 편향벡터.
여기서 틀리면 결과가 정확히 반대로 나오므로, 아래 [1]에서 "본인 벡터를 빼면
학습 구간의 평균 오차가 줄어드는가"를 기계적으로 확인해 부호를 자체 점검한다.
--figures 로 산점도를 뽑아 눈으로도 확인할 것(§9 체크리스트).

사용법
  python analyze.py ../data                     # 폴더 안의 main_*.json 전부
  python analyze.py ../data/main_P0*.json       # 파일 직접 지정
  python analyze.py ../data --out result.json --figures ../figures
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from dataclasses import dataclass, field

import numpy as np
from scipy import stats

CONDITIONS = ("A", "B", "C")
CONDITION_LABEL = {
    "A": "A 보정 없음",
    "B": "B 남의 편향",
    "C": "C 본인 편향",
}


# ---------------------------------------------------------------- 로드

@dataclass
class Participant:
    pid: str
    path: str
    button_size_px: float
    train: list = field(default_factory=list)   # 학습 구간 시행 (dict)
    test: list = field(default_factory=list)    # 평가 구간 시행 (dict)
    n_main: int = 0
    n_no_response: int = 0
    n_timeout: int = 0
    dev_mode: bool = False
    input_device: str = "?"
    vector: tuple = (0.0, 0.0)
    others_vector: tuple = (0.0, 0.0)


def expand_inputs(args_paths):
    files = []
    for p in args_paths:
        if os.path.isdir(p):
            files += sorted(glob.glob(os.path.join(p, "*.json")))
        else:
            hits = sorted(glob.glob(p))
            files += hits if hits else [p]
    # 중복 제거(순서 유지)
    seen, out = set(), []
    for f in files:
        key = os.path.abspath(f)
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


def main_index_of(trial, fallback):
    mi = trial.get("main_index")
    return fallback if mi is None else mi


def load_participant(path, warnings):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if data.get("mode") != "main":
        return None  # 모드 A(sizing) 파일이나 다른 산출물은 조용히 넘긴다
    if data.get("schema_version") != "3.0":
        warnings.append(f"{os.path.basename(path)}: schema_version={data.get('schema_version')} (기대 3.0)")

    cfg = data.get("config", {})
    train_split = cfg.get("train_split")
    default_size = cfg.get("button_size_px")

    p = Participant(
        pid=str(data.get("participant_id")),
        path=path,
        button_size_px=float(default_size) if default_size else float("nan"),
        dev_mode=bool(data.get("dev_mode")),
        input_device=(data.get("environment") or {}).get("input_device", "?"),
    )
    if data.get("dummy"):
        warnings.append(f"{p.pid}: make_dummy.py 가 만든 더미 데이터입니다 — 결과로 보고하면 안 됩니다")
    if data.get("aborted"):
        warnings.append(f"{p.pid}: 중단된 세션입니다 (aborted=true)")
    if p.dev_mode:
        warnings.append(f"{p.pid}: dev=1 축소 모드 데이터입니다 — 본실험에 쓰면 안 됩니다")
    if p.input_device != "mouse":
        warnings.append(f"{p.pid}: 입력 장치가 '{p.input_device}' 입니다 (계획서 §7: 트랙패드 금지)")

    main_trials = [t for t in data["trials"] if not t.get("warmup")]
    p.n_main = len(main_trials)
    if train_split is None:
        train_split = int(round(p.n_main * 2 / 3))
        warnings.append(f"{p.pid}: config.train_split이 없어 {train_split} 로 가정했습니다")

    for order, t in enumerate(main_trials):
        mi = main_index_of(t, order)
        if t.get("no_response") or t.get("click") is None:
            p.n_no_response += 1
            continue                      # 무응답만 제외. timeout은 유지(§4.3)
        if t.get("timeout"):
            p.n_timeout += 1

        size = t.get("button_size_px") or default_size
        rec = {
            "main_index": mi,
            "radius": float(size) / 2.0,
            "cx": float(t["click"]["x"]),
            "cy": float(t["click"]["y"]),
            "tx": float(t["target"]["x"]),
            "ty": float(t["target"]["y"]),
            "ex": float(t["error_x"]),
            "ey": float(t["error_y"]),
            "direction_deg": t.get("direction_deg"),
            "rt_ms": t.get("rt_ms"),
            "timeout": bool(t.get("timeout")),
        }
        (p.train if mi < train_split else p.test).append(rec)

    return p


# ---------------------------------------------------------------- 통계

def cochran_q(matrix):
    """matrix: (N trials, k conditions) 0/1. Cochran's Q 와 p (df = k-1)."""
    m = np.asarray(matrix, dtype=float)
    n, k = m.shape
    col = m.sum(axis=0)
    row = m.sum(axis=1)
    denom = k * row.sum() - (row ** 2).sum()
    if denom == 0:
        return float("nan"), float("nan"), k - 1
    q = (k - 1) * (k * (col ** 2).sum() - col.sum() ** 2) / denom
    return q, float(stats.chi2.sf(q, k - 1)), k - 1


def mcnemar_exact(a, b):
    """같은 시행에 대한 두 0/1 벡터. 불일치쌍 이항 정확검정(양측)."""
    a = np.asarray(a, dtype=bool)
    b = np.asarray(b, dtype=bool)
    n01 = int(np.sum(~a & b))   # a 실패 → b 성공
    n10 = int(np.sum(a & ~b))   # a 성공 → b 실패
    if n01 + n10 == 0:
        return n01, n10, 1.0
    p = stats.binomtest(min(n01, n10), n01 + n10, 0.5, alternative="two-sided").pvalue
    return n01, n10, float(p)


def rm_anova_oneway(matrix):
    """참가자 × 조건 반복측정 일원배치 ANOVA. matrix: (n_subj, k)."""
    m = np.asarray(matrix, dtype=float)
    n, k = m.shape
    if n < 2:
        return {"F": None, "p": None, "df": None, "note": "참가자 2명 미만 — 계산 불가"}
    grand = m.mean()
    ss_cond = n * ((m.mean(axis=0) - grand) ** 2).sum()
    ss_subj = k * ((m.mean(axis=1) - grand) ** 2).sum()
    ss_total = ((m - grand) ** 2).sum()
    ss_err = ss_total - ss_cond - ss_subj
    df_cond, df_err = k - 1, (k - 1) * (n - 1)
    if df_err <= 0 or ss_err <= 0:
        return {"F": None, "p": None, "df": [df_cond, df_err], "note": "오차항이 0 — 계산 불가"}
    f = (ss_cond / df_cond) / (ss_err / df_err)
    return {
        "F": float(f),
        "p": float(stats.f.sf(f, df_cond, df_err)),
        "df": [df_cond, df_err],
        "partial_eta_sq": float(ss_cond / (ss_cond + ss_err)),
        "note": None,
    }


def paired_test(x, y):
    """대응표본 검정 + 효과크기. 정규성 위반이면 Wilcoxon 도 함께 보고."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    d = y - x
    if np.allclose(d, 0):
        return {"n": int(len(d)), "mean_diff": 0.0, "t_p": 1.0, "cohen_d": 0.0,
                "wilcoxon_p": 1.0, "shapiro_p": None}
    t_stat, t_p = stats.ttest_rel(x, y)
    try:
        w_p = float(stats.wilcoxon(x, y).pvalue)
    except ValueError:
        w_p = None
    shapiro_p = float(stats.shapiro(d).pvalue) if 3 <= len(d) <= 5000 else None
    sd = d.std(ddof=1)
    return {
        "n": int(len(d)),
        "mean_diff": float(d.mean()),
        "t": float(t_stat),
        "t_p": float(t_p),
        "cohen_d": float(d.mean() / sd) if sd > 0 else 0.0,
        "wilcoxon_p": w_p,
        "shapiro_p": shapiro_p,
    }


# ---------------------------------------------------------------- 분석 본체

def apply_correction(rec, offset):
    """보정좌표 = 클릭좌표 − 편향벡터 (§5). 성공 = 중심에서 반지름 이내."""
    x = rec["cx"] - offset[0]
    y = rec["cy"] - offset[1]
    dist = math.hypot(x - rec["tx"], y - rec["ty"])
    return dist <= rec["radius"], dist


def analyze(participants, alpha=0.05):
    n_p = len(participants)

    # ---- §6.1 개인 편향 벡터 (학습 구간) ----
    for p in participants:
        ex = np.array([r["ex"] for r in p.train])
        ey = np.array([r["ey"] for r in p.train])
        p.vector = (float(ex.mean()), float(ey.mean()))
        p.train_se = (float(ex.std(ddof=1) / math.sqrt(len(ex))),
                      float(ey.std(ddof=1) / math.sqrt(len(ey)))) if len(ex) > 1 else (float("nan"),) * 2

    # B는 "본인 제외 나머지 전원 평균" (§6.2). 한 명만 빌리면 하필 그 사람이
    # 비슷하냐로 결과가 흔들리고, B와 C의 차이가 "개인차 몫"이라는 의미를 잃는다.
    for p in participants:
        others = [q.vector for q in participants if q.pid != p.pid]
        p.others_vector = (float(np.mean([v[0] for v in others])),
                           float(np.mean([v[1] for v in others]))) if others else (0.0, 0.0)

    usable_conditions = list(CONDITIONS) if n_p >= 2 else ["A", "C"]

    # ---- 평가 구간에 세 조건 적용 ----
    pooled = {c: [] for c in CONDITIONS}       # 시행 단위 성공 0/1 (참가자 통합)
    pooled_dist = {c: [] for c in CONDITIONS}  # 시행 단위 오차 거리
    per_participant = []

    for p in participants:
        offsets = {"A": (0.0, 0.0), "B": p.others_vector, "C": p.vector}
        succ = {c: [] for c in CONDITIONS}
        dists = {c: [] for c in CONDITIONS}
        for rec in p.test:
            for c in CONDITIONS:
                ok, d = apply_correction(rec, offsets[c])
                succ[c].append(1 if ok else 0)
                dists[c].append(d)
        for c in CONDITIONS:
            pooled[c] += succ[c]
            pooled_dist[c] += dists[c]

        per_participant.append({
            "participant_id": p.pid,
            "n_train": len(p.train),
            "n_test": len(p.test),
            "n_main": p.n_main,
            "n_no_response": p.n_no_response,
            "n_timeout": p.n_timeout,
            "input_device": p.input_device,
            "vector_px": {"x": p.vector[0], "y": p.vector[1]},
            "vector_magnitude_px": float(math.hypot(*p.vector)),
            "vector_se_px": {"x": p.train_se[0], "y": p.train_se[1]},
            "others_vector_px": {"x": p.others_vector[0], "y": p.others_vector[1]},
            "success_rate": {c: float(np.mean(succ[c])) if succ[c] else None for c in CONDITIONS},
            "mean_error_px": {c: float(np.mean(dists[c])) if dists[c] else None for c in CONDITIONS},
        })

    # ---- §6.3 주 검정: 성공률 ----
    matrix = np.array([pooled[c] for c in usable_conditions], dtype=int).T
    q, q_p, q_df = cochran_q(matrix)

    pairs = [(usable_conditions[i], usable_conditions[j])
             for i in range(len(usable_conditions)) for j in range(i + 1, len(usable_conditions))]
    posthoc = {}
    for c1, c2 in pairs:
        n01, n10, p_raw = mcnemar_exact(pooled[c1], pooled[c2])
        posthoc[f"{c1} vs {c2}"] = {
            "success_rate": [float(np.mean(pooled[c1])), float(np.mean(pooled[c2]))],
            "flips_to_success": n01,
            "flips_to_failure": n10,
            "p_raw": p_raw,
            "p_bonferroni": min(1.0, p_raw * len(pairs)),
            "significant": min(1.0, p_raw * len(pairs)) < alpha,
        }

    # ---- 보조: 오차 거리 (시행 단위 대응표본) + 반복측정 ANOVA (참가자 단위) ----
    dist_tests = {}
    for c1, c2 in pairs:
        dist_tests[f"{c1} vs {c2}"] = paired_test(pooled_dist[c1], pooled_dist[c2])

    subj_success = np.array([[pp["success_rate"][c] for c in usable_conditions] for pp in per_participant], dtype=float)
    subj_error = np.array([[pp["mean_error_px"][c] for c in usable_conditions] for pp in per_participant], dtype=float)
    rm_success = rm_anova_oneway(subj_success)
    rm_error = rm_anova_oneway(subj_error)

    # ---- 편향의 개인차가 실재하는가 (이 연구의 전제) ----
    individual = {}
    if n_p >= 2:
        groups_x = [[r["ex"] for r in p.train] for p in participants]
        groups_y = [[r["ey"] for r in p.train] for p in participants]
        fx = stats.f_oneway(*groups_x)
        fy = stats.f_oneway(*groups_y)
        vx = np.array([p.vector[0] for p in participants])
        vy = np.array([p.vector[1] for p in participants])
        individual = {
            "between_participant_sd_px": {"x": float(vx.std(ddof=1)), "y": float(vy.std(ddof=1))},
            "mean_within_se_px": {
                "x": float(np.mean([p.train_se[0] for p in participants])),
                "y": float(np.mean([p.train_se[1] for p in participants])),
            },
            "oneway_anova_error_x": {"F": float(fx.statistic), "p": float(fx.pvalue)},
            "oneway_anova_error_y": {"F": float(fy.statistic), "p": float(fy.pvalue)},
            "group_mean_vector_px": {"x": float(vx.mean()), "y": float(vy.mean())},
        }

    # ---- 부호 자체 점검: 본인 벡터를 빼면 학습 구간 평균 오차가 줄어야 한다 ----
    sign_check = []
    for p in participants:
        before = float(np.mean([math.hypot(r["ex"], r["ey"]) for r in p.train]))
        after = float(np.mean([
            math.hypot(r["ex"] - p.vector[0], r["ey"] - p.vector[1]) for r in p.train
        ]))
        sign_check.append({"participant_id": p.pid, "train_mean_error_before": before,
                           "train_mean_error_after": after, "improved": after <= before})

    # ---- §6.4 결론 ----
    verdict = decide(posthoc, pooled, usable_conditions, alpha, n_p)

    return {
        "primary_metric": "success_rate (사전 확정, 계획서 §6.3)",
        "alpha": alpha,
        "n_participants": n_p,
        "conditions_used": usable_conditions,
        "n_test_trials_pooled": int(matrix.shape[0]),
        "success_rate_pooled": {c: float(np.mean(pooled[c])) for c in CONDITIONS if pooled[c]},
        "mean_error_px_pooled": {c: float(np.mean(pooled_dist[c])) for c in CONDITIONS if pooled_dist[c]},
        "cochran_q": {"Q": q, "p": q_p, "df": q_df, "k": len(usable_conditions)},
        "posthoc_mcnemar_bonferroni": posthoc,
        "error_distance_paired_tests": dist_tests,
        "rm_anova_success_rate": rm_success,
        "rm_anova_error_distance": rm_error,
        "individual_differences": individual,
        "sign_convention_check": sign_check,
        "per_participant": per_participant,
        "verdict": verdict,
    }


def decide(posthoc, pooled, used, alpha, n_p):
    """§6.4 세 갈래 판정. ❌도 결론이다 — 연구계획서 1장의 전제가 틀렸다는 뜻."""
    def better(c1, c2):
        key = f"{c1} vs {c2}" if f"{c1} vs {c2}" in posthoc else f"{c2} vs {c1}"
        if key not in posthoc:
            return None
        item = posthoc[key]
        rates = dict(zip(key.split(" vs "), item["success_rate"]))
        return item["significant"] and rates[c1] > rates[c2]

    c_gt_a = better("C", "A")
    c_gt_b = better("C", "B") if "B" in used else None
    b_gt_a = better("B", "A") if "B" in used else None

    if c_gt_a is None:
        return {"code": "unknown", "text": "판정 불가 — 조건 비교가 성립하지 않습니다."}
    if not c_gt_a:
        # 세 갈래 표(§6.4)에는 없지만, B > A 인데 C ≈ A 인 경우가 실제로 나올 수 있다.
        # "공통 편향만 빼도 되는" 상태이므로 결론이 달라진다 — 뭉개지 말고 따로 적는다.
        if b_gt_a:
            return {"code": "common_only",
                    "text": "C ≈ A 인데 B > A → 개인 벡터로는 이득이 없고 공통 편향(남의 평균)을 "
                            "빼는 것만으로 성공률이 올랐다. 개인 벡터 추정이 잡음에 묻혔을 가능성 "
                            "(학습 구간을 늘리거나 버튼을 더 작게)을 함께 검토할 것."}
        return {"code": "no_effect",
                "text": "C ≈ A → 보정이 성공률을 올리지 못했다 ❌ "
                        "(연구계획서 1장의 전제가 틀렸다는 결론이며, 이 자체가 보고 가치가 있다)"}
    if "B" not in used:
        return {"code": "c_beats_a_only",
                "text": "C > A 지만 참가자가 1명이라 B(남의 편향)를 만들 수 없다 — "
                        "개인화 필요성은 판정 불가. 8명을 채워야 한다."}
    if c_gt_b:
        return {"code": "personalization_needed",
                "text": "C > A 그리고 C > B → 보정이 되고, 개인화가 필요하다 ✅"}
    return {"code": "correction_but_not_personal",
            "text": "C > A 인데 C ≈ B → 보정은 되지만 개인화는 무의미하다 "
                    "(다들 같은 방향으로 치우친다)"}


# ---------------------------------------------------------------- 보고서 출력

def fmt_p(p):
    if p is None:
        return "—"
    if p != p:  # NaN
        return "nan"
    return f"{p:.4f}" if p >= 1e-4 else f"{p:.2e}"


def print_report(res, warnings, files):
    W = 78
    print("=" * W)
    print("마우스 보정 실험 v3 — 분석 (계획서 §6)")
    print("=" * W)
    print(f"입력 파일 {len(files)}개 · 참가자 {res['n_participants']}명 · "
          f"평가 시행(통합) {res['n_test_trials_pooled']}회")
    print(f"주 지표: {res['primary_metric']} · α = {res['alpha']}")
    if warnings:
        print("\n[경고]")
        for w in warnings:
            print("  ! " + w)

    print("\n[1] 부호 규약 자체 점검 — 본인 벡터를 빼면 학습 구간 평균 오차가 줄어야 한다")
    for row in res["sign_convention_check"]:
        mark = "OK " if row["improved"] else "!! "
        print(f"  {mark}{row['participant_id']}: "
              f"{row['train_mean_error_before']:.3f} → {row['train_mean_error_after']:.3f} px")
    if not all(r["improved"] for r in res["sign_convention_check"]):
        print("  !! 줄지 않은 참가자가 있습니다 — error_x/error_y 부호나 보정 방향을 확인하세요.")

    print("\n[2] 개인 편향 벡터 (학습 구간 평균 오차)")
    print(f"  {'ID':<10}{'n_tr':>6}{'n_te':>6}{'vec_x':>9}{'vec_y':>9}{'|vec|':>8}"
          f"{'others_x':>10}{'others_y':>10}{'timeout':>9}{'무응답':>8}")
    for pp in res["per_participant"]:
        print(f"  {pp['participant_id']:<10}{pp['n_train']:>6}{pp['n_test']:>6}"
              f"{pp['vector_px']['x']:>9.2f}{pp['vector_px']['y']:>9.2f}"
              f"{pp['vector_magnitude_px']:>8.2f}"
              f"{pp['others_vector_px']['x']:>10.2f}{pp['others_vector_px']['y']:>10.2f}"
              f"{pp['n_timeout']:>9}{pp['n_no_response']:>8}")

    ind = res["individual_differences"]
    if ind:
        print("\n[3] 편향의 개인차가 실재하는가 (이 연구의 전제)")
        print(f"  집단 평균 벡터        : ({ind['group_mean_vector_px']['x']:+.2f}, "
              f"{ind['group_mean_vector_px']['y']:+.2f}) px  ← 모두에게 공통인 몫")
        print(f"  참가자 간 SD          : x {ind['between_participant_sd_px']['x']:.2f}, "
              f"y {ind['between_participant_sd_px']['y']:.2f} px")
        print(f"  참가자 내 추정오차 SE : x {ind['mean_within_se_px']['x']:.2f}, "
              f"y {ind['mean_within_se_px']['y']:.2f} px  ← 이보다 커야 개인차가 실재")
        print(f"  일원배치 ANOVA error_x: F={ind['oneway_anova_error_x']['F']:.2f}, "
              f"p={fmt_p(ind['oneway_anova_error_x']['p'])}")
        print(f"  일원배치 ANOVA error_y: F={ind['oneway_anova_error_y']['F']:.2f}, "
              f"p={fmt_p(ind['oneway_anova_error_y']['p'])}")

    print("\n[4] 세 조건 성공률 (평가 구간, 참가자 통합) — 주 지표")
    for c in res["conditions_used"]:
        sr = res["success_rate_pooled"].get(c)
        me = res["mean_error_px_pooled"].get(c)
        print(f"  {CONDITION_LABEL[c]:<14} 성공률 {sr * 100:6.2f}%   평균 오차 {me:6.3f} px")

    q = res["cochran_q"]
    print(f"\n[5] 주 검정 — Cochran's Q (k={q['k']}, df={q['df']}): "
          f"Q = {q['Q']:.3f}, p = {fmt_p(q['p'])}")
    if q["p"] is not None and q["p"] == q["p"] and q["p"] < res["alpha"]:
        print("  → 유의. 사후 McNemar 정확검정 + Bonferroni:")
    else:
        print("  → 유의하지 않음. (사후검정은 참고용)")
    for name, item in res["posthoc_mcnemar_bonferroni"].items():
        a, b = item["success_rate"]
        print(f"     {name:<10} {a * 100:6.2f}% → {b * 100:6.2f}%  "
              f"(성공 전환 {item['flips_to_success']}건 / 실패 전환 {item['flips_to_failure']}건)  "
              f"p_raw={fmt_p(item['p_raw'])}  p_bonf={fmt_p(item['p_bonferroni'])}"
              f"{'  *' if item['significant'] else ''}")

    print("\n[6] 보조 지표")
    for name, t in res["error_distance_paired_tests"].items():
        print(f"  오차 거리 {name:<10} Δ={t['mean_diff']:+.3f} px, d={t['cohen_d']:+.3f}, "
              f"t-p={fmt_p(t['t_p'])}, Wilcoxon-p={fmt_p(t['wilcoxon_p'])}")
    for label, rm in (("성공률", res["rm_anova_success_rate"]), ("오차 거리", res["rm_anova_error_distance"])):
        if rm["F"] is None:
            print(f"  반복측정 ANOVA ({label}): {rm['note']}")
        else:
            print(f"  반복측정 ANOVA ({label}): F({rm['df'][0]},{rm['df'][1]}) = {rm['F']:.3f}, "
                  f"p = {fmt_p(rm['p'])}, partial η² = {rm['partial_eta_sq']:.3f}")

    print("\n[7] 결론 (§6.4)")
    print("  " + res["verdict"]["text"])
    print("=" * W)


# ---------------------------------------------------------------- 그림

def make_figures(participants, res, outdir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib import font_manager
    except ImportError:
        print("(matplotlib이 없어 그림은 건너뜁니다: pip install matplotlib)")
        return []

    have_ko = False
    for cand in ("Malgun Gothic", "AppleGothic", "NanumGothic", "Noto Sans CJK KR"):
        if any(f.name == cand for f in font_manager.fontManager.ttflist):
            matplotlib.rcParams["font.family"] = cand
            have_ko = True
            break
    matplotlib.rcParams["axes.unicode_minus"] = False
    L = (lambda ko, en: ko) if have_ko else (lambda ko, en: en)

    os.makedirs(outdir, exist_ok=True)
    made = []

    # (1) 오차 산점도 — 부호 규약을 눈으로 확인 (§9 체크리스트)
    n = len(participants)
    cols = min(4, n)
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(3.2 * cols, 3.2 * rows), squeeze=False)
    for ax in axes.flat:
        ax.set_visible(False)
    for i, p in enumerate(participants):
        ax = axes[i // cols][i % cols]
        ax.set_visible(True)
        ex = [r["ex"] for r in p.train]
        ey = [r["ey"] for r in p.train]
        ax.scatter(ex, ey, s=6, alpha=0.35, color="#2563eb", linewidths=0)
        ax.axhline(0, color="#9ca3af", lw=0.8)
        ax.axvline(0, color="#9ca3af", lw=0.8)
        ax.add_patch(plt.Circle((0, 0), p.train[0]["radius"], fill=False, color="#dc2626", lw=1.2))
        ax.annotate("", xy=p.vector, xytext=(0, 0),
                    arrowprops=dict(arrowstyle="->", color="#b45309", lw=2))
        ax.set_title(f"{p.pid}  vec=({p.vector[0]:+.2f}, {p.vector[1]:+.2f})", fontsize=9)
        ax.set_xlabel("error_x (px)", fontsize=8)
        ax.set_ylabel("error_y (px)", fontsize=8)
        ax.invert_yaxis()   # 화면 좌표계: y는 아래로 증가
        ax.set_aspect("equal", adjustable="datalim")
        ax.tick_params(labelsize=7)
    fig.suptitle(L("학습 구간 오차 산점도 (y축 아래로 증가 = 화면 좌표계, 빨간 원 = 버튼 경계)",
                   "Training-phase error scatter (y down = screen coords; red = button edge)"),
                 fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    path = os.path.join(outdir, "error_scatter.png")
    fig.savefig(path, dpi=140)
    plt.close(fig)
    made.append(path)

    # (2) 조건별 성공률
    used = res["conditions_used"]
    fig, ax = plt.subplots(figsize=(5.2, 4))
    xs = np.arange(len(used))
    vals = [res["success_rate_pooled"][c] * 100 for c in used]
    ax.bar(xs, vals, color=["#9ca3af", "#60a5fa", "#2563eb"][:len(used)], width=0.6)
    for pp in res["per_participant"]:
        ax.plot(xs, [pp["success_rate"][c] * 100 for c in used], marker="o", ms=3,
                lw=0.8, color="#1f2430", alpha=0.35)
    for x, v in zip(xs, vals):
        ax.text(x, v + 0.6, f"{v:.2f}%", ha="center", fontsize=9)
    ax.set_xticks(xs)
    ax.set_xticklabels([CONDITION_LABEL[c] if have_ko else c for c in used], fontsize=9)
    ax.set_ylabel(L("성공률 (%)", "success rate (%)"))
    ax.set_title(L("평가 구간 조건별 성공률 (선 = 참가자별)",
                   "Success rate by condition (lines = participants)"), fontsize=10)
    fig.tight_layout()
    path = os.path.join(outdir, "success_by_condition.png")
    fig.savefig(path, dpi=140)
    plt.close(fig)
    made.append(path)

    # (3) 개인별 편향 벡터
    # annotate 화살표는 축 범위 자동조정에 포함되지 않는다(빈 캔버스가 나온다).
    # 선 + 점으로 그려 autoscale이 걸리게 하고, 범위는 직접 못박는다.
    fig, ax = plt.subplots(figsize=(5.4, 5))
    for p in participants:
        ax.plot([0, p.vector[0]], [0, p.vector[1]], color="#2563eb", lw=1.4, zorder=2)
        ax.plot([p.vector[0]], [p.vector[1]], "o", ms=4, color="#2563eb", zorder=3)
        ax.text(p.vector[0], p.vector[1], " " + p.pid, fontsize=8, va="center", zorder=4)
    gm = (float(np.mean([p.vector[0] for p in participants])),
          float(np.mean([p.vector[1] for p in participants])))
    ax.plot([0, gm[0]], [0, gm[1]], color="#dc2626", lw=3, zorder=5)
    ax.plot([gm[0]], [gm[1]], "o", ms=6, color="#dc2626", zorder=6)
    ax.text(gm[0], gm[1], L("  집단 평균", "  group mean"), fontsize=9, color="#dc2626",
            va="center", zorder=6)

    span = max(0.5, max(max(abs(p.vector[0]), abs(p.vector[1])) for p in participants)) * 1.45
    ax.set_xlim(-span, span)
    ax.set_ylim(span, -span)          # 화면 좌표계: y는 아래로 증가
    ax.axhline(0, color="#9ca3af", lw=0.8, zorder=1)
    ax.axvline(0, color="#9ca3af", lw=0.8, zorder=1)
    ax.set_xlabel("vector x (px)")
    ax.set_ylabel("vector y (px)")
    ax.set_aspect("equal")
    ax.set_title(L("개인별 편향 벡터 (빨강 = 공통 몫, 흩어짐 = 개인차 몫)",
                   "Per-participant bias vectors (red = common part)"), fontsize=10)
    fig.tight_layout()
    path = os.path.join(outdir, "bias_vectors.png")
    fig.savefig(path, dpi=140)
    plt.close(fig)
    made.append(path)

    return made


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description="마우스 보정 실험 v3 — §6 분석")
    ap.add_argument("inputs", nargs="+", help="모드 B(main) JSON 파일 또는 폴더")
    ap.add_argument("--out", help="분석 결과 JSON 저장 경로")
    ap.add_argument("--figures", help="그림 저장 폴더")
    ap.add_argument("--alpha", type=float, default=0.05)
    args = ap.parse_args(argv)

    files = expand_inputs(args.inputs)
    if not files:
        print("입력 파일이 없습니다.", file=sys.stderr)
        return 2

    warnings = []
    participants = []
    for f in files:
        try:
            p = load_participant(f, warnings)
        except (KeyError, ValueError, TypeError) as exc:
            warnings.append(f"{os.path.basename(f)}: 읽기 실패 ({type(exc).__name__}: {exc})")
            continue
        if p is None:
            continue
        if not p.train or not p.test:
            warnings.append(f"{p.pid}: 학습 {len(p.train)}회 / 평가 {len(p.test)}회 — 제외")
            continue
        participants.append(p)

    if not participants:
        print("분석할 참가자 데이터가 없습니다 (mode=='main' 인 파일이 필요합니다).", file=sys.stderr)
        for w in warnings:
            print("  ! " + w, file=sys.stderr)
        return 2

    ids = [p.pid for p in participants]
    if len(set(ids)) != len(ids):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        warnings.append(f"참가자 ID 중복: {', '.join(dupes)} — 같은 사람의 세션이 여러 개인지 확인하세요")
    if len(participants) < 8:
        warnings.append(f"참가자 {len(participants)}명 — 계획서는 8명을 전제합니다")

    res = analyze(participants, alpha=args.alpha)
    res["input_files"] = files
    res["warnings"] = warnings
    print_report(res, warnings, files)

    if args.figures:
        made = make_figures(participants, res, args.figures)
        if made:
            print("\n그림: " + ", ".join(made))

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
        print(f"결과 JSON: {args.out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
