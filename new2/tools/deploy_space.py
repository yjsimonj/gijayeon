#!/usr/bin/env python
"""
HF Space + Dataset repo 배포 (계획서 §3.1, B안)

수동으로 하면 오타 한 번에 데이터가 사라지는 지점이 네 곳이다 — repo 이름,
토큰 권한, 시크릿 이름, 업로드 누락. 그 네 곳을 한 번에 처리하고 마지막에
실제로 되는지까지 확인해 준다.

  pip install huggingface_hub

  # 1) 배포
  python tools/deploy_space.py --user <HF계정> --deploy

  # 2) 참가자가 한 세션 돌린 뒤, 데이터가 실제로 쌓였는지 확인
  python tools/deploy_space.py --user <HF계정> --check

토큰은 --token 인자, 환경변수 HF_TOKEN, 그 다음 입력 프롬프트 순으로 찾는다.
인자로 주면 셸 기록에 남으니 되도록 프롬프트나 환경변수를 쓸 것.

무엇을 만드는가
  - Dataset repo : <user>/<dataset>   **private** (결과 JSON이 쌓이는 곳)
  - Space        : <user>/<space>     **public** (참가자가 링크로 들어와야 하므로)
                   Space에 등록되는 것: 시크릿 HF_TOKEN, 변수 HF_DATASET_REPO

Space가 public이어도 시크릿은 서버 쪽에만 있으므로 방문자에게 노출되지 않는다.
그래도 업로드용 토큰은 **이 Dataset repo에만 쓰기 권한이 있는 fine-grained 토큰**을
따로 발급해 --space-token 으로 주는 것을 권한다(배포용 토큰과 분리).

README.md 는 일부러 올리지 않는다. Space를 만들 때 HF가 유효한 sdk_version이 담긴
README를 자동으로 넣어 주는데, 우리 README로 덮으면 sdk_version이 사라져 빌드가
깨진다. Space 설명은 웹에서 고치면 된다.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

try:
    from huggingface_hub import HfApi
    from huggingface_hub.utils import HfHubHTTPError
except ImportError:
    print("huggingface_hub 가 없습니다:  pip install huggingface_hub", file=sys.stderr)
    raise SystemExit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Space에 올라가는 파일. 실험 화면(static/)이 빠지면 app.py가 시작하다 죽는다.
UPLOAD_PATTERNS = ["app.py", "requirements.txt", "static/*"]
REQUIRED_FILES = ["app.py", "requirements.txt",
                  "static/experiment.html", "static/experiment.js", "static/experiment.css"]


def resolve_token(cli_token, purpose):
    if cli_token:
        return cli_token
    env = os.environ.get("HF_TOKEN", "").strip()
    if env:
        print(f"  토큰: 환경변수 HF_TOKEN 사용 ({purpose})")
        return env
    return getpass.getpass(f"HF write 토큰 입력 ({purpose}): ").strip()


def check_local_files():
    missing = [f for f in REQUIRED_FILES if not os.path.exists(os.path.join(ROOT, f))]
    if missing:
        print("올릴 파일이 없습니다: " + ", ".join(missing), file=sys.stderr)
        raise SystemExit(2)


def deploy(args):
    check_local_files()
    token = resolve_token(args.token, "repo 생성·업로드용")
    api = HfApi(token=token)

    who = api.whoami()
    print(f"\n[0] 토큰 확인 — {who.get('name')} ({who.get('type')})")
    if args.user and args.user != who.get("name"):
        print(f"    주의: --user({args.user})와 토큰 소유자({who.get('name')})가 다릅니다. "
              f"조직 계정이라면 정상입니다.")

    dataset_id = f"{args.user}/{args.dataset}"
    space_id = f"{args.user}/{args.space}"
    space_token = args.space_token or token
    if not args.space_token:
        print("    (Space 시크릿에도 같은 토큰을 씁니다. 분리하려면 --space-token)")

    print(f"\n[1] Dataset repo (private) — {dataset_id}")
    api.create_repo(dataset_id, repo_type="dataset", private=True, exist_ok=True)
    print("    준비됨")

    print(f"\n[2] Space (gradio, public) — {space_id}")
    api.create_repo(space_id, repo_type="space", space_sdk="gradio",
                    private=False, exist_ok=True)
    print("    준비됨 (README/sdk_version 은 HF가 만든 것을 그대로 둡니다)")

    print(f"\n[3] 시크릿·변수")
    api.add_space_secret(space_id, "HF_TOKEN", space_token,
                         description="Dataset repo 업로드용 write 토큰")
    api.add_space_variable(space_id, "HF_DATASET_REPO", dataset_id,
                           description="결과 JSON이 쌓이는 Dataset repo")
    print(f"    HF_TOKEN (secret) / HF_DATASET_REPO = {dataset_id}")

    print(f"\n[4] 업로드 — {', '.join(UPLOAD_PATTERNS)}")
    api.upload_folder(
        repo_id=space_id,
        repo_type="space",
        folder_path=ROOT,
        allow_patterns=UPLOAD_PATTERNS,
        commit_message="마우스 보정 실험 v3 실험 앱 배포",
    )
    print("    완료")

    print(f"\n{'=' * 62}")
    print(f"Space   https://huggingface.co/spaces/{space_id}")
    print(f"Dataset https://huggingface.co/datasets/{dataset_id}")
    print(f"{'=' * 62}")
    print("""
빌드가 끝나면(1~3분) 순서대로 확인하세요.

  1. Space 링크 뒤에 ?dev=1 을 붙여 접속 → ID 'deploytest' → 모드 B → 24회 완주
     (?dev=1 축소 모드라 1분이면 끝납니다. 이 데이터는 dev_mode:true 로 박혀
      분석 스크립트가 경고를 띄우므로 실수로 결과에 섞일 일이 없습니다)
  2. 완료 화면에 "저장 완료 — deploytest, 20시행" 이 뜨는지
       ⚠ "전달된 데이터가 없습니다"  → JS 브리지 문제 (§3.3)
       ⚠ "업로드 실패: ..."          → 토큰 권한/repo 이름 확인
       ⚠ "환경변수 ... 없습니다"      → 이 스크립트를 다시 실행
  3. 완료 화면의 JSON 다운로드 버튼도 눌러 파일이 받아지는지 (§3.4)
  4. 터미널에서:  python tools/deploy_space.py --user <계정> --check
  5. 마지막으로 Wi-Fi를 끊고 ?dev=1 로 한 번 더 완주 → 업로드는 실패하지만
     다운로드 버튼으로 데이터가 남는지 (§9 체크리스트)

앱을 고친 뒤 다시 올릴 때도 같은 명령(--deploy)을 그대로 쓰면 됩니다.
""")


def check(args):
    token = resolve_token(args.token, "Dataset repo 조회용")
    api = HfApi(token=token)
    dataset_id = f"{args.user}/{args.dataset}"

    try:
        files = api.list_repo_files(dataset_id, repo_type="dataset")
    except HfHubHTTPError as exc:
        print(f"Dataset repo를 읽을 수 없습니다 ({dataset_id}): {exc}", file=sys.stderr)
        raise SystemExit(1)

    raw = sorted(f for f in files if f.startswith("raw/") and f.endswith(".json"))
    print(f"\n{dataset_id} / raw — {len(raw)}개")
    for f in raw:
        print("  " + f)

    if not raw:
        print("\n아직 아무것도 없습니다. Space에서 한 세션을 완주했는지, 완료 화면의"
              "\n저장 문구가 '저장 완료'였는지 확인하세요.")
        return

    modes = {}
    for f in raw:
        modes[f.split("/")[1].split("_")[0]] = modes.get(f.split("/")[1].split("_")[0], 0) + 1
    print("\n모드별: " + ", ".join(f"{k} {v}개" for k, v in sorted(modes.items())))
    print("\n내려받기:")
    print(f"  huggingface-cli download {dataset_id} --repo-type dataset --local-dir data")
    print("  (또는 웹에서 Files → 다운로드)")
    print("\n분석:  cd analysis && python analyze.py ../data/raw")


def main(argv=None):
    ap = argparse.ArgumentParser(description="HF Space + Dataset repo 배포 (계획서 §3)")
    ap.add_argument("--user", required=True, help="HF 계정(또는 조직) 이름")
    ap.add_argument("--space", default="mouse-calibration-exp", help="Space 이름")
    ap.add_argument("--dataset", default="mouse-exp-data", help="Dataset repo 이름")
    ap.add_argument("--token", help="배포용 write 토큰 (생략하면 HF_TOKEN 또는 프롬프트)")
    ap.add_argument("--space-token", help="Space 시크릿에 넣을 업로드용 토큰 (생략하면 배포용과 동일)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--deploy", action="store_true", help="repo 생성 + 시크릿 등록 + 업로드")
    g.add_argument("--check", action="store_true", help="Dataset repo에 쌓인 파일 확인")
    args = ap.parse_args(argv)

    if args.deploy:
        deploy(args)
    else:
        check(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
