/* =====================================================================
 * 실험 앱 무인 완주 시험 (선택 도구)
 *
 * 실제 브라우저 대신 jsdom 위에 실험 화면을 띄우고, 가상 마우스로 전 시행을
 * 클릭해 끝까지 완주시킨 뒤 나온 JSON을 검사한다. 계획서 §8-6("본인들 둘이 각각
 * 600회 완주")을 사람이 하기 전에 기계로 한 번 돌려보는 용도다.
 *
 * 함께 검증되는 것
 *   - 파이썬 통로(§3.3): #payload textarea + #trigger 를 실제로 놓고,
 *     value setter 우회가 정말로 값을 넘기는지 (빈 문자열로 넘어가면 조용히 실패)
 *   - 전체화면 이탈 → 진행 중이던 시행만 버리고 다시 제시하는지
 *   - 무응답(3000ms), 중단하고 저장
 *   - 부호 규약·거리·방향·궤적 형식·타이밍
 *
 * jsdom 은 이 프로젝트의 의존성이 아니다. 쓰려면 아무 폴더에서 `npm install jsdom`
 * 한 뒤 그 경로를 알려준다.
 *
 *   JSDOM_PATH=/경로/node_modules/jsdom node tools/e2e-jsdom.mjs
 *   node tools/e2e-jsdom.mjs --full     # 620시행 전체 (약 3분)
 *   node tools/e2e-jsdom.mjs --abort    # 중단하고 저장 경로
 * ===================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const ABORT = argv.includes('--abort');
const DROP_FS_AT = ABORT ? -1 : 6;                    // 전체화면 이탈 → 재제시
const ABORT_AT = ABORT ? 5 : -1;
// 무응답(3000ms 무클릭)은 3초가 걸리므로 축소 모드에서만 기본으로 켠다.
const NO_RESPONSE_AT = (FULL || ABORT) ? -1 : 8;

let JSDOM;
try {
  ({ JSDOM } = require(process.env.JSDOM_PATH || 'jsdom'));
} catch (e) {
  console.log('jsdom 이 없어 이 시험은 건너뜁니다.');
  console.log('  npm install jsdom   후');
  console.log('  JSDOM_PATH=<...>/node_modules/jsdom node tools/e2e-jsdom.mjs');
  process.exit(0);
}

let failures = 0;
let checks = 0;
function ok(cond, label, extra) {
  checks++;
  console.log(`  ${cond ? 'OK ' : '!! '} ${label}${cond || !extra ? '' : '  → ' + extra}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 문서 구성 ------------------------------ */

const css = readFileSync(join(ROOT, 'static', 'experiment.css'), 'utf-8');
const fragment = readFileSync(join(ROOT, 'static', 'experiment.html'), 'utf-8');
const js = readFileSync(join(ROOT, 'static', 'experiment.js'), 'utf-8');

const VW = 1440;
const VH = 900;

const dom = new JSDOM(
  `<!DOCTYPE html><html><head><style>${css}</style></head>
   <body>
     ${fragment}
     <div id="payload"><textarea></textarea></div>
     <button id="trigger"></button>
   </body></html>`,
  {
    url: `http://localhost/${FULL ? '' : '?dev=1'}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  }
);

const { window } = dom;
const { document } = window;

// 뷰포트·화면 정보 (jsdom 기본값 1024×768은 최대 500px 시행에 모자란다)
for (const [k, v] of Object.entries({ innerWidth: VW, innerHeight: VH, outerWidth: VW, outerHeight: VH })) {
  Object.defineProperty(window, k, { value: v, configurable: true });
}
Object.defineProperty(window, 'screen', {
  value: { width: VW, height: VH, availWidth: VW, availHeight: VH }, configurable: true,
});
Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });

// 전체화면 스텁
let fsElement = null;
Object.defineProperty(document, 'fullscreenElement', { get: () => fsElement, configurable: true });
Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
window.HTMLElement.prototype.requestFullscreen = function () {
  fsElement = this;
  document.dispatchEvent(new window.Event('fullscreenchange'));
  return Promise.resolve();
};
document.exitFullscreen = () => {
  fsElement = null;
  document.dispatchEvent(new window.Event('fullscreenchange'));
  return Promise.resolve();
};

// 다운로드 스텁 (jsdom 은 createObjectURL 미구현)
let downloadClicked = 0;
window.URL.createObjectURL = () => 'blob:selftest';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloadClicked++; };

const alerts = [];
window.alert = (m) => { alerts.push(String(m)); };
window.confirm = () => true;

// 파이썬 쪽: #trigger 가 눌리면 save() 대신 여기서 받아 검사한다
let received = null;
document.getElementById('trigger').addEventListener('click', () => {
  received = document.querySelector('#payload textarea').value;
});

window.eval(js);   // runScripts:'outside-only' 이므로 DOM 안의 <script>는 실행되지 않는다

console.log(`\n[준비] ${FULL ? '전체 620시행' : 'dev 축소'}${ABORT ? ' · 중단 시험' : ''} · 뷰포트 ${VW}×${VH}`);
ok(!!window.mouseExperiment, 'experiment.js 로드');
ok(document.getElementById('mx-screen-setup').classList.contains('active'), '설정 화면이 활성');

const $ = (id) => document.getElementById(id);
function setValue(el, v) {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// 시작 차단 조건
ok($('mx-start').disabled, '학번·이름·ID를 비운 채로는 시작 불가');
setValue($('mx-participant-id'), 'E2E01');
ok($('mx-start').disabled && $('mx-start-blocked').textContent.includes('학번'), '학번이 비면 막는다');
setValue($('mx-student-id'), '20231234');
ok($('mx-start').disabled && $('mx-start-blocked').textContent.includes('이름'), '이름이 비면 막는다');
setValue($('mx-name'), '홍길동');
setValue($('mx-button-size'), '12');
ok(!$('mx-start').disabled, '전부 채우면 시작 가능', $('mx-start-blocked').textContent);

/* ------------------------------ 완주 구동 ------------------------------ */

const stage = () => $('mx-stage');
const visible = (el) => !el.classList.contains('mx-hidden');

function dispatchMouse(type, x, y) {
  stage().dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
  }));
}

function centerOf(el) {
  const size = parseFloat(el.style.width);
  return { x: parseFloat(el.style.left) + size / 2, y: parseFloat(el.style.top) + size / 2 };
}

let clicked = 0;
let pauses = 0;
let fsDropped = false;
let aborted = false;
let noResponded = false;
let lastTarget = null;

$('mx-start').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const deadline = Date.now() + (FULL ? 8 * 60 * 1000 : 90 * 1000);
while (!$('mx-screen-done').classList.contains('active')) {
  if (Date.now() > deadline) {
    ok(false, '제한 시간 안에 완주', `${clicked}시행에서 멈춤`);
    break;
  }
  await sleep(8);

  if (visible($('mx-overlay-fs'))) {
    $('mx-fs-reenter').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    continue;
  }
  if (visible($('mx-overlay-pause'))) {
    pauses++;
    $('mx-pause-resume').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    continue;
  }

  const target = stage().querySelector('.mx-stim.mx-target');
  if (target && target !== lastTarget) {
    // 클릭 후에도 다음 시행이 시작될 때까지 목표가 화면에 남으므로 노드 동일성으로 걸러낸다
    const c = centerOf(target);

    if (!fsDropped && clicked === DROP_FS_AT) {
      fsDropped = true;
      fsElement = null;
      document.dispatchEvent(new window.Event('fullscreenchange'));
      continue;
    }

    if (!aborted && clicked === ABORT_AT) {
      aborted = true;
      fsElement = null;
      document.dispatchEvent(new window.Event('fullscreenchange'));
      await sleep(30);
      $('mx-fs-abort').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      continue;
    }

    if (!noResponded && clicked === NO_RESPONSE_AT) {
      noResponded = true;
      lastTarget = target;
      await sleep(3300);      // 3000ms 무클릭 → no_response
      continue;
    }

    // 목표로 접근하는 궤적 + 살짝 어긋난 클릭 (편향 +1.5, −1.0 px)
    for (const f of [0.5, 0.8, 0.95]) dispatchMouse('mousemove', c.x * f, c.y * f);
    const cx = c.x + 1.5;
    const cy = c.y - 1.0;
    dispatchMouse('mousemove', cx, cy);
    dispatchMouse('mousedown', cx, cy);
    dispatchMouse('mouseup', cx, cy);
    lastTarget = target;
    clicked++;
    continue;
  }

  const start = stage().querySelector('.mx-stim:not(.mx-target)');
  if (start) start.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/* ------------------------------ 검사 ------------------------------ */

console.log('\n[결과]');
ok($('mx-screen-done').classList.contains('active'), '완료 화면 도달');
ok(alerts.length === 0, '중간 경고창 없음', alerts.join(' / '));
if (!ABORT) ok(fsDropped, '전체화면 이탈을 한 번 끼워 넣었음');

ok(typeof received === 'string' && received.length > 0,
  '파이썬 통로로 빈 문자열이 아닌 값이 전달됨 (§3.3)');

let data = null;
try { data = JSON.parse(received); } catch (e) { /* 아래에서 실패로 잡힌다 */ }
ok(!!data, '전달된 값이 유효한 JSON');

if (data) {
  const expectWarmup = FULL ? 20 : 4;
  const expectMain = FULL ? 600 : 20;
  const main = data.trials.filter((t) => !t.warmup);
  const warm = data.trials.filter((t) => t.warmup);

  ok(data.schema_version === '3.0', 'schema_version 3.0');
  ok(data.mode === 'main', 'mode = main');
  ok(data.participant_id === 'E2E01', 'participant_id 기록');
  ok(data.participant.student_id === '20231234' && data.participant.name === '홍길동',
    '학번·이름이 JSON에 기록됨');
  ok(data.trials.every((t, i) => t.index === i), 'index 연속');
  ok(main.every((t, i) => t.main_index === i), 'main_index 연속 (버린 시행이 번호를 비우지 않음)');
  ok(pauses > 0, `휴식/연습종료 화면 ${pauses}회 통과`);

  if (ABORT) {
    ok(data.aborted === true, 'aborted = true 로 기록');
    ok(data.trials.length === ABORT_AT, `중단 시점까지 ${ABORT_AT}시행만 담김`, `실제 ${data.trials.length}`);
    ok((data.session_events || []).some((e) => e.type === 'session_end' && e.detail.aborted),
      'session_events 에 중단 기록');
  } else {
    ok(data.aborted === false, 'aborted = false');
    ok(warm.length === expectWarmup, `워밍업 ${expectWarmup}회`, `실제 ${warm.length}`);
    ok(main.length === expectMain, `본시행 ${expectMain}회`, `실제 ${main.length}`);
    ok((data.session_events || []).some((e) => e.type === 'fullscreen_lost'),
      '전체화면 이탈이 session_events 에 기록됨');
  }

  const answered = main.filter((t) => t.click);
  const noResp = data.trials.filter((t) => t.no_response);
  if (NO_RESPONSE_AT >= 0) {
    ok(noResp.length === 1, '무응답 시행이 1건 기록됨', `실제 ${noResp.length}`);
    const nr = noResp[0];
    ok(!!nr && nr.click === null && nr.rt_ms === null && nr.error_x === null,
      '무응답 시행: click·rt_ms·error 가 null');
    ok(!!nr && nr.success === false && nr.timeout === true, '무응답 시행: success=false, timeout=true');
    ok(!!nr && nr.trajectory.length >= 2, '무응답 시행도 궤적은 남는다');
    ok(main.length === expectMain, '무응답 시행도 본시행 수에 포함 (재제시하지 않음)');
  } else {
    ok(noResp.length === 0, '무응답 없음 (가상 마우스는 항상 클릭)');
  }

  // 부호 규약(§5): error = click − target. (+1.5, −1.0) 어긋나게 클릭했다.
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  ok(Math.abs(mean(answered.map((t) => t.error_x)) - 1.5) < 0.2,
    `error_x 평균 ≈ +1.5 (실제 ${mean(answered.map((t) => t.error_x)).toFixed(2)})`);
  ok(Math.abs(mean(answered.map((t) => t.error_y)) + 1.0) < 0.2,
    `error_y 평균 ≈ −1.0 (실제 ${mean(answered.map((t) => t.error_y)).toFixed(2)})`);
  ok(answered.every((t) => Math.abs(t.error_x - (t.click.x - t.target.x)) < 1e-6 &&
                           Math.abs(t.error_y - (t.click.y - t.target.y)) < 1e-6),
    'error_x/y = click − target 로 계산됨');
  ok(answered.every((t) => t.success === (Math.hypot(t.error_x, t.error_y) <= t.button_size_px / 2)),
    'success = 중심에서 반지름 이내');

  // 거리·방향 — 시행마다 다르게 뽑히므로 "기록된 거리와 실제 거리가 맞는가"를 본다
  ok(main.every((t) => Math.abs(
      Math.hypot(t.target.x - t.start.x, t.target.y - t.start.y) - t.distance_px) < 0.3),
    '기록된 distance_px 가 실제 start→target 거리와 일치');
  const dists = main.map((t) => t.distance_px);
  ok(dists.every((d) => d >= 249.9 && d <= 500.1), 'distance_px 가 250~500px 범위 안',
    `${Math.min(...dists).toFixed(0)}~${Math.max(...dists).toFixed(0)}`);
  ok(new Set(dists).size > dists.length * 0.8, '거리가 시행마다 다르다 (고정이 아님)',
    `${new Set(dists).size}종 / ${dists.length}시행`);
  ok(new Set(main.map((t) => `${t.start.x},${t.start.y}`)).size > main.length * 0.8,
    '시작점이 시행마다 다르다 — 학습·평가가 같은 기하를 공유하지 않는다',
    `${new Set(main.map((t) => `${t.start.x},${t.start.y}`)).size}종`);
  if (!ABORT) {
    // 방향은 블록마다 원을 층화 추출한다 → 합벡터가 0에 가까워야 한다
    const cx = main.reduce((s, t) => s + Math.cos(t.direction_deg * Math.PI / 180), 0) / main.length;
    const cy = main.reduce((s, t) => s + Math.sin(t.direction_deg * Math.PI / 180), 0) / main.length;
    ok(Math.hypot(cx, cy) < (FULL ? 0.08 : 0.35), '방향이 한쪽으로 치우치지 않음',
      `합벡터 ${Math.hypot(cx, cy).toFixed(3)}`);
    const q = [0, 0, 0, 0];
    main.forEach((t) => { q[Math.floor((((t.direction_deg % 360) + 360) % 360) / 90)]++; });
    ok(q.every((v) => v > 0), '네 사분면 모두 등장', JSON.stringify(q));
  }
  // 방향 규약: 목표 = 시작 + (cos θ, −sin θ)·거리. 부호를 놓치면 위아래가 뒤집힌다.
  ok(main.every((t) => {
    const rad = t.direction_deg * Math.PI / 180;
    return Math.abs(t.target.x - (t.start.x + Math.cos(rad) * t.distance_px)) < 0.3 &&
           Math.abs(t.target.y - (t.start.y - Math.sin(rad) * t.distance_px)) < 0.3;
  }), '방향 규약 dy = −sin θ (0°=오른쪽, 90°=위)');

  // 궤적 형식 §3.5
  ok(main.every((t) => Array.isArray(t.trajectory) && t.trajectory.length >= 2), '궤적 샘플 2개 이상');
  ok(main.every((t) => t.trajectory.every((p) => Array.isArray(p) && p.length === 3)),
    '궤적은 [t, x, y] 숫자 배열 (객체 배열이 아님)');
  ok(main.every((t) => t.trajectory[0][0] === 0), '궤적 첫 샘플 t = 0 (목표 등장 기준)');
  ok(main.every((t) => t.trajectory.every((p) =>
    Math.abs(p[1] * 10 - Math.round(p[1] * 10)) < 1e-9 &&
    Math.abs(p[2] * 10 - Math.round(p[2] * 10)) < 1e-9)), '좌표는 소수점 첫째 자리');

  // 타이밍 (무응답은 rt_ms·t_click 이 null 이므로 클릭이 있는 시행만)
  ok(answered.every((t) => t.rt_ms !== null && t.rt_ms >= 0), 'rt_ms 기록');
  ok(answered.every((t) => t.timeout === (t.rt_ms > 750)), 'timeout 은 750ms 초과일 때만');
  ok(answered.every((t) => t.t_click >= t.t_target_shown), 't_click ≥ t_target_shown');

  ok(data.config.train_split === (FULL ? 400 : 12), 'config.train_split 기록');
  ok(main.every((t) => t.button_size_px === 12), '버튼 크기 고정 12px (화면에서 12로 입력했다)');
  ok(data.environment.inner_width === VW && data.environment.inner_height === VH,
    'environment 에 뷰포트 기록');
}

// 예비 다운로드 버튼
$('mx-download-json').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(downloadClicked > 0, '완료 화면의 “JSON 직접 받기” 동작 (§3.4)');
ok($('mx-save-status').textContent.length > 0, '저장 상태 문구 표시');

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? `통과: ${checks}개 검사 전부 OK (${clicked}시행 완주)`
                           : `실패: ${failures} / ${checks}`);
console.log('='.repeat(60));

dom.window.close();
process.exit(failures === 0 ? 0 : 1);
