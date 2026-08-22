// 당동 캘린더 — 정기전 일정 · 경기 판수 · 모임 투표
//
// 모임 투표: "8/25 5시 메카당구장" 처럼 모임 하나를 띄우고 참/불참을 받는다.
//   · 만들면 알림을 켜 둔 팀원에게 푸시가 간다 (Supabase Edge Function notify-meetup).
//   · 안드로이드는 알림에 붙은 [참석]/[불참] 버튼으로 바로 답한다. iOS 는 알림 버튼을
//     지원하지 않아서, 누르면 캘린더가 그 모임을 연 채 뜨고 거기서 고른다.
//   · 참석자는 이름까지 보이고 불참은 인원수만 나간다 — 서버 함수(meetups_in)가 정하는 범위다.
// 자세한 정책은 저장소 루트의 sql/calendar/ 참고 (1,2,4,5 를 순서대로 실행).
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
let events = {};    // 날짜 → { id, note } — 회차는 담지 않는다 (eventSeq 가 순서로 계산한다)
let gameCnt = {};   // 날짜 → 경기 판수
let meetups = {};   // 날짜 → [모임...]  각 모임은 meetups_in 이 준 그대로
                    // { id, meet_time, place, note, created_by, creator_name,
                    //   yes_names[], yes_cnt, no_cnt, my_status:'yes'|'no'|null }
let planSpans = []; // 이 달에 걸린 일정 막대 [{ name, from, to, cnt }] — 이름·기간·인원수만 (익명)
let myPlans = [];   // 내가 등록한 일정 [{ id, name, start_date, end_date }] — 지우려면 이게 필요하다

// 회차는 저장하지 않는다 — '몇 번째 모임인가'가 곧 회차라서, 팀의 정기전을 날짜순으로 세면 그게 답이다.
// 덕분에 하나를 지우거나 끼워 넣어도 뒤 회차가 저절로 맞는다 (다시 써 넣을 행이 없다).
// 달마다가 아니라 팀 전체를 한 번에 받아 둔다 — 날짜만 받으므로 몇 년치라도 가볍다.
let eventSeq = null;   // 'YYYY-MM-DD' → 회차(1부터)
let seqTeam = null;    // 그 표가 어느 팀 것인지
let loading = false;
let loadErr = '';   // 이번 달 데이터를 못 불러온 이유 (화면에 그대로 띄운다)

// ── 날짜 유틸 (로컬 시간 기준. toISOString 은 UTC 라 하루 밀릴 수 있어 쓰지 않는다) ──
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const todayStr = () => ymd(new Date());
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
// 지난 날짜엔 모임을 만들 수 없다 (이미 지나간 날의 약속을 잡을 이유가 없다).
// 키가 'YYYY-MM-DD' 라 문자열 비교로 충분하다.
const isPast = key => key < todayStr();
// 그 날 내가 등록해 둔 일정들
const plansOn = key => myPlans.filter(p => p.start_date <= key && key <= p.end_date);
// 그 날의 모임들 (없으면 빈 배열)
const meetsOn = key => meetups[key] || [];
// '17:30:00' → '오후 5시 30분'. 시간이 없으면 null (시간 미정)
function timeText(t){
  if (!t) return null;
  const [h, mi] = t.split(':').map(Number);
  const ap = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ap} ${h12}시${mi ? ' ' + mi + '분' : ''}`;
}
// 달력 칸처럼 좁은 자리용 — '17:30' / '17시'
const timeShort = t => t ? (Number(t.slice(3, 5)) ? t.slice(0, 5) : Number(t.slice(0, 2)) + '시') : '';
const label = key => {
  const [y, m, dd] = key.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  return `${m}월 ${dd}일 (${DOW[d.getDay()]})`;
};

// 팀의 정기전을 날짜순으로 세어 회차 표를 만든다
async function ensureSeq(force = false){
  if (!currentTeam) { eventSeq = null; seqTeam = null; return; }
  if (!force && eventSeq && seqTeam === currentTeam) return;
  try {
    const rows = await sbFetch(`/rest/v1/club_events?select=event_date&team_id=eq.${currentTeam}`
      + `&order=event_date.asc`);
    const m = new Map();
    if (Array.isArray(rows)) rows.forEach((r, i) => m.set(r.event_date, i + 1));
    eventSeq = m; seqTeam = currentTeam;
  } catch(e){ if (!eventSeq) eventSeq = new Map(); }   // 못 읽으면 회차만 안 보인다
}
const roundOf = key => (eventSeq && eventSeq.get(key)) || null;
// 이 날짜 앞에 있는 정기전 수 — 일괄 등록 미리보기에서 '몇 회부터 시작인지' 계산에 쓴다
const countBefore = key => eventSeq ? [...eventSeq.keys()].filter(k => k < key).length : 0;

// 정기전을 더하거나 지운 뒤 — 회차가 여러 달에 걸쳐 밀리므로 전부 다시 읽는다
async function afterEventChange(){
  monthCache = {}; eventSeq = null;
  await refresh(true);
}

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
    meetups: { ...meetups },
    planSpans: [...planSpans],
    myPlans: [...myPlans],
    loadErr
  };
}

function clearMonth(){
  events = {}; gameCnt = {}; meetups = {};
  planSpans = []; myPlans = []; loadErr = '';
}
function applyCache(c){
  events = { ...c.events };
  gameCnt = { ...c.gameCnt };
  meetups = { ...(c.meetups || {}) };
  planSpans = [...(c.planSpans || [])];
  myPlans = [...(c.myPlans || [])];
  loadErr = c.loadErr;
}

async function loadMonth(force = false){
  if (!currentTeam) { clearMonth(); eventSeq = null; seqTeam = null; return; }
  const cacheKey = getMonthKey();
  if (!force && monthCache[cacheKey]) { applyCache(monthCache[cacheKey]); await ensureSeq(); return; }

  clearMonth();
  const [d1, d2] = monthRange();
  const auth = getAuth();
  const seqP = ensureSeq(true);          // 회차 표는 달과 무관하므로 나머지와 나란히 받아 온다

  // 다음 달 1일 00:00 (경기 조회 상한 — played_at 은 timestamptz 라 날짜 비교가 아니라 범위로 자른다)
  const nextMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);

  const [ev, games, mts, spans, plans] = await Promise.allSettled([
    sbFetch(`/rest/v1/club_events?select=id,event_date,note&team_id=eq.${currentTeam}`
          + `&event_date=gte.${d1}&event_date=lte.${d2}`),
    sbFetch(`/rest/v1/games?select=played_at&team_id=eq.${currentTeam}`
          + `&played_at=gte.${d1}T00:00:00&played_at=lt.${ymd(nextMonth)}T00:00:00`),
    sbFetch('/rest/v1/rpc/meetups_in', { method: 'POST', body: JSON.stringify({ t: currentTeam, d1, d2 }) }),
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

  // 모임과 참석 현황. 남의 표는 RLS 로 막혀 있어 이 함수 말고는 알 방법이 없다 —
  // 여기서 실패하면 '모임이 하나도 없는 것처럼' 보이므로 조용히 넘기지 않고 드러낸다.
  if (mts.status === 'fulfilled' && Array.isArray(mts.value)) {
    for (const m of mts.value) (meetups[m.meet_date] || (meetups[m.meet_date] = [])).push(m);
  } else {
    loadErr = describeMeetupErr(mts.reason);
  }

  // 일정 기능은 나중에 붙었다. sql/calendar/4-plan-spans.sql 을 아직 안 돌린 서버라면 여기서 404 가 난다.
  // 막대가 안 보일 뿐 달력은 그대로 쓸 수 있으므로 조용히 비워 두고 넘어간다.
  planSpans = (spans.status === 'fulfilled' && Array.isArray(spans.value))
    ? spans.value.map(r => ({ name: r.name, from: r.start_date, to: r.end_date, cnt: r.cnt }))
    : [];
  myPlans = (plans.status === 'fulfilled' && Array.isArray(plans.value)) ? plans.value : [];

  await seqP;
  updateMonthCache();
}

const errText = e => (e && (e.message || e.msg)) || '알 수 없는 오류';

// 모임을 못 읽는 원인은 갈린다. 사람이 바로 조치할 수 있게 구분해서 알려준다.
function describeMeetupErr(e){
  const st = e && e.status;
  if (st === 404 || st === 400) {
    return '모임 조회 함수(meetups_in)를 찾지 못했습니다. sql/calendar/5-meetups.sql 을 Supabase 에서 '
         + '실행했는지, 실행했다면 스키마 캐시가 갱신됐는지 확인해 주세요. (' + errText(e) + ')';
  }
  if (st === 401 || st === 403) {
    return '모임을 볼 권한이 없습니다. 이 팀의 팀원인지 확인해 주세요. (' + errText(e) + ')';
  }
  return '모임을 불러오지 못했습니다: ' + errText(e);
}

// ══ 화면 ══
// 칸 둘째 줄 — 정기전 회차. 일정 막대가 앉는 자리와 같지만, 막대는 정기전 칸을 비켜 가므로
// (barsForWeek 의 skip) 둘이 한 칸에서 겹치는 일은 없다.
function cellR2Html(key){
  if (!events[key]) return '';
  const n = roundOf(key);
  // 회차가 세 자리면 좁은 폰(320px)에서 '제12…' 로 잘려 엉뚱한 회차로 읽힌다 → 그때만 한 호 줄인다
  const sm = String(n || '').length >= 3 ? ' sm' : '';
  return `<span class="evchip${sm}">${n ? '제' + n + '회' : '정기전'}</span>`;
}

// 칸 셋째 줄 — 지난 날은 '몇 판 쳤나', 오늘·앞으로는 '모임 몇 시에 몇 명'.
// 그 시점에 쓸모 있는 쪽만 남긴다. 회차는 둘째 줄이 맡으므로 여기서 자리를 다투지 않는다.
function cellR3Html(key){
  const g = gameCnt[key];
  // 오늘 친 판수를 바로 띄우면 아직 유효한 모임 정보와 자리를 다툰다 → 판수는 날짜가 지난 뒤부터.
  if (isPast(key)) return g ? `<span class="gchip">${g}판</span>` : '';
  const ms = meetsOn(key);
  if (!ms.length) return '';
  // 모임이 둘 이상이면 시각 대신 개수를 보여 준다 — 좁은 칸에 둘 다 넣으면 아무것도 안 읽힌다
  const head = ms.length > 1 ? `모임 ${ms.length}` : (timeShort(ms[0].meet_time) || '모임');
  const yes = ms.reduce((n, m) => n + (m.yes_cnt || 0), 0);
  return `<span class="mtchip">${esc(head)}${yes ? ' ' + yes + '명' : ''}</span>`;
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
      const ev = events[key], ms = meetsOn(key);
      // 지난 날의 모임은 이미 끝난 일이다 → 표시 테두리를 지우고
      // 그날 실제로 있었던 일(정기전·판수)만 남긴다. 셋째 줄도 cellR3Html 이 같은 기준으로 가른다.
      const past = key < today;
      const cls = ['cell'];
      if (ev) cls.push('event');
      if (key === today) cls.push('today');
      // 모임이 잡힌 날은 테두리로 알린다. 내가 답했으면 그 색(초록=참석, 빨강=불참)으로 바뀐다.
      if (ms.length && !past) {
        cls.push('meet');
        // 여러 모임 중 하나라도 참석이면 참석 쪽을 보여 준다 — 그날 나가는 게 결론이므로
        if (ms.some(x => x.my_status === 'yes')) cls.push('yes');
        else if (ms.every(x => x.my_status === 'no')) cls.push('no');
      }
      if (past) cls.push('past');          // 지난 날 — 눌러서 정기전·판수는 볼 수 있다
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
      <div style="font-weight:700; color:var(--no); margin-bottom:6px;">⚠️ 모임 현황을 불러오지 못했습니다</div>
      <div class="sub" style="color:var(--text)">${esc(loadErr)}</div>
      <div class="sub" style="margin-top:8px">이 상태에서는 잡힌 모임이 보이지 않습니다.</div>
    </div>` : ''}
    <div class="monthbar">
      <button class="mbtn" id="prevM" aria-label="이전 달">‹</button>
      <b>${y}년 ${m + 1}월</b>
      <button class="mbtn" id="nextM" aria-label="다음 달">›</button>
    </div>
    ${barHtml()}
    <div class="dow">${DOW.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="gridclip"><div class="grid" id="grid">${weeks}</div></div>
    <div class="sub" style="text-align:center; margin:14px 0 20px;">
      날짜를 눌러 모임을 만들거나 참석 여부를 고르세요.
    </div>
    ${upNextHtml()}
  `;

  $('#prevM').onclick = () => moveMonth(-1);
  $('#nextM').onclick = () => moveMonth(1);
  bindBar();
  document.querySelectorAll('#grid .cell[data-d]').forEach(el => {
    el.onclick = () => { if (!swallowClick()) openDay(el.dataset.d); };
  });
  document.querySelectorAll('.upnext[data-d]').forEach(el => {
    el.onclick = () => openDay(el.dataset.d);
  });
  bindSwipe($('#grid'));
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

// ══ 달력 위 버튼 줄 ══
function barHtml(){
  return `<div class="bulkbar">
      ${isTeamLeader ? '<button type="button" class="bulkbtn" id="regOn">정기전 설정</button>' : ''}
      <button type="button" class="bulkbtn go" id="mtNew">＋ 모임 만들기</button>
    </div>`;
}

function bindBar(){
  const reg = $('#regOn');
  if (reg) reg.onclick = openRegModal;
  const nw = $('#mtNew');
  // 모임을 만들려면 날짜가 있어야 한다 → 오늘 날짜의 상세를 열고 만들기 상자로 데려간다
  if (nw) nw.onclick = () => openDay(todayStr(), { focusNew: true });
}

// 다가오는 모임 — 오늘 이후로 잡힌 것들. 달력을 훑지 않아도 다음 약속이 바로 보이게.
function upNextHtml(){
  const rows = Object.keys(meetups)
    .filter(k => !isPast(k))
    .sort()
    .flatMap(k => meetsOn(k).map(m => ({ k, m })))
    .slice(0, 5);
  if (!rows.length) return '';
  return `<div class="card">
    <div style="font-weight:700; margin-bottom:6px;">🎱 다가오는 모임</div>
    ${rows.map(({ k, m }) => {
      const when = timeText(m.meet_time);
      const mine = m.my_status === 'yes' ? ' ✅' : m.my_status === 'no' ? ' ❌' : '';
      return `<button type="button" class="upnext" data-d="${k}">
        <span class="d">${label(k)}${when ? ' ' + esc(when) : ''}</span>
        <span class="p">${esc(m.place || '')}</span>
        <span class="n${m.yes_cnt ? '' : ' none'}">${m.yes_cnt || 0}명${mine}</span>
      </button>`;
    }).join('')}
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

function openDay(key, opts = {}){
  openKey = key;
  const ev = events[key], g = gameCnt[key] || 0;
  $('#dsTitle').textContent = label(key);

  const bits = [];
  if (ev) { const n = roundOf(key); bits.push(n ? `🏅 제${n}회 정기전` : '🏅 정기전'); }
  if (ev && ev.note) bits.push(esc(ev.note));
  if (g) bits.push(`🎱 ${g}판`);
  $('#dsInfo').innerHTML = bits.join(' · ') || '기록된 일정이 없습니다.';

  renderMeetups(key);
  renderAgg(key);

  const past = isPast(key);
  const auth = getAuth();

  // 모임 만들기 — 팀원 누구나. 지난 날짜에는 잡을 게 없으므로 닫는다.
  // 시트를 열 때 한 번만 비운다(참석을 누를 때마다 비우면 적던 내용이 날아간다).
  const canMeet = !past && !!auth && !!currentTeam;
  $('#dsMt').style.display = canMeet ? '' : 'none';
  if (canMeet) {
    $('#dsMtTime').value = ''; $('#dsMtPlace').value = ''; $('#dsMtNote').value = '';
  }

  // 일정은 모임과 별개다 — 모임에 뭘 답했든 언제나 등록할 수 있다.
  const canPlan = !past && !!auth;
  $('#dsPlan').style.display = canPlan ? '' : 'none';
  if (canPlan) {
    $('#dsPlanName').value = '';
    planDates = [key];        // 연 날짜부터 담아 둔다 — 하루짜리면 그대로 등록하면 된다
    syncPlanPick();
  }

  const adm = $('#dsAdm');
  adm.style.display = isTeamLeader ? 'block' : 'none';
  if (isTeamLeader) {
    $('#dsNote').value = ev && ev.note ? ev.note : '';
    $('#dsSave').textContent = ev ? '저장' : '지정';
    $('#dsDel').style.display = ev ? '' : 'none';
  }
  msg('');
  $('#daySheet').classList.add('on');
  // '＋ 모임 만들기' 로 들어왔으면 입력 칸까지 데려간다 — 시트를 연 이유가 그거니까
  if (opts.focusNew && canMeet) {
    $('#dsMt').scrollIntoView({ block: 'nearest' });
    $('#dsMtPlace').focus();
  }
}

// ══ 모임 카드 ══
// 참석자는 이름, 불참은 인원수. 이 범위는 서버(meetups_in)가 정하는 것이고
// 여기서는 받은 것을 그대로 그릴 뿐이다 — 불참자 이름은 애초에 오지 않는다.
function renderMeetups(key){
  const box = $('#dsMeetups');
  const ms = meetsOn(key);
  const auth = getAuth();
  const past = isPast(key);

  if (!ms.length) {
    box.innerHTML = past ? '' :
      `<div class="sub" style="margin-top:14px;">아직 잡힌 모임이 없습니다.</div>`;
    return;
  }

  box.innerHTML = ms.map(m => {
    const when = timeText(m.meet_time);
    const names = (m.yes_names || []);
    const mine = auth && m.created_by === auth.uid;
    return `<div class="mtcard${mine ? ' mine' : ''}">
      <div class="mthd">
        <div class="mtwhen">${when ? esc(when) : '시간 미정'}
          ${m.place ? `<span class="pl">📍 ${esc(m.place)}</span>` : ''}
        </div>
        ${mine ? `<button class="mtdel" data-id="${esc(m.id)}" aria-label="이 모임 지우기">&times;</button>` : ''}
      </div>
      ${m.note ? `<div class="mtnote">${esc(m.note)}</div>` : ''}
      <div class="mtby">${esc(m.creator_name || '알 수 없음')}님이 만듦</div>
      <div class="mtwho">
        <span class="lb">참석</span>${names.length
          ? `<span class="yes">${names.map(esc).join(', ')}</span>`
          : `<span class="none">아직 없음</span>`}
        ${m.no_cnt ? `<span class="nocnt"> · 불참 ${m.no_cnt}명</span>` : ''}
      </div>
      ${past ? '' : `<div class="tally">
        <button type="button" class="o${m.my_status === 'yes' ? ' on' : ''}"
                data-rsvp="yes" data-id="${esc(m.id)}" aria-pressed="${m.my_status === 'yes'}">
          <b>${m.yes_cnt || 0}</b><span>✅ 참석</span></button>
        <button type="button" class="x${m.my_status === 'no' ? ' on' : ''}"
                data-rsvp="no" data-id="${esc(m.id)}" aria-pressed="${m.my_status === 'no'}">
          <b>${m.no_cnt || 0}</b><span>❌ 불참</span></button>
      </div>`}
    </div>`;
  }).join('');

  box.querySelectorAll('[data-rsvp]').forEach(b => {
    b.onclick = () => rsvp(b.dataset.id, b.dataset.rsvp);
  });
  box.querySelectorAll('.mtdel').forEach(b => {
    b.onclick = () => delMeetup(b.dataset.id);
  });
}

const shortRange = (a, b) => {
  const f = k => k.slice(5).replace('-', '/');   // '2026-08-12' → '08/12'
  return a === b ? f(a) : `${f(a)} ~ ${f(b)}`;
};

const vibTick = () => { try { navigator.vibrate && navigator.vibrate(6); } catch(e){} };

const RANGE_MAX = 90;   // 한 번에 등록할 수 있는 최대 일수 (실수로 몇 년치를 채우는 걸 막는다)

function msg(t, kind){
  const el = $('#dsMsg');
  el.textContent = t;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ══ 참석 / 불참 ══
// 같은 쪽을 다시 누르면 표를 거둔다. 화면부터 바꾸고 저장은 뒤따르게 해서
// 누른 순간 반응이 오도록 한다 — 실패하면 되돌린다.
async function rsvp(id, status){
  const auth = getAuth();
  if (!auth || !currentTeam) return msg('로그인이 필요합니다.', 'err');
  const key = openKey;
  const m = meetsOn(key).find(x => x.id === id);
  if (!m || isPast(key)) return;

  const prev = m.my_status || null;
  const next = status === prev ? null : status;

  const bump = (s, d) => { if (s === 'yes') m.yes_cnt = Math.max(0, (m.yes_cnt || 0) + d);
                           if (s === 'no')  m.no_cnt  = Math.max(0, (m.no_cnt  || 0) + d); };
  const myName = auth.name || null;   // 로그인할 때 저장해 둔 표시 이름

  // 낙관적 반영 — 숫자와 참석자 이름을 먼저 움직인다
  const beforeNames = [...(m.yes_names || [])];
  bump(prev, -1); bump(next, +1);
  m.my_status = next;
  if (myName) {
    const others = beforeNames.filter(n => n !== myName);
    m.yes_names = next === 'yes' ? [...others, myName].sort() : others;
  }
  vibTick();
  renderMeetups(key);
  msg('저장 중...');

  try {
    if (next) {
      await sbFetch('/rest/v1/meetup_rsvps?on_conflict=meetup_id,user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ meetup_id: id, user_id: auth.uid, status: next,
                               updated_at: new Date().toISOString() })
      });
    } else {
      await sbFetch(`/rest/v1/meetup_rsvps?meetup_id=eq.${id}&user_id=eq.${auth.uid}`, { method: 'DELETE' });
    }
    msg(next === 'yes' ? '참석으로 저장했습니다.' : next === 'no' ? '불참으로 저장했습니다.' : '표를 거뒀습니다.', 'ok');
    updateMonthCache();
    render();
    // 이름 목록은 내 것만 추측해서 넣은 상태다 — 서버 값으로 맞춘다
    await refresh(true);
    if ($('#daySheet').classList.contains('on')) renderMeetups(key);
  } catch(e){
    bump(next, -1); bump(prev, +1);
    m.my_status = prev;
    m.yes_names = beforeNames;
    renderMeetups(key);
    updateMonthCache();
    msg('저장하지 못했습니다: ' + errText(e), 'err');
  }
}

// ══ 모임 만들기 ══
async function saveMeetup(){
  const auth = getAuth();
  const key = openKey;
  if (!auth || !currentTeam) return msg('로그인이 필요합니다.', 'err');
  if (isPast(key)) return msg('지난 날짜에는 모임을 만들 수 없습니다.', 'err');

  const time  = $('#dsMtTime').value || null;        // '17:30' 또는 빈 값(시간 미정)
  const place = $('#dsMtPlace').value.trim() || null;
  const note  = $('#dsMtNote').value.trim() || null;
  if (!place && !time) return msg('시간이나 장소 중 하나는 적어 주세요.', 'err');

  msg('만드는 중...');
  let created;
  try {
    const rows = await sbFetch('/rest/v1/meetups', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ team_id: currentTeam, meet_date: key, meet_time: time,
                             place, note, created_by: auth.uid })
    });
    if (!rows || !rows.length) throw new Error('저장은 됐지만 결과를 받지 못했습니다.');
    created = rows[0];
  } catch(e){
    return msg('모임을 만들지 못했습니다: ' + errText(e), 'err');
  }

  await refresh(true);
  openDay(key);

  // 알림은 모임이 만들어진 뒤에 보낸다 — 알림이 실패해도 모임은 남아야 한다.
  msg('알림 보내는 중...');
  try {
    const r = await notifyMeetup(created.id);
    const n = (r && typeof r.sent === 'number') ? r.sent : null;
    msg(n === null ? '모임을 만들고 알림을 보냈습니다.'
      : n ? `모임을 만들고 ${n}명에게 알림을 보냈습니다.`
          : '모임을 만들었습니다. (알림을 켠 팀원이 아직 없습니다)', 'ok');
  } catch(e){
    // 알림만 실패한 경우 — 모임 자체는 멀쩡하다는 걸 분명히 알린다
    msg('모임은 만들었지만 알림을 보내지 못했습니다: ' + errText(e), 'err');
  }
}

// Supabase Edge Function 이 실제 발송을 맡는다 (VAPID 개인키가 서버 쪽에만 있어야 하므로).
const notifyMeetup = id => sbFetch('/functions/v1/notify-meetup', {
  method: 'POST', body: JSON.stringify({ meetup_id: id })
});

async function delMeetup(id){
  const key = openKey;
  const m = meetsOn(key).find(x => x.id === id);
  if (!m) return;
  const when = timeText(m.meet_time);
  if (!confirm(`${label(key)}${when ? ' ' + when : ''} 모임을 지울까요?\n(참석 표도 함께 사라집니다)`)) return;
  msg('삭제 중...');
  try {
    await sbFetch(`/rest/v1/meetups?id=eq.${id}`, { method: 'DELETE' });
    await refresh(true);
    openDay(key);
    msg('모임을 지웠습니다.', 'ok');
  } catch(e){
    msg('지우지 못했습니다: ' + errText(e), 'err');
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

// 그 날 팀에 등록된 일정 목록. 이름만 나오고 누가 등록했는지는 서버에서부터 나오지 않는다.
function renderAgg(key){
  const reasons = planSpans
    .filter(s => s.from <= key && key <= s.to)
    .map(s => [s.name, s.cnt]);
  let html = '';

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

// 정기전 지정/해제 (팀장 — 사이트 전체 관리자와는 다른 권한이다)
// 회차는 받지 않는다. 날짜만 정하면 순서가 회차를 정한다.
async function saveEvent(){
  if (!isTeamLeader || !currentTeam) return;
  const key = openKey;
  const note = $('#dsNote').value.trim() || null;
  msg('저장 중...');
  try {
    const rows = await sbFetch('/rest/v1/club_events?on_conflict=team_id,event_date', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ team_id: currentTeam, event_date: key, round_no: null, note })
    });
    if (!rows || !rows.length) throw new Error('권한이 없습니다. 팀장만 등록할 수 있습니다.');
    await afterEventChange();
    openDay(key);              // 시트 내용 갱신 — msg 를 지우므로 안내는 그 뒤에 띄운다
    const n = roundOf(key);
    msg(n ? `제${n}회 정기전으로 저장했습니다.` : '정기전을 저장했습니다.', 'ok');
  } catch(e){ msg('저장 실패: ' + (e.message || '알 수 없는 오류'), 'err'); }
}

async function delEvent(){
  if (!isTeamLeader || !currentTeam) return;
  const key = openKey;
  if (!events[key]) return;
  const n = roundOf(key);
  if (!confirm(`${label(key)}${n ? ` 제${n}회` : ''} 정기전을 지울까요?\n(뒤따르는 정기전의 회차가 하나씩 당겨집니다)`)) return;
  msg('삭제 중...');
  try {
    await sbFetch(`/rest/v1/club_events?team_id=eq.${currentTeam}&event_date=eq.${key}`, { method: 'DELETE' });
    await afterEventChange();
    openDay(key);
    msg('삭제했습니다. 뒤따르는 회차가 하나씩 당겨졌습니다.', 'ok');
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
  // 시작 날짜 앞에 이미 있는 정기전 수가 곧 시작 회차를 정한다 — 팀장이 적을 게 없다
  const start = countBefore($('#regFrom').value) + 1;
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

async function openRegModal(){
  if (!isTeamLeader || !currentTeam) return;
  const cfg = regLoadCfg();
  regFreq   = cfg && cfg.freq   ? cfg.freq   : 1;
  regDows   = cfg && Array.isArray(cfg.dows) ? cfg.dows.slice(0, regFreq) : [];
  regMonths = cfg && cfg.months ? cfg.months : 3;
  $('#regFrom').value = todayStr();
  regMsg('');
  regSyncSegs();
  regSyncDows();
  $('#regModal').classList.add('on');
  await ensureSeq();       // 시작 회차를 세려면 회차 표가 있어야 한다
  regSyncPrev();
}

async function regApply(){
  if (!isTeamLeader || !currentTeam) return regMsg('팀장만 정기전을 등록할 수 있습니다.', 'err');
  if (regDows.length !== regFreq) return regMsg(`요일을 ${regFreq}개 골라 주세요.`, 'err');
  const from = $('#regFrom').value;
  if (!from) return regMsg('시작 날짜를 골라 주세요.', 'err');

  const dates = regDates();
  if (!dates.length) return regMsg('잡히는 날짜가 없습니다.', 'err');
  const to = addMonths(from, regMonths);
  // 시작 날짜 앞에 이미 있는 정기전 수가 시작 회차를 정한다 (안내용 — 저장하는 값은 아니다)
  const start = countBefore(from) + 1;
  const endNo = start + dates.length - 1;
  if (!confirm(`${label(dates[0])}부터 ${label(dates[dates.length - 1])}까지\n`
    + `총 ${dates.length}회 (제${start}회 ~ 제${endNo}회) 정기전을 등록합니다.\n\n`
    + `이 기간에 이미 등록된 정기전은 새 일정으로 대체됩니다.\n계속할까요?`)) return;

  regMsg('저장 중...');
  try {
    // 요일을 바꿨을 때 예전 요일의 정기전이 남지 않도록, 기간을 통째로 비우고 새로 넣는다
    await sbFetch(`/rest/v1/club_events?team_id=eq.${currentTeam}`
      + `&event_date=gte.${from}&event_date=lte.${to}`, { method: 'DELETE' });
    // 회차는 넣지 않는다 — 날짜 순서가 곧 회차라서, 기간 뒤에 남은 정기전도 저절로 이어진다
    const rows = dates.map(d => ({ team_id: currentTeam, event_date: d, round_no: null, note: null }));
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
    await afterEventChange();              // 여러 달이 한꺼번에 바뀌었다 — 캐시를 전부 버리고 다시 읽는다
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

  $('#regFrom').onchange = () => { regSyncPrev(); regMsg(''); };
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
$('#dsMtSave').onclick = saveMeetup;
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

// 다른 부원이 답한 건 서버에만 쌓이므로, 화면으로 돌아올 때 다시 읽어 온다.
// (앱을 켜 둔 채로도 최신 참석 인원을 보게 된다. 폴링은 하지 않는다)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTeam) refresh(true);
});

// ══ 알림에서 들어온 경우 ══
// 알림 버튼(참석/불참)은 안드로이드에만 있다. iOS 는 알림을 누르면 여기로 오는데,
// 그때 ?meetup=<id> 를 달고 온다 → 그 모임이 있는 날짜의 상세를 열어 준다.
async function openFromLink(){
  const id = new URLSearchParams(location.search).get('meetup');
  if (!id) return;
  // 주소창에 남겨 두면 새로고침마다 시트가 다시 열린다 → 한 번 쓰고 지운다
  try { history.replaceState(null, '', location.pathname); } catch(e){}
  try {
    const rows = await sbFetch('/rest/v1/rpc/meetup_one', {
      method: 'POST', body: JSON.stringify({ m: id })
    });
    const m = Array.isArray(rows) ? rows[0] : null;
    if (!m) return;
    // 다른 팀·다른 달의 모임일 수 있다 — 그 팀과 그 달로 옮겨 놓고 연다
    if (m.team_id && m.team_id !== currentTeam) {
      currentTeam = m.team_id; tSet(currentTeam);
      const me = myTeams.find(t => t.id === currentTeam);
      isTeamLeader = !!(me && me.is_admin);
      renderTeamBar();
    }
    const [y, mo] = m.meet_date.split('-').map(Number);
    cur = new Date(y, mo - 1, 1);
    await refresh(true);
    openDay(m.meet_date);
  } catch(e){ /* 못 찾으면 그냥 이번 달을 보여 준다 */ }
}

// ══ 시작 ══
applyTheme(getTheme());
registerSW();
(async () => {
  $('#view').innerHTML = '<div class="card"><div class="empty">불러오는 중...</div></div>';
  if (getAuth()) $('#btnLogout').style.display = '';
  await loadTeams();
  renderTeamBar();
  await refresh();
  await openFromLink();
})();
