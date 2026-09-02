/* =====================================================================
 * 마우스 보정 실험 v3 — 실험 로직 전부
 *
 * 계획서: new2/실험앱_계획서_v2(1).md  (이하 "계획서 §x")
 *
 * 실험 질문: 개인별 클릭 편향을 학습해 빼주면 정확도가 오르는가?
 *            그 이득은 개인화 때문인가?
 *
 * 이 파일은 서버와 무관하게 혼자 돌아간다. Gradio(§3)는 저장 담당일 뿐이고,
 * Gradio 컴포넌트가 없으면(로컬 실행 = A안) 조용히 다운로드 전용으로 동작한다.
 *
 * 목차
 *   0. 상수 / 상태
 *   1. 유틸리티
 *   2. 환경 점검 (§7)
 *   3. 시행 스펙 생성 (§4.1, §4.2)
 *   4. 배치 계산 (시작 버튼·목표 좌표)
 *   5. 한 시행 실행 (§4.3)
 *   6. 세션 실행 — 휴식 / 전체화면 이탈
 *   7. 완료 — 요약 · 제출(§3.3) · 백업 · 다운로드(§3.4)
 *   8. 모드 A 집계 (§4.2)
 *   9. UI 바인딩 / mount
 *
 * 좌표는 전부 뷰포트 기준 CSS px (event.clientX/clientY 와 같은 공간).
 * 부호 규약(§5): error_x = click.x − target.x, error_y = click.y − target.y.
 *                보정은 "빼는" 것 → 보정좌표 = 클릭좌표 − 편향벡터.
 * 방향 규약: 0°=오른쪽, 90°=위, 180°=왼쪽, 270°=아래.
 *            (계획서 §5 예시가 direction_deg 90 에서 target.y 200 < start.y 650,
 *             즉 y가 줄어드는 "위"이므로 dy = −sin θ 다. 화면 y축은 아래로 증가.)
 * ===================================================================== */

(function () {
  'use strict';

  /* ---------------------- 0. 상수 / 상태 ---------------------- */

  const params = new URLSearchParams(location.search);
  const DEV_MODE = params.get('dev') === '1';

  const SCHEMA_VERSION = '3.0';

  // §4.1 고정 조건
  const DISTANCE_PX = 450;
  const DIRECTIONS_DEG = [0, 90, 180, 270];
  const TIME_LIMIT_MS = 750;        // 초과 시 timeout 플래그만. 시행은 유지(§4.3)
  const RESPONSE_CAP_MS = 3000;     // 이때까지 무클릭이면 no_response
  const INTER_TRIAL_BLANK_MS = 200;
  const START_BUTTON_SIZE_PX = 30;
  const DEFAULT_BUTTON_SIZE_PX = 12;

  // §4.2 모드 A 후보 크기 / 목표 성공률
  const CANDIDATE_SIZES_PX = [8, 12, 16, 24, 32];
  const SIZING_TARGET_SUCCESS = 0.65;

  // 실행 세부
  const DRAG_THRESHOLD_PX = 50;     // mousedown~mouseup 이 이보다 멀면 드래그 → 폐기하고 계속 대기
  const EDGE_PADDING_PX = 8;
  const TOP_CLEARANCE_PX = 14;      // 시간바(5px) + 여유
  const BACKUP_KEEP = 6;            // localStorage 백업 보관 개수

  // §8-2: 축소 모드. 없으면 점검할 때마다 600번 클릭하게 된다.
  const COUNTS = DEV_MODE
    ? { warmupMain: 4, main: 20, trainSplit: 12, restEvery: 10, warmupSizing: 2, sizingPerSize: 2 }
    : { warmupMain: 20, main: 600, trainSplit: 400, restEvery: 100, warmupSizing: 10, sizingPerSize: 20 };

  // §7 자동 점검 기준
  const MIN_INNER_W = 1200;
  const MIN_INNER_H = 800;
  const ZOOM_OK_MIN = 0.94;
  const ZOOM_OK_MAX = 1.06;

  const MODE_LABEL = { main: '모드 B — 본실험', sizing: '모드 A — 버튼 크기 정하기' };

  const S = {
    participantId: null,
    mode: 'main',
    buttonSizePx: DEFAULT_BUTTON_SIZE_PX,
    inputDevice: 'mouse',
    zoomEstimate: null,
    startedAt: null,
    trials: [],
    events: [],          // 휴식·전체화면 이탈 등 세션 사건 기록
    abortRequested: false,
    lastPayload: null,   // 완료 화면의 다운로드 버튼이 쓰는 내보내기 객체
    lastFilename: null,
    lastAggregate: null,
  };

  /* ---------------------- 1. 유틸리티 ---------------------- */

  const $ = (id) => document.getElementById(id);
  const nowPerf = () => performance.now();
  const r1 = (v) => Math.round(v * 10) / 10;   // §3.5 좌표는 소수점 첫째 자리
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  function randomInt(maxExclusive) {
    return Math.floor(Math.random() * maxExclusive);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** values를 total개로 균등 배분한 뒤 순서를 섞는다. 나머지는 무작위 value에 +1. */
  function balanced(values, total) {
    const base = Math.floor(total / values.length);
    const rest = total - base * values.length;
    const bonus = new Set(shuffle(values.map((_, i) => i)).slice(0, rest));
    const out = [];
    values.forEach((v, i) => {
      const n = base + (bonus.has(i) ? 1 : 0);
      for (let k = 0; k < n; k++) out.push(v);
    });
    return shuffle(out);
  }

  function median(xs) {
    if (xs.length === 0) return null;
    const a = xs.slice().sort((p, q) => p - q);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function sanitizeId(raw) {
    return String(raw).replace(/[^A-Za-z0-9_-]/g, '');
  }

  function logEvent(type, detail) {
    S.events.push({ at: new Date().toISOString(), type, detail: detail || null });
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(reader.result)); }
        catch (e) { reject(new Error(file.name + ' — JSON 파싱 실패: ' + e.message)); }
      };
      reader.onerror = () => reject(new Error(file.name + ' — 파일 읽기 실패'));
      reader.readAsText(file, 'utf-8');
    });
  }

  /* ---------------------- 2. 환경 점검 (§7) ---------------------- */

  /**
   * 확대율은 전체화면 진입 전에만 추정할 수 있다.
   * 창 모드에서는 outerWidth(창 프레임) / innerWidth(뷰포트) ≈ 확대율이지만,
   * 전체화면에서는 둘이 같은 CSS px로 보고되어 항상 1이 나온다 — 그래서 설정
   * 화면에서 재고, 그 값을 environment에 기록한다.
   */
  /** HF Space 페이지처럼 앱이 다른 문서의 iframe 안에 얹혀 있는가. */
  function isFramed() {
    try { return window.self !== window.top; }
    catch (e) { return true; }   // 접근이 막히면 그것 자체가 다른 출처의 iframe이라는 뜻
  }

  function estimateZoom() {
    if (document.fullscreenElement) return null;
    if (!window.outerWidth || !window.innerWidth) return null;
    return window.outerWidth / window.innerWidth;
  }

  function envChecks() {
    const zoom = estimateZoom();
    if (zoom !== null) S.zoomEstimate = zoom;

    // 전체화면에서의 뷰포트는 대체로 screen.availWidth/Height 에 가깝다.
    // 여기서는 "예상"만 보여주고, 실제 차단은 전체화면 진입 직후에 한다.
    const predW = document.fullscreenElement ? window.innerWidth : (window.screen.availWidth || window.innerWidth);
    const predH = document.fullscreenElement ? window.innerHeight : (window.screen.availHeight || window.innerHeight);

    const rows = [];
    rows.push({
      name: '창 크기 (전체화면 예상)',
      value: `${predW} × ${predH}`,
      rule: `≥ ${MIN_INNER_W} × ${MIN_INNER_H}`,
      ok: predW >= MIN_INNER_W && predH >= MIN_INNER_H,
      blocking: false, // 실제 차단은 전체화면 진입 후 실측으로
    });
    rows.push({
      name: '확대율 (추정)',
      value: S.zoomEstimate === null ? '측정 불가' : (S.zoomEstimate * 100).toFixed(0) + '%',
      rule: '100% (Ctrl+0)',
      ok: S.zoomEstimate === null ? false : (S.zoomEstimate >= ZOOM_OK_MIN && S.zoomEstimate <= ZOOM_OK_MAX),
      blocking: true,
    });
    rows.push({
      name: '입력 장치',
      value: S.inputDevice === 'mouse' ? '마우스' : '트랙패드',
      rule: '마우스',
      ok: S.inputDevice === 'mouse',
      blocking: false, // 경고 + 확인 체크박스로 처리
    });
    // HF Space 페이지처럼 앱이 iframe에 얹히면 전체화면이 막힐 수 있다. 그러면 주소창
    // 높이가 좌표에 섞여(§7) 데이터가 조용히 오염되므로, 추측하지 않고 브라우저가
    // 알려주는 fullscreenEnabled 로 직접 확인해 막는다.
    rows.push({
      name: '전체화면 사용 가능',
      value: document.fullscreenEnabled ? '예' : (isFramed() ? '아니오 (iframe 제한)' : '아니오'),
      rule: '가능해야 함',
      ok: !!document.fullscreenEnabled,
      blocking: true,
    });
    return rows;
  }

  function renderEnvTable() {
    const rows = envChecks();
    const body = $('mx-env-body');
    body.innerHTML = rows.map((r) => (
      `<tr><td>${r.name}</td><td>${r.value}</td><td>${r.rule}</td>` +
      `<td class="${r.ok ? 'mx-ok' : ''}">${r.ok ? '통과' : '미달'}</td></tr>`
    )).join('');
    return rows;
  }

  /** 전체화면 진입 후 실측 검사. 통과 못 하면 시작을 막는다 (§7). */
  function fullscreenViewportOk() {
    const w = window.innerWidth, h = window.innerHeight;
    if (w >= MIN_INNER_W && h >= MIN_INNER_H) return null;
    return `전체화면 뷰포트가 ${w}×${h} 입니다. 기준은 ${MIN_INNER_W}×${MIN_INNER_H} 이상입니다.\n` +
           `Windows 디스플레이 배율을 낮추거나 더 큰 화면에서 실행하세요.`;
  }

  /* ---------------------- 3. 시행 스펙 생성 ---------------------- */

  /**
   * 본실험(모드 B): 워밍업 20 + 본시행 600.
   *
   * 방향은 100회 블록마다 4방향을 25회씩 균등 배분한 뒤 블록 안에서만 섞는다.
   * 600회를 통째로 섞으면 앞 400(학습)과 뒤 200(평가)의 방향 구성이 우연히
   * 달라질 수 있다. §6은 학습 벡터를 평가 시행에 그대로 적용하므로, 두 구간의
   * 방향 구성이 어긋나면 "개인 편향"이 아니라 "방향 구성 차이"를 재게 된다.
   * 블록 단위 균등이면 어디서 잘라도 방향이 맞고, 피로 효과도 방향에 고르게 퍼진다.
   */
  function buildMainSpecs(buttonSizePx) {
    const specs = [];

    balanced(DIRECTIONS_DEG, COUNTS.warmupMain).forEach((deg) => {
      specs.push({ size: buttonSizePx, direction: deg, warmup: true, mainIndex: null, block: null });
    });

    const blockSize = COUNTS.main % COUNTS.restEvery === 0 ? COUNTS.restEvery : COUNTS.main;
    const nBlocks = Math.round(COUNTS.main / blockSize);
    let mainIndex = 0;
    for (let b = 0; b < nBlocks; b++) {
      balanced(DIRECTIONS_DEG, blockSize).forEach((deg) => {
        specs.push({ size: buttonSizePx, direction: deg, warmup: false, mainIndex: mainIndex++, block: b });
      });
    }

    // 참가자에게 알리지 않는다: 화면상 학습/평가 구분은 없다 (§4.2).
    // pauseBefore 는 워밍업 종료와 100회 휴식에만 붙는다.
    specs.forEach((sp) => {
      if (sp.warmup) return;
      if (sp.mainIndex === 0) sp.pauseBefore = 'warmup-end';
      else if (sp.mainIndex % COUNTS.restEvery === 0) sp.pauseBefore = 'rest';
    });
    return specs;
  }

  /** 모드 A: 워밍업 10 + 본시행 100 (후보 5종 × 20회, 무작위 순서). */
  function buildSizingSpecs() {
    const specs = [];
    const warmSizes = balanced(CANDIDATE_SIZES_PX, COUNTS.warmupSizing);
    const warmDirs = balanced(DIRECTIONS_DEG, COUNTS.warmupSizing);
    warmSizes.forEach((size, i) => {
      specs.push({ size, direction: warmDirs[i], warmup: true, mainIndex: null, block: null });
    });

    const total = CANDIDATE_SIZES_PX.length * COUNTS.sizingPerSize;
    const sizes = balanced(CANDIDATE_SIZES_PX, total);
    const dirs = balanced(DIRECTIONS_DEG, total);
    for (let i = 0; i < total; i++) {
      specs.push({ size: sizes[i], direction: dirs[i], warmup: false, mainIndex: i, block: 0 });
      if (i === 0) specs[specs.length - 1].pauseBefore = 'warmup-end';
      else if (i % COUNTS.restEvery === 0) specs[specs.length - 1].pauseBefore = 'rest';
    }
    return specs;
  }

  function buildSpecs() {
    return S.mode === 'sizing' ? buildSizingSpecs() : buildMainSpecs(S.buttonSizePx);
  }

  /* ---------------------- 4. 배치 계산 ---------------------- */

  /**
   * 시작 버튼은 화면 중앙(§4.3)이 기본이지만, 그대로 두면 세로 방향 시행이
   * 화면을 벗어난다: 900px 높이에서 중앙 450 − 450 = 0, 800px 높이면 −50 이다.
   * 거리 450px 고정과 4방향은 분석의 뼈대라 건드릴 수 없으므로, 대신 시작 버튼을
   * 해당 축으로 필요한 최소량만 민다(1440×900에서 ±14px). 밀렸는지는
   * start_shifted 로 기록한다.
   * 배치가 아예 불가능하면 null.
   */
  function computeLayout(sizePx, directionDeg, vw, vh) {
    const rad = (directionDeg * Math.PI) / 180;
    const vx = Math.cos(rad) * DISTANCE_PX;
    const vy = -Math.sin(rad) * DISTANCE_PX;   // 90° = 위

    const sr = START_BUTTON_SIZE_PX / 2;
    const tr = sizePx / 2;

    // 시작 버튼이 놓일 수 있는 범위 = (시작 버튼이 화면 안) ∩ (목표도 화면 안)
    const xMin = Math.max(sr, tr - vx) + EDGE_PADDING_PX;
    const xMax = vw - Math.max(sr, tr + vx) - EDGE_PADDING_PX;
    const yMin = TOP_CLEARANCE_PX + Math.max(sr, tr - vy);
    const yMax = vh - Math.max(sr, tr + vy) - EDGE_PADDING_PX;
    if (xMin > xMax || yMin > yMax) return null;

    const wantX = vw / 2;
    const wantY = (TOP_CLEARANCE_PX + vh) / 2;
    const startX = clamp(wantX, xMin, xMax);
    const startY = clamp(wantY, yMin, yMax);

    return {
      startX, startY,
      targetX: startX + vx,
      targetY: startY + vy,
      shifted: Math.abs(startX - wantX) > 0.5 || Math.abs(startY - wantY) > 0.5,
    };
  }

  /** 시작 전에 모든 시행이 실제로 표시 가능한지 확인한다. */
  function allTrialsFit(specs) {
    const bad = specs.filter((sp) => computeLayout(sp.size, sp.direction, window.innerWidth, window.innerHeight) === null);
    if (bad.length === 0) return null;
    return `화면이 너무 작아 ${bad.length}개 시행을 표시할 수 없습니다 ` +
           `(뷰포트 ${window.innerWidth}×${window.innerHeight}, 이동거리 ${DISTANCE_PX}px).`;
  }

  /* ---------------------- 5. 한 시행 실행 (§4.3) ---------------------- */

  /**
   * 1. 화면 중앙에 시작 버튼(30px) → 2. 클릭(커서 시작 위치 확정)
   * 3. 450px 떨어진 4방향 중 하나에 목표 등장(t0) → 4. 이동·클릭
   * 5. 기록 → 6. 200ms 공백
   *
   * resolve({ record })            정상 종료 (무응답 포함)
   * resolve({ aborted: true })     전체화면 이탈 등으로 이 시행을 버림 → 재제시
   */
  function runTrial(spec, trialIndex) {
    return new Promise((resolve) => {
      const stage = $('mx-stage');
      stage.innerHTML = '';

      // 모든 좌표는 클릭 이벤트(clientX/clientY)와 같은 뷰포트 기준으로 계산하고,
      // 렌더링할 때만 stageRect를 빼서 stage 로컬 좌표로 바꾼다. 이 변환을 빼먹으면
      // 기록된 목표 중심과 클릭 좌표가 어긋나 맞은 클릭도 전부 미스로 남는다.
      const stageRect = stage.getBoundingClientRect();
      const layout = computeLayout(spec.size, spec.direction, window.innerWidth, window.innerHeight);

      // 시작 전에 allTrialsFit()으로 전부 확인했으므로 여기서 null이 나오는 경우는
      // 세션 도중에 뷰포트가 줄어든 것(전체화면 해제·해상도 변경)뿐이다. 그냥
      // 진행하면 좌표가 화면 밖으로 나가 "실패한 클릭"으로 조용히 오염되므로,
      // 시행을 버리고 화면을 되돌리라고 안내한다.
      if (!layout) {
        logEvent('layout_infeasible', {
          trial_index: trialIndex, size: spec.size, direction: spec.direction,
          inner_width: window.innerWidth, inner_height: window.innerHeight,
        });
        showFullscreenLost(() => resolve({ aborted: true }));
        return;
      }

      let phase = 'await-start';      // 'await-start' | 'await-click' | 'done'
      let trajectory = [];
      let latest = null;
      let pendingDown = null;
      let dragRejected = 0;
      let softFired = false;
      let finished = false;
      let paused = false;

      let tStartClickEpoch = null;
      let tShownEpoch = null;
      let tShownPerf = null;
      let softTimer = null;
      let capTimer = null;
      let raf = null;

      function place(el, cx, cy, size) {
        el.style.left = (cx - stageRect.left - size / 2) + 'px';
        el.style.top = (cy - stageRect.top - size / 2) + 'px';
        el.style.width = size + 'px';
        el.style.height = size + 'px';
      }

      const startEl = document.createElement('div');
      startEl.className = 'mx-stim';
      place(startEl, layout.startX, layout.startY, START_BUTTON_SIZE_PX);
      stage.appendChild(startEl);

      const targetEl = document.createElement('div');
      targetEl.className = 'mx-stim mx-target';

      // ---- 시간 압박 표시줄 ----
      const bar = $('mx-timebar-fill');
      function resetBar() {
        bar.classList.remove('mx-overtime');
        bar.style.transition = 'none';
        bar.style.width = '0%';
        void bar.offsetWidth;   // reflow 강제 — 다음 transition이 0%에서 시작하도록
      }
      function startBar() {
        bar.style.transition = `width ${TIME_LIMIT_MS}ms linear`;
        bar.style.width = '100%';
      }

      // ---- 궤적: mousemove로 최신 좌표만 갱신하고 rAF에서 push ----
      function onMove(e) { latest = { x: e.clientX, y: e.clientY }; }

      function sampleLoop() {
        if (phase === 'await-click' && !paused && latest) {
          trajectory.push([Math.round(nowPerf() - tShownPerf), r1(latest.x), r1(latest.y)]);
        }
        raf = requestAnimationFrame(sampleLoop);
      }

      function onDown(e) {
        if (paused || phase !== 'await-click' || e.button !== 0) return;
        pendingDown = { x: e.clientX, y: e.clientY, perf: nowPerf() };
      }

      function onUp(e) {
        if (paused || phase !== 'await-click' || e.button !== 0 || !pendingDown) return;
        if (dist(pendingDown.x, pendingDown.y, e.clientX, e.clientY) > DRAG_THRESHOLD_PX) {
          dragRejected++;       // 드래그로 간주 — 폐기하고 계속 대기(시행은 안 끝남)
          pendingDown = null;
          return;
        }
        finish(pendingDown);
      }

      function onContextMenu(e) { e.preventDefault(); }
      function onDragStart(e) { e.preventDefault(); }

      function onStartClick() {
        if (phase !== 'await-start') return;
        phase = 'await-click';
        tStartClickEpoch = Date.now();
        stage.removeChild(startEl);

        tShownEpoch = Date.now();
        tShownPerf = nowPerf();
        // 커서는 지금 시작 버튼 위에 있다. 궤적 첫 샘플을 그 지점으로 심고 latest도
        // 같은 값으로 초기화한다. 첫 mousemove가 오기 전 구간이 비지 않고(§5 예시의
        // [0, 720, 650]), 커서가 아예 멈춰 있는 동안에도 프레임마다 샘플이 남는다
        // (무응답 시행이나 클릭 직전 정지 구간이 통째로 비는 것을 막는다).
        latest = { x: layout.startX, y: layout.startY };
        trajectory.push([0, r1(layout.startX), r1(layout.startY)]);

        place(targetEl, layout.targetX, layout.targetY, spec.size);
        stage.appendChild(targetEl);
        armTimers();
      }

      function armTimers() {
        resetBar();
        startBar();
        softTimer = setTimeout(() => {
          softFired = true;              // 시행은 끝내지 않는다. 플래그만 (§4.3)
          bar.classList.add('mx-overtime');
        }, TIME_LIMIT_MS);
        capTimer = setTimeout(() => finish(null), RESPONSE_CAP_MS);
      }

      function clearTimers() {
        if (softTimer) clearTimeout(softTimer);
        if (capTimer) clearTimeout(capTimer);
        softTimer = capTimer = null;
      }

      function cleanup() {
        clearTimers();
        resetBar();
        cancelAnimationFrame(raf);
        stage.removeEventListener('mousemove', onMove);
        stage.removeEventListener('mousedown', onDown);
        stage.removeEventListener('mouseup', onUp);
        stage.removeEventListener('contextmenu', onContextMenu);
        stage.removeEventListener('dragstart', onDragStart);
        document.removeEventListener('fullscreenchange', onFsChange);
      }

      // ---- 전체화면 이탈: 이 시행을 버리고 재제시한다 ----
      // 이탈/재진입 사이에 뷰포트 크기가 바뀌면 이미 계산한 좌표가 낡은 값이 된다.
      // 반쯤 진행된 시행을 이어받는 것보다 버리는 편이 안전하다.
      function onFsChange() {
        if (finished || document.fullscreenElement) return;
        paused = true;
        clearTimers();
        resetBar();
        logEvent('fullscreen_lost', { trial_index: trialIndex, phase });
        showFullscreenLost(() => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({ aborted: true });
        });
      }
      document.addEventListener('fullscreenchange', onFsChange);

      startEl.addEventListener('click', onStartClick);
      stage.addEventListener('mousemove', onMove);
      stage.addEventListener('mousedown', onDown);
      stage.addEventListener('mouseup', onUp);
      stage.addEventListener('contextmenu', onContextMenu);
      stage.addEventListener('dragstart', onDragStart);
      raf = requestAnimationFrame(sampleLoop);

      function finish(clickPoint) {
        if (finished) return;
        finished = true;
        phase = 'done';
        cleanup();

        let click = null;
        let tClickEpoch = null;
        let rtMs = null;

        if (clickPoint) {
          const rel = clickPoint.perf - tShownPerf;
          rtMs = Math.round(rel);
          tClickEpoch = Math.round(tShownEpoch + rel);
          click = { x: r1(clickPoint.x), y: r1(clickPoint.y) };
          // rAF 샘플과 클릭 사이 최대 16ms 공백을 메운다.
          trajectory.push([Math.round(rel), click.x, click.y]);
        }

        const ts = trajectory.map((p) => p[0]);
        const gaps = [];
        for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);

        const targetX = r1(layout.targetX);
        const targetY = r1(layout.targetY);
        const hit = click ? dist(click.x, click.y, targetX, targetY) <= spec.size / 2 : false;

        const record = {
          index: trialIndex,
          main_index: spec.mainIndex,       // 본시행 내 번호 (워밍업은 null) — §6의 학습/평가 분할 기준
          warmup: !!spec.warmup,
          block: spec.block,
          direction_deg: spec.direction,
          button_size_px: spec.size,        // 모드 A는 시행마다 다르다
          target: { x: targetX, y: targetY },
          start: { x: r1(layout.startX), y: r1(layout.startY) },
          start_shifted: layout.shifted,
          t_start_click: tStartClickEpoch,
          t_target_shown: tShownEpoch,
          t_click: tClickEpoch,
          click,
          rt_ms: rtMs,
          // 클릭이 있으면 클릭 시각으로 판정한다. softFired 는 mouseup 시점에 읽히므로
          // 버튼을 오래 누르고 있으면 제한 안에 누른 클릭이 timeout으로 잘못 기록된다.
          timeout: click ? rtMs > TIME_LIMIT_MS : softFired,
          no_response: !click,
          success: hit,
          error_x: click ? r1(click.x - targetX) : null,
          error_y: click ? r1(click.y - targetY) : null,
          trajectory,
          sample_interval_median_ms: gaps.length ? median(gaps) : null,
          trajectory_span_ms: ts.length ? ts[ts.length - 1] - ts[0] : 0,
          n_trajectory_samples: trajectory.length,
          drag_rejected: dragRejected,
        };

        resolve({ record });
      }
    });
  }

  /* ---------------------- 6. 세션 실행 ---------------------- */

  let fsResumeCb = null;

  function showFullscreenLost(onGiveUp) {
    $('mx-overlay-fs').classList.remove('mx-hidden');
    fsResumeCb = onGiveUp;   // 재진입/중단 어느 쪽이든 진행 중이던 시행은 버린다
  }

  function hideFullscreenLost() {
    $('mx-overlay-fs').classList.add('mx-hidden');
  }

  /** 휴식·워밍업 종료 화면. 참가자가 직접 재개한다 (§4.2). */
  function showPause(kind, doneMain, totalMain) {
    return new Promise((resolve) => {
      const overlay = $('mx-overlay-pause');
      const isWarmupEnd = kind === 'warmup-end';
      $('mx-pause-title').textContent = isWarmupEnd ? '연습 끝' : '휴식';
      $('mx-pause-text').textContent = isWarmupEnd
        ? '지금부터 본 시행입니다. 준비되면 계속하기를 누르세요.'
        : '편한 만큼 쉬고, 준비되면 계속하기를 누르세요.';
      $('mx-pause-progress').textContent = isWarmupEnd ? '' : `${doneMain} / ${totalMain} 완료`;
      overlay.classList.remove('mx-hidden');
      logEvent(isWarmupEnd ? 'warmup_end' : 'rest', { done_main: doneMain });

      const btn = $('mx-pause-resume');
      const onClick = () => {
        btn.removeEventListener('click', onClick);
        overlay.classList.add('mx-hidden');
        resolve();
      };
      btn.addEventListener('click', onClick);
      btn.focus();
    });
  }

  async function runSession(specs) {
    const totalMain = specs.filter((sp) => !sp.warmup).length;

    S.trials = [];
    S.events = [];
    S.abortRequested = false;
    S.startedAt = new Date().toISOString();
    logEvent('session_start', { mode: S.mode, dev_mode: DEV_MODE, n_specs: specs.length });

    let i = 0;
    while (i < specs.length && !S.abortRequested) {
      const spec = specs[i];

      if (spec.pauseBefore && !spec._paused) {
        spec._paused = true;
        await showPause(spec.pauseBefore, spec.mainIndex, totalMain);
      }

      const out = await runTrial(spec, S.trials.length);
      if (out.aborted) {
        if (S.abortRequested) break;
        continue;                 // i를 올리지 않는다 = 같은 시행을 처음부터 다시 제시
      }

      S.trials.push(out.record);
      i++;
      await delay(INTER_TRIAL_BLANK_MS);
    }

    logEvent('session_end', { aborted: S.abortRequested, n_trials: S.trials.length });
    await finishSession();
  }

  /* ---------------------- 7. 완료 ---------------------- */

  function buildPayload() {
    const config = {
      button_size_px: S.mode === 'sizing' ? null : S.buttonSizePx,
      candidate_sizes_px: S.mode === 'sizing' ? CANDIDATE_SIZES_PX : null,
      distance_px: DISTANCE_PX,
      directions_deg: DIRECTIONS_DEG,
      time_limit_ms: TIME_LIMIT_MS,
      response_cap_ms: RESPONSE_CAP_MS,
      inter_trial_blank_ms: INTER_TRIAL_BLANK_MS,
      start_button_size_px: START_BUTTON_SIZE_PX,
      warmup_trials: S.mode === 'sizing' ? COUNTS.warmupSizing : COUNTS.warmupMain,
      main_trials: S.mode === 'sizing' ? CANDIDATE_SIZES_PX.length * COUNTS.sizingPerSize : COUNTS.main,
      train_split: S.mode === 'sizing' ? null : COUNTS.trainSplit,
      rest_every_n_trials: COUNTS.restEvery,
      sizing_target_success_rate: S.mode === 'sizing' ? SIZING_TARGET_SUCCESS : null,
      direction_convention: '0=right, 90=up, 180=left, 270=down (dy = -sin θ)',
      error_sign_convention: 'error = click - target; 보정좌표 = 클릭좌표 - 편향벡터',
    };

    return {
      schema_version: SCHEMA_VERSION,
      mode: S.mode,
      participant_id: S.participantId,
      dev_mode: DEV_MODE,
      started_at: S.startedAt,
      finished_at: new Date().toISOString(),
      aborted: S.abortRequested,
      environment: {
        inner_width: window.innerWidth,
        inner_height: window.innerHeight,
        screen_width: window.screen.width,
        screen_height: window.screen.height,
        device_pixel_ratio: window.devicePixelRatio || 1,
        input_device: S.inputDevice,
        zoom_estimate: S.zoomEstimate === null ? null : Math.round(S.zoomEstimate * 1000) / 1000,
        fullscreen: !!document.fullscreenElement,
        user_agent: navigator.userAgent,
        platform: navigator.platform || null,
      },
      config,
      session_events: S.events,
      trials: S.trials,
    };
  }

  /**
   * §3.3 JS → 파이썬 전달.
   * box.value = ... 로 직접 넣으면 프레임워크가 변경을 감지하지 못해 파이썬으로
   * 빈 문자열이 넘어간다. 오류도 안 나고 조용히 실패한다 — 그래서 프로토타입의
   * value setter를 직접 호출한다.
   */
  function submitResults(data) {
    const box = document.querySelector('#payload textarea, #payload input[type="text"]');
    const trigger = document.querySelector('#trigger');
    if (!box || !trigger) {
      return { sent: false, reason: 'local' };
    }
    try {
      const proto = box.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(box, JSON.stringify(data));
      box.dispatchEvent(new Event('input', { bubbles: true }));
      trigger.click();
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }

  /**
   * localStorage 백업. 업로드도 다운로드도 실패할 수 있고 참가자를 다시 부를 수는
   * 없다. 용량을 넘기면 궤적을 떼고 다시 시도한다 — 궤적은 이번 분석에 쓰지 않으므로
   * (§4.3) 떼어낸 백업으로도 §6은 전부 돌아간다.
   */
  function backupToStorage(payload, filename) {
    const key = 'mxexp:' + filename;
    try {
      localStorage.setItem(key, JSON.stringify(payload));
    } catch (e) {
      try {
        const light = Object.assign({}, payload, {
          trajectory_stripped: true,
          trials: payload.trials.map((t) => Object.assign({}, t, { trajectory: [] })),
        });
        localStorage.setItem(key, JSON.stringify(light));
      } catch (e2) {
        return { ok: false, reason: e2.message };
      }
      pruneBackups();
      return { ok: true, stripped: true };
    }
    pruneBackups();
    return { ok: true, stripped: false };
  }

  function backupKeys() {
    return Object.keys(localStorage).filter((k) => k.indexOf('mxexp:') === 0).sort();
  }

  function pruneBackups() {
    const keys = backupKeys();
    while (keys.length > BACKUP_KEEP) localStorage.removeItem(keys.shift());
  }

  function renderRecovery() {
    const keys = backupKeys().reverse();
    const field = $('mx-recovery-field');
    const list = $('mx-recovery-list');
    if (keys.length === 0) {
      field.classList.add('mx-hidden');
      return;
    }
    field.classList.remove('mx-hidden');
    list.innerHTML = '';
    keys.forEach((k) => {
      const name = k.slice('mxexp:'.length);
      const row = document.createElement('p');
      const btn = document.createElement('button');
      btn.textContent = '다운로드';
      btn.addEventListener('click', () => {
        try { downloadJson(name, JSON.parse(localStorage.getItem(k))); }
        catch (e) { alert('백업을 읽을 수 없습니다: ' + e.message); }
      });
      row.textContent = name + ' ';
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  function summarize(payload) {
    const main = payload.trials.filter((t) => !t.warmup);
    const answered = main.filter((t) => t.click);
    const succ = answered.filter((t) => t.success).length;
    const sizeMb = new Blob([JSON.stringify(payload)]).size / (1024 * 1024);
    const gaps = main.map((t) => t.sample_interval_median_ms).filter((v) => v !== null);
    const errX = answered.map((t) => t.error_x);
    const errY = answered.map((t) => t.error_y);
    const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

    return {
      nTotal: payload.trials.length,
      nMain: main.length,
      nWarmup: payload.trials.length - main.length,
      nNoResponse: main.length - answered.length,
      nTimeout: main.filter((t) => t.timeout).length,
      successRate: answered.length ? succ / answered.length : null,
      meanErrX: mean(errX),
      meanErrY: mean(errY),
      sampleIntervalMedian: median(gaps),
      sizeMb,
      nShifted: main.filter((t) => t.start_shifted).length,
      nDragRejected: main.reduce((s, t) => s + t.drag_rejected, 0),
    };
  }

  async function finishSession() {
    await document.exitFullscreen().catch(() => {});
    document.body.classList.remove('mx-running');

    const payload = buildPayload();
    S.lastPayload = payload;

    const stamp = payload.finished_at.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
    const filename = `${payload.mode}_${payload.participant_id}_${stamp}.json`;
    S.lastFilename = filename;

    const sub = submitResults(payload);            // 서버 저장 시도 (있으면)
    const backup = backupToStorage(payload, filename);   // 브라우저 백업

    showScreen('mx-screen-done');
    $('mx-done-title').textContent = MODE_LABEL[payload.mode] + (payload.aborted ? ' — 중단됨' : ' 완료');

    const s = summarize(payload);
    const pct = (v) => (v === null ? '—' : (v * 100).toFixed(1) + '%');
    $('mx-done-summary').innerHTML = `
      <table>
        <tbody>
          <tr><td>본시행 / 워밍업</td><td>${s.nMain} / ${s.nWarmup}</td></tr>
          <tr><td>성공률 (본시행, 무응답 제외)</td><td>${pct(s.successRate)}</td></tr>
          <tr><td>평균 오차 (error_x, error_y)</td><td>${s.meanErrX === null ? '—' : s.meanErrX.toFixed(2)}, ${s.meanErrY === null ? '—' : s.meanErrY.toFixed(2)} px</td></tr>
          <tr><td>${TIME_LIMIT_MS}ms 초과(timeout, 유지)</td><td>${s.nTimeout}</td></tr>
          <tr><td>무응답(${RESPONSE_CAP_MS}ms, 분석 제외)</td><td>${s.nNoResponse}</td></tr>
          <tr><td>드래그로 무시된 클릭</td><td>${s.nDragRejected}</td></tr>
          <tr><td>궤적 샘플 간격 중앙값</td><td>${s.sampleIntervalMedian === null ? '—' : s.sampleIntervalMedian + ' ms'}</td></tr>
          <tr><td>시작 버튼이 밀린 시행</td><td>${s.nShifted}</td></tr>
          <tr><td>JSON 용량</td><td>${s.sizeMb.toFixed(2)} MB</td></tr>
        </tbody>
      </table>
      ${payload.aborted ? '<p class="mx-warn">중단된 세션입니다. 지금까지의 시행만 담겨 있습니다.</p>' : ''}
      ${s.sizeMb > 3 ? '<p class="mx-warn">JSON이 3MB를 넘습니다 — 업로드가 실패할 수 있으니 다운로드 파일을 꼭 확인하세요.</p>' : ''}
    `;

    const parts = [];
    if (sub.sent) parts.push('서버로 전송했습니다. 아래 Gradio 상태 메시지에서 업로드 결과를 확인하세요.');
    else if (sub.reason === 'local') parts.push('로컬 실행 모드입니다(서버 저장 없음). 아래 버튼으로 파일을 받아 두세요.');
    else parts.push('서버 전송 실패: ' + sub.reason + ' — 아래 버튼으로 파일을 반드시 받아 두세요.');
    if (backup.ok) parts.push(backup.stripped
      ? '브라우저 백업 저장됨 (용량 초과로 궤적은 제외).'
      : '브라우저 백업 저장됨.');
    else parts.push('브라우저 백업 실패: ' + backup.reason);
    parts.push('파일명: ' + filename);
    $('mx-save-status').innerHTML = parts.join('<br>');

    renderRecovery();
  }

  /* ---------------------- 8. 모드 A 집계 (§4.2) ---------------------- */

  /** 2x2 뉴턴법(IRLS)으로 p = sigmoid(a + b·x) 적합. 외부 의존성 없음. */
  function fitLogistic(xs, ys, maxIter = 200, tol = 1e-10) {
    let a = 0, b = 0;
    for (let iter = 0; iter < maxIter; iter++) {
      let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        const p = 1 / (1 + Math.exp(-(a + b * x)));
        const w = p * (1 - p);
        g0 += ys[i] - p;
        g1 += (ys[i] - p) * x;
        h00 += w;
        h01 += w * x;
        h11 += w * x * x;
      }
      const det = h00 * h11 - h01 * h01;
      if (Math.abs(det) < 1e-12) break;
      const da = (g0 * h11 - g1 * h01) / det;
      const db = (h00 * g1 - h01 * g0) / det;
      a += da; b += db;
      if (Math.abs(da) < tol && Math.abs(db) < tol) break;
    }
    return { a, b };
  }

  function aggregateSizing(datasets) {
    const bySize = new Map();
    const xs = [];
    const ys = [];

    datasets.forEach((d) => {
      if (d.mode !== 'sizing') throw new Error(`${d.participant_id}: mode가 "sizing"이 아닙니다 (${d.mode})`);
      d.trials.forEach((t) => {
        if (t.warmup) return;        // 워밍업 제외
        if (!t.click) return;        // 무응답 제외
        const size = t.button_size_px;
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(t.success ? 1 : 0);
        xs.push(Math.log(size));
        ys.push(t.success ? 1 : 0);
      });
    });

    const perSize = [...bySize.entries()]
      .map(([size, out]) => ({
        size_px: size,
        n_trials: out.length,
        success_rate: out.reduce((s, v) => s + v, 0) / out.length,
      }))
      .sort((p, q) => p.size_px - q.size_px);

    const { a, b } = fitLogistic(xs, ys);
    const logit = Math.log(SIZING_TARGET_SUCCESS / (1 - SIZING_TARGET_SUCCESS));
    const raw = Math.exp((logit - a) / b);
    const selected = Math.round(raw);

    const tested = perSize.map((p) => p.size_px);
    const minT = Math.min(...tested);
    const maxT = Math.max(...tested);

    const warnings = [];
    if (!(Number.isFinite(a) && Number.isFinite(b) && b > 0 && Number.isFinite(raw) && raw > 0)) {
      warnings.push('적합이 불안정합니다(기울기 ≤ 0 또는 발산). 원 데이터를 확인하세요.');
    }
    if (selected < minT || selected > maxT) {
      warnings.push(`산출 크기 ${selected}px가 시험 범위(${minT}~${maxT}px) 밖입니다 — 회귀선 외삽입니다. 후보 크기를 넓혀 모드 A를 다시 돌리세요.`);
    }
    if (datasets.length < 2) {
      warnings.push('참가자가 1명뿐입니다 — 계획서 §4.2는 2~3명을 요구합니다.');
    }

    return {
      generated_at: new Date().toISOString(),
      target_success_rate: SIZING_TARGET_SUCCESS,
      per_size: perSize,
      logistic_fit: { intercept: a, slope_on_ln_size: b },
      predicted_size_px_raw: raw,
      selected_size_px: selected,
      tested_size_range_px: [minT, maxT],
      n_source_participants: datasets.length,
      source_participant_ids: datasets.map((d) => d.participant_id),
      warnings,
    };
  }

  /* ---------------------- 9. UI 바인딩 / mount ---------------------- */

  function showScreen(id) {
    document.querySelectorAll('#mx-app .mx-screen').forEach((el) => el.classList.remove('active'));
    $(id).classList.add('active');
  }

  function selectedMode() {
    const el = document.querySelector('input[name="mx-mode"]:checked');
    return el ? el.value : 'main';
  }

  function selectedDevice() {
    const el = document.querySelector('input[name="mx-device"]:checked');
    return el ? el.value : 'mouse';
  }

  function refreshSetup() {
    const mode = selectedMode();
    S.mode = mode;
    S.inputDevice = selectedDevice();

    $('mx-field-size').classList.toggle('mx-hidden', mode === 'sizing');
    $('mx-trackpad-warn').classList.toggle('mx-hidden', S.inputDevice !== 'trackpad');

    const rows = renderEnvTable();
    const rawId = $('mx-participant-id').value.trim();
    const id = sanitizeId(rawId);
    const size = Number($('mx-button-size').value);

    const reasons = [];
    if (!document.fullscreenEnabled) {
      reasons.push(isFramed()
        ? '이 페이지가 다른 화면 안(iframe)에 들어 있어 전체화면을 쓸 수 없습니다 — 앱 주소를 새 창에서 직접 열어주세요.'
        : '이 브라우저에서 전체화면이 허용되지 않습니다.');
    }
    if (!id) reasons.push('참가자 ID를 입력하세요(영문·숫자·_·-).');
    else if (id !== rawId) reasons.push(`참가자 ID에 쓸 수 없는 문자가 있습니다 → "${id}" 로 저장됩니다. 그대로 쓰려면 입력을 고치세요.`);
    if (mode === 'main' && !(Number.isFinite(size) && size >= 4 && size <= 80)) {
      reasons.push('버튼 크기를 4~80px 사이로 입력하세요.');
    }
    rows.filter((r) => r.blocking && !r.ok).forEach((r) => reasons.push(`${r.name}: ${r.value} (기준 ${r.rule})`));
    if (S.inputDevice === 'trackpad' && !$('mx-trackpad-ack').checked) {
      reasons.push('트랙패드는 권장하지 않습니다 — 진행하려면 확인란을 체크하세요.');
    }

    S.participantId = id;
    S.buttonSizePx = size;
    $('mx-start').disabled = reasons.length > 0;
    $('mx-start-blocked').innerHTML = reasons.join('<br>');
  }

  async function startRun() {
    refreshSetup();
    if ($('mx-start').disabled) return;

    try {
      await document.documentElement.requestFullscreen();
    } catch (e) {
      alert('전체화면 진입 실패: ' + e.message + '\n브라우저 창을 클릭한 뒤 다시 시도하세요.');
      return;
    }
    // 전환 애니메이션이 끝나야 innerWidth/innerHeight가 전체화면 값으로 바뀐다.
    await delay(350);

    const sizeProblem = fullscreenViewportOk();
    if (sizeProblem) {
      await document.exitFullscreen().catch(() => {});
      alert(sizeProblem);
      return;
    }

    // 스펙은 여기서 한 번만 뽑는다. 점검용과 실행용을 따로 뽑으면 실제로 돌아가는
    // 시퀀스가 아닌 다른 추첨을 검사하게 된다.
    const specs = buildSpecs();
    const fitProblem = allTrialsFit(specs);
    if (fitProblem) {
      await document.exitFullscreen().catch(() => {});
      alert(fitProblem);
      return;
    }

    document.body.classList.add('mx-running');
    showScreen('mx-screen-run');
    await runSession(specs);
  }

  function bind() {
    // 시행 수를 화면에 채운다 (dev 모드면 축소된 값이 그대로 보인다)
    const fill = (cls, v) => document.querySelectorAll('#mx-app .' + cls).forEach((el) => { el.textContent = v; });
    fill('mx-c-warmup-main', COUNTS.warmupMain);
    fill('mx-c-main', COUNTS.main);
    fill('mx-c-warmup-sizing', COUNTS.warmupSizing);
    fill('mx-c-sizing', CANDIDATE_SIZES_PX.length * COUNTS.sizingPerSize);

    $('mx-build-line').textContent =
      `스키마 ${SCHEMA_VERSION} · 거리 ${DISTANCE_PX}px · ${DIRECTIONS_DEG.length}방향 · 제한 ${TIME_LIMIT_MS}ms` +
      (DEV_MODE ? ' · ⚠ dev=1 축소 모드 (본실험에 쓰지 말 것)' : '');
    $('mx-button-size').value = DEFAULT_BUTTON_SIZE_PX;

    $('mx-participant-id').addEventListener('input', refreshSetup);
    $('mx-button-size').addEventListener('input', refreshSetup);
    document.querySelectorAll('input[name="mx-mode"], input[name="mx-device"]')
      .forEach((el) => el.addEventListener('change', refreshSetup));
    $('mx-trackpad-ack').addEventListener('change', refreshSetup);
    $('mx-recheck-env').addEventListener('click', refreshSetup);
    window.addEventListener('resize', () => {
      if (!document.fullscreenElement && $('mx-screen-setup').classList.contains('active')) refreshSetup();
    });

    $('mx-start').addEventListener('click', startRun);

    $('mx-fs-reenter').addEventListener('click', async () => {
      try {
        await document.documentElement.requestFullscreen();
        await delay(250);
        hideFullscreenLost();
        if (fsResumeCb) { const cb = fsResumeCb; fsResumeCb = null; cb(); }
      } catch (e) {
        alert('전체화면 재진입 실패: ' + e.message);
      }
    });

    $('mx-fs-abort').addEventListener('click', () => {
      if (!confirm('여기서 중단하고 지금까지의 시행을 저장할까요?')) return;
      S.abortRequested = true;
      hideFullscreenLost();
      if (fsResumeCb) { const cb = fsResumeCb; fsResumeCb = null; cb(); }
    });

    $('mx-download-json').addEventListener('click', () => {
      if (!S.lastPayload) return;
      downloadJson(S.lastFilename, S.lastPayload);
    });

    $('mx-back-from-done').addEventListener('click', () => {
      showScreen('mx-screen-setup');
      refreshSetup();
    });

    // ---- 모드 A 집계 ----
    $('mx-go-aggregate').addEventListener('click', () => showScreen('mx-screen-aggregate'));
    $('mx-back-from-aggregate').addEventListener('click', () => {
      showScreen('mx-screen-setup');
      refreshSetup();
    });

    $('mx-run-aggregate').addEventListener('click', async () => {
      const files = $('mx-aggregate-files').files;
      if (!files.length) { alert('모드 A JSON 파일을 선택하세요.'); return; }
      try {
        const datasets = await Promise.all(Array.from(files).map(readJsonFile));
        const res = aggregateSizing(datasets);
        S.lastAggregate = res;

        $('mx-aggregate-body').innerHTML = res.per_size.map((r) =>
          `<tr><td>${r.size_px}</td><td>${r.n_trials}</td><td>${(r.success_rate * 100).toFixed(1)}%</td></tr>`
        ).join('');
        $('mx-aggregate-fit').textContent =
          `적합: logit(성공) = ${res.logistic_fit.intercept.toFixed(3)} + ${res.logistic_fit.slope_on_ln_size.toFixed(3)}·ln(크기)` +
          ` · 참가자 ${res.n_source_participants}명 (${res.source_participant_ids.join(', ')})`;
        $('mx-aggregate-selected').innerHTML =
          `성공률 ${(res.target_success_rate * 100).toFixed(0)}% 지점 크기: <b>${res.selected_size_px}px</b>` +
          ` (반올림 전 ${res.predicted_size_px_raw.toFixed(2)}px)`;
        $('mx-aggregate-warnings').innerHTML =
          res.warnings.map((w) => `<p class="mx-bad">경고: ${w}</p>`).join('');
        $('mx-aggregate-result').classList.remove('mx-hidden');
      } catch (e) {
        alert('집계 실패: ' + e.message);
      }
    });

    $('mx-apply-size').addEventListener('click', () => {
      if (!S.lastAggregate) return;
      $('mx-button-size').value = S.lastAggregate.selected_size_px;
      document.querySelector('input[name="mx-mode"][value="main"]').checked = true;
      showScreen('mx-screen-setup');
      refreshSetup();
      alert(`모드 B의 버튼 크기를 ${S.lastAggregate.selected_size_px}px로 설정했습니다.`);
    });

    $('mx-download-size').addEventListener('click', () => {
      if (!S.lastAggregate) return;
      downloadJson('sizing_result.json', S.lastAggregate);
    });

    refreshSetup();
    renderRecovery();
  }

  /**
   * mount: Gradio에서는 이 스크립트가 head에 주입되어 gr.HTML 내용보다 먼저 실행된다.
   * 그래서 DOMContentLoaded만 기다리면 #mx-app이 아직 없다. 요소가 나타날 때까지 관찰한다.
   */
  function mount() {
    if (!$('mx-app') || !$('mx-start')) return false;
    if (window.__mxMounted) return true;
    window.__mxMounted = true;
    bind();
    return true;
  }

  if (!mount()) {
    const obs = new MutationObserver(() => { if (mount()) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', mount);
  }

  // 로컬 셸(static/index.html)이 조각을 나중에 붙이는 경우를 위한 훅.
  // _internal 은 tools/selftest.mjs 가 DOM 없이 순수 로직을 검사하는 시험용 통로다.
  window.mouseExperiment = {
    mount,
    version: SCHEMA_VERSION,
    devMode: DEV_MODE,
    _internal: {
      COUNTS, DIRECTIONS_DEG, DISTANCE_PX, CANDIDATE_SIZES_PX, SIZING_TARGET_SUCCESS,
      START_BUTTON_SIZE_PX, TOP_CLEARANCE_PX, EDGE_PADDING_PX, TIME_LIMIT_MS,
      balanced, buildMainSpecs, buildSizingSpecs, computeLayout, fitLogistic, aggregateSizing,
    },
  };
})();
