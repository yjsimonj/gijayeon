/* =====================================================================
 * experiment.js 자체 점검 — 브라우저·의존성 없이 순수 로직만 검사한다.
 *
 *   node tools/selftest.mjs
 *
 * 검사 항목
 *   1) 본실험 시퀀스: 600회 = 4방향 × 150, 100회 블록마다 25씩,
 *      학습 400 / 평가 200 어느 쪽으로 잘라도 방향 균형 (§4.2, §6)
 *   2) 휴식 배치: 워밍업 종료 1회 + 100회마다 1회
 *   3) 배치 기하: 거리 450px 고정, 시작·목표 원이 화면 안 (§4.1, §4.3)
 *   4) 로지스틱 적합: 알려진 곡선에서 65% 지점 크기를 되찾는가 (§4.2)
 *   5) 모드 A 집계: 목표 크기를 찾아내고 외삽을 경고하는가
 *   6) 스키마 정합: experiment.js 의 시행 레코드 키와
 *      analysis/make_dummy.py 가 만드는 키가 같은가
 *      (한쪽만 고치면 실험 다 하고 분석이 안 도는 사고가 난다 — §8-3)
 * ===================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (cond) {
    console.log(`  OK  ${label}`);
  } else {
    failures++;
    console.log(`  !!  ${label}${extra ? '  → ' + extra : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `기대 ${expected}, 실제 ${actual}`);
}

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, label, `기대 ${expected}±${tol}, 실제 ${actual}`);
}

/* ------------------- experiment.js 를 DOM 스텁 위에서 로드 ------------------- */

function loadExperiment(search = '') {
  const src = readFileSync(join(ROOT, 'static', 'experiment.js'), 'utf-8');

  const noop = () => {};
  const elementStub = {
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    removeChild: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, textContent: '', innerHTML: '', value: '', focus: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 900 }),
  };
  const documentStub = {
    getElementById: () => null,          // mount()가 실패해 MutationObserver 경로로 가게 한다
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: elementStub,
    body: elementStub,
    createElement: () => Object.assign({}, elementStub),
    fullscreenElement: null,
  };

  const win = {};
  const ctx = {
    window: win,
    document: documentStub,
    location: { search },
    navigator: { userAgent: 'selftest', platform: 'node' },
    performance: { now: () => Date.now() },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    URLSearchParams,
    Blob: class { constructor(parts) { this.size = String(parts[0] || '').length; } },
    alert: noop, confirm: () => true,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  new vm.Script(src, { filename: 'experiment.js' }).runInContext(ctx);
  return win.mouseExperiment;
}

/* ------------------------------- 1~2. 시퀀스 ------------------------------- */

console.log('\n[1] 본실험 시퀀스 (모드 B)');
const api = loadExperiment('');
const I = api._internal;
eq(api.devMode, false, 'dev 모드 아님 (?dev=1 없음)');

const specs = I.buildMainSpecs(12);
const warm = specs.filter((s) => s.warmup);
const main = specs.filter((s) => !s.warmup);

eq(warm.length, I.COUNTS.warmupMain, `워밍업 ${I.COUNTS.warmupMain}회`);
eq(main.length, I.COUNTS.main, `본시행 ${I.COUNTS.main}회`);

function countByDirection(list) {
  const c = new Map(I.DIRECTIONS_DEG.map((d) => [d, 0]));
  list.forEach((s) => c.set(s.direction, c.get(s.direction) + 1));
  return c;
}

const perDir = countByDirection(main);
ok([...perDir.values()].every((v) => v === I.COUNTS.main / 4),
  `4방향 각 ${I.COUNTS.main / 4}회`, JSON.stringify([...perDir]));

const train = main.filter((s) => s.mainIndex < I.COUNTS.trainSplit);
const test = main.filter((s) => s.mainIndex >= I.COUNTS.trainSplit);
eq(train.length, I.COUNTS.trainSplit, `학습 구간 ${I.COUNTS.trainSplit}회`);
eq(test.length, I.COUNTS.main - I.COUNTS.trainSplit, `평가 구간 ${I.COUNTS.main - I.COUNTS.trainSplit}회`);
ok([...countByDirection(train).values()].every((v) => v === I.COUNTS.trainSplit / 4),
  '학습 구간도 4방향 균등');
ok([...countByDirection(test).values()].every((v) => v === (I.COUNTS.main - I.COUNTS.trainSplit) / 4),
  '평가 구간도 4방향 균등');

const blocks = new Map();
main.forEach((s) => {
  if (!blocks.has(s.block)) blocks.set(s.block, []);
  blocks.get(s.block).push(s);
});
ok([...blocks.values()].every((b) => [...countByDirection(b).values()].every((v) => v === b.length / 4)),
  `블록(${I.COUNTS.restEvery}회)마다 4방향 균등`);

ok(main.every((s, i) => s.mainIndex === i), 'main_index가 0부터 연속');

console.log('\n[2] 휴식 배치');
const pauses = specs.filter((s) => s.pauseBefore);
eq(pauses.filter((s) => s.pauseBefore === 'warmup-end').length, 1, '워밍업 종료 화면 1회');
eq(pauses.filter((s) => s.pauseBefore === 'rest').length, I.COUNTS.main / I.COUNTS.restEvery - 1,
  `휴식 ${I.COUNTS.main / I.COUNTS.restEvery - 1}회 (마지막 블록 뒤에는 없음)`);
ok(pauses.every((s) => s.mainIndex % I.COUNTS.restEvery === 0), '휴식은 100회 경계에서만');

console.log('\n[2-1] dev 축소 모드');
const devApi = loadExperiment('?dev=1');
eq(devApi.devMode, true, '?dev=1 인식');
const devMain = devApi._internal.buildMainSpecs(12).filter((s) => !s.warmup);
eq(devMain.length, 20, '축소 모드 본시행 20회 (§8-2)');

/* ------------------------------- 3. 기하 ------------------------------- */

console.log('\n[3] 배치 기하 (거리 450px 고정, 화면 안)');
for (const [vw, vh] of [[1440, 900], [1200, 800], [1920, 1080], [2560, 1440]]) {
  for (const size of [8, 12, 32]) {
    let allOk = true;
    let detail = '';
    for (const deg of I.DIRECTIONS_DEG) {
      const L = I.computeLayout(size, deg, vw, vh);
      if (!L) { allOk = false; detail = `deg=${deg} 배치 불가`; break; }
      const d = Math.hypot(L.targetX - L.startX, L.targetY - L.startY);
      if (Math.abs(d - I.DISTANCE_PX) > 1e-6) { allOk = false; detail = `deg=${deg} 거리 ${d}`; break; }
      const sr = I.START_BUTTON_SIZE_PX / 2;
      const tr = size / 2;
      const inside =
        L.startX - sr >= 0 && L.startX + sr <= vw &&
        L.startY - sr >= I.TOP_CLEARANCE_PX && L.startY + sr <= vh &&
        L.targetX - tr >= 0 && L.targetX + tr <= vw &&
        L.targetY - tr >= I.TOP_CLEARANCE_PX && L.targetY + tr <= vh;
      if (!inside) {
        allOk = false;
        detail = `deg=${deg} 화면 밖: start=(${L.startX.toFixed(1)},${L.startY.toFixed(1)}) ` +
                 `target=(${L.targetX.toFixed(1)},${L.targetY.toFixed(1)})`;
        break;
      }
    }
    ok(allOk, `${vw}×${vh}, 버튼 ${size}px — 4방향 모두 표시 가능`, detail);
  }
}

// 가로 시행은 중앙에서 밀릴 이유가 없고, 900px 높이의 세로 시행은 밀려야 한다.
const hz = I.computeLayout(12, 0, 1440, 900);
const vt = I.computeLayout(12, 90, 1440, 900);
ok(!hz.shifted, '가로 시행: 시작 버튼이 화면 중앙 그대로');
ok(vt.shifted, '세로 시행: 시작 버튼이 밀림 (450px가 중앙에서 화면을 벗어나므로)');
near(vt.startY, 470, 1, '세로(위) 시행 시작 y ≈ 470 (1440×900)');
ok(Math.abs(vt.startY - hz.startY) < 20, '밀림량은 20px 미만', `${(vt.startY - hz.startY).toFixed(1)}px`);

// 배치가 불가능한 화면은 null 이어야 한다 (checkAllTrialsFit이 이걸 보고 막는다)
ok(I.computeLayout(12, 90, 1440, 400) === null, '너무 낮은 화면은 배치 불가(null) 반환');

/* --------------------------- 4~5. 로지스틱 / 집계 --------------------------- */

console.log('\n[4] 로지스틱 적합');
// 알려진 곡선 logit(p) = a + b·ln(size) 에서 뽑은 표본으로 65% 지점 크기를 되찾는가.
const A_TRUE = -4.0, B_TRUE = 1.7;
const trueSize65 = Math.exp((Math.log(0.65 / 0.35) - A_TRUE) / B_TRUE);
{
  const xs = [], ys = [];
  for (const size of I.CANDIDATE_SIZES_PX) {
    const p = 1 / (1 + Math.exp(-(A_TRUE + B_TRUE * Math.log(size))));
    for (let i = 0; i < 4000; i++) {
      xs.push(Math.log(size));
      ys.push(Math.random() < p ? 1 : 0);
    }
  }
  const fit = I.fitLogistic(xs, ys);
  near(fit.a, A_TRUE, 0.35, `절편 복원 (참값 ${A_TRUE})`);
  near(fit.b, B_TRUE, 0.15, `기울기 복원 (참값 ${B_TRUE})`);
  const got = Math.exp((Math.log(0.65 / 0.35) - fit.a) / fit.b);
  near(got, trueSize65, 1.0, `65% 지점 크기 복원 (참값 ${trueSize65.toFixed(2)}px)`);
}

console.log('\n[5] 모드 A 집계');
function fakeSizingDataset(pid, a, b, perSize = 20) {
  const trials = [];
  let idx = 0;
  for (let w = 0; w < 10; w++) {
    trials.push({ warmup: true, button_size_px: 12, click: { x: 0, y: 0 }, success: true, index: idx++ });
  }
  for (const size of I.CANDIDATE_SIZES_PX) {
    const p = 1 / (1 + Math.exp(-(a + b * Math.log(size))));
    for (let i = 0; i < perSize; i++) {
      trials.push({
        warmup: false, button_size_px: size, index: idx++,
        click: { x: 0, y: 0 }, success: Math.random() < p,
      });
    }
  }
  return { mode: 'sizing', participant_id: pid, trials };
}
{
  const res = I.aggregateSizing([
    fakeSizingDataset('S01', A_TRUE, B_TRUE, 200),
    fakeSizingDataset('S02', A_TRUE, B_TRUE, 200),
  ]);
  eq(res.per_size.length, I.CANDIDATE_SIZES_PX.length, '크기 5종 집계');
  ok(res.per_size.every((r) => r.n_trials === 400), '워밍업이 집계에서 제외됨 (크기당 400)');
  near(res.selected_size_px, trueSize65, 2, `산출 크기 ≈ ${trueSize65.toFixed(1)}px`);
  eq(res.target_success_rate, 0.65, '목표 성공률 65% (§4.2)');
  ok(res.warnings.length === 0, '경고 없음(참가자 2명·범위 안)', JSON.stringify(res.warnings));

  // 참가자 1명 + 성공률이 낮아 외삽이 필요한 경우 → 경고가 떠야 한다
  const bad = I.aggregateSizing([fakeSizingDataset('S01', -9.0, 2.0, 200)]);
  ok(bad.warnings.some((w) => w.includes('외삽')), '외삽 경고');
  ok(bad.warnings.some((w) => w.includes('1명')), '참가자 1명 경고');
}

/* ------------------------------ 6. 스키마 정합 ------------------------------ */

console.log('\n[6] 스키마 정합 — experiment.js ↔ make_dummy.py ↔ analyze.py');

// 시행 레코드의 최상위 키. 여기를 고치면 세 파일을 함께 고쳐야 한다.
const TRIAL_KEYS = [
  'index', 'main_index', 'warmup', 'block', 'direction_deg', 'button_size_px',
  'target', 'start', 'start_shifted', 't_start_click', 't_target_shown', 't_click',
  'click', 'rt_ms', 'timeout', 'no_response', 'success', 'error_x', 'error_y',
  'trajectory', 'sample_interval_median_ms', 'trajectory_span_ms',
  'n_trajectory_samples', 'drag_rejected',
];

// Windows에서 체크아웃하면 git이 줄바꿈을 CRLF로 바꿔 놓는다. 아래 마커에 \n 을
// 쓰므로, 읽을 때 LF로 정규화하지 않으면 블록을 못 찾는다(실제로 한 번 깨졌다).
const readSource = (p) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

function keysFromBlock(text, startMarker, endMarker, keyRegex) {
  const s = text.indexOf(startMarker);
  if (s < 0) return null;
  const e = text.indexOf(endMarker, s);
  if (e < 0) return null;
  const body = text.slice(s + startMarker.length, e);
  return body.split('\n')
    .map((line) => line.match(keyRegex))
    .filter(Boolean)
    .map((m) => m[1]);
}

const jsSrc = readSource(join(ROOT, 'static', 'experiment.js'));
// `click,` 처럼 축약 표기(shorthand)도 키다 — `:` 만 보면 놓친다.
const jsKeys = keysFromBlock(jsSrc, 'const record = {', '\n        };', /^ {10}([a-z_0-9]+)\s*[,:]/);
ok(jsKeys !== null, 'experiment.js 의 시행 레코드 블록을 찾음');

const pySrc = readSource(join(ROOT, 'analysis', 'make_dummy.py'));
const pyKeys = keysFromBlock(pySrc, '    return {\n        "index": index,', '\n    }',
  /^ {8}"([a-z_0-9]+)":/);
ok(pyKeys !== null, 'make_dummy.py 의 시행 dict 블록을 찾음');

if (jsKeys && pyKeys) {
  const pyAll = ['index', ...pyKeys];   // 시작 마커에 이미 포함된 첫 키
  const missingJs = TRIAL_KEYS.filter((k) => !jsKeys.includes(k));
  const extraJs = jsKeys.filter((k) => !TRIAL_KEYS.includes(k));
  const missingPy = TRIAL_KEYS.filter((k) => !pyAll.includes(k));
  const extraPy = pyAll.filter((k) => !TRIAL_KEYS.includes(k));
  ok(missingJs.length === 0, 'experiment.js 에 빠진 키 없음', missingJs.join(', '));
  ok(extraJs.length === 0, 'experiment.js 에 목록 밖 키 없음', extraJs.join(', '));
  ok(missingPy.length === 0, 'make_dummy.py 에 빠진 키 없음', missingPy.join(', '));
  ok(extraPy.length === 0, 'make_dummy.py 에 목록 밖 키 없음', extraPy.join(', '));
}

// analyze.py 가 실제로 읽는 키들이 스키마에 있는지 (오타 방지)
const anSrc = readSource(join(ROOT, 'analysis', 'analyze.py'));
for (const k of ['main_index', 'no_response', 'button_size_px', 'error_x', 'error_y', 'warmup', 'timeout']) {
  ok(anSrc.includes(`"${k}"`), `analyze.py 가 ${k} 를 참조`);
}
ok(anSrc.includes('cx"] - offset[0]') || anSrc.includes('rec["cx"] - offset[0]'),
  'analyze.py 의 보정은 빼기(−)  ← 부호 규약 §5');

/* --------------------------------- 결과 --------------------------------- */

console.log('\n' + '='.repeat(60));
if (failures === 0) {
  console.log(`통과: ${checks}개 검사 전부 OK`);
} else {
  console.log(`실패: ${failures} / ${checks}`);
}
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
