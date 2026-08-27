/* =====================================================================
 * 개인화 마우스 보정 실험 — app.js
 * UI 인식(DOM) · 시선추적(WebGazer) · 개인 클릭 패턴 학습의 기여도 분리
 * 실험설계서(2026 기초자율연구) 구현.
 *
 * 좌표계: 모든 좌표는 뷰포트(clientX/clientY) 기준. #stage 는 top:40px 이므로
 *          stage 내부 좌표 = client 좌표 - stageRect.top/left 로 환산.
 * 보정 원칙: 버튼을 직접 Invoke 하지 않는다. 좌표 기반 보정만 수행하고,
 *            보정된 좌표에 대해 hit-test 하여 "선택된 버튼"을 결정한다.
 * ===================================================================== */
'use strict';

/* ------------------------------------------------------------------ */
/* 0. 전역 상태                                                         */
/* ------------------------------------------------------------------ */
const App = {
  pid: null,
  cfg: {
    repsPerCell: 2,
    grid: 3,          // NxN(또는 4x3) 시선 구역 격자
    gridCols: 3,
    gridRows: 3,
    useGaze: true,
    gazeBufferMs: 300,     // 클릭 직전 시선 버퍼 구간(설계: 200–300ms)
    snapRadius: 90,        // 좌표 스냅 최대 반경(px). 이보다 멀면 스냅 안 함.
    timeLimitMs: 900,      // 시간 압박 조건의 제한시간
    sizes: { small: 26, large: 60 },     // 버튼 한 변(px)
    dists: { near: 260, far: 560 },      // home→target 목표 거리(px)
    nDistractors: 5,
    gazeSmoothAlpha: 0.45, // 시선 좌표 지수이동평균 계수(낮을수록 부드럽지만 반응 지연↑). WebGazer 프레임별 예측이 원래 매우 노이즈가 커서 무보정 시 점이 심하게 튐.
  },
  gazeReady: false,       // WebGazer 로드+시작 성공 여부
  gazeSmooth: null,       // {x,y} 지수이동평균 상태
  gazeBuffer: [],         // {x,y,t} 링버퍼 (client 좌표, 스무딩 적용됨)
  trials: [],             // 모든 시행 기록(과거 세션 포함 누적)
  runSeq: 0,              // 본실험을 실행할 때마다 +1. 결과 화면에서 "방금 실행" 필터링에 씀.
  personal: new PersonalModel(),
  running: false,
  abort: false,
};

/* localStorage 복원 */
try {
  const saved = JSON.parse(localStorage.getItem('mc_trials') || '[]');
  if (Array.isArray(saved)) App.trials = saved;
} catch (e) {}

/* ------------------------------------------------------------------ */
/* 1. 유틸                                                              */
/* ------------------------------------------------------------------ */
/* 조건 코드(C0~C4)의 화면 표시용 쉬운 말. 상태바·결과표 등 어디서든 이걸로 통일. */
const CONDLABEL = { C0:'보정 없음', C1:'버튼 위치만', C2:'시선만', C3:'시선+버튼위치', C4:'전부 다' };
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const now = () => performance.now();
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const rand = (a,b) => a + Math.random()*(b-a);
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
const mean = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : NaN;
const shuffle = arr => { for(let i=arr.length-1;i>0;i--){const j=(Math.random()*(i+1))|0;[arr[i],arr[j]]=[arr[j],arr[i]];} return arr; };
const fmt = (v, d=1) => (v==null||Number.isNaN(v)) ? '–' : (+v).toFixed(d);

function stageRectPx(){ return $('#stage').getBoundingClientRect(); }

/* client 좌표가 속한 시선 구역 인덱스(격자). stage 영역 기준. */
function zoneOf(clientX, clientY){
  const r = stageRectPx();
  const cols = App.cfg.gridCols, rows = App.cfg.gridRows;
  const fx = clamp((clientX - r.left) / r.width,  0, 0.999999);
  const fy = clamp((clientY - r.top ) / r.height, 0, 0.999999);
  const cx = Math.floor(fx * cols);
  const cy = Math.floor(fy * rows);
  return cy * cols + cx;
}

/* ------------------------------------------------------------------ */
/* 2. 개인 클릭 패턴 모델                                                */
/*    누적 클릭 오차 벡터(raw click - target center)의 실행평균.        */
/*    크기별 평균 우선, 표본 부족 시 전역 평균 사용.                     */
/* ------------------------------------------------------------------ */
function PersonalModel(){
  this.all = { sx:0, sy:0, n:0 };
  this.bySize = {};   // sizeKey -> {sx,sy,n}
}
PersonalModel.prototype.update = function(errVec, sizeKey){
  this.all.sx += errVec.x; this.all.sy += errVec.y; this.all.n++;
  const b = this.bySize[sizeKey] || (this.bySize[sizeKey]={sx:0,sy:0,n:0});
  b.sx += errVec.x; b.sy += errVec.y; b.n++;
};
PersonalModel.prototype.offset = function(sizeKey){
  const b = this.bySize[sizeKey];
  if (b && b.n >= 4) return { x:b.sx/b.n, y:b.sy/b.n, n:b.n, src:'size' };
  if (this.all.n >= 3) return { x:this.all.sx/this.all.n, y:this.all.sy/this.all.n, n:this.all.n, src:'all' };
  return { x:0, y:0, n:this.all.n, src:'none' };
};
PersonalModel.prototype.reset = function(){ this.all={sx:0,sy:0,n:0}; this.bySize={}; };

/* ------------------------------------------------------------------ */
/* 3. 시선추적 (WebGazer 래퍼)                                          */
/* ------------------------------------------------------------------ */
const Gaze = {
  async start(){
    if (!App.cfg.useGaze) return false;
    if (typeof webgazer === 'undefined'){
      console.warn('WebGazer 미로드 — 시선 기능 비활성화');
      App.gazeError = 'WebGazer 스크립트가 로드되지 않음 (CDN 차단 가능). 인터넷 연결을 확인하세요.';
      return false;
    }
    try {
      App.gazeSmooth = null;
      webgazer.params.showVideoPreview = true;
      webgazer.params.showFaceOverlay  = false;
      webgazer.params.showPredictionPoints = false;
      try { webgazer.setRegression('ridge'); } catch(e){ /* 일부 버전은 기본이 ridge */ }
      webgazer.setGazeListener((data, ts) => {
        if (!data) return;
        // WebGazer는 프레임마다 원시 예측을 그대로 던져 값이 매우 튄다(=화면에서 노란 점이 심하게 흔들리는 원인).
        // 지수이동평균으로 완화한 좌표를 실제 버퍼·표시에 사용한다.
        const a = App.cfg.gazeSmoothAlpha;
        if (!App.gazeSmooth) App.gazeSmooth = { x:data.x, y:data.y };
        else { App.gazeSmooth.x += (data.x - App.gazeSmooth.x)*a; App.gazeSmooth.y += (data.y - App.gazeSmooth.y)*a; }
        const sx = App.gazeSmooth.x, sy = App.gazeSmooth.y;
        // client 좌표. 버퍼에 저장, 오래된 것 제거.
        const t = now();
        App.gazeBuffer.push({ x:sx, y:sy, t });
        const cut = t - 1200;
        while (App.gazeBuffer.length && App.gazeBuffer[0].t < cut) App.gazeBuffer.shift();
        const dot = $('#gazeDot');
        dot.style.display='block';
        dot.style.left = sx+'px'; dot.style.top = sy+'px';
      });
      // begin()이 얼굴모델 로딩에서 멈추는 경우를 대비해 타임아웃과 경쟁.
      const beginP = webgazer.begin();
      const timeoutP = new Promise((_,rej)=> setTimeout(()=> rej(new Error('begin() 응답 없음(모델 로딩 지연/차단 추정)')), 15000));
      await Promise.race([Promise.resolve(beginP), timeoutP]);
      // 여기까지 오면 카메라/시선 파이프라인은 시작됨 → 준비 완료로 확정.
      App.gazeReady = true;
      // 아래는 표시 관련 부가 호출. 버전에 따라 체이닝이 undefined를 반환할 수 있어
      // 각각 독립적으로 감싸 초기화 실패로 이어지지 않게 한다.
      try { webgazer.showVideoPreview(true); } catch(e){}
      try { webgazer.showPredictionPoints(false); } catch(e){}
      try { webgazer.showFaceOverlay(false); } catch(e){}
      try { webgazer.showFaceFeedbackBox(false); } catch(e){}
      updateStatusbar();
      return true;
    } catch(e){
      console.warn('WebGazer 시작 실패:', e);
      App.gazeError = (e && (e.message || e.name)) ? (e.name+': '+e.message) : String(e);
      App.gazeReady = false;
      return false;
    }
  },
  /* 클릭 직전 buffer 구간의 시선 표본들. */
  recentSamples(clickT, windowMs){
    const lo = clickT - windowMs;
    return App.gazeBuffer.filter(s => s.t >= lo && s.t <= clickT + 5);
  },
  /* 최근 시선 표본들의 다수결 구역. 없으면 null. */
  dominantZone(clickT, windowMs){
    const s = this.recentSamples(clickT, windowMs);
    if (!s.length) return null;
    // 예전엔 버퍼(최대 300ms) 안 표본들의 다수결로 구역을 정했는데, 그러면 클릭 직전 막판에
    // 눈을 빠르게 옮겼을 때 "지금 보는 곳"이 아니라 "그 전에 보던 곳"이 다수결에서 이겨버릴 수 있다.
    // "지금 실제로 보고 있는 점"에 맞게, 가장 최근 표본의 구역을 그대로 쓴다.
    const last = s[s.length-1];
    const zone = zoneOf(last.x, last.y);
    const cnt = {};
    for (const p of s){ const z = zoneOf(p.x, p.y); cnt[z]=(cnt[z]||0)+1; }
    // confidence는 그대로 "이 구역이 버퍼 동안 얼마나 안정적이었나"의 의미로 유지.
    return { zone, n:s.length, confidence:(cnt[zone]||0)/s.length };
  },
  pause(){ try{ webgazer.pause(); }catch(e){} },
  resume(){ try{ webgazer.resume(); }catch(e){} },
};

/* ------------------------------------------------------------------ */
/* 4. 자극 배치 / 시행 생성                                             */
/* ------------------------------------------------------------------ */
/* home 버튼: stage 하단 중앙. target: home에서 지정 거리, 랜덤 각도(위쪽 반원). */
function layoutTrial(spec){
  const r = stageRectPx();
  const size = App.cfg.sizes[spec.size];
  const homeSize = 44;
  const home = {
    x: r.width/2,
    y: r.height - 70,
    w: homeSize, h: homeSize,
  };
  const D = App.cfg.dists[spec.dist];
  // 위쪽 반원(−160°~−20°) 안에서 stage 밖으로 안 나가게 각도 조정
  let target=null;
  for (let tries=0; tries<40; tries++){
    const ang = rand(-Math.PI*0.9, -Math.PI*0.1);
    const cx = home.x + Math.cos(ang)*D;
    const cy = home.y + Math.sin(ang)*D;
    const m = size/2 + 20;
    if (cx> m && cx< r.width-m && cy> m && cy< r.height-m){
      target = { cx, cy, w:size, h:size };
      break;
    }
  }
  if (!target){ target = { cx:r.width/2, cy:r.height*0.35, w:size, h:size }; }

  // 방해 버튼: target 주변 링에 배치 (겹침 최소화)
  const distractors=[];
  const N = App.cfg.nDistractors;
  const ring = size + rand(26, 46);
  for (let i=0;i<N;i++){
    const a = (i/N)*Math.PI*2 + rand(-0.2,0.2);
    const cx = clamp(target.cx + Math.cos(a)*ring, size, r.width-size);
    const cy = clamp(target.cy + Math.sin(a)*ring, size, r.height-size);
    distractors.push({ cx, cy, w:size, h:size });
  }
  return { home, target, distractors, size };
}

/* 본실험 시행 목록 생성: 선택된 조건(기본 5개 전부) × 크기2 × 거리2 × 시간2 × 반복.
   C4(개인패턴)는 데이터 누적이 필요하므로 포함돼 있으면 항상 마지막 블록.
   나머지 조건 블록 순서는 참가자 번호 기반 회전(counterbalancing).
   조건을 하나만 선택하면 그 조건만 단독으로 도는 "단일 조건 테스트"가 된다. */
function buildMainTrials(){
  const sizes = ['small','large'];
  const dists = ['near','far'];
  const times = ['none','limited'];
  const reps  = App.cfg.repsPerCell;
  const selected = (App.cfg.conditions && App.cfg.conditions.length) ? App.cfg.conditions : ['C0','C1','C2','C3','C4'];

  // C4를 뺀 나머지 선택 조건들의 순서 회전
  const head = selected.filter(c=>c!=='C4');
  const seed = pidSeed(App.pid);
  const order = head.length ? head.slice(seed % head.length).concat(head.slice(0, seed % head.length)) : [];
  const blockOrder = order.concat(selected.includes('C4') ? ['C4'] : []);

  const trials=[];
  for (const cond of blockOrder){
    let cells=[];
    if (App.cfg.quickMode){
      // 빠른 비교: 쉬운 조건이면 원클릭도 거의 다 성공해서 보정 효과 자체를 볼 수가 없다.
      // 일부러 제일 어려운 조합(작은 버튼·먼 거리·시간압박)으로 몇 번 반복해서
      // "원클릭이 실제로 빗나가고, 그걸 보정이 고쳐주는지"가 보이게 한다.
      for (let k=0;k<8;k++) cells.push({ size:'small', dist:'far', time:'limited' });
    } else {
      for (const size of sizes) for (const d of dists) for (const t of times)
        for (let k=0;k<reps;k++) cells.push({ size, dist:d, time:t });
      shuffle(cells);
    }
    for (const c of cells) trials.push({ cond, ...c });
  }
  return trials;
}
function pidSeed(pid){ let s=0; for (const ch of (pid||'')) s=(s+ch.charCodeAt(0))%997; return s; }

/* ------------------------------------------------------------------ */
/* 5. 보정 엔진 (설계 5장)                                              */
/*    입력: rawClick(client), 시행 자극 정보, 조건, 시선/궤적           */
/*    출력: { corrected, chosenButtonId, applied, agree, personalUsed } */
/* ------------------------------------------------------------------ */
function candidateButtons(layout){
  // id 0 = target, 1..N = distractors. rect(client 좌표)
  const r = stageRectPx();
  const toRect = (c)=>({ left:r.left+c.cx-c.w/2, top:r.top+c.cy-c.h/2, right:r.left+c.cx+c.w/2, bottom:r.top+c.cy+c.h/2, cx:r.left+c.cx, cy:r.top+c.cy, w:c.w, h:c.h });
  const list = [{ id:'target', rect:toRect(layout.target) }];
  layout.distractors.forEach((d,i)=> list.push({ id:'d'+i, rect:toRect(d) }));
  return list;
}
function pointInRect(p, R){ return p.x>=R.left && p.x<=R.right && p.y>=R.top && p.y<=R.bottom; }
function distToRectCenter(p, R){ return Math.hypot(p.x-R.cx, p.y-R.cy); }

/* 특정 점이 직접 맞힌 버튼(포함) 또는 null */
function hitTest(p, buttons){
  for (const b of buttons) if (pointInRect(p, b.rect)) return b.id;
  return null;
}
/* 후보 집합 중 점에 가장 가까운 버튼(중심거리, snapRadius 이내) */
function nearest(p, buttons, radius){
  let best=null, bd=Infinity;
  for (const b of buttons){
    const d = distToRectCenter(p, b.rect);
    if (d<bd){ bd=d; best=b; }
  }
  if (best && bd <= (radius ?? Infinity)) return best;
  return null;
}
/* 시선 구역 안에 있는 버튼만 필터 */
function buttonsInZone(buttons, zone){
  return buttons.filter(b => zoneOf(b.rect.cx, b.rect.cy) === zone);
}

function applyCorrection(cond, rawClick, layout, ctx){
  const buttons = candidateButtons(layout);
  const R = App.cfg.snapRadius;
  const result = {
    corrected: { ...rawClick },
    chosen: hitTest(rawClick, buttons),   // 기본: 직접 맞힌 버튼
    applied: false, agree: null, personalUsed:false,
    gazeZone: ctx.gazeZone, gazeConf: ctx.gazeConf,
  };

  if (cond === 'C0'){
    // 무보정: 원 클릭 그대로. 직접 맞힌 게 없으면 miss(null).
    return result;
  }

  if (cond === 'C1'){
    // UI만: 전체 버튼 중 최근접 스냅.
    const nb = nearest(rawClick, buttons, R);
    if (nb){ result.corrected = { x:nb.rect.cx, y:nb.rect.cy }; result.chosen = nb.id; result.applied=true; }
    return result;
  }

  if (cond === 'C2'){
    // 시선만: 시선 구역으로 후보를 좁히고, 그 안에서 최근접 버튼 선택.
    if (ctx.gazeZone==null){ return result; }               // 시선 없음 → 무보정
    const inz = buttonsInZone(buttons, ctx.gazeZone);
    if (!inz.length){ return result; }                       // 구역에 버튼 없음 → 무보정
    const nb = nearest(rawClick, inz, R*1.5);                // 시선은 저정밀 → 반경 완화
    if (nb){ result.corrected={ x:nb.rect.cx, y:nb.rect.cy }; result.chosen=nb.id; result.applied=true; }
    return result;
  }

  // C3, C4: 결합. 신호 일치할 때만 보정.
  if (cond === 'C3' || cond === 'C4'){
    let click = { ...rawClick };
    // C4: 먼저 개인 오차 벡터로 사전보정 (raw - meanError = 의도 추정점)
    if (cond === 'C4'){
      const off = App.personal.offset(ctx.sizeKey);
      if (off.src !== 'none'){ click = { x:rawClick.x - off.x, y:rawClick.y - off.y }; result.personalUsed=true; result.personalOffset=off; }
    }
    // 시선 구역 없으면 결합 불가 → UI 단독으로 폴백(안전)
    if (ctx.gazeZone==null){
      const nb = nearest(click, buttons, R);
      if (nb){ result.corrected={x:nb.rect.cx,y:nb.rect.cy}; result.chosen=nb.id; result.applied=true; result.agree=false; }
      return result;
    }
    const inz = buttonsInZone(buttons, ctx.gazeZone);
    // 마우스 궤적 방향과 시선 구역 일치 확인
    const agree = trajectoryAgrees(ctx.traj, ctx.gazeZone) && inz.length>0;
    result.agree = agree;
    if (!agree){
      // 신호 불일치 → 보정하지 않음(원 클릭 통과). 오보정 방지 안전장치.
      return result;
    }
    const nb = nearest(click, inz, R*1.4);
    if (nb){ result.corrected={x:nb.rect.cx,y:nb.rect.cy}; result.chosen=nb.id; result.applied=true; }
    else { // 구역 내 근접 버튼 없음 → 통과
    }
    return result;
  }
  return result;
}

/* 마우스 궤적의 진행 방향(시작→끝)이 가리키는 지점이 시선 구역과 같은가.
   궤적 끝점 부근 + 진행 방향으로 약간 외삽한 점의 구역을 본다. */
function trajectoryAgrees(traj, gazeZone){
  if (!traj || traj.length < 3) return true;   // 궤적 정보 부족 시 방해하지 않음
  const a = traj[0], b = traj[traj.length-1];
  const dx = b.x-a.x, dy=b.y-a.y;
  const L = Math.hypot(dx,dy) || 1;
  const ext = { x: b.x + dx/L*30, y: b.y + dy/L*30 };
  const zEnd = zoneOf(b.x, b.y);
  const zExt = zoneOf(ext.x, ext.y);
  return zEnd===gazeZone || zExt===gazeZone;
}

/* ------------------------------------------------------------------ */
/* 6. 시행 실행 (한 trial)                                              */
/* ------------------------------------------------------------------ */
function runTrial(spec, index, total, phase){
  return new Promise(resolve => {
    const stage = $('#stage');
    stage.querySelectorAll('.stimBtn').forEach(e=>e.remove());
    $('#clickMark').classList.add('hidden');
    $('#corrMark').classList.add('hidden');
    $('#trialMsg').textContent='';
    setZoneOverlay(null);

    const layout = layoutTrial(spec);
    const r = stageRectPx();

    // ---- 버튼 DOM 생성 ----
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
    // home
    const homeEl = mkBtn(layout.home, 'home', 'HOME');

    // 상태
    let phaseState = 'await-home';   // await-home → show-target → clicked
    let targetShownT=0, firstMoveT=0, movedSince=false;
    const traj=[];
    let timeLimitTimer=null;

    // 궤적 기록
    const onMove = (e)=>{
      if (phaseState!=='show-target') return;
      if (!movedSince){ firstMoveT=now(); movedSince=true; }
      traj.push({ x:e.clientX, y:e.clientY, t:now() });
    };
    stage.addEventListener('mousemove', onMove);

    // home 클릭 → 타겟 표시
    homeEl.addEventListener('click', (e)=>{
      if (phaseState!=='await-home') return;
      e.stopPropagation();
      homeEl.remove();
      // fixation 잠깐
      phaseState='fixation';
      const fx=$('#fixation'); fx.classList.remove('hidden');
      fx.style.left=layout.home.x+'px'; fx.style.top=(layout.home.y-4)+'px';
      setTimeout(()=>{
        fx.classList.add('hidden');
        showTarget();
      }, 350);
    });
    $('#trialMsg').textContent = 'HOME 을 클릭해 시작';

    function showTarget(){
      phaseState='show-target';
      $('#trialMsg').textContent='';
      mkBtn(layout.target, 'target', '●', 'target');
      layout.distractors.forEach((d,i)=> mkBtn(d, '', '', 'd'+i));
      targetShownT=now(); movedSince=false;
      if (spec.time==='limited'){
        timeLimitTimer = setTimeout(()=> finalize(null, true), App.cfg.timeLimitMs);
      }
    }

    // stage 클릭(버튼 위든 빈 곳이든) = 클릭 시도
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

      const buttons = candidateButtons(layout);
      const targetBtn = buttons[0];
      const targetCenter = { x:targetBtn.rect.cx, y:targetBtn.rect.cy };

      // 시선 구역
      let gz=null, gconf=null, gazeSamples=0, gazeLeadMs=null;
      if (App.gazeReady){
        const dz = Gaze.dominantZone(clickT, App.cfg.gazeBufferMs);
        if (dz){ gz=dz.zone; gconf=dz.confidence; gazeSamples=dz.n; }
        // 시선 선행성: 시선이 target 구역에 처음 진입한 시각
        const targetZone = zoneOf(targetCenter.x, targetCenter.y);
        const win = App.gazeBuffer.filter(s=> s.t>=targetShownT && s.t<=clickT);
        const firstIn = win.find(s=> zoneOf(s.x,s.y)===targetZone);
        if (firstIn) gazeLeadMs = clickT - firstIn.t;
      }
      // 시선을 실제로 안 쓰는 조건(무보정·버튼위치만)에서는 구역을 안 칠한다.
      // 안 그러면 보정에 전혀 관여 안 한 시선 표시가 마치 이번 판정에 쓰인 것처럼 보여 혼란을 줌.
      setZoneOverlay(['C2','C3','C4'].includes(spec.cond) ? gz : null);

      // 보정
      let rec;
      if (timeout || !rawClick){
        rec = { corrected:null, chosen:null, applied:false, agree:null, personalUsed:false, gazeZone:gz, gazeConf:gconf };
      } else {
        rec = applyCorrection(spec.cond, rawClick, layout, {
          gazeZone: gz, gazeConf: gconf, traj, sizeKey: spec.size,
        });
      }

      // 판정
      const targetZone = zoneOf(targetCenter.x, targetCenter.y);
      const rawHit = rawClick ? hitTest(rawClick, buttons) : null;
      const chosen = rec.chosen;
      const hit = chosen === 'target';
      // 오보정: 보정이 적용됐는데 결과가 target이 아님(원클릭이 맞았거나 무판정이었는데 틀린 버튼으로 유도)
      const misdirect = !!rec.applied && chosen!=='target' && chosen!=null;

      // 원(raw) 클릭 오차 — H1 일관성·개인 패턴 학습에 사용(보정과 무관한 본래 편향).
      const errVec = rawClick ? { x:rawClick.x-targetCenter.x, y:rawClick.y-targetCenter.y } : null;
      const errDist = errVec ? Math.hypot(errVec.x, errVec.y) : null;
      // 유효(effective) 클릭 오차 — 보정 후 실제 반영되는 클릭점 기준. 조건 비교의 핵심 종속변인.
      const effPoint = rec.corrected || rawClick;
      const effErrX = effPoint ? effPoint.x-targetCenter.x : null;
      const effErrY = effPoint ? effPoint.y-targetCenter.y : null;
      const effErrDist = effPoint ? Math.hypot(effErrX, effErrY) : null;

      // 개인 모델 업데이트(원 클릭 오차로 학습) — target을 알므로 항상 학습 가능.
      if (errVec) App.personal.update(errVec, spec.size);

      // 기록
      const trial = {
        pid: App.pid, phase, ts: Date.now(), runId: App.runSeq,
        index, cond: spec.cond, size: spec.size, distance: spec.dist, timePressure: spec.time,
        buttonSizePx: App.cfg.sizes[spec.size], targetDistPx: App.cfg.dists[spec.dist],
        timeout: !!timeout,
        rawClick, corrected: rec.corrected, targetCenter,
        rawErrX: errVec?errVec.x:null, rawErrY: errVec?errVec.y:null, rawErrDist: errDist,
        effErrX, effErrY, effErrDist,
        rawHit, chosen, hit, misdirect,
        correctionApplied: rec.applied, signalsAgree: rec.agree, personalUsed: rec.personalUsed,
        personalOffset: rec.personalOffset || null,
        gazeUsed: App.gazeReady, gazeZone: gz, targetZone, gazeConfidence: gconf, gazeSamples,
        gazeLeadMs,
        rt: (firstMoveT&&targetShownT)? (firstMoveT-targetShownT):null,
        mt: rawClick? (clickT - (firstMoveT||targetShownT)):null,
        trajLen: traj.length,
      };
      App.trials.push(trial);
      persist();

      // 피드백 표시(정답=초록 테두리, 선택=주황 점선)
      const tEl = stage.querySelector('.stimBtn.target');
      if (tEl) tEl.classList.add('reveal-correct');
      if (chosen && chosen!=='target'){
        const cEl = stage.querySelector(`.stimBtn[data-bid="${chosen}"]`);
        if (cEl) cEl.classList.add('reveal-chosen');
      }
      if (rawClick){ const m=$('#clickMark'); m.classList.remove('hidden'); m.style.left=(rawClick.x-r.left)+'px'; m.style.top=(rawClick.y-r.top)+'px'; }
      if (rec.corrected){ const m=$('#corrMark'); m.classList.remove('hidden'); m.style.left=(rec.corrected.x-r.left)+'px'; m.style.top=(rec.corrected.y-r.top)+'px'; }
      // "적중/빗나감"만으로는 보정이 실제로 관여했는지 알 수 없어 혼란을 주므로, 이번 시행에서
      // 무슨 일이 있었는지(원클릭 그대로인지, 보정이 걸렸는지, 걸렸는데 틀렸는지) 짧게 같이 보여준다.
      let why;
      if (timeout) why = '시간 초과';
      else if (spec.cond==='C0') why = '원클릭 그대로(무보정 조건)';
      else if (!rec.applied) why = '보정 안 걸림(원클릭 유지)';
      else if (misdirect) why = '보정 걸렸는데 틀린 버튼으로(오보정)';
      else why = '보정이 표적으로 옮겨줌';
      $('#trialMsg').textContent = (timeout ? '시간 초과' : (hit? '적중' : '빗나감')) + ' · ' + why;
      $('#trialMsg').style.color = timeout? '#f5b544' : (hit? '#39c07d':'#ff6b6b');

      updateStatusbar(index+1, total, spec.cond);
      setTimeout(()=>{ resolve(trial); }, 520);
    }
  });
}

/* 시선 구역 오버레이 그리기 */
function setZoneOverlay(activeZone){
  const ov = $('#zoneOverlay'); ov.innerHTML='';
  const cols=App.cfg.gridCols, rows=App.cfg.gridRows;
  const r = stageRectPx();
  for (let cy=0;cy<rows;cy++) for (let cx=0;cx<cols;cx++){
    const idx=cy*cols+cx;
    const cell=document.createElement('div');
    cell.className='cell'+(idx===activeZone?' gaze':'');
    cell.style.left=(cx/cols*100)+'%'; cell.style.top=(cy/rows*100)+'%';
    cell.style.width=(100/cols)+'%'; cell.style.height=(100/rows)+'%';
    ov.appendChild(cell);
  }
}

/* ------------------------------------------------------------------ */
/* 7. 단계 실행기 (본실험 / 예비A / 예비B / 보정)                       */
/* ------------------------------------------------------------------ */
async function runBlock(trialSpecs, phaseLabel){
  App.runSeq++;   // 이번 실행 번호. 결과 화면 "방금 실행" 필터링용.
  enterStage();
  App.running=true; App.abort=false;
  updateStatusbar(0, trialSpecs.length, trialSpecs[0]?.cond||'–');
  for (let i=0;i<trialSpecs.length;i++){
    if (App.abort) break;
    setStatusPhase(phaseLabel);
    await runTrial(trialSpecs[i], i, trialSpecs.length, phaseLabel);
  }
  App.running=false;
  leaveStage();
  if (!App.abort){ go('results'); renderResults(); }
  else go('menu');
}

async function startMain(){
  const specs = buildMainTrials();
  await runBlock(specs, 'main');
}

/* 예비실험 A — 시선 특성화: 격자 지점 응시 오차 측정 */
async function startPreA(){
  if (!App.gazeReady){ alert('예비실험 A는 시선추적이 필요합니다. 먼저 보정(Calibration)을 완료하세요.'); go('menu'); return; }
  enterStage(); App.running=true; App.abort=false;
  const stage=$('#stage'); const r=stageRectPx();
  const pts=[];
  const gx=4, gy=3;
  for (let j=0;j<gy;j++) for (let i=0;i<gx;i++)
    pts.push({ x:(i+0.5)/gx*r.width, y:(j+0.5)/gy*r.height });
  const recs=[];
  for (let k=0;k<pts.length;k++){
    if (App.abort) break;
    setStatusPhase('preA'); updateStatusbar(k, pts.length, 'gaze');
    stage.querySelectorAll('.stimBtn').forEach(e=>e.remove());
    const dot=document.createElement('button');
    dot.className='stimBtn target'; dot.style.width='22px'; dot.style.height='22px';
    dot.style.left=(pts[k].x-11)+'px'; dot.style.top=(pts[k].y-11)+'px'; dot.textContent='＋';
    stage.appendChild(dot);
    $('#trialMsg').textContent='이 점을 바라본 채로 클릭 (시선 정확도 측정 중)';
    await new Promise(res=> dot.addEventListener('click', (e)=>{ e.stopPropagation(); res(); }, {once:true}));
    const t=now();
    const s=Gaze.recentSamples(t, 400);
    const gx0=mean(s.map(p=>p.x)), gy0=mean(s.map(p=>p.y));
    const errX = gx0-(r.left+pts[k].x), errY=gy0-(r.top+pts[k].y);
    const gzTrue=zoneOf(r.left+pts[k].x, r.top+pts[k].y);
    const dz=Gaze.dominantZone(t,400);
    recs.push({ pid:App.pid, phase:'preA', ts:Date.now(),
      pointX:pts[k].x, pointY:pts[k].y, gazeX:gx0, gazeY:gy0,
      errX, errY, errDist:Math.hypot(errX,errY),
      zoneTrue:gzTrue, zonePred:dz?dz.zone:null, zoneHit: dz? (dz.zone===gzTrue):null, samples:s.length });
  }
  App.preA = recs; App.running=false; leaveStage();
  go('results'); renderResults();
}

/* 예비실험 B — UI(DOM) 확인: 방해 버튼 밀도별 DOM 읽기 정확/지연 */
async function startPreB(){
  enterStage(); App.running=true; App.abort=false;
  const stage=$('#stage'); const r=stageRectPx();
  const densities=[3,8,16,28];
  const recs=[];
  for (let di=0; di<densities.length; di++){
    if (App.abort) break;
    setStatusPhase('preB'); updateStatusbar(di, densities.length, 'DOM');
    const N=densities[di];
    stage.querySelectorAll('.stimBtn').forEach(e=>e.remove());
    const els=[];
    for (let i=0;i<N;i++){
      const el=document.createElement('button'); el.className='stimBtn';
      const w=34, x=rand(w, r.width-w), y=rand(w, r.height-w);
      el.style.width=w+'px'; el.style.height=w+'px'; el.style.left=x+'px'; el.style.top=y+'px';
      el.dataset.gx=x+w/2; el.dataset.gy=y+w/2;
      stage.appendChild(el); els.push(el);
    }
    const tgt=els[(Math.random()*els.length)|0]; tgt.classList.add('target'); tgt.textContent='●';
    $('#trialMsg').textContent=`버튼 ${N}개 중 파란 표적을 클릭 (화면이 복잡해져도 잘 찾아내는지 확인 중)`;
    // DOM 읽기 지연 측정
    const t0=now();
    const rects=els.map(e=>({ r:e.getBoundingClientRect() }));
    const readMs=now()-t0;
    // DOM 좌표 정확도: getBoundingClientRect 중심 vs 설정값
    let maxErr=0;
    // dataset.gx/gy는 stage 내부 기준 좌표인데 getBoundingClientRect()는 항상 뷰포트 기준이라
    // stage의 오프셋(r.left, r.top)을 빼줘야 같은 좌표계에서 비교된다(안 그러면 상태바 높이(40px)만큼
    // 고정 오차가 매번 똑같이 잡히는 버그가 생김).
    els.forEach(e=>{ const b=e.getBoundingClientRect(); const cx=b.left+b.width/2-r.left, cy=b.top+b.height/2-r.top;
      maxErr=Math.max(maxErr, Math.hypot(cx-+e.dataset.gx, cy-+e.dataset.gy)); });
    const clickT0=now();
    const hitTargetP = await new Promise(res=>{
      const h=(e)=>{ const el=e.target.closest('.stimBtn'); res(el===tgt); };
      stage.addEventListener('click', h, {once:true});
    });
    recs.push({ pid:App.pid, phase:'preB', ts:Date.now(), density:N,
      domReadMs:readMs, domCenterMaxErrPx:maxErr, findMs:now()-clickT0, correctPick:hitTargetP, nButtons:N });
  }
  App.preB=recs; App.running=false; leaveStage();
  go('results'); renderResults();
}

/* WebGazer 보정(Calibration) — 9점 각 5클릭 */
async function startCalibration(){
  const ok = App.gazeReady || await Gaze.start();
  if (!ok){ alert('WebGazer를 시작할 수 없습니다.\n\n원인: '+(App.gazeError||'알 수 없음')+'\n\n웹캠 권한/인터넷을 확인하세요. 시선 미사용으로도 C0·C1 실험은 가능합니다.'); go('menu'); return; }
  const layer=$('#calibLayer'); layer.classList.remove('hidden');
  // 보정 중에는 WebGazer 자체 얼굴 랜드마크 메쉬만 잠깐 켜서,
  // 카메라가 얼굴/눈을 제대로 잡고 있는지 육안으로 확인할 수 있게 한다.
  // (얼굴 메쉬가 흔들리거나 엉뚱한 곳을 잡으면 조명·거리·각도 문제로 진단 가능)
  // WebGazer 자체 예측점(showPredictionPoints)·가이드박스(showFaceFeedbackBox)는
  // 버전에 따라 꺼짐 호출이 씹혀 화면에 고정된 채 남는 경우가 있어 아예 쓰지 않는다.
  // 시선 시각화는 우리가 그리는 노란 점(#gazeDot) 하나로 통일.
  try { webgazer.showFaceOverlay(true); } catch(e){}
  const W=innerWidth, H=innerHeight;
  // 보정점을 화면 구석까지 밀지 않고 안쪽으로(가로 8~86%, 세로 15~80%) 배치.
  // → 우하단 웹캠 미리보기(150×112)와 겹치지 않아 모든 점을 볼·클릭할 수 있음.
  const fx=[0.08,0.47,0.86], fy=[0.15,0.48,0.80];
  const pts=[]; for (let j=0;j<3;j++) for (let i=0;i<3;i++) pts.push({x:fx[i]*W, y:fy[j]*H});
  const need=5; const counts=new Array(pts.length).fill(0);
  const dots=pts.map((p,idx)=>{
    const d=document.createElement('button');
    d.style.cssText=`position:absolute;left:${p.x-13}px;top:${p.y-13}px;width:26px;height:26px;border-radius:50%;background:#ff5a5a;border:2px solid #fff;cursor:pointer;z-index:90;opacity:.5;`;
    d.addEventListener('click', ()=>{
      counts[idx]++; d.style.opacity=(0.5+0.1*counts[idx]).toFixed(2);
      if (counts[idx]>=need){ d.style.background='#39c07d'; d.disabled=true; }
      $('#calibProg').textContent = counts.filter(c=>c>=need).length+' / '+pts.length;
      if (counts.every(c=>c>=need)) endCalib();
    });
    layer.appendChild(d); return d;
  });
  $('#calibProg').textContent = '0 / '+pts.length;
  function endCalib(){
    dots.forEach(d=>d.remove());
    layer.classList.add('hidden');
    try { webgazer.showFaceOverlay(false); } catch(e){}
    go('menu'); updateStatusbar();
    alert('보정 완료. 이제 예비실험 A 또는 본실험을 진행할 수 있습니다.');
  }
  $('#calibDone').onclick=endCalib;
}

/* ------------------------------------------------------------------ */
/* 8. 화면 전환 / 상태바                                                */
/* ------------------------------------------------------------------ */
function go(name){
  $$('.screen').forEach(s=>s.classList.remove('active'));
  const map={ menu:'#scr-menu', brief:'#scr-brief', results:'#scr-results' };
  const el=$(map[name]||'#scr-menu'); el.classList.add('active');
  $('#statusbar').classList.toggle('hidden', name==='menu');
  if (name==='menu'){ $('#statusbar').classList.add('hidden'); updateDataCount(); }
}
function enterStage(){ $('#stage').classList.remove('hidden'); $$('.screen').forEach(s=>s.classList.remove('active')); $('#statusbar').classList.remove('hidden'); Gaze.resume(); }
function leaveStage(){
  $('#stage').classList.add('hidden');
  // 시행 화면을 벗어나면 시선 추적을 멈춰서, 메뉴·결과 화면에 노란 점이 멈춘 채로
  // 계속 떠 있는 걸 방지한다(안 그러면 마지막 예측 위치에 고정된 것처럼 보여 혼란을 줌).
  Gaze.pause();
  const dot = $('#gazeDot'); dot.style.display='none';
  App.gazeSmooth = null;
}
function setStatusPhase(p){ const m={main:'본실험',preA:'예비A',preB:'예비B',calib:'보정'}; $('#sbPhase').textContent=m[p]||p; }
function updateStatusbar(done, total, cond){
  $('#sbPid').textContent = App.pid||'–';
  if (cond!==undefined) $('#sbCond').textContent = CONDLABEL[cond] || cond;
  if (total!==undefined) $('#sbProg').textContent=`${done} / ${total}`;
  const g=$('#sbGaze'); if (App.gazeReady){ g.textContent='시선 ON'; g.className='pill on'; } else { g.textContent='시선 OFF'; g.className='pill off'; }
}
function updateDataCount(){ $('#dataCount').textContent=`기록된 시행 ${App.trials.length}건`; }

/* ------------------------------------------------------------------ */
/* 9. 저장 / 내보내기                                                   */
/* ------------------------------------------------------------------ */
function persist(){ try{ localStorage.setItem('mc_trials', JSON.stringify(App.trials)); }catch(e){} updateDataCount(); }
function download(name, text, type='application/json'){
  const blob=new Blob([text],{type}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function exportJSON(){
  const payload={ meta:{ exportedAt:new Date().toISOString(), pid:App.pid, cfg:App.cfg }, trials:App.trials, preA:App.preA||[], preB:App.preB||[] };
  download(`mousecorr_${App.pid||'data'}_${Date.now()}.json`, JSON.stringify(payload,null,2));
}
function exportCSV(){
  const cols=['pid','phase','index','cond','size','distance','timePressure','buttonSizePx','targetDistPx','timeout',
    'rawErrX','rawErrY','rawErrDist','effErrX','effErrY','effErrDist','rawHit','chosen','hit','misdirect',
    'correctionApplied','signalsAgree','personalUsed','gazeUsed','gazeZone','targetZone','gazeConfidence','gazeSamples',
    'gazeLeadMs','rt','mt','trajLen','ts'];
  const esc=v=> v==null?'':(typeof v==='object'?JSON.stringify(v):String(v));
  const lines=[cols.join(',')];
  for (const t of App.trials) lines.push(cols.map(c=>esc(t[c])).join(','));
  download(`mousecorr_${App.pid||'data'}_${Date.now()}.csv`, lines.join('\n'), 'text/csv');
}

/* ------------------------------------------------------------------ */
/* 10. 분석 / 결과 렌더                                                 */
/* ------------------------------------------------------------------ */
function summarizeByCondition(trials){
  const conds=['C0','C1','C2','C3','C4']; const out={};
  for (const c of conds){
    const ts=trials.filter(t=>t.cond===c && t.phase==='main');
    if (!ts.length){ out[c]=null; continue; }
    const hits=ts.filter(t=>t.hit).length;
    const errs=ts.map(t=> t.effErrDist!=null? t.effErrDist : t.rawErrDist).filter(v=>v!=null); // 보정 후 유효 오차
    const rawErrs=ts.map(t=>t.rawErrDist).filter(v=>v!=null);
    const mts =ts.map(t=>t.mt).filter(v=>v!=null);
    const misd=ts.filter(t=>t.misdirect).length;
    const applied=ts.filter(t=>t.correctionApplied).length;
    const leads=ts.map(t=>t.gazeLeadMs).filter(v=>v!=null);
    out[c]={
      n:ts.length, hitRate:hits/ts.length*100, errMean:mean(errs), rawErrMean:mean(rawErrs), mtMean:mean(mts),
      misdirectRate: applied? misd/applied*100 : 0, appliedRate:applied/ts.length*100,
      gazeLeadMean: leads.length?mean(leads):null,
    };
  }
  return out;
}
/* 개인 패턴 일관성(H1): C0 오차 벡터의 방향 분산 vs 무작위. 평균저항 R̄. */
function h1Consistency(trials){
  const c0=trials.filter(t=>t.cond==='C0' && t.phase==='main' && t.rawErrX!=null);
  if (c0.length<5) return null;
  const ang=c0.map(t=>Math.atan2(t.rawErrY,t.rawErrX));
  const C=mean(ang.map(a=>Math.cos(a))), S=mean(ang.map(a=>Math.sin(a)));
  const R=Math.hypot(C,S);   // 0=무작위, 1=완전 일관
  const meanAngDeg=Math.atan2(S,C)*180/Math.PI;
  const meanVec={ x:mean(c0.map(t=>t.rawErrX)), y:mean(c0.map(t=>t.rawErrY)) };
  return { n:c0.length, R, meanAngDeg, meanMag:Math.hypot(meanVec.x,meanVec.y), meanVec };
}

function renderResults(){
  updateDataCount();
  const el=$('#resultsBody'); el.innerHTML='';
  // 기본은 "방금 실행한 본실험" 데이터만. 체크박스로 이전 실행까지 전부 볼 수 있음.
  const showAll = !!App.resultsShowAll;
  const T = showAll ? App.trials : App.trials.filter(t=> t.phase!=='main' || t.runId===App.runSeq);
  const mainN=T.filter(t=>t.phase==='main').length;

  let html = `<div class="card row spread" style="padding:12px 18px">
    <span class="note">${showAll? '전체 누적 데이터(이전 실행 포함)를 보고 있습니다.' : '방금 실행한 본실험 결과만 보고 있습니다.'}</span>
    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer">
      <input type="checkbox" id="showAllChk" ${showAll?'checked':''}> 이전 실행 데이터까지 전부 보기
    </label>
  </div>`;

  // ---- 조건별 요약 ----
  const s=summarizeByCondition(T);
  html+=`<div class="card"><h3>조건별 요약 (본실험 ${mainN}시행)</h3>`;
  if (!mainN){ html+='<p class="note">본실험 데이터가 없습니다. 메뉴에서 본실험을 진행하세요.</p>'; }
  else{
    html+=`<table><thead><tr>
      <th class="l">조건</th><th>N</th><th>명중률(%)</th><th>보정후 오차(px)</th><th>원클릭 오차(px)</th><th>평균 MT(ms)</th>
      <th>보정적용(%)</th><th>오보정률(%)</th><th>시선선행(ms)</th></tr></thead><tbody>`;
    const label=CONDLABEL;
    for (const c of ['C0','C1','C2','C3','C4']){
      const r=s[c];
      html+=`<tr><td class="l">${label[c]}</td>`+
        (r? `<td>${r.n}</td><td>${fmt(r.hitRate)}</td><td>${fmt(r.errMean)}</td><td>${fmt(r.rawErrMean)}</td><td>${fmt(r.mtMean,0)}</td>
             <td>${fmt(r.appliedRate)}</td><td>${fmt(r.misdirectRate)}</td><td>${r.gazeLeadMean!=null?fmt(r.gazeLeadMean,0):'–'}</td>`
           : `<td colspan="8" class="note">데이터 없음</td>`)+`</tr>`;
    }
    html+='</tbody></table>';
    // 증분 효과
    const d=(a,b,key,inv)=>{ if(!s[a]||!s[b])return '–'; const v=s[b][key]-s[a][key]; return (inv? -v: v).toFixed(1); };
    html+=`<div class="sep"></div><h3>요소 기여 분리 (증분 효과)</h3><ul class="tight">
      <li><b>UI 효과</b> C0→C1 명중률 Δ = <b>${d('C0','C1','hitRate')}</b>%p, 오차 Δ = ${d('C0','C1','errMean')}px</li>
      <li><b>시선 효과</b> C0→C2 명중률 Δ = <b>${d('C0','C2','hitRate')}</b>%p</li>
      <li><b>결합 이득</b> (C1,C2)→C3 명중률 Δ = <b>${s.C3&&s.C1? (s.C3.hitRate-Math.max(s.C1.hitRate,s.C2?.hitRate??-1)).toFixed(1):'–'}</b>%p</li>
      <li><b>개인 학습 이득</b> C3→C4 명중률 Δ = <b>${d('C3','C4','hitRate')}</b>%p, 오차 Δ = ${d('C3','C4','errMean')}px</li>
    </ul>`;
  }
  html+='</div>';

  // ---- H1 개인 패턴 일관성 ----
  const h1=h1Consistency(T);
  html+=`<div class="card"><h3>H1 · 개인 클릭 오차의 일관성 (무보정 C0)</h3>`;
  if (!h1) html+='<p class="note">C0 시행 5건 이상 필요.</p>';
  else{
    const verdict = h1.R>0.5? '방향성이 뚜렷 — 개인화 정당화됨' : (h1.R>0.25? '약한 방향성' : '거의 무작위');
    html+=`<ul class="tight">
      <li>표본 n = ${h1.n}</li>
      <li>평균저항 R̄ = <b>${fmt(h1.R,3)}</b> (0=무작위 · 1=완전일관) → ${verdict}</li>
      <li>평균 오차 방향 = ${fmt(h1.meanAngDeg,0)}° · 평균 크기 = ${fmt(h1.meanMag)}px</li>
      <li>평균 오차 벡터 = (${fmt(h1.meanVec.x)}, ${fmt(h1.meanVec.y)}) px</li>
    </ul><p class="note">R̄가 클수록 클릭 오차가 특정 방향으로 일관되게 치우침을 뜻함(개인 편향).</p>`;
  }
  html+='</div>';

  // ---- 난이도 상호작용(H5) 간이표 ----
  const mainT=T.filter(t=>t.phase==='main');
  if (mainT.length){
    html+=`<div class="card"><h3>H5 · 난이도별 보정 이득 (명중률 C4 − C0)</h3>`;
    html+=`<table><thead><tr><th>크기</th><th>거리</th><th>시간압박</th><th>C0 명중률</th><th>C4 명중률</th><th>Δ(%p)</th></tr></thead><tbody>`;
    for (const size of ['small','large']) for (const dd of ['near','far']) for (const tp of ['none','limited']){
      const c0=mainT.filter(t=>t.cond==='C0'&&t.size===size&&t.distance===dd&&t.timePressure===tp);
      const c4=mainT.filter(t=>t.cond==='C4'&&t.size===size&&t.distance===dd&&t.timePressure===tp);
      if (!c0.length&&!c4.length) continue;
      const h0=c0.length? c0.filter(t=>t.hit).length/c0.length*100:null;
      const h4=c4.length? c4.filter(t=>t.hit).length/c4.length*100:null;
      const dl=(h0!=null&&h4!=null)? (h4-h0).toFixed(1):'–';
      html+=`<tr><td>${size==='small'?'작음':'큼'}</td><td>${dd==='near'?'가까움':'멂'}</td><td>${tp==='limited'?'있음':'없음'}</td>
        <td>${h0!=null?fmt(h0):'–'}</td><td>${h4!=null?fmt(h4):'–'}</td><td><b>${dl}</b></td></tr>`;
    }
    html+='</tbody></table><p class="note">설계 H5: 작고·멀고·시간압박 있는 어려운 조건에서 보정 이득(Δ)이 더 클 것으로 예측.</p></div>';
  }

  // ---- 예비실험 A ----
  if (App.preA?.length){
    const zh=App.preA.filter(r=>r.zoneHit).length;
    html+=`<div class="card"><h3>예비실험 A · 시선 특성화</h3><ul class="tight">
      <li>측정 지점 = ${App.preA.length}</li>
      <li>평균 시선 오차 = <b>${fmt(mean(App.preA.map(r=>r.errDist)),0)}px</b></li>
      <li>구역 판별 정확도(${App.cfg.gridCols}×${App.cfg.gridRows}) = <b>${fmt(zh/App.preA.length*100)}%</b></li>
    </ul><p class="note">픽셀 정밀도가 아닌 '구역 수준' 정확도임을 확인 → C2·C3의 구역 분할 근거.</p></div>`;
  }
  // ---- 예비실험 B ----
  if (App.preB?.length){
    html+=`<div class="card"><h3>예비실험 B · UI(DOM) 확인</h3>
      <table><thead><tr><th>방해 밀도</th><th>DOM 읽기(ms)</th><th>중심오차 최대(px)</th><th>표적 탐색(ms)</th><th>정답</th></tr></thead><tbody>`;
    for (const r of App.preB) html+=`<tr><td>${r.density}</td><td>${fmt(r.domReadMs,2)}</td><td>${fmt(r.domCenterMaxErrPx,1)}</td><td>${fmt(r.findMs,0)}</td><td>${r.correctPick?'○':'×'}</td></tr>`;
    html+='</tbody></table><p class="note">DOM은 지연 없이 정확히 버튼 좌표를 제공. 밀도↑ 시 사람의 탐색시간이 증가.</p></div>';
  }

  el.innerHTML=html;
  $('#showAllChk').addEventListener('change', (e)=>{ App.resultsShowAll = e.target.checked; renderResults(); });
}

/* ------------------------------------------------------------------ */
/* 11. 안내문                                                           */
/* ------------------------------------------------------------------ */
const BRIEFS={
  calib:{ title:'① 시선 보정하기', body:`
    <p>웹캠으로 "지금 어디를 보고 있나"를 추측하려면, 먼저 몇 개 지점을 봐서 기준을 잡아야 합니다.</p>
    <ul class="tight">
      <li>화면에 <b>빨간 점 9개</b>가 나타납니다.</li>
      <li>각 점을 <b>바라보면서 5번씩 클릭</b>하세요. 점이 초록색이 되면 완료.</li>
      <li>얼굴이 웹캠 중앙에 오도록 하고, 끝날 때까지 <b>머리 위치를 고정</b>하세요.</li>
    </ul>
    <p class="note">웹캠 권한을 허용해야 합니다. 시선추적을 안 쓰는 실험은 이 단계 없이도 진행할 수 있어요.</p>` },
  preA:{ title:'② 시선 정확도 확인', body:`
    <p>방금 맞춘 시선추적이 실제로 얼마나 정확한지 확인하는 단계입니다.</p>
    <ul class="tight">
      <li>화면 여러 지점에 표적이 나타납니다. <b>표적을 응시한 뒤 클릭</b>하세요.</li>
      <li>시선이 예측한 위치와 실제 위치가 얼마나 차이나는지 측정합니다.</li>
    </ul>
    <p class="note">먼저 ①번(시선 보정)을 끝내야 합니다.</p>` },
  preB:{ title:'③ 버튼 인식 확인', body:`
    <p>브라우저가 화면의 버튼 위치·크기를 얼마나 정확하고 빠르게 읽는지, 버튼이 많아지면 어떻게 되는지 봅니다.</p>
    <ul class="tight">
      <li>화면에 있는 버튼 개수가 <b>3 → 8 → 16 → 28</b>개로 점점 늘어납니다.</li>
      <li>각 화면에서 <b>파란 표적</b>을 클릭하세요.</li>
    </ul>` },
  main:{ title:'④ 진짜 실험 (본실험)', body:`
    <p>보정 방식을 다르게 조합한 여러 조건을 다 해보면서, 어떤 방식이 클릭을 제일 잘 맞혀주는지 비교합니다.</p>
    <ul class="tight">
      <li><b>HOME</b>을 클릭 → 잠시 후 <b>파란 표적(●)</b>과 방해 버튼이 나타납니다.</li>
      <li>표적을 <b>최대한 정확·빠르게</b> 클릭하세요. 시간압박 조건에서는 제한시간이 있습니다.</li>
      <li>매 시행 후 정답(초록 테두리)·원클릭(빨강)·보정점(초록)이 잠깐 표시됩니다.</li>
      <li>조건 순서는 자동으로 정해집니다. 신경 안 쓰셔도 됩니다.</li>
    </ul>
    <p class="note">중간에 <span class="kbd">중단</span> 버튼으로 멈출 수 있으며, 그때까지의 데이터는 저장됩니다.</p>` },
};
function showBrief(name){
  const b=BRIEFS[name]; if(!b){ startPhase(name); return; }
  $('#briefTitle').textContent=b.title; $('#briefBody').innerHTML=b.body;
  go('brief'); $('#briefStart').onclick=()=>startPhase(name);
}
async function startPhase(name){
  if (!App.pid){ alert('먼저 참가자 ID를 입력하세요.'); go('menu'); return; }
  // 시선 사용을 선택했는데 아직 보정을 안 했다면, main·preA 모두 먼저 보정부터 강제한다.
  // (본실험을 보정 없이 시작하면 시선 파이프라인이 아예 시작되지 않아 C2~C4가
  //  경고 없이 무보정으로 진행되고 데이터가 무효화되므로 반드시 막아야 한다.)
  if ((name==='main'||name==='preA') && App.cfg.useGaze && !App.gazeReady && name!=='calib'){
    await startCalibration(); return;
  }
  if (name==='calib') return startCalibration();
  if (name==='preA')  return startPreA();
  if (name==='preB')  return startPreB();
  if (name==='main')  return startMain();
}

/* ------------------------------------------------------------------ */
/* 12. 설정 읽기 / 이벤트 바인딩                                        */
/* ------------------------------------------------------------------ */
function readConfig(){
  App.pid = $('#pid').value.trim() || null;
  App.cfg.repsPerCell = clamp(parseInt($('#repsPerCell').value)||2, 1, 10);
  const g = parseInt($('#gridSel').value);
  if (g===4){ App.cfg.gridCols=4; App.cfg.gridRows=3; }
  else if (g===2){ App.cfg.gridCols=2; App.cfg.gridRows=2; }
  else if (g===6){ App.cfg.gridCols=3; App.cfg.gridRows=2; }
  else { App.cfg.gridCols=3; App.cfg.gridRows=3; }
  App.cfg.useGaze = $('#useGaze').value==='yes';
  App.cfg.conditions = $$('.condChk').filter(c=>c.checked).map(c=>c.value);
}
function recalcTotal(){
  const reps=clamp(parseInt($('#repsPerCell').value)||2,1,10);
  const nCond = $$('.condChk').filter(c=>c.checked).length || 5;
  $('#condCount').textContent = nCond;
  $('#totalCalc').textContent = nCond*2*2*2*reps;
}

window.addEventListener('DOMContentLoaded', ()=>{
  updateDataCount();

  $('#repsPerCell').addEventListener('input', recalcTotal); recalcTotal();
  $$('.condChk').forEach(c=> c.addEventListener('change', recalcTotal));

  // 메뉴의 단계 버튼
  $$('[data-go]').forEach(b=> b.addEventListener('click', ()=>{
    let g=b.dataset.go;
    if (g==='menu'){ go('menu'); return; }
    if (g==='results'){ go('results'); renderResults(); return; }
    readConfig();
    // "방식별로 비교해보기" 버튼: 무보정 대비 해당 방식만 딱 1시행씩 돌리는 빠른 비교.
    const TRY_CONDS = { tryUI:['C0','C1'], tryGaze:['C0','C2'], tryBoth:['C0','C3'] };
    App.cfg.quickMode = (g==='mainQuick') || !!TRY_CONDS[g];
    if (TRY_CONDS[g]){
      if ((g==='tryGaze'||g==='tryBoth') && !App.cfg.useGaze){
        alert('시선을 쓰는 비교예요. 먼저 위에서 "시선추적 사용"을 켜주세요.'); return;
      }
      App.cfg.conditions = TRY_CONDS[g];
      g = 'main';
    } else if (g==='mainQuick'){ g='main'; }
    if (['calib','preA','preB','main'].includes(g)){
      if (!App.pid){ alert('먼저 참가자 ID를 입력하세요.'); return; }
      if (g==='main' && !App.cfg.conditions.length){ alert('본실험에 포함할 조건을 최소 1개 체크하세요.'); return; }
      // 시선 사용이고 아직 미시작이면, calib/preA/main 진입 시 자동 시작 시도
      showBrief(g);
    }
  }));

  $('#briefStart') && ($('#briefStart').onclick=()=>{});
  $('#sbAbort').addEventListener('click', ()=>{ App.abort=true; });

  $('#btnExportJSON').addEventListener('click', exportJSON);
  $('#btnExportCSV').addEventListener('click', exportCSV);
  $('#btnExportJSON2').addEventListener('click', exportJSON);
  $('#btnExportCSV2').addEventListener('click', exportCSV);
  $('#btnClear').addEventListener('click', ()=>{
    if (confirm('기록된 모든 시행 데이터를 삭제할까요?')){ App.trials=[]; App.preA=[]; App.preB=[]; App.personal.reset(); persist(); }
  });

  // 시선 사용 선택 시 미리 WebGazer 준비(권한 프롬프트는 보정 때)
  $('#useGaze').addEventListener('change', ()=>{ App.cfg.useGaze = $('#useGaze').value==='yes'; });
});
