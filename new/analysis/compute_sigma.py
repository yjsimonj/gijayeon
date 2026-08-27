"""1단계(단일 버튼 400회) 로그로부터 참가자 σ와 3단계 간격(gap) config를 산출한다.

웹앱의 "1단계 완료 화면 → σ/gap config 즉시 계산" 기능과 정확히 동일한 필터·공식을
Python으로 재구현한 것으로, 웹앱이 그 자리에서 내려준 gap config가 맞게 계산됐는지
오프라인으로 재현·대조하는 용도다 (README 참고).

필터: trial_index 기준 앞 20회(워밍업) 제외, timeout==true 시행 제외.
공식: 남은 시행의 (클릭 - 버튼중심) 유클리드 거리(px, 정규화 안 함)의 표본표준편차 = sigma_px.

사용법:
    python compute_sigma.py <phase1_export.json> [--out OUT.json]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from error_decomposition import error_distance  # noqa: E402

WARMUP_TRIALS = 20


def load_phase1_export(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    phase = data.get("phase")
    if phase != 1:
        raise ValueError(f"phase==1 로그가 아닙니다 (phase={phase!r}): {path}")

    trials = data.get("trials")
    if not trials:
        raise ValueError(f"trials 배열이 비어 있습니다: {path}")

    return data


def compute_sigma(data: dict) -> dict:
    trials = sorted(data["trials"], key=lambda t: t["trial_index"])
    n_total = len(trials)

    after_warmup = trials[WARMUP_TRIALS:]
    n_excluded_warmup = n_total - len(after_warmup)

    used = [t for t in after_warmup if not t.get("timeout")]
    n_excluded_timeout = len(after_warmup) - len(used)

    distances = []
    for t in used:
        click = t.get("click")
        if click is None:
            # timeout==false인데 click이 없는 것은 스키마 위반 — 조용히 넘기지 않고 알린다.
            raise ValueError(f"trial_index={t['trial_index']}: timeout=false인데 click이 없습니다")
        center = (t["button"]["center_x"], t["button"]["center_y"])
        distances.append(error_distance((click["x"], click["y"]), center))

    if len(distances) < 2:
        raise ValueError(
            f"표준편차를 계산하기엔 유효 시행이 너무 적습니다 (n_used={len(distances)})"
        )

    sigma_px = statistics.stdev(distances)  # 표본표준편차 (ddof=1)

    return {
        "participant_id": data.get("participant_id"),
        "sigma_source_phase": 1,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "n_trials_total": n_total,
        "n_excluded_warmup": n_excluded_warmup,
        "n_excluded_timeout": n_excluded_timeout,
        "n_used": len(distances),
        "sigma_px": sigma_px,
        "gaps_px": {"0": 0, "1sigma": sigma_px, "3sigma": 3 * sigma_px},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export_path", type=Path, help="1단계 내보내기 JSON 경로")
    parser.add_argument("--out", type=Path, default=None, help="출력 경로 (기본: stdout)")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    data = load_phase1_export(args.export_path)
    result = compute_sigma(data)

    output_text = json.dumps(result, ensure_ascii=False, indent=2)

    if args.out is None:
        print(output_text)
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(output_text, encoding="utf-8")
        print(f"작성됨: {args.out}")
        print(f"sigma_px = {result['sigma_px']:.3f}  (n_used={result['n_used']}/{result['n_trials_total']})")


if __name__ == "__main__":
    main()
