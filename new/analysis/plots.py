"""시각화 (명세서 5.4절 6번).

  1. 간격별 조건 비교 그래프 — 7.1절의 핵심 결과
  2. 오차 산점도 (진행 방향 기준 e∥/e⊥) — 2.3절 부호 규약 육안 검증용
  3. 개인별 편향 벡터 — 방향별 평균 오차
  4. 멈칫 위치 분포 — 궤적 구조

명세서 2.3절이 요구한 "분석 전 시각화로 부호 방향을 한 번 검증할 것"을
2번 그림이 담당한다. e⊥ 부호가 화면상 어느 쪽인지 반드시 눈으로 확인할 것.

사용법:
    python plots.py --phase1 <phase1.json> [--phase3-result <result.json>] --outdir <dir>
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feature_extraction import build_dataset  # noqa: E402

# 한글 라벨을 쓰므로 윈도우 기본 한글 폰트를 지정한다
for font in ("Malgun Gothic", "AppleGothic", "NanumGothic", "DejaVu Sans"):
    try:
        matplotlib.rcParams["font.family"] = font
        break
    except Exception:
        continue
matplotlib.rcParams["axes.unicode_minus"] = False

CONDITION_ORDER = ["A. 보정 없음", "B. AI 보정", "C. 스냅", "D. 결합"]
CONDITION_COLORS = {"A. 보정 없음": "#6b7280", "B. AI 보정": "#2563eb",
                    "C. 스냅": "#dc2626", "D. 결합": "#16a34a"}


def plot_gap_comparison(result: dict, outdir: Path) -> Path:
    """간격별 성공률·오선택률 — 명세서 7.1절 그래프."""
    per_gap = result["per_gap"]
    labels = list(per_gap.keys())
    x = np.arange(len(labels))

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for ax, key, title in [(axes[0], "success_rate", "성공률"),
                           (axes[1], "misdirect_rate", "오선택률")]:
        for cond in CONDITION_ORDER:
            if cond not in per_gap[labels[0]]:
                continue
            y = [per_gap[l][cond][key] * 100 for l in labels]
            ax.plot(x, y, marker="o", label=cond, color=CONDITION_COLORS[cond], linewidth=2)
        ax.set_xticks(x)
        ax.set_xticklabels(labels)
        ax.set_xlabel("버튼 간격")
        ax.set_ylabel(f"{title} (%)")
        ax.set_title(f"간격에 따른 {title}")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=9)
    fig.suptitle(f"참가자 {result['participant_id']} — 3단계 조건 비교 "
                 f"(n={result['n_trials']})")
    fig.tight_layout()
    path = outdir / "gap_comparison.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_error_scatter(rows: list[dict], outdir: Path, participant: str) -> Path:
    """e∥/e⊥ 산점도 + 화면좌표 Δx/Δy 산점도. 부호 규약 육안 검증."""
    e_par = np.array([r["labels"]["e_parallel"] for r in rows])
    e_perp = np.array([r["labels"]["e_perp"] for r in rows])
    dx = np.array([r["labels"]["dx"] for r in rows])
    dy = np.array([r["labels"]["dy"] for r in rows])

    fig, axes = plt.subplots(1, 2, figsize=(12, 5.5))

    ax = axes[0]
    ax.scatter(e_par, e_perp, s=14, alpha=0.5, color="#2563eb")
    ax.axhline(0, color="#9ca3af", lw=1)
    ax.axvline(0, color="#9ca3af", lw=1)
    ax.scatter([e_par.mean()], [e_perp.mean()], s=140, marker="X",
               color="#dc2626", zorder=5,
               label=f"평균 ({e_par.mean():+.2f}, {e_perp.mean():+.2f})")
    ax.set_xlabel("e∥  (양수 = 진행 방향으로 오버슛)")
    ax.set_ylabel("e⊥  (양수 = 진행 방향 기준 화면상 아래쪽)")
    ax.set_title("진행 방향 기준 오차 (명세서 2.3절)")
    ax.legend(fontsize=9)
    ax.grid(alpha=0.3)
    ax.set_aspect("equal", adjustable="datalim")

    ax = axes[1]
    ax.scatter(dx, dy, s=14, alpha=0.5, color="#16a34a")
    ax.axhline(0, color="#9ca3af", lw=1)
    ax.axvline(0, color="#9ca3af", lw=1)
    ax.scatter([dx.mean()], [dy.mean()], s=140, marker="X",
               color="#dc2626", zorder=5,
               label=f"평균 ({dx.mean():+.2f}, {dy.mean():+.2f})")
    ax.invert_yaxis()   # 화면 좌표계: y 아래로 증가
    ax.set_xlabel("Δx  (양수 = 화면 오른쪽)")
    ax.set_ylabel("Δy  (양수 = 화면 아래, 축 반전됨)")
    ax.set_title("화면 좌표 오차 (회전 없음)")
    ax.legend(fontsize=9)
    ax.grid(alpha=0.3)
    ax.set_aspect("equal", adjustable="datalim")

    fig.suptitle(f"참가자 {participant} — 오차 분포 (n={len(rows)})\n"
                 f"※ e⊥ 부호가 화면상 어느 쪽인지 이 그림으로 확인할 것 (2.3절)",
                 fontsize=11)
    fig.tight_layout()
    path = outdir / "error_scatter.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_bias_vectors(rows: list[dict], outdir: Path, participant: str) -> Path:
    """방향별 평균 오차 벡터 — 개인 편향의 방향 의존성."""
    by_dir: dict[int, list[tuple[float, float]]] = {}
    for r in rows:
        theta = r["meta"]["theta"]
        bucket = int(round(math.degrees(theta) / 45) * 45) % 360
        by_dir.setdefault(bucket, []).append((r["labels"]["dx"], r["labels"]["dy"]))

    fig, ax = plt.subplots(figsize=(6.5, 6.5))
    scale = 12.0
    for bucket in sorted(by_dir):
        vals = np.array(by_dir[bucket], float)
        mx, my = vals.mean(axis=0)
        rad = math.radians(bucket)
        ox, oy = math.cos(rad) * scale, math.sin(rad) * scale
        ax.arrow(ox, oy, mx, my, head_width=0.6, head_length=0.8,
                 color="#2563eb", length_includes_head=True)
        ax.plot([ox], [oy], "o", color="#9ca3af", ms=5)
        ax.annotate(f"{bucket}°\n(n={len(vals)})", (ox, oy),
                    textcoords="offset points", xytext=(6, 6), fontsize=8)

    ax.axhline(0, color="#e5e7eb", lw=1)
    ax.axvline(0, color="#e5e7eb", lw=1)
    ax.invert_yaxis()
    ax.set_aspect("equal")
    ax.set_title(f"참가자 {participant} — 이동 방향별 평균 오차 벡터\n"
                 f"(회색 점 = 그 방향, 화살표 = 평균 클릭 오차, 화면 좌표)", fontsize=10)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    path = outdir / "bias_vectors.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def plot_pause_structure(rows: list[dict], outdir: Path, participant: str) -> Path:
    """멈칫 위치·시간 분포 — 궤적 구조."""
    progress, to_click, depth = [], [], []
    n_pauses = []
    for r in rows:
        n_pauses.append(r["shape"]["n_pauses"])
        for p in r["shape"]["pauses"]:
            progress.append(p["progress"])
            to_click.append(p["time_to_click"])
            depth.append(p["depth"])

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.2))

    axes[0].hist(n_pauses, bins=np.arange(-0.5, max(n_pauses) + 1.5, 1),
                 color="#2563eb", alpha=0.8, edgecolor="white")
    axes[0].set_xlabel("시행당 멈칫 횟수")
    axes[0].set_ylabel("시행 수")
    axes[0].set_title("멈칫 횟수 분포")
    axes[0].grid(alpha=0.3, axis="y")

    if progress:
        axes[1].hist(progress, bins=40, range=(0, 1.4), color="#16a34a",
                     alpha=0.8, edgecolor="white")
        axes[1].axvline(1.0, color="#dc2626", lw=2, ls="--", label="클릭점")
        axes[1].set_xlabel("진행률 (0 = 시작점, 1 = 클릭점)")
        axes[1].set_ylabel("멈칫 수")
        axes[1].set_title(f"멈칫 위치 (n={len(progress)})")
        axes[1].legend(fontsize=9)
        axes[1].grid(alpha=0.3, axis="y")

        axes[2].scatter(progress, to_click, s=14, alpha=0.45, c=depth,
                        cmap="viridis")
        axes[2].axvline(1.0, color="#dc2626", lw=1.5, ls="--")
        axes[2].set_xlabel("진행률")
        axes[2].set_ylabel("클릭까지 남은 시간 (ms)")
        axes[2].set_title("멈칫 위치 × 시간 (색 = 깊이, 어두울수록 완전정지)")
        axes[2].grid(alpha=0.3)

    fig.suptitle(f"참가자 {participant} — 궤적의 멈칫 구조", fontsize=11)
    fig.tight_layout()
    path = outdir / "pause_structure.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase1", type=Path, default=None, help="1단계 내보내기 JSON")
    ap.add_argument("--phase3-result", type=Path, default=None,
                    help="evaluate_phase3.py --out 으로 저장한 결과 JSON")
    ap.add_argument("--outdir", type=Path, required=True)
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args.outdir.mkdir(parents=True, exist_ok=True)

    made = []
    if args.phase1:
        data = json.loads(args.phase1.read_text(encoding="utf-8"))
        ds = build_dataset(data["trials"], warmup_to_exclude=20,
                           include_pause_features=True)
        pid = data["participant_id"]
        made.append(plot_error_scatter(ds["rows"], args.outdir, pid))
        made.append(plot_bias_vectors(ds["rows"], args.outdir, pid))
        made.append(plot_pause_structure(ds["rows"], args.outdir, pid))

    if args.phase3_result:
        result = json.loads(args.phase3_result.read_text(encoding="utf-8"))
        made.append(plot_gap_comparison(result, args.outdir))

    if not made:
        raise SystemExit("--phase1 또는 --phase3-result 중 하나는 필요합니다")
    for p in made:
        print(f"저장됨: {p}")


if __name__ == "__main__":
    main()
