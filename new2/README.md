---
title: Gijayeon
emoji: 📊
colorFrom: indigo
colorTo: green
sdk: gradio
sdk_version: 5.9.1
python_version: '3.12'
app_file: app.py
pinned: false
short_description: gijayeon
---

<!-- 위 블록은 HF Space 빌드 설정이다 (Space를 만들 때 HF가 넣어 준 값 그대로).
     이 폴더를 Space 루트로 그대로 밀어 넣기 때문에, 지우면 Space가 SDK를 몰라
     빌드가 깨진다. sdk_version 을 올리지 말 것 — gradio 6.26은 launch() 직후
     프로세스가 죽는다(커밋 617b201). GitHub에서는 표로 보이는데 그건 무해하다. -->

# 마우스 보정 실험 — 실행 가이드

`실험앱_계획서_v2(1).md`의 **모드 B(본실험)** 를 실행하는 Gradio 앱 + 분석 스크립트.

> **실험 질문** — 개인별 클릭 편향을 학습해 빼주면 정확도가 오르는가?
> 그 이득은 개인화 때문인가?
>
> **주 지표는 성공률이다.** 데이터를 보기 전에 확정했다(계획서 §6.3). 오차 거리·반복측정
> ANOVA는 보조 지표이며, 성공률이 아니라 오차 거리로 결론을 바꿔 쓰지 않는다.

---

## 실행

```powershell
pip install gradio
cd c:\Lab\gijayoun\new2
python app.py
```

브라우저에서 **http://127.0.0.1:7860** 접속.
점검용 축소 모드(24시행)는 **http://127.0.0.1:7860/?dev=1**.

완료하면 결과가 서버(=앱을 돌리는 이 PC)의 **`new2/data/`** 폴더에 저장된다.

```
data/main_<참가자ID>_<시각>.json
```

같은 참가자를 두 번 돌려도 시각이 달라 덮어쓰지 않는다.
저장 폴더를 바꾸려면 환경변수 `MOUSE_EXP_DATA_DIR`.
환경변수 `HF_TOKEN` 을 주면 HF Dataset repo에도 같이 올라간다(아래 "원격 수집").
로컬 실행만 할 거면 토큰은 필요 없다.

다른 PC의 참가자가 접속하게 하려면 `app.py` 의 `demo.launch(**_LAUNCH_KWARGS)` 에
`server_name="0.0.0.0"` 을 추가하고, 같은 네트워크에서 `http://<이 PC의 IP>:7860` 으로
접속하면 된다. 이때도 저장은 이 PC의 `data/` 에 쌓인다.

---

## 원격 수집 — HF Space + Dataset

한 PC에 8명을 모을 수 있으면 위 로컬 실행이 낫다(계획서 §1). 마우스·화면이 자동으로
통제되는데 이 연구에서는 그게 편의 문제가 아니라 타당도 문제다(§7). 원격이 불가피할
때만 아래를 쓴다.

| | |
|---|---|
| **참가자에게 줄 주소** | **https://yjsimonj-gijayeon.hf.space/** |
| 점검용 축소 모드(24시행) | https://yjsimonj-gijayeon.hf.space/?dev=1 |
| Space 관리 페이지 | https://huggingface.co/spaces/yjsimonj/gijayeon |
| Dataset (private) | https://huggingface.co/datasets/yjsimonj/mouse-exp-data |
| 코드 | https://github.com/yjsimonj/gijayeon → `new2/` |

### 주소 세 개 중 어느 것을 쓰나

| 주소 | 상태 |
|---|---|
| `yjsimonj-gijayeon.hf.space` | ✅ 앱이 직접 서빙된다. **이걸 쓴다** |
| `huggingface.co/spaces/yjsimonj/gijayeon` | 관리·로그용. 앱을 iframe으로 감싼 페이지다 |
| `yjsimonj-gijayeon.static.hf.space` | ❌ **404** |

`.static.hf.space` 는 **Static Space 전용 도메인**이다. 이 Space를 한때 `new2/static` 만
올리는 Static Space로 배포하려 했던 이력이 있어(커밋 `c7e678b`) 그 도메인이 Space
메타데이터에 남아 있는데, 지금 SDK는 `gradio` 라서 그 도메인 뒤에는 서빙할 정적 빌드가
없다. Space 정보에 `stage: READY` 로 보이지만 "예약돼 있다"는 뜻일 뿐이다.

**참가자에게는 `huggingface.co/spaces/...` 가 아니라 `hf.space` 주소를 준다.** 관리
페이지의 iframe은 `allow="... fullscreen ..."` 를 달고 있어 앱이 시작을 막지는 않지만,
그때 전체화면이 되는 것은 브라우저 창이 아니라 iframe이다. 이 연구는 클릭 좌표가
1~2px 단위로 의미를 갖고 뷰포트 기준이 어긋나면 데이터가 조용히 오염되므로(§7),
감싸는 층을 하나 없애는 쪽이 맞다.

**Space 파일시스템은 재시작하면 초기화된다**(§2). Space는 놀리면 자고, 코드를 고치면
재빌드되고, 가끔 알아서 재시작한다. 그래서 원격 수집에서는 `data/` 를 믿을 수 없고
Dataset repo가 실제 저장소다. `app.py` 는 **양쪽에 다 쓴다** — 로컬 `data/` 와 Dataset.

### 준비 (한 번만)

Space → Settings → Variables and secrets:

| 이름 | 값 | 종류 |
|---|---|---|
| `HF_TOKEN` | **write** 권한 토큰 | secret |
| `HF_DATASET_REPO` | `yjsimonj/mouse-exp-data` | (생략 가능 — 기본값) |

`HF_TOKEN` 이 없으면 업로드만 건너뛰고 실험은 정상 동작한다. 다만 Space에서 토큰이
없으면 완료 화면이 **"재시작하면 이 파일은 사라집니다"** 라고 경고한다 — 그 문구가
보이면 secret이 안 걸린 것이니 세션을 더 돌리기 전에 고쳐야 한다.

### 하드웨어: ZeroGPU 에 맞춰 두었다

이 Space는 **ZeroGPU(`zero-a10g`)** 로 설정돼 있다. 이 앱은 서버에서 계산을 안 하니
계획서 §0대로면 CPU Basic 이 맞지만, 하드웨어를 바꿀 수 없어 코드가 ZeroGPU 조건을
맞춘다.

ZeroGPU 런타임은 앱이 `launch()` 하는 순간 **`@spaces.GPU` 로 데코레이트된 함수가
하나라도 등록됐는지** 보고, 없으면 프로세스를 끊는다:

```
로컬 저장 폴더: /home/user/app/data
* Running on local URL:  http://0.0.0.0:7860
Stopping Node.js server...          ← 여기서 끝난다
```

`errorMessage: No @spaces.GPU function detected during startup`, `stage: RUNTIME_ERROR`.
로그만 보면 정상 기동한 뒤 조용히 멈춘 것처럼 읽혀 코드를 의심하게 되는데, 코드가
아니라 **등록된 GPU 함수가 없다**는 뜻이다.

그래서 `app.py` 에 호출하지 않는 자리표시자 하나를 둔다:

```python
@spaces.GPU
def _zerogpu_placeholder():
    return None
```

- **지우면 Space가 다시 죽는다.** 어디에도 연결하지 않았고 부르지도 않으므로 GPU가
  실제로 할당되는 일은 없다.
- **`spaces` 를 `requirements.txt` 에 적으면 빌드가 깨진다.** ZeroGPU Space는 빌드할 때
  pip 명령에 `spaces==0.51.1` 을 직접 붙인다(빌드 로그에서 확인):

  ```
  pip install -r /tmp/requirements.txt "torch<=2.11.0" gradio[oauth]==5.9.1 ... spaces==0.51.1
  ```

  여기에 `spaces>=0.51.3` 을 얹으면 그 핀과 충돌해 pip이 죽는다 — 실제로 `BUILD_ERROR`
  를 한 번 냈다. 플랫폼이 깔아 준 것을 그냥 쓴다. `torch` 도 플랫폼이 같이 깔지만
  우리 코드는 요구하지 않는다 (`spaces` 는 torch 없이도 동작한다 —
  `spaces/zero/torch/__init__.py` 가 `import torch` 를 try 로 감싸 두어 전부 no-op 이
  되고 시작 보고는 그대로 나간다).
- 나중에 하드웨어를 CPU basic 으로 바꿔도 **그대로 두면 된다.** ZeroGPU가 아닌 곳에서는
  `spaces.GPU` 가 함수를 그대로 돌려주고 아무것도 등록하지 않는다. `spaces` 자체가
  없으면(로컬 실행) `app.py` 가 `ImportError` 를 받아 건너뛴다.

### 코드 밀어 넣기

Space는 `new2/` 를 **루트로** 받는다(`app.py` 가 최상단에 와야 한다). 그래서
subtree로 민다:

```powershell
cd c:\Lab\gijayoun
git push origin master                          # GitHub (저장소 전체)
git subtree push --prefix=new2 space main        # HF Space (new2/ 만)
```

`README.md` 맨 위 YAML 블록이 Space 빌드 설정이다. **지우지 말 것** — 지우면 Space가
SDK를 몰라 빌드가 깨진다. `sdk_version: 5.9.1` 도 올리지 말 것(gradio 6.26은 launch()
직후 프로세스가 죽는다).

### 결과 받기

```powershell
huggingface-cli download yjsimonj/mouse-exp-data --repo-type dataset --local-dir ..\data_hf
cd analysis
python analyze.py ..\..\data_hf\raw --figures ..\figures
```

> **Dataset repo는 private으로 유지할 것.** 원본 JSON에 학번·이름이 들어 있다(§5).

---

## 실험 순서

**1. 버튼 크기 확인 (본인, 1분)**

`?dev=1` 로 24회 완주 → 완료 화면의 성공률을 본다. **기본값 20px** 이다.

| 성공률 | 조치 |
|---|---|
| 50~80% | **그대로 쓴다** (가장 좋은 구간) |
| 80~90% | 그대로 써도 되고, 한 단계 낮춰도 된다 |
| 90% 이상 | 16px → 12px 로 낮춤 |
| 40% 이하 | 24px 로 올림 |

**σ(클릭잡음)를 알 필요가 없다.** 2D 등방 오차에서 성공률이 반지름/σ 비를 결정하므로,
검정력을 관측 성공률의 함수로 쓸 수 있다. 평가 시행 1600회(8명 × 200), McNemar +
Bonferroni, α=.05 로 계산한 결과 — 편향/σ 비는 모르니 세 값으로 훑었다:

| 관측 성공률 | b/σ=0.15 | b/σ=0.25 | b/σ=0.40 |
|---|---|---|---|
| 40% | 32% | 70% | 98% |
| **60%** | **37%** | **77%** | **99%** |
| 80% | 33% | 71% | 98% |
| 90% | 25% | 56% | 91% |
| 95% | 18% | 39% | 73% |
| 98% | 11% | 23% | 45% |

비가 무엇이든 **50~80% 구간에서 검정력이 가장 높고 평평하다.** 95% 이상에서 급락하고
(버튼이 오차보다 훨씬 커서 보정해도 승패가 안 바뀐다), 30% 이하도 나쁘다(버튼이
오차보다 작아 보정해도 어차피 빗나간다).

> **주의 — 이 연구가 충분한 검정력을 가질지는 아직 모른다.** 위 표의 세로축이 그
> 이야기다. 개인 편향이 클릭잡음의 15% 정도면 8명·1600시행으로는 검정력 37%가
> 최대다. 그 비가 얼마인지는 아무 데이터도 알려주지 않는다 — **본인 600회 완주
> (아래 2단계) 후 `analyze.py` 의 [3]절**(참가자 간 SD vs 참가자 내 SE)이 처음으로
> 그 단서를 준다. 거기서 SD가 SE보다 크지 않으면 8명을 모아도 결론이 안 나온다.

**정한 값은 참가자 전원에게 같이 쓴다.**

**2. 본인이 먼저 600회 완주 (계획서 §8-6, 건너뛰지 말 것)**

참가자 8명을 모아놓고 버그를 발견하면 되돌릴 수 없다. `data/` 에 파일이 남고
아래 분석이 그대로 도는지 확인한다.

**3. 참가자 8명 × 약 25분**

- 화면에서 학번·이름·참가자 ID(`P01`~`P08`)·버튼 크기 입력 → 전체화면으로 시작
- 워밍업 20 + 본시행 600. **앞 400 = 학습, 뒤 200 = 평가** (참가자에게 알리지 않고
  화면상 구분도 없다). 100회마다 휴식이 뜨고 참가자가 직접 재개한다.
- **반드시 한 세션에.** test01에서 1단계와 2단계 사이에 성공률이 73%→65%로 떨어졌다
  (세션 간 컨디션 차이). 나눠 하면 그대로 재현된다.
- 통제(계획서 §7): 마우스 가속(포인터 정밀도 향상) 끄기 · 확대율 100%(Ctrl+0) ·
  **트랙패드 금지** · 가능하면 8명 전원 같은 PC·같은 마우스

**4. 분석**

```powershell
cd c:\Lab\gijayoun\new2\analysis
python analyze.py ..\data --out ..\data\result.json --figures ..\figures
```

| 절 | 내용 |
|---|---|
| [1] | **부호 규약 자체 점검** — 본인 벡터를 빼면 학습 구간 평균 오차가 줄어야 한다 |
| [2] | 참가자별 편향 벡터, 남의 편향 벡터, timeout·무응답 수 |
| [3] | 편향의 개인차가 실재하는가 — 참가자 간 SD vs 추정오차 SE, 일원배치 ANOVA |
| [4] | 세 조건 성공률·평균 오차 — **A** 보정 없음 / **B** 남의 편향 / **C** 본인 편향 |
| [5] | **주 검정** Cochran's Q → 사후 McNemar 정확검정 + Bonferroni |
| [6] | 보조 — 오차 거리 대응표본(t/Wilcoxon, Cohen's d), 반복측정 ANOVA |
| [7] | 계획서 §6.4 판정 |

결론은 세 갈래 모두 결론이다. **C ≈ A(❌)도 보고 가치가 있다** — 연구계획서 1장의
전제가 틀렸다는 뜻이니까.

분석 라이브러리는 `analysis/requirements.txt` (numpy, scipy, matplotlib).

---

## 폴더

```
new2/
├─ app.py                  Gradio 앱 — 화면을 얹고 결과를 data/ + Dataset repo 에 저장
├─ requirements.txt        gradio, huggingface_hub
├─ static/                 실험 화면 (로직 전부 여기 있다)
│  ├─ experiment.html        마크업 (설정 → 진행 → 완료, 세 화면)
│  ├─ experiment.css
│  └─ experiment.js          시행 루프·궤적·전체화면·기록·전달
├─ data/                   결과 JSON (앱이 만든다)
├─ analysis/
│  ├─ analyze.py             §6 분석: 편향 벡터 → A/B/C → Cochran Q → McNemar
│  ├─ make_dummy.py          더미 데이터 생성 (분석을 미리 돌려보기, §8-3)
│  └─ requirements.txt
└─ tools/                  자체 점검
   ├─ selftest.mjs           시퀀스·기하·스키마 정합 (node, 의존성 없음)
   ├─ test_app_save.py       app.py 의 save() (gradio 없이)
   └─ e2e-jsdom.mjs          가상 마우스로 620시행 무인 완주 (jsdom 필요, 선택)
```

## 실험 전 자체 점검

```powershell
cd c:\Lab\gijayoun\new2
node tools/selftest.mjs          # 76개 — 시퀀스·기하·스키마·CSS 정합
python tools/test_app_save.py    # 41개 — 저장·업로드·ZeroGPU·오류 처리
```

`selftest.mjs` 는 **experiment.js / make_dummy.py / analyze.py 세 파일의 시행 레코드
키가 일치하는지** 본다 — 한쪽만 고치면 실험을 다 하고 나서 분석이 안 도는 사고가 난다.

글자색을 요소별로 못박아 뒀는지도 본다. Gradio 다크 테마는 `h1`·`p`·`label` 같은 맨
요소에 `color` 를 직접 걸고, CSS 상속은 어떤 직접 규칙에도 지므로 `#mx-app` 에 색을
한 번 주는 것으로는 자손 글자색이 정해지지 않는다 — 흰 패널에 흰 글씨가 되어 설정
화면을 읽을 수 없었다. 색 규칙을 걷어내면 이 검사가 잡는다.

분석을 미리 돌려보려면(계획서 §8-3):

```powershell
cd analysis
python make_dummy.py --out ..\data_dummy          # 8명, 개인차 있음
python analyze.py ..\data_dummy                   # → "C > A 그리고 C > B" 가 나와야 정상
python make_dummy.py --out ..\data_dummy_flat --individual-sd 0
python analyze.py ..\data_dummy_flat              # 개인차가 없을 때의 갈래도 확인
```

DOM 단위로 실제 클릭까지 흉내내 완주시켜 보려면(선택):

```powershell
npm install jsdom
$env:JSDOM_PATH = "<...>\node_modules\jsdom"
node tools/e2e-jsdom.mjs            # 축소 24시행 + 무응답 + 전체화면 이탈
node tools/e2e-jsdom.mjs --full     # 620시행 완주 (약 3분)
node tools/e2e-jsdom.mjs --abort    # 중단하고 저장
```

---

## 계획서에서 조정한 것

### 1. 방향·거리·시작위치를 시행마다 무작위로 뽑는다 (§4.1·§4.3 교체)

계획서 §4.1은 거리 450px 고정 · 4방향(↑↓←→) 고정이었다. 그러면 시작점도 방향마다
하나로 정해져 **목표가 화면상 4곳에만 나온다.** 그게 문제다: 학습 400회와 평가
200회가 같은 4개 지점을 쓰므로, "이 사람의 편향"과 "그 4개 지점의 특성"을 갈라낼
방법이 설계 안에 없다. 400/200 분할은 시간 흐름과 추정 잡음은 통제하지만 위치
특이성은 통제하지 못한다.

그래서 시행마다 방향(원 전체)·거리(250~500px)·시작점(가능 영역 안)을 층화 무작위로
뽑는다. 벡터를 여러 위치에서 추정해 **한 번도 쓰지 않은 위치**에 적용하게 된다.

**검정력은 손해를 보지 않는다.** §6이 추정하는 것은 학습 시행 전체를 평균한 전역
벡터 하나(파라미터 2개)이고, 그 표준오차는 σ/√400 으로 **칸 구조와 무관하다.** 칸당
시행 수가 문제가 되는 것은 칸별로 따로 적합할 때뿐이다. 시뮬레이션(8명 × 400/200,
20px, McNemar+Bonferroni, 300회 반복):

| 설계 | C>A | C>A 그리고 C>B |
|---|---|---|
| 고정: 4방향 · 450px · 위치 4곳 | 88.7% | 77.0% |
| **무작위: 방향·거리·위치** | **90.7~93.0%** | **79.7~87.3%** |

오히려 조금 오른다 — 짧은 거리가 섞이면 σ가 작아져 버튼 크기 대비 민감한 구간에 더
자주 들어가기 때문이다.

**층화하는 이유:** 완전 무작위면 앞 400과 뒤 200의 방향·거리 구성이 우연히 어긋날 수
있고, §6은 학습 벡터를 평가 시행에 그대로 적용하므로 그 경우 "개인 편향"이 아니라
"구성 차이"를 재게 된다. 블록마다 원과 거리 범위를 균등 분할해 뽑으면 그 위험만
사라지고 무작위성은 남는다.

**덤으로 얻는 것:** 편향이 화면 좌표 고정 오프셋인지 이동 방향에 딸린 것인지는 아직
모른다. 방향을 몇 개로 고정하는 것은 전자라는 검증 안 된 가정을 코드에 박는 일이다
(방향을 균등하게 깔면 화면 좌표계에서 방향 의존 성분은 상쇄된다). 방향·거리를 시행
마다 기록해 두면 어느 쪽인지는 나중에 데이터가 답한다.

스키마 변화: 시행에 `distance_px` 가 생기고 `start_shifted` 가 사라졌다(시작점이
설계상 무작위이므로 "밀렸는지"가 의미를 잃는다). `config.distance_px` →
`config.distance_range_px`, `config.directions_deg` → `config.geometry_sampling`.

### 2. 스키마에 `main_index` 를 추가했다

§5의 `index` 만으로는 "앞 400 / 뒤 200"을 자를 기준이 애매하다(워밍업 20회가 앞에
있으므로). `index` 는 세션 전체 순번, `main_index` 는 본시행 내 순번(워밍업은 `null`).
분석은 `main_index < config.train_split` 으로 학습 구간을 정한다.

### 3. 방향 규약을 §5 예시에 맞췄다

§5 예시가 `direction_deg: 90` 에서 `target.y(200) < start.y(650)` 이므로 **90°는 위**다
(`dy = −sin θ`). 화면 y축은 아래로 증가하므로 이 부호를 놓치면 위아래가 뒤집힌다.
`config.direction_convention` 에 문자열로도 박아 둔다.

### 4. 모드 A(버튼 크기 예비실험)를 빼고 크기를 화면에서 입력받는다

크기 1종을 정하는 것이 목적이므로, 로지스틱 회귀로 65% 지점을 역산하는 절차 대신
`?dev=1` 24회로 성공률을 보고 고른다(위 "실험 순서 1"). 참가자 전원 같은 값을 쓰는
것만 지키면 §6의 비교는 성립한다.

### 5. 학번·이름 칸

개인정보라 **원본 JSON에만** 기록되고 파일명·분석 결과에는 들어가지 않는다.
분석·파일명은 계획서대로 가명(`P01`)인 `participant_id` 를 쓴다.

### 6. 전체화면 이탈 시 해당 시행을 버린다

이탈·재진입 사이에 뷰포트가 바뀌면 이미 계산한 좌표가 낡은 값이 된다. 반쯤 진행된
시행을 이어받는 대신 버리고 같은 조건으로 다시 제시한다(`session_events` 에 기록).
같은 화면에서 "중단하고 저장"도 가능하다 — 여기까지의 시행은 그대로 저장된다.
앱이 iframe 안에 얹혀 전체화면이 불가능하면(`document.fullscreenEnabled === false`)
시작 자체를 막는다 — 주소창 높이가 좌표에 섞이면 데이터가 조용히 오염된다(§7).

### 7. 궤적 샘플링은 mousemove + requestAnimationFrame

§4.3은 "mousemove를 전부 기록"이라고 적었지만, mousemove로 최신 좌표를 갱신하고
프레임마다 한 점씩 쌓는다. 사람은 목표에 커서를 세운 뒤 클릭하며 그 정지가 80~100ms
이어지는데(test01 관측), 이벤트만 받으면 그 구간이 빈다. 실측 간격 중앙값 8ms(125Hz),
시행당 약 75샘플로 §3.5의 용량 추정과 맞는다. 각 시행에 실제 간격 중앙값이 남는다.

### 8. 궤적은 이번 분석에 쓰지 않는다 (§4.3)

그래도 `[[t, x, y], ...]` 숫자 배열로 기록은 남긴다 — 보고서에 "궤적 기반 예측도
시도했으나 설명력이 3%였다"(`new/` 의 test01 결과)를 쓸 재료이자 나중에 다시 볼
여지다. 좌표는 소수점 첫째 자리로 반올림해 620시행 약 1MB다.

### 10. 저장 실패해도 세션은 건진다 (§3.4)

`data/` 쓰기가 실패하면 완료 화면이 이유를 그대로 보여주고, "JSON 직접 받기" 버튼으로
브라우저에서 파일을 받을 수 있다. 25분짜리 세션을 다시 부를 수는 없다.
