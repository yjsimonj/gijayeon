"""
마우스 보정 실험 — Gradio 앱

실행
    pip install gradio
    python app.py                 →  http://127.0.0.1:7860
    점검용 축소 모드: http://127.0.0.1:7860/?dev=1   (24시행)

역할은 두 가지뿐이다.
  1. static/ 의 실험 화면(순수 HTML/JS)을 브라우저에 얹어 준다
  2. JS가 넘겨준 결과 JSON을 서버의 data/ 폴더에 쓴다

실험 로직은 전부 JS다. Gradio 컴포넌트로는 궤적 125Hz·px 단위 클릭 좌표·ms 단위
타이밍·전체화면을 다룰 수 없기 때문이다(계획서 §2).

저장 위치
    data/main_<참가자ID>_<시각>.json
    같은 참가자를 두 번 돌려도 시각이 달라 덮어쓰지 않는다.
"""

import datetime
import json
import os
import threading
import traceback

import gradio as gr

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA_DIR = os.environ.get("MOUSE_EXP_DATA_DIR") or os.path.join(HERE, "data")

MAX_PAYLOAD_BYTES = 32 * 1024 * 1024  # 620시행 JSON은 1~2MB. 이 이상이면 뭔가 잘못됐다.

ALLOWED_NAME_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
)


def _read(name: str) -> str:
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


HTML = _read("experiment.html")
JS = _read("experiment.js")
CSS = _read("experiment.css")


def _safe_name(value, fallback: str) -> str:
    """파일명에 들어갈 문자열을 ASCII 영문·숫자·_·- 로 제한한다.

    참가자 ID를 그대로 파일명에 쓰면 안 된다 — 경로 구분자나 '..' 가 들어오면
    data/ 밖에 쓰게 된다. str.isalnum() 은 한글도 True라 쓰지 않는다.
    """
    cleaned = "".join(c for c in str(value) if c in ALLOWED_NAME_CHARS)
    return cleaned or fallback


def save(payload: str):
    """결과 JSON을 data/ 에 저장한다. 실패해도 예외를 밖으로 던지지 않는다.

    참가자 화면에 이유를 그대로 보여주고 "직접 받기" 버튼으로 데이터를 건지게 하는
    것이 우선이다 — 25분짜리 세션을 다시 부를 수는 없다(계획서 §3.4).
    """
    if not payload:
        # value setter 없이 textbox.value 에 직접 넣으면 빈 문자열이 조용히 넘어온다.
        # (계획서 §3.3) 그 경우를 여기서 잡아 알려 준다.
        return "⚠ 전달된 데이터가 없습니다 — experiment.js 의 submitResults 확인 필요"

    if len(payload.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        return "⚠ 데이터가 너무 큽니다 — 화면의 “JSON 직접 받기”로 파일을 받아 두세요"

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        return f"⚠ JSON 파싱 실패: {exc} — 화면의 “JSON 직접 받기”로 파일을 받아 두세요"

    pid = _safe_name(data.get("participant_id"), "unknown")
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"main_{pid}_{ts}.json"

    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        path = os.path.join(DATA_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError as exc:
        traceback.print_exc()
        return (
            f"⚠ 저장 실패: {exc}\n\n"
            f"**화면의 “JSON 직접 받기”로 파일을 반드시 받아 두세요** ({pid}, {len(data.get('trials', []))}시행)"
        )

    trials = data.get("trials", [])
    main_trials = [t for t in trials if not t.get("warmup")]
    print(f"[저장] {path}  ({len(main_trials)} 본시행 / {len(trials)} 전체)")
    return (
        f"### 저장 완료\n"
        f"- 참가자 **{pid}** · 본시행 {len(main_trials)}회\n"
        f"- 파일 `{os.path.join(os.path.basename(DATA_DIR), name)}`"
    )


# 통로용 컴포넌트를 감추는 방식에 주의. visible=False 로 만들면 Gradio 버전에 따라
# DOM에 아예 렌더링되지 않을 수 있고, 그러면 JS가 #payload 를 못 찾아 조용히 저장이
# 안 된다. 컴포넌트는 살려 두고 CSS로만 감춘다 — DOM에는 반드시 있어야 한다.
BRIDGE_CSS = "#payload, #trigger { display: none !important; }"

HEAD = f"<style>{CSS}{BRIDGE_CSS}</style><script>{JS}</script>"

# head 를 넘기는 위치가 Gradio 6에서 바뀌었다.
#   ~5.x : gr.Blocks(head=...)
#   6.0+ : demo.launch(head=...)    ← Blocks에 주면 경고만 뜨고 조용히 무시된다
# 무시되면 CSS·JS가 주입되지 않아 실험 화면이 아예 뜨지 않는다.
_GRADIO_MAJOR = int(str(gr.__version__).split(".")[0])
_BLOCKS_KWARGS = {} if _GRADIO_MAJOR >= 6 else {"head": HEAD}
_LAUNCH_KWARGS = {"head": HEAD} if _GRADIO_MAJOR >= 6 else {}

with gr.Blocks(title="마우스 보정 실험", **_BLOCKS_KWARGS) as demo:
    gr.HTML(HTML)

    # 실험 화면(JS) → 파이썬 통로 (계획서 §3.3)
    payload = gr.Textbox(elem_id="payload", label="payload")
    trigger = gr.Button("trigger", elem_id="trigger")
    status = gr.Markdown()

    trigger.click(save, inputs=payload, outputs=status)


def main():
    print(f"저장 폴더: {DATA_DIR}")
    demo.launch(**_LAUNCH_KWARGS)
    # Gradio 6의 launch()는 서버를 띄우고 곧바로 반환한다. 그대로 두면 프로세스가
    # 끝나 버리므로 붙잡아 둔다.
    try:
        demo.block_thread()
    except (AttributeError, KeyboardInterrupt, OSError):
        pass
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
