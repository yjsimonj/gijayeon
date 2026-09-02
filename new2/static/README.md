---
title: Gijayeon
emoji: 📊
colorFrom: indigo
colorTo: green
sdk: static
pinned: false
short_description: 마우스 보정 실험
---

# 마우스 보정 실험 v3

이 폴더가 HF Static Space의 루트로 배포된다 (`index.html`, `experiment.html/.css/.js`).

- 실험 로직은 전부 브라우저 JS다. 서버가 필요 없다.
- **참가자에게는 반드시 앱 직접 주소를 주세요**: `https://yjsimonj-gijayeon.static.hf.space/`
  Space 페이지(huggingface.co/spaces/...)는 앱을 iframe에 넣어 전체화면이 막힐 수 있고,
  그러면 시작 화면이 "전체화면 사용 가능: 아니오"로 시작을 막는다.
- 점검용 축소 모드: 주소 뒤에 `?dev=1` (24시행)
- 완료 화면에서 **JSON 다운로드** 버튼으로 데이터를 받아 연구자에게 전달한다.
  (서버 자동 저장은 Gradio Space가 PRO 전용이라 이 배포본에는 없다. 되돌리려면
   상위 폴더 `app.py` 를 쓰는 Gradio 배포로 전환하면 된다.)

전체 실행 순서·분석은 저장소의 `new2/README.md` 참고.
