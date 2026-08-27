# 마우스 보정 실험 — 실행 가이드

`마우스보정_실험계획서.md`(연구 설계)와 그 구현 확정 사항(구현 중 발견된 모순·공백을 연구자와 조율한 결과)을 실행하는 웹앱 + 분석 모듈. 확정 사항의 근거와 전체 설계 논의는 이 대화의 계획 기록을 참고. 이 문서는 "무엇을 만들었는지"가 아니라 "어떤 순서로 실행하는지"에 집중한다.

## 디렉터리

```
new/
├─ experiment/        웹앱 (index.html, style.css, app.js)
├─ analysis/
│  ├─ error_decomposition.py   방향 추정 + e∥/e⊥ 분해
│  ├─ feature_extraction.py    궤적 → 특징 벡터 (+ 멈칫 분해)
│  ├─ compute_sigma.py         σ/gap config 오프라인 재현·검증용
│  ├─ train_model.py           릿지 회귀 학습 + 교차검증
│  ├─ model_io.py              모델 로드 · 보정 적용 · 스냅 판정
│  ├─ evaluate_phase2.py       2단계 평가 (McNemar 등)
│  ├─ evaluate_phase3.py       3단계 A/B/C/D 재평가 (Cochran's Q 등)
│  └─ plots.py                 그림 4종
├─ .venv/              분석용 가상환경 (git 제외)
├─ requirements.txt    분석 라이브러리 (최소 버전)
├─ requirements-lock.txt  검증된 정확한 버전
├─ config/
│  ├─ phase0_button_sizes.json      0단계 결과 집계로 생성 (최초엔 없음)
│  └─ participant_gap_configs/      1단계 완료 시 웹앱이 내려주는 gap config 저장 위치
├─ data/               원본 JSON + 분석 결과 JSON
├─ figures/            plots.py 출력
└─ results/            결과 보고서
```

## 웹앱 실행

```
cd new/experiment
python -m http.server 8000
```
브라우저에서 `http://localhost:8000` 접속. **`file://`로 직접 열지 말 것** — 전체화면·마우스 이벤트 정확도에 영향을 줄 수 있음.

개발/점검용으로 시행 수를 대폭 줄인 축소 모드는 `?dev=1`을 붙여 접속 (`http://localhost:8000/?dev=1`). 기본 실행 경로에는 영향 없음.

## 전체 실행 순서

1. **0단계(예비실험)** — 참가자 2~3명 각각 별도로 실행(각 150회: 후보 크기 5종 × 30회). 완료 화면에서 각자 JSON 내보내기. **한 명만 하고 넘어가지 말 것** — 여기서 정한 버튼 크기는 전체 참가자에게 공통 적용되므로, 한 사람 손에 맞추면 다른 참가자의 난이도가 어긋난다.
2. **0단계 결과 집계** — 설정 화면 → "0단계 결과 집계 화면으로" → 1에서 내보낸 JSON 파일들을 **전부 한 번에** 선택 → "집계 실행". 크기별 관측 성공률과 로지스틱 회귀 적합 결과, 산출된 크기 3종이 표시된다. 아래 경고가 뜨면 그대로 진행하지 말 것:
   - *관측 범위 밖 외삽* — 목표 성공률에 해당하는 크기가 시험해본 크기보다 큼. 후보 크기를 넓혀(예: 40·48px 추가) 0단계를 다시 돌린다.
   - *참가자 1명* — 위 1번 참고.

   문제가 없으면 "phase0_button_sizes.json 다운로드" → `new/config/phase0_button_sizes.json`으로 옮겨둔다.
3. **1단계(학습 데이터 수집)** — 참가자별로 설정 화면에서 참가자 ID 입력, 1단계 선택, `phase0_button_sizes.json` 불러오기 → 시작 (400회). 완료 화면에서:
   - "JSON 내보내기" → `new/data/`로 옮겨둔다.
   - "gap config 다운로드" → 3단계에 쓸 σ/gap 값이 담긴 파일. `new/config/participant_gap_configs/`로 옮겨둔다.
4. **(검증, 선택)** — 3에서 내보낸 1단계 JSON에 대해
   ```
   cd new/analysis
   ../.venv/Scripts/python.exe compute_sigma.py ../data/phase1_<참가자ID>_*.json
   ```
   출력된 `sigma_px`가 3번에서 웹앱이 내려준 gap config의 `sigma_px`와 일치하는지 대조한다. 불일치하면 웹앱/스크립트 중 하나에 버그가 있다는 뜻이므로 실험을 계속 진행하기 전에 원인을 확인할 것.
5. **2단계(단일 버튼 평가)** — 설정 화면에서 2단계 선택, `phase0_button_sizes.json` 불러오기 → 시작 (120회, 1단계와 별개의 새 시행). 완료 후 JSON 내보내기.
6. **3단계(다중 버튼 평가)** — 설정 화면에서 3단계 선택, `phase0_button_sizes.json` + 3에서 만든 해당 참가자의 gap config를 모두 불러오기(참가자 ID가 일치해야 시작 가능) → 시작 (240회). 완료 후 JSON 내보내기.

한 참가자에 대해 3 → 5 → 6 순서(1·2·3단계)를 반복하는 것이 본 실험의 단위다. 0단계(1~2번)는 전체 연구에서 한 번만 수행한다.

## 분석 환경 준비 (가상환경)

분석 라이브러리는 `new/.venv` 가상환경에 설치한다. 시스템 파이썬을 건드리지 않으므로 다른 프로젝트와 버전이 충돌하지 않는다.

```bash
cd new
python -m venv .venv                        # 최초 1회만
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

macOS·Linux라면 `.venv/bin/python`. `requirements.txt`는 최소 버전만 지정하고, 실제로 검증한 정확한 버전은 `requirements-lock.txt`에 있다(재현이 필요하면 이쪽을 쓸 것).

**활성화 없이 쓰는 방법** — 셸마다 활성화 명령이 달라 헷갈리므로, 아래 예시는 전부 venv의 파이썬을 직접 지정한다:

```bash
cd new/analysis
PY=../.venv/Scripts/python.exe        # PowerShell: $PY = "..\.venv\Scripts\python.exe"
$PY train_model.py ...
```

활성화하고 쓰려면 PowerShell에서 `.\.venv\Scripts\Activate.ps1`, Git Bash에서 `source .venv/Scripts/activate`.

## 분석 파이프라인

데이터가 모인 뒤 이 순서로 돌린다 (`new/analysis/`에서 실행, `$PY`는 위 참고):

```bash
# 1단계 로그로 모델 학습 (교차검증 + 7.3절 3단 베이스라인 비교까지 출력)
$PY train_model.py ../data/phase1_test01_*.json --out ../config/test01_model.json

# 2단계 평가 — 새 데이터에 모델 적용, McNemar + 대응표본 검정
$PY evaluate_phase2.py ../data/phase2_test01_*.json \
    --model ../config/test01_model.json \
    --phase1 ../data/phase1_test01_*.json \
    --out ../data/phase2_result_test01.json

# 3단계 평가 — A/B/C/D 오프라인 재평가, 간격별 Cochran's Q + 사후 McNemar
$PY evaluate_phase3.py ../data/phase3_test01_*.json \
    --model ../config/test01_model.json \
    --out ../data/phase3_result_test01.json

# 그림
$PY plots.py --phase1 ../data/phase1_test01_*.json \
    --phase3-result ../data/phase3_result_test01.json --outdir ../figures
```

웹앱을 띄우는 `python -m http.server`는 표준 라이브러리만 쓰므로 가상환경이 필요 없다.

### 모듈별 역할

| 파일 | 역할 |
|---|---|
| `error_decomposition.py` | 접근 방향 추정(150ms, 3px 미만 시 250ms 폴백) → e∥/e⊥ 분해 → 버튼 반폭 정규화. `python error_decomposition.py`로 부호 규약 자체 점검 실행 |
| `feature_extraction.py` | 궤적 → 명세서 4.1절 6특징. 멈칫(pause) 분해도 함께 계산. `--` 인자로 단독 실행하면 특징 분포를 출력 |
| `compute_sigma.py` | σ / gap config 산출 (위 4번). 웹앱 계산의 오프라인 재현·검증용 |
| `train_model.py` | 릿지 회귀 + 5-fold CV(20회 반복). e∥/e⊥ 와 화면좌표 Δx/Δy **두 대상 모두** 학습해 비교. 7.3절 3단 베이스라인(보정없음/상수/릿지) 출력 |
| `model_io.py` | 저장된 모델 로드·보정 적용, 최근접 버튼 스냅, 원형 포함 판정 |
| `evaluate_phase2.py` | 1단계 학습 → 2단계 적용. McNemar(성공률) + 대응표본 t 또는 Wilcoxon(오차거리) |
| `evaluate_phase3.py` | A/B/C/D 재평가. 간격별 Cochran's Q → 사후 McNemar + Bonferroni |
| `plots.py` | 간격별 조건 비교, 오차 산점도(부호 검증용), 방향별 편향 벡터, 멈칫 구조 |

### 구현 시 주의한 점 (실데이터에서 확인된 사항)

- **σ 계산**: 워밍업 20회와 무응답 시행만 제외하고 **timeout 시행은 포함**한다(명세서 4.3절). 750ms 제한에서 timeout이 20~56%에 달해, 제외하면 표본이 크게 줄고 느린(신중한) 시행만 빠져 σ가 부풀려진다.
- **예측 대상을 두 가지로 학습한다**: e∥/e⊥ 로 회전하면 화면 좌표계의 고정 편향이 8방향 평균에서 상쇄된다. 1단계 375시행에서 Δy = −1.28px (t=−3.28)의 편향이 회전 후에는 사라졌다. 명세서 2.1절은 그 반대를 전제했으므로, 두 대상을 모두 적합해 비교한다.
- **멈칫 특징은 기본 비활성**: 추가하면 e⊥ 의 교차검증 R²가 −1.7% → −3.2%로 악화됐다(과적합). `--pause-features` 로만 켜진다.
- **게이팅(4.5절) 주의**: 예측 보정량이 1~2px 수준인데 임계값이 반폭의 0.5(=5~7.5px)라, 그대로 적용하면 거의 모든 보정이 무효화된다. 결과 표에서 게이팅 적용/미적용을 함께 보고한다.
- **추론 제약(1.3절)을 코드로 강제**: `feature_extraction.py`의 특징은 궤적·클릭점·버튼 반폭만 쓴다. 목표 버튼 중심 좌표는 라벨 계산에만 사용한다. "목표 대비 오버슛" 같은 지표는 추론 시 계산할 수 없어 특징에서 제외했다.

## 분석 시 권장 절차

1단계 400회처럼 표본이 제한된 상태에서 특징을 여러 개 시험하면 우연히 맞는 것을 고르게 된다. 앞부분(예: 150회)으로만 탐색해 가설을 정하고, 남겨둔 부분으로 한 번만 검증할 것. 실제로 1단계 데이터에서 탐색 단계에 유의했던 가설 3개가 검증셋에서 전부 재현되지 않았다.

## 알려진 제약

- 3단계 격자는 목표 버튼 위치를 기준으로 배치되므로, σ가 큰 참가자 + 큰 이동거리(600px) + 화면 해상도가 작은 환경이 겹치면 격자 일부가 화면 밖으로 나갈 수 있다. 가능하면 큰 해상도에서 실행할 것.
- 브라우저는 다운로드 위치를 코드에서 지정할 수 없다 (보통 다운로드 폴더). 위 단계에서 언급한 `new/config/`, `new/data/`로의 이동은 연구자가 수동으로 해야 한다.
