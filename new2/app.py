"""
마우스 보정 실험 — Gradio 앱

실행
    pip install gradio
    python app.py                 →  http://127.0.0.1:7860
    점검용 축소 모드: http://127.0.0.1:7860/?dev=1   (24시행)

역할은 두 가지뿐이다.
  1. static/ 의 실험 화면(순수 HTML/JS)을 브라우저에 얹어 준다
  2. JS가 넘겨준 결과 JSON을 저장한다

실험 로직은 전부 JS다. Gradio 컴포넌트로는 궤적 125Hz·px 단위 클릭 좌표·ms 단위
타이밍·전체화면을 다룰 수 없기 때문이다(계획서 §2).

저장은 두 곳에 한다 (둘 다 시도하고, 결과를 화면에 그대로 보여준다)

  1. 서버 로컬       data/main_<참가자ID>_<시각>.json
                     같은 참가자를 두 번 돌려도 시각이 달라 덮어쓰지 않는다.
                     저장 폴더를 바꾸려면 환경변수 MOUSE_EXP_DATA_DIR.

  2. HF Dataset repo raw/main_<참가자ID>_<시각>.json
                     HF Space에서 돌릴 때 필수다. Space 파일시스템은 재시작하면
                     초기화되므로(계획서 §2 "왜 Dataset repo가 필요한가") 1번만
                     믿으면 데이터가 조용히 사라진다.

                     HF_TOKEN         write 권한 토큰 (Space → Settings →
                                      Variables and secrets 에 secret 으로)
                     HF_DATASET_REPO  기본값 yjsimonj/mouse-exp-data (바꿀 때만)

                     HF_TOKEN 이 없으면 업로드만 건너뛴다 — 로컬 실행(계획서 1안)은
                     토큰 없이 그대로 돌아간다.

어느 쪽이 실패해도 예외를 밖으로 던지지 않는다. 완료 화면의 "JSON 직접 받기" 가
마지막 보험이라, 참가자가 그걸 누를 수 있게 화면을 띄우는 것이 우선이다(§3.4).
"""

import datetime
import json
import os
import threading
import traceback

import gradio as gr

# ---------------------------------------------------------------- ZeroGPU
# 이 Space는 ZeroGPU(zero-a10g) 하드웨어에 올라가 있다. ZeroGPU 런타임은 앱이
# launch() 하는 순간 "@spaces.GPU 로 데코레이트된 함수가 하나라도 등록됐는지"를
# 보고, 없으면 프로세스를 끊는다:
#
#   No @spaces.GPU function detected during startup   →  stage: RUNTIME_ERROR
#
# 로그에는 앱이 정상 기동한 뒤 조용히 멈춘 것처럼 찍혀서(Running on local URL
# 다음 줄이 Stopping Node.js server...) 코드를 의심하게 되는 함정이다.
#
# spaces 패키지 안을 보면 판정 기준이 이렇다 (spaces/zero/__init__.py):
#   - import 시점에 gr.Blocks.launch 를 감싸 두고 (gradio.one_launch)
#   - launch() 가 불릴 때 startup() 을 먼저 돌리는데
#   - decorator.decorated_cache 가 비어 있으면 그냥 return 해 버린다
#     → 플랫폼이 기다리는 startup_report() 가 전송되지 않는다
#
# 그래서 필요한 것은 "GPU를 쓰는 코드"가 아니라 **등록된 함수 하나**다. 이 앱은
# 서버에서 계산을 하지 않으므로(계획서 §2 — 실험 로직은 전부 브라우저 JS다) 아래
# 자리표시자는 어디에도 연결하지 않고 호출도 하지 않는다. 호출하지 않으므로 GPU가
# 실제로 할당되는 일도 없다.
#
# spaces 는 requirements.txt 에 적지 않는다. ZeroGPU Space는 빌드 시 pip 명령에
# spaces==0.51.1 을 직접 붙이므로, 여기서 버전을 요구하면 그 핀과 충돌해 빌드가
# 깨진다(실제로 spaces>=0.51.3 으로 BUILD_ERROR 를 냈다). 플랫폼이 깔아 준 것을 쓴다.
# 0.51.1 과 0.51.3 의 판정 로직(zero/__init__.py, zero/decorator.py)은 동일하다.
#
# torch 도 요구하지 않는다. 플랫폼이 "torch<=2.11.0" 을 같이 깔지만, 없어도 무해하다 —
# spaces/zero/torch/__init__.py 가 import torch 를 try 로 감싸 두어 없으면
# patch()·pack() 이 전부 no-op 으로 떨어지고 startup_report() 는 그대로 나간다.
try:
    import spaces
except ImportError:
    # 로컬 실행(계획서 1안)에는 spaces 가 없다. 없어도 그대로 돌아야 한다.
    spaces = None

if spaces is not None:

    @spaces.GPU
    def _zerogpu_placeholder():
        """ZeroGPU 시작 검사를 통과시키는 자리표시자. 부르지 않는다.

        지우면 Space가 시작 직후 RUNTIME_ERROR 로 죽는다. 하드웨어를 CPU basic 으로
        바꾸면 필요 없어지지만, 그때도 무해하다 — ZeroGPU가 아닌 곳에서는
        spaces.GPU 가 함수를 그대로 돌려주고 아무것도 등록하지 않는다.
        """
        return None


HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA_DIR = os.environ.get("MOUSE_EXP_DATA_DIR") or os.path.join(HERE, "data")

# Dataset repo 이름은 기본값을 박아 둔다. 계획서 §9 체크리스트가 "repo 이름 오타"를
# 배포 전 확인 항목으로 꼽는데, 기본값이 있으면 그 실패 경로가 아예 없어진다.
# 이름은 계획서 §3.1 의 `계정/mouse-exp-data` 규약을 따른다.
DATASET_REPO = (os.environ.get("HF_DATASET_REPO") or "yjsimonj/mouse-exp-data").strip()
HF_TOKEN = (os.environ.get("HF_TOKEN") or "").strip()

# HF Space 안에서 돌고 있는가. 토큰이 없을 때 경고 수준을 정하는 데 쓴다 — Space에서
# 로컬 저장만 되는 상태는 "재시작하면 데이터가 사라진다"는 뜻이라 그냥 넘길 수 없다.
ON_SPACE = bool(os.environ.get("SPACE_ID"))

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


def _save_local(name: str, text: str):
    """서버 로컬 data/ 에 쓴다. (ok, 상세) 를 돌려주고 예외는 삼킨다."""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        path = os.path.join(DATA_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return True, os.path.join(os.path.basename(DATA_DIR), name)
    except OSError as exc:
        traceback.print_exc()
        return False, f"{type(exc).__name__}: {exc}"


def _upload_dataset(name: str, text: str):
    """HF Dataset repo 에 올린다. ("ok"|"skipped"|"failed", 상세).

    토큰이 없으면 "skipped" — 로컬 실행(계획서 1안)은 토큰 없이 돌아가야 한다.
    올릴 때 임시 파일을 만들지 않고 바이트를 그대로 넘긴다. 로컬 쓰기가 실패한
    상황에서도 업로드는 살아 있어야 하므로, 두 경로가 서로에게 의존하면 안 된다.
    """
    if not HF_TOKEN:
        return "skipped", "HF_TOKEN 없음"
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        return "failed", f"huggingface_hub 를 불러올 수 없습니다 ({exc})"
    try:
        HfApi().upload_file(
            path_or_fileobj=text.encode("utf-8"),
            path_in_repo=f"raw/{name}",
            repo_id=DATASET_REPO,
            repo_type="dataset",
            token=HF_TOKEN,
        )
    except Exception as exc:
        # 토큰 만료·권한 부족·repo 오타·네트워크 — 무엇이든 화면에 드러낸다.
        # 여기서 조용히 넘기면 25분짜리 세션이 사라진 것을 아무도 모른다.
        traceback.print_exc()
        return "failed", f"{type(exc).__name__}: {exc}"
    return "ok", f"{DATASET_REPO}/raw/{name}"


def save(payload: str):
    """결과 JSON을 로컬 data/ 와 HF Dataset repo 양쪽에 저장한다.

    실패해도 예외를 밖으로 던지지 않는다. 참가자 화면에 이유를 그대로 보여주고
    "JSON 직접 받기" 버튼으로 데이터를 건지게 하는 것이 우선이다 — 25분짜리
    세션을 다시 부를 수는 없다(계획서 §3.4).
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
    text = json.dumps(data, ensure_ascii=False)

    trials = data.get("trials", [])
    n_main = len([t for t in trials if not t.get("warmup")])

    local_ok, local_detail = _save_local(name, text)
    remote_state, remote_detail = _upload_dataset(name, text)

    print(f"[저장] {name}  ({n_main} 본시행 / {len(trials)} 전체)  "
          f"local={'ok' if local_ok else local_detail}  dataset={remote_state}")

    # 둘 다 실패했을 때만 "저장 실패"다. 한쪽이라도 남았으면 데이터는 건졌다.
    if not local_ok and remote_state != "ok":
        return "\n".join([
            f"### ⚠ 저장 실패 — {pid} · 본시행 {n_main}회",
            f"- 서버 로컬: {local_detail}",
            f"- Dataset: {remote_detail}",
            "",
            "**화면의 “JSON 직접 받기”로 파일을 반드시 받아 두세요.**",
        ])

    lines = ["### 저장 완료", f"- 참가자 **{pid}** · 본시행 {n_main}회"]
    if remote_state == "ok":
        lines.append(f"- Dataset `{remote_detail}`")
    if local_ok:
        lines.append(f"- 서버 파일 `{local_detail}`")

    if remote_state == "failed":
        lines += [
            "",
            f"⚠ Dataset 업로드는 실패했습니다 ({remote_detail}). "
            "서버 파일은 남았지만, **“JSON 직접 받기”로 한 부 더 받아 두세요.**",
        ]
    elif remote_state == "skipped" and ON_SPACE:
        # Space에서 로컬만 남는 것은 사실상 저장이 안 된 것이다 (계획서 §2).
        lines += [
            "",
            "⚠ **HF_TOKEN 이 설정되지 않아 Dataset에 올라가지 않았습니다.** "
            "Space 파일시스템은 재시작하면 초기화되므로 이 파일은 사라집니다 — "
            "**“JSON 직접 받기”로 파일을 받아 두고**, 연구자는 Space Settings 의 "
            "secret 을 확인하세요.",
        ]

    return "\n".join(lines)


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
    print(f"로컬 저장 폴더: {DATA_DIR}")
    if HF_TOKEN:
        print(f"Dataset 업로드: {DATASET_REPO}  (raw/main_<ID>_<시각>.json)")
    else:
        print(f"Dataset 업로드: 끔 (HF_TOKEN 없음). 대상은 {DATASET_REPO} 였다.")
        if ON_SPACE:
            print("  ⚠ Space에서 토큰 없이 돌고 있다 — 재시작하면 data/ 가 사라진다.")
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
