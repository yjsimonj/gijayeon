#!/usr/bin/env python
"""
app.py 의 save() 점검 — gradio/huggingface_hub 설치 없이 돌아간다.

두 모듈을 가짜로 끼워 넣고 app 을 import 한 뒤 save() 만 시험한다.
Space에 올리기 전 계획서 §9 체크리스트 중 다음 항목을 자동으로 확인한다.

  - 빈 문자열이 넘어왔을 때(§3.3 setter 누락) 조용히 넘어가지 않는가
  - 업로드 실패·환경변수 누락에도 예외 없이 안내 문구를 돌려주는가
  - 테스트 파일 2개가 서로 다른 이름으로 저장되는가 (덮어쓰기 아닌지)
  - 참가자 ID에 경로 문자가 섞여도 파일명이 안전한가

  python tools/test_app_save.py
"""

from __future__ import annotations

import json
import os
import sys
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


# ---------------------------------------------------------------- 가짜 모듈

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
fake_gradio.Blocks = _Blocks
fake_gradio.HTML = _Fake
fake_gradio.Textbox = _Fake
fake_gradio.Button = _Fake
fake_gradio.Markdown = _Fake

uploads = []


class _HfApi:
    def upload_file(self, path_or_fileobj=None, path_in_repo=None, repo_id=None,
                    repo_type=None, token=None):
        if token == "boom":                       # 토큰 만료 상황 재현
            raise RuntimeError("401 Unauthorized")
        uploads.append({
            "local": path_or_fileobj, "repo_path": path_in_repo,
            "repo": repo_id, "type": repo_type,
        })


fake_hub = types.ModuleType("huggingface_hub")
fake_hub.HfApi = _HfApi

sys.modules["gradio"] = fake_gradio
sys.modules["huggingface_hub"] = fake_hub
sys.path.insert(0, ROOT)


def load_app(repo="acct/mouse-exp-data", token="tok"):
    os.environ["HF_DATASET_REPO"] = repo
    os.environ["HF_TOKEN"] = token
    for name in list(sys.modules):
        if name == "app":
            del sys.modules[name]
    import app  # noqa: E402  (환경변수를 세운 뒤 import 해야 REPO/TOKEN이 잡힌다)
    return app


def sample_payload(pid="P03", n=3):
    return json.dumps({
        "schema_version": "3.0",
        "mode": "main",
        "participant_id": pid,
        "trials": [{"index": i} for i in range(n)],
    })


# ---------------------------------------------------------------- 시험

print("\n[1] 정상 업로드")
app = load_app()
uploads.clear()
msg = app.save(sample_payload())
ok("저장 완료" in msg, "성공 문구 반환", msg)
ok(len(uploads) == 1, "업로드 1회 호출")
ok(uploads and uploads[0]["repo"] == "acct/mouse-exp-data", "repo_id 전달")
ok(uploads and uploads[0]["type"] == "dataset", "repo_type=dataset (Space 파일시스템이 아니라 Dataset repo)")
ok(uploads and uploads[0]["repo_path"].startswith("raw/main_P03_"), "경로 raw/main_<id>_<시각>.json",
   uploads[0]["repo_path"] if uploads else "")
ok("3시행" in msg, "시행 수 표시", msg)

print("\n[2] 같은 참가자를 두 번 저장 → 덮어쓰지 않는가 (§9 체크리스트)")
uploads.clear()
app.save(sample_payload())
os.environ["TZ"] = os.environ.get("TZ", "")
# 파일명은 초 단위 시각을 포함한다. 같은 초에 두 번 저장하면 이름이 겹칠 수 있으므로
# 그 한계를 여기서 드러내 둔다 (참가자당 25분 세션이라 실사용에서는 발생하지 않는다).
import time  # noqa: E402
time.sleep(1.05)
app.save(sample_payload())
names = [u["repo_path"] for u in uploads]
ok(len(set(names)) == 2, "두 파일 이름이 다름", str(names))

print("\n[3] 위험한 참가자 ID")
uploads.clear()
app.save(sample_payload(pid="../../etc/passwd"))
path = uploads[0]["repo_path"]
ok(".." not in path and path.count("/") == 1, "경로 문자가 제거됨", path)
uploads.clear()
app.save(sample_payload(pid="참가자!"))   # ASCII 문자가 하나도 없는 경우
ok(uploads[0]["repo_path"].startswith("raw/main_unknown_"), "쓸 수 있는 문자가 없으면 unknown",
   uploads[0]["repo_path"])
uploads.clear()
app.save(sample_payload(pid="한글 P03"))  # 유니코드는 떨어지고 ASCII만 남는다
ok(uploads[0]["repo_path"].startswith("raw/main_P03_"), "유니코드 문자는 제거 (JS 규칙과 동일)",
   uploads[0]["repo_path"])

print("\n[4] 빈 payload — §3.3 setter 누락 상황")
msg = app.save("")
ok("⚠" in msg and "setter" in msg, "원인(setter)을 짚어 주는 경고", msg)

print("\n[5] 깨진 JSON")
msg = app.save("{not json")
ok("파싱 실패" in msg and "다운로드" in msg, "파싱 실패 + 다운로드 안내", msg)

print("\n[6] 업로드 실패 (토큰 만료)")
app = load_app(token="boom")
msg = app.save(sample_payload())
ok("업로드 실패" in msg, "예외를 밖으로 던지지 않고 문구로 반환", msg)
ok("다운로드" in msg, "다운로드 안내 포함 (§3.4)", msg)

print("\n[7] 환경변수 누락")
app = load_app(repo="", token="")
msg = app.save(sample_payload())
ok("HF_DATASET_REPO" in msg and "HF_TOKEN" in msg, "무엇이 없는지 알려준다", msg)
ok("다운로드" in msg, "다운로드 안내 포함", msg)

print("\n[8] 과대 payload")
app = load_app()
big = json.dumps({"participant_id": "P01", "mode": "main", "trials": [],
                  "pad": "x" * (33 * 1024 * 1024)})
msg = app.save(big)
ok("너무 큽니다" in msg, "용량 상한에서 거절", msg[:60])

print("\n" + "=" * 60)
print(f"통과: {checks}개 검사 전부 OK" if failures == 0 else f"실패: {failures} / {checks}")
print("=" * 60)
sys.exit(1 if failures else 0)
