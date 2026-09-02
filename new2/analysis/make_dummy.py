#!/usr/bin/env python
"""
더미 데이터 생성기 — 계획서 §8-3

  "스키마 확정 → 더미 데이터로 §6 분석 스크립트를 먼저 돌려본다.
   분석이 안 돌아가는 스키마를 실험 다 하고 발견하는 게 최악이다."

실험 앱이 내보내는 것과 같은 모양(schema_version 3.0)의 JSON을 만든다.
분석 파이프라인 점검용이며, 여기서 나온 파일은 절대 결과로 보고하지 않는다
(dev_mode 대신 dummy: true 로 표시해 둔다).

클릭 모형
  click = target + (공통 편향 + 개인 편향) + 등방 정규잡음
  성공  = |click − target| ≤ 버튼 반지름

  --individual-sd 0 으로 주면 개인 편향이 사라진다 → 분석이 §6.4의
  "C > A 인데 C ≈ B" 갈래를 제대로 골라내는지 확인할 수 있다.

사용법
  python make_dummy.py --out ../data_dummy                     # 8명, 개인차 있음
  python make_dummy.py --out ../data_dummy_nopersonal --individual-sd 0
  python make_dummy.py --out ../data_dummy --mode sizing --participants 3
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import random

SCHEMA_VERSION = "3.0"
DISTANCE_PX = 450
DIRECTIONS_DEG = [0, 90, 180, 270]
TIME_LIMIT_MS = 750
RESPONSE_CAP_MS = 3000
START_BUTTON_SIZE_PX = 30
CANDIDATE_SIZES_PX = [8, 12, 16, 24, 32]
TOP_CLEARANCE_PX = 14
EDGE_PADDING_PX = 8


def r1(v):
    return round(v, 1)


def layout(size_px, deg, vw, vh):
    """experiment.js 의 computeLayout 과 같은 규칙 (시작 버튼을 최소량만 민다)."""
    rad = math.radians(deg)
    vx = math.cos(rad) * DISTANCE_PX
    vy = -math.sin(rad) * DISTANCE_PX          # 90° = 위
    sr = START_BUTTON_SIZE_PX / 2
    tr = size_px / 2

    x_min = max(sr, tr - vx) + EDGE_PADDING_PX
    x_max = vw - max(sr, tr + vx) - EDGE_PADDING_PX
    y_min = TOP_CLEARANCE_PX + max(sr, tr - vy)
    y_max = vh - max(sr, tr + vy) - EDGE_PADDING_PX

    want_x = vw / 2
    want_y = (TOP_CLEARANCE_PX + vh) / 2
    sx = min(max(want_x, x_min), x_max)
    sy = min(max(want_y, y_min), y_max)
    return sx, sy, sx + vx, sy + vy, abs(sx - want_x) > 0.5 or abs(sy - want_y) > 0.5


def balanced(values, total, rng):
    base, rest = divmod(total, len(values))
    idx = list(range(len(values)))
    rng.shuffle(idx)
    bonus = set(idx[:rest])
    out = []
    for i, v in enumerate(values):
        out += [v] * (base + (1 if i in bonus else 0))
    rng.shuffle(out)
    return out


def fake_trajectory(sx, sy, cx, cy, rt_ms, n_samples, rng):
    """궤적은 이번 분석에 쓰지 않지만(§4.3) 기록은 남긴다. 모양만 그럴듯하게."""
    pts = []
    for i in range(n_samples):
        f = i / max(1, n_samples - 1)
        ease = 1 - (1 - f) ** 3                       # 감속하며 접근
        jitter = 0 if f in (0.0, 1.0) else rng.gauss(0, 2.0)
        pts.append([
            int(round(rt_ms * f)),
            r1(sx + (cx - sx) * ease + jitter),
            r1(sy + (cy - sy) * ease + jitter),
        ])
    return pts


def make_trial(index, main_index, warmup, block, size_px, deg, bias, sigma, rng,
               vw, vh, n_samples, no_response_rate, t0_epoch):
    sx, sy, tx, ty = layout(size_px, deg, vw, vh)[:4]
    tx, ty = r1(tx), r1(ty)

    rt = max(180, int(rng.gauss(620, 130)))
    no_response = rng.random() < no_response_rate

    if no_response:
        click = None
        rt_ms = None
        t_click = None
        traj = fake_trajectory(sx, sy, tx, ty, RESPONSE_CAP_MS, n_samples, rng)
    else:
        cx = tx + bias[0] + rng.gauss(0, sigma)
        cy = ty + bias[1] + rng.gauss(0, sigma)
        click = {"x": r1(cx), "y": r1(cy)}
        rt_ms = rt
        t_click = t0_epoch + rt
        traj = fake_trajectory(sx, sy, click["x"], click["y"], rt, n_samples, rng)

    gaps = [traj[i][0] - traj[i - 1][0] for i in range(1, len(traj))]
    gaps.sort()
    med = gaps[len(gaps) // 2] if gaps else None

    hit = (click is not None
           and math.hypot(click["x"] - tx, click["y"] - ty) <= size_px / 2)

    return {
        "index": index,
        "main_index": main_index,
        "warmup": warmup,
        "block": block,
        "direction_deg": deg,
        "button_size_px": size_px,
        "target": {"x": tx, "y": ty},
        "start": {"x": r1(sx), "y": r1(sy)},
        "start_shifted": layout(size_px, deg, vw, vh)[4],
        "t_start_click": t0_epoch - 300,
        "t_target_shown": t0_epoch,
        "t_click": t_click,
        "click": click,
        "rt_ms": rt_ms,
        "timeout": (rt_ms is not None and rt_ms > TIME_LIMIT_MS),
        "no_response": no_response,
        "success": hit,
        "error_x": r1(click["x"] - tx) if click else None,
        "error_y": r1(click["y"] - ty) if click else None,
        "trajectory": traj,
        "sample_interval_median_ms": med,
        "trajectory_span_ms": traj[-1][0] - traj[0][0] if traj else 0,
        "n_trajectory_samples": len(traj),
        "drag_rejected": 0,
    }


def build_main(pid, bias, args, rng):
    vw, vh = args.viewport
    trials = []
    epoch = int(datetime.datetime.now().timestamp() * 1000)
    idx = 0

    for deg in balanced(DIRECTIONS_DEG, args.warmup, rng):
        trials.append(make_trial(idx, None, True, None, args.button_size, deg, bias,
                                 args.sigma, rng, vw, vh, args.trajectory_samples,
                                 args.no_response_rate, epoch + idx * 1200))
        idx += 1

    block_size = args.rest_every if args.main % args.rest_every == 0 else args.main
    n_blocks = args.main // block_size
    main_index = 0
    for b in range(n_blocks):
        for deg in balanced(DIRECTIONS_DEG, block_size, rng):
            trials.append(make_trial(idx, main_index, False, b, args.button_size, deg, bias,
                                     args.sigma, rng, vw, vh, args.trajectory_samples,
                                     args.no_response_rate, epoch + idx * 1200))
            idx += 1
            main_index += 1

    return envelope(pid, "main", trials, args, extra_config={
        "button_size_px": args.button_size,
        "candidate_sizes_px": None,
        "warmup_trials": args.warmup,
        "main_trials": args.main,
        "train_split": args.train_split,
    })


def build_sizing(pid, bias, args, rng):
    vw, vh = args.viewport
    trials = []
    epoch = int(datetime.datetime.now().timestamp() * 1000)
    idx = 0

    warm_sizes = balanced(CANDIDATE_SIZES_PX, args.sizing_warmup, rng)
    warm_dirs = balanced(DIRECTIONS_DEG, args.sizing_warmup, rng)
    for size, deg in zip(warm_sizes, warm_dirs):
        trials.append(make_trial(idx, None, True, None, size, deg, bias, args.sigma, rng,
                                 vw, vh, args.trajectory_samples, args.no_response_rate,
                                 epoch + idx * 1200))
        idx += 1

    total = len(CANDIDATE_SIZES_PX) * args.sizing_per_size
    sizes = balanced(CANDIDATE_SIZES_PX, total, rng)
    dirs = balanced(DIRECTIONS_DEG, total, rng)
    for i in range(total):
        trials.append(make_trial(idx, i, False, 0, sizes[i], dirs[i], bias, args.sigma, rng,
                                 vw, vh, args.trajectory_samples, args.no_response_rate,
                                 epoch + idx * 1200))
        idx += 1

    return envelope(pid, "sizing", trials, args, extra_config={
        "button_size_px": None,
        "candidate_sizes_px": CANDIDATE_SIZES_PX,
        "warmup_trials": args.sizing_warmup,
        "main_trials": total,
        "train_split": None,
        "sizing_target_success_rate": 0.65,
    })


def envelope(pid, mode, trials, args, extra_config):
    vw, vh = args.viewport
    now = datetime.datetime.now().isoformat()
    config = {
        "distance_px": DISTANCE_PX,
        "directions_deg": DIRECTIONS_DEG,
        "time_limit_ms": TIME_LIMIT_MS,
        "response_cap_ms": RESPONSE_CAP_MS,
        "inter_trial_blank_ms": 200,
        "start_button_size_px": START_BUTTON_SIZE_PX,
        "rest_every_n_trials": args.rest_every,
        "direction_convention": "0=right, 90=up, 180=left, 270=down (dy = -sin θ)",
        "error_sign_convention": "error = click - target; 보정좌표 = 클릭좌표 - 편향벡터",
    }
    config.update(extra_config)
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": mode,
        "participant_id": pid,
        "dev_mode": False,
        "dummy": True,               # 실제 데이터와 절대 섞이지 않게
        "started_at": now,
        "finished_at": now,
        "aborted": False,
        "environment": {
            "inner_width": vw, "inner_height": vh,
            "screen_width": vw, "screen_height": vh,
            "device_pixel_ratio": 1.0,
            "input_device": "mouse",
            "zoom_estimate": 1.0,
            "fullscreen": True,
            "user_agent": "make_dummy.py",
            "platform": "dummy",
        },
        "config": config,
        "session_events": [{"at": now, "type": "session_start", "detail": {"dummy": True}}],
        "trials": trials,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="더미 데이터 생성 (§8-3 분석 사전 점검용)")
    ap.add_argument("--out", required=True, help="저장 폴더")
    ap.add_argument("--mode", choices=["main", "sizing"], default="main")
    ap.add_argument("--participants", type=int, default=8)
    ap.add_argument("--button-size", type=float, default=12)
    ap.add_argument("--sigma", type=float, default=4.0, help="축별 클릭 잡음 SD(px)")
    ap.add_argument("--common-bias", type=float, nargs=2, default=[0.4, -1.3],
                    help="전원 공통 편향 (x y). test01의 Δy=-1.28px 관측을 반영한 기본값")
    ap.add_argument("--individual-sd", type=float, default=1.6,
                    help="개인 편향의 축별 SD(px). 0이면 개인차 없음 → C ≈ B 갈래 점검")
    ap.add_argument("--warmup", type=int, default=20)
    ap.add_argument("--main", type=int, default=600)
    ap.add_argument("--train-split", type=int, default=400)
    ap.add_argument("--rest-every", type=int, default=100)
    ap.add_argument("--sizing-warmup", type=int, default=10)
    ap.add_argument("--sizing-per-size", type=int, default=20)
    ap.add_argument("--trajectory-samples", type=int, default=8,
                    help="더미 궤적 샘플 수. 실제는 약 75개지만 분석에 쓰지 않으므로 짧게 만든다")
    ap.add_argument("--no-response-rate", type=float, default=0.002)
    ap.add_argument("--viewport", type=int, nargs=2, default=[1440, 900])
    ap.add_argument("--seed", type=int, default=20260902)
    args = ap.parse_args(argv)

    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)

    made = []
    for i in range(args.participants):
        pid = f"D{i + 1:02d}"
        bias = (args.common_bias[0] + rng.gauss(0, args.individual_sd),
                args.common_bias[1] + rng.gauss(0, args.individual_sd))
        data = build_main(pid, bias, args, rng) if args.mode == "main" else build_sizing(pid, bias, args, rng)
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S") + f"_{i:02d}"
        path = os.path.join(args.out, f"{args.mode}_{pid}_{stamp}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        size_mb = os.path.getsize(path) / (1024 * 1024)
        made.append(path)
        print(f"{pid}: bias=({bias[0]:+.2f}, {bias[1]:+.2f}) px  "
              f"trials={len(data['trials'])}  {size_mb:.2f} MB  → {os.path.basename(path)}")

    print(f"\n{len(made)}개 파일 생성: {os.path.abspath(args.out)}")
    if args.mode == "main":
        print("다음: python analyze.py " + args.out)
    else:
        print("다음: 실험 앱의 '모드 A 결과 집계' 화면에서 이 파일들을 전부 선택")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
