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
  - HF Dataset 업로드: 토큰이 있을 때/없을 때/실패할 때, 그리고 Space 위에서
    토큰 없이 도는 상황(재시작하면 데이터가 사라진다)을 화면에 어떻게 알리는가

huggingface_hub 도 가짜로 끼워 넣으므로 이 시험은 네트워크를 전혀 건드리지 않는다.
"""

from __future__ import annotations

import glob
import io
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


class _FakeHfApi:
    """업로드 인자를 기록만 하는 가짜 HfApi. fail_with 를 세우면 그 예외를 던진다."""

    uploads = []
    fail_with = None

    def upload_file(self, *, path_or_fileobj, path_in_repo, repo_id, repo_type, token):
        if _FakeHfApi.fail_with is not None:
            raise _FakeHfApi.fail_with
        _FakeHfApi.uploads.append({
            "bytes": path_or_fileobj,
            "path_in_repo": path_in_repo,
            "repo_id": repo_id,
            "repo_type": repo_type,
            "token": token,
        })


fake_hub = types.ModuleType("huggingface_hub")
fake_hub.HfApi = _FakeHfApi
sys.modules["huggingface_hub"] = fake_hub

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


ENV_KEYS = ("HF_TOKEN", "HF_DATASET_REPO", "SPACE_ID")


def load_app(**env):
    """app 을 새로 import 한다. app.py 는 환경변수를 모듈 최상단에서 읽으므로,
    토큰 있음/없음을 시험하려면 매번 다시 import 해야 한다."""
    os.environ["MOUSE_EXP_DATA_DIR"] = DATA_DIR
    for k in ENV_KEYS:
        os.environ.pop(k, None)
    os.environ.update(env)
    _FakeHfApi.uploads = []
    _FakeHfApi.fail_with = None
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

    print("\n[7] Dataset 업로드 — 토큰이 있을 때")
    app = load_app(HF_TOKEN="hf_fake_token", HF_DATASET_REPO="acct/exp-data")
    before = len(saved_files())
    msg = app.save(payload(pid="P07", n_main=4))
    ok(len(_FakeHfApi.uploads) == 1, "업로드가 1회 호출됨", str(len(_FakeHfApi.uploads)))
    up = _FakeHfApi.uploads[0] if _FakeHfApi.uploads else {}
    ok(up.get("repo_id") == "acct/exp-data" and up.get("repo_type") == "dataset",
       "HF_DATASET_REPO 를 dataset repo 로 지정", f"{up.get('repo_id')} / {up.get('repo_type')}")
    ok(str(up.get("path_in_repo", "")).startswith("raw/main_P07_"),
       "repo 안 경로가 raw/main_<ID>_<시각>.json", str(up.get("path_in_repo")))
    ok(up.get("token") == "hf_fake_token", "토큰이 그대로 전달됨")
    ok(isinstance(up.get("bytes"), bytes) and
       json.loads(up["bytes"].decode("utf-8"))["participant_id"] == "P07",
       "올린 바이트가 유효한 JSON이고 내용이 맞다")
    ok(len(saved_files()) == before + 1, "업로드와 별개로 로컬에도 남는다", str(len(saved_files())))
    ok("저장 완료" in msg and "acct/exp-data" in msg and "서버 파일" in msg,
       "화면 문구에 Dataset 경로와 서버 파일이 함께", msg.replace("\n", " "))

    print("\n[8] Dataset 기본 repo — HF_DATASET_REPO 를 안 줘도 돈다")
    app = load_app(HF_TOKEN="hf_fake_token")
    app.save(payload(pid="P08"))
    ok(_FakeHfApi.uploads and _FakeHfApi.uploads[0]["repo_id"] == "yjsimonj/mouse-exp-data",
       "기본값 yjsimonj/mouse-exp-data 로 올린다 (repo 이름 오타 경로를 없앤다)",
       str(_FakeHfApi.uploads[0]["repo_id"]) if _FakeHfApi.uploads else "업로드 없음")

    print("\n[9] 토큰이 없을 때 — 로컬 실행(계획서 1안)")
    app = load_app()
    before = len(saved_files())
    msg = app.save(payload(pid="P09"))
    ok(not _FakeHfApi.uploads, "업로드를 시도하지 않는다")
    ok(len(saved_files()) == before + 1, "로컬 저장은 그대로 된다")
    ok("저장 완료" in msg and "Dataset" not in msg,
       "Dataset 얘기 없이 조용히 넘어간다", msg.replace("\n", " "))

    print("\n[10] Space 위에서 토큰 없이 — 재시작하면 사라진다고 경고해야 한다")
    app = load_app(SPACE_ID="yjsimonj/gijayeon")
    msg = app.save(payload(pid="P10"))
    ok("저장 완료" in msg, "로컬 저장 자체는 성공")
    ok("HF_TOKEN" in msg and "사라집니다" in msg and "직접 받기" in msg,
       "토큰 누락·데이터 소실·예비 다운로드를 모두 알린다", msg.replace("\n", " "))

    print("\n[11] 업로드가 실패할 때 — 세션은 건져야 한다")
    app = load_app(HF_TOKEN="hf_fake_token")
    _FakeHfApi.fail_with = RuntimeError("401 Unauthorized")
    before = len(saved_files())
    msg = app.save(payload(pid="P11", n_main=5))
    ok(len(saved_files()) == before + 1, "업로드가 실패해도 로컬 파일은 남는다")
    ok("저장 완료" in msg and "업로드는 실패" in msg and "401" in msg,
       "실패 이유를 화면에 그대로 드러낸다", msg.replace("\n", " "))
    ok("직접 받기" in msg, "예비 다운로드를 권한다")

    print("\n[12] 로컬·업로드 둘 다 실패 — 이때만 '저장 실패'")
    app = load_app(HF_TOKEN="hf_fake_token")
    _FakeHfApi.fail_with = RuntimeError("network down")
    app.DATA_DIR = os.path.join(DATA_DIR, "both_fail_not_a_dir")
    with open(app.DATA_DIR, "w", encoding="utf-8") as f:
        f.write("이 경로는 폴더가 아니다")
    msg = app.save(payload(pid="P12"))
    ok(msg.startswith("### ⚠ 저장 실패"), "'저장 실패' 로 시작", msg.replace("\n", " ")[:80])
    ok("network down" in msg and "반드시 받아" in msg,
       "양쪽 실패 이유 + 반드시 받으라는 지시", msg.replace("\n", " ")[:160])

    print("\n[13] 저장 폴더를 쓸 수 없을 때 (토큰 없음)")
    # [12] 는 토큰이 있는 app 을 쓰므로 여기서 새로 불러온다. 그러지 않으면
    # "토큰 없음" 이라고 적어 놓고 실제로는 업로드까지 실패한 경로를 재는 셈이 된다.
    app_bad = load_app()
    app_bad.DATA_DIR = os.path.join(DATA_DIR, "file_not_dir")
    with open(app_bad.DATA_DIR, "w", encoding="utf-8") as f:
        f.write("이 경로는 폴더가 아니다")
    msg = app_bad.save(payload())
    ok("저장 실패" in msg and "직접 받기" in msg,
       "예외를 던지지 않고 예비 다운로드로 안내", msg.replace("\n", " ")[:120])
    print("\n[14] ZeroGPU 시작 검사 — @spaces.GPU 함수가 등록되는가")
    # ZeroGPU 런타임은 launch() 시점에 데코레이트된 함수가 하나라도 있는지 보고,
    # 없으면 프로세스를 끊는다. 여기서 재는 것은 "등록되었는가" 하나다.
    decorated = []

    def _fake_gpu(task=None, **kw):
        if callable(task):
            decorated.append(task)
            return task
        def wrap(fn):
            decorated.append(fn)
            return fn
        return wrap

    fake_spaces = types.ModuleType("spaces")
    fake_spaces.GPU = _fake_gpu
    sys.modules["spaces"] = fake_spaces
    app = load_app()
    ok(len(decorated) == 1, "@spaces.GPU 함수가 정확히 1개 등록된다", str(len(decorated)))
    ok(decorated and decorated[0].__name__ == "_zerogpu_placeholder",
       "등록된 것이 자리표시자", str([f.__name__ for f in decorated]))
    ok(callable(getattr(app, "_zerogpu_placeholder", None)),
       "모듈에서 접근 가능 (지우면 Space가 죽는다는 표시)")
    # 자리표시자는 어디에도 연결되지 않아야 한다 — 불리면 GPU가 실제로 할당된다
    src = io.open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()
    ok(src.count("_zerogpu_placeholder") == 1,
       "자리표시자는 정의만 있고 호출·연결하는 곳이 없다",
       f"{src.count('_zerogpu_placeholder')}회 등장")

    print("\n[15] spaces 가 없을 때 — 로컬 실행은 그대로 돌아야 한다")
    sys.modules.pop("spaces", None)
    sys.modules["spaces"] = None      # import spaces → ImportError
    app = load_app()
    ok(app.spaces is None, "spaces 가 없으면 None 으로 두고 넘어간다")
    before = len(saved_files())
    msg = app.save(payload(pid="P15"))
    ok("저장 완료" in msg and len(saved_files()) == before + 1,
       "spaces 없이도 저장이 정상 동작", msg.replace("\n", " "))
    sys.modules.pop("spaces", None)

finally:
    shutil.rmtree(DATA_DIR, ignore_errors=True)

print("\n" + "=" * 60)
print(f"통과: {checks}개 검사 전부 OK" if failures == 0 else f"실패: {failures} / {checks}")
print("=" * 60)
sys.exit(1 if failures else 0)
