/* =====================================================================
 * 실험 앱 DOM 단위 무인 완주 시험 (선택 도구)
 *
 * 실제 브라우저 대신 jsdom 위에 실험 화면을 띄우고, 가상 마우스로 전 시행을
 * 클릭해 끝까지 완주시킨 뒤 나온 JSON을 검사한다. 계획서 §8-6("본인들 둘이 각각
 * 600회 완주")을 사람이 하기 전에 기계로 한 번 돌려보는 용도다.
 *
 * 함께 검증되는 것
 *   - Gradio 브리지(§3.3): #payload textarea + #trigger 를 실제로 놓고,
 *     value setter 우회가 정말로 값을 넘기는지 확인한다
 *   - 전체화면 이탈 → 재진입 시 해당 시행만 버리고 다시 제시하는지
 *   - 완료 화면의 다운로드 버튼이 예외 없이 동작하는지
 *   - 나온 레코드가 스키마·부호 규약(§5)에 맞는지
 *
 * jsdom 은 이 프로젝트의 의존성이 아니다. 쓰려면 아무 폴더에서
 *     npm install jsdom
 * 한 뒤 그 경로를 알려준다.
 *
 *   JSDOM_PATH=/경로/node_modules/jsdom node tools/e2e-jsdom.mjs
 *   node tools/e2e-jsdom.mjs --full          # 620시행 전체 (약 3분)
 *   node tools/e2e-jsdom.mjs --sizing        # 모드 A
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
const SIZING = argv.includes('--sizing');
const ABORT = argv.includes('--abort');          // 중단하고 저장 경로만 시험
const DROP_FS_AT = ABORT ? -1 : 6;               // 전체화면 이탈 → 재제시
const ABORT_AT = ABORT ? 5 : -1;
// 무응답(3000ms 무클릭) 경로. 3초가 걸리므로 축소 모드에서만 기본으로 켠다.
const NO_RESPONSE_AT = (FULL || ABORT || argv.includes('--no-no-response')) ? -1 : 8;

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
   <body class="mx-standalone">
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

// 뷰포트·화면 정보. jsdom 기본값(1024×768)은 §7 기준에 미달해 시작이 막힌다.
for (const [k, v] of Object.entries({ innerWidth: VW, innerHeight: VH, outerWidth: VW, outerHeight: VH })) {
  Object.defineProperty(window, k, { value: v, configurable: true });
}
Object.defineProperty(window, 'screen', {
  value: { width: VW, height: VH, availWidth: VW, availHeight: VH },
  configurable: true,
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
window.URL.createObjectURL = () => 'blob:selftest';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloadClicked++; };
let downloadClicked = 0;

window.alert = (m) => { alerts.push(String(m)); };
window.confirm = () => true;
const alerts = [];

// Gradio 쪽: #trigger 가 눌리면 파이썬 save() 대신 여기서 받아 검사한다
let received = null;
document.getElementById('trigger').addEventListener('click', () => {
  received = document.querySelector('#payload textarea').value;
});

/* ------------------------------ 앱 로드 ------------------------------ */

window.eval(js);   // runScripts:'outside-only' 이므로 DOM 안의 <script>는 실행되지 않는다

console.log(`\n[준비] 모드 ${SIZING ? 'A(sizing)' : 'B(main)'} · ${FULL ? '전체' : 'dev 축소'} · 뷰포트 ${VW}×${VH}`);
ok(!!window.mouseExperiment, 'experiment.js 로드');
ok(document.getElementById('mx-screen-setup').classList.contains('active'), '설정 화면이 활성');

const $ = (id) => document.getElementById(id);
function setValue(el, v) {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// 시작 차단 조건 (§7)
ok($('mx-start').disabled, '학번·이름·ID를 비운 채로는 시작 불가');
setValue($('mx-participant-id'), 'E2E01');
ok($('mx-start').disabled && $('mx-start-blocked').textContent.includes('학번'),
  '학번이 비어 있으면 막고 이유를 알려준다');
setValue($('mx-student-id'), '20231234');
ok($('mx-start').disabled && $('mx-start-blocked').textContent.includes('이름'),
  '이름이 비어 있으면 막고 이유를 알려준다');
setValue($('mx-name'), '홍길동');
setValue($('mx-participant-id'), 'P 03!');
ok($('mx-start').disabled && $('mx-start-blocked').textContent.includes('P03'),
  '쓸 수 없는 문자가 있으면 정리된 ID를 알려주고 막는다', $('mx-start-blocked').textContent);

function pickDevice(v) {
  const el = document.querySelector(`input[name="mx-device"][value="${v}"]`);
  el.checked = true;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
setValue($('mx-participant-id'), 'E2E01');
pickDevice('trackpad');
ok($('mx-start').disabled && !$('mx-trackpad-warn').classList.contains('mx-hidden'),
  '트랙패드 선택 시 경고 + 시작 차단');
$('mx-trackpad-ack').checked = true;
$('mx-trackpad-ack').dispatchEvent(new window.Event('change', { bubbles: true }));
ok(!$('mx-start').disabled, '확인란을 체크하면 진행 가능 (금지가 아니라 경고)');
$('mx-trackpad-ack').checked = false;
pickDevice('mouse');
if (SIZING) {
  const radio = document.querySelector('input[name="mx-mode"][value="sizing"]');
  radio.checked = true;
  radio.dispatchEvent(new window.Event('change', { bubbles: true }));
} else {
  setValue($('mx-button-size'), '12');
}
ok(!$('mx-start').disabled, '환경 점검 통과 → 시작 버튼 활성', $('mx-start-blocked').textContent);

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
  return {
    x: parseFloat(el.style.left) + size / 2,
    y: parseFloat(el.style.top) + size / 2,
    size,
  };
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
    // 클릭 후에도 다음 시행이 시작될 때까지 목표 요소가 화면에 남아 있으므로,
    // 같은 요소를 두 번 클릭하지 않도록 노드 동일성으로 걸러낸다.
    const c = centerOf(target);

    // 전체화면 이탈을 한 번 끼워 넣어 재제시 경로를 시험한다
    if (!fsDropped && clicked === DROP_FS_AT) {
      fsDropped = true;
      fsElement = null;
      document.dispatchEvent(new window.Event('fullscreenchange'));
      continue;
    }

    // 중단하고 저장: 이탈 화면에서 그만두면 여기까지의 시행만 담겨야 한다
    if (!aborted && clicked === ABORT_AT) {
      aborted = true;
      fsElement = null;
      document.dispatchEvent(new window.Event('fullscreenchange'));
      await sleep(30);
      $('mx-fs-abort').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      continue;
    }

    // 무응답: 3000ms 동안 클릭하지 않으면 no_response 로 기록되고 다음으로 넘어간다
    if (!noResponded && clicked === NO_RESPONSE_AT) {
      noResponded = true;
      lastTarget = target;      // 되돌아와서 같은 목표를 클릭하지 않도록
      await sleep(3300);
      continue;
    }

    // 목표 근처로 접근하는 궤적 + 살짝 어긋난 클릭 (편향 +1.5, -1.0 px)
    for (const f of [0.5, 0.8, 0.95]) {
      dispatchMouse('mousemove', c.x * f, c.y * f);
    }
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
  if (start) {
    start.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
}

/* ------------------------------ 검사 ------------------------------ */

console.log('\n[결과]');
ok($('mx-screen-done').classList.contains('active'), '완료 화면 도달');
ok(alerts.length === 0, '중간 경고창 없음', alerts.join(' / '));
if (!ABORT) ok(fsDropped, '전체화면 이탈을 한 번 끼워 넣었음');

ok(typeof received === 'string' && received.length > 0,
  'Gradio 브리지: #payload 로 빈 문자열이 아닌 값이 전달됨 (§3.3)');

let data = null;
try { data = JSON.parse(received); } catch (e) { /* 아래에서 실패로 잡힌다 */ }
ok(!!data, '전달된 값이 유효한 JSON');

if (data) {
  const expectWarmup = FULL ? (SIZING ? 10 : 20) : (SIZING ? 2 : 4);
  const expectMain = FULL ? (SIZING ? 100 : 600) : (SIZING ? 10 : 20);
  const main = data.trials.filter((t) => !t.warmup);
  const warm = data.trials.filter((t) => t.warmup);

  ok(data.schema_version === '3.0', 'schema_version 3.0');
  ok(data.mode === (SIZING ? 'sizing' : 'main'), `mode = ${SIZING ? 'sizing' : 'main'}`);
  ok(data.participant_id === 'E2E01', 'participant_id 기록');
  ok(data.participant && data.participant.student_id === '20231234' && data.participant.name === '홍길동',
    '학번·이름이 원본 JSON에 기록됨');
  const saveText = $('mx-save-status').textContent;   // "파일명: main_E2E01_....json" 포함
  ok(saveText.includes('파일명:') && !saveText.includes('20231234') && !saveText.includes('홍길동'),
    '학번·이름은 파일명에 들어가지 않음', saveText);
  ok(data.trials.every((t, i) => t.index === i), 'index 연속');
  ok(main.every((t, i) => t.main_index === i), 'main_index 연속 (버린 시행이 번호를 비우지 않음)');
  ok(pauses > 0, `휴식/연습종료 화면 ${pauses}회 통과`);

  if (ABORT) {
    // 중단하고 저장 — 여기까지의 시행만, aborted 표시와 함께 남아야 한다
    ok(data.aborted === true, 'aborted = true 로 기록');
    ok(data.trials.length === ABORT_AT, `중단 시점까지 ${ABORT_AT}시행만 담김`,
      `실제 ${data.trials.length}`);
    ok((data.session_events || []).some((e) => e.type === 'session_end' && e.detail.aborted),
      'session_events 에 중단 기록');
    ok(warm.length <= expectWarmup, '워밍업이 전부 끝나기 전에도 저장 가능');
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
    ok(!!nr && nr.click === null && nr.rt_ms === null && nr.error_x === null && nr.error_y === null,
      '무응답 시행: click·rt_ms·error 가 null');
    ok(!!nr && nr.success === false && nr.timeout === true,
      '무응답 시행: success=false, timeout=true');
    ok(!!nr && nr.trajectory.length >= 2, '무응답 시행도 궤적은 남는다');
    ok(main.length === expectMain, '무응답 시행도 본시행 수에 포함 (재제시하지 않음)');
    ok(answered.length === main.length - noResp.filter((t) => !t.warmup).length,
      '무응답을 뺀 나머지는 모두 클릭됨');
  } else {
    ok(noResp.length === 0, '무응답 없음 (가상 마우스는 항상 클릭)');
    ok(answered.length === main.length, '본시행 전부 클릭됨');
  }

  // 부호 규약(§5): error = click − target. 클릭을 (+1.5, −1.0) 어긋나게 했으므로
  // error_x ≈ +1.5, error_y ≈ −1.0 이 나와야 한다.
  const ex = answered.map((t) => t.error_x);
  const ey = answered.map((t) => t.error_y);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  ok(Math.abs(mean(ex) - 1.5) < 0.2, `error_x 평균 ≈ +1.5 (실제 ${mean(ex).toFixed(2)})`);
  ok(Math.abs(mean(ey) + 1.0) < 0.2, `error_y 평균 ≈ −1.0 (실제 ${mean(ey).toFixed(2)})`);
  ok(answered.every((t) => Math.abs(t.error_x - (t.click.x - t.target.x)) < 1e-6 &&
                           Math.abs(t.error_y - (t.click.y - t.target.y)) < 1e-6),
    'error_x/y = click − target 로 계산됨');
  ok(answered.every((t) => t.success === (Math.hypot(t.error_x, t.error_y) <= t.button_size_px / 2)),
    'success = 중심에서 반지름 이내');

  // 거리·방향
  ok(main.every((t) => Math.abs(Math.hypot(t.target.x - t.start.x, t.target.y - t.start.y) - 450) < 0.2),
    '모든 시행의 이동 거리 450px');
  const dirs = new Map([0, 90, 180, 270].map((d) => [d, 0]));
  main.forEach((t) => dirs.set(t.direction_deg, dirs.get(t.direction_deg) + 1));
  // 방향은 휴식 블록(100회) 안에서 균등 배분된다. 본실험은 100/4 = 25로 정확히
  // 나뉘어 전체도 정확히 균등해지지만, dev 축소 모드는 블록이 10회라 ±1이 남는다.
  // (블록 균등 자체는 tools/selftest.mjs 가 본실험 설정으로 정확히 검사한다)
  // 중단 모드는 본시행이 몇 개 없어 균등을 볼 수 없으므로 건너뛴다.
  if (!ABORT) {
    const tol = FULL ? 0 : 1;
    ok([...dirs.values()].every((v) => Math.abs(v - main.length / 4) <= tol),
      `4방향 균등 (허용 ±${tol})`, JSON.stringify([...dirs]));
  }
  const up = data.trials.find((t) => t.direction_deg === 90);
  ok(!!up && up.target.y < up.start.y, '90° 는 위쪽 (target.y < start.y)');

  // 궤적 형식 §3.5
  ok(main.every((t) => Array.isArray(t.trajectory) && t.trajectory.length >= 2),
    '궤적 샘플 2개 이상');
  ok(main.every((t) => t.trajectory.every((p) => Array.isArray(p) && p.length === 3)),
    '궤적은 [t, x, y] 숫자 배열 (객체 배열이 아님)');
  ok(main.every((t) => t.trajectory[0][0] === 0), '궤적 첫 샘플 t = 0 (목표 등장 시각 기준)');
  ok(main.every((t) => t.trajectory.every((p) =>
    Math.abs(p[1] * 10 - Math.round(p[1] * 10)) < 1e-9 &&
    Math.abs(p[2] * 10 - Math.round(p[2] * 10)) < 1e-9)),
    '좌표는 소수점 첫째 자리로 반올림');

  // 타이밍 (무응답 시행은 rt_ms·t_click 이 null 이므로 클릭이 있는 시행만 본다)
  ok(answered.every((t) => t.rt_ms !== null && t.rt_ms >= 0), 'rt_ms 기록');
  ok(answered.every((t) => t.timeout === (t.rt_ms > 750)), 'timeout 은 750ms 초과일 때만');
  ok(answered.every((t) => t.t_click >= t.t_target_shown), 't_click ≥ t_target_shown');

  if (!SIZING) {
    ok(data.config.train_split === (FULL ? 400 : 12), 'config.train_split 기록');
    ok(main.every((t) => t.button_size_px === 12), '버튼 크기 고정 12px');
  } else {
    ok(new Set(main.map((t) => t.button_size_px)).size === 5, '모드 A는 후보 5종 사용');
  }

  ok(data.environment.inner_width === VW && data.environment.inner_height === VH,
    'environment 에 뷰포트 기록');
  ok(data.environment.input_device === 'mouse', 'environment 에 입력 장치 기록');
}

// 완료 화면 다운로드 버튼
$('mx-download-json').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(downloadClicked > 0, '완료 화면 다운로드 버튼 동작 (§3.4)');
ok($('mx-save-status').textContent.length > 0, '저장 상태 문구 표시');
ok(Object.keys(window.localStorage).some((k) => k.startsWith('mxexp:')), 'localStorage 백업 저장');

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? `통과: ${checks}개 검사 전부 OK (${clicked}시행 완주)`
                           : `실패: ${failures} / ${checks}`);
console.log('='.repeat(60));

dom.window.close();
process.exit(failures === 0 ? 0 : 1);
