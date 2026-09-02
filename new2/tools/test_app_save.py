#!/usr/bin/env python
"""
app.py 의 save() 점검 — gradio 설치 없이 돌아간다.

가짜 gradio 모듈을 끼워 넣고 app 을 import 한 뒤 save() 만 시험한다.

  python tools/test_app_save.py

확인하는 것
  - CSS·JS(head)를 Gradio 버전에 맞는 곳에 넘기는가 (틀리면 조용히 무시되어
    실험 화면이 아예 뜨지 않는다)
  - 결과가 data/ 에 제대로 저장되는가, 두 번 돌려도 덮어쓰지 않는가
  - 빈 문자열·깨진 JSON·과대 payload·위험한 참가자 ID를 어떻게 다루는가
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import sys
import tempfile
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

failures = 0
checks = 0


def ok(cond, label, extra=""):
    global failures, checks
    checks += 1
    print(f"  {'OK ' if cond else '!! '} {label}" + ("" if cond or not extra else f"  → {extra}"))
    if not cond:
        failures += 1


# ---------------------------------------------------------------- 가짜 gradio


class _Fake:
    """gr.Textbox(...) 등 무엇이 와도 받아 넘기는 자리표시자."""

    def __init__(self, *a, **k):
        self.calls = []

    def click(self, fn, inputs=None, outputs=None):
        self.calls.append((fn, inputs, outputs))


class _Blocks(_Fake):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


fake_gradio = types.ModuleType("gradio")
fake_gradio.__version__ = "6.26.0"
fake_gradio.Blocks = _Blocks
fake_gradio.HTML = _Fake
fake_gradio.Textbox = _Fake
fake_gradio.Button = _Fake
fake_gradio.Markdown = _Fake
sys.modules["gradio"] = fake_gradio
sys.path.insert(0, ROOT)

DATA_DIR = tempfile.mkdtemp(prefix="mouse_exp_test_")


def load_app():
    os.environ["MOUSE_EXP_DATA_DIR"] = DATA_DIR
    sys.modules.pop("app", None)
    import app  # noqa: E402  (환경변수를 세운 뒤 import 해야 DATA_DIR이 잡힌다)
    return app


def payload(pid="P03", n_main=3, n_warmup=2):
    trials = [{"index": i, "warmup": True} for i in range(n_warmup)]
    trials += [{"index": n_warmup + i, "warmup": False, "main_index": i} for i in range(n_main)]
    return json.dumps({
        "schema_version": "3.0", "mode": "main", "participant_id": pid,
        "participant": {"student_id": "20231234", "name": "홍길동"},
        "trials": trials,
    })


def saved_files():
    return sorted(os.path.basename(p) for p in glob.glob(os.path.join(DATA_DIR, "*.json")))


try:
    print("\n[0] head(CSS·JS) 주입 위치 — Gradio 버전별")
    # Gradio 6은 head 를 Blocks 가 아니라 launch 에서 받는다. 잘못된 쪽에 주면 경고만
    # 뜨고 조용히 무시되어 실험 화면이 뜨지 않는다.
    for version, expect_launch in (("6.26.0", True), ("5.9.1", False), ("4.44.0", False)):
        fake_gradio.__version__ = version
        app = load_app()
        in_launch = "mouseExperiment" in app._LAUNCH_KWARGS.get("head", "")
        in_blocks = "mouseExperiment" in app._BLOCKS_KWARGS.get("head", "")
        ok(in_launch == expect_launch and in_blocks != expect_launch,
           f"gradio {version}: head → {'launch()' if expect_launch else 'Blocks()'}",
           f"launch={in_launch}, blocks={in_blocks}")
    fake_gradio.__version__ = "6.26.0"
    app = load_app()
    ok("#payload, #trigger" in app.HEAD, "통로 컴포넌트 숨김 CSS 포함")
    ok("mx-screen-setup" in app.HTML, "실험 화면 마크업 포함")

    print("\n[1] 정상 저장")
    msg = app.save(payload())
    files = saved_files()
    ok(len(files) == 1, "data/ 에 파일 1개 생성", str(files))
    ok(files and files[0].startswith("main_P03_"), "파일명 main_<ID>_<시각>.json", str(files))
    ok("저장 완료" in msg and "3회" in msg, "성공 문구에 본시행 수 표시", msg.replace("\n", " "))
    with open(os.path.join(DATA_DIR, files[0]), encoding="utf-8") as f:
        back = json.load(f)
    ok(back["participant_id"] == "P03" and back["participant"]["name"] == "홍길동",
       "저장된 내용이 그대로 읽힌다")

    print("\n[2] 같은 참가자를 두 번 → 덮어쓰지 않는가")
    time.sleep(1.05)   # 파일명이 초 단위 시각을 쓴다
    app.save(payload())
    ok(len(saved_files()) == 2, "파일이 2개로 늘어남", str(saved_files()))

    print("\n[3] 위험한 참가자 ID")
    app.save(payload(pid="../../etc/passwd"))
    bad = [f for f in saved_files() if ".." in f or "/" in f or "\\" in f]
    ok(not bad, "경로 문자(.. / \\)가 제거됨", str(bad))
    ok(any(f.startswith("main_etcpasswd_") for f in saved_files()),
       "영문·숫자만 남겨 저장", str(saved_files()))
    app.save(payload(pid="참가자"))
    ok(any(f.startswith("main_unknown_") for f in saved_files()),
       "ASCII가 하나도 없으면 unknown", str(saved_files()))

    print("\n[4] 빈 payload — value setter 누락 상황 (§3.3)")
    msg = app.save("")
    ok("⚠" in msg and "submitResults" in msg, "원인을 짚어 주는 경고", msg)

    print("\n[5] 깨진 JSON")
    msg = app.save("{not json")
    ok("파싱 실패" in msg and "직접 받기" in msg, "파싱 실패 + 예비 다운로드 안내", msg)

    print("\n[6] 과대 payload")
    big = json.dumps({"participant_id": "P01", "mode": "main", "trials": [],
                      "pad": "x" * (33 * 1024 * 1024)})
    msg = app.save(big)
    ok("너무 큽니다" in msg, "용량 상한에서 거절", msg[:60])

    print("\n[7] 저장 폴더를 쓸 수 없을 때")
    app_bad = app
    app_bad.DATA_DIR = os.path.join(DATA_DIR, "file_not_dir")
    with open(app_bad.DATA_DIR, "w", encoding="utf-8") as f:
        f.write("이 경로는 폴더가 아니다")
    msg = app_bad.save(payload())
    ok("저장 실패" in msg and "직접 받기" in msg,
       "예외를 던지지 않고 예비 다운로드로 안내", msg.replace("\n", " ")[:120])
finally:
    shutil.rmtree(DATA_DIR, ignore_errors=True)

print("\n" + "=" * 60)
print(f"통과: {checks}개 검사 전부 OK" if failures == 0 else f"실패: {failures} / {checks}")
print("=" * 60)
sys.exit(1 if failures else 0)
