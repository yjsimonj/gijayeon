/* =====================================================================
 * 마우스 보정 실험 — 실험 로직 전부
 *
 * 계획서: new2/실험앱_계획서_v2(1).md (이하 "계획서 §x") 중 모드 B(본실험)만 구현.
 * 실험 질문: 개인별 클릭 편향을 학습해 빼주면 정확도가 오르는가?
 *            그 이득은 개인화 때문인가?
 *
 * 실험 로직은 전부 여기 있다. Gradio(app.py)는 화면을 얹어 주고 결과 JSON을
 * 서버의 data/ 폴더에 쓰는 일만 한다 — 궤적 125Hz·px 단위 클릭 좌표·ms 타이밍·
 * 전체화면은 Gradio 컴포넌트로 다룰 수 없기 때문이다(계획서 §2).
 *
 * 좌표는 전부 뷰포트 기준 CSS px (event.clientX/clientY 와 같은 공간).
 * 부호 규약(§5): error_x = click.x − target.x, error_y = click.y − target.y.
 *                보정은 빼는 것 → 보정좌표 = 클릭좌표 − 편향벡터.
 * 방향 규약: 0°=오른쪽, 90°=위, 180°=왼쪽, 270°=아래 (dy = −sin θ).
 *            계획서 §5 예시가 90°에서 target.y(200) < start.y(650) 이므로 위다.
 *
 * 목차
 *   0. 상수 / 상태      1. 유틸리티        2. 시행 스펙
 *   3. 배치 계산        4. 한 시행         5. 세션(휴식·전체화면)
 *   6. 완료(제출·다운로드)                 7. UI 바인딩
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
  const TIME_LIMIT_MS = 750;      // 초과 시 timeout 플래그만. 시행은 유지(§4.3)
  const RESPONSE_CAP_MS = 3000;   // 이때까지 무클릭이면 no_response
  const INTER_TRIAL_BLANK_MS = 200;
  const START_BUTTON_SIZE_PX = 30;
  const DEFAULT_BUTTON_SIZE_PX = 12;

  // 실행 세부
  const DRAG_THRESHOLD_PX = 50;   // mousedown~mouseup 이 이보다 멀면 드래그 → 폐기하고 계속 대기
  const EDGE_PADDING_PX = 8;
  const TOP_CLEARANCE_PX = 14;    // 시간바(5px) + 여유

  // §4.2 / §8-2 (?dev=1 축소 모드. 없으면 점검할 때마다 600번 클릭하게 된다)
  const COUNTS = DEV_MODE
    ? { warmup: 4, main: 20, trainSplit: 12, restEvery: 10 }
    : { warmup: 20, main: 600, trainSplit: 400, restEvery: 100 };

  const S = {
    participantId: null,
    studentId: null,      // 개인정보: 원본 JSON에만 남고 파일명·분석에는 쓰지 않는다
    name: null,
    buttonSizePx: DEFAULT_BUTTON_SIZE_PX,
    startedAt: null,
    trials: [],
    events: [],
    abortRequested: false,
    lastPayload: null,
    lastFilename: null,
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

  const sanitizeId = (raw) => String(raw).replace(/[^A-Za-z0-9_-]/g, '');

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

  /* ---------------------- 2. 시행 스펙 ---------------------- */

  /**
   * 워밍업 20 + 본시행 600 (§4.2).
   *
   * 방향은 100회 블록마다 4방향을 25회씩 균등 배분하고 블록 안에서만 섞는다.
   * 600회를 통째로 섞으면 앞 400(학습)과 뒤 200(평가)의 방향 구성이 우연히
   * 달라질 수 있다. §6은 학습 벡터를 평가 시행에 그대로 적용하므로, 두 구간의
   * 방향 구성이 어긋나면 "개인 편향"이 아니라 "방향 구성 차이"를 재게 된다.
   */
  function buildSpecs(buttonSizePx) {
    const specs = [];

    balanced(DIRECTIONS_DEG, COUNTS.warmup).forEach((deg) => {
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

    // 학습/평가 구분은 참가자에게 알리지 않고 화면상 표시도 없다 (§4.2).
    // 멈추는 곳은 워밍업 종료와 100회 휴식뿐이다.
    specs.forEach((sp) => {
      if (sp.warmup) return;
      if (sp.mainIndex === 0) sp.pauseBefore = 'warmup-end';
      else if (sp.mainIndex % COUNTS.restEvery === 0) sp.pauseBefore = 'rest';
    });
    return specs;
  }

  /* ---------------------- 3. 배치 계산 ---------------------- */

  /**
   * 시작 버튼은 화면 중앙(§4.3)이 기본이지만, 그대로 두면 세로 방향 시행이 화면을
   * 벗어난다: 900px 높이에서 중앙 450 − 450 = 0, 800px면 −50이다. 거리 450px과
   * 4방향은 분석의 뼈대라 건드릴 수 없으므로, 시작 버튼을 해당 축으로 필요한
   * 최소량만 민다(1440×900에서 ±14px). 밀렸는지는 start_shifted 로 기록한다.
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
    const bad = specs.filter((sp) =>
      computeLayout(sp.size, sp.direction, window.innerWidth, window.innerHeight) === null);
    if (bad.length === 0) return null;
    return `화면이 너무 작아 ${bad.length}개 시행을 표시할 수 없습니다 ` +
           `(뷰포트 ${window.innerWidth}×${window.innerHeight}, 이동거리 ${DISTANCE_PX}px, ` +
           `버튼 ${specs[0].size}px). 더 큰 화면이나 낮은 디스플레이 배율에서 실행하세요.`;
  }

  /* ---------------------- 4. 한 시행 (§4.3) ---------------------- */

  /**
   * 1. 화면 중앙에 시작 버튼(30px) → 2. 클릭(커서 시작 위치 확정)
   * 3. 450px 떨어진 4방향 중 하나에 목표 등장(t0) → 4. 이동·클릭
   * 5. 기록 → 6. 200ms 공백
   *
   * resolve({ record })         정상 종료 (무응답 포함)
   * resolve({ aborted: true })  전체화면 이탈 등으로 이 시행을 버림 → 재제시
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

      // 시작 전에 전부 확인했으므로, 여기서 null이면 세션 도중에 뷰포트가 줄어든
      // 것이다(전체화면 해제·해상도 변경). 그냥 진행하면 화면 밖 목표를 "실패한
      // 클릭"으로 조용히 기록해 데이터가 오염된다.
      if (!layout) {
        logEvent('layout_infeasible', {
          trial_index: trialIndex, size: spec.size, direction: spec.direction,
          inner_width: window.innerWidth, inner_height: window.innerHeight,
        });
        showFullscreenLost(() => resolve({ aborted: true }));
        return;
      }

      let phase = 'await-start';    // 'await-start' | 'await-click' | 'done'
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
      // 750ms 제한이 눈에 보이지 않으면 참가자가 버튼 위에서 느긋하게 미세조정해버려
      // 측정하려는 오차 자체가 생기지 않는다.
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
      // 이벤트마다 쌓지 않는 이유: 커서가 멈춰 있는 구간(사람은 목표에 커서를 세운 뒤
      // 클릭한다 — 80~100ms)도 샘플이 남아야 시계열이 끊기지 않는다. 실측 간격
      // 중앙값 8ms(125Hz)로 시행당 약 75샘플이며 이는 §3.5의 용량 추정과 맞는다.
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
        // 커서는 지금 시작 버튼 위에 있다. 첫 샘플을 그 지점으로 심고 latest도 같은
        // 값으로 초기화한다 (§5 예시의 [0, 720, 650]). 커서가 아예 안 움직여도
        // 프레임마다 샘플이 남는다.
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

      // ---- 전체화면 이탈: 이 시행을 버리고 재제시 ----
      // 이탈/재진입 사이에 뷰포트가 바뀌면 이미 계산한 좌표가 낡은 값이 된다.
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
          trajectory.push([Math.round(rel), click.x, click.y]);  // rAF와 클릭 사이 공백 보정
        }

        const ts = trajectory.map((p) => p[0]);
        const gaps = [];
        for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);

        const targetX = r1(layout.targetX);
        const targetY = r1(layout.targetY);
        const hit = click ? dist(click.x, click.y, targetX, targetY) <= spec.size / 2 : false;

        const record = {
          index: trialIndex,
          main_index: spec.mainIndex,     // 본시행 내 번호(워밍업은 null) — §6의 학습/평가 분할 기준
          warmup: !!spec.warmup,
          block: spec.block,
          direction_deg: spec.direction,
          button_size_px: spec.size,
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

  /* ---------------------- 5. 세션 ---------------------- */

  let fsGiveUpCb = null;

  function showFullscreenLost(onGiveUp) {
    $('mx-overlay-fs').classList.remove('mx-hidden');
    fsGiveUpCb = onGiveUp;
  }

  function hideFullscreenLost() {
    $('mx-overlay-fs').classList.add('mx-hidden');
  }

  /** 휴식·워밍업 종료. 참가자가 직접 재개한다 (§4.2). */
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
    logEvent('session_start', { dev_mode: DEV_MODE, n_specs: specs.length });

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

  /* ---------------------- 6. 완료 ---------------------- */

  function buildPayload() {
    return {
      schema_version: SCHEMA_VERSION,
      mode: 'main',
      participant_id: S.participantId,
      // 학번·이름은 개인정보다. 원본 JSON에만 두고 파일명·분석에는 쓰지 않는다.
      participant: { student_id: S.studentId, name: S.name },
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
        fullscreen: !!document.fullscreenElement,
        user_agent: navigator.userAgent,
        platform: navigator.platform || null,
      },
      config: {
        button_size_px: S.buttonSizePx,
        distance_px: DISTANCE_PX,
        directions_deg: DIRECTIONS_DEG,
        time_limit_ms: TIME_LIMIT_MS,
        response_cap_ms: RESPONSE_CAP_MS,
        inter_trial_blank_ms: INTER_TRIAL_BLANK_MS,
        start_button_size_px: START_BUTTON_SIZE_PX,
        warmup_trials: COUNTS.warmup,
        main_trials: COUNTS.main,
        train_split: COUNTS.trainSplit,
        rest_every_n_trials: COUNTS.restEvery,
        direction_convention: '0=right, 90=up, 180=left, 270=down (dy = -sin θ)',
        error_sign_convention: 'error = click - target; 보정좌표 = 클릭좌표 - 편향벡터',
      },
      session_events: S.events,
      trials: S.trials,
    };
  }

  /**
   * 결과를 파이썬으로 넘긴다 (계획서 §3.3).
   *
   * box.value = ... 로 직접 넣으면 프레임워크가 변경을 감지하지 못해 파이썬으로
   * 빈 문자열이 넘어간다. 오류도 안 나고 조용히 실패한다 — 그래서 프로토타입의
   * value setter를 직접 호출한다. 이 한 줄 때문에 며칠 날리는 경우가 흔하다.
   */
  function submitResults(data) {
    const box = document.querySelector('#payload textarea, #payload input[type="text"]');
    const trigger = document.querySelector('#trigger');
    if (!box || !trigger) return { sent: false, reason: 'no-bridge' };
    try {
      const proto = box.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, JSON.stringify(data));
      box.dispatchEvent(new Event('input', { bubbles: true }));
      trigger.click();
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }

  function summarize(payload) {
    const main = payload.trials.filter((t) => !t.warmup);
    const answered = main.filter((t) => t.click);
    const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
    return {
      nMain: main.length,
      nWarmup: payload.trials.length - main.length,
      nNoResponse: main.length - answered.length,
      nTimeout: main.filter((t) => t.timeout).length,
      successRate: answered.length ? answered.filter((t) => t.success).length / answered.length : null,
      meanErrX: mean(answered.map((t) => t.error_x)),
      meanErrY: mean(answered.map((t) => t.error_y)),
      sampleIntervalMedian: median(main.map((t) => t.sample_interval_median_ms).filter((v) => v !== null)),
      sizeMb: new Blob([JSON.stringify(payload)]).size / (1024 * 1024),
    };
  }

  async function finishSession() {
    await document.exitFullscreen().catch(() => {});
    document.body.classList.remove('mx-running');

    const payload = buildPayload();
    S.lastPayload = payload;
    const stamp = payload.finished_at.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
    S.lastFilename = `main_${payload.participant_id}_${stamp}.json`;

    const sub = submitResults(payload);

    showScreen('mx-screen-done');
    $('mx-done-title').textContent = payload.aborted ? '중단됨' : '완료 — 수고하셨습니다';

    const s = summarize(payload);
    const pct = (v) => (v === null ? '—' : (v * 100).toFixed(1) + '%');
    $('mx-done-summary').innerHTML = `
      <table><tbody>
        <tr><td>참가자</td><td>${payload.participant_id} · ${payload.participant.student_id} · ${payload.participant.name}</td></tr>
        <tr><td>본시행 / 워밍업</td><td>${s.nMain} / ${s.nWarmup}</td></tr>
        <tr><td>성공률 (본시행)</td><td>${pct(s.successRate)}</td></tr>
        <tr><td>평균 오차 (error_x, error_y)</td><td>${s.meanErrX === null ? '—' : s.meanErrX.toFixed(2)}, ${s.meanErrY === null ? '—' : s.meanErrY.toFixed(2)} px</td></tr>
        <tr><td>${TIME_LIMIT_MS}ms 초과 / 무응답</td><td>${s.nTimeout} / ${s.nNoResponse}</td></tr>
        <tr><td>궤적 샘플 간격 중앙값</td><td>${s.sampleIntervalMedian === null ? '—' : s.sampleIntervalMedian + ' ms'}</td></tr>
        <tr><td>JSON 용량</td><td>${s.sizeMb.toFixed(2)} MB</td></tr>
      </tbody></table>
      ${payload.aborted ? '<p class="mx-warn">중단된 세션입니다. 지금까지의 시행만 담겨 있습니다.</p>' : ''}
    `;

    $('mx-save-status').innerHTML = sub.sent
      ? '서버로 전송했습니다. 아래 저장 결과 메시지를 확인하세요.'
      : '⚠ 서버 전송 실패(' + sub.reason + ') — <b>아래 “JSON 직접 받기”로 파일을 받아 두세요.</b>';
  }

  /* ---------------------- 7. UI 바인딩 ---------------------- */

  function showScreen(id) {
    document.querySelectorAll('#mx-app .mx-screen').forEach((el) => el.classList.remove('active'));
    $(id).classList.add('active');
  }

  function refreshSetup() {
    const rawId = $('mx-participant-id').value.trim();
    const id = sanitizeId(rawId);
    const size = Number($('mx-button-size').value);
    const studentId = $('mx-student-id').value.trim();
    const name = $('mx-name').value.trim();

    const reasons = [];
    // 앱이 iframe에 얹혀 있으면 전체화면이 막힌다. 그러면 주소창 높이가 좌표에
    // 섞여(§7) 데이터가 조용히 오염되므로 추측하지 않고 브라우저에 직접 물어본다.
    if (!document.fullscreenEnabled) {
      reasons.push('이 창에서는 전체화면을 쓸 수 없습니다 — 앱 주소를 새 창에서 직접 열어주세요.');
    }
    if (!studentId) reasons.push('학번을 입력하세요.');
    if (!name) reasons.push('이름을 입력하세요.');
    if (!id) reasons.push('참가자 ID를 입력하세요(영문·숫자·_·-).');
    else if (id !== rawId) reasons.push(`참가자 ID에 쓸 수 없는 문자가 있습니다 → "${id}" 로 저장됩니다.`);
    if (!(Number.isFinite(size) && size >= 4 && size <= 80)) {
      reasons.push('버튼 크기를 4~80px 사이로 입력하세요.');
    }

    S.participantId = id;
    S.studentId = studentId;
    S.name = name;
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
      alert('전체화면 진입 실패: ' + e.message + '\n화면을 한 번 클릭한 뒤 다시 시도하세요.');
      return;
    }
    await delay(350);   // 전환이 끝나야 innerWidth/innerHeight가 전체화면 값이 된다

    // 스펙은 한 번만 뽑는다. 점검용과 실행용을 따로 뽑으면 실제로 돌아가는 시퀀스가
    // 아닌 다른 추첨을 검사하게 된다.
    const specs = buildSpecs(S.buttonSizePx);
    const problem = allTrialsFit(specs);
    if (problem) {
      await document.exitFullscreen().catch(() => {});
      alert(problem);
      return;
    }

    document.body.classList.add('mx-running');
    showScreen('mx-screen-run');
    await runSession(specs);
  }

  function bind() {
    $('mx-build-line').textContent =
      `워밍업 ${COUNTS.warmup} + 본시행 ${COUNTS.main}회 · 거리 ${DISTANCE_PX}px · ` +
      `4방향 · 제한 ${TIME_LIMIT_MS}ms · ${COUNTS.restEvery}회마다 휴식` +
      (DEV_MODE ? ' · ⚠ dev=1 축소 모드 (본실험에 쓰지 말 것)' : '');
    $('mx-button-size').value = DEFAULT_BUTTON_SIZE_PX;

    ['mx-participant-id', 'mx-student-id', 'mx-name', 'mx-button-size']
      .forEach((id) => $(id).addEventListener('input', refreshSetup));

    $('mx-start').addEventListener('click', startRun);

    $('mx-fs-reenter').addEventListener('click', async () => {
      try {
        await document.documentElement.requestFullscreen();
        await delay(250);
        hideFullscreenLost();
        if (fsGiveUpCb) { const cb = fsGiveUpCb; fsGiveUpCb = null; cb(); }
      } catch (e) {
        alert('전체화면 재진입 실패: ' + e.message);
      }
    });

    $('mx-fs-abort').addEventListener('click', () => {
      if (!confirm('여기서 중단하고 지금까지의 시행을 저장할까요?')) return;
      S.abortRequested = true;
      hideFullscreenLost();
      if (fsGiveUpCb) { const cb = fsGiveUpCb; fsGiveUpCb = null; cb(); }
    });

    $('mx-download-json').addEventListener('click', () => {
      if (S.lastPayload) downloadJson(S.lastFilename, S.lastPayload);
    });

    $('mx-back-from-done').addEventListener('click', () => {
      showScreen('mx-screen-setup');
      refreshSetup();
    });

    refreshSetup();
  }

  /**
   * mount: Gradio에서는 이 스크립트가 head에 주입되어 gr.HTML 내용보다 먼저 실행된다.
   * 그래서 DOMContentLoaded만 기다리면 #mx-app이 아직 없다. 나타날 때까지 관찰한다.
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

  // _internal 은 tools/selftest.mjs 가 DOM 없이 순수 로직을 검사하는 시험용 통로다.
  window.mouseExperiment = {
    mount,
    version: SCHEMA_VERSION,
    devMode: DEV_MODE,
    _internal: {
      COUNTS, DIRECTIONS_DEG, DISTANCE_PX, START_BUTTON_SIZE_PX,
      TOP_CLEARANCE_PX, EDGE_PADDING_PX, TIME_LIMIT_MS,
      balanced, buildSpecs, computeLayout,
    },
  };
})();
