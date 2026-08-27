/* =====================================================================
 * 마우스 보정 실험 — 0~3단계 웹앱
 * new/마우스보정_실험계획서.md 및 확정된 사용자 지시사항(계획 파일 참고) 구현.
 *
 * 목차
 *  0. 상수 / 전역 상태
 *  1. 유틸리티 (난수, 균형 시퀀스, 각도/거리)
 *  2. Config 로드 (phase0_button_sizes.json, gap config)
 *  3. 시행 스펙 생성 (단계별)
 *  4. 시행 실행 (홈 → 목표 → 클릭 상태기계)
 *  5. 블록(단계) 실행 — 진행률·휴식·전체화면 관리
 *  6. σ/gap config 계산 (1단계 완료 시)
 *  7. 0단계 결과 집계 (로지스틱 회귀 기반 크기 자동 선택)
 *  8. 내보내기 (JSON 다운로드)
 *  9. 화면 전환 / UI 바인딩
 * ===================================================================== */

/* ---------------------- 0. 상수 / 전역 상태 ---------------------- */

const params = new URLSearchParams(location.search);
const DEV_MODE = params.get('dev') === '1';

// 명세서 3.2절 — 0단계 후보 크기(px). 실험 설계 자체의 값이므로 config로 빼지 않는다.
const CANDIDATE_SIZES_PX = [6, 10, 16, 24, 32];

const DISTANCES_PX = [300, 600];
const DIRECTIONS_DEG = [0, 45, 90, 135, 180, 225, 270, 315];
const GRID_ROWS_COLS = [0, 1, 2];

const TRIAL_COUNTS = DEV_MODE
  ? { phase0PerSize: 3, phase1: 16, phase2: 8, phase3: 9 }
  : { phase0PerSize: 30, phase1: 400, phase2: 120, phase3: 240 }; // 사용자 확정: 0단계 30회/크기(총 150)

const REST_BREAK_EVERY_N_TRIALS = DEV_MODE ? 5 : 50;
const REST_BREAK_DURATION_MS = DEV_MODE ? 3000 : 30000;

const TIME_SOFT_LIMIT_MS = 750;   // 초과 시 timeout=true 로 표시만, 시행은 안 끝남 (명세서 원안 500 → 750으로 변경)
const RESPONSE_HARD_CAP_MS = 3000; // 이 시점까지도 무응답이면 click:null 로 강제 종료
const INTER_TRIAL_BLANK_MS = 200;
const DRAG_DISTANCE_THRESHOLD_PX = 50; // mousedown~mouseup 거리 이 값 넘으면 드래그로 간주(폐기)
// 방향 추정 확대 창(analysis/error_decomposition.py의 FALLBACK_WINDOW_MS=250)과 같은 값.
// 이보다 짧으면 폴백 계산에 쓸 참조점이 없으므로 해당 시행에 플래그를 남긴다.
const MIN_PRECLICK_TRAJECTORY_MS = 250;
const MIN_GRID_GAP_PX = 4; // 0단계 자동 선택 시 세 크기 간 최소 간격

const WARMUP_TRIALS_TO_EXCLUDE = 20; // σ 계산 시 앞 N회 제외 (분석용, 실행 로직과 무관)

const PHASE_LABELS = {
  0: '0단계 — 예비실험',
  1: '1단계 — 학습 데이터 수집',
  2: '2단계 — 단일 버튼 평가',
  3: '3단계 — 다중 버튼 평가',
};

const App = {
  participantId: null,
  phase: null,
  screenInfo: null,
  buttonSizesConfig: null, // { selected_sizes_px: [...], ... }
  gapConfig: null,         // { participant_id, sigma_px, gaps_px, ... }
  trials: [],
  abortRequested: false,
};

/* ---------------------- 1. 유틸리티 ---------------------- */

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function randomChoice(arr) {
  return arr[randomInt(arr.length)];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * values를 totalCount개로 최대한 균등 배분한 뒤 순서를 무작위로 섞어 반환한다.
 * totalCount가 values.length로 나누어떨어지지 않으면 나머지를 무작위로 선택된
 * value들에 +1씩 분배한다 (예: 240개를 9칸에 배분 → 6칸은 27, 3칸은 26).
 */
function balancedSequence(values, totalCount) {
  const base = Math.floor(totalCount / values.length);
  const remainder = totalCount - base * values.length;
  const bonusIdx = new Set(shuffle(values.map((_, i) => i)).slice(0, remainder));
  const seq = [];
  values.forEach((v, idx) => {
    const count = base + (bonusIdx.has(idx) ? 1 : 0);
    for (let i = 0; i < count; i++) seq.push(v);
  });
  return shuffle(seq);
}

function directionToUnitVector(deg) {
  const rad = (deg * Math.PI) / 180;
  return { dx: Math.cos(rad), dy: Math.sin(rad) }; // 화면 좌표계(y 아래로 증가) 그대로 사용
}

function distanceBetween(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// 원형 판정: 클릭이 버튼 내부(중심에서 반경 이내)였는가 (계획서 2.5절 성공 판정)
function isHit(trial) {
  return !!trial.click && distanceBetween(trial.click.x, trial.click.y, trial.button.center_x, trial.button.center_y) <= trial.button.size / 2;
}

function nowMs() {
  return performance.now();
}

/* ---------------------- 2. Config 로드 ---------------------- */

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (e) {
        reject(new Error('JSON 파싱 실패: ' + e.message));
      }
    };
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsText(file, 'utf-8');
  });
}

/* ---------------------- 3. 시행 스펙 생성 ---------------------- */

function generatePhase0Specs() {
  const total = CANDIDATE_SIZES_PX.length * TRIAL_COUNTS.phase0PerSize;
  const sizeSeq = balancedSequence(CANDIDATE_SIZES_PX, total);
  const dirSeq = balancedSequence(DIRECTIONS_DEG, total);
  return sizeSeq.map((size, i) => ({
    size,
    distance: randomChoice(DISTANCES_PX),
    direction: dirSeq[i],
  }));
}

function generateSingleButtonSpecs(total, selectedSizes) {
  const dirSeq = balancedSequence(DIRECTIONS_DEG, total);
  const specs = [];
  for (let i = 0; i < total; i++) {
    specs.push({
      size: randomChoice(selectedSizes),   // 명세서: "매 시행 무작위" (균형 배분 아님)
      distance: randomChoice(DISTANCES_PX), // 명세서: "무작위" (균형 배분 아님)
      direction: dirSeq[i],                 // 명세서: "균등 배분 후 순서 무작위"
    });
  }
  return specs;
}

function generatePhase3Specs(selectedSizes, gapsPx) {
  const total = TRIAL_COUNTS.phase3;
  const cells = [];
  selectedSizes.forEach((size, sIdx) => {
    Object.entries(gapsPx).forEach(([gapLabel, gapValue]) => {
      cells.push({ size, gap: gapValue, gapLabel });
    });
  });
  const cellSeq = balancedSequence(cells, total);
  const dirSeq = balancedSequence(DIRECTIONS_DEG, total);
  const specs = [];
  for (let i = 0; i < total; i++) {
    specs.push({
      size: cellSeq[i].size,
      gap: cellSeq[i].gap,
      gapLabel: cellSeq[i].gapLabel,
      distance: randomChoice(DISTANCES_PX),
      direction: dirSeq[i],
      targetRow: randomChoice(GRID_ROWS_COLS),
      targetCol: randomChoice(GRID_ROWS_COLS),
    });
  }
  return specs;
}

/* ---------------------- 3-1. 시행 배치(홈·목표 위치) ---------------------- */

// 홈을 화면 정중앙에 고정하면 세로 방향 600px 시행이 화면 밖으로 나간다
// (세로 900px 화면에서 중앙 450 + 600 = 1050 > 900). 1920x1080에서도 마찬가지로
// 불가능하다. 그래서 홈을 매 시행 옮겨 목표가 화면 안에 들어오게 하되,
// 가능한 한 홈–목표 쌍의 중점이 화면 중앙에 오도록 배치한다.
// 거리 300/600·8방향 균등배분은 그대로 유지된다.
const HOME_BUTTON_SIZE_PX = 24;
const EDGE_PADDING_PX = 8;
const STATUSBAR_CLEARANCE_PX = 50; // 상단바에 가려지지 않도록 확보하는 위쪽 여유

// 목표를 중심으로 화면을 차지하는 반경. 3단계는 격자 바깥쪽 한 칸까지 포함한다.
function targetExtentPx(spec, phase) {
  const r = spec.size / 2;
  if (phase !== 3) return r;
  const spacing = spec.size + spec.gap; // 인접 버튼 중심 간 거리 = 2r + gap
  return r + spacing;
}

/**
 * 한 시행의 홈·목표 좌표를 뷰포트 기준으로 계산한다.
 * 배치가 불가능하면(화면이 너무 작아 어떤 위치로도 둘 다 담을 수 없음) null.
 */
function computeTrialLayout(spec, phase, viewportW, viewportH) {
  const { dx, dy } = directionToUnitVector(spec.direction);
  const vx = dx * spec.distance;
  const vy = dy * spec.distance;

  const homeR = HOME_BUTTON_SIZE_PX / 2;
  const te = targetExtentPx(spec, phase);

  // 홈이 놓일 수 있는 범위 = (홈 자신이 화면 안) ∩ (홈 + 이동벡터인 목표도 화면 안)
  const hxMin = Math.max(homeR, te - vx) + EDGE_PADDING_PX;
  const hxMax = viewportW - Math.max(homeR, te + vx) - EDGE_PADDING_PX;
  const hyMin = STATUSBAR_CLEARANCE_PX + Math.max(homeR, te - vy);
  const hyMax = viewportH - Math.max(homeR, te + vy) - EDGE_PADDING_PX;

  if (hxMin > hxMax || hyMin > hyMax) return null;

  // 기본값: 홈–목표 쌍의 중점이 화면(상단바 아래 영역) 중앙에 오도록
  const desiredHx = viewportW / 2 - vx / 2;
  const desiredHy = (STATUSBAR_CLEARANCE_PX + viewportH) / 2 - vy / 2;

  const homeX = Math.min(Math.max(desiredHx, hxMin), hxMax);
  const homeY = Math.min(Math.max(desiredHy, hyMin), hyMax);

  return { homeX, homeY, targetX: homeX + vx, targetY: homeY + vy };
}

// 시작 전에 모든 시행이 실제로 표시 가능한지 확인한다. 확인 없이 진행하면
// 화면 밖 목표를 "클릭 실패"로 조용히 기록해 데이터가 오염된다.
function checkAllTrialsFit(specs, phase) {
  const infeasible = specs.filter(
    (s) => computeTrialLayout(s, phase, window.innerWidth, window.innerHeight) === null
  );
  if (infeasible.length === 0) return true;

  const worst = infeasible.reduce((a, b) => (b.distance > a.distance ? b : a));
  alert(
    `화면이 너무 작아 ${infeasible.length}개 시행을 표시할 수 없습니다.\n` +
    `(예: 이동거리 ${worst.distance}px, 버튼 ${worst.size}px)\n` +
    `현재 뷰포트 ${window.innerWidth}x${window.innerHeight}.\n` +
    `Windows 디스플레이 배율을 낮추거나 더 큰 화면에서 실행하세요.`
  );
  return false;
}

/* ---------------------- 4. 시행 실행 ---------------------- */

/**
 * 한 시행을 실행하고 완료되면 trial record를 resolve하는 Promise를 반환한다.
 * spec: { size, distance, direction, gap?, gapLabel?, targetRow?, targetCol? }
 */
function runTrial(spec, trialIndex, phase) {
  return new Promise((resolve) => {
    const stage = document.getElementById('stage');
    stage.innerHTML = '';

    // 모든 좌표(홈/목표/격자/기록값)는 클릭 이벤트(e.clientX/clientY)와 동일한
    // 뷰포트 기준으로 계산한다. 렌더링 시에만 stageRect.left/top을 빼서 stage
    // 로컬 좌표로 변환한다 (변환 안 하면 button.center_*가 stage 로컬 기준이 되어
    // 클릭 좌표와 어긋나 실제로는 맞은 클릭도 전부 미스로 기록되는 버그가 생긴다).
    const stageRect = stage.getBoundingClientRect();
    const layout = computeTrialLayout(spec, phase, window.innerWidth, window.innerHeight);
    const homeX = layout.homeX;
    const homeY = layout.homeY;

    let subPhase = 'await-home'; // 'await-home' | 'await-target-click'
    let trajectory = [];
    let latestPointer = null;
    let pendingMousedown = null; // {x,y,t}
    let targetOnsetTime = null;
    let homeClickTime = null;
    let softTimeoutFired = false;
    let hardCapTimer = null;
    let rafHandle = null;
    let finalized = false;
    let fullscreenPaused = false;

    // ---- 렌더링 ----
    function circleStyle(el, cx, cy, size) {
      el.style.left = (cx - stageRect.left - size / 2) + 'px';
      el.style.top = (cy - stageRect.top - size / 2) + 'px';
      el.style.width = size + 'px';
      el.style.height = size + 'px';
    }

    const homeEl = document.createElement('div');
    homeEl.className = 'stim home';
    circleStyle(homeEl, homeX, homeY, HOME_BUTTON_SIZE_PX);
    stage.appendChild(homeEl);

    let targetAbsX, targetAbsY;
    let gridCells = []; // phase3: [{el, cx, cy, isTarget}]

    function renderTarget() {
      targetAbsX = layout.targetX;
      targetAbsY = layout.targetY;

      if (phase !== 3) {
        const el = document.createElement('div');
        el.className = 'stim target';
        circleStyle(el, targetAbsX, targetAbsY, spec.size);
        stage.appendChild(el);
        gridCells = [{ el, cx: targetAbsX, cy: targetAbsY, isTarget: true }];
        return;
      }

      // 3단계: 목표 버튼의 절대 위치를 기준으로 3x3 격자를 배치한다.
      // (격자 "중심" 기준이 아니라 목표 버튼 위치 기준 — 계획 확정 사항)
      const r = spec.size / 2;
      const spacing = 2 * r + spec.gap;
      gridCells = [];
      GRID_ROWS_COLS.forEach((row) => {
        GRID_ROWS_COLS.forEach((col) => {
          const cx = targetAbsX + (col - spec.targetCol) * spacing;
          const cy = targetAbsY + (row - spec.targetRow) * spacing;
          const isTarget = row === spec.targetRow && col === spec.targetCol;
          const el = document.createElement('div');
          el.className = 'stim' + (isTarget ? ' target' : '');
          circleStyle(el, cx, cy, spec.size);
          stage.appendChild(el);
          gridCells.push({ el, cx, cy, isTarget });
        });
      });
    }

    // ---- 궤적 샘플링 (mousemove로 최신 좌표만 갱신, rAF에서 push) ----
    function onMouseMove(e) {
      latestPointer = { x: e.clientX, y: e.clientY };
    }

    function sampleLoop() {
      if (subPhase === 'await-target-click' && !fullscreenPaused && latestPointer) {
        trajectory.push({ x: latestPointer.x, y: latestPointer.y, t: nowMs() });
      }
      rafHandle = requestAnimationFrame(sampleLoop);
    }

    // ---- 클릭 판정 ----
    function onMouseDown(e) {
      if (fullscreenPaused) return;
      if (e.button !== 0) return; // 좌클릭만
      if (subPhase !== 'await-target-click') return;
      pendingMousedown = { x: e.clientX, y: e.clientY, t: nowMs() };
    }

    function onMouseUp(e) {
      if (fullscreenPaused) return;
      if (e.button !== 0) return;
      if (subPhase !== 'await-target-click') return;
      if (!pendingMousedown) return;

      const dragDist = distanceBetween(pendingMousedown.x, pendingMousedown.y, e.clientX, e.clientY);
      if (dragDist > DRAG_DISTANCE_THRESHOLD_PX) {
        // 드래그로 간주 — 폐기하고 계속 대기 (시행 안 끝남)
        pendingMousedown = null;
        return;
      }

      finalizeWithClick(pendingMousedown);
    }

    function onContextMenu(e) {
      e.preventDefault();
    }

    function onHomeClick() {
      if (subPhase !== 'await-home') return;
      homeClickTime = nowMs();
      stage.removeChild(homeEl);
      subPhase = 'await-target-click';
      targetOnsetTime = nowMs();
      renderTarget();
      armTimers();
    }
    homeEl.addEventListener('click', onHomeClick);

    stage.addEventListener('mousemove', onMouseMove);
    stage.addEventListener('mousedown', onMouseDown);
    stage.addEventListener('mouseup', onMouseUp);
    stage.addEventListener('contextmenu', onContextMenu);
    rafHandle = requestAnimationFrame(sampleLoop);

    // ---- 시간압박 표시줄: 소프트 제한을 실제로 "느끼게" 함 (계획서 3.3절
    // "시간 제한을 두는 이유" — 안 보이면 사용자가 여유롭게 미세조정해버려 무의미) ----
    const timeBarFill = document.getElementById('timeBarFill');
    function resetTimeBar() {
      timeBarFill.classList.remove('overtime');
      timeBarFill.style.transition = 'none';
      timeBarFill.style.width = '0%';
      void timeBarFill.offsetWidth; // reflow 강제 — 다음 transition이 0%부터 시작하도록
    }
    function startTimeBar() {
      timeBarFill.style.transition = `width ${TIME_SOFT_LIMIT_MS}ms linear`;
      timeBarFill.style.width = '100%';
    }

    // ---- 타이머 ----
    let softTimer = null;
    function armTimers() {
      resetTimeBar();
      startTimeBar();

      softTimer = setTimeout(() => {
        softTimeoutFired = true; // 시행은 끝내지 않음, 플래그만
        timeBarFill.classList.add('overtime');
      }, TIME_SOFT_LIMIT_MS);

      hardCapTimer = setTimeout(() => {
        finalizeWithClick(null); // 3000ms까지 무응답 → 강제 종료
      }, RESPONSE_HARD_CAP_MS);
    }

    function clearTimers() {
      if (softTimer) clearTimeout(softTimer);
      if (hardCapTimer) clearTimeout(hardCapTimer);
    }

    // ---- 전체화면 이탈 대응: 목표 대기 중 이탈 시 해당 시행을 재시작 ----
    function onFullscreenChange() {
      if (subPhase !== 'await-target-click') return;
      if (!document.fullscreenElement) {
        fullscreenPaused = true;
        clearTimers();
        showFullscreenLostOverlay(() => {
          // 재진입 성공 시 이 시행의 "목표 대기" 단계를 처음부터 다시 시작
          fullscreenPaused = false;
          trajectory = [];
          pendingMousedown = null;
          softTimeoutFired = false;
          targetOnsetTime = nowMs();
          armTimers();
        });
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // ---- 종료 처리 ----
    function cleanup() {
      clearTimers();
      resetTimeBar();
      cancelAnimationFrame(rafHandle);
      stage.removeEventListener('mousemove', onMouseMove);
      stage.removeEventListener('mousedown', onMouseDown);
      stage.removeEventListener('mouseup', onMouseUp);
      stage.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    }

    function finalizeWithClick(clickPoint) {
      if (finalized) return;
      finalized = true;
      subPhase = 'clicked';
      cleanup();

      let click = null;
      if (clickPoint) {
        click = { x: clickPoint.x, y: clickPoint.y, time: clickPoint.t };
        // 클릭 좌표를 궤적 마지막 원소로 추가 (rAF 샘플-클릭 사이 최대 16ms 공백 보정)
        trajectory.push({ x: clickPoint.x, y: clickPoint.y, t: clickPoint.t });
      }

      const trajectorySpanMs = trajectory.length > 0 ? trajectory[trajectory.length - 1].t - trajectory[0].t : 0;
      const insufficientTrajectory = trajectory.length === 0 || trajectorySpanMs < MIN_PRECLICK_TRAJECTORY_MS;

      const target = gridCells.find((c) => c.isTarget);

      const record = {
        participant_id: App.participantId,
        phase,
        trial_index: trialIndex,
        timestamp: Date.now(),
        button: {
          center_x: target.cx,
          center_y: target.cy,
          size: spec.size,
          gap: phase === 3 ? spec.gap : null,
          grid_positions: phase === 3 ? gridCells.map((c) => ({ center_x: c.cx, center_y: c.cy })) : null,
        },
        click,
        target_onset_time: targetOnsetTime,
        home_click_time: homeClickTime,
        trajectory,
        // 클릭이 있으면 클릭 시각(mousedown) 기준으로 판정한다. softTimeoutFired는
        // mouseup 시점에 읽히므로, 버튼을 오래 누르고 있으면 제한 안에 누른 클릭도
        // timeout으로 잘못 기록된다(실측: mousedown 972ms인데 timeout=true).
        timeout: click ? click.time - targetOnsetTime > TIME_SOFT_LIMIT_MS : softTimeoutFired,
        insufficient_trajectory_flag: insufficientTrajectory,
        gap_sigma_px: phase === 3 ? App.gapConfig.sigma_px : null,
        screen: App.screenInfo,
      };

      resolve(record);
    }
  });
}

/* ---------------------- 5. 블록(단계) 실행 ---------------------- */

let fullscreenLostResumeCallback = null;

function showFullscreenLostOverlay(onResume) {
  fullscreenLostResumeCallback = onResume;
  document.getElementById('fullscreen-lost-overlay').classList.remove('hidden');
}

function hideFullscreenLostOverlay() {
  document.getElementById('fullscreen-lost-overlay').classList.add('hidden');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showRestBreak() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('rest-overlay');
    const countdownEl = document.getElementById('restCountdown');
    overlay.classList.remove('hidden');
    let remainingMs = REST_BREAK_DURATION_MS;
    countdownEl.textContent = Math.ceil(remainingMs / 1000);
    const interval = setInterval(() => {
      remainingMs -= 1000;
      countdownEl.textContent = Math.max(0, Math.ceil(remainingMs / 1000));
      if (remainingMs <= 0) {
        clearInterval(interval);
        overlay.classList.add('hidden');
        resolve();
      }
    }, 1000);
  });
}

function updateStatusbar(done, total) {
  document.getElementById('statusParticipant').textContent = 'ID: ' + App.participantId;
  document.getElementById('statusPhase').textContent = PHASE_LABELS[App.phase];
  document.getElementById('statusProgress').textContent = done + ' / ' + total;
}

async function runBlock(trialSpecs, phase) {
  App.trials = [];
  App.abortRequested = false;

  updateStatusbar(0, trialSpecs.length);

  for (let i = 0; i < trialSpecs.length; i++) {
    if (App.abortRequested) break;

    const record = await runTrial(trialSpecs[i], i, phase);
    App.trials.push(record);
    updateStatusbar(App.trials.length, trialSpecs.length);

    const completedCount = i + 1;
    if (completedCount % REST_BREAK_EVERY_N_TRIALS === 0 && completedCount < trialSpecs.length) {
      await showRestBreak();
    } else {
      await delay(INTER_TRIAL_BLANK_MS);
    }
  }

  showDoneScreen();
}

/* ---------------------- 6. σ/gap config 계산 ---------------------- */

// timeout 시행은 제외하지 않는다. 명세서 4.3절("시간 초과 시행은 별도 플래그를
// 남기되 제외하지 않음 — 속도-정확도 교환의 일부")과 일치시킨 것으로, 실측에서
// timeout이 56%에 달해 제외하면 표본이 절반 이하로 줄고 느린(신중한) 시행만
// 빠져 σ가 부풀려진다(실측 4.24 → 4.59px).
// 클릭이 아예 없는 시행(무응답)은 오차를 정의할 수 없으므로 여전히 제외한다.
function computeSigmaAndGaps(trials, participantId) {
  const sorted = trials.slice().sort((a, b) => a.trial_index - b.trial_index);
  const afterWarmup = sorted.slice(WARMUP_TRIALS_TO_EXCLUDE);
  const used = afterWarmup.filter((t) => t.click);

  const distances = used.map((t) => distanceBetween(t.click.x, t.click.y, t.button.center_x, t.button.center_y));
  const n = distances.length;
  const mean = distances.reduce((s, v) => s + v, 0) / n;
  const variance = distances.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sigmaPx = Math.sqrt(variance);

  return {
    participant_id: participantId,
    sigma_source_phase: 1,
    computed_at: new Date().toISOString(),
    n_trials_total: sorted.length,
    n_excluded_warmup: sorted.length - afterWarmup.length,
    n_excluded_no_click: afterWarmup.length - used.length,
    n_timeout_included: used.filter((t) => t.timeout).length, // 제외 안 함, 참고용
    n_used: n,
    sigma_px: sigmaPx,
    gaps_px: { '0': 0, '1sigma': sigmaPx, '3sigma': sigmaPx * 3 },
  };
}

/* ---------------------- 7. 0단계 결과 집계 ---------------------- */

// 2x2 뉴턴법(IRLS)으로 p = sigmoid(a + b*x) 적합. 순수 JS, 외부 의존성 없음.
function fitLogisticRegression(xs, ys, maxIter = 100, tol = 1e-10) {
  let a = 0, b = 0;
  const n = xs.length;
  for (let iter = 0; iter < maxIter; iter++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i];
      const z = a + b * x;
      const p = 1 / (1 + Math.exp(-z));
      const w = p * (1 - p);
      const err = y - p;
      g0 += err;
      g1 += err * x;
      h00 += w;
      h01 += w * x;
      h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (g0 * h11 - g1 * h01) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da;
    b += db;
    if (Math.abs(da) < tol && Math.abs(db) < tol) break;
  }
  return { a, b };
}

function invertLogisticForSize(a, b, targetP) {
  const logit = Math.log(targetP / (1 - targetP));
  return Math.exp((logit - a) / b);
}

function aggregatePhase0(exportedDatasets) {
  // 크기별 풀링
  const bySize = new Map();
  CANDIDATE_SIZES_PX.forEach((s) => bySize.set(s, []));

  exportedDatasets.forEach((data) => {
    if (data.phase !== 0) throw new Error('phase==0 로그가 아닙니다: ' + data.participant_id);
    data.trials.forEach((t) => {
      const size = t.button.size;
      if (!bySize.has(size)) bySize.set(size, []);
      bySize.get(size).push(isHit(t) ? 1 : 0);
    });
  });

  const perSize = [];
  const xs = [];
  const ys = [];
  bySize.forEach((outcomes, size) => {
    if (outcomes.length === 0) return;
    const successRate = outcomes.reduce((s, v) => s + v, 0) / outcomes.length;
    perSize.push({ size_px: size, n_trials: outcomes.length, success_rate: successRate });
    outcomes.forEach((y) => {
      xs.push(Math.log(size));
      ys.push(y);
    });
  });
  perSize.sort((a, b) => a.size_px - b.size_px);

  const { a, b } = fitLogisticRegression(xs, ys);

  // 명세서 밴드는 75~90%지만 목표를 80/85/90%로 잡으면 90%에 해당하는 크기가
  // 후보 최대치(32px)를 넘어 외삽된다(실측: 32px에서도 성공률 83%가 한계).
  // 75/80/85%는 밴드 안이면서 산출 크기가 전부 관측 범위에 들어온다.
  const targets = [0.75, 0.8, 0.85];
  const rawPredicted = targets.map((p) => invertLogisticForSize(a, b, p));

  let adjusted = [Math.round(rawPredicted[0])];
  adjusted.push(Math.max(Math.round(rawPredicted[1]), adjusted[0] + MIN_GRID_GAP_PX));
  adjusted.push(Math.max(Math.round(rawPredicted[2]), adjusted[1] + MIN_GRID_GAP_PX));

  const fitValid = Number.isFinite(a) && Number.isFinite(b) && b > 0 && adjusted.every((v) => Number.isFinite(v) && v > 0);

  // 산출 크기가 실제로 시험해본 범위를 벗어나면 회귀선만 믿고 외삽하는 것이므로
  // 조용히 넘어가지 않고 기록·표시한다. (관측 최대 크기의 성공률이 목표에 못 미치면 발생)
  const testedSizes = perSize.map((p) => p.size_px);
  const minTested = Math.min(...testedSizes);
  const maxTested = Math.max(...testedSizes);
  const extrapolated = adjusted.filter((s) => s < minTested || s > maxTested);

  return {
    generated_at: new Date().toISOString(),
    trials_per_size: TRIAL_COUNTS.phase0PerSize,
    per_size: perSize,
    logistic_fit: { intercept: a, slope_on_ln_size: b, valid: fitValid },
    target_success_rates: targets,
    predicted_sizes_px_raw: rawPredicted,
    selected_sizes_px: adjusted,
    min_gap_adjustment_applied: adjusted.some((v, i) => Math.round(rawPredicted[i]) !== v),
    tested_size_range_px: [minTested, maxTested],
    extrapolated_sizes_px: extrapolated,
    source_participant_ids: exportedDatasets.map((d) => d.participant_id),
    n_source_participants: exportedDatasets.length,
  };
}

/* ---------------------- 8. 내보내기 ---------------------- */

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildExportEnvelope() {
  return {
    participant_id: App.participantId,
    phase: App.phase,
    exported_at: new Date().toISOString(),
    screen: App.screenInfo,
    trials: App.trials,
  };
}

/* ---------------------- 9. 화면 전환 / UI 바인딩 ---------------------- */

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function captureScreenInfo() {
  App.screenInfo = {
    width: window.screen.width,
    height: window.screen.height,
    dpr: window.devicePixelRatio || 1,
  };
}

function refreshStartButtonState() {
  const btn = document.getElementById('startRunBtn');
  const reasonEl = document.getElementById('startBlockedReason');
  const phase = getSelectedPhase();

  document.getElementById('field-button-sizes-config').classList.toggle('hidden', phase === 0);
  document.getElementById('field-gap-config').classList.toggle('hidden', phase !== 3);

  const idOk = !!document.getElementById('participantId').value.trim();
  let reason = '';
  if (!idOk) reason = '참가자 ID를 입력하세요.';
  else if (phase !== 0 && !App.buttonSizesConfig) reason = '버튼 크기 설정을 불러오세요.';
  else if (phase === 3 && !App.gapConfig) reason = '간격 설정을 불러오세요.';
  else if (phase === 3 && App.gapConfig && App.gapConfig.participant_id !== document.getElementById('participantId').value.trim()) {
    reason = '간격 설정의 participant_id가 입력한 참가자 ID와 다릅니다.';
  }

  btn.disabled = !!reason;
  reasonEl.textContent = reason;
}

function getSelectedPhase() {
  return Number(document.querySelector('input[name="phase"]:checked').value);
}

function buildSpecsForPhase(phase) {
  if (phase === 0) return generatePhase0Specs();
  if (phase === 1) return generateSingleButtonSpecs(TRIAL_COUNTS.phase1, App.buttonSizesConfig.selected_sizes_px);
  if (phase === 2) return generateSingleButtonSpecs(TRIAL_COUNTS.phase2, App.buttonSizesConfig.selected_sizes_px);
  if (phase === 3) return generatePhase3Specs(App.buttonSizesConfig.selected_sizes_px, App.gapConfig.gaps_px);
  throw new Error('알 수 없는 단계: ' + phase);
}

function showDoneScreen() {
  showScreen('screen-done');
  document.getElementById('doneTitle').textContent = PHASE_LABELS[App.phase] + ' 완료';

  const total = App.trials.length;
  const successCount = App.trials.filter(isHit).length;
  const timeoutCount = App.trials.filter((t) => t.timeout).length;
  const noResponseCount = App.trials.filter((t) => !t.click).length;
  const flaggedCount = App.trials.filter((t) => t.insufficient_trajectory_flag).length;

  document.getElementById('doneSummary').innerHTML = `
    <p>총 시행: ${total}</p>
    <p>성공(원 안 클릭): ${successCount} (${((successCount / total) * 100).toFixed(1)}%)</p>
    <p>${TIME_SOFT_LIMIT_MS}ms 초과(timeout): ${timeoutCount}</p>
    <p>무응답(${RESPONSE_HARD_CAP_MS}ms): ${noResponseCount}</p>
    <p>궤적 부족 플래그: ${flaggedCount}</p>
  `;

  const sigmaBlock = document.getElementById('phase1SigmaBlock');
  if (App.phase === 1) {
    sigmaBlock.classList.remove('hidden');
    const result = computeSigmaAndGaps(App.trials, App.participantId);
    App._lastSigmaResult = result;
    document.getElementById('sigmaSummary').innerHTML = `
      <p>sigma_px = ${result.sigma_px.toFixed(3)} (n_used=${result.n_used}/${result.n_trials_total}, 워밍업 제외 ${result.n_excluded_warmup}, 무응답 제외 ${result.n_excluded_no_click}, timeout ${result.n_timeout_included}건은 포함)</p>
      <p>gaps_px: 0 / ${result.gaps_px['1sigma'].toFixed(1)} / ${result.gaps_px['3sigma'].toFixed(1)}</p>
    `;
  } else {
    sigmaBlock.classList.add('hidden');
  }
}

async function requestFullscreenAndRun() {
  try {
    await document.documentElement.requestFullscreen();
  } catch (e) {
    alert('전체화면 진입에 실패했습니다: ' + e.message);
    return;
  }

  const specs = buildSpecsForPhase(App.phase);
  if (!checkAllTrialsFit(specs, App.phase)) {
    await document.exitFullscreen().catch(() => {});
    return;
  }

  captureScreenInfo();
  showScreen('screen-run');
  await runBlock(specs, App.phase);
}

document.addEventListener('DOMContentLoaded', () => {
  const participantIdInput = document.getElementById('participantId');
  const buttonSizesInput = document.getElementById('buttonSizesConfigInput');
  const gapConfigInput = document.getElementById('gapConfigInput');

  participantIdInput.addEventListener('input', refreshStartButtonState);
  document.querySelectorAll('input[name="phase"]').forEach((r) => r.addEventListener('change', refreshStartButtonState));

  buttonSizesInput.addEventListener('change', async () => {
    const file = buttonSizesInput.files[0];
    if (!file) return;
    try {
      App.buttonSizesConfig = await readJsonFile(file);
      document.getElementById('buttonSizesConfigStatus').textContent =
        '불러옴: 크기 ' + App.buttonSizesConfig.selected_sizes_px.join(', ') + 'px';
    } catch (e) {
      App.buttonSizesConfig = null;
      document.getElementById('buttonSizesConfigStatus').textContent = '오류: ' + e.message;
    }
    refreshStartButtonState();
  });

  gapConfigInput.addEventListener('change', async () => {
    const file = gapConfigInput.files[0];
    if (!file) return;
    try {
      App.gapConfig = await readJsonFile(file);
      document.getElementById('gapConfigStatus').textContent =
        '불러옴: participant_id=' + App.gapConfig.participant_id + ', sigma_px=' + App.gapConfig.sigma_px.toFixed(2);
    } catch (e) {
      App.gapConfig = null;
      document.getElementById('gapConfigStatus').textContent = '오류: ' + e.message;
    }
    refreshStartButtonState();
  });

  document.getElementById('startRunBtn').addEventListener('click', () => {
    App.participantId = participantIdInput.value.trim();
    App.phase = getSelectedPhase();
    requestFullscreenAndRun();
  });

  document.getElementById('abortBtn').addEventListener('click', () => {
    if (confirm('실험을 중단할까요? 지금까지의 시행은 완료 화면에서 내보낼 수 있습니다.')) {
      App.abortRequested = true;
    }
  });

  document.getElementById('reenterFullscreenBtn').addEventListener('click', async () => {
    try {
      await document.documentElement.requestFullscreen();
      hideFullscreenLostOverlay();
      if (fullscreenLostResumeCallback) {
        const cb = fullscreenLostResumeCallback;
        fullscreenLostResumeCallback = null;
        cb();
      }
    } catch (e) {
      alert('전체화면 재진입 실패: ' + e.message);
    }
  });

  document.getElementById('exportJsonBtn').addEventListener('click', () => {
    const envelope = buildExportEnvelope();
    downloadJson(`phase${App.phase}_${App.participantId}_${Date.now()}.json`, envelope);
  });

  document.getElementById('downloadGapConfigBtn').addEventListener('click', () => {
    downloadJson(`${App.participantId}_gap_config.json`, App._lastSigmaResult);
  });

  document.getElementById('backToSetupFromDoneBtn').addEventListener('click', () => {
    showScreen('screen-setup');
  });

  // ---- 0단계 결과 집계 화면 ----
  document.getElementById('goAggregateBtn').addEventListener('click', () => showScreen('screen-phase0-aggregate'));
  document.getElementById('backToSetupFromAggregateBtn').addEventListener('click', () => showScreen('screen-setup'));

  let lastAggregateResult = null;

  document.getElementById('runAggregateBtn').addEventListener('click', async () => {
    const files = document.getElementById('phase0FilesInput').files;
    if (!files.length) {
      alert('0단계 JSON 파일을 선택하세요.');
      return;
    }
    try {
      const datasets = await Promise.all(Array.from(files).map(readJsonFile));
      const result = aggregatePhase0(datasets);
      lastAggregateResult = result;

      const tbody = document.querySelector('#aggregateTable tbody');
      tbody.innerHTML = '';
      result.per_size.forEach((row) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.size_px}</td><td>${row.n_trials}</td><td>${(row.success_rate * 100).toFixed(1)}%</td>`;
        tbody.appendChild(tr);
      });

      document.getElementById('aggregateFit').textContent =
        `로지스틱 회귀: a=${result.logistic_fit.intercept.toFixed(3)}, b=${result.logistic_fit.slope_on_ln_size.toFixed(3)}` +
        (result.logistic_fit.valid ? '' : ' (경고: 적합 불안정 — 원 데이터 확인 필요)');
      const warnings = [];
      if (result.extrapolated_sizes_px.length > 0) {
        warnings.push(
          `${result.extrapolated_sizes_px.join(', ')}px는 실제로 시험한 범위` +
          `(${result.tested_size_range_px[0]}~${result.tested_size_range_px[1]}px) 밖입니다 — ` +
          `회귀선 외삽이므로 후보 크기를 넓혀 0단계를 다시 돌리는 것을 권합니다.`
        );
      }
      if (result.n_source_participants < 2) {
        warnings.push('참가자가 1명뿐입니다 — 명세서 3.2절은 2~3명을 요구합니다.');
      }

      document.getElementById('aggregateSelected').innerHTML =
        `선택된 크기 3종: <b>${result.selected_sizes_px.join(', ')}px</b>` +
        (result.min_gap_adjustment_applied ? ' (최소 4px 간격 보정 적용됨)' : '') +
        warnings.map((w) => `<br><span style="color:#b91c1c">경고: ${w}</span>`).join('');

      document.getElementById('aggregateResult').classList.remove('hidden');
    } catch (e) {
      alert('집계 실패: ' + e.message);
    }
  });

  document.getElementById('downloadPhase0ConfigBtn').addEventListener('click', () => {
    if (!lastAggregateResult) return;
    downloadJson('phase0_button_sizes.json', lastAggregateResult);
  });

  refreshStartButtonState();
});
