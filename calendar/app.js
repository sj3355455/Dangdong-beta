// 당동 캘린더 — 정기전 일정 · 경기 판수 · 참여 익명 투표
//
// 익명성은 서버(RLS)가 지킨다. 이 파일은 남의 표를 조회하는 코드를 아예 갖고 있지 않다.
//   · 내 표      : day_votes 에서 내 행만 읽고 쓴다 (RLS 가 남의 행을 막는다)
//   · 인원수     : vote_counts() 함수가 서버에서 세어 O/X 숫자만 돌려준다
// 자세한 정책은 저장소 루트의 sql/calendar/ 참고 (1~4 를 순서대로 실행).
import { sbFetch } from '../record/supabase.js';
import { registerSW, getTheme, applyTheme, LS_THEME, initTeamModal,
         shiftDay, openDayPicker } from '../record/common.js';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const LS_AUTH = 'dangScoreAuth', LS_TEAM = 'dangCurrentTeam';
const getAuth = () => { try { const v = localStorage.getItem(LS_AUTH); return v ? JSON.parse(v) : null; } catch(e){ return null; } };
const tGet = () => { try { return JSON.parse(localStorage.getItem(LS_TEAM)); } catch(e){ return null; } };
const tSet = v => { try { localStorage.setItem(LS_TEAM, JSON.stringify(v)); } catch(e){} };

let myTeams = [];
let currentTeam = tGet();
let isTeamLeader = false;

// 보고 있는 달 (1일 기준)
let cur = new Date(); cur.setDate(1); cur.setHours(0, 0, 0, 0);

// 이번 달 데이터 — 모두 'YYYY-MM-DD' 를 키로 쓴다
let events = {};    // 날짜 → { id, round_no, note }
let gameCnt = {};   // 날짜 → 경기 판수
let counts = {};    // 날짜 → { o, x }
let myVote = {};    // 날짜 → { c:'o'|'x', slots, from, to } — day_votes 의 내 행. slots 은 시간대 비트합
                    // (from/to 는 slots 이전 기록을 환산할 때만 쓴다)
let planSpans = []; // 이 달에 걸린 일정 막대 [{ name, from, to, cnt }] — 이름·기간·인원수만 (익명)
let myPlans = [];   // 내가 등록한 일정 [{ id, name, start_date, end_date }] — 지우려면 이게 필요하다
let loading = false;
let loadErr = '';   // 이번 달 데이터를 못 불러온 이유 (화면에 그대로 띄운다)

// ── 날짜 유틸 (로컬 시간 기준. toISOString 은 UTC 라 하루 밀릴 수 있어 쓰지 않는다) ──
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const todayStr = () => ymd(new Date());
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
// 지난 날짜엔 투표할 수 없다 (이미 지나간 날의 참여 여부를 받을 이유가 없다).
// 키가 'YYYY-MM-DD' 라 문자열 비교로 충분하다.
const isPast = key => key < todayStr();
// 그 날 내가 등록해 둔 일정들
const plansOn = key => myPlans.filter(p => p.start_date <= key && key <= p.end_date);
// 그 날 내 선택 ('o' | 'x' | null). 일정은 개인 메모일 뿐 참석 여부가 아니라서 여기에 끼지 않는다
// (서버 vote_counts 도 같은 기준으로 센다). myVote 는 시간까지 담은 객체라 한 겹 벗겨서 쓴다.
const myChoice = key => (myVote[key] && myVote[key].c) || null;
const label = key => {
  const [y, m, dd] = key.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  return `${m}월 ${dd}일 (${DOW[d.getDay()]})`;
};

// ══ 데이터 ══
async function loadTeams(){
  const auth = getAuth();
  if (!auth || !auth.uid) { myTeams = []; return; }
  try {
    const rows = await sbFetch('/rest/v1/rpc/my_teams', { method: 'POST', body: JSON.stringify({}) });
    myTeams = Array.isArray(rows) ? rows : [];
    const remembered = tGet();
    if (remembered && myTeams.some(t => t.id === remembered)) currentTeam = remembered;
    else currentTeam = myTeams[0] ? myTeams[0].id : null;
    tSet(currentTeam);
  } catch(e){ /* my_teams 미배포 → 팀 없음으로 처리 */ }
  const me = myTeams.find(t => t.id === currentTeam);
  isTeamLeader = !!(me && me.is_admin);
}

// 이번 달의 첫날/마지막날 (문자열)
function monthRange(){
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const last  = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
  return [ymd(first), ymd(last)];
}

let monthCache = {};

function getMonthKey() {
  return (currentTeam || 'none') + ':' + cur.getFullYear() + '-' + pad(cur.getMonth() + 1);
}

function updateMonthCache() {
  const k = getMonthKey();
  monthCache[k] = {
    events: { ...events },
    gameCnt: { ...gameCnt },
    counts: { ...counts },
    myVote: { ...myVote },
    planSpans: [...planSpans],
    myPlans: [...myPlans],
    loadErr
  };
}

function clearMonth(){
  events = {}; gameCnt = {}; counts = {}; myVote = {};
  planSpans = []; myPlans = []; loadErr = '';
}
function applyCache(c){
  events = { ...c.events };
  gameCnt = { ...c.gameCnt };
  counts = { ...c.counts };
  myVote = { ...c.myVote };
  planSpans = [...(c.planSpans || [])];
  myPlans = [...(c.myPlans || [])];
  loadErr = c.loadErr;
}

async function loadMonth(force = false){
  if (!currentTeam) { clearMonth(); return; }
  const cacheKey = getMonthKey();
  if (!force && monthCache[cacheKey]) { applyCache(monthCache[cacheKey]); return; }

  clearMonth();
  const [d1, d2] = monthRange();
  const auth = getAuth();

  // 다음 달 1일 00:00 (경기 조회 상한 — played_at 은 timestamptz 라 날짜 비교가 아니라 범위로 자른다)
  const nextMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);

  const [ev, games, cnt, mine, spans, plans] = await Promise.allSettled([
    sbFetch(`/rest/v1/club_events?select=id,event_date,round_no,note&team_id=eq.${currentTeam}`
          + `&event_date=gte.${d1}&event_date=lte.${d2}`),
    sbFetch(`/rest/v1/games?select=played_at&team_id=eq.${currentTeam}`
          + `&played_at=gte.${d1}T00:00:00&played_at=lt.${ymd(nextMonth)}T00:00:00`),
    sbFetch('/rest/v1/rpc/vote_counts', { method: 'POST', body: JSON.stringify({ t: currentTeam, d1, d2 }) }),
    auth && auth.uid
      ? sbFetch(`/rest/v1/day_votes?select=vote_date,choice,slots,from_hour,to_hour&team_id=eq.${currentTeam}`
              + `&vote_date=gte.${d1}&vote_date=lte.${d2}`)
      : Promise.resolve([]),
    sbFetch('/rest/v1/rpc/plan_spans', { method: 'POST', body: JSON.stringify({ t: currentTeam, d1, d2 }) }),
    auth && auth.uid
      ? sbFetch(`/rest/v1/day_plans?select=id,name,start_date,end_date&team_id=eq.${currentTeam}`
              + `&start_date=lte.${d2}&end_date=gte.${d1}`)
      : Promise.resolve([])
  ]);

  if (ev.status === 'fulfilled' && Array.isArray(ev.value))
    for (const e of ev.value) events[e.event_date] = e;

  if (games.status === 'fulfilled' && Array.isArray(games.value))
    for (const g of games.value) {
      const k = ymd(new Date(g.played_at));
      gameCnt[k] = (gameCnt[k] || 0) + 1;
    }

  // 남의 표는 RLS 로 막혀 있어 이 집계 함수 말고는 인원수를 알 방법이 없다.
  // 그래서 여기서 실패하면 '나만 보이고 남은 안 보이는' 상태가 된다 → 조용히 넘기지 않고 드러낸다.
  // hours/reasons 는 vote_counts 를 새로 배포하기 전이면 안 온다 → 빈 배열로 두고 나머지는 그대로 굴린다
  if (cnt.status === 'fulfilled' && Array.isArray(cnt.value))
    for (const c of cnt.value) counts[c.vote_date] = {
      o: c.o_cnt || 0, x: c.x_cnt || 0,
      hours: Array.isArray(c.hours) ? c.hours : [],       // [[토막, 인원], ...] 0=오전 1=오후 2=저녁
      reasons: Array.isArray(c.reasons) ? c.reasons : []  // [[사유, 인원], ...]
    };
  else
    loadErr = describeCountErr(cnt.reason);

  // day_votes 는 RLS 상 '내 행'만 돌아온다 — 그래서 이게 곧 내 표다
  if (mine.status === 'fulfilled' && Array.isArray(mine.value)) {
    for (const v of mine.value)
      myVote[v.vote_date] = { c: v.choice, slots: v.slots, from: v.from_hour, to: v.to_hour };
  } else if (!loadErr) {
    loadErr = '내 투표를 불러오지 못했습니다: ' + errText(mine.reason);
  }

  // 일정 기능은 나중에 붙었다. sql/calendar/4-plan-spans.sql 을 아직 안 돌린 서버라면 여기서 404 가 난다.
  // 막대가 안 보일 뿐 달력은 그대로 쓸 수 있으므로 조용히 비워 두고 넘어간다.
  planSpans = (spans.status === 'fulfilled' && Array.isArray(spans.value))
    ? spans.value.map(r => ({ name: r.name, from: r.start_date, to: r.end_date, cnt: r.cnt }))
    : [];
  myPlans = (plans.status === 'fulfilled' && Array.isArray(plans.value)) ? plans.value : [];

  updateMonthCache();
}

const errText = e => (e && (e.message || e.msg)) || '알 수 없는 오류';

// 집계 실패는 원인이 갈린다. 사람이 바로 조치할 수 있게 구분해서 알려준다.
function describeCountErr(e){
  const st = e && e.status;
  if (st === 404 || st === 400) {
    return '투표 집계 함수(vote_counts)를 찾지 못했습니다. sql/calendar/3-vote-counts.sql 을 Supabase 에서 '
         + '실행했는지, 실행했다면 스키마 캐시가 갱신됐는지 확인해 주세요. (' + errText(e) + ')';
  }
  if (st === 401 || st === 403) {
    return '투표 집계를 볼 권한이 없습니다. 이 팀의 팀원인지 확인해 주세요. (' + errText(e) + ')';
  }
  return '투표 인원수를 불러오지 못했습니다: ' + errText(e);
}

// ══ 화면 ══
// 칸 둘째 줄 — 정기전 회차. 일정 막대가 앉는 자리와 같지만, 막대는 정기전 칸을 비켜 가므로
// (barsForWeek 의 skip) 둘이 한 칸에서 겹치는 일은 없다.
function cellR2Html(key){
  const ev = events[key];
  if (!ev) return '';
  // 회차가 세 자리면 좁은 폰(320px)에서 '제12…' 로 잘려 엉뚱한 회차로 읽힌다 → 그때만 한 호 줄인다
  const sm = String(ev.round_no || '').length >= 3 ? ' sm' : '';
  return `<span class="evchip${sm}">${ev.round_no ? '제' + esc(ev.round_no) + '회' : '정기전'}</span>`;
}

// 칸 셋째 줄 — 지난 날은 '몇 판 쳤나', 오늘·앞으로는 '몇 명 되나'. 그 시점에 쓸모 있는 쪽만 남긴다.
// 정기전이든 아니든 같은 규칙이다 — 회차는 둘째 줄이 맡으므로 여기서 자리를 다투지 않는다.
// 붓 모드가 칸 하나만 다시 그릴 때도 이걸 쓴다.
function cellR3Html(key){
  const g = gameCnt[key], c = counts[key] || { o: 0, x: 0 };
  // 오늘 친 판수를 바로 띄우면 아직 유효한 O/X 와 자리를 다툰다 → 판수는 날짜가 지난 뒤부터.
  if (isPast(key)) return g ? `<span class="gchip">${g}판</span>` : '';
  return (c.o || c.x) ? `<b class="vo">${c.o}</b><i class="vsep">/</i><b class="vx">${c.x}</b>` : '';
}

function render(){
  const view = $('#view');
  const auth = getAuth();

  if (!auth) {
    view.innerHTML = `<div class="card"><div class="empty">
      캘린더를 쓰려면 로그인이 필요합니다.
      <div style="margin-top:18px"><a href="../score/" class="bigbtn" style="display:inline-block;text-decoration:none;max-width:260px;">점수판으로 가서 로그인</a></div>
    </div></div>`;
    return;
  }
  if (!currentTeam) {
    view.innerHTML = `<div class="card"><div class="empty">
      소속된 팀이 없습니다.<br>⚙️ 설정 → 팀 설정에서 팀에 참가하거나 만들어 주세요.
    </div></div>`;
    return;
  }

  const y = cur.getFullYear(), m = cur.getMonth();
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = first.getDay();               // 1일 앞의 빈 칸 수
  const today = todayStr();

  // 달력을 '주' 단위로 쌓는다. 여러 날짜에 걸친 일정 막대를 한 줄로 이으려면
  // 그 주 안에서 몇 번째 칸부터 몇 칸인지를 알아야 하기 때문이다.
  const slots = [];                                    // 42칸 안팎의 격자 — 앞뒤 빈 칸은 null
  for (let i = 0; i < lead; i++) slots.push(null);
  for (let d = 1; d <= daysInMonth; d++) slots.push(`${y}-${pad(m + 1)}-${pad(d)}`);
  while (slots.length % 7) slots.push(null);

  const spans = spansForMonth();                       // 이 달의 일정 (사유별로 이어 붙인 구간)
  const isEvent = k => !!events[k];                    // 정기전 칸에서는 막대를 끊는다

  // 주마다 막대를 먼저 계산해서 '이 달에서 가장 많이 쌓인 줄 수'를 구한다.
  // 주마다 다른 높이를 쓰면 인원수와 막대의 세로 위치가 주마다 달라져 눈이 어지럽다.
  const laid = [];
  for (let w = 0; w * 7 < slots.length; w++) {
    const row = slots.slice(w * 7, w * 7 + 7);
    laid.push({ row, bars: barsForWeek(row, spans, isEvent) });
  }
  const monthLanes = laid.reduce((n, wk) =>
    Math.max(n, wk.bars.reduce((m, b) => Math.max(m, b.lane + 1), 0)), 0);
  // 둘째 줄 높이 (달 전체 공통) — 막대 줄 수로 정하되, 이 달에 정기전이 있으면
  // 회차가 앉을 한 줄은 반드시 남긴다. 일정이 하나도 없는 달이라도 회차는 떠야 하기 때문이다.
  const hasEvent = slots.some(k => k && events[k]);
  const barBox = Math.max(monthLanes * (BAR_H + 2), hasEvent ? EV_H : 0);

  let weeks = '';
  for (const { row, bars } of laid) {
    let cells = '';
    for (const key of row) {
      if (!key) { cells += '<div class="cell pad"></div>'; continue; }
      const d = Number(key.slice(8));
      const dow = new Date(y, m, d).getDay();
      const ev = events[key], mv = myChoice(key);
      // 지난 날의 참여 투표는 이미 의미가 없다 → 내 표·표시 테두리를 지우고
      // 그날 실제로 있었던 일(정기전·판수)만 남긴다. 셋째 줄도 cellR3Html 이 같은 기준으로 가른다.
      const past = key < today;
      const cls = ['cell'];
      if (ev) cls.push('event');
      if (key === today) cls.push('today');
      // 내 표는 테두리 색으로만 알린다 (초록=가능, 빨강=불가). 칸 안에 표시를 얹지 않는다.
      if (mv && !past) cls.push(mv === 'o' ? 'vo' : 'vx');
      if (past) cls.push('past');          // 투표 불가 — 눌러서 정기전·판수는 볼 수 있다
      const dcls = dow === 0 ? ' sun' : dow === 6 ? ' sat' : '';
      // 첫째 줄 = 날짜만(가운데), 둘째 줄 = 정기전 회차 · 일정 막대, 셋째 줄 = 인원수 또는 판수.
      // 정기전 회차를 날짜 옆에 두면 날짜가 가운데를 못 잡아 아랫줄로 내렸다.
      // .rbar 에는 막대가 얹히지만(.wbars 가 그 위에 그린다) 막대는 정기전 칸을 비켜 가므로
      // 회차와 겹치지 않는다. 줄 높이를 고정해 둬야 칸마다 위아래로 흔들리지 않는다.
      cells += `<div class="${cls.join(' ')}" data-d="${key}">
        <span class="r1"><span class="dnum${dcls}">${d}</span></span>
        <span class="rbar" style="height:${barBox}px">${cellR2Html(key)}</span>
        <span class="r3">${cellR3Html(key)}</span>
      </div>`;
    }
    weeks += `<div class="week"><div class="wrow">${cells}</div>`
           + `<div class="wbars" style="height:${barBox}px">`
           + bars.map(b => `<span class="xbar${b.lcap ? ' lcap' : ''}${b.rcap ? ' rcap' : ''}"
                 style="left:${colLeft(b.col)}; width:${colWidth(b.len)}; top:${b.lane * (BAR_H + 2)}px"
                 title="${esc(b.reason)}">${b.lcap ? esc(b.reason) : ''}</span>`).join('')
           + `</div></div>`;
  }

  view.innerHTML = `
    ${loadErr ? `<div class="card" style="border-color:var(--no)">
      <div style="font-weight:700; color:var(--no); margin-bottom:6px;">⚠️ 투표 현황을 불러오지 못했습니다</div>
      <div class="sub" style="color:var(--text)">${esc(loadErr)}</div>
      <div class="sub" style="margin-top:8px">이 상태에서는 다른 부원의 표가 보이지 않습니다.</div>
    </div>` : ''}
    <div class="monthbar">
      <button class="mbtn" id="prevM" aria-label="이전 달">‹</button>
      <b>${y}년 ${m + 1}월</b>
      <button class="mbtn" id="nextM" aria-label="다음 달">›</button>
    </div>
    ${bulkBarHtml()}
    <div class="dow">${DOW.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="gridclip"><div class="grid${bulkMode ? ' paint' : ''}" id="grid">${weeks}</div></div>
    ${bulkMode ? '' : `<div class="sub" style="text-align:center; margin:14px 0 20px;">
      날짜를 눌러 참여 가능 여부를 남기세요. 누가 골랐는지는 공개되지 않습니다.
    </div>`}
    ${topDaysHtml()}
  `;

  $('#prevM').onclick = () => moveMonth(-1);
  $('#nextM').onclick = () => moveMonth(1);
  bindBulkBar();
  // 붓 모드에서는 칸을 눌러도 시트가 열리지 않는다 — 누른 자리가 곧 표다.
  if (bulkMode) {
    bindPaint($('#grid'));
  } else {
    document.querySelectorAll('#grid .cell[data-d]').forEach(el => {
      el.onclick = () => { if (!swallowClick()) openDay(el.dataset.d); };
    });
    bindSwipe($('#grid'));
  }
}

// ══ 좌우 드래그로 달 넘기기 ══
// 격자는 CSS 의 touch-action:pan-y 로 가로 제스처만 넘겨받는다 — 세로 스크롤은 브라우저가 그대로 처리.
// 포인터 이벤트라 손가락과 마우스가 같은 코드를 탄다.
const SWIPE_GO = 60;    // 이만큼 끌면 달이 넘어간다
const SWIPE_SLOP = 12;  // 이 전에는 가로/세로 방향을 판단하지 않는다
let swipedAt = 0;       // 스와이프 직후 따라오는 click 을 한 번 무시하기 위한 표시

// 드래그로 달을 넘긴 직후의 click 이면 삼킨다 (날짜 상세가 열리지 않도록)
const swallowClick = () => Date.now() - swipedAt < 400;

function bindSwipe(grid){
  if (!grid) return;
  let x0 = 0, y0 = 0, dx = 0, dragging = false, decided = false, horiz = false;

  const reset = () => { grid.style.transition = 'transform .18s, opacity .18s'; grid.style.transform = ''; grid.style.opacity = ''; };

  grid.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    x0 = e.clientX; y0 = e.clientY;
    dx = 0; dragging = true; decided = false; horiz = false;
    grid.style.transition = '';
  });

  grid.addEventListener('pointermove', e => {
    if (!dragging || !e.isPrimary) return;
    dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!decided) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
      decided = true;
      horiz = Math.abs(dx) > Math.abs(dy);
      if (!horiz) { dragging = false; reset(); return; }   // 세로 제스처면 손을 뗀다
    }
    // 손가락보다 덜 따라가게 해서 고무줄처럼 끌리는 느낌을 준다
    grid.style.transform = `translateX(${dx * 0.55}px)`;
    grid.style.opacity = String(Math.max(.45, 1 - Math.abs(dx) / 420));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (horiz && Math.abs(dx) >= SWIPE_GO) {
      // 제자리로 되돌리지 않는다 — 지금 위치에서 그대로 이어서 밀려 나가야 뚝 끊기지 않는다
      swipedAt = Date.now();
      moveMonth(dx < 0 ? 1 : -1);
    } else {
      reset();                       // 기준에 못 미치면 제자리로
    }
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
  grid.addEventListener('pointerleave', end);
}

// ══ 일괄 선택 (붓 모드) ══
// 날짜 하나마다 시트를 열고 O/X 를 누르는 게 번거롭다. 표를 먼저 하나 골라 두고(붓)
// 칸을 누르거나 쭉 쓸면 지나간 날이 전부 그 표가 된다. 한 번의 제스처가 한 번의 저장이다.
let bulkMode = false;
let brush = 'o';            // 'o' | 'x' | null(지우기 — 표를 없앤다)
let bulkMsgText = '', bulkMsgKind = '';   // 안내문은 다시 그려도 남아야 해서 상태로 둔다

function bulkBarHtml(){
  // 붓 모드가 아닐 때만 팀장에게 '정기전 설정'을 함께 보인다 — 칠하는 중엔 자리를 다투지 않게.
  if (!bulkMode) return `<div class="bulkbar" style="justify-content:flex-end">
      ${isTeamLeader ? '<button type="button" class="bulkbtn" id="regOn">정기전 설정</button>' : ''}
      <button type="button" class="bulkbtn" id="bulkOn">일괄 선택</button>
    </div>`;
  const on = b => brush === b ? ' on' : '';
  return `<div class="bulkbar">
      <div class="brushes" id="brushes">
        <button type="button" class="o${on('o')}" data-b="o" aria-pressed="${brush === 'o'}">⭕ 가능</button>
        <button type="button" class="x${on('x')}" data-b="x" aria-pressed="${brush === 'x'}">❌ 불가</button>
        <button type="button" class="c${on(null)}" data-b="" aria-pressed="${brush === null}">지우기</button>
      </div>
      <button type="button" class="bulkbtn done" id="bulkOff">완료</button>
    </div>
    <div class="sub bulkhint">고른 표시로 날짜를 누르거나 가로로 쓸어 보세요 · 달 이동은 ‹ › 로</div>
    <div class="bulkmsg${bulkMsgKind ? ' ' + bulkMsgKind : ''}" id="bulkMsg">${esc(bulkMsgText)}</div>`;
}

function bindBulkBar(){
  const reg = $('#regOn');
  if (reg) reg.onclick = openRegModal;
  const on = $('#bulkOn');
  if (on) on.onclick = () => { bulkMode = true; bulkMsg(''); render(); };
  const off = $('#bulkOff');
  if (off) off.onclick = () => { bulkMode = false; bulkMsg(''); render(); };
  const bs = $('#brushes');
  if (bs) bs.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      brush = b.dataset.b || null;
      bs.querySelectorAll('button').forEach(o => {
        const sel = (o.dataset.b || null) === brush;
        o.classList.toggle('on', sel);
        o.setAttribute('aria-pressed', sel);
      });
      bulkMsg('');
    };
  });
}

function bulkMsg(t, kind){
  bulkMsgText = t || ''; bulkMsgKind = kind || '';
  const el = $('#bulkMsg');
  if (el) { el.textContent = bulkMsgText; el.className = 'bulkmsg' + (bulkMsgKind ? ' ' + bulkMsgKind : ''); }
}

// 내 표를 화면 쪽에서만 먼저 바꾼다 (숫자·테두리). 서버 저장은 제스처가 끝난 뒤 한 번에.
function applyLocal(key, next){
  const prev = myChoice(key);
  const c = counts[key] || (counts[key] = { o: 0, x: 0, hours: [], reasons: [] });
  if (prev) c[prev] = Math.max(0, c[prev] - 1);
  if (next) c[next] = (c[next] || 0) + 1;
  // 캐시가 myVote 를 얕게 복사하므로 기존 객체를 고치지 않고 새 객체로 갈아 끼운다
  if (next) myVote[key] = { c: next, slots: next === 'o' ? SLOT_ALL : null, from: null, to: null };
  else delete myVote[key];
}

// 칸 하나만 다시 칠한다 — 칠하는 도중에 render() 를 부르면 손가락 밑의 격자가 통째로 갈려 나간다.
function repaintCell(el, key){
  const mv = myChoice(key), past = isPast(key);
  el.classList.toggle('vo', mv === 'o' && !past);
  el.classList.toggle('vx', mv === 'x' && !past);
  const r3 = el.querySelector('.r3');
  if (r3) r3.innerHTML = cellR3Html(key);
}

// 붓 모드의 칠하기. 달 넘기기 스와이프와 손이 겹치므로 이 모드에선 스와이프를 끄고 ‹ › 만 남긴다.
//
// 손가락 하나로 세 가지를 가려야 한다 — 톡 누르기(한 칸), 가로로 쓸기(여러 칸), 세로로 밀기(화면 스크롤).
// 그래서 격자는 touch-action:pan-y 그대로 두고(세로는 브라우저에 맡긴다), 방향이 정해지기 전에는
// 아무것도 칠하지 않는다. 누르자마자 칠해 버리면 스크롤하려던 손에 표가 찍힌다.
function bindPaint(grid){
  if (!grid) return;
  let painting = false, decided = false, freehand = false;
  let x0 = 0, y0 = 0, startEl = null;
  let changed = null;        // key → 바꾸기 전의 내 표 (실패하면 이걸로 되돌린다)

  const cellAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest('#grid .cell[data-d]') : null;
  };

  const touch = el => {
    if (!el || !changed) return;
    const key = el.dataset.d;
    // 한 제스처 안에서 이미 지나간 칸은 다시 건드리지 않는다 (손이 왔다 갔다 해도 결과가 같도록)
    if (!key || changed.has(key)) return;
    if (isPast(key)) return bulkMsg('지난 날짜에는 투표할 수 없습니다.', 'err');
    if (myChoice(key) === brush) return;           // 이미 그 표면 쓸 일이 없다
    changed.set(key, myVote[key] || null);
    applyLocal(key, brush);
    repaintCell(el, key);
    vibTick();
  };

  const stop = () => { painting = false; decided = false; startEl = null; changed = null; };

  grid.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    x0 = e.clientX; y0 = e.clientY;
    startEl = cellAt(x0, y0);
    painting = true; decided = false;
    // 마우스는 세로로 끌어도 화면이 스크롤되지 않는다 → 방향을 가릴 필요 없이 자유롭게 칠한다
    freehand = e.pointerType === 'mouse';
    changed = new Map();
    try { grid.setPointerCapture(e.pointerId); } catch(err){}
  });

  grid.addEventListener('pointermove', e => {
    if (!painting || !e.isPrimary) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!decided) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;   // 아직 톡 누른 것일 수도
      // 세로로 미는 손은 스크롤이다 — 표를 하나도 남기지 않고 물러난다
      if (!freehand && Math.abs(dy) >= Math.abs(dx)) return stop();
      decided = true;
      touch(startEl);                 // 이제야 시작 칸부터 칠한다
    }
    touch(cellAt(e.clientX, e.clientY));
  });

  const end = e => {
    if (!painting) return;
    try { grid.releasePointerCapture(e.pointerId); } catch(err){}
    if (!decided) touch(startEl);     // 움직임 없이 뗀 손 = 한 칸 톡 누르기
    const m = changed;
    stop();
    if (m && m.size) flushBulk(m);
  };
  grid.addEventListener('pointerup', end);
  // 세로 스크롤이 시작되면 브라우저가 포인터를 가져간다 — 그때까지 칠한 건 그대로 저장한다
  grid.addEventListener('pointercancel', end);
}

// 제스처 한 번에 바뀐 날들을 한 번의 요청으로 저장한다 (표 세우기 / 지우기 각각 한 방).
let bulkPending = 0;   // 아직 답을 기다리는 저장 수 — 마지막 하나가 끝날 때만 서버 값을 다시 읽는다
                       // (앞선 저장의 응답으로 다시 읽으면, 그 사이 칠한 칸이 잠깐 원래대로 돌아가 보인다)

async function flushBulk(changes){
  const auth = getAuth();
  if (!auth || !currentTeam) return;
  const b = brush;                       // 저장하는 사이에 붓이 바뀌어도 안내문이 어긋나지 않게
  const n = changes.size;
  const keys = [...changes.keys()];

  updateMonthCache();
  bulkMsg(`${n}일 저장 중...`);
  render();                              // 요약(모이기 좋은 날)까지 새 값으로 — 제스처는 이미 끝났다

  bulkPending++;
  let saved = false;
  try {
    const sets = keys.filter(k => myChoice(k));
    const dels = keys.filter(k => !myChoice(k));
    if (sets.length) await upsertVotes(sets.map(k => rowFor(k, myVote[k])));
    if (dels.length) await sbFetch(`/rest/v1/day_votes?team_id=eq.${currentTeam}&user_id=eq.${auth.uid}`
      + `&vote_date=in.(${dels.join(',')})`, { method: 'DELETE' });
    saved = true;
  } catch(e){
    for (const [k, prev] of changes) {
      applyLocal(k, prev && prev.c);
      if (prev) myVote[k] = prev;        // 시간대(slots)까지 그대로 되살린다
    }
    updateMonthCache();
    bulkMsg(`저장하지 못했습니다: ${errText(e)}`, 'err');
    render();
  } finally { bulkPending--; }

  if (!saved) return;
  bulkMsg(b ? `${n}일을 ${b === 'o' ? '가능으로' : '불가로'} 저장했습니다.` : `${n}일의 표를 지웠습니다.`, 'ok');
  if (!bulkPending) await refresh(true); // 서버 집계(시간대별 인원)를 다시 읽어 맞춘다
  else { updateMonthCache(); render(); }
}

// 이번 달에서 모이기 좋은 날 — 가능 인원이 많고 불가 인원이 적은 순.
// 약속을 잡으려고 보는 목록이므로 이미 지난 날짜는 뺀다.
function topDaysHtml(){
  const rows = Object.keys(counts)
    .map(k => ({ k, o: counts[k].o || 0, x: counts[k].x || 0 }))
    .filter(r => r.o > 0 && !isPast(r.k))
    .sort((a, b) => (b.o - b.x) - (a.o - a.x) || b.o - a.o || a.k.localeCompare(b.k))
    .slice(0, 5);
  if (!rows.length) return '';
  const max = Math.max(...rows.map(r => r.o + r.x));
  return `<div class="card">
    <div style="font-weight:700; margin-bottom:6px;">🗓 모이기 좋은 날</div>
    <div class="sub" style="margin-bottom:6px;">가능 인원이 많고 불가 인원이 적은 순</div>
    ${rows.map(r => `<div class="topday">
      <span class="d">${label(r.k)}</span>
      <span class="bar">
        <i class="o" style="width:${(r.o / max) * 100}%"></i>
        <i class="x" style="width:${(r.x / max) * 100}%"></i>
      </span>
      <span class="n">O ${r.o} · X ${r.x}</span>
    </div>`).join('')}
  </div>`;
}

// ══ 여러 날에 걸친 일정 막대 ══
// 서버는 날짜별로 [사유, 인원] 만 준다. 같은 사유가 연달아 붙어 있는 구간을 여기서 이어 붙여
// 하나의 일정으로 본다. 이름만 쓰므로 누가 등록했는지는 여전히 드러나지 않는다.
const BAR_H = 13;                                   // 막대 한 줄 높이(px)
const EV_H = BAR_H + 2;                             // 정기전 회차가 앉을 최소 높이 — 막대 한 줄과 같게 둔다
// 칸 간격은 CSS 의 --gap 하나만 보고 계산한다 — 여기에 숫자를 박아 두면 CSS 를 고칠 때 막대가 어긋난다.
// INSET: 칸 폭에 딱 맞추면 둥근 모서리 밖으로 삐져나와 보이므로 양쪽을 조금 들여 그린다.
// 막대는 칸 세로 한가운데(top:26px)에 놓여 둥근 모서리와 멀다. 그래서 조금만 들여도 되고,
// 좁은 폰에서 이름 한두 글자가 더 들어가는 쪽이 훨씬 쓸모 있다. 5 → 2 로 줄여 폭 6px 을 벌었다.
const BAR_INSET = 2;
const colLeft  = i => `calc((100% - var(--gap) * 6) / 7 * ${i} + var(--gap) * ${i} + ${BAR_INSET}px)`;
const colWidth = n => `calc((100% - var(--gap) * 6) / 7 * ${n} + var(--gap) * ${n - 1} - ${BAR_INSET * 2}px)`;

// 이 달에 보이는 모든 일정 구간 → [{ reason, from, to }]  (from/to 는 'YYYY-MM-DD')
// 서버가 '이름 + 기간' 그대로 돌려주므로 날짜별 사유를 이어 붙이던 추측이 필요 없다.
// 덕분에 이름이 같아도 기간이 다르면 각각 다른 막대로 그려진다.
function spansForMonth(){
  return planSpans.map(s => ({ reason: s.name, from: s.from, to: s.to }));
}

// 한 주(7칸)에 걸치는 막대 조각들 → 겹치지 않게 위아래 줄(lane)을 배정한다.
// 정기전 칸(skip)에서는 막대를 끊는다 — 그 칸은 색칠로 이미 꽉 차 있어 침범하면 안 된다.
function barsForWeek(row, spans, skip = () => false){
  const segs = [];
  for (const s of spans) {
    let col = -1, len = 0;
    const flush = () => {
      if (col < 0) return;
      segs.push({
        reason: s.reason, col, len,
        // 주 안에서 끊긴 자리는 실제로 보이는 끝이므로 둥글게 만다.
        // 주 가장자리에 딱 붙었는데 일정이 더 이어질 때만 각지게 남겨 다음 주와 이어 보이게 한다.
        lcap: col > 0 || row[0] === s.from,
        rcap: col + len < 7 || row[6] === s.to
      });
      col = -1; len = 0;
    };
    for (let i = 0; i < 7; i++) {
      const k = row[i];
      if (k && k >= s.from && k <= s.to && !skip(k)) { if (col < 0) col = i; len++; }
      else flush();
    }
    flush();
  }
  // 시작이 빠른 것부터, 빈 줄 중 가장 위에 넣는다
  segs.sort((a, b) => a.col - b.col || b.len - a.len);
  const lanes = [];
  for (const s of segs) {
    let L = 0;
    while (lanes[L] && lanes[L] > s.col) L++;      // 그 줄의 마지막 끝보다 뒤면 같은 줄에 놓을 수 있다
    s.lane = L;
    lanes[L] = s.col + s.len;
  }
  return segs;
}

// 달 넘기기 — 밀려 나가고 반대쪽에서 밀려 들어온다.
// 네트워크를 기다리면 화면이 멈추므로, 캐시가 있으면 바로 그리고 없으면 빈 달을 먼저 그린 뒤
// 데이터가 오면 다시 그린다. 애니메이션이 통신 속도에 끌려가지 않게 하는 게 핵심.
const OUT_MS = 140, IN_MS = 180;
const wait = ms => new Promise(r => setTimeout(r, ms));
let sliding = false;

async function moveMonth(delta){
  if (sliding) return;
  sliding = true;
  try {
    const g = $('#grid');
    if (g) {
      // 드래그 중이었다면 지금 손가락이 있던 위치에서 이어서 밀려 나간다 (transform 을 지우지 않는다)
      g.style.transition = `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`;
      g.style.transform = `translateX(${delta > 0 ? -38 : 38}%)`;
      g.style.opacity = '0';
      await wait(OUT_MS);
    }

    cur = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
    const cached = monthCache[getMonthKey()];
    if (cached) applyCache(cached); else clearMonth();
    render();

    const n = $('#grid');
    if (n) {
      n.style.transition = 'none';
      n.style.transform = `translateX(${delta > 0 ? 38 : -38}%)`;
      n.style.opacity = '0';
      // 두 프레임 뒤에 풀어야 브라우저가 시작 상태를 확정한 뒤 전환을 시작한다
      requestAnimationFrame(() => requestAnimationFrame(() => {
        n.style.transition = `transform ${IN_MS}ms ease-out, opacity ${IN_MS}ms ease-out`;
        n.style.transform = '';
        n.style.opacity = '';
      }));
    }
  } finally { sliding = false; }

  if (!monthCache[getMonthKey()]) await refresh();   // 아직 안 받아온 달이면 이어서 불러온다
}

async function refresh(force = false){
  if (loading) return;
  loading = true;
  try { await loadMonth(force); } finally { loading = false; }
  render();
}

// ══ 날짜 상세 ══
let openKey = null;

function openDay(key){
  openKey = key;
  const ev = events[key], g = gameCnt[key] || 0, c = counts[key] || { o: 0, x: 0 };
  $('#dsTitle').textContent = label(key);

  const bits = [];
  if (ev) bits.push(ev.round_no ? `🏅 제${ev.round_no}회 정기전` : '🏅 정기전');
  if (ev && ev.note) bits.push(esc(ev.note));
  if (g) bits.push(`🎱 ${g}판`);
  $('#dsInfo').innerHTML = bits.join(' · ') || '기록된 일정이 없습니다.';

  // 점수판이 투표 버튼이므로 지난 날짜엔 숫자만 남기고 버튼을 잠근다.
  const past = isPast(key);
  $('#dsO').disabled = past;
  $('#dsX').disabled = past;
  $('#dsPastNote').style.display = past ? '' : 'none';
  syncVoteUI();
  $('#dsCntO').textContent = c.o;
  $('#dsCntX').textContent = c.x;
  renderAgg(key);

  // 일정은 O/X 와 별개다 — 표를 뭘 눌렀든, 안 눌렀든 언제나 등록할 수 있다.
  // 시트를 열 때 한 번만 초기화한다(투표할 때마다 하면 적던 내용이 날아간다).
  const canPlan = !past && !!getAuth();
  $('#dsPlan').style.display = canPlan ? '' : 'none';
  if (canPlan) {
    $('#dsPlanName').value = '';
    planDates = [key];        // 연 날짜부터 담아 둔다 — 하루짜리면 그대로 등록하면 된다
    syncPlanPick();
  }

  const adm = $('#dsAdm');
  adm.style.display = isTeamLeader ? 'block' : 'none';
  if (isTeamLeader) {
    $('#dsRound').value = ev && ev.round_no != null ? ev.round_no : '';
    $('#dsNote').value = ev && ev.note ? ev.note : '';
    $('#dsDel').style.display = ev ? '' : 'none';
  }
  msg('');
  $('#daySheet').classList.add('on');
}

function syncVoteUI(){
  const mv = myChoice(openKey);
  const o = $('#dsO'), x = $('#dsX');
  o.classList.toggle('on', mv === 'o');
  x.classList.toggle('on', mv === 'x');
  o.setAttribute('aria-pressed', mv === 'o');
  x.setAttribute('aria-pressed', mv === 'x');

  // O 를 골랐으면 가능 시간 칸. 지난 날짜엔 닫는다. (일정 칸은 표와 무관하므로 openDay 가 맡는다)
  const past = isPast(openKey);
  const meta = myVote[openKey] || {};
  $('#dsWhen').style.display = (mv === 'o' && !past) ? '' : 'none';
  // 시간을 안 고른 사람은 '아무때나'. 기본값을 함부로 넣으면 아무 때나 되는 사람이
  // 특정 시간대만 되는 것처럼 집계되므로, 비워 두는 쪽(=아무때나)이 기본이다.
  if (mv === 'o') syncSlots(meta);
}

const shortRange = (a, b) => {
  const f = k => k.slice(5).replace('-', '/');   // '2026-08-12' → '08/12'
  return a === b ? f(a) : `${f(a)} ~ ${f(b)}`;
};

// ══ 가능한 시간 ══
// 예전엔 시(時)를 하나씩 돌려 고르는 휠이었다. 정작 모이는 시간대는 몇 갈래뿐이라
// 오전/오후/저녁 세 토막으로 줄이고, 여러 개를 함께 고를 수 있게 비트합으로 담는다.
// 오전+저녁처럼 떨어진 조합도 있어서 from~to 한 쌍으로는 표현할 수 없기 때문이다.
const SLOT_AM = 1, SLOT_PM = 2, SLOT_EV = 4, SLOT_ALL = 7;
const SLOT_NAME = { 1:'오전', 2:'오후', 4:'저녁' };
const slotText = n => [1,2,4].filter(b => n & b).map(b => SLOT_NAME[b]).join('·');
// 예전 기록(slots 없음)은 from_hour~to_hour 와 겹치는 토막으로 환산한다. 서버 vote_counts 도
// 똑같이 환산하므로 화면과 집계가 어긋나지 않는다. 시간을 안 적었던 표는 '무관' → 세 토막 전부.
function slotsOf(meta){
  if (meta.slots != null) return meta.slots;
  if (meta.from == null) return SLOT_ALL;
  return (meta.from < 12 && meta.to >  6 ? SLOT_AM : 0)
       + (meta.from < 18 && meta.to > 12 ? SLOT_PM : 0)
       + (meta.from < 24 && meta.to > 18 ? SLOT_EV : 0);
}
const vibTick = () => { try { navigator.vibrate && navigator.vibrate(6); } catch(e){} };

function syncSlots(meta){
  const n = slotsOf(meta);
  $('#dsSlots').querySelectorAll('button').forEach(b => {
    const on = !!(n & Number(b.dataset.b));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
}

const RANGE_MAX = 90;   // 한 번에 등록할 수 있는 최대 일수 (실수로 몇 년치를 채우는 걸 막는다)

function msg(t, kind){
  const el = $('#dsMsg');
  el.textContent = t;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// 투표 저장 — 같은 값을 다시 누르면 취소로 동작
async function vote(choice){
  const auth = getAuth();
  if (!auth || !currentTeam) return;
  const key = openKey;
  if (isPast(key)) return;   // 지난 날짜는 투표 대상이 아니다 (UI도 가려져 있지만 이중으로 막는다)
  const prevRow = myVote[key];
  const prev = myChoice(key);
  const next = (choice && choice !== prev) ? choice : null;

  // 가능(O)은 세 시간대 전부 켠 상태로 시작한다 — 안 되는 때만 꺼 주면 된다
  const nextRow = next ? { c: next, slots: next === 'o' ? SLOT_ALL : null, from: null, to: null } : null;

  // 낙관적 반영: 숫자를 먼저 움직여 두고, 실패하면 되돌린다
  const c = counts[key] || (counts[key] = { o: 0, x: 0, hours: [], reasons: [] });
  if (prev) c[prev] = Math.max(0, c[prev] - 1);
  if (next) c[next] = (c[next] || 0) + 1;
  if (nextRow) myVote[key] = nextRow; else delete myVote[key];
  syncVoteUI();
  $('#dsCntO').textContent = c.o;
  $('#dsCntX').textContent = c.x;
  msg('저장 중...');

  try {
    if (nextRow) {
      await upsertVotes([rowFor(key, nextRow)]);
    } else {
      await sbFetch(`/rest/v1/day_votes?team_id=eq.${currentTeam}&vote_date=eq.${key}&user_id=eq.${auth.uid}`,
        { method: 'DELETE' });
    }
    msg(next ? (next === 'o' ? '가능으로 저장했습니다.' : '불가로 저장했습니다.') : '표를 취소했습니다.', 'ok');
    updateMonthCache();
    render();
    await reloadAgg();
  } catch(e){
    // 되돌리기
    if (next) c[next] = Math.max(0, c[next] - 1);
    if (prev) c[prev] = (c[prev] || 0) + 1;
    if (prevRow) myVote[key] = prevRow; else delete myVote[key];
    syncVoteUI();
    $('#dsCntO').textContent = c.o;
    $('#dsCntX').textContent = c.x;
    updateMonthCache();
    msg('저장하지 못했습니다: ' + (e.message || '알 수 없는 오류'), 'err');
  }
}

// day_votes 한 행으로 만든다. 안 쓰는 열은 명시적으로 null 을 넣어야 예전 값이 남지 않는다.
function rowFor(key, row){
  const auth = getAuth();
  return {
    team_id: currentTeam, vote_date: key, user_id: auth.uid, choice: row.c,
    slots:     row.c === 'o' ? slotsOf(row) : null,
    from_hour: null,          // 시간은 slots 로 옮겼다 — 이 두 열은 예전 기록을 읽을 때만 쓴다
    to_hour:   null,
    reason:    null,          // 일정은 day_plans 로 옮겼다 — 이 열은 더 쓰지 않는다
    updated_at: new Date().toISOString()
  };
}

const upsertVotes = rows => sbFetch('/rest/v1/day_votes?on_conflict=team_id,vote_date,user_id', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify(rows)
});

// 가능 시간 토글 — 이미 O 를 고른 상태에서만 불린다. 여러 토막을 함께 켤 수 있다.
async function saveHours(bit){
  const key = openKey, row = myVote[key];
  if (!row || row.c !== 'o' || isPast(key)) return;
  const cur = slotsOf(row);
  const next = cur ^ bit;
  // 전부 끄면 "언제 되는지 모름"이 되어 O 를 누른 뜻이 사라진다 → 마지막 하나는 못 끄게 막는다
  if (!next) return msg('최소 한 시간대는 골라야 합니다.', 'err');
  vibTick();

  // 캐시가 myVote 를 얕게 복사해 두므로 기존 객체를 고치면 캐시까지 같이 바뀐다 → 새 객체로 교체한다
  const before = row;
  myVote[key] = { ...row, slots: next, from: null, to: null };
  syncSlots(myVote[key]);              // 통신을 기다리지 않고 버튼부터 켠다
  msg('저장 중...');
  try {
    await upsertVotes([rowFor(key, myVote[key])]);
    msg(`${slotText(next)} 가능으로 저장했습니다.`, 'ok');
    updateMonthCache();
    await reloadAgg();
  } catch(e){
    myVote[key] = before;
    updateMonthCache();
    syncSlots(before);
    msg('저장하지 못했습니다: ' + (e.message || '알 수 없는 오류'), 'err');
  }
}

// ══ 일정 등록 ══
// 날짜는 시작~끝이 아니라 하나씩 골라 담는다. 시험기간처럼 쭉 이어지는 일정도,
// 매주 토요일처럼 떨어진 일정도 한 번에 등록되기 때문이다.
// 저장할 때 붙어 있는 날들을 한 덩어리(구간)로 묶어 day_plans 에 한 행씩 넣는다 —
// 서버가 행 하나를 막대 하나로 돌려주므로, 이어진 날짜는 저절로 이어진 막대가 된다.
let planDates = [];       // 지금 고른 날들 ('YYYY-MM-DD' 오름차순)

// 붙어 있는 날짜끼리 묶는다 → [{ from, to }]
function runsOf(dates){
  const out = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && shiftDay(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

// 고른 날짜를 한 줄로 요약. 구간이 많으면 앞의 둘만 적고 나머지는 건수로 줄인다.
function planPickLabel(){
  if (!planDates.length) return '📅 날짜 고르기';
  const runs = runsOf(planDates);
  const head = runs.slice(0, 2).map(r => shortRange(r.from, r.to)).join(', ');
  const rest = runs.length > 2 ? ` 외 ${runs.length - 2}건` : '';
  return `📅 ${head}${rest} · ${planDates.length}일`;
}

function syncPlanPick(){
  const el = $('#dsPlanPick');
  if (!el) return;
  el.textContent = planPickLabel();
  el.classList.toggle('has', planDates.length > 0);
}

function openPlanPicker(){
  openDayPicker({
    min: todayStr(),          // 앞으로의 예정이라 지난 날짜는 못 고른다
    selected: planDates,
    limit: RANGE_MAX,
    onCommit: dates => { planDates = dates; syncPlanPick(); }
  });
}

async function savePlan(){
  const key = openKey;
  const auth = getAuth();
  if (!auth || !currentTeam || isPast(key)) return;
  const name = $('#dsPlanName').value.trim();
  const dates = planDates.filter(d => !isPast(d));   // 고른 뒤 자정을 넘겼을 수도 있다
  if (!name) return msg('일정 이름을 적어 주세요.', 'err');
  if (!dates.length) return msg('날짜를 골라 주세요.', 'err');
  if (dates.length > RANGE_MAX)
    return msg(`한 번에 ${RANGE_MAX}일까지만 등록할 수 있습니다.`, 'err');

  const runs = runsOf(dates);
  msg('저장 중...');
  try {
    await sbFetch('/rest/v1/day_plans', {
      method: 'POST',
      body: JSON.stringify(runs.map(r => ({
        team_id: currentTeam, user_id: auth.uid, name, start_date: r.from, end_date: r.to
      })))
    });
    // 여러 날이 한꺼번에 바뀌므로 낙관적 반영 없이 서버 값을 다시 읽는다
    await refresh(true);
    openDay(key);
    msg(`'${name}' 일정을 ${dates.length}일 등록했습니다.`, 'ok');
  } catch(e){
    msg('저장하지 못했습니다: ' + errText(e), 'err');
  }
}

async function delPlan(id){
  const p = myPlans.find(x => x.id === id);
  // 하루만 열어 놓고 지워도 기간 전체가 사라진다 → 기간을 확인 문구에 같이 보여 준다
  if (!p || !confirm(`'${p.name}' 일정을 지울까요?\n(${shortRange(p.start_date, p.end_date)} 전체가 사라집니다)`)) return;
  msg('삭제 중...');
  try {
    await sbFetch(`/rest/v1/day_plans?id=eq.${id}`, { method: 'DELETE' });
    const key = openKey;
    await refresh(true);
    openDay(key);
    msg('일정을 지웠습니다.', 'ok');
  } catch(e){
    msg('지우지 못했습니다: ' + errText(e), 'err');
  }
}

// 표를 바꾼 뒤 집계(시간대·사유)를 다시 읽어 시트에 반영한다
async function reloadAgg(){
  await refresh(true);
  if ($('#daySheet').classList.contains('on')) renderAgg(openKey);
}

// 익명 집계 — 시간대별 가능 인원 막대 + 불가 사유별 인원. 이름은 서버에서부터 나오지 않는다.
function renderAgg(key){
  const c = counts[key] || {};
  const hours = c.hours || [], reasons = c.reasons || [];
  let html = '';

  if (hours.length) {
    // 서버가 [토막, 인원] 으로 준다 (0=오전 1=오후 2=저녁). 셋을 항상 다 그린다 —
    // 0명인 토막을 빼면 "아무도 없는 시간"이 안 보여서 정작 알고 싶은 게 안 보인다.
    const at = Object.fromEntries(hours);
    const max = Math.max(...hours.map(h => h[1]));
    const cols = ['오전','오후','저녁'].map((lb, i) => {
      const n = at[i] || 0;
      return `<div class="hcol${n && n === max ? ' best' : ''}">
        <span class="hn">${n || ''}</span>
        <span class="hb"><i style="height:${max ? (n / max) * 100 : 0}%"></i></span>
        <span class="hh">${lb}</span>
      </div>`;
    }).join('');
    html += `<div class="agg"><div class="agghd">🕐 시간대별 가능 인원</div>`
      + `<div class="hchart">${cols}</div>`
      + `</div>`;
  }
  if (reasons.length) {
    // 서버가 주는 목록은 이름만 있고 누구 것인지는 없다(익명). 그래서 내 일정과 이름을 맞춰
    // 내가 등록한 줄에만 삭제 버튼을 붙인다. 인원수는 쓸모가 없어 빼고 그 자리를 버튼에 준다.
    const mine = plansOn(key);
    html += `<div class="agg"><div class="agghd">📌 등록된 일정</div>`
      + reasons.map(([t]) => {
          const p = mine.find(x => String(x.name).trim() === t);
          const right = p
            ? `<button class="del" data-id="${esc(p.id)}" title="내 일정 삭제" aria-label="'${esc(t)}' 일정 삭제">&times;</button>`
            : `<span class="pad"></span>`;
          return `<div class="rsn"><span class="t">${esc(t)}</span>${right}</div>`;
        }).join('')
      + `</div>`;
  }
  $('#dsAgg').innerHTML = html;
  $('#dsAgg').querySelectorAll('.rsn .del').forEach(b => {
    b.onclick = () => delPlan(b.dataset.id);
  });
}

// 정기전 등록/수정 (팀장 — 사이트 전체 관리자와는 다른 권한이다)
async function saveEvent(){
  if (!isTeamLeader || !currentTeam) return;
  const key = openKey;
  const raw = $('#dsRound').value.trim();
  const round = raw === '' ? null : parseInt(raw, 10);
  if (raw !== '' && (!Number.isFinite(round) || round < 1)) return msg('회차는 1 이상의 숫자로 입력해 주세요.', 'err');
  const note = $('#dsNote').value.trim() || null;
  msg('저장 중...');
  try {
    const rows = await sbFetch('/rest/v1/club_events?on_conflict=team_id,event_date', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ team_id: currentTeam, event_date: key, round_no: round, note })
    });
    if (!rows || !rows.length) throw new Error('권한이 없습니다. 팀장만 등록할 수 있습니다.');
    events[key] = rows[0];
    updateMonthCache();
    render();
    openDay(key);              // 시트 내용 갱신 — msg 를 지우므로 안내는 그 뒤에 띄운다
    msg('정기전을 저장했습니다.', 'ok');
  } catch(e){ msg('저장 실패: ' + (e.message || '알 수 없는 오류'), 'err'); }
}

async function delEvent(){
  if (!isTeamLeader || !currentTeam) return;
  const key = openKey;
  if (!events[key]) return;
  if (!confirm(`${label(key)} 정기전 기록을 지울까요?`)) return;
  msg('삭제 중...');
  try {
    await sbFetch(`/rest/v1/club_events?team_id=eq.${currentTeam}&event_date=eq.${key}`, { method: 'DELETE' });
    delete events[key];
    updateMonthCache();
    render();
    openDay(key);
    msg('삭제했습니다.', 'ok');
  } catch(e){ msg('삭제 실패: ' + (e.message || '알 수 없는 오류'), 'err'); }
}

// ══ 정기전 자동 편성 (팀장) ══
// 날짜를 하나씩 열어 회차를 적는 대신, '주 몇 회 · 무슨 요일'만 정하면 그 규칙에 맞는 날을
// 전부 뽑아 회차를 차례로 매겨 넣는다. 시작 회차는 시작 날짜 이전의 마지막 회차에서 이어 붙인다.
const LS_REG = 'dangRegPlan';
const REG_MAX = 400;                     // 한 번에 만들 수 있는 최대 회차 수 (실수로 몇 년치를 채우는 걸 막는다)

let regFreq = 1;          // 주 횟수 — 고를 수 있는 요일 개수를 이 값이 정한다
let regDows = [];         // 고른 요일 (0=일 … 6=토) — 고른 순서대로 담아 두고, 넘치면 가장 먼저 고른 걸 뺀다
let regMonths = 3;        // 적용 기간(개월)
let regTouchedStart = false;   // 시작 회차를 손으로 고쳤으면 자동 채우기를 멈춘다

const regCfgKey = () => LS_REG + ':' + (currentTeam || 'none');
function regSaveCfg(){
  try { localStorage.setItem(regCfgKey(), JSON.stringify({ freq: regFreq, dows: regDows, months: regMonths })); } catch(e){}
}
function regLoadCfg(){
  try { return JSON.parse(localStorage.getItem(regCfgKey())); } catch(e){ return null; }
}

// key 에서 n 개월 뒤. 31일에 한 달을 더하면 다음 달을 넘어가므로 그 달의 마지막 날로 눌러 준다.
function addMonths(key, n){
  const [y, m, d] = key.split('-').map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate();
  return ymd(new Date(y, m - 1 + n, Math.min(d, last)));
}

// 지금 설정으로 잡히는 정기전 날짜들 (오름차순)
function regDates(){
  const from = $('#regFrom').value;
  if (!from || !regDows.length) return [];
  const end = addMonths(from, regMonths);
  const [y, m, d] = from.split('-').map(Number);
  const out = [];
  for (const dt = new Date(y, m - 1, d); ymd(dt) <= end && out.length < REG_MAX; dt.setDate(dt.getDate() + 1))
    if (regDows.includes(dt.getDay())) out.push(ymd(dt));
  return out;
}

function regMsg(t, kind){
  const el = $('#regMsg');
  el.textContent = t || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// 시작 날짜 이전의 마지막 회차 + 1 — 앞선 정기전에서 번호가 끊기지 않게 이어 붙인다.
async function regFillStart(){
  if (regTouchedStart || !currentTeam) return;
  const from = $('#regFrom').value;
  if (!from) return;
  let last = 0;
  try {
    const rows = await sbFetch(`/rest/v1/club_events?select=round_no&team_id=eq.${currentTeam}`
      + `&event_date=lt.${from}&round_no=not.is.null&order=round_no.desc&limit=1`);
    if (Array.isArray(rows) && rows[0] && rows[0].round_no) last = rows[0].round_no;
  } catch(e){ /* 못 읽으면 1회부터 — 팀장이 직접 고치면 된다 */ }
  if (regTouchedStart) return;           // 기다리는 사이에 손으로 고쳤을 수도 있다
  $('#regStart').value = last + 1;
  regSyncPrev();
}

// 요일 개수가 주 횟수와 맞아야 등록할 수 있다. 미리보기로 몇 회가 언제 잡히는지 먼저 보여 준다.
function regSyncPrev(){
  const need = regFreq, got = regDows.length;
  const cnt = $('#regDowCnt');
  cnt.textContent = `${got}/${need} 선택`;
  cnt.className = 'cnt' + (got === need ? '' : ' bad');

  const prev = $('#regPrev');
  if (got !== need) {
    prev.innerHTML = `요일을 <b>${need}개</b> 골라 주세요.`;
    return;
  }
  const dates = regDates();
  if (!dates.length) { prev.innerHTML = '잡히는 날짜가 없습니다.'; return; }
  const s = parseInt($('#regStart').value, 10);
  const start = Number.isFinite(s) && s >= 1 ? s : 1;
  const endNo = start + dates.length - 1;
  prev.innerHTML = `총 <b>${dates.length}회</b>`
    + `<br><span class="rd">${label(dates[0])} 제${start}회</span>`
    + ` ~ <span class="rd">${label(dates[dates.length - 1])} 제${endNo}회</span>`;
}

function regSyncDows(){
  $('#regDow').querySelectorAll('button').forEach(b => {
    const on = regDows.includes(Number(b.dataset.w));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  regSyncPrev();
}

function regSyncSegs(){
  $('#regFreq').querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === regFreq));
  $('#regSpan').querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.m) === regMonths));
}

function openRegModal(){
  if (!isTeamLeader || !currentTeam) return;
  const cfg = regLoadCfg();
  regFreq   = cfg && cfg.freq   ? cfg.freq   : 1;
  regDows   = cfg && Array.isArray(cfg.dows) ? cfg.dows.slice(0, regFreq) : [];
  regMonths = cfg && cfg.months ? cfg.months : 3;
  regTouchedStart = false;
  $('#regFrom').value = todayStr();
  $('#regStart').value = '';
  regMsg('');
  regSyncSegs();
  regSyncDows();
  $('#regModal').classList.add('on');
  regFillStart();
}

async function regApply(){
  if (!isTeamLeader || !currentTeam) return regMsg('팀장만 정기전을 등록할 수 있습니다.', 'err');
  if (regDows.length !== regFreq) return regMsg(`요일을 ${regFreq}개 골라 주세요.`, 'err');
  const from = $('#regFrom').value;
  if (!from) return regMsg('시작 날짜를 골라 주세요.', 'err');
  const raw = $('#regStart').value.trim();
  const start = parseInt(raw, 10);
  if (!Number.isFinite(start) || start < 1) return regMsg('시작 회차는 1 이상의 숫자로 입력해 주세요.', 'err');

  const dates = regDates();
  if (!dates.length) return regMsg('잡히는 날짜가 없습니다.', 'err');
  const to = addMonths(from, regMonths);
  const endNo = start + dates.length - 1;
  if (!confirm(`${label(dates[0])}부터 ${label(dates[dates.length - 1])}까지\n`
    + `총 ${dates.length}회 (제${start}회 ~ 제${endNo}회) 정기전을 등록합니다.\n\n`
    + `이 기간에 이미 등록된 정기전은 새 일정으로 대체됩니다.\n계속할까요?`)) return;

  regMsg('저장 중...');
  try {
    // 요일을 바꿨을 때 예전 요일의 정기전이 남지 않도록, 기간을 통째로 비우고 새로 넣는다
    await sbFetch(`/rest/v1/club_events?team_id=eq.${currentTeam}`
      + `&event_date=gte.${from}&event_date=lte.${to}`, { method: 'DELETE' });
    const rows = dates.map((d, i) => ({ team_id: currentTeam, event_date: d, round_no: start + i, note: null }));
    // 한 번에 다 보내면 URL·본문이 커진다 → 100행씩 끊어 넣는다
    for (let i = 0; i < rows.length; i += 100) {
      const part = await sbFetch('/rest/v1/club_events?on_conflict=team_id,event_date', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows.slice(i, i + 100))
      });
      if (!part || !part.length) throw new Error('권한이 없습니다. 팀장만 등록할 수 있습니다.');
    }
    regSaveCfg();
    monthCache = {};                       // 여러 달이 한꺼번에 바뀌었다 — 캐시를 전부 버린다
    await refresh(true);
    regMsg(`${dates.length}회 정기전을 등록했습니다. (제${start}회 ~ 제${endNo}회)`, 'ok');
  } catch(e){
    regMsg('저장 실패: ' + errText(e), 'err');
  }
}

(function initRegModal(){
  const modal = $('#regModal'); if (!modal) return;
  const close = () => modal.classList.remove('on');
  $('#regClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };

  $('#regFreq').querySelectorAll('button').forEach(b => b.onclick = () => {
    regFreq = Number(b.dataset.n);
    // 주 횟수를 줄이면 나중에 고른 요일부터 떨어져 나간다 (먼저 고른 쪽을 남긴다)
    if (regDows.length > regFreq) regDows = regDows.slice(0, regFreq);
    regSyncSegs(); regSyncDows(); regMsg('');
  });

  $('#regSpan').querySelectorAll('button').forEach(b => b.onclick = () => {
    regMonths = Number(b.dataset.m);
    regSyncSegs(); regSyncPrev(); regMsg('');
  });

  $('#regDow').querySelectorAll('button').forEach(b => b.onclick = () => {
    const w = Number(b.dataset.w);
    if (regDows.includes(w)) regDows = regDows.filter(x => x !== w);
    else {
      regDows.push(w);
      // 주 횟수만큼만 남긴다 — 가장 먼저 고른 요일이 밀려난다 (다시 고르는 수고를 던다)
      if (regDows.length > regFreq) regDows.shift();
    }
    regSyncDows(); regMsg('');
  });

  $('#regFrom').onchange = () => { regSyncPrev(); regFillStart(); regMsg(''); };
  $('#regStart').oninput = () => { regTouchedStart = true; regSyncPrev(); };
  $('#regApply').onclick = regApply;
})();

// ══ 소속 팀 스위처 ══
function renderTeamBar(){
  const bar = $('#teamBar'), sel = $('#teamSel');
  if (!bar || !sel) return;
  if (!getAuth()) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (!myTeams.length) {
    sel.innerHTML = '<option value="">소속 팀 없음</option>';
    sel.disabled = true;
  } else {
    sel.innerHTML = myTeams.map(t =>
      `<option value="${esc(t.id)}"${t.id === currentTeam ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    sel.disabled = myTeams.length < 2;
  }
  sel.onchange = async () => {
    if (!sel.value) return;
    currentTeam = sel.value; tSet(currentTeam);
    const me = myTeams.find(t => t.id === currentTeam);
    isTeamLeader = !!(me && me.is_admin);
    await refresh();
  };
}

// ══ 설정 모달 ══
const { open: openTeamModal } = initTeamModal({
  getAuth,
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; tSet(currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: async () => { renderTeamBar(); await refresh(); }
});

// 점수 음성은 세 화면이 같은 값을 쓴다 (점수판에서만 실제로 소리가 나지만 설정은 어디서든 바꿀 수 있게)
const LS_VOICE = 'dangScoreVoice';
const getVoice = () => { try { const v = localStorage.getItem(LS_VOICE); return v == null ? true : JSON.parse(v); } catch(e){ return true; } };
const setVoice = b => { try { localStorage.setItem(LS_VOICE, JSON.stringify(b)); } catch(e){} };

(function initSettings(){
  const modal = $('#setModal'); if (!modal) return;
  const vbtn = $('#setVoice');
  const themeBtns = modal.querySelectorAll('#setTheme button');
  const sync = () => {
    vbtn.classList.toggle('on', getVoice());
    const cur = getTheme();
    themeBtns.forEach(b => b.classList.toggle('on', b.dataset.t === cur));
  };
  const open = () => { sync(); modal.classList.add('on'); };
  const close = () => modal.classList.remove('on');
  $('#btnSettings').onclick = open;
  $('#setClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  // 로그인 전에는 팀을 고를 수 없다 → 로그인이 있는 내 정보 화면으로 (기록실과 같은 처리)
  $('#setTeam').onclick = () => { close(); if (getAuth()) openTeamModal(); else location.href = '../record/?tab=me'; };
  $('#setMe').onclick = () => { location.href = '../record/?tab=me'; };   // 내 정보 화면은 기록실에만 있다
  vbtn.onclick = () => { const nv = !getVoice(); setVoice(nv); vbtn.classList.toggle('on', nv); };
  themeBtns.forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    // '시스템'은 값을 지워서 표현한다 — 문자열로 저장하면 다른 화면이 못 알아본다
    try { if (t === 'system') localStorage.removeItem(LS_THEME); else localStorage.setItem(LS_THEME, t); } catch(e){}
    applyTheme(t); sync();
  });
})();

$('#dsClose').onclick = () => $('#daySheet').classList.remove('on');
$('#daySheet').onclick = e => { if (e.target.id === 'daySheet') $('#daySheet').classList.remove('on'); };
$('#dsO').onclick = () => vote('o');
$('#dsX').onclick = () => vote('x');
$('#dsPlanSave').onclick = savePlan;
$('#dsPlanPick').onclick = openPlanPicker;
$('#dsPlanPick').onkeydown = e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlanPicker(); }
};
$('#dsSave').onclick = saveEvent;
$('#dsDel').onclick = delEvent;

$('#btnLogout').onclick = () => {
  if (!confirm('로그아웃할까요?')) return;
  try { localStorage.removeItem(LS_AUTH); localStorage.removeItem(LS_TEAM); } catch(e){}
  location.href = '../score/';
};

// 다른 부원이 투표한 건 서버에만 쌓이므로, 화면으로 돌아올 때 다시 읽어 온다.
// (앱을 켜 둔 채로도 최신 인원수를 보게 된다. 폴링은 하지 않는다)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTeam) refresh(true);
});

// ══ 시작 ══
applyTheme(getTheme());
registerSW();
$('#dsSlots').querySelectorAll('button').forEach(b => { b.onclick = () => saveHours(Number(b.dataset.b)); });
(async () => {
  $('#view').innerHTML = '<div class="card"><div class="empty">불러오는 중...</div></div>';
  if (getAuth()) $('#btnLogout').style.display = '';
  await loadTeams();
  renderTeamBar();
  await refresh();
})();
