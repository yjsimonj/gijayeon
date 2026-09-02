"""
마우스 보정 실험 v3 — Gradio Space 껍데기 (계획서 §2, §3)

역할은 두 가지뿐이다.
  1. static/ 의 실험 화면(순수 HTML/JS)을 참가자 브라우저에 얹어준다
  2. JS가 넘겨준 결과 JSON을 HF Dataset repo(private)에 올린다

실험 로직은 전부 JS다. Gradio 컴포넌트로는 125Hz 궤적·px 단위 클릭 좌표·ms 단위
타이밍·전체화면을 다룰 수 없기 때문이다(계획서 §2). Space 파일시스템은 재시작하면
초기화되므로 저장은 반드시 Dataset repo로 나간다(§2 "왜 Dataset repo가 필요한가").

배포 준비 (§3.1)
  1. HF에서 private Dataset repo 생성
  2. write 권한 토큰 발급
  3. Space → Settings → Variables and secrets 에 등록
       HF_TOKEN        = 발급한 write 토큰            (secret)
       HF_DATASET_REPO = 계정이름/mouse-exp-data      (variable)

로컬에서 이 파일을 돌려볼 때도 같은 환경변수를 쓰면 된다. 환경변수가 없으면
업로드만 실패하고 실험 자체는 정상 동작한다 — 참가자는 완료 화면의 다운로드
버튼으로 데이터를 건질 수 있다(§3.4).
"""

import datetime
import json
import os
import traceback

import gradio as gr
from huggingface_hub import HfApi

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

REPO = os.environ.get("HF_DATASET_REPO", "").strip()
TOKEN = os.environ.get("HF_TOKEN", "").strip()

MAX_PAYLOAD_BYTES = 32 * 1024 * 1024  # 620시행 JSON은 1~2MB (§3.5). 이 이상이면 뭔가 잘못됐다.


def _read(name: str) -> str:
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


HTML = _read("experiment.html")
JS = _read("experiment.js")
CSS = _read("experiment.css")


ALLOWED_NAME_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
)


def _safe_token(value, fallback: str) -> str:
    """파일명에 들어갈 문자열을 ASCII 영문·숫자·_·- 로 제한한다.

    참가자 ID를 그대로 파일명에 쓰면 안 된다 — 경로 구분자나 '..' 가 들어오면
    repo 안의 엉뚱한 경로에 쓰게 된다.

    str.isalnum() 은 한글·한자 같은 유니코드 문자도 True다. 실험 화면(experiment.js)
    쪽은 ID를 ASCII로 제한하므로, 서버도 같은 규칙을 써서 파일명 인코딩 문제를
    아예 만들지 않는다.
    """
    cleaned = "".join(c for c in str(value) if c in ALLOWED_NAME_CHARS)
    return cleaned or fallback


def save(payload: str):
    """JS가 숨긴 텍스트박스로 넘긴 결과 JSON을 Dataset repo에 올린다.

    실패해도 예외를 밖으로 던지지 않는다. 참가자 화면에 그대로 보여주고 다운로드
    버튼으로 데이터를 건지게 하는 것이 우선이다.
    """
    if not payload:
        # value setter 없이 textbox.value 에 직접 넣으면 빈 문자열이 조용히 넘어온다.
        # (§3.3) 그 경우를 여기서 잡아 알려준다.
        return "⚠ 전달된 데이터가 없습니다 — experiment.js 의 submitResults(setter.call) 확인 필요"

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        return f"⚠ JSON 파싱 실패: {exc} — 브라우저 다운로드 버튼으로 파일을 받아 두세요"

    if len(payload.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        return "⚠ 데이터가 너무 큽니다 — 브라우저 다운로드 버튼으로 파일을 받아 두세요"

    pid = _safe_token(data.get("participant_id"), "unknown")
    mode = _safe_token(data.get("mode"), "unknown")
    n_trials = len(data.get("trials", []))
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"{mode}_{pid}_{ts}.json"
    path = f"/tmp/{name}"

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    if not REPO or not TOKEN:
        missing = " / ".join(
            n for n, v in (("HF_DATASET_REPO", REPO), ("HF_TOKEN", TOKEN)) if not v
        )
        return (
            f"⚠ 서버 저장 안 됨 — 환경변수 {missing} 가 설정되지 않았습니다.\n\n"
            f"**참가자 화면의 다운로드 버튼으로 파일을 받아 두세요** ({pid}, {n_trials}시행)"
        )

    try:
        HfApi().upload_file(
            path_or_fileobj=path,
            path_in_repo=f"raw/{name}",
            repo_id=REPO,
            repo_type="dataset",
            token=TOKEN,
        )
    except Exception as exc:  # 토큰 만료·repo 오타·네트워크 — 무엇이든 화면에 드러낸다
        traceback.print_exc()
        return (
            f"⚠ 업로드 실패: {type(exc).__name__}: {exc}\n\n"
            f"**참가자 화면의 다운로드 버튼으로 파일을 반드시 받아 두세요** ({pid}, {n_trials}시행)"
        )

    return f"저장 완료 — {pid}, {n_trials}시행 → `{REPO}/raw/{name}`"


# 통로용 컴포넌트를 감추는 방식에 주의. visible=False 로 만들면 Gradio 버전에 따라
# DOM에 아예 렌더링되지 않을 수 있고, 그러면 JS가 #payload 를 못 찾아 조용히 저장이
# 안 된다. 그래서 컴포넌트는 살려 두고 CSS로만 감춘다 — DOM에는 반드시 있어야 한다.
BRIDGE_CSS = "#payload, #trigger { display: none !important; }"

with gr.Blocks(
    title="마우스 보정 실험",
    head=f"<style>{CSS}{BRIDGE_CSS}</style><script>{JS}</script>",
) as demo:
    gr.HTML(HTML)

    # 실험 화면(JS)과 파이썬을 잇는 통로 (§3.3).
    payload = gr.Textbox(elem_id="payload", label="payload")
    trigger = gr.Button("trigger", elem_id="trigger")
    status = gr.Markdown()

    trigger.click(save, inputs=payload, outputs=status)

if __name__ == "__main__":
    demo.launch()
