/* =====================================================================
 * experiment.js 자체 점검 — 브라우저·의존성 없이 순수 로직만 검사한다.
 *
 *   node tools/selftest.mjs
 *
 * 검사 항목
 *   1) 시퀀스: 600회, 방향·거리를 시행마다 층화 무작위. 학습 400 / 평가 200 어느
 *      쪽으로 잘라도 방향·거리 구성이 균형 (어긋나면 §6이 "개인 편향" 대신
 *      "구성 차이"를 잰다)
 *   2) 휴식 배치: 워밍업 종료 1회 + 100회마다 1회
 *   3) 배치 기하: 거리가 범위 안, 시작점이 흩어지고, 두 원이 화면 안
 *   4) 스키마 정합: experiment.js 의 시행 레코드 키와 analysis/make_dummy.py 가
 *      만드는 키가 같은가 — 한쪽만 고치면 실험 다 하고 분석이 안 도는 사고가 난다
 *   5) CSS 다크 테마 방어: 글자색을 요소별로 못박았는가 — 상속에 맡기면 Gradio
 *      다크 테마에서 흰 패널에 흰 글씨가 된다
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

// Windows에서 체크아웃하면 git이 줄바꿈을 CRLF로 바꿔 놓는다. 아래 마커에 \n 을
// 쓰므로, 읽을 때 LF로 정규화하지 않으면 블록을 못 찾는다(실제로 한 번 깨졌다).
const readSource = (p) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

/* ------------------- experiment.js 를 DOM 스텁 위에서 로드 ------------------- */

function loadExperiment(search = '') {
  const noop = () => {};
  const documentStub = {
    getElementById: () => null,     // mount()가 실패해 MutationObserver 경로로 가게 한다
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    documentElement: { addEventListener: noop },
    body: { classList: { add: noop, remove: noop } },
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop } }),
    fullscreenElement: null,
    fullscreenEnabled: true,
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
    setTimeout, clearTimeout,
    console,
    URLSearchParams,
    Blob: class { constructor(parts) { this.size = String(parts[0] || '').length; } },
    alert: noop, confirm: () => true,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  new vm.Script(readSource(join(ROOT, 'static', 'experiment.js')),
    { filename: 'experiment.js' }).runInContext(ctx);
  return win.mouseExperiment;
}

/* ------------------------------- 1~2. 시퀀스 ------------------------------- */

console.log('\n[1] 시행 시퀀스');
const api = loadExperiment('');
const I = api._internal;
eq(api.devMode, false, 'dev 모드 아님 (?dev=1 없음)');

const specs = I.buildSpecs(12);
const warm = specs.filter((s) => s.warmup);
const main = specs.filter((s) => !s.warmup);

eq(warm.length, I.COUNTS.warmup, `워밍업 ${I.COUNTS.warmup}회`);
eq(main.length, I.COUNTS.main, `본시행 ${I.COUNTS.main}회`);

// 방향·거리가 연속값이 되었으므로 "각 방향 몇 회"가 아니라 층화가 실제로 균형을
// 만들어 내는지를 본다. §6은 학습 벡터를 평가 시행에 그대로 적용하므로, 두 구간의
// 방향·거리 구성이 어긋나면 "개인 편향"이 아니라 "구성 차이"를 재게 된다.

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const dirMean = (list) => ({
  cos: mean(list.map((s) => Math.cos((s.direction * Math.PI) / 180))),
  sin: mean(list.map((s) => Math.sin((s.direction * Math.PI) / 180))),
});
const quadrants = (list) => {
  const q = [0, 0, 0, 0];
  list.forEach((s) => { q[Math.floor(((s.direction % 360) + 360) % 360 / 90)]++; });
  return q;
};

const train = main.filter((s) => s.mainIndex < I.COUNTS.trainSplit);
const test = main.filter((s) => s.mainIndex >= I.COUNTS.trainSplit);
eq(train.length, I.COUNTS.trainSplit, `학습 구간 ${I.COUNTS.trainSplit}회`);
eq(test.length, I.COUNTS.main - I.COUNTS.trainSplit, `평가 구간 ${I.COUNTS.main - I.COUNTS.trainSplit}회`);

// 이전 설계는 방향이 4종뿐이라 목표가 화면상 4곳에만 나왔다. 지금은 시행마다
// 새로 뽑으므로 방향이 수백 종이어야 한다. (0.1°로 반올림하므로 600개 중 몇 개는
// 우연히 겹친다 — 3600개 값에서 600번 뽑는 생일문제. 거리·시작점이 다르면 기하가
// 같은 것이 아니므로 방향 중복 자체는 문제가 아니다.)
ok(new Set(main.map((s) => s.direction)).size > main.length * 0.8,
  `방향이 수백 종 (4종 고정이 아님)`,
  `${new Set(main.map((s) => s.direction)).size}종 / ${main.length}시행`);
// 완전 일치를 요구하면 안 된다. 방향 3600값 · 거리 2500값으로 반올림하므로 600시행
// 이면 둘 다 우연히 같은 쌍이 약 2% 확률로 생긴다(생일문제) — 실제로 40회 중 1회
// 걸렸다. 게다가 시작점은 따로 뽑으므로 그 경우에도 기하는 다르다. 재려는 것은
// "같은 조합이 반복 사용되지 않는가" 이므로 거의 전부 고유하면 된다.
const pairs = new Set(main.map((s) => `${s.direction}@${s.distance}`)).size;
ok(pairs >= main.length - 3, '(방향, 거리) 조합이 거의 전부 고유 (반올림 충돌 3개까지 허용)',
  `${pairs}종 / ${main.length}시행`);

// 층화 추출이면 방향 합벡터가 0에 가깝다 = 어느 방향으로도 치우치지 않았다
for (const [label, list] of [['본시행 전체', main], ['학습 구간', train], ['평가 구간', test]]) {
  const m = dirMean(list);
  ok(Math.hypot(m.cos, m.sin) < 0.08, `${label}: 방향이 한쪽으로 치우치지 않음`,
    `합벡터 크기 ${Math.hypot(m.cos, m.sin).toFixed(3)}`);
}

// 사분면 배분도 균등해야 한다 (블록 층화의 결과)
for (const [label, list] of [['학습 구간', train], ['평가 구간', test]]) {
  const q = quadrants(list);
  const expect = list.length / 4;
  ok(q.every((v) => Math.abs(v - expect) <= Math.max(2, expect * 0.15)),
    `${label}: 사분면 배분 균등`, JSON.stringify(q));
}

// 거리도 범위 안에서 균등해야 하고, 두 구간의 평균이 어긋나면 안 된다
const [dLo, dHi] = I.DISTANCE_RANGE_PX;
ok(main.every((s) => s.distance >= dLo - 0.1 && s.distance <= dHi + 0.1),
  `거리가 ${dLo}~${dHi}px 범위 안`,
  `실제 ${Math.min(...main.map((s) => s.distance)).toFixed(0)}~${Math.max(...main.map((s) => s.distance)).toFixed(0)}`);
near(mean(train.map((s) => s.distance)), (dLo + dHi) / 2, 12, '학습 구간 평균 거리가 범위 중앙');
near(mean(test.map((s) => s.distance)), (dLo + dHi) / 2, 18, '평가 구간 평균 거리가 범위 중앙');

const blocks = new Map();
main.forEach((s) => {
  if (!blocks.has(s.block)) blocks.set(s.block, []);
  blocks.get(s.block).push(s);
});
ok([...blocks.values()].every((b) => {
  const m = dirMean(b);
  return Math.hypot(m.cos, m.sin) < 0.25;
}), `블록(${I.COUNTS.restEvery}회)마다 방향이 원을 고르게 덮는다`);

ok(main.every((s, i) => s.mainIndex === i), 'main_index가 0부터 연속');
ok(main.every((s) => s.size === 12) && warm.every((s) => s.size === 12), '버튼 크기 1종 고정');

// 화면의 기본 버튼 크기와 JS 기본값이 어긋나면, 참가자가 보는 숫자와 실제로 쓰이는
// 값이 달라진다 — bind() 가 JS 값으로 덮어쓰므로 화면 쪽이 거짓말을 한다.
const jsDefault = readSource(join(ROOT, 'static', 'experiment.js'))
  .match(/DEFAULT_BUTTON_SIZE_PX\s*=\s*(\d+)/);
const htmlDefault = readSource(join(ROOT, 'static', 'experiment.html'))
  .match(/id="mx-button-size"[^>]*value="(\d+)"/);
ok(jsDefault !== null && htmlDefault !== null, '기본 버튼 크기를 두 파일에서 찾음');
if (jsDefault && htmlDefault) {
  eq(htmlDefault[1], jsDefault[1], `기본 버튼 크기가 HTML·JS 일치 (${jsDefault[1]}px)`);
}

console.log('\n[2] 휴식 배치');
const pauses = specs.filter((s) => s.pauseBefore);
eq(pauses.filter((s) => s.pauseBefore === 'warmup-end').length, 1, '워밍업 종료 화면 1회');
eq(pauses.filter((s) => s.pauseBefore === 'rest').length, I.COUNTS.main / I.COUNTS.restEvery - 1,
  `휴식 ${I.COUNTS.main / I.COUNTS.restEvery - 1}회 (마지막 블록 뒤에는 없음)`);
ok(pauses.every((s) => s.mainIndex % I.COUNTS.restEvery === 0), '휴식은 블록 경계에서만');

console.log('\n[2-1] dev 축소 모드');
const devApi = loadExperiment('?dev=1');
eq(devApi.devMode, true, '?dev=1 인식');
eq(devApi._internal.buildSpecs(12).filter((s) => !s.warmup).length, 20, '축소 모드 본시행 20회');

/* ------------------------------- 3. 기하 ------------------------------- */

console.log('\n[3] 배치 기하 (거리는 시행마다 다름, 시작점 무작위, 둘 다 화면 안)');
const [DLO, DHI] = I.DISTANCE_RANGE_PX;
for (const [vw, vh] of [[1440, 900], [1200, 800], [1920, 1080], [2560, 1440]]) {
  for (const size of [8, 12, 20, 32]) {   // 20 = 화면 기본값
    let allOk = true;
    let detail = '';
    // 무작위 시작점이므로 한 번만 보면 안 된다. 방향·거리·추첨을 두루 훑는다.
    outer:
    for (let deg = 0; deg < 360; deg += 7) {
      for (const dist of [DLO, (DLO + DHI) / 2, DHI]) {
        for (let rep = 0; rep < 3; rep++) {
          const L = I.computeLayout(size, deg, dist, vw, vh);
          if (!L) { allOk = false; detail = `deg=${deg} dist=${dist} 배치 불가`; break outer; }
          const d = Math.hypot(L.targetX - L.startX, L.targetY - L.startY);
          if (Math.abs(d - dist) > 1e-6) { allOk = false; detail = `deg=${deg} 거리 ${d}`; break outer; }
          const sr = I.START_BUTTON_SIZE_PX / 2;
          const tr = size / 2;
          const inside =
            L.startX - sr >= 0 && L.startX + sr <= vw &&
            L.startY - sr >= I.TOP_CLEARANCE_PX && L.startY + sr <= vh &&
            L.targetX - tr >= 0 && L.targetX + tr <= vw &&
            L.targetY - tr >= I.TOP_CLEARANCE_PX && L.targetY + tr <= vh;
          if (!inside) {
            allOk = false;
            detail = `deg=${deg} dist=${dist} 화면 밖: start=(${L.startX.toFixed(1)},${L.startY.toFixed(1)}) ` +
                     `target=(${L.targetX.toFixed(1)},${L.targetY.toFixed(1)})`;
            break outer;
          }
        }
      }
    }
    ok(allOk, `${vw}×${vh}, 버튼 ${size}px — 방향 52종 × 거리 3종 모두 표시 가능`, detail);
  }
}

// 시작점이 실제로 흩어지는가. 고정이면 학습·평가가 같은 기하를 공유하게 된다.
const samples = Array.from({ length: 200 }, () => I.computeLayout(20, 30, 300, 1440, 900));
ok(samples.every(Boolean), '표본 배치가 모두 성립');
const xs = samples.map((L) => L.startX);
const ys = samples.map((L) => L.startY);
const spread = (a) => Math.max(...a) - Math.min(...a);
ok(spread(xs) > 100 && spread(ys) > 100,
  '같은 방향·거리라도 시작점이 넓게 흩어진다',
  `x 폭 ${spread(xs).toFixed(0)}px, y 폭 ${spread(ys).toFixed(0)}px`);
ok(new Set(xs.map((v) => v.toFixed(3))).size > 190, '시작점이 매번 새로 뽑힌다');

// 배치 불가 조건은 그대로 막아야 한다
ok(I.computeLayout(20, 90, DHI, 1440, 400) === null, '너무 낮은 화면은 배치 불가(null) 반환');
ok(I.computeLayout(20, 90, 5000, 1440, 900) === null, '화면보다 긴 거리는 배치 불가(null) 반환');

/* ------------------------------ 4. 스키마 정합 ------------------------------ */

console.log('\n[4] 스키마 정합 — experiment.js ↔ make_dummy.py ↔ analyze.py');

// 시행 레코드의 최상위 키. 여기를 고치면 세 파일을 함께 고쳐야 한다.
const TRIAL_KEYS = [
  'index', 'main_index', 'warmup', 'block', 'direction_deg', 'button_size_px',
  'target', 'start', 'distance_px', 't_start_click', 't_target_shown', 't_click',
  'click', 'rt_ms', 'timeout', 'no_response', 'success', 'error_x', 'error_y',
  'trajectory', 'sample_interval_median_ms', 'trajectory_span_ms',
  'n_trajectory_samples', 'drag_rejected', 'stray_rejected',
];

function keysFromBlock(text, startMarker, endMarker, keyRegex) {
  const s = text.indexOf(startMarker);
  if (s < 0) return null;
  const e = text.indexOf(endMarker, s);
  if (e < 0) return null;
  return text.slice(s + startMarker.length, e).split('\n')
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

const anSrc = readSource(join(ROOT, 'analysis', 'analyze.py'));
for (const k of ['main_index', 'no_response', 'button_size_px', 'error_x', 'error_y', 'warmup', 'timeout']) {
  ok(anSrc.includes(`"${k}"`), `analyze.py 가 ${k} 를 참조`);
}
ok(anSrc.includes('rec["cx"] - offset[0]'), 'analyze.py 의 보정은 빼기(−) ← 부호 규약 §5');

/* ------------------------ 5. CSS 다크 테마 방어 ------------------------ */

// Gradio 다크 테마는 h1·p·label 같은 맨 요소에 color 를 직접 건다. CSS 상속은
// 어떤 직접 규칙에도 지므로 #mx-app 에 color 를 한 번 주는 것으로는 자손 글자색이
// 정해지지 않는다 — 흰 패널에 흰 글씨가 되어 설정 화면을 읽을 수 없었다.
// 요소별로 못박은 규칙이 남아 있는지 여기서 지킨다.

console.log('\n[5] CSS 다크 테마 방어 (흰 패널에 흰 글씨 재발 방지)');
const cssSrc = readSource(join(ROOT, 'static', 'experiment.css'));

// 선택자 목록만 뽑는다 (선언 블록 안의 색 값과 섞이지 않게)
const selectors = cssSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')          // 주석 제거
  .split('}')
  .map((chunk) => chunk.split('{')[0].trim())
  .filter(Boolean);
const hasSelector = (needle) => selectors.some((s) => s.includes(needle));

ok(/#mx-app\s*\{[^}]*color-scheme:\s*light/.test(cssSrc),
  '#mx-app 에 color-scheme: light (네이티브 폼 컨트롤까지 밝게)');

for (const el of ['h1', 'h2', 'p', 'label', 'div', 'span', 'code']) {
  ok(hasSelector(`#mx-app ${el}`), `#mx-app ${el} 에 색을 직접 지정`);
}

// 색 선언은 !important 여야 한다. Gradio 규칙이 !important 를 쓰는 경우까지 이긴다.
const textBlock = cssSrc.match(/#mx-app h1,[\s\S]*?\}/);
ok(textBlock !== null && /!important/.test(textBlock[0]),
  '기본 글자색 선언이 !important');

// 보조 문구는 #mx-app div 보다 우선순위가 높아야 한다 (ID+클래스 > ID+요소)
for (const cls of ['.mx-hint', '.mx-warn', '.mx-bad']) {
  ok(hasSelector(`#mx-app ${cls}`), `${cls} 도 #mx-app 접두사로 지정`);
}

// 오버레이는 어두운 배경 위 흰 글씨 — 위의 기본 글자색에 덮이면 안 된다
ok(hasSelector('#mx-app .mx-overlay div'), '오버레이 안 글자색을 다시 흰색으로 잡음');
ok(/#mx-app \.mx-overlay p \{[^}]*#e5e7eb\s*!important/.test(cssSrc),
  '오버레이 본문은 밝은 회색 유지');

// 자극(원)의 대비는 실험 과제 자체다
ok(/#mx-app \.mx-stim\.mx-target \{[^}]*background:\s*#2563eb\s*!important/.test(cssSrc),
  '목표 버튼 색이 테마에 흔들리지 않게 못박음');

// Gradio 전용 규칙은 app.py 쪽에 있어야 한다 (experiment.css 는 로컬에서도 쓴다)
const appSrc = readSource(join(ROOT, 'app.py'));
ok(/gradio-app|\.gradio-container/.test(appSrc) && !/gradio-container/.test(cssSrc),
  'Gradio 전용 배경 규칙은 app.py 에만 (experiment.css 는 프레임워크 중립)');

/* --------------------------------- 결과 --------------------------------- */

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? `통과: ${checks}개 검사 전부 OK` : `실패: ${failures} / ${checks}`);
console.log('='.repeat(60));
process.exit(failures === 0 ? 0 : 1);
