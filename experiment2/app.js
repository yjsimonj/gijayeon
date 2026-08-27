/* =====================================================================
 * UI 인식 vs AI 궤적 예측 비교 실험 — app.js (phase 1: UI 인식만)
 *
 * 방향 전환 배경: experiment/(v1 WebGazer, v2 MediaPipe)에서 웹캠 시선추적을
 * 실측한 결과 머리 자세 변화에 취약해 구역 판별조차 불안정 → 시선 신호는
 * 이번 비교에서 뺀다. 대신 두 접근을 비교한다.
 *   (1) UI 인식: DOM 버튼 중 클릭 시점에 가장 가까운 버튼을 고른다.
 *   (2) AI(궤적 학습): 클릭 직전 구간의 마우스 궤적으로 의도 버튼을 예측한다.
 *       → phase 2에서 구현. 지금은 궤적 원자료(raw, 리샘플 전)만 매 시행 기록해 둔다.
 *
 * 가설: 버튼이 떨어져 있는 "일반 배치(A)"에서는 UI 인식이 유리하고,
 *       버튼이 다닥다닥 붙은 "밀집 배치(B, 북마크바형)"에서는 최근접 규칙이
 *       애매해져(동률·오분류) AI가 유리할 것으로 예상 — 이 파일은 그 근거가 될
 *       "UI 인식 단독 성능"을 두 배치 모두에서 측정한다.
 *
 * 좌표계: 모든 좌표는 뷰포트(clientX/clientY) 기준. #stage 는 top:40px 이므로
 *          stage 내부 좌표(레이아웃 생성 시 쓰는 cx/cy) = client 좌표 - stageRect.top/left.
 *
 * 안전성(오보정)은 이번 phase 1에서 의도적으로 안 본다: C-UI는 반경 제한 없이
 * 항상 가장 가까운 버튼 하나를 고른다(= "멀어서 보정 포기"가 없음). 이건 순수
 * 판별력만 보기 위한 선택이고, 실사용 안전장치가 필요한지는 phase 2 이후 과제다.
 * 대신 역효과율(원클릭은 맞았는데 보정이 틀리게 만든 비율)이 안전성의 일부를
 * 대리 지표로 보여준다 — 하지만 "멀리 있는 클릭을 억지로 보정하다 생기는 위험"
 * 자체는 이 지표에 안 잡힌다는 점에 주의.
 * ===================================================================== */
'use strict';

/* ------------------------------------------------------------------ */
/* 0. 전역 상태                                                         */
/* ------------------------------------------------------------------ */
const App = {
  pid: null,
  cfg: {
    repsPerCellA: 2,       // 시나리오 A(일반 배치) 셀당 반복 수
    repsPerCellB: 4,       // 시나리오 B(밀집 배치)는 역효과·동률이 드문 사건일 수 있어 A보다 더 많이 반복
    scenarios: ['A','B'],
    conditions: ['C0','C-UI'],
    // 시나리오 A(일반 배치) — experiment/ v1과 동일한 파라미터
    sizes: { small:26, large:60 },       // 버튼 한 변(px)
    dists: { near:260, far:560 },        // home→target 목표 거리(px)
    nDistractorsA: 5,
    // 시나리오 B(밀집 배치·북마크바형) — 신규
    iconSizes: { small:22, large:34 },   // 아이콘 한 변(px)
    gaps: { tight:2, loose:12 },         // 아이콘 사이 간격(px)
    nBookmarks: 12,
    // 공통
    timeLimitMs: 900,
  },
  trials: [],
  runSeq: 0,
  running: false,
  abort: false,
};

/* localStorage 복원 */
try {
  const saved = JSON.parse(localStorage.getItem('mc2_trials') || '[]');
  if (Array.isArray(saved)) App.trials = saved;
} catch (e) {}

/* ------------------------------------------------------------------ */
/* 1. 유틸                                                              */
/* ------------------------------------------------------------------ */
const CONDLABEL = { 'C0':'보정 없음', 'C-UI':'UI 인식(최근접)' };
const SCENLABEL = { A:'일반 배치', B:'밀집 배치(북마크바)' };
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const now = () => performance.now();
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const rand = (a,b) => a + Math.random()*(b-a);
const mean = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : NaN;
const shuffle = arr => { for(let i=arr.length-1;i>0;i--){const j=(Math.random()*(i+1))|0;[arr[i],arr[j]]=[arr[j],arr[i]];} return arr; };
const fmt = (v, d=1) => (v==null||Number.isNaN(v)) ? '–' : (+v).toFixed(d);
function pidSeed(pid){ let s=0; for (const ch of (pid||'')) s=(s+ch.charCodeAt(0))%997; return s; }

function stageRectPx(){ return $('#stage').getBoundingClientRect(); }

/* ------------------------------------------------------------------ */
/* 2. UI 인식 (이번 단계의 핵심 구현)                                    */
/*    규칙: 후보 버튼 전체 중, 클릭 지점에서 사각형까지의 거리가          */
/*    가장 가까운 버튼 하나를 고른다. 반경 제한 없음 — 항상 하나 고른다.  */
/*    점이 사각형 내부면 거리 0 (= 직접 클릭한 경우도 이 함수 하나로 처리).*/
/* ------------------------------------------------------------------ */
function pointToRectDist(p, R){
  const dx = Math.max(R.left - p.x, 0, p.x - R.right);
  const dy = Math.max(R.top  - p.y, 0, p.y - R.bottom);
  return Math.hypot(dx, dy);
}
function pointInRect(p, R){ return p.x>=R.left && p.x<=R.right && p.y>=R.top && p.y<=R.bottom; }

/* buttons: [{id, rect:{left,top,right,bottom,cx,cy}}]
 * 반환: { id, dist, secondId, secondDist }
 * "동률"을 여기서 하나의 임계값으로 판정하지 않는다 — 1위·2위 거리(dist, secondDist)를
 * 원본 그대로 넘겨서, 어느 임계값에서 동률로 볼지는 분석 시점(summarize)에서
 * 자유롭게 정하도록 한다. (이전엔 0.5px 고정 임계값을 여기서 판정했는데, 밀집 배치처럼
 * 버튼이 수십 px 붙어 있는 상황에서도 사람이 "애매하다"고 느끼는 거리차는 훨씬 크므로
 * 하나로 못 박으면 안 됨 — 거리차 자체를 저장해 사후에 여러 임계값을 시도할 수 있게 한다.) */
function recognizeUI(p, buttons){
  let best=null, bd=Infinity, second=null, sd=Infinity;
  for (const b of buttons){
    const d = pointToRectDist(p, b.rect);
    if (d < bd){ second=best; sd=bd; best=b; bd=d; }
    else if (d < sd){ second=b; sd=d; }
  }
  return { id: best?best.id:null, dist:bd, secondId: second?second.id:null, secondDist:sd };
}

/* ------------------------------------------------------------------ */
/* 3. 자극 배치 / 시행 생성                                             */
/* ------------------------------------------------------------------ */
/* 시나리오 A — 일반 배치: home에서 지정 거리·각도에 표적, 주변 링에 방해 버튼.
 * experiment/ v1의 layoutTrial()과 동일한 로직. */
function layoutSpaced(spec){
  const r = stageRectPx();
  const size = App.cfg.sizes[spec.size];
  const homeSize = 44;
  const home = { x:r.width/2, y:r.height-70, w:homeSize, h:homeSize };
  const D = App.cfg.dists[spec.dist];
  let target=null;
  for (let tries=0; tries<40; tries++){
    const ang = rand(-Math.PI*0.9, -Math.PI*0.1);
    const cx = home.x + Math.cos(ang)*D;
    const cy = home.y + Math.sin(ang)*D;
    const m = size/2 + 20;
    if (cx>m && cx<r.width-m && cy>m && cy<r.height-m){ target={cx,cy,w:size,h:size}; break; }
  }
  if (!target){ target = { cx:r.width/2, cy:r.height*0.35, w:size, h:size }; }

  const distractors=[];
  const N = App.cfg.nDistractorsA;
  const ring = size + rand(26, 46);
  for (let i=0;i<N;i++){
    const a = (i/N)*Math.PI*2 + rand(-0.2,0.2);
    const cx = clamp(target.cx + Math.cos(a)*ring, size, r.width-size);
    const cy = clamp(target.cy + Math.sin(a)*ring, size, r.height-size);
    distractors.push({ cx, cy, w:size, h:size });
  }
  return { home, target, distractors, size };
}

/* 시나리오 B — 밀집 배치(북마크바형): 화면 상단에 작은 버튼들을 간격 거의 없이
 * 한 줄로 붙여 놓는다. 그중 하나가 표적. 나머지는 layoutSpaced와 같은 모양의
 * {home, target, distractors, size} 구조로 반환해 아래 공통 파이프라인을 그대로 탄다. */
function layoutDense(spec){
  const r = stageRectPx();
  const homeSize = 44;
  const home = { x:r.width/2, y:r.height-70, w:homeSize, h:homeSize };
  const n = App.cfg.nBookmarks;
  const iconSize = App.cfg.iconSizes[spec.size];
  const gap = App.cfg.gaps[spec.gap];
  const totalW = n*iconSize + (n-1)*gap;
  const barY = 100;
  const startX = clamp((r.width - totalW)/2, iconSize, r.width-iconSize);
  const icons=[];
  for (let i=0;i<n;i++){
    const cx = startX + i*(iconSize+gap) + iconSize/2;
    icons.push({ cx, cy:barY, w:iconSize, h:iconSize });
  }
  const targetIdx = (Math.random()*n)|0;
  const target = icons[targetIdx];
  const distractors = icons.filter((_,i)=>i!==targetIdx);
  return { home, target, distractors, size:iconSize };
}

function layoutTrial(spec){ return spec.scenario==='B' ? layoutDense(spec) : layoutSpaced(spec); }

/* 본실험 시행 목록 생성: 시나리오 × 조건 블록 × (크기×dist|gap×시간) 셀 × 반복.
 * 조건 블록 순서는 참가자 번호 기반 회전(counterbalancing). */
function buildMainTrials(){
  const times = ['none','limited'];
  const scens = App.cfg.scenarios.length ? App.cfg.scenarios : ['A','B'];
  const conds = App.cfg.conditions.length ? App.cfg.conditions : ['C0','C-UI'];
  const seed = pidSeed(App.pid);
  const condOrder = conds.length ? conds.slice(seed % conds.length).concat(conds.slice(0, seed % conds.length)) : conds;

  const trials=[];
  for (const scenario of scens){
    const reps = scenario==='A' ? App.cfg.repsPerCellA : App.cfg.repsPerCellB;
    for (const cond of condOrder){
      let cells=[];
      if (App.cfg.quickMode){
        const hardCell = scenario==='A'
          ? { size:'small', dist:'far', time:'limited' }
          : { size:'small', gap:'tight', time:'limited' };
        for (let k=0;k<8;k++) cells.push({ ...hardCell });
      } else if (scenario==='A'){
        for (const size of ['small','large']) for (const d of ['near','far']) for (const t of times)
          for (let k=0;k<reps;k++) cells.push({ size, dist:d, time:t });
        shuffle(cells);
      } else {
        for (const size of ['small','large']) for (const g of ['tight','loose']) for (const t of times)
          for (let k=0;k<reps;k++) cells.push({ size, gap:g, time:t });
        shuffle(cells);
      }
      for (const c of cells) trials.push({ scenario, cond, ...c });
    }
  }
  return trials;
}

/* ------------------------------------------------------------------ */
/* 4. 보정 엔진 — C0(무보정) / C-UI(최근접 스냅, 반경 제한 없음)          */
/* ------------------------------------------------------------------ */
function candidateButtons(layout){
  const r = stageRectPx();
  const toRect = (c)=>({ left:r.left+c.cx-c.w/2, top:r.top+c.cy-c.h/2, right:r.left+c.cx+c.w/2, bottom:r.top+c.cy+c.h/2, cx:r.left+c.cx, cy:r.top+c.cy, w:c.w, h:c.h });
  const list = [{ id:'target', rect:toRect(layout.target) }];
  layout.distractors.forEach((d,i)=> list.push({ id:'d'+i, rect:toRect(d) }));
  return list;
}

function applyCorrection(cond, rawClick, layout){
  const buttons = candidateButtons(layout);
  const rawHit = buttons.find(b=>pointInRect(rawClick,b.rect));
  const result = { corrected:{...rawClick}, chosen: rawHit?rawHit.id:null, applied:false };

  if (cond === 'C0') return result;   // 무보정: 원 클릭 그대로. 직접 맞힌 게 없으면 miss(null).

  if (cond === 'C-UI'){
    const rec = recognizeUI(rawClick, buttons);   // 항상 하나 고름(반경 제한 없음)
    const chosenBtn = buttons.find(b=>b.id===rec.id);
    result.corrected = { x:chosenBtn.rect.cx, y:chosenBtn.rect.cy };
    result.chosen = rec.id;
    result.applied = true;
    result.recDist = rec.dist;              // 선택된(1위) 버튼까지 거리
    result.secondRecDist = rec.secondDist;  // 2위 버튼까지 거리
    result.distGap = isFinite(rec.secondDist) ? (rec.secondDist - rec.dist) : null;  // 사후 동률 판정용 원자료
    return result;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 5. 시행 실행 (한 trial)                                              */
/* ------------------------------------------------------------------ */
function runTrial(spec, index, total, phase){
  return new Promise(resolve => {
    const stage = $('#stage');
    stage.querySelectorAll('.stimBtn').forEach(e=>e.remove());
    $('#clickMark').classList.add('hidden');
    $('#corrMark').classList.add('hidden');
    $('#trialMsg').textContent='';
    const timeBar=$('#timeBar'), timeBarFill=$('#timeBarFill');
    timeBar.classList.add('hidden');
    timeBarFill.style.transition='none';
    timeBarFill.style.width='0%';

    const layout = layoutTrial(spec);
    const r = stageRectPx();

    const mkBtn = (c, cls, label, bid) => {
      const el = document.createElement('button');
      el.className = 'stimBtn '+cls;
      el.style.width=c.w+'px'; el.style.height=c.h+'px';
      el.style.left=(c.cx - c.w/2)+'px'; el.style.top=(c.cy - c.h/2)+'px';
      if (label) el.textContent=label;
      if (bid) el.dataset.bid = bid;
      stage.appendChild(el);
      return el;
    };
    const homeEl = mkBtn(layout.home, 'home', 'HOME');

    let phaseState = 'await-home';
    let targetShownT=0, firstMoveT=0, movedSince=false;
    const traj=[];   // 원자료(raw) 궤적: 리샘플·구간자르기는 AI 단계(phase 2)에서 분석 시점에 수행.

    const onMove = (e)=>{
      if (phaseState!=='show-target') return;
      if (!movedSince){ firstMoveT=now(); movedSince=true; }
      traj.push({ x:e.clientX, y:e.clientY, t:now() });
    };
    stage.addEventListener('mousemove', onMove);

    homeEl.addEventListener('click', (e)=>{
      if (phaseState!=='await-home') return;
      e.stopPropagation();
      homeEl.remove();
      phaseState='fixation';
      const fx=$('#fixation'); fx.classList.remove('hidden');
      fx.style.left=layout.home.x+'px'; fx.style.top=(layout.home.y-4)+'px';
      setTimeout(()=>{ fx.classList.add('hidden'); showTarget(); }, 350);
    });
    $('#trialMsg').textContent = 'HOME 을 클릭해 시작';
    $('#trialMsg').style.color = '';

    function showTarget(){
      phaseState='show-target';
      $('#trialMsg').textContent='';
      mkBtn(layout.target, 'target', '●', 'target');
      layout.distractors.forEach((d,i)=> mkBtn(d, '', '', 'd'+i));
      targetShownT=now(); movedSince=false;
      if (spec.time==='limited'){
        timeLimitTimer = setTimeout(()=> finalize(null, true), App.cfg.timeLimitMs);
        // 시간압박을 눈에 보이게: 막대가 제한시간 동안 0%→100%로 차오르다가 꽉 차면 시간 초과.
        // "클릭하고 나서야 초과 여부를 아는" 게 아니라, 채워지는 걸 보면서 그 전에 눌러야 하게.
        timeBar.classList.remove('hidden');
        timeBarFill.style.transition='none';
        timeBarFill.style.width='0%';
        void timeBarFill.offsetWidth;   // 강제 리플로우 — transition 없이 0%로 세팅된 걸 확정시킴
        timeBarFill.style.transition=`width ${App.cfg.timeLimitMs}ms linear`;
        timeBarFill.style.width='100%';
      }
    }
    let timeLimitTimer=null;

    const onStageClick = (e)=>{
      if (phaseState!=='show-target') return;
      finalize({ x:e.clientX, y:e.clientY }, false);
    };
    stage.addEventListener('click', onStageClick);

    function finalize(rawClick, timeout){
      if (phaseState==='clicked') return;
      phaseState='clicked';
      const clickT=now();
      if (timeLimitTimer) clearTimeout(timeLimitTimer);
      stage.removeEventListener('click', onStageClick);
      stage.removeEventListener('mousemove', onMove);
      timeBar.classList.add('hidden');
      timeBarFill.style.transition='none';
      timeBarFill.style.width='0%';

      const buttons = candidateButtons(layout);
      const targetBtn = buttons[0];
      const targetCenter = { x:targetBtn.rect.cx, y:targetBtn.rect.cy };

      const rec = (timeout || !rawClick) ? { corrected:null, chosen:null, applied:false } : applyCorrection(spec.cond, rawClick, layout);

      const rawHitBtn = rawClick ? buttons.find(b=>pointInRect(rawClick,b.rect)) : null;
      const rawHit = rawHitBtn ? rawHitBtn.id : null;
      const chosen = rec.chosen;
      const hit = chosen === 'target';
      // 역효과(misdirect): 원클릭이 애초에 어떤 버튼 안에도 없었는데(rawHit==null, 즉
      // 아무것도 안 눌렸을 상황), 보정이 그걸 표적이 아닌 다른 버튼으로 확정해서 눌러버린 경우.
      // "클릭 실패"보다 "엉뚱한 버튼을 확신 있게 눌러버림"이 더 나쁘다는 기준.
      // (이전엔 "원클릭이 표적이었는데 보정이 틀어버린 경우"로 정의했는데, 버튼이 겹치지 않는
      // 배치에서는 원클릭이 표적 안이면 표적까지 거리가 항상 0=유일한 최솟값이라 그 경우가
      // 논리적으로 절대 발생하지 않았음 — 즉 그 정의로는 역효과율이 구조적으로 항상 0%.)
      const misdirect = !!rec.applied && rawHit==null && chosen!=='target';

      const errVec = rawClick ? { x:rawClick.x-targetCenter.x, y:rawClick.y-targetCenter.y } : null;
      const errDist = errVec ? Math.hypot(errVec.x, errVec.y) : null;
      const effPoint = rec.corrected || rawClick;
      const effErrX = effPoint ? effPoint.x-targetCenter.x : null;
      const effErrY = effPoint ? effPoint.y-targetCenter.y : null;
      const effErrDist = effPoint ? Math.hypot(effErrX, effErrY) : null;

      const trial = {
        pid: App.pid, phase, ts: Date.now(), runId: App.runSeq,
        index, scenario: spec.scenario, cond: spec.cond,
        size: spec.size, distance: spec.dist ?? null, gap: spec.gap ?? null, timePressure: spec.time,
        timeout: !!timeout,
        rawClick, corrected: rec.corrected, targetCenter,
        rawErrX: errVec?errVec.x:null, rawErrY: errVec?errVec.y:null, rawErrDist: errDist,
        effErrX, effErrY, effErrDist,
        rawHit, chosen, hit, misdirect,
        correctionApplied: rec.applied,
        recDist: rec.recDist ?? null, secondRecDist: rec.secondRecDist ?? null, distGap: rec.distGap ?? null,
        rt: (firstMoveT&&targetShownT)? (firstMoveT-targetShownT):null,
        mt: rawClick? (clickT - (firstMoveT||targetShownT)):null,
        targetShownT, clickT: rawClick?clickT:null,
        traj,   // [{x,y,t}] — AI(phase 2) 학습용 원자료. t는 performance.now() 기준(같은 세션 내 상대비교용).
        trajLen: traj.length,
      };
      App.trials.push(trial);
      persist();

      const tEl = stage.querySelector('.stimBtn.target');
      if (tEl) tEl.classList.add('reveal-correct');
      if (chosen && chosen!=='target'){
        const cEl = stage.querySelector(`.stimBtn[data-bid="${chosen}"]`);
        if (cEl) cEl.classList.add('reveal-chosen');
      }
      if (rawClick){ const m=$('#clickMark'); m.classList.remove('hidden'); m.style.left=(rawClick.x-r.left)+'px'; m.style.top=(rawClick.y-r.top)+'px'; }
      if (rec.corrected){ const m=$('#corrMark'); m.classList.remove('hidden'); m.style.left=(rec.corrected.x-r.left)+'px'; m.style.top=(rec.corrected.y-r.top)+'px'; }

      const gapTxt = rec.distGap!=null ? ` · 다음 후보와 ${fmt(rec.distGap,1)}px 차이` : '';
      let why;
      if (timeout) why = '시간 초과';
      else if (spec.cond==='C0') why = '원클릭 그대로(무보정 조건)';
      else if (misdirect) why = 'UI 인식이 틀린 버튼으로(역효과)' + gapTxt;
      else why = 'UI 인식이 표적으로 스냅' + gapTxt;
      $('#trialMsg').textContent = (timeout ? '시간 초과' : (hit? '적중' : '빗나감')) + ' · ' + why;
      $('#trialMsg').style.color = timeout? '#f5b544' : (hit? '#39c07d':'#ff6b6b');

      updateStatusbar(index+1, total, spec.scenario, spec.cond);
      setTimeout(()=>{ resolve(trial); }, 480);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 6. 단계 실행기                                                       */
/* ------------------------------------------------------------------ */
async function runBlock(trialSpecs, phaseLabel){
  App.runSeq++;
  enterStage();
  App.running=true; App.abort=false;
  updateStatusbar(0, trialSpecs.length, trialSpecs[0]?.scenario||'–', trialSpecs[0]?.cond||'–');
  for (let i=0;i<trialSpecs.length;i++){
    if (App.abort) break;
    await runTrial(trialSpecs[i], i, trialSpecs.length, phaseLabel);
  }
  App.running=false;
  leaveStage();
  if (!App.abort){ go('results'); renderResults(); }
  else go('menu');
}
async function startMain(){ await runBlock(buildMainTrials(), 'main'); }

/* ------------------------------------------------------------------ */
/* 7. 화면 전환 / 상태바                                                */
/* ------------------------------------------------------------------ */
function go(name){
  $$('.screen').forEach(s=>s.classList.remove('active'));
  const map={ menu:'#scr-menu', results:'#scr-results' };
  const el=$(map[name]||'#scr-menu'); el.classList.add('active');
  $('#statusbar').classList.toggle('hidden', name==='menu');
  if (name==='menu'){ updateDataCount(); }
}
function enterStage(){ $('#stage').classList.remove('hidden'); $$('.screen').forEach(s=>s.classList.remove('active')); $('#statusbar').classList.remove('hidden'); }
function leaveStage(){ $('#stage').classList.add('hidden'); }
function updateStatusbar(done, total, scenario, cond){
  $('#sbPid').textContent = App.pid||'–';
  if (scenario!==undefined) $('#sbScen').textContent = SCENLABEL[scenario] || scenario;
  if (cond!==undefined) $('#sbCond').textContent = CONDLABEL[cond] || cond;
  if (total!==undefined) $('#sbProg').textContent=`${done} / ${total}`;
}
function updateDataCount(){ $('#dataCount').textContent=`기록된 시행 ${App.trials.length}건`; }

/* ------------------------------------------------------------------ */
/* 8. 저장 / 내보내기                                                   */
/* ------------------------------------------------------------------ */
function persist(){ try{ localStorage.setItem('mc2_trials', JSON.stringify(App.trials)); }catch(e){} updateDataCount(); }
function download(name, text, type='application/json'){
  const blob=new Blob([text],{type}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function exportJSON(){
  const payload={ meta:{ exportedAt:new Date().toISOString(), pid:App.pid, cfg:App.cfg }, trials:App.trials };
  download(`uiai_${App.pid||'data'}_${Date.now()}.json`, JSON.stringify(payload,null,2));
}
function exportCSV(){
  // traj는 CSV에 담기 부적합(가변길이 배열)해서 JSON 내보내기에서만 포함. CSV는 요약 지표 위주.
  const cols=['pid','phase','index','scenario','cond','size','distance','gap','timePressure','timeout',
    'rawErrX','rawErrY','rawErrDist','effErrX','effErrY','effErrDist','rawHit','chosen','hit','misdirect',
    'correctionApplied','recDist','secondRecDist','distGap','rt','mt','trajLen','ts'];
  const esc=v=> v==null?'':(typeof v==='object'?JSON.stringify(v):String(v));
  const lines=[cols.join(',')];
  for (const t of App.trials) lines.push(cols.map(c=>esc(t[c])).join(','));
  download(`uiai_${App.pid||'data'}_${Date.now()}.csv`, lines.join('\n'), 'text/csv');
}

/* ------------------------------------------------------------------ */
/* 9. 결과 / 분석                                                       */
/* ------------------------------------------------------------------ */
/* tieThresholdPx: "1위·2위 후보 거리차가 이 값 이하면 동률로 친다"는 판정을
 * 여기(분석 시점)에서만 적용한다. 원본 distGap을 그대로 저장해뒀기 때문에
 * 이 값을 결과 화면에서 자유롭게 바꿔가며 동률률이 어떻게 변하는지 볼 수 있다. */
function summarize(trials, tieThresholdPx){
  const scens=['A','B'], conds=['C0','C-UI']; const out={};
  for (const scenario of scens){
    out[scenario]={};
    for (const c of conds){
      const ts=trials.filter(t=>t.scenario===scenario && t.cond===c && t.phase==='main');
      if (!ts.length){ out[scenario][c]=null; continue; }
      const hits=ts.filter(t=>t.hit).length;
      const errs=ts.map(t=> t.effErrDist!=null? t.effErrDist : t.rawErrDist).filter(v=>v!=null);
      const rawErrs=ts.map(t=>t.rawErrDist).filter(v=>v!=null);
      const mts =ts.map(t=>t.mt).filter(v=>v!=null);
      const misd=ts.filter(t=>t.misdirect).length;
      const applied=ts.filter(t=>t.correctionApplied).length;
      const gapKnown=ts.filter(t=>t.correctionApplied && t.distGap!=null);
      const ties=gapKnown.filter(t=>t.distGap<=tieThresholdPx).length;
      out[scenario][c]={
        n:ts.length, hitRate:hits/ts.length*100, errMean:mean(errs), rawErrMean:mean(rawErrs), mtMean:mean(mts),
        misdirectRate: applied? misd/applied*100 : 0, appliedRate:applied/ts.length*100,
        tieRate: applied? ties/applied*100 : 0,
        distGapMean: gapKnown.length? mean(gapKnown.map(t=>t.distGap)) : null,
      };
    }
  }
  return out;
}

function renderResults(){
  updateDataCount();
  const el=$('#resultsBody'); el.innerHTML='';
  const showAll = !!App.resultsShowAll;
  const T = showAll ? App.trials : App.trials.filter(t=> t.phase!=='main' || t.runId===App.runSeq);
  const mainN=T.filter(t=>t.phase==='main').length;

  let html = `<div class="card row spread" style="padding:12px 18px">
    <span class="note">${showAll? '전체 누적 데이터(이전 실행 포함)를 보고 있습니다.' : '방금 실행한 결과만 보고 있습니다.'}</span>
    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer">
      <input type="checkbox" id="showAllChk" ${showAll?'checked':''}> 이전 실행 데이터까지 전부 보기
    </label>
  </div>`;

  const tieThreshold = App.resultsTieThreshold ?? 5;
  const s=summarize(T, tieThreshold);
  html+=`<div class="card"><h3>시나리오 × 조건별 요약 (본실험 ${mainN}시행)</h3>
    <div class="row" style="margin:-2px 0 10px">
      <label class="field" style="min-width:auto">동률 판정 임계값(px)
        <input type="number" id="tieThresholdInput" value="${tieThreshold}" min="0" max="200" step="1" style="width:90px" />
      </label>
      <span class="note" style="align-self:center">1위·2위 후보 거리차가 이 값 이하면 "동률"로 집계. 원본 거리차를 그대로 저장해뒀으니 값을 바꿔가며 동률률 변화를 볼 수 있음.</span>
    </div>`;
  if (!mainN){ html+='<p class="note">데이터가 없습니다. 메뉴에서 본실험을 진행하세요.</p>'; }
  else{
    html+=`<table><thead><tr>
      <th class="l">시나리오</th><th class="l">조건</th><th>N</th><th>명중률(%)</th><th>보정후 오차(px)</th>
      <th>원클릭 오차(px)</th><th>평균 MT(ms)</th><th>보정적용(%)</th><th>역효과율(%)</th><th>동률률(%)</th><th>평균 거리차(px)</th></tr></thead><tbody>`;
    for (const scenario of ['A','B']){
      for (const c of ['C0','C-UI']){
        const r=s[scenario][c];
        html+=`<tr><td class="l">${SCENLABEL[scenario]}</td><td class="l">${CONDLABEL[c]}</td>`+
          (r? `<td>${r.n}</td><td>${fmt(r.hitRate)}</td><td>${fmt(r.errMean)}</td><td>${fmt(r.rawErrMean)}</td><td>${fmt(r.mtMean,0)}</td>
               <td>${fmt(r.appliedRate)}</td><td>${fmt(r.misdirectRate)}</td><td>${fmt(r.tieRate)}</td><td>${r.distGapMean!=null?fmt(r.distGapMean):'–'}</td>`
             : `<td colspan="9" class="note">데이터 없음</td>`)+`</tr>`;
      }
    }
    html+='</tbody></table>';
    const d=(scenario,key)=>{ const a=s[scenario].C0, b=s[scenario]['C-UI']; if(!a||!b) return '–'; return (b[key]-a[key]).toFixed(1); };
    html+=`<div class="sep"></div><h3>UI 인식의 효과 (C0 → C-UI, 시나리오별)</h3><ul class="tight">
      <li><b>일반 배치(A)</b> 명중률 Δ = <b>${d('A','hitRate')}</b>%p, 오차 Δ = ${d('A','errMean')}px</li>
      <li><b>밀집 배치(B)</b> 명중률 Δ = <b>${d('B','hitRate')}</b>%p, 오차 Δ = ${d('B','errMean')}px</li>
    </ul><p class="note">가설: A에서는 Δ가 뚜렷이 양(+)이고, B에서는 Δ가 작거나 음(−)이며 역효과율·동률률이
    A보다 눈에 띄게 높을 것으로 예상. 이 차이가 확인되면 phase 2(AI 궤적 예측)의 근거가 된다.</p>
    <p class="note"><b>역효과율 정의:</b> 원클릭이 애초에 어떤 버튼 안에도 없었는데(클릭 실패 상황),
    보정이 그걸 표적이 아닌 다른 버튼으로 확정해 눌러버린 비율. "실패보다 엉뚱한 걸 확신 있게
    눌러버리는 게 더 나쁘다"는 기준. 원클릭이 표적을 직접 맞혔는데 보정이 틀어버리는 경우는
    이 배치(버튼 비겹침)에서는 구조적으로 발생하지 않아 애초에 포함하지 않는다.</p>
    <p class="note"><b>주의(안전성):</b> C-UI는 반경 제한 없이 항상 최근접 버튼으로 보정한다 —
    "멀어서 보정을 포기"하는 안전장치가 없다. 역효과율은 이 위험의 일부만 보여주며,
    "표적에서 한참 벗어난 클릭을 억지로 아무 버튼에나 갖다붙이는" 위험까지 전부 잡지는 못한다.</p>`;
  }
  html+='</div>';

  el.innerHTML=html;
  $('#showAllChk').addEventListener('change', (e)=>{ App.resultsShowAll = e.target.checked; renderResults(); });
  $('#tieThresholdInput').addEventListener('change', (e)=>{
    const v = parseFloat(e.target.value);
    App.resultsTieThreshold = Number.isFinite(v) ? clamp(v,0,200) : 5;
    renderResults();
  });
}

/* ------------------------------------------------------------------ */
/* 10. 설정 읽기 / 이벤트 바인딩                                        */
/* ------------------------------------------------------------------ */
function readConfig(){
  App.pid = $('#pid').value.trim() || null;
  App.cfg.repsPerCellA = clamp(parseInt($('#repsPerCellA').value)||2, 1, 20);
  App.cfg.repsPerCellB = clamp(parseInt($('#repsPerCellB').value)||4, 1, 20);
  App.cfg.scenarios = $$('.scenChk').filter(c=>c.checked).map(c=>c.value);
  App.cfg.conditions = $$('.condChk').filter(c=>c.checked).map(c=>c.value);
}
function recalcTotal(){
  const repsA=clamp(parseInt($('#repsPerCellA').value)||2,1,20);
  const repsB=clamp(parseInt($('#repsPerCellB').value)||4,1,20);
  const scenChecked = $$('.scenChk').filter(c=>c.checked).map(c=>c.value);
  const nCond = $$('.condChk').filter(c=>c.checked).length || 2;
  const nA = scenChecked.includes('A') ? nCond*2*2*repsA : 0;
  const nB = scenChecked.includes('B') ? nCond*2*2*repsB : 0;
  $('#totalCalc').textContent = nA+nB;
}

window.addEventListener('DOMContentLoaded', ()=>{
  updateDataCount();
  $('#repsPerCellA').addEventListener('input', recalcTotal);
  $('#repsPerCellB').addEventListener('input', recalcTotal);
  recalcTotal();
  $$('.scenChk,.condChk').forEach(c=> c.addEventListener('change', recalcTotal));

  $$('[data-go]').forEach(b=> b.addEventListener('click', ()=>{
    let g=b.dataset.go;
    if (g==='menu'){ go('menu'); return; }
    if (g==='results'){ go('results'); renderResults(); return; }
    readConfig();
    App.cfg.quickMode = (g==='mainQuick');
    if (g==='mainQuick') g='main';
    if (g==='main'){
      if (!App.pid){ alert('먼저 참가자 ID를 입력하세요.'); return; }
      if (!App.cfg.scenarios.length){ alert('시나리오를 최소 1개 체크하세요.'); return; }
      if (!App.cfg.conditions.length){ alert('조건을 최소 1개 체크하세요.'); return; }
      startMain();
    }
  }));

  $('#sbAbort').addEventListener('click', ()=>{ App.abort=true; });
  $('#btnExportJSON').addEventListener('click', exportJSON);
  $('#btnExportCSV').addEventListener('click', exportCSV);
  $('#btnExportJSON2').addEventListener('click', exportJSON);
  $('#btnExportCSV2').addEventListener('click', exportCSV);
  $('#btnClear').addEventListener('click', ()=>{
    if (confirm('기록된 모든 시행 데이터를 삭제할까요?')){ App.trials=[]; persist(); }
  });
});
