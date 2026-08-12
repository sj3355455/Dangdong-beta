import { sbFetch } from './supabase.js';
import { registerSW, getTheme, applyTheme, LS_THEME, initTeamModal,
         ymd, todayYmd, ddmy, rangeRowHtml, bindRangePicker, syncRangeDisp } from './common.js';

let DATA = { updated: '', players: [], games: [] };
let RAW_GAMES = [];
let RAW_MEMBERS = [];
let rankFrom = '';   // 조회 시작일 (YYYY-MM-DD, ''=제한 없음)
let rankTo = '';     // 조회 종료일 (둘 다 ''이면 통산)
let gamesMode = '통합';
const GAMES_PAGE = 20;   // 경기 탭에서 한 번에 그리는 경기 수 (아래로 내리면 이만큼씩 더)
let gamesIO = null;      // 경기 목록 무한 스크롤 관찰자 (화면을 벗어나면 끊는다)
let RAW_HDCP = [];       // 수지 변경 이력 (handicap_history) — 홈 탭의 '수지 상승' 카드용
let homeTimer = null;    // 홈 카드 자동 넘김 타이머 (화면을 바꿀 때 끊는다)
let homeVis = null;      // 홈 카드의 visibilitychange 핸들러 (같이 떼야 새 화면에 남지 않는다)
// 홈을 떠날 때 정리 — 화면을 바꾸는 곳(show/showPlayer)마다 불러 준다
function stopHome(){
  if (homeTimer) { clearTimeout(homeTimer); homeTimer = null; }
  if (homeVis) { document.removeEventListener('visibilitychange', homeVis); homeVis = null; }
}

// ── 정기전 필터 ──
// 경기는 날짜가 아니라 정기전(club_events)에 붙어 있다. 날짜 범위로는 "정기전 날에 낀
// 정기전 아닌 경기"를 뺄 수 없어서 따로 둔다. 켜고 끄는 것 하나면 충분하다 —
// 특정 회차만 보고 싶으면 이걸 켠 채 기간을 그 날짜로 잡으면 된다.
const EVT_ICON = '⭐';   // 정기전 표시. 🏆 는 우승 표시로 이미 쓰고 있어 겹치면 안 된다.
let RAW_EVENTS = [];
let clubOnly = false;
let HAS_EVENTS = true;   // DB에 event_id 컬럼이 있는지 (없으면 필터 UI를 숨긴다)
const evtLabel = e => e ? ((e.round_no ? `제${e.round_no}회 정기전` : '정기전') + ' (' + ddmy(e.event_date) + ')') : '';
const evtById = id => RAW_EVENTS.find(e => String(e.id) === String(id)) || null;

// ── 소속 팀 컨텍스트 (점수판과 localStorage 공유) ──
const LS_TEAM = 'dangCurrentTeam';
const tGet = () => { try { return JSON.parse(localStorage.getItem(LS_TEAM)); } catch(e){ return null; } };
const tSet = v => { try { localStorage.setItem(LS_TEAM, JSON.stringify(v)); } catch(e){} };
let myTeams = [];
let currentTeam = tGet();   // 현재 팀 id (없으면 전역 폴백)

// ── 기간 관련 공용 헬퍼 ── (ymd/todayYmd/ddmy 와 기간 선택기는 common.js 에서 가져온다)
// dateStr(YYYY-MM-DD)이 [from, to] 안이면 true. from/to는 ''이면 제한 없음, 뒤집혀 있으면 자동 보정.
function inRange(dateStr, from, to){
  let lo = from, hi = to;
  if (lo && hi && lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo && dateStr < lo) return false;
  if (hi && dateStr > hi) return false;
  return true;
}
// 기복 = 경기별 에버리지의 변동계수(표준편차 ÷ 평균) × 100. 2경기 미만이면 null.
function volatilityPct(avgs){
  if (!avgs || avgs.length < 2) return null;
  const m = avgs.reduce((x, y) => x + y, 0) / avgs.length;
  if (!(m > 0)) return null;
  const sd = Math.sqrt(avgs.reduce((x, y) => x + (y - m) ** 2, 0) / avgs.length);
  return (sd / m) * 100;
}
// 알 이닝 = 알을 쳐서 점수를 노린 이닝. 마무리 쿠션만 친 이닝은 뺀다. 에버·득점률·평균 타수의 분모.
// (쿠션 이닝은 cushInn 으로 따로 세고 쿠션 성공률로만 쓴다)
//
// ballInn 이 저장되기 전 기록은 총 이닝 − 쿠션 이닝으로 되살린다. cushInn 의 정의는
// 예전부터 지금까지 '마무리 쿠션 단계로 끝난 이닝'으로 동일하므로 그대로 뺄 수 있다.
// 다만 목표를 채운 이닝은 알(도달 전)과 쿠션(도달 후) 양쪽에 걸쳐 있어 뺄셈으로 사라진다 → 1을 되돌려준다.
// 팀전은 짝꿍 둘 중 누가 마지막 점수를 냈는지가 저장돼 있지 않아 되돌리지 않는다(없는 이닝을 만들지 않기 위해).
function ballInnOf(p, innings){
  const inn = innings != null ? innings : (p.innings || 0);
  if (p.ballInn != null) return p.ballInn;
  const cushInn = p.cushInn ?? p.cush_inn ?? 0;
  if (!cushInn) return inn;                       // 마무리 쿠션 단계가 없던 경기 → 전부 알 이닝
  return Math.max(0, inn - cushInn + (p.isTeam ? 0 : 1));
}
// 공타 = 알 이닝 중 한 점도 못 낸 이닝. 득점률·평균 타수에서 알 이닝과 짝을 이룬다.
// 예전 기록은 공타를 이닝 종류와 무관하게 세서 마무리 쿠션을 못 친 이닝까지 들어가 있다.
// 그대로 두면 공타가 알 이닝보다 커져 득점률이 음수가 된다 → 쿠션 쪽 실패를 덜어낸다.
//   쿠션 이닝 = 목표를 채운 이닝(점수를 냈으니 공타 아님) + 쿠션을 성공한 이닝 + 쿠션 공타
// 마지막으로 알 이닝 범위로 잘라 어떤 경우에도 0~100% 를 벗어나지 않게 한다.
function missOf(p, bInn){
  const miss = p.misses ?? p.miss_count ?? 0;
  if (p.ballInn == null) {
    const cushInn = p.cushInn ?? p.cush_inn ?? 0;
    if (cushInn) {
      const cushMade = p.cushMade ?? p.cush_made ?? 0;
      const cushMiss = Math.max(0, cushInn - (p.isTeam ? 0 : 1) - cushMade);
      return Math.max(0, Math.min(miss - cushMiss, bInn));
    }
  }
  return Math.max(0, Math.min(miss, bInn));
}
// 정기전만 보기 토글. 기간 줄 아래에 따로 둔다 — 한 줄에 넣으면 폰에서 너무 좁다.
// 등록된 정기전이 없거나 DB에 event_id 컬럼이 없으면 아예 그리지 않는다.
function eventRowHtml(cls){
  if (!HAS_EVENTS || !RAW_EVENTS.length) return '';
  return `<button class="mbtn push ${cls}-evt ${clubOnly?'on':''}">
      ${clubOnly ? '✓ ' : ''}${EVT_ICON} 정기전만 보기
    </button>`;
}
// 토글 버튼을 변경 핸들러에 연결. 없으면 아무것도 하지 않는다.
function bindEventSel(el, cls, onChange){
  const btn = el.querySelector('.'+cls+'-evt');
  if (btn) btn.onclick = () => { clubOnly = !clubOnly; onChange(); };
}

let fullProcessCache = null;
let filteredDataCache = null;
let filteredCacheKey = '';

function clearProcessCache() {
  fullProcessCache = null;
  filteredDataCache = null;
  filteredCacheKey = '';
  monthCache = { key: '', data: null };   // 홈 탭의 이번 달/지난 달 집계도 같이 버린다
}

function getFullProcessData() {
  if (!fullProcessCache) {
    fullProcessCache = processData(RAW_GAMES, RAW_MEMBERS);
  }
  return fullProcessCache;
}

function getFilteredData() {
  const cacheKey = `${rankFrom}|${rankTo}|${clubOnly}|${RAW_GAMES.length}`;
  if (filteredDataCache && filteredCacheKey === cacheKey) {
    return filteredDataCache;
  }
  const byDate = (rankFrom || rankTo)
    ? RAW_GAMES.filter(g => inRange(ymd(new Date(g.played_at)), rankFrom, rankTo))
    : RAW_GAMES;
  const games = clubOnly ? byDate.filter(g => !!g.event_id) : byDate;
  filteredDataCache = processData(games, RAW_MEMBERS);
  filteredCacheKey = cacheKey;
  return filteredDataCache;
}

const SB_URL = 'https://ezwassqurbmzcjfmtjop.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6d2Fzc3F1cmJtemNqZm10am9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjMxOTIsImV4cCI6MjA5OTc5OTE5Mn0.O6eHOO4-yxW7HVmNVjOkakrcoEeF5tORylhG1j79BeU';
const LS_AUTH = 'dangScoreAuth';

async function fetchGames() {
  if (!currentTeam) return []; // 소속 팀이 없는 사용자는 다른 팀의 게임 정보를 조회하지 않음
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  try {
    const auth = getAuth();
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
  } catch(e) {}
  
  // event_id 는 마이그레이션(event-games.sql) 이후에만 있는 컬럼이다. 아직 없는 DB에서도
  // 기록실이 통째로 죽지 않도록, 실패하면 빼고 한 번 더 부른다(정기전 필터만 비활성).
  const base = SB_URL + '/rest/v1/games?select=';
  const tail = '&order=played_at.asc&team_id=eq.' + currentTeam;
  const get = async cols => {
    const res = await fetch(base + cols + tail, { headers: headers });
    if (!res.ok) throw Object.assign(new Error('fetch error'), { status: res.status });
    return await res.json();
  };
  try {
    return await get('id,played_at,players,event_id');
  } catch(e){
    if (e.status !== 400 && e.status !== 404) throw e;
    HAS_EVENTS = false;
    return await get('id,played_at,players');
  }
}

// 수지 변경 이력. handicap-history.sql 을 아직 안 돌린 DB에서도 홈 탭이 통째로 죽지 않게
// 실패하면 빈 배열 — 수지 상승 카드만 안 뜬다. (팀 구분이 없는 테이블이라 소속 팀 회원으로 걸러 쓴다)
async function fetchHandicapHistory(){
  if (!currentTeam) return [];
  try {
    const rows = await sbFetch('/rest/v1/handicap_history'
      + '?select=player_id,old_handicap,new_handicap,changed_at&order=changed_at.asc');
    return Array.isArray(rows) ? rows : [];
  } catch(e){ return []; }
}

// 정기전 목록 (캘린더에서 관리자가 등록한 것). 기록실에서는 읽기만 한다.
async function fetchEvents(){
  if (!currentTeam) return [];
  try {
    const rows = await sbFetch('/rest/v1/club_events?select=id,event_date,round_no,note&team_id=eq.'
      + currentTeam + '&order=event_date.desc');
    return Array.isArray(rows) ? rows : [];
  } catch(e){ return []; }   // 캘린더 미배포 → 정기전 필터만 사라짐
}

// 내 소속 팀 로드 + 현재 팀 확정 (실패 시 전역 폴백)
async function loadTeams(){
  const auth = getAuth();
  if (!auth || !auth.uid) { myTeams = []; renderTeamBar(); return; }
  try {
    const rows = await sbFetch('/rest/v1/rpc/my_teams', { method: 'POST', body: JSON.stringify({}) });
    myTeams = Array.isArray(rows) ? rows : [];
    const remembered = tGet();
    if (remembered && myTeams.some(t => t.id === remembered)) currentTeam = remembered;
    else currentTeam = myTeams[0] ? myTeams[0].id : null;
    tSet(currentTeam);
  } catch(e){ /* my_teams 미배포 등 → 전역 폴백 */ }
  renderTeamBar();
}

// 헤더 소속 팀 스위처
function renderTeamBar(){
  const bar = document.getElementById('teamBar');
  const sel = document.getElementById('teamSel');
  if (!bar || !sel) return;
  const auth = getAuth();
  if (!auth) { bar.style.display = 'none'; return; }
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
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '팀 전환 중...';
    await reloadData();
    const cur = document.querySelector('.tab.on') ? document.querySelector('.tab.on').dataset.v : 'rank';
    show(cur);
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
  };
}

// ══ 팀 설정 모달 — 공통 모듈(common.js)로 이동. 앱별 차이(콜백)만 주입. ══
const { open: openTeamModal } = initTeamModal({
  getAuth: () => getAuth(),
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; tSet(currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: async () => {
    await reloadData();
    const cur = document.querySelector('.tab.on') ? document.querySelector('.tab.on').dataset.v : 'rank';
    show(cur);
  }
});

async function fetchMembers() {
  if (!currentTeam) return []; // 소속 팀이 없으면 다른 팀의 회원 정보가 조회되지 않도록 격리
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  try {
    const auth = getAuth();
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
  } catch(e) {}
  
  const res = await fetch(SB_URL + '/rest/v1/team_members?select=user_id,profiles(id,display_name,handicap)&team_id=eq.' + currentTeam, {
    headers: headers
  });
  if (!res.ok) throw new Error('fetch error');
  const rows = await res.json();
  // team_members 는 profiles 를 중첩해서 반환한다({user_id, profiles:{...}}).
  // processData 의 수지 매칭은 평탄한 {id, display_name, handicap} 구조를 기대하므로 평탄화한다.
  // (이걸 안 하면 매칭이 전부 실패해 프로필의 실제 수지가 반영되지 않고 0으로 남는다.)
  return (rows || []).map(r => (r && r.profiles) ? {
    id: r.profiles.id,
    display_name: r.profiles.display_name,
    handicap: r.profiles.handicap
  } : r).filter(Boolean);
}

// ══ 관리자 기능 ══
// 서버(RLS)가 실제 권한을 강제한다. 여기서는 UI 노출 여부만 판단.
let IS_ADMIN = false;
async function fetchAdmin(){
  const auth = getAuth();
  if (!auth || !auth.uid || !auth.token) return false;
  try {
    const d = await sbFetch('/rest/v1/profiles?select=is_admin&id=eq.' + auth.uid);
    return !!(d && d[0] && d[0].is_admin);
  } catch(e){ return false; }   // is_admin 컬럼이 아직 없으면 조용히 비활성화
}
// Prefer: return=representation — RLS에 막히면 빈 배열이 와서 실패를 감지할 수 있다
const REP = { headers: { Prefer: 'return=representation' } };
const adminApi = {
  updateGame: (id, players) => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'PATCH', body: JSON.stringify({ players }) }, REP)),
  updateGameEvent: (id, event_id) => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'PATCH', body: JSON.stringify({ event_id }) }, REP)),
  deleteGame: id => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'DELETE' }, REP)),
  updateProfile: (id, fields) => sbFetch('/rest/v1/profiles?id=eq.' + id, Object.assign({ method: 'PATCH', body: JSON.stringify(fields) }, REP)),
  // 이름 변경을 한 번에: 프로필 + 그 사람이 뛴 모든 경기의 저장된 이름을 서버에서 갱신 (본인/관리자만)
  renamePlayer: (id, name, handicap) => sbFetch('/rest/v1/rpc/rename_player', { method: 'POST', body: JSON.stringify({ target: id, new_name: name, new_handicap: handicap }) })
};
async function reloadData(){
  clearProcessCache();
  RAW_GAMES = await fetchGames();
  RAW_MEMBERS = await fetchMembers().catch(() => RAW_MEMBERS);
  RAW_EVENTS = await fetchEvents();
  RAW_HDCP = await fetchHandicapHistory();   // 수지를 고친 직후면 이력이 한 줄 늘어 있다
  DATA = getFilteredData();
}
const NO_PERM = '권한이 없습니다. 관리자 계정으로 로그인했는지 확인하세요.';

function attachGameAdmin(el, id){
  const raw = RAW_GAMES.find(r => String(r.id) === String(id));
  if (!raw) return;
  const F = [['rank','순위'],['score','점수'],['target','목표'],['innings','이닝'],['highRun','하이런'],['misses','공타'],['fouls','파울'],['cushMade','쿠션성공'],['cushInn','쿠션시도']];
  // 정기전 소속 정정 — 부원은 games 를 수정할 권한이 없어서(RLS) 잘못 저장된 소속은 여기서만 고친다.
  // 예: 정기전 날에 낀 친선 경기를 '정기전 아님'으로 내리는 경우.
  const evtSel = !HAS_EVENTS ? '' : `
    <div style="margin-top:12px">
      <div class="sub" style="margin:0 0 6px">정기전 소속</div>
      <select id="gAdmEvt" class="field" style="width:100%; height:34px; padding:0 26px 0 8px; font-size:0.9rem; border-radius:8px; margin:0;">
        <option value="" ${!raw.event_id?'selected':''}>정기전 아님 (일반 경기)</option>
        ${RAW_EVENTS.map(e => `<option value="${esc(e.id)}" ${String(raw.event_id)===String(e.id)?'selected':''}>${esc(evtLabel(e))}</option>`).join('')}
      </select>
      <div id="gAdmEvtMsg" class="sub" style="margin-top:6px"></div>
    </div>`;
  const bar = $(`<div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🛠 관리자</h3>
    <div style="display:flex; gap:8px;">
      <button class="mbtn" id="gAdmEdit">✏️ 경기 수정</button>
      <button class="mbtn" id="gAdmDel" style="color:#e5484d;border-color:#e5484d">🗑 경기 삭제</button>
    </div>
    ${evtSel}
    <div id="gAdmForm" style="display:none; margin-top:12px">
      <div class="scroll"><table>
        <thead><tr><th class="name">선수</th>${F.map(f=>`<th>${f[1]}</th>`).join('')}</tr></thead>
        <tbody>${raw.players.map((p,j)=>`<tr><td class="name">${esc(p.name||'')}</td>${
          F.map(f=>`<td><input data-j="${j}" data-k="${f[0]}" type="number" value="${p[f[0]] ?? 0}" style="width:64px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px"></td>`).join('')
        }</tr>`).join('')}</tbody>
      </table></div>
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="mbtn on" id="gAdmSave">저장</button>
        <button class="mbtn" id="gAdmCancel">취소</button>
      </div>
      <div class="sub" style="margin-top:8px">순위를 바꾸면 우승(1위) 여부도 자동으로 맞춰집니다.</div>
    </div>
  </div>`);
  bar.querySelector('#gAdmEdit').onclick = () => {
    const f = bar.querySelector('#gAdmForm');
    f.style.display = f.style.display === 'none' ? '' : 'none';
  };
  const evtSelEl = bar.querySelector('#gAdmEvt');
  if (evtSelEl) evtSelEl.onchange = async () => {
    const msg = bar.querySelector('#gAdmEvtMsg');
    const prev = raw.event_id || '';
    evtSelEl.disabled = true;
    msg.textContent = '저장 중...'; msg.style.color = 'var(--muted)';
    try {
      const d = await adminApi.updateGameEvent(raw.id, evtSelEl.value || null);
      if (!d || !d.length) throw new Error(NO_PERM);
      await reloadData();
      // 정기전 필터를 켜 둔 상태에서 소속을 바꾸면 이 경기가 목록에서 빠질 수 있다 → 목록으로
      if (DATA.games.some(v => v.id === String(id))) showGame(id);
      else show('games');
    } catch(err){
      evtSelEl.value = prev; evtSelEl.disabled = false;
      msg.textContent = '변경 실패: ' + err.message; msg.style.color = '#f44336';
    }
  };
  bar.querySelector('#gAdmCancel').onclick = () => { bar.querySelector('#gAdmForm').style.display = 'none'; };
  bar.querySelector('#gAdmSave').onclick = async e => {
    const btn = e.target; btn.disabled = true;
    try {
      const np = raw.players.map(p => Object.assign({}, p));
      bar.querySelectorAll('#gAdmForm input').forEach(inp => {
        np[+inp.dataset.j][inp.dataset.k] = parseInt(inp.value, 10) || 0;
      });
      np.forEach(p => { p.win = p.rank === 1; });
      const d = await adminApi.updateGame(raw.id, np);
      if (!d || !d.length) throw new Error(NO_PERM);
      await reloadData();
      alert('경기 기록이 수정되었습니다.');
      showGame(id);
    } catch(err){ alert('수정 실패: ' + err.message); btn.disabled = false; }
  };
  bar.querySelector('#gAdmDel').onclick = async () => {
    if (!confirm('이 경기를 완전히 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      const d = await adminApi.deleteGame(raw.id);
      if (!d || !d.length) throw new Error(NO_PERM);
      await reloadData();
      alert('경기가 삭제되었습니다.');
      show('games');
    } catch(err){ alert('삭제 실패: ' + err.message); }
  };
  el.appendChild(bar);
}

function processData(games, members) {
  const pmap = {};
  const dataGames = [];
  // 이름은 경기에 저장된 값을 그대로 쓴다. (이름 변경 시 rename_player 함수가
  //  프로필과 모든 경기의 저장 이름을 한 번에 갱신하므로 매번 매칭할 필요가 없다.)

  for (const g of (games || [])) {
    if (!g) continue;
    const dt = new Date(g.played_at);
    const pad = n => String(n).padStart(2, '0');
    const dateStr = dt.getFullYear() + '-' + pad(dt.getMonth()+1) + '-' + pad(dt.getDate());
    const datetimeStr = dateStr + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
    const pls = Array.isArray(g.players) ? g.players : [];
    const isTeam = pls.length > 0 && pls[0].isTeam;
    const typeStr = isTeam ? '팀전' : (pls.length + '인');
    const nameStr = typeStr;

    dataGames.unshift({
      id: String(g.id || datetimeStr),
      date: dateStr,
      datetime: datetimeStr,
      type: typeStr,
      name: nameStr,
      eventId: g.event_id || null,
      players: pls.map(p => ({
        name: p.name || p.id || "알 수 없음", ranking: p.win ? 1 : 2,
        rank: p.rank != null ? p.rank : (p.win ? 1 : 2),
        timeMs: p.timeMs ?? p.time_ms ?? 0,
        target: p.target, score: p.score, innings: p.innings, ballInn: ballInnOf(p),
        highRun: p.highRun ?? p.high_run ?? 0, misses: missOf(p, ballInnOf(p)), cushMade: p.cushMade ?? p.cush_made ?? 0, cushInn: p.cushInn ?? p.cush_inn ?? 0,
        // 파울은 나중에 추가된 항목 — 예전 기록에는 없으므로 0이 아니라 null(기록 없음)로 둔다
        fouls: p.fouls ?? null
      }))
    });

    // 게임 내 각 선수의 평균순위(분수). 동순위는 공동 점유 구간의 평균: 공동 2등 = 2.5, 공동 3등 = 3.5
    const ranks = pls.map(pp => (pp.rank != null ? pp.rank : (pp.win ? 1 : 2)));
    const fracRank = idx => {
      const r = ranks[idx]; let less = 0, eq = 0;
      for (const rr of ranks) { if (rr < r) less++; else if (rr === r) eq++; }
      return less + (eq + 1) / 2;
    };

    for (const p of pls) {
      const pName = p.name || p.id || "알 수 없음";
      // 회원은 계정 id로 묶어 이름이 바뀌어도 같은 사람으로 집계. 게스트는 이름으로 묶는다.
      const key = p.id ? ('id:' + p.id) : ('nm:' + pName);
      if (!pmap[key]) {
        pmap[key] = {
          name: pName,
          handicap: isTeam ? 0 : p.target,
          games: 0,
          wins: 0,
          modes: {},   // 모드별 집계: {'2인':{games,wins,rankSum}, '3인':..., '4인':..., '팀전':...}
          history: [],
          adjPtsSum: 0,
          id: p.id || null
        };
      }
      const st = pmap[key];
      if (!isTeam) st.handicap = Math.max(st.handicap, p.target);
      st.games++;
      if (p.win) st.wins++;

      const pIdx = g.players.indexOf(p);
      const pRank = fracRank(pIdx);
      
      let pt = 0;
      if (isTeam) {
        pt = (3.5 - pRank) / 2 * 100;
      } else {
        const N = g.players.length;
        if (N > 1) pt = (N - pRank) / (N - 1) * 100;
      }
      st.adjPtsSum += pt;

      const M = st.modes[typeStr] || (st.modes[typeStr] = { games: 0, wins: 0, rankSum: 0, adjPtsSum: 0 });
      M.games++;
      if (p.win) M.wins++;
      M.rankSum += pRank;
      M.adjPtsSum += pt;

      const opp = g.players.filter(x => (x.name || x.id) !== pName).map(x => x.name || x.id).join(', ');
      const innings = p.innings || p.turn_count || 0;
      const bInn = ballInnOf(p, innings);
      const average = bInn ? (p.score / bInn) : 0;

      st.history.unshift({
        id: g.id,
        type: typeStr,
        rank: pRank,
        date: dateStr,
        opponents: opp,
        score: p.score,
        inning: innings,       // 총 이닝(알 + 쿠션) — 인터벌 계산용
        ballInn: bInn,         // 알 이닝 — 에버·득점률·평균타수의 분모
        miss: missOf(p, bInn),
        foul: p.fouls ?? null,   // 기록되기 전 경기는 null
        average: average,
        highRun: p.highRun ?? p.high_run ?? 0,
        cushMade: p.cushMade ?? p.cush_made ?? 0,
        cushInn: p.cushInn ?? p.cush_inn ?? 0,
        timeMs: p.timeMs ?? p.time_ms ?? 0,
        win: p.win,
        adjPt: pt
      });
    }
  }

  const pArr = Object.values(pmap);
  
  // Update handicap based on actual member info
  if (members && members.length > 0) {
    for (const p of pArr) {
      let m = p.id ? members.find(x => x.id === p.id) : null;
      if (!m) m = members.find(x => x.display_name === p.name);
      if (m) {
        // 이름은 경기에 저장된 값을 사용 (rename_player가 저장 시점에 갱신). 여기선 현재 수지만 반영.
        if (m.handicap != null) p.handicap = parseInt(m.handicap, 10);
      }
    }
  }

  for (const p of pArr) {
    p.winRate = p.games > 0 ? (p.wins / p.games) * 100 : 0;
    p.adjRate = p.games > 0 ? (p.adjPtsSum / p.games) : 0;

    for (const mk in p.modes) {
      const M = p.modes[mk];
      M.winRate = M.games > 0 ? (M.wins / M.games) * 100 : 0;
      M.avgRank = M.games > 0 ? (M.rankSum / M.games) : null;
      M.adjRate = M.games > 0 ? (M.adjPtsSum / M.games) : 0;
    }

    // 실력 지표: 전체(통합) 누적과 모드별 누적을 함께 계산한다.
    const blankAcc = () => ({ inn:0, binn:0, score:0, hr:0, miss:0, cm:0, ci:0, time:0, shots:0, avgs:[],
                              fBinn:0, fMiss:0, fGross:0, fFoul:0 });   // f* = 파울이 기록된 경기만 (평균 타수·파울률용)
    const tot = blankAcc();
    const byMode = {};   // 모드별 실력 지표 누적

    for (const h of p.history) {
      const add = a => {
        a.inn += h.inning;      // 총 이닝 — 인터벌용
        a.binn += h.ballInn;    // 알 이닝 — 에버·득점률·평균타수용
        a.score += h.score;
        a.miss += h.miss;
        // 평균 타수·파울률은 파울이 기록된 경기만 모은다 — 파울 수를 모르면 분자(파울 차감 전 득점)를 복원할 수 없다
        if (h.foul != null) { a.fBinn += h.ballInn; a.fMiss += h.miss; a.fGross += h.score + h.foul; a.fFoul += h.foul; }
        if (h.highRun > a.hr) a.hr = h.highRun;
        a.cm += h.cushMade;
        a.ci += h.cushInn;
        if (h.ballInn > 0) a.avgs.push(h.score / h.ballInn);   // 경기별 에버리지 (기복 계산용)
        if (h.timeMs > 0) {
          a.time += h.timeMs;
          a.shots += Math.max(1, h.score + h.inning);
        }
      };
      add(tot);
      add(byMode[h.type] || (byMode[h.type] = blankAcc()));
    }

    // 누적 → 지표 변환 (통합/모드 공통 규칙)
    const finalize = (dst, a) => {
      // 에버 = 총득점 / 알 이닝 (마무리 쿠션만 친 이닝은 분모에서 뺀다)
      dst.avgAvg = a.binn > 0 ? (a.score / a.binn) : 0;
      dst.bestHr = a.hr;
      dst.hitRate = a.binn > 0 ? ((a.binn - a.miss) / a.binn) * 100 : 0;
      // 평균 타수 = (파울 차감 전 득점) / 득점한 알 이닝. 파울이 기록되기 전 경기는 아예 뺀다.
      // 파울 수를 모르면 분자를 복원할 수 없어 실제보다 낮게 나오기 때문. 해당 경기가 없으면 null.
      dst.streakAvg = (a.fBinn - a.fMiss) > 0 ? (a.fGross / (a.fBinn - a.fMiss)) : null;
      // 파울률 = 파울 / 총 타격수. 타격은 두 종류뿐이라 이렇게 센다:
      //   · 득점한 타격 = 파울 차감 전 득점(fGross)  — 1점당 1타격
      //   · 실패한 타격 = 알 이닝 수(fBinn)          — 알 이닝은 공타 아니면 파울로 끝난다
      //
      // '공타'를 분모로 쓰면 안 된다. 공타는 빗맞힌 타격 수가 아니라 '한 점도 못 낸 이닝 수'다
      // (score/app.js 의 closeInning: isMiss && tp===0 일 때만 센다). 그래서 3점 뽑고 실패한 이닝의
      // 마지막 타격이 통째로 빠지고, 반대로 무득점 이닝의 파울은 공타로도 세여 이중 계상된다.
      //
      // 한계: 목표를 채우며 끝난 이닝은 실패 타격이 없는데도 fBinn 에 들어가므로 분모가 경기당 최대
      // 1 만큼 크다(≈ 실제보다 3% 낮게 나옴). 완주 여부는 저장된 값으로 팀전에서 가려낼 수 없어
      // (score 는 개인 점수, target 은 팀 목표) 보정하지 않는다 — 모드별로 다르게 틀리는 게 더 나쁘다.
      dst.foulRate = (a.fGross + a.fBinn) > 0 ? (a.fFoul / (a.fGross + a.fBinn)) * 100 : null;
      // 평균 인터벌 = 1샷(타석) 당 평균 소모 시간(초). 공타/파울 횟수까지 포함
      dst.avgInterval = a.shots > 0 ? (a.time / a.shots) / 1000 : null;
      // 쿠션 성공률 = 마무리 쿠션 성공 / 쿠션을 시도한 이닝. 시도가 없으면 null
      dst.cushRate = a.ci > 0 ? (a.cm / a.ci) * 100 : null;
      // 기복 = 경기별 에버리지의 변동계수(%). 2경기 미만이면 null
      dst.volatility = volatilityPct(a.avgs);
    };
    finalize(p, tot);
    for (const mk in p.modes) {
      if (byMode[mk]) finalize(p.modes[mk], byMode[mk]);
    }
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return {
    updated: now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
    players: pArr,
    games: dataGames
  };
}

const $ = (h) => { const d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const getAuth = () => { try { return JSON.parse(localStorage.getItem(LS_AUTH)); } catch(e) { return null; } }

const COL_NAME = {k:'name', t:'이름', txt:1};
const COL_HDCP = {k:'handicap', t:'수지', fmt:v=>v ? v*10 : '—'};
const COLS_ALL = [   // 통합: 실력 지표 통합. 승수·승률 대신 보정 승률(준비 중)
  COL_NAME, COL_HDCP,
  {k:'games',    t:'경기수'},
  {k:'adjRate',  t:'승률',      fmt:v=>v.toFixed(1)+'%'},
  {k:'avgAvg',   t:'에버리지',   fmt:v=>v.toFixed(3)},
  {k:'streakAvg',t:'평균 타수', fmt:v=>v.toFixed(2)},
  {k:'hitRate',  t:'득점률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'foulRate', t:'파울률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'cushRate', t:'쿠션 성공률', fmt:v=>v.toFixed(1)+'%'},
  {k:'bestHr',   t:'하이런'},
  {k:'avgInterval', t:'평균 인터벌', fmt:v=>v.toFixed(1)+'초'},
  {k:'volatility', t:'기복',     fmt:v=>v.toFixed(1)+'%'},
];
const COLS_SKILL = [  // 모드 공통 실력 지표
  {k:'avgAvg',   t:'에버리지',   fmt:v=>v.toFixed(3)},
  {k:'streakAvg',t:'평균 타수', fmt:v=>v.toFixed(2)},
  {k:'hitRate',  t:'득점률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'foulRate', t:'파울률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'cushRate', t:'쿠션 성공률', fmt:v=>v.toFixed(1)+'%'},
  {k:'bestHr',   t:'하이런'},
  {k:'avgInterval', t:'평균 인터벌', fmt:v=>v.toFixed(1)+'초'},
  {k:'volatility', t:'기복',     fmt:v=>v.toFixed(1)+'%'},
];
const COLS_VS = [    // 2인 · 팀전: 두 진영 승부
  COL_NAME, COL_HDCP,
  {k:'games',   t:'경기수'},
  {k:'wins',    t:'승'},
  {k:'winRate', t:'승률', fmt:v=>v.toFixed(0)+'%'},
  ...COLS_SKILL,
];
const COLS_MULTI = [ // 3인 · 4인: 다자전
  COL_NAME, COL_HDCP,
  {k:'games',   t:'경기수'},
  {k:'avgRank', t:'평균순위', fmt:v=>v.toFixed(2)+'등'},
  {k:'winRate', t:'승률(1등)', fmt:v=>v.toFixed(0)+'%'},
  ...COLS_SKILL,
];
const MODE_TABS = ['통합','2인','3인','4인','팀전'];
const colsFor = m => m==='통합' ? COLS_ALL : (m==='2인'||m==='팀전') ? COLS_VS : COLS_MULTI;
const defSort = m => m==='통합' ? 'avgAvg' : 'winRate';
const cell = (p, c) => p[c.k]==null ? '—' : (c.fmt ? c.fmt(p[c.k]) : p[c.k]);
// 값이 낮을수록 잘한 지표. 표에서 제목을 처음 눌렀을 때와 포디움의 1등이 여기에 달려 있다.
// (기복 = 경기별 에버리지 변동폭이라 낮을수록 안정적이다)
const bestIsLow = k => k==='avgRank' || k==='foulRate' || k==='volatility';
// 포디움에 올릴 지표 — 승률·에버리지·평균 타수·득점률·하이런만. 표(COLS)의 순서를 따라간다.
// 승률은 모드마다 열 키가 다르다(통합 adjRate / 나머지 winRate).
const PODIUM_KEYS = ['adjRate','winRate','avgAvg','streakAvg','hitRate','bestHr'];
const podiumCols = COLS => COLS.filter(c => PODIUM_KEYS.includes(c.k));
let rankMode='통합', sortKey='avgAvg', sortAsc=false;
let rankView='table';   // 'table' | 'podium' — 순위 탭 안에서 표/포디움 전환

function rankRows(mode){
  if(mode==='통합') return DATA.players.filter(p=>p.games>0 && p.id);
  return DATA.players
    .filter(p=>p.modes[mode] && p.modes[mode].games>0 && p.id)
    .map(p=>({name:p.name, handicap:p.handicap, ...p.modes[mode]}));
}

/* 포디움 — 1·2·3등은 시상대에, 나머지는 아래 목록에.
   등수는 표와 똑같이 rankOf(공동 등수)를 그대로 쓴다. 공동 1등이 둘이면 한 칸에 둘 다
   올라가고 2등 칸은 비는 게 아니라 아예 없다(다음이 3등이므로). */
// 1~3등을 등수별로 묶는다(공동 등수면 한 묶음). 화면과 저장 이미지가 같은 결과를 쓰도록 공용.
function podiumGroups(rows, rankOf){
  const groups = [];
  rows.forEach((p, i) => {
    const r = rankOf[i];
    if (r > 3) return;
    const g = groups.find(x => x.rank === r);
    if (g) g.players.push(p); else groups.push({ rank: r, players: [p] });
  });
  return groups;
}
const podiumRest = (rows, rankOf) =>
  rows.map((p, i) => ({ rank: rankOf[i], p })).filter(x => x.rank > 3);

function podiumHtml(rows, rankOf, COLS){
  const col = COLS.find(c => c.k === sortKey) || COLS[0];
  const groups = podiumGroups(rows, rankOf);
  const nameLink = p => `<a class="pl" data-p="${esc(p.name)}">${esc(p.name)}</a>`;
  // 단(stand)은 윗면(밝은 띠) + 앞면(금속 그라디언트 · 등수 숫자)으로 나눠 입체감을 준다.
  const step = g => !g ? '' : `<div class="step s${g.rank}">
      <div class="who">${g.players.map(nameLink).join('')}</div>
      <div class="val">${cell(g.players[0], col)}</div>
      <div class="stand"><div class="top"></div><div class="face">${g.rank}</div></div>
    </div>`;
  const byRank = r => groups.find(g => g.rank === r);
  // 2등 왼쪽 · 1등 가운데 · 3등 오른쪽
  const pod = `<div class="pod">${[byRank(2), byRank(1), byRank(3)].map(step).join('')}</div>
    <div class="podfloor"></div>`;

  const rest = podiumRest(rows, rankOf);
  const restHtml = !rest.length ? '' : `<div class="podrest">${rest.map(x => `
      <div class="pdrow"><span class="pd-rk">${x.rank}</span>
        <span class="pd-nm">${nameLink(x.p)}</span>
        <span class="pd-vl">${cell(x.p, col)}</span></div>`).join('')}</div>`;

  const saveBtn = `<div style="text-align:center;margin-top:18px">
      <button class="mbtn p-save">📷 이미지로 저장</button>
      <div class="sub p-save-msg" style="margin:8px 0 0;min-height:1.2em"></div>
    </div>`;
  return `<div class="podhead">${esc(col.t)}</div>${pod}${restHtml}${saveBtn}`;
}

/* ══ 포디움을 이미지로 ══
   DOM 캡처 라이브러리(html2canvas 등)를 쓰지 않고 캔버스에 직접 그린다. 외부 의존성이
   없어야 하고(오프라인·CSP), 화면 그대로가 아니라 제목·기간을 넣은 공유용 카드가 낫기 때문.
   색은 지금 테마의 CSS 변수를 그대로 읽어 와 화면과 같은 톤으로 맞춘다. */
const PODIUM_IMG = {
  W: 720, PAD: 40, GAP: 16,
  H1: 168, H2: 122, H3: 92,     // 1·2·3등 단 높이
  TOPBAR: 10,                   // 단 윗면 밝은 띠
  ROW: 46,                      // 4등 이하 한 줄
  MAXNAMES: 4                   // 한 단에 이름 최대 4명, 넘으면 '외 N명'
};
function podiumCanvas(rows, rankOf, COLS){
  const G = PODIUM_IMG;
  const col = COLS.find(c => c.k === sortKey) || COLS[0];
  const groups = podiumGroups(rows, rankOf);
  const rest = podiumRest(rows, rankOf);

  const rootCS = getComputedStyle(document.documentElement);
  const v = (n, d) => (rootCS.getPropertyValue(n) || '').trim() || d;
  const C = { bg:v('--card','#ffffff'), text:v('--text','#1a1d21'), muted:v('--muted','#6b7280'),
              line:v('--line','#e5e7eb'), chip:v('--bg','#f6f7f9') };
  // 금·은·동은 테마와 무관하게 고정 (화면 CSS 와 같은 값)
  const METAL = [ {top:'#ffeaa6', a:'#ffd75f', b:'#e0a112', num:'#8a5c00'},
                  {top:'#f0f3f6', a:'#dde2e8', b:'#aab2bd', num:'#525a65'},
                  {top:'#f6dcc4', a:'#e9bb92', b:'#c1854f', num:'#6d4520'} ];
  const FF = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const font = (w, s) => `${w} ${s}px ${FF}`;

  // 단 위에 올라가는 이름 줄 수 → 포디움 영역이 얼마나 높아야 하는지 결정한다
  const shown = g => Math.min(g.players.length, G.MAXNAMES) + (g.players.length > G.MAXNAMES ? 1 : 0);
  const maxNameLines = groups.length ? Math.max(...groups.map(shown)) : 0;
  const headH = 192;                                   // 제목 세 줄이 들어가는 영역
  const aboveH = maxNameLines * 30 + 52;               // 이름들 + 값 알약
  const floorY = headH + aboveH + G.H1;
  const restH = rest.length ? 22 + rest.length * G.ROW : 0;
  const H = Math.round(floorY + 18 + restH + 54);

  const S = 2;                                         // 2배로 그려서 선명하게
  const cv = document.createElement('canvas');
  cv.width = G.W * S; cv.height = H * S;
  const x = cv.getContext('2d');
  x.scale(S, S);
  x.textBaseline = 'alphabetic';

  const roundRect = (px, py, w, h, r) => {
    x.beginPath();
    if (x.roundRect) x.roundRect(px, py, w, h, r);
    else {  // roundRect 미지원 브라우저 대비
      x.moveTo(px+r, py); x.arcTo(px+w, py, px+w, py+h, r); x.arcTo(px+w, py+h, px, py+h, r);
      x.arcTo(px, py+h, px, py, r); x.arcTo(px, py, px+w, py, r); x.closePath();
    }
  };
  // 단은 윗모서리만 둥글다. 아래까지 둥글리면 바닥선에서 떠 보인다(화면 CSS 와 동일).
  const roundTopRect = (px, py, w, h, r) => {
    x.beginPath();
    x.moveTo(px, py + h);
    x.lineTo(px, py + r);
    x.quadraticCurveTo(px, py, px + r, py);
    x.lineTo(px + w - r, py);
    x.quadraticCurveTo(px + w, py, px + w, py + r);
    x.lineTo(px + w, py + h);
    x.closePath();
  };
  const text = (s, px, py, f, color, align) => {
    x.font = f; x.fillStyle = color; x.textAlign = align || 'left'; x.fillText(s, px, py);
  };
  // 길면 … 로 자른다 (이름이 길어도 칸을 넘지 않게)
  const clip = (s, f, max) => {
    x.font = f;
    if (x.measureText(s).width <= max) return s;
    let t = s;
    while (t.length > 1 && x.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  };

  x.fillStyle = C.bg; x.fillRect(0, 0, G.W, H);

  // ── 제목 (세 줄: 앱 이름 / 지표 / 조건). 줄 간격을 넉넉히 벌린다 ──
  const cx = G.W / 2;
  text('당동 기록실', cx, 64, font(700, 20), C.muted, 'center');
  text(col.t, cx, 128, font(800, 38), C.text, 'center');
  const parts = [rankMode === '통합' ? '통산 기준' : rankMode + '전'];
  if (clubOnly) parts.push(EVT_ICON + ' 정기전만');
  parts.push((rankFrom || rankTo) ? `${ddmy(rankFrom) || '처음'} ~ ${ddmy(rankTo) || '오늘'}` : '전체 기간');
  text(parts.join('  ·  '), cx, 172, font(500, 17), C.muted, 'center');

  // ── 시상대 ──
  const sw = (G.W - G.PAD*2 - G.GAP*2) / 3;
  const slot = [groups.find(g=>g.rank===2), groups.find(g=>g.rank===1), groups.find(g=>g.rank===3)];
  const single = slot.filter(Boolean).length === 1;
  slot.forEach((g, i) => {
    if (!g) return;
    const sx = single ? cx - sw/2 : G.PAD + i * (sw + G.GAP);
    const h = [G.H2, G.H1, G.H3][i];
    const m = METAL[g.rank - 1];

    // 단 (윗면 밝은 띠 + 앞면 그라디언트), 위쪽 모서리만 둥글게
    x.save();
    roundTopRect(sx, floorY - h, sw, h, 10); x.clip();
    x.fillStyle = m.top; x.fillRect(sx, floorY - h, sw, G.TOPBAR);
    const gr = x.createLinearGradient(0, floorY - h + G.TOPBAR, 0, floorY);
    gr.addColorStop(0, m.a); gr.addColorStop(1, m.b);
    x.fillStyle = gr; x.fillRect(sx, floorY - h + G.TOPBAR, sw, h - G.TOPBAR);
    x.restore();
    // 등수 숫자 (흰 그림자로 음각 느낌)
    x.save();
    x.fillStyle = 'rgba(255,255,255,.5)';
    x.font = font(800, 40); x.textAlign = 'center';
    x.fillText(String(g.rank), sx + sw/2, floorY - h + G.TOPBAR + 47);
    x.fillStyle = m.num;
    x.fillText(String(g.rank), sx + sw/2, floorY - h + G.TOPBAR + 46);
    x.restore();

    // 단 위: 값 알약 → 이름들 → 왕관
    const mid = sx + sw/2;
    let y = floorY - h - 18;
    const val = String(cell(g.players[0], col));
    x.font = font(700, 17);
    const vw = x.measureText(val).width + 22;
    x.fillStyle = C.chip; roundRect(mid - vw/2, y - 20, vw, 27, 14); x.fill();
    x.strokeStyle = C.line; x.lineWidth = 1; x.stroke();
    text(val, mid, y, font(700, 17), C.text, 'center');

    y -= 30;
    const names = g.players.slice(0, G.MAXNAMES).map(p => p.name);
    if (g.players.length > G.MAXNAMES) names.push(`외 ${g.players.length - G.MAXNAMES}명`);
    names.slice().reverse().forEach(n => {
      text(clip(n, font(700, 21), sw - 6), mid, y, font(700, 21), C.text, 'center');
      y -= 30;
    });
  });

  // 바닥선
  const fg = x.createLinearGradient(G.PAD, 0, G.W - G.PAD, 0);
  fg.addColorStop(0, 'rgba(0,0,0,0)'); fg.addColorStop(.12, C.line);
  fg.addColorStop(.88, C.line); fg.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = fg; roundRect(G.PAD, floorY, G.W - G.PAD*2, 4, 2); x.fill();

  // ── 4등 이하 ──
  let ry = floorY + 22;
  rest.forEach(item => {
    const cyc = ry + G.ROW/2;
    x.fillStyle = C.chip; x.beginPath(); x.arc(G.PAD + 16, cyc, 16, 0, Math.PI*2); x.fill();
    x.strokeStyle = C.line; x.lineWidth = 1; x.stroke();
    text(String(item.rank), G.PAD + 16, cyc + 6, font(700, 16), C.muted, 'center');
    const vs = String(cell(item.p, col));
    x.font = font(700, 19);
    const vw = x.measureText(vs).width;
    text(clip(item.p.name, font(600, 19), G.W - G.PAD*2 - 60 - vw - 20), G.PAD + 44, cyc + 7, font(600, 19), C.text);
    text(vs, G.W - G.PAD, cyc + 7, font(700, 19), C.text, 'right');
    x.fillStyle = C.line; x.fillRect(G.PAD, ry + G.ROW - 1, G.W - G.PAD*2, 1);
    ry += G.ROW;
  });

  text(todayYmd().replace(/-/g, '.') + ' 기준', cx, H - 26, font(500, 15), C.muted, 'center');
  return cv;
}

/* 저장 — 기기마다 '갤러리에 넣는' 방법이 다르다.
 *
 *  안드로이드: 바로 내려받는다. 크롬이 받은 이미지는 미디어 스캔을 타서 갤러리의
 *    '다운로드' 앨범에 바로 뜬다. 공유 시트를 거치면 앱을 한 번 더 골라야 해서 건너뛴다.
 *    (웹앱이 DCIM·Pictures 폴더에 직접 쓸 방법은 없다 — 안드로이드 자체 제약이라
 *     '다운로드' 앨범에 들어가는 것이 웹에서 갈 수 있는 최선이다)
 *  iOS: 홈 화면 앱에서 a[download] 가 동작하지 않으므로 공유 시트로 보낸다.
 *    시트의 '이미지 저장'을 누르면 사진 앱에 들어간다.
 *  그 외(데스크톱 등): 그냥 내려받기.
 */
async function savePodiumImage(cv, metricName, msgEl){
  const say = (t, err) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = err ? '#f44336' : 'var(--muted)'; } };
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if (!blob) { say('이미지를 만들지 못했습니다.', true); return; }
  const fname = `당동_${metricName}_${todayYmd()}.png`.replace(/\s+/g, '');
  const file = new File([blob], fname, { type: 'image/png' });

  const isAndroid = /Android/i.test(navigator.userAgent);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));

  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  if (isAndroid || !canShare) {
    try {
      download();
      say(isAndroid ? '갤러리에 저장했습니다. (다운로드 앨범)' : '저장했습니다.');
      return;
    } catch(e){
      if (!canShare) { say('저장에 실패했습니다.', true); return; }
      // 내려받기가 막힌 안드로이드 → 아래 공유 시트로 넘어간다
    }
  }
  try { await navigator.share({ files: [file] }); say(''); }
  catch(e){
    if (e && e.name === 'AbortError') { say(''); return; }   // 사용자가 취소
    say('저장에 실패했습니다.', true);
  }
}

function renderRank(){
  const COLS = colsFor(rankMode);
  if(!COLS.some(c=>c.k===sortKey)) sortKey = defSort(rankMode);
  // 포디움은 올릴 수 있는 지표가 정해져 있다. 표에서 다른 열로 정렬해 둔 채 넘어왔으면
  // (이름순 포함) 그 모드의 기본 지표로 되돌린다.
  if(rankView==='podium' && !PODIUM_KEYS.includes(sortKey)){ sortKey = defSort(rankMode); sortAsc = bestIsLow(sortKey); }
  const rows = rankRows(rankMode).sort((a,b)=>{
    let x=a[sortKey], y=b[sortKey], r;
    if(x==null && y==null) r = 0;
    else if(x==null) return 1;    // 값이 없는 사람은 정렬 방향과 무관하게 항상 아래로
    else if(y==null) return -1;
    else if(typeof x==='string') r = x.localeCompare(y,'ko');
    else r = x-y;
    if(r !== 0) return sortAsc ? r : -r;
    // 동점자끼리의 줄 순서 — 정렬 방향을 따라가면 안 된다(내림차순일 때 에버 낮은 사람이
    // 위로 올라오던 문제). 항상 에버리지 높은 쪽을 위에 둔다. 등수는 어차피 공동이다.
    return (b.avgAvg||0)-(a.avgAvg||0);
  });

  // 공동 등수 — 정렬 기준 열의 값이 같으면 같은 등수. 표준 경쟁 순위라 공동 2등이 둘이면
  // 다음은 4등이다. 값 비교는 정렬 기준 열만 본다(동점 안에서 에버리지로 줄만 세운 것이지
  // 그게 등수를 가르지는 않는다). 값이 둘 다 없으면(—) 그것도 같은 값으로 친다.
  const sameRank = (a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null || y == null) return x == null && y == null;
    return x === y;
  };
  const rankOf = [];
  rows.forEach((p, i) => { rankOf[i] = (i > 0 && sameRank(p, rows[i-1])) ? rankOf[i-1] : i + 1; });
  
  const modeSel = `<select class="field p-mode" style="flex:0 0 auto; width:84px; height:34px; padding:0 26px 0 8px; font-size:0.9rem; border-radius:8px; margin:0;">` +
    MODE_TABS.map(m => `<option value="${m}" ${m===rankMode?'selected':''}>${m}</option>`).join('') +
    `</select>`;

  const head = COLS.map(c=>{
    const on = c.k===sortKey;
    const ar = on ? (sortAsc?'▲':'▼') : '↕';
    return `<th class="${on?'on':''} ${c.txt?'name':''}" data-k="${c.k}">${c.t} <span class="ar">${ar}</span></th>`;
  }).join('');
  let inner;
  if(rows.length===0){
    inner = `<div class="empty">아직 ${rankMode==='통합'?'':rankMode+'전 '}기록이 없습니다</div>`;
  } else if(rankView==='podium'){
    inner = podiumHtml(rows, rankOf, COLS);
  } else {
    // 이름순 정렬은 성적 순위가 아니므로 메달도 등수도 아닌 그냥 줄 번호
    const ranked = sortKey !== 'name';
    const body = rows.map((p,i)=>{
      const rk = rankOf[i];
      const medal = !ranked ? (i+1) : (['🥇','🥈','🥉'][rk-1] || rk);
      const tds = COLS.map(c=>{
        if(c.k==='name') return `<td class="name"><a class="pl" data-p="${esc(p.name)}">${esc(p.name)}</a></td>`;
        return `<td>${cell(p, c)}</td>`;
      }).join('');
      return `<tr><td class="rk">${medal}</td>${tds}</tr>`;
    }).join('');
    inner = `<div class="scroll"><table class="rank"><thead><tr><th class="rk"></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  // 지표 선택 — 포디움엔 누를 표 제목이 없으므로 셀렉트로 고른다.
  const metricSel = rankView!=='podium' ? '' :
    `<select class="field p-metric" style="width:100%; height:32px; padding:0 26px 0 10px; font-size:0.85rem; border-radius:999px; margin:6px 0 0;">` +
    podiumCols(COLS).map(c=>`<option value="${c.k}" ${c.k===sortKey?'selected':''}>${esc(c.t)}</option>`).join('') +
    `</select>`;
  const viewBtns = `<div class="seg">
      <button class="p-view ${rankView==='table'?'on':''}" data-v="table">표</button>
      <button class="p-view ${rankView==='podium'?'on':''}" data-v="podium">포디움</button>
    </div>`;

  const note = rankView==='podium' ? '지표를 고르면 그 기준으로 세웁니다.'
    : (rankMode==='3인'||rankMode==='4인')
      ? '표 제목을 누르면 정렬됩니다. · <b>평균순위</b>는 동순위를 분수로 계산합니다(공동 2등 = 2.5등).'
      : '표 제목을 누르면 그 기준으로 정렬됩니다.';
  // 공동 등수 안내는 어느 모드에서나 필요하다 (이름순은 등수가 아니라 줄 번호라 제외)
  const rankNote = sortKey === 'name' ? '' :
    ' · 정렬 기준 값이 같으면 <b>공동 등수</b>입니다 (공동 2등이 둘이면 다음은 4등).';
  const el = $(`<div class="card">
      <div style="margin-bottom:14px;">
        ${rangeRowHtml('p-period', rankFrom, rankTo, modeSel)}
        <div class="toolrow">${viewBtns}${eventRowHtml('p-period')}</div>
        ${metricSel}
      </div>
      ${inner}
      <div class="sub" style="margin:10px 0 0">${note}${rankNote}</div></div>`);
  bindRangePicker(el, 'p-period', { max: todayYmd(), allowClear: true, aria: '조회 기간' });

  const refreshRankSub = () => {
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
  };
  const applyRankRange = () => {
    rankFrom = el.querySelector('.p-period-from').value;
    rankTo = el.querySelector('.p-period-to').value;
    DATA = getFilteredData();
    refreshRankSub();
    show('rank');
  };
  el.querySelector('.p-period-from').onchange = applyRankRange;
  el.querySelector('.p-period-to').onchange = applyRankRange;
  bindEventSel(el, 'p-period', () => { DATA = getFilteredData(); refreshRankSub(); show('rank'); });

  el.querySelector('.p-mode').onchange = (e) => {
    rankMode = e.target.value;
    sortKey = defSort(rankMode);
    sortAsc = false;
    show('rank');
  };
  el.querySelectorAll('.p-view').forEach(b => b.onclick = () => {
    rankView = b.dataset.v;
    show('rank');
  });
  const saveEl = el.querySelector('.p-save');
  if (saveEl) saveEl.onclick = async () => {
    const msg = el.querySelector('.p-save-msg');
    saveEl.disabled = true;
    if (msg) { msg.textContent = '이미지 만드는 중...'; msg.style.color = 'var(--muted)'; }
    try {
      const col = COLS.find(c => c.k === sortKey) || COLS[0];
      await savePodiumImage(podiumCanvas(rows, rankOf, COLS), col.t, msg);
    } catch(err){
      if (msg) { msg.textContent = '저장 실패: ' + err.message; msg.style.color = '#f44336'; }
    }
    saveEl.disabled = false;
  };
  const metricEl = el.querySelector('.p-metric');
  if (metricEl) metricEl.onchange = () => {
    sortKey = metricEl.value;
    sortAsc = bestIsLow(sortKey);   // 고른 지표에서 잘한 사람이 1등이 되도록
    show('rank');
  };
  el.querySelectorAll('th[data-k]').forEach(th=>th.onclick=()=>{
    const k = th.dataset.k;
    // 낮을수록 좋은 지표(순위·파울률·기복)는 첫 클릭에 오름차순 — 잘한 사람이 위로 오게
    if(k===sortKey) sortAsc=!sortAsc; else { sortKey=k; sortAsc = (k==='name' || bestIsLow(k)); }
    show('rank');
  });
  el.querySelectorAll('a.pl').forEach(a=>a.onclick=()=>showPlayer(a.dataset.p));
  return el;
}

/* 순위표 이름 열을 왼쪽에 고정할 때 쓸 오프셋 — 순위 칸의 실제 폭을 재서 --rkw 로 넘긴다.
   메달 이모지 폭이 기기·폰트마다 달라(34px 아님) CSS 상수로 두면 열이 어긋난다.
   DOM 에 붙은 뒤라야 잴 수 있으므로 show() 끝과 창 크기 변경 때 호출한다. */
function syncRankSticky(){
  document.querySelectorAll('table.rank').forEach(tb=>{
    const rk = tb.querySelector('thead th.rk');
    if(rk) tb.style.setProperty('--rkw', rk.getBoundingClientRect().width + 'px');
  });
}
window.addEventListener('resize', syncRankSticky);

function chart(vals, labels, opt){
  opt = opt || {};
  if(vals.length<2) return '<div class="empty">경기 2개 이상부터 그래프가 표시됩니다</div>';
  const dec = opt.dec==null ? 2 : opt.dec;
  const suf = opt.suffix || '';
  const fmt = v => (+v.toFixed(dec)) + suf;

  const availW = Math.max(260, Math.round(opt.W || 680));
  const H = opt.H || (availW < 420 ? 300 : availW < 560 ? 270 : 240);
  const P = {t:20, r:14, b:34, l:44};

  const MIN_GAP = 46;
  const needW = P.l + P.r + MIN_GAP*(vals.length-1);
  const W = Math.max(availW, needW);

  const iw=W-P.l-P.r, ih=H-P.t-P.b;
  const isInv = opt.invert || false;
  const min = opt.min != null ? opt.min : (isInv ? Math.min(...vals)*0.9 : 0);
  const max = opt.max != null ? opt.max : (Math.max(...vals)*1.15 || 1);
  const range = max - min || 1;

  const x = i => P.l + (vals.length===1?iw/2:iw*i/(vals.length-1));
  const y = v => isInv ? P.t + ((v - min)/range)*ih : P.t + ih - ((v - min)/range)*ih;

  const gap = iw/(vals.length-1);
  const showVal = gap >= 36;
  const xStep = Math.max(1, Math.ceil(34/gap));

  let g='';
  for(let i=0;i<=4;i++){
    const yy=P.t+ih*i/4;
    const v = isInv ? min + (range*i/4) : min + (range*(4-i)/4);
    g+=`<line x1="${P.l}" y1="${yy}" x2="${W-P.r}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>`;
    g+=`<text x="${P.l-8}" y="${yy+4}" fill="var(--muted)" font-size="11" text-anchor="end">${fmt(v)}</text>`;
  }
  const pts = vals.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  const dots = vals.map((v,i)=>{
    const c = `<circle cx="${x(i)}" cy="${y(v)}" r="${showVal?4:3}" fill="var(--accent)"/>`;
    if(!showVal) return c;
    return c + `<text x="${x(i)}" y="${y(v)-10}" fill="var(--text)" font-size="11" text-anchor="middle">${fmt(v)}</text>`;
  }).join('');
  const xs = labels.map((l,i)=> i%xStep===0 ?
    `<text x="${x(i)}" y="${H-12}" fill="var(--muted)" font-size="10" text-anchor="middle">${esc(l)}</text>`:'').join('');
  return `<div class="cscroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round"/>${dots}${xs}</svg></div>`;
}

const METRICS = [
  {k:'avg', t:'에버리지', modes:MODE_TABS, dec:2},
  {k:'streak', t:'평균 타수', modes:MODE_TABS, dec:2},
  {k:'hit', t:'득점률', modes:MODE_TABS, max:100, suffix:'%', dec:0},
  {k:'adj', t:'보정 승률', modes:MODE_TABS, max:100, suffix:'%', dec:1},
  {k:'games', t:'경기수', modes:MODE_TABS, dec:0},
  {k:'cush', t:'쿠션 성공률', modes:MODE_TABS, max:100, suffix:'%', dec:0},
  {k:'hr', t:'하이런', modes:MODE_TABS, dec:0},
  {k:'winRate', t:'승률', modes:['2인','팀전'], max:100, suffix:'%', dec:0},
  {k:'avgRank', t:'평균 순위', modes:['3인','4인'], dec:1, invert:true, min:1, max:4}
];

function calcStatsForHistory(h) {
  let games = h.length;
  let wins = h.filter(r => r.win).length;
  let fBallInn = 0, fMiss = 0, fGross = 0;   // 파울이 기록된 경기만 (평균 타수용)
  let sumInnings = 0, sumBallInn = 0, sumScore = 0, totalMisses = 0, maxHr = 0, cushMade = 0, cushInn = 0, sumTime = 0, sumShots = 0, sumAdjPt = 0, rankSum = 0;
  const avgs = [];   // 경기별 에버리지 (기복 계산용)

  h.forEach(r => {
    sumInnings += (r.inning || 0);      // 총 이닝 — 인터벌용
    sumBallInn += (r.ballInn || 0);     // 알 이닝 — 에버·득점률·평균타수용
    sumScore += (r.score || 0);
    if (r.foul != null) { fBallInn += (r.ballInn || 0); fMiss += (r.miss || 0); fGross += (r.score || 0) + r.foul; }
    totalMisses += (r.miss || 0);
    if ((r.highRun || 0) > maxHr) maxHr = r.highRun;
    cushMade += (r.cushMade || 0);
    cushInn += (r.cushInn || 0);
    sumAdjPt += (r.adjPt || 0);
    rankSum += (r.rank || 0);
    if (r.ballInn > 0) avgs.push(r.score / r.ballInn);
    if (r.timeMs > 0) {
      sumTime += r.timeMs;
      sumShots += Math.max(1, r.score + r.inning);
    }
  });

  return {
    games,
    wins,
    winRate: games > 0 ? (wins / games) * 100 : 0,
    avgAvg: sumBallInn > 0 ? (sumScore / sumBallInn) : 0,
    bestHr: maxHr,
    hitRate: sumBallInn > 0 ? ((sumBallInn - totalMisses) / sumBallInn) * 100 : 0,
    streakAvg: (fBallInn - fMiss) > 0 ? (fGross / (fBallInn - fMiss)) : null,
    cushRate: cushInn > 0 ? (cushMade / cushInn) * 100 : null,
    avgInterval: sumShots > 0 ? (sumTime / sumShots) / 1000 : null,
    volatility: volatilityPct(avgs),
    avgRank: games > 0 ? (rankSum / games) : null,
    adjRate: games > 0 ? (sumAdjPt / games) : 0
  };
}

// ══ 플레이 성향(MBTI식 4축) — 소속 팀 전체와 비교한 상대 위치로 계산 ══
// 축마다 원지표를 팀 모집단 기준 z-score 로 바꾼 뒤, ±2σ 를 막대 끝으로 매핑한다.
function computeTendency(name){
  const full = getFullProcessData();           // 통산(기간 필터 없음) 기준 (메모이제이션 적용)
  const pool = full.players.filter(p => p.games >= 3);        // 비교 모집단(게스트 포함, 최소 3경기)
  const target = full.players.find(p => p.name === name);

  const LABELS = [
    { L:'단타', R:'장타' },   // ① 득점률 대비 연타
    { L:'쿠션', R:'알' },     // ② 마무리 쿠션 성공 에버 ÷ 에버리지
    { L:'안정', R:'기복' },   // ③ 경기별 에버리지 변동계수
    { L:'오픈', R:'디펜스' }  // ④ 다음 차례(상대) 에버리지 변화(높일수록 오픈)
  ];
  const blank = () => ({ ready:false, axes: LABELS.map(a => ({ ...a, pos:0, ok:false })) });
  if (!target || target.games < 4 || pool.length < 3) return blank();

  // 선수별 원지표
  const metricsOf = p => {
    let sMade = 0, sCushInn = 0; const avgs = [];
    for (const h of p.history){
      sMade += (h.cushMade||0); sCushInn += (h.cushInn||0);
      if (h.ballInn > 0) avgs.push(h.score / h.ballInn);   // 경기별 에버리지
    }
    // ② 쿠션↔알: 마무리 쿠션 성공 에버 ÷ 전체 에버리지 (쿠션 1·2개 게임 보정)
    const cushRatio = (sCushInn > 0 && p.avgAvg > 0) ? (sMade / sCushInn) / p.avgAvg : null;
    // ③ 안정↔기복: 경기별 에버리지의 변동계수(표준편차 ÷ 평균)
    let volatility = null;
    if (avgs.length >= 2){
      const m = avgs.reduce((a,b)=>a+b,0) / avgs.length;
      if (m > 0){
        const sd = Math.sqrt(avgs.reduce((a,b)=>a+(b-m)**2,0) / avgs.length);
        volatility = sd / m;
      }
    }
    return {
      streak: p.streakAvg,   // 평균 타수
      hit:    p.hitRate,     // 득점률
      cushRatio,             // 쿠션 마무리 상대 효율
      volatility             // 에버리지 변동계수
    };
  };

  // ④ 오픈↔디펜스: '내 바로 다음 차례' 선수가 그 경기에서 평소보다 잘 쳤나(오픈) 못 쳤나(디펜스).
  // 저장된 선수 배열 = 좌석/턴 순서라 다음 사람 = players[(i+1)%N]. 다음 사람의 모든 이닝은 내가 남긴
  // 자리에서 시작하므로 게임 방식 무관(팀전 포함). 지표 = (다음 사람 그 경기 에버리지 − 그의 통산 에버리지) 평균.
  const avgEver = {};                           // 이름 → 통산 에버리지
  for (const p of full.players) avgEver[p.name] = p.avgAvg;
  const defAcc = {};                            // 이름 → { sum, n }
  for (const g of full.games){
    const P = g.players || [];
    const N = P.length;
    if (N < 2) continue;
    for (let i = 0; i < N; i++){
      const me = P[i], nx = P[(i + 1) % N];
      const nxEver = nx.ballInn > 0 ? nx.score / nx.ballInn : null;
      const nxAvg = avgEver[nx.name];
      if (nxEver == null || nxAvg == null) continue;
      const a = defAcc[me.name] || (defAcc[me.name] = { sum: 0, n: 0 });
      a.sum += (nxEver - nxAvg); a.n++;
    }
  }
  const defenseOf = p => { const a = defAcc[p.name]; return (a && a.n > 0) ? a.sum / a.n : null; };

  const poolM = pool.map(p => ({ ...metricsOf(p), defense: defenseOf(p) }));
  const stat = key => {
    const xs = poolM.map(m => m[key]).filter(v => v != null && !isNaN(v));
    if (xs.length < 2) return null;
    const mean = xs.reduce((a,b) => a+b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a,b) => a + (b-mean)**2, 0) / xs.length);
    return { mean, sd };
  };
  const S = { streak:stat('streak'), hit:stat('hit'), cushRatio:stat('cushRatio'),
              volatility:stat('volatility'), defense:stat('defense') };
  const z = (key, val) => (S[key] && S[key].sd > 0 && val != null) ? (val - S[key].mean) / S[key].sd : null;

  const tM = { ...metricsOf(target), defense: defenseOf(target) };

  // ① 단타-장타: 팀 기준 z(연타) − z(득점률) 를 다시 팀 기준으로 표준화
  const comp = poolM.map(m => {
    const zs = z('streak', m.streak), zh = z('hit', m.hit);
    return (zs != null && zh != null) ? zs - zh : null;
  }).filter(v => v != null);
  const cMean = comp.length ? comp.reduce((a,b)=>a+b,0) / comp.length : 0;
  const cSd = comp.length ? Math.sqrt(comp.reduce((a,b)=>a+(b-cMean)**2,0) / comp.length) : 0;
  const zsT = z('streak', tM.streak), zhT = z('hit', tM.hit);
  const compT = (zsT != null && zhT != null) ? zsT - zhT : null;
  const zBalance = (compT != null && cSd > 0) ? (compT - cMean) / cSd : null;

  const clamp = v => Math.max(-1, Math.min(1, v));
  const pos = (zz, dir) => zz == null ? null : clamp(zz / 2) * dir;   // ±2σ → 막대 끝

  const raw = [
    pos(zBalance, 1),                        // 높을수록 장타(오른쪽)
    pos(z('cushRatio', tM.cushRatio), -1),   // 마무리 쿠션 잘할수록 쿠션(왼쪽)
    pos(z('volatility', tM.volatility), 1),  // 변동 클수록 기복(오른쪽)
    pos(z('defense',  tM.defense),  -1)      // 상대 득점↑일수록 오픈(왼쪽)
  ];
  return {
    ready: true,
    axes: LABELS.map((a, i) => ({ ...a, ok: raw[i] != null, pos: raw[i] == null ? 0 : raw[i] }))
  };
}

function renderTendency(name){
  const t = computeTendency(name);
  const rows = t.axes.map(a => {
    const pct = ((a.pos + 1) / 2 * 100).toFixed(1);
    const side = !a.ok ? '' : (a.pos < -0.15 ? 'L' : a.pos > 0.15 ? 'R' : '');
    return `<div>
      <div class="tlab"><span class="${side==='L'?'on':''}">${a.L}</span><span class="${side==='R'?'on':''}">${a.R}</span></div>
      <div class="ttrack"><div class="tmid"></div><div class="tdot ${a.ok?'':'off'}" style="left:${a.ok?pct:'50'}%"></div></div>
    </div>`;
  }).join('');
  const note = t.ready
    ? '소속 팀 전체와 비교한 상대적 성향이에요 · 통산 기록 기준'
    : '기록이 더 쌓이면 표시됩니다.';
  return `<div class="card">
    <h3 style="font-size:1rem;margin:0 0 4px">🧭 플레이 성향</h3>
    <div class="sub" style="margin:0 0 16px">${note}</div>
    <div class="tend">${rows}</div>
  </div>`;
}

function showPlayer(name){
  stopHome();   // 홈 카드에서 이름을 눌러 들어온 경우 — show() 를 안 거치므로 여기서 끊는다
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const auth = getAuth();
  if(auth && name === auth.name) {
    const btn = document.getElementById('btnMyRec');
    if(btn) btn.classList.add('on');
  }
  let p = DATA.players.find(v=>v.name===name);
  if (!p) p = { name, id: null, handicap: 0, total_games: 0, win_rate: 0, avg: 0, hr: 0 };
  let playerMode = '통합';
  let chartCur = 'avg';
  let playerFrom = rankFrom;
  let playerTo = rankTo;

  const el = $(`<div>
    <button class="back">← 순위로</button>
    <div class="card">
      <h2 style="margin:0">${esc(p.name)}</h2>
      <div class="sub" style="margin:2px 0 10px">수지 ${p.handicap * 10}</div>
      <div style="margin-bottom:12px;">
        ${rangeRowHtml('pd-period', playerFrom, playerTo, `<select class="field ptab" style="flex:0 0 auto; width:84px; height:34px; padding:0 26px 0 8px; font-size:0.9rem; border-radius:8px; margin:0;">
            ${MODE_TABS.map(m=>`<option value="${m}" ${m===playerMode?'selected':''}>${m}</option>`).join('')}
          </select>`)}
      </div>
      <div class="stats" id="pStats"></div>
      <div id="chartArea">
        <div class="chead" style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:4px;">
          <div style="flex:1;">
            <h3 style="font-size:1rem;margin:0 0 6px 0">📈 추이</h3>
            <select id="pMetricSel" class="field" style="width:140px; padding:6px; font-size:0.9rem"></select>
          </div>
        </div>
        <div class="sub" id="cdesc" style="margin:0 0 6px"></div>
        <div id="cbox"></div>
      </div>
    </div>
    <div id="tendArea"></div>
    <div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🗒️ 경기 이력</h3>
      <div class="scroll"><table>
        <thead><tr><th class="name">날짜</th><th class="name">상대</th><th>점수</th>
          <th>알이닝</th><th>에버</th><th>하이런</th><th>결과</th></tr></thead>
        <tbody id="pHist"></tbody></table></div></div>
  </div>`);

  el.querySelector('.back').onclick=()=>show('rank');
  el.querySelector('#tendArea').innerHTML = renderTendency(p.name);
  bindRangePicker(el, 'pd-period', { max: todayYmd(), allowClear: true, aria: '조회 기간' });
  let lastW = 0;

  const renderMode = () => {
    let hPeriod = [...p.history];
    if (playerFrom || playerTo) {
      hPeriod = hPeriod.filter(r => inRange(r.date, playerFrom, playerTo));
    }

    const h = playerMode === '통합' ? hPeriod : hPeriod.filter(r => r.type === playerMode);

    if (h.length === 0) {
      el.querySelector('#pStats').innerHTML = '<div class="empty" style="width:100%; text-align:center; padding: 20px 0; color:var(--muted)">이 기간 동안 치러진 경기가 없습니다.</div>';
      el.querySelector('#chartArea').style.display = 'none';
      el.querySelector('#pHist').innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">기록 없음</td></tr>';
      return;
    }

    const COLS = colsFor(playerMode).filter(c => c.k !== 'name' && c.k !== 'handicap');
    const stObj = calcStatsForHistory(h);
    
    let statsHtml = '';
    COLS.forEach(c => {
      statsHtml += `<div class="st"><div class="k">${c.t}</div><div class="v">${cell(stObj, c)}</div></div>`;
    });
    el.querySelector('#pStats').innerHTML = statsHtml;

    el.querySelector('#pHist').innerHTML = [...h].reverse().map(r=>`<tr onclick="showGame('${r.id}')" style="cursor:pointer">
      <td class="name">${esc(r.date)}</td><td class="name">${esc(r.opponents)}</td>
      <td>${r.score}</td><td>${r.ballInn}</td><td>${+r.average.toFixed(3)}</td>
      <td>${r.highRun}</td><td>${r.win?'<span class="win">🏆</span>':'—'}</td></tr>`).join('');

    el.querySelector('#chartArea').style.display = 'block';

      const availableMetrics = METRICS.filter(m => m.modes.includes(playerMode));
      el.querySelector('#pMetricSel').innerHTML = availableMetrics.map(m => `<option value="${m.k}">${m.t}</option>`).join('');
      
      if (!availableMetrics.find(m => m.k === chartCur)) {
        chartCur = availableMetrics[0].k;
      }
      el.querySelector('#pMetricSel').value = chartCur;

      el.querySelector('#pMetricSel').onchange = (e) => {
        chartCur = e.target.value;
        const currentH = playerMode === '통합' ? [...hPeriod] : hPeriod.filter(r => r.type === playerMode);
        draw(chartCur, currentH);
      };

      draw(chartCur, h);
  };

  const draw = (key, h) => {
    chartCur = key;
    const m = METRICS.find(v=>v.k===key);
    const box = el.querySelector('#cbox');
    lastW = box.clientWidth || innerWidth-64;

    const hAsc = [...h].reverse();
    const groups = {}; 
    
    hAsc.forEach(r => {
      const gKey = r.date.substring(5, 10);   // 일별(MM-DD)로 통일
      if (!groups[gKey]) groups[gKey] = { games: 0, sumInning: 0, sumScore: 0, sumMiss: 0, fBallInn: 0, fMiss: 0, fGross: 0, sumAdjPt: 0, maxHr: 0, cushMade: 0, cushInn: 0, wins: 0, rankSum: 0 };
      groups[gKey].games++;
      groups[gKey].sumInning += (r.ballInn || 0);   // 차트 지표(에버·평균타수·득점률)는 모두 알 이닝 기준
      groups[gKey].sumScore += (r.score || 0);
      if (r.foul != null) {   // 평균 타수는 파울이 기록된 경기만
        groups[gKey].fBallInn += (r.ballInn || 0);
        groups[gKey].fMiss += (r.miss || 0);
        groups[gKey].fGross += (r.score || 0) + r.foul;
      }
      groups[gKey].sumMiss += (r.miss || 0);
      groups[gKey].sumAdjPt += (r.adjPt || 0);
      if ((r.highRun || 0) > groups[gKey].maxHr) groups[gKey].maxHr = r.highRun;
      if (r.cushInn > 0) {
         groups[gKey].cushMade += (r.cushMade || 0);
         groups[gKey].cushInn += r.cushInn;
      }
      if (r.win) groups[gKey].wins++;
      if (r.rank) groups[gKey].rankSum += r.rank;
    });

    const allLabels = Object.keys(groups);
    const rawVals = allLabels.map(lbl => {
      const g = groups[lbl];
      if (key === 'avg') return g.sumInning ? g.sumScore / g.sumInning : 0;
      if (key === 'streak') return (g.fBallInn - g.fMiss) > 0 ? g.fGross / (g.fBallInn - g.fMiss) : null;
      if (key === 'hit') return g.sumInning ? (g.sumInning - g.sumMiss) / g.sumInning * 100 : 0;
      if (key === 'adj') return g.games ? g.sumAdjPt / g.games : 0;
      if (key === 'games') return g.games;
      if (key === 'hr') return g.maxHr;
      if (key === 'cush') return g.cushInn ? (g.cushMade / g.cushInn) * 100 : 0;
      if (key === 'winRate') return g.games ? (g.wins / g.games) * 100 : 0;
      if (key === 'avgRank') return g.games ? (g.rankSum / g.games) : 0;
      return 0;
    });
    // 값이 없는 날은 점 자체를 뺀다 (평균 타수는 파울이 기록된 경기가 없는 날엔 계산 불가)
    const labels = allLabels.filter((_, i) => rawVals[i] != null);
    const vals = rawVals.filter(v => v != null);

    box.innerHTML = chart(vals, labels, {...m, W: lastW});
    
    const groupText = '일별';
    let desc = m.t;
    if (key === 'avg') desc = `해당 ${groupText} 평균 에버리지 (총 득점 / 알 이닝)`;
    else if (key === 'streak') desc = `해당 ${groupText} 평균 타수 (파울 차감 전 득점 / 득점한 알 이닝)`;
    else if (key === 'hit') desc = `해당 ${groupText} 평균 득점률 (알 이닝 중 점수를 낸 이닝 비율)`;
    else if (key === 'adj') desc = `해당 ${groupText} 평균 보정 승률`;
    else if (key === 'games') desc = `해당 ${groupText} 총 경기수`;
    else if (key === 'hr') desc = `해당 ${groupText} 최고 하이런`;
    else if (key === 'cush') desc = `해당 ${groupText} 쿠션 성공률`;
    else if (key === 'winRate') desc = `해당 ${groupText} 평균 승률`;
    else if (key === 'avgRank') desc = `해당 ${groupText} 평균 순위`;

    el.querySelector('#cdesc').textContent = desc;
    const sc = box.querySelector('.cscroll');
    if(sc && sc.scrollWidth > sc.clientWidth){
      sc.scrollLeft = sc.scrollWidth;
      box.insertAdjacentHTML('beforeend', '<div class="chint">← 옆으로 밀면 지난 경기를 볼 수 있어요</div>');
    }
  };

  const applyPlayerRange = () => {
    playerFrom = el.querySelector('.pd-period-from').value;
    playerTo = el.querySelector('.pd-period-to').value;
    syncRangeDisp(el, 'pd-period');
    renderMode();
  };
  el.querySelector('.pd-period-from').onchange = applyPlayerRange;
  el.querySelector('.pd-period-to').onchange = applyPlayerRange;

  el.querySelector('.ptab').onchange = (e) => {
    playerMode = e.target.value;
    renderMode();
  };

  if (IS_ADMIN && p.id) {
    const adm = $(`<div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🛠 관리자: 선수 정보 수정</h3>
      <div class="sub" style="margin:0 0 8px">이름을 바꾸면 순위·기록에 새 이름으로 표시됩니다. 수지는 저장값 기준입니다 (예: 15 = 수지 150).</div>
      <input id="admName" class="field" maxlength="10" value="${esc(p.name)}" placeholder="이름">
      <input id="admHd" class="field" type="number" value="${p.handicap ?? ''}" placeholder="수지 저장값 (예: 15)">
      <button class="mbtn on" id="admSave">저장</button>
    </div>`);
    adm.querySelector('#admSave').onclick = async e => {
      const name = adm.querySelector('#admName').value.trim();
      const hd = parseInt(adm.querySelector('#admHd').value, 10);
      if (!name) return alert('이름을 입력하세요');
      e.target.disabled = true;
      try {
        if (!p.id) throw new Error('계정이 없는 선수(직접 입력)는 이름을 바꿀 수 없어요');
        await adminApi.renamePlayer(p.id, name, isNaN(hd) ? null : hd);   // 프로필 + 모든 경기 이름 갱신
        await reloadData();
        alert('선수 정보가 수정되었습니다.');
        showPlayer(name);
      } catch(err){ alert('수정 실패: ' + (/not_authorized|not_authenticated/.test(err.message) ? NO_PERM : err.message)); e.target.disabled = false; }
    };
    el.appendChild(adm);
  }
  document.getElementById('view').replaceChildren(el);
  renderMode();

  chartRO = new ResizeObserver(es=>{ 
    const w = es[0].contentRect.width; 
    if(Math.abs(w - lastW) > 2) {
      let hPeriod = [...p.history];
      if (playerFrom || playerTo) {
        hPeriod = hPeriod.filter(r => inRange(r.date, playerFrom, playerTo));
      }
      const h = playerMode === '통합' ? hPeriod : hPeriod.filter(r => r.type === playerMode);
      draw(chartCur, h); 
    }
  });
  chartRO.observe(el.querySelector('#cbox'));
  scrollTo(0,0);
}

function renderMe() {
  const auth = getAuth();
  const d = document.createElement('div');
  if (!auth) {
    d.innerHTML = `<div style="padding:16px 0 8px; text-align:center;">
      <p style="margin:0 0 24px 0; color:var(--text); opacity:0.8;">내 정보를 설정하려면 로그인이 필요합니다.</p>
      <a href="../score/" class="bigbtn" style="display:inline-block; text-decoration:none; box-sizing:border-box;">점수판으로 가서 로그인</a>
    </div>`;
    return d;
  }
  d.innerHTML = `<div>
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; opacity:0.8;">이름</label>
    <input type="text" id="meName" class="field" placeholder="당신의 이름">
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; opacity:0.8;">수지 (목표 점수)</label>
    <select id="meHandicap" class="field">
      <option value="">선택하세요</option>
      ${[50, 80, 100, 120, 150, 200, 250, 300, 400, 500].map(v => `<option value="${v/10}">${v}</option>`).join('')}
    </select>
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; margin-top:12px; opacity:0.8;">비밀번호 변경 (변경할 때만 입력)</label>
    <input type="password" id="mePwd" class="field" placeholder="새 비밀번호 입력">
    <div id="meMsg" style="margin-bottom:16px; font-size:0.95rem; font-weight:bold; height:20px;"></div>
    <button id="meSave" class="bigbtn">저장하기</button>
    ${IS_ADMIN ? '<button id="meAdminBtn" class="bigbtn" style="margin-top:12px; background:var(--card); color:var(--accent); border:1px solid var(--accent);">👑 관리자 메뉴</button>' : ''}
    <button id="meLogout" class="obtn ghost" style="margin-top:12px; width:100%; border:1px solid var(--border); color:#f44336;">로그아웃</button>
  </div>`;
  const myData = (DATA && DATA.players) ? DATA.players.find(p => p.name === auth.name) : null;
  const myHandicap = myData ? myData.handicap : '';
  d.querySelector('#meName').value = auth.name || '';
  d.querySelector('#meHandicap').value = myHandicap;
  
  if (d.querySelector('#meAdminBtn')) {
    d.querySelector('#meAdminBtn').onclick = () => { closeMeModal(); renderAdminMenu(); };
  }

  fetch(SB_URL + '/rest/v1/profiles?id=eq.' + auth.uid, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + auth.token }
  })
  .then(r=>r.json())
  .then(rows => { if(rows && rows.length > 0) { if (rows[0].display_name) d.querySelector('#meName').value = rows[0].display_name; if (rows[0].handicap) d.querySelector('#meHandicap').value = rows[0].handicap; } }).catch(()=>{});
  d.querySelector('#meSave').onclick = async () => {
    const btn = d.querySelector('#meSave'), msg = d.querySelector('#meMsg'), name = d.querySelector('#meName').value.trim(), hd = d.querySelector('#meHandicap').value.trim(), pwd = d.querySelector('#mePwd').value;
    btn.disabled = true; msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      if (!name) { msg.textContent = '이름을 입력하세요.'; msg.style.color = '#f44336'; btn.disabled = false; return; }
      // 이름·수지 변경 + 내가 뛴 모든 경기의 저장 이름을 서버에서 한 번에 갱신
      await adminApi.renamePlayer(auth.uid, name, hd ? parseInt(hd,10) : null);
      auth.name = name; localStorage.setItem(LS_AUTH, JSON.stringify(auth));
      if(pwd) {
        const authRes = await fetch(SB_URL + '/auth/v1/user', {
          method: 'PUT',
          headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        if(!authRes.ok) throw 0;
      }
      msg.textContent = '✅ 성공적으로 저장되었습니다.'; msg.style.color = '#4CAF50'; d.querySelector('#mePwd').value = '';
      try { await reloadData(); } catch(e){}   // 바뀐 이름을 순위·경기 화면에 즉시 반영
    } catch(e) { msg.textContent = '❌ 저장 실패. 다시 로그인해 보세요.'; msg.style.color = '#f44336'; }
    btn.disabled = false;
  };
  
  d.querySelector('#meLogout').onclick = () => {
    localStorage.removeItem(LS_AUTH);
    location.href = '../score/';
  };
  return d;
}

// ══ 내 정보 설정 모달 (팀 설정처럼 앞에 띄우는 팝업) ══
function openMeModal(){
  const m = document.getElementById('meModal'); if (!m) return;
  const body = document.getElementById('meModalBody');
  if (body) body.replaceChildren(renderMe());
  m.style.display = 'flex';
}
function closeMeModal(){ const m = document.getElementById('meModal'); if (m) m.style.display = 'none'; }

// ══ 관리자 메뉴 (전체 회원 및 소속 팀 관리) ══
async function renderAdminMenu(){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const el = $(`<div>
    <button class="back">← 내 정보로</button>
    <div class="card">
      <h2 style="margin:0 0 16px 0; font-size:1.3rem;">👑 관리자 메뉴 (회원 및 소속팀)</h2>
      <div id="adminRosterMsg" style="color:var(--muted); font-size:0.9rem;">불러오는 중...</div>
      <div id="adminRosterList" style="display:flex; flex-direction:column; gap:12px; margin-top:12px;"></div>
    </div>
  </div>`);

  el.querySelector('.back').onclick = () => { show('rank'); openMeModal(); };

  const container = el.querySelector('#adminRosterList');
  const msg = el.querySelector('#adminRosterMsg');

  try {
    let membersWithTeams = [];
    try {
      membersWithTeams = await sbFetch('/rest/v1/rpc/admin_get_all_members', { method: 'POST', body: JSON.stringify({}) });
    } catch(rpcErr) {
      const profs = await sbFetch('/rest/v1/profiles?select=id,display_name,handicap,team_members(team_id,is_admin,teams(id,name,join_code))&order=display_name');
      membersWithTeams = (profs || []).map(p => ({
        user_id: p.id,
        display_name: p.display_name,
        handicap: p.handicap,
        teams: (p.team_members || []).map(tm => ({
          id: tm.teams ? tm.teams.id : tm.team_id,
          name: tm.teams ? tm.teams.name : '알 수 없는 팀',
          join_code: tm.teams ? tm.teams.join_code : '',
          is_admin: tm.is_admin
        }))
      }));
    }

    msg.textContent = `총 ${membersWithTeams.length}명의 회원`;

    container.innerHTML = membersWithTeams.map(m => {
      const name = m.display_name || '이름 없음';
      const teams = Array.isArray(m.teams) ? m.teams : [];
      
      const teamChips = teams.length === 0
        ? `<span style="font-size:0.85rem; color:var(--muted);">(소속 팀 없음)</span>`
        : teams.map(t => `<button class="adm-team-chip" data-tid="${esc(t.id)}" data-tname="${esc(t.name)}" data-tcode="${esc(t.join_code||'')}" style="padding:4px 10px; border-radius:6px; background:var(--card2); color:var(--accent); border:1px solid var(--line); font-size:0.85rem; font-weight:600; cursor:pointer; margin-right:6px; margin-top:4px;">${esc(t.name)}${t.is_admin ? ' 👑' : ''}</button>`).join('');

      return `<div style="padding:12px; border-radius:10px; background:var(--bg); border:1px solid var(--line); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <a class="adm-pl-name" data-name="${esc(name)}" style="font-weight:700; font-size:1.05rem; color:var(--text); text-decoration:underline; cursor:pointer;">👤 ${esc(name)}</a>
          <span style="font-size:0.8rem; color:var(--muted);">수지 ${m.handicap ? m.handicap*10 : '—'}</span>
        </div>
        <div style="font-size:0.85rem; display:flex; flex-wrap:wrap; align-items:center; gap:4px;">
          <span style="color:var(--muted); font-size:0.8rem; margin-right:4px;">소속팀:</span>
          ${teamChips}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.adm-pl-name').forEach((a, i) => {
      a.onclick = (e) => {
        e.preventDefault();
        renderAdminMemberEditPage(membersWithTeams[i]);
      };
    });

    container.querySelectorAll('.adm-team-chip').forEach(btn => {
      btn.onclick = () => {
        openAdminTeamEditModal({ id: btn.dataset.tid, name: btn.dataset.tname, join_code: btn.dataset.tcode });
      };
    });

  } catch(e) {
    msg.textContent = '회원 목록을 불러오는 데 실패했습니다.';
  }

  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}

function openAdminTeamEditModal(team){
  const el = $(`<div class="ovl on" style="z-index:999;">
    <div class="ovlcard" style="max-width:400px; text-align:left;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <h3 style="margin:0; font-size:1.15rem;">🏢 팀 정보 관리</h3>
        <button class="close-btn" style="background:none; border:none; color:var(--muted); font-size:1.4rem; line-height:1; cursor:pointer; padding:0 4px;">&times;</button>
      </div>

      <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:4px;">팀 이름</label>
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <input id="admTName" value="${esc(team.name)}" maxlength="20" style="flex:1; padding:8px 10px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:0.9rem;">
        <button id="admTRenameBtn" style="padding:8px 12px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:0.85rem; cursor:pointer;">이름 변경</button>
      </div>

      <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:4px;">초대 코드</label>
      <div style="display:flex; gap:8px; margin-bottom:16px;">
        <input id="admTCode" value="${esc(team.join_code||'')}" maxlength="16" style="flex:1; padding:8px 10px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:0.9rem;">
        <button id="admTCodeBtn" style="padding:8px 12px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:0.85rem; cursor:pointer;">코드 변경</button>
      </div>

      <div id="admTMsg" style="font-size:0.85rem; min-height:1.2em; margin-bottom:16px; font-weight:600;"></div>

      <div style="padding-top:12px; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center;">
        <button id="admTDelBtn" style="padding:9px 14px; border-radius:8px; background:var(--card); color:var(--danger,#e5484d); border:1px solid var(--line); font-size:0.85rem; font-weight:700; cursor:pointer;">🗑️ 팀 삭제</button>
        <button class="close-btn" style="padding:9px 16px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-size:0.85rem; cursor:pointer;">닫기</button>
      </div>
    </div>
  </div>`);

  document.body.appendChild(el);

  const close = () => { el.remove(); };
  el.querySelectorAll('.close-btn').forEach(b => b.onclick = close);

  el.querySelector('#admTRenameBtn').onclick = async () => {
    const msg = el.querySelector('#admTMsg');
    const newName = (el.querySelector('#admTName').value || '').trim();
    if (!newName) { msg.textContent = '팀 이름을 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '변경 중...'; msg.style.color = 'var(--text)';
    try {
      await sbFetch('/rest/v1/rpc/rename_team', { method: 'POST', body: JSON.stringify({ p_team_id: team.id, new_name: newName }) });
      msg.textContent = '✅ 팀 이름이 변경되었습니다.'; msg.style.color = '#4CAF50';
      team.name = newName;
      await loadTeams();
    } catch(e) {
      msg.textContent = /name_taken|duplicate|unique/i.test(e.message) ? '이미 사용 중인 팀 이름입니다.' : '팀 이름 변경 실패.';
      msg.style.color = '#f44336';
    }
  };

  el.querySelector('#admTCodeBtn').onclick = async () => {
    const msg = el.querySelector('#admTMsg');
    const newCode = (el.querySelector('#admTCode').value || '').trim().toUpperCase();
    if (!newCode) { msg.textContent = '초대 코드를 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '변경 중...'; msg.style.color = 'var(--text)';
    try {
      const saved = await sbFetch('/rest/v1/rpc/set_join_code', { method: 'POST', body: JSON.stringify({ p_team_id: team.id, new_code: newCode }) });
      msg.textContent = '✅ 초대 코드가 변경되었습니다.'; msg.style.color = '#4CAF50';
      team.join_code = saved;
      el.querySelector('#admTCode').value = saved;
    } catch(e) {
      msg.textContent = /code_taken|duplicate|unique/i.test(e.message) ? '이미 사용 중인 참여 코드입니다.' : '코드 변경 실패.';
      msg.style.color = '#f44336';
    }
  };

  el.querySelector('#admTDelBtn').onclick = async () => {
    if (!confirm(`"${team.name}" 팀을 삭제하시겠습니까?\n\n- 팀 내 멤버 소속만 해제되며 회원 계정과 경기 기록은 삭제되지 않습니다.`)) return;
    const msg = el.querySelector('#admTMsg');
    msg.textContent = '팀 삭제 중...'; msg.style.color = 'var(--text)';
    try {
      try {
        await sbFetch('/rest/v1/rpc/delete_team', { method: 'POST', body: JSON.stringify({ p_team_id: team.id }) });
      } catch(rpcErr) {
        await sbFetch('/rest/v1/teams?id=eq.' + team.id, { method: 'DELETE' });
      }
      alert(`"${team.name}" 팀이 삭제되었습니다.`);
      close();
      await loadTeams();
      renderAdminMenu();
    } catch(e) {
      msg.textContent = '팀 삭제에 실패했습니다.'; msg.style.color = '#f44336';
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════
   홈 — 이번 달 하이라이트 (세로 카드 한 장씩 3초마다)

   다른 탭과 달리 조회 기간·정기전 필터를 따르지 않는다. "이번 달 / 지난 달"이
   카드의 뜻 자체라서, 사용자가 순위 탭에서 잡아 둔 기간에 따라 내용이 바뀌면
   같은 문구가 다른 의미가 돼 버린다. 홈은 언제나 달력 기준 이번 달·지난 달.
   ══════════════════════════════════════════════════════════════════════ */

// off=0 이번 달, -1 지난 달. 달의 첫날~마지막날을 YYYY-MM-DD 로.
function monthOf(off){
  const n = new Date();
  const s = new Date(n.getFullYear(), n.getMonth() + off, 1);
  const e = new Date(s.getFullYear(), s.getMonth() + 1, 0);   // 다음 달 0일 = 이번 달 말일
  return { from: ymd(s), to: ymd(e), label: s.getFullYear() + '년 ' + (s.getMonth() + 1) + '월' };
}

let monthCache = { key: '', data: null };
function monthData(){
  const key = RAW_GAMES.length + '|' + todayYmd();
  if (monthCache.key === key && monthCache.data) return monthCache.data;
  const cur = monthOf(0), prev = monthOf(-1);
  const at = g => ymd(new Date(g.played_at));
  const data = {
    cur, prev,
    curD:  processData(RAW_GAMES.filter(g => inRange(at(g), cur.from, cur.to)), RAW_MEMBERS),
    prevD: processData(RAW_GAMES.filter(g => inRange(at(g), prev.from, prev.to)), RAW_MEMBERS),
    // 하이런 '경신' 판정용 — 이번 달 이전 통산
    befD:  processData(RAW_GAMES.filter(g => at(g) < cur.from), RAW_MEMBERS)
  };
  monthCache = { key, data };
  return data;
}

// 선수 식별 — processData 와 같은 규칙(회원은 계정 id, 게스트는 이름)으로 달을 넘겨 이어 붙인다
const pKey = p => p.id ? ('id:' + p.id) : ('nm:' + p.name);
const pMap = d => { const m = {}; for (const p of d.players) m[pKey(p)] = p; return m; };
const f3 = v => v.toFixed(3);
const fPct = v => v.toFixed(1) + '%';   // 보정 승률 — 통합 순위표와 같은 자릿수
const arrow = (a, b) => a + '<span class="ar">→</span>' + b;

const HOME_TABS = [
  { k: 'grow', t: '이번 달 성장' },
  { k: 'last', t: '지난 달 결산' },
  { k: 'best', t: '최고 기록' }
];
let homeTab = 'grow';

/* 1등 뽑기 — 값이 같으면 공동으로 이름을 나란히 적는다.
   (그럴 땐 눌러서 넘어갈 곳이 하나가 아니므로 renderHome 에서 링크를 안 건다) */
function topOf(players, val){
  let best = -Infinity, who = [];
  for (const p of players) {
    const v = val(p);
    if (v == null || !(v > 0)) continue;
    if (v > best) { best = v; who = [p.name]; }
    else if (v === best) who.push(p.name);
  }
  return who.length ? { v: best, who } : null;
}

/* 한 경기 최고치 — 선수별 누적값이 아니라 '경기 하나'의 최고 기록.
   누적으로 뽑으면 매 경기 2.0 을 꾸준히 친 사람이, 한 번 3.0 을 뽑은 사람을 이겨 버린다.
   기록(record)은 그날 그 경기의 최고점이어야 해서 history 를 낱개로 훑는다.
   val(h) 이 null 을 주면 그 경기는 건너뛴다(알 이닝이 없는 경기 등). */
function bestGameOf(players, val){
  let best = null;
  for (const p of players) for (const h of p.history) {
    const v = val(h);
    if (v == null) continue;
    if (!best || v > best.v + 1e-9) best = { v, who: [p.name], date: h.date };
    // 소수 비교라 완전 동률은 오차 범위로 본다. 같은 사람이 두 번 찍었으면 이름은 한 번만.
    else if (Math.abs(v - best.v) < 1e-9 && !best.who.includes(p.name)) best.who.push(p.name);
  }
  return best;
}
const gameAvg  = h => h.ballInn > 0 ? h.score / h.ballInn : null;
// 기록이 한 사람·한 경기일 때만 날짜를 밝힌다 (공동이면 날짜가 여럿이라 한 날을 못 적는다)
const recDate = r => (r && r.who.length === 1) ? ddmy(r.date) + ' 경기' : '';

/* [1등, 라벨, 단위, 포맷, 이 카드만의 밑줄] 묶음 → 카드로. 1등이 없는 줄은 버린다. */
const mkCards = (rows, badge, foot) => rows.filter(([r]) => r)
  .map(([r, label, unit, fmt, ownFoot]) => ({
    badge, name: r.who.join(', '), player: r.who.length === 1 ? r.who[0] : null,
    big: (fmt ? fmt(r.v) : r.v) + (unit ? `<span class="un">${unit}</span>` : ''),
    label, foot: ownFoot || foot
  }));

// ── 이번 달 성장 — 하이런 신기록 → 수지 → 에버리지 → 승률 ──
function homeGrowCards(){
  const M = monthData();
  const cur = M.cur;
  const C = pMap(M.curD), P = pMap(M.prevD), B = pMap(M.befD);
  const out = [];

  // ── 수지 상승 (handicap_history) ──
  // 한 달에 여러 번 바뀌었으면 처음 값 → 마지막 값 하나로 합친다.
  const memName = {};
  for (const m of (RAW_MEMBERS || [])) if (m && m.id) memName[m.id] = m.display_name;
  const hd = {};
  for (const h of RAW_HDCP) {
    if (h.old_handicap == null || h.new_handicap == null) continue;
    if (!memName[h.player_id]) continue;                                  // 다른 팀 회원은 뺀다
    // changed_at 은 timestamptz(UTC 로 온다) — 문자열을 자르면 안 되고 로컬 날짜로 바꿔서 견준다.
    // 한국은 UTC+9 라 1일 오전 0~9시 변경분이 전달 말일로 잡혀 통째로 누락된다. 경기(played_at)와 같은 방식.
    if (!inRange(ymd(new Date(h.changed_at)), cur.from, cur.to)) continue;
    const e = hd[h.player_id] || (hd[h.player_id] = { from: h.old_handicap });
    e.to = h.new_handicap;
  }
  const hdUp = Object.keys(hd).map(id => ({ id, ...hd[id] }))
    .filter(e => e.to > e.from)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from));

  // ── 성적 변화 (지난달 대비) ──
  // 한두 경기 뽑기로 뒤집히지 않게 양쪽 달 모두 2경기 이상인 사람만
  const avgUp = [];
  const rateUp = [];
  const hrNew = [];
  for (const k in C) {
    const c = C[k], p = P[k], b = B[k];
    if (p && c.games >= 2 && p.games >= 2) {
      if (p.avgAvg > 0 && c.avgAvg > p.avgAvg) avgUp.push({ c, p, d: c.avgAvg - p.avgAvg });
      // 승률은 반드시 보정 승률(adjRate). 홈 카드는 모드를 안 가리고 한 달을 통째로 묶는데
      // 원시 승률(wins/games)은 1등만 세서 다인전 2등이 꼴등과 같은 0점 취급이 된다.
      // 통합 순위표의 '승률' 열도 adjRate 다 (COLS_ALL) — 표와 카드가 다른 수를 말하면 안 된다.
      if (c.games >= 3 && p.games >= 3 && c.adjRate > p.adjRate + 0.5)
        rateUp.push({ c, p, d: c.adjRate - p.adjRate });
    }
    // 하이런은 '지난달보다'보다 '통산 최고 경신'이 훨씬 값진 소식이라 이전 전체와 비교한다
    if (b && b.bestHr > 0 && c.bestHr > b.bestHr) hrNew.push({ c, b, d: c.bestHr - b.bestHr });
  }

  hrNew.sort((a, b) => b.d - a.d).slice(0, 3).forEach(g => out.push({
    badge: '📈 이번 달 성장', name: g.c.name, player: g.c.name,
    big: arrow(g.b.bestHr, g.c.bestHr), label: '하이런 신기록',
    delta: '+' + g.d, foot: '지난 기록을 ' + cur.label + '에 갈아치웠습니다'
  }));

  hdUp.forEach(e => out.push({
    badge: '📈 이번 달 성장', name: memName[e.id], player: memName[e.id],
    big: arrow(e.from * 10, e.to * 10), label: '수지 상승',
    delta: '+' + (e.to - e.from) * 10, foot: cur.label
  }));
  avgUp.sort((a, b) => b.d - a.d).slice(0, 3).forEach(g => out.push({
    badge: '📈 이번 달 성장', name: g.c.name, player: g.c.name,
    big: arrow(f3(g.p.avgAvg), f3(g.c.avgAvg)), label: '에버리지 상승',
    delta: '+' + f3(g.d),
    foot: '지난달 ' + g.p.games + '경기 → 이번달 ' + g.c.games + '경기'
  }));
  rateUp.sort((a, b) => b.d - a.d).slice(0, 2).forEach(g => out.push({
    badge: '📈 이번 달 성장', name: g.c.name, player: g.c.name,
    big: arrow(fPct(g.p.adjRate), fPct(g.c.adjRate)), label: '승률 상승',
    delta: '+' + g.d.toFixed(1) + '%p',
    foot: '지난달 ' + g.p.games + '경기 → 이번달 ' + g.c.games + '경기'
  }));

  return out;
}

/* ── 지난 달 결산 ── 한 달을 '누가 잘했나'로 요약하는 자리라 전부 누적값이다.
   승수(wins)는 쓰지 않는다: 다인전 1등과 2인전 1승이 같은 1승으로 세여 값이 뒤섞인다.
   대신 모드를 가리지 않는 보정 승률(adjRate)로 '최고 승률'을 뽑는다. */
function homeLastCards(){
  const M = monthData();
  if (!M.prevD.games.length) return [];
  const pl = M.prevD.players;
  const enough = pl.filter(p => p.games >= 2);   // 누적 평균은 한두 경기로 뒤집히지 않게
  return mkCards([
    [topOf(pl, p => p.games),        '최다 경기 수', '경기'],
    [topOf(enough, p => p.adjRate),  '최고 승률',    '', fPct],
    [topOf(enough, p => p.avgAvg),   '최고 에버리지', '', f3],
    [topOf(pl, p => p.bestHr),       '최고 하이런',  '점']
  ], '🏅 ' + M.prev.label + ' 결산',
     M.prev.label + ' · ' + M.prevD.games.length + '경기 기준');
}

/* ── 최고 기록 ── 기간·정기전 필터와 무관한 통산 전체.
   에버리지는 '한 경기' 최고치다 — 결산은 그 달의 성적 요약이지만
   이쪽은 깨지기 전까지 남는 기록판이라 그날 하루의 최고점을 올린다.
   (하이런은 원래 경기별 최고 연속 득점이라 누적/한 경기 구분이 없다) */
function homeBestCards(){
  const D = getFullProcessData();
  if (!D.games.length) return [];
  const pl = D.players;
  const bAvg = bestGameOf(pl, gameAvg);
  return mkCards([
    [bAvg, '한 경기 최고 에버리지', '', f3, recDate(bAvg)],
    [topOf(pl, p => p.bestHr), '최고 하이런', '점']
  ], '👑 통산 최고 기록', '지금까지 쌓인 ' + D.games.length + '경기 전체 기준');
}

// 고른 묶음이 비어 있으면 빈 화면 대신 안내 한 장
const HOME_EMPTY = {
  grow: ['📈 이번 달 성장', '이번 달 성장 소식은 아직이에요', '지난달과 견줄 기록이 쌓이면 여기에 뜹니다'],
  last: ['🏅 지난 달 결산', '지난 달 기록이 없어요', '한 달 치가 쌓이면 결산이 만들어집니다'],
  best: ['👑 통산 최고 기록', '아직 기록이 없어요', '첫 경기를 치면 여기가 채워집니다']
};
function homeSlides(){
  const cards = homeTab === 'last' ? homeLastCards()
              : homeTab === 'best' ? homeBestCards()
              : homeGrowCards();
  if (cards.length) return cards;
  const [badge, label, foot] = HOME_EMPTY[homeTab] || HOME_EMPTY.grow;
  return [{ badge, big: '🎱', label, foot }];
}

const homeSlideHtml = (s, i) => `<div class="hslide${i === 0 ? ' on' : ''}">
    <div class="hbadge">${esc(s.badge)}</div>
    ${s.name ? (s.player
        ? `<a class="hname" data-p="${esc(s.player)}">${esc(s.name)}</a>`
        : `<div class="hname">${esc(s.name)}</div>`) : ''}
    <div class="hbig">${s.big}</div>
    <div class="hlabel">${esc(s.label)}</div>
    ${s.delta ? `<div class="hdelta">${esc(s.delta)}</div>` : ''}
    ${s.foot ? `<div class="hfoot">${esc(s.foot)}</div>` : ''}
  </div>`;

function renderHome(){
  const slides = homeSlides();
  const el = $(`<div class="home">
    <div class="hseg seg">${HOME_TABS.map(t =>
      `<button class="h-tab${t.k === homeTab ? ' on' : ''}" data-k="${t.k}">${t.t}</button>`
    ).join('')}</div>
    <div class="hcar">
      <div class="hbar"></div>
      ${slides.map(homeSlideHtml).join('')}
    </div>
    <div class="hdots">${slides.map((s, i) =>
      `<button class="hdot${i === 0 ? ' on' : ''}" data-i="${i}" aria-label="${i + 1}번째 카드"></button>`
    ).join('')}</div>
    <div class="sub" style="text-align:center; margin:12px 0 0">
      ${slides.length > 1 ? '3초마다 넘어갑니다 · 누르고 있으면 멈추고, 좌우로 밀거나 점을 눌러 이동' : ''}
    </div>
  </div>`);

  const items = [...el.querySelectorAll('.hslide')];
  const dots  = [...el.querySelectorAll('.hdot')];
  const bar   = el.querySelector('.hbar');
  const car   = el.querySelector('.hcar');

  /* 넘김 타이머 — 남은 시간을 들고 있는 setTimeout 이다(setInterval 이 아니라).
     손가락을 얹고 있는 동안 '남은 시간'만 얼려 두고, 떼면 그 자리에서 이어 간다.
     진행 막대도 animation-play-state 로 같이 멈춰야 눈과 실제가 어긋나지 않는다. */
  const DUR = 3000;
  let idx = 0, left = DUR, startedAt = 0, held = false;

  const pause = () => {
    if (homeTimer) {
      left = Math.max(0, left - (Date.now() - startedAt));
      clearTimeout(homeTimer);
      homeTimer = null;
    }
    bar.style.animationPlayState = 'paused';
  };
  const resume = () => {
    if (items.length < 2 || homeTimer || held || document.hidden) return;
    startedAt = Date.now();
    homeTimer = setTimeout(() => { homeTimer = null; go(idx + 1); }, left);
    bar.style.animationPlayState = 'running';
  };
  const go = n => {
    idx = (n + items.length) % items.length;
    items.forEach((e, i) => e.classList.toggle('on', i === idx));
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    // 막대는 클래스를 뗐다 붙여 애니메이션을 처음부터 다시 튼다 (사이에 reflow 강제)
    bar.classList.remove('run');
    void bar.offsetWidth;
    bar.style.animationPlayState = '';
    if (items.length > 1) bar.classList.add('run');
    if (homeTimer) { clearTimeout(homeTimer); homeTimer = null; }
    left = DUR;
    if (held) bar.style.animationPlayState = 'paused'; else resume();
  };

  // 누르고 있는 동안 멈춤. 터치는 포인터가 대상에 암묵적으로 붙어 있어
  // 카드 밖으로 끌고 나가도 pointerup 이 여기로 온다. 마우스는 pointerleave 로 푼다.
  car.addEventListener('pointerdown', () => { held = true; pause(); });
  const release = () => { if (!held) return; held = false; resume(); };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => car.addEventListener(ev, release));

  // 다른 탭·앱에 가 있는 동안도 멈춘다 — 돌아왔을 때 여러 장 건너뛴 것처럼 보이지 않게
  homeVis = () => { if (document.hidden) pause(); else resume(); };
  document.addEventListener('visibilitychange', homeVis);

  dots.forEach(d => d.onclick = () => go(+d.dataset.i));
  el.querySelectorAll('.h-tab').forEach(b => b.onclick = () => { homeTab = b.dataset.k; show('home'); });
  el.querySelectorAll('a.hname').forEach(a => a.onclick = () => showPlayer(a.dataset.p));

  let sx = 0, sy = 0;
  car.addEventListener('touchstart', e => {
    const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  car.addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    // 세로로 더 많이 움직였으면 스크롤이지 넘기기가 아니다
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) go(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });

  go(0);
  return el;
}

function renderGames(){
  const modeSel = `<select class="field pg-mode" style="flex:0 0 auto; width:84px; height:34px; padding:0 26px 0 8px; font-size:0.9rem; border-radius:8px; margin:0;">` +
    MODE_TABS.map(m => `<option value="${m}" ${m===gamesMode?'selected':''}>${m}</option>`).join('') +
    `</select>`;

  const filteredGames = gamesMode === '통합' 
    ? DATA.games 
    : DATA.games.filter(g => g.type === gamesMode);

  // 기록이 쌓이면 한 번에 다 그리기엔 무겁다 → 20경기씩. 아래로 내려 감시 지점이 보이면 다음 20경기.
  const sorted = [...filteredGames].sort((a,b)=>b.datetime.localeCompare(a.datetime));
  const rowHtml = g => {
    const win = g.players.filter(p=>p.ranking===1).map(p=>p.name).join(', ');
    const all = g.players.map(p=>p.name).join(', ');
    return `<tr onclick="showGame('${g.id}')" style="cursor:pointer">
      <td class="name">${esc(g.date)}</td><td class="name">${esc(g.name||g.type)}${g.eventId ? ' ' + EVT_ICON : ''}</td>
      <td class="name">${esc(all)}</td><td class="name win">🏆 ${esc(win)}</td></tr>`;
  };

  const inner = sorted.length ? `<table>
    <thead><tr><th class="name">날짜</th><th class="name">경기</th>
      <th class="name">참가자</th><th class="name">우승</th></tr></thead>
    <tbody>${sorted.slice(0, GAMES_PAGE).map(rowHtml).join('')}</tbody></table>`
    : `<div class="empty">기록이 없습니다</div>`;

  const el = $(`<div class="card">
    <div style="margin-bottom:14px;">
      ${rangeRowHtml('pg-period', rankFrom, rankTo, modeSel)}
      ${eventRowHtml('pg-period') ? `<div class="toolrow">${eventRowHtml('pg-period')}</div>` : ''}
    </div>
    <div class="scroll">${inner}</div>
    <button class="pg-more mbtn" style="display:none; width:100%; margin-top:10px"></button>
    <div class="sub" style="margin:10px 0 0">경기를 누르면 상세 기록을 볼 수 있습니다.</div>
  </div>`);
  bindRangePicker(el, 'pg-period', { max: todayYmd(), allowClear: true, aria: '조회 기간' });

  const tbody = el.querySelector('tbody');
  const more = el.querySelector('.pg-more');
  let shown = Math.min(GAMES_PAGE, sorted.length);
  const syncMore = () => {
    const rest = sorted.length - shown;
    more.style.display = rest > 0 ? '' : 'none';
    more.textContent = rest > 0 ? `${rest}경기 더 보기` : '';
  };
  const loadMore = () => {
    if (!tbody || shown >= sorted.length) return;
    tbody.insertAdjacentHTML('beforeend', sorted.slice(shown, shown + GAMES_PAGE).map(rowHtml).join(''));
    shown = Math.min(shown + GAMES_PAGE, sorted.length);
    syncMore();
  };
  syncMore();
  more.onclick = loadMore;   // 관찰자가 없거나 놓쳤을 때의 대비책
  if (tbody && 'IntersectionObserver' in window) {
    // 200px 앞에서 미리 채워 스크롤이 끊기지 않게. 화면을 바꿀 때 show() 가 끊는다.
    gamesIO = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadMore(); },
                                       { rootMargin: '200px 0px' });
    gamesIO.observe(more);
  }

  const refreshGamesSub = () => {
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
  };
  const applyGamesRange = () => {
    rankFrom = el.querySelector('.pg-period-from').value;
    rankTo = el.querySelector('.pg-period-to').value;
    DATA = getFilteredData();
    refreshGamesSub();
    show('games');
  };
  el.querySelector('.pg-period-from').onchange = applyGamesRange;
  el.querySelector('.pg-period-to').onchange = applyGamesRange;
  bindEventSel(el, 'pg-period', () => { DATA = getFilteredData(); refreshGamesSub(); show('games'); });

  el.querySelector('.pg-mode').onchange = (e) => {
    gamesMode = e.target.value;
    show('games');
  };

  return el;
}

function showGame(id){
  const g = DATA.games.find(v=>v.id===id);
  if(!g) return;
  if(gamesIO){ gamesIO.disconnect(); gamesIO = null; }   // 목록을 떠나므로 더 불러올 일이 없다
  // 표준 경쟁 순위: 앞선 인원 + 1 (공동 1등이 2명이면 다음은 3등). 동순위면 "공동 N등"
  const rankLabel = p => {
    const less = g.players.filter(x => x.rank < p.rank).length;
    const same = g.players.filter(x => x.rank === p.rank).length;
    return (same > 1 ? '공동 ' : '') + (less + 1) + '등';
  };
  const pRows = [...g.players].sort((a,b)=>a.rank-b.rank).map(p => {
    const avg = p.ballInn ? (p.score / p.ballInn).toFixed(3) : '0.000';   // 에버 분모는 알 이닝
    const medal = p.rank===1 ? ' 🏆' : '';
    const shots = Math.max(1, p.score + (p.innings||0));
    const itv = p.timeMs > 0 ? (p.timeMs / shots / 1000).toFixed(1) + '초' : '—';
    return `<tr>
      <td class="name"><a class="pl" data-p="${esc(p.name)}">${esc(p.name)}</a>${medal}</td>
      <td>${rankLabel(p)}</td>
      <td><b>${p.score}</b> <span class="ar">/ ${p.target||''}</span></td>
      <td>${p.ballInn}</td>
      <td>${avg}</td>
      <td>${itv}</td>
      <td>${p.cushInn ? `${p.cushMade}/${p.cushInn}` : '—'}</td>
      <td>${p.highRun}</td>
      <td>${p.misses}</td>
      <td>${p.fouls == null ? '—' : p.fouls}</td>
    </tr>`;
  }).join('');
  // 게임 총 시간 = 선수별 소모 시간 합 (시간 기록이 있는 경기만)
  const totMs = g.players.reduce((a,p)=>a+(p.timeMs||0), 0);
  const totStr = totMs > 0 ? ` · 총 ${Math.floor(totMs/60000)}분 ${Math.round(totMs%60000/1000)}초` : '';
  const ev = g.eventId ? evtById(g.eventId) : null;
  // 정기전에 붙어 있는데 캘린더에서 그 정기전이 지워진 경우 — 소속은 살아 있으니 그렇게 표시
  const evtOf = g.eventId ? (ev ? evtLabel(ev) : '정기전 (삭제된 일정)') : '';
  const el = $(`<div>
    <button class="back">← 경기 목록으로</button>
    <div class="card">
      <h2 style="margin:0 0 4px">🎱 ${esc(g.name||g.type)}</h2>
      <div class="sub" style="margin:0 0 16px">${esc(g.datetime)}${totStr}${evtOf ? ' · ' + EVT_ICON + ' ' + esc(evtOf) : ''}</div>
      <div class="scroll">
        <table class="statgrid">
          <thead><tr><th class="name">선수</th><th>순위</th><th>점수</th><th>알이닝</th><th>에버</th><th>인터벌</th><th>쿠션</th><th>하이런</th><th>공타</th><th>파울</th></tr></thead>
          <tbody>${pRows}</tbody>
        </table>
      </div>
    </div>
  </div>`);
  el.querySelector('.back').onclick=()=>show('games');
  el.querySelectorAll('a.pl').forEach(a=>a.onclick=()=>showPlayer(a.dataset.p));
  if (IS_ADMIN) attachGameAdmin(el, id);
  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}
window.showGame = showGame;   // 모듈 전환 후에도 인라인 onclick에서 접근 가능하도록

/* 오프라인 대기열 동기화는 점수판(score/)이 담당한다.
 * 앱 시작 화면이 점수판이라 기록실엔 반드시 점수판을 거쳐 오므로 여기선 불필요. */
async function initDashboard() {
  const sub = document.getElementById('sub');
  if (sub) sub.textContent = '서버에서 데이터를 불러오는 중입니다...';
  try {
    await loadTeams();   // 현재 팀 확정 후 그 팀 게임만 로드
    const [games, members, adm, events, hdcp] = await Promise.all([
      fetchGames(),
      fetchMembers().catch(() => []),
      fetchAdmin(),
      fetchEvents(),
      fetchHandicapHistory()
    ]);
    RAW_GAMES = games;
    RAW_MEMBERS = members;
    IS_ADMIN = adm;
    RAW_EVENTS = events;
    RAW_HDCP = hdcp;
    DATA = getFilteredData();
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
    const t = new URLSearchParams(location.search).get('tab') || 'home';
    if (t === 'me') { show('home'); openMeModal(); }   // 점수판에서 넘어온 내 정보 딥링크 → 팝업
    else show(t);
  } catch(e) { if (sub) sub.textContent = '데이터를 불러오는데 실패했습니다.'; }
}

let chartRO = null;
function show(v){
  if(v==='me'){ openMeModal(); return; }   // 내 정보는 팝업 모달로 (기본 화면 유지)
  if(chartRO){ chartRO.disconnect(); chartRO = null; }
  if(gamesIO){ gamesIO.disconnect(); gamesIO = null; }
  stopHome();
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.v===v));
  
  const auth = getAuth();
  const uName = document.getElementById('topUserName');
  if (uName) uName.textContent = auth ? auth.name : '게스트';
  const ico = document.getElementById('topUserIcon');
  if (ico) ico.textContent = (auth && IS_ADMIN) ? '🛡️' : '👤';
  const myRecBtn = document.getElementById('btnMyRec');
  if(myRecBtn){
    if(auth && auth.name && DATA && DATA.players && DATA.players.find(p=>p.name===auth.name)) {
      myRecBtn.style.display = 'block';
      myRecBtn.onclick = () => showPlayer(auth.name);
    } else {
      myRecBtn.style.display = 'none';
    }
  }
  // 하단 로그아웃 버튼 — 점수판과 통일성. 로그인 상태에서만 노출
  const logoutBtn = document.getElementById('btnLogout');
  if(logoutBtn){
    if(auth){
      logoutBtn.style.display = '';
      logoutBtn.onclick = () => {
        if(!confirm('로그아웃할까요? 처음 화면으로 돌아갑니다.')) return;
        try { localStorage.removeItem(LS_AUTH); localStorage.removeItem(LS_TEAM); } catch(e){}
        location.href = '../score/';
      };
    } else {
      logoutBtn.style.display = 'none';
    }
  }
  
  let node;
  if(v==='rank') node = renderRank();
  else if(v==='games') node = renderGames();
  else node = renderHome();   // 홈이 기본 — 주소창에 엉뚱한 tab= 이 와도 빈 화면이 되지 않게
  document.getElementById('view').replaceChildren(node);
  syncRankSticky();
}
document.querySelectorAll('.tab').forEach(t=>{ if(t.id!=='btnSettings') t.onclick=()=>show(t.dataset.v); });

// ══ 설정 모달 (팀 설정 / 내 정보 설정 / 음향 / 테마) ══ — 테마 헬퍼는 common.js 에서 import
const LS_VOICE = 'dangScoreVoice';
const getVoice = () => { try { const v = localStorage.getItem(LS_VOICE); return v == null ? true : JSON.parse(v); } catch(e){ return true; } };
const setVoice = b => { try { localStorage.setItem(LS_VOICE, JSON.stringify(b)); } catch(e){} };
(function initSettings(){
  const modal = document.getElementById('setModal'); if (!modal) return;
  const vbtn = document.getElementById('setVoice');
  const themeBtns = modal.querySelectorAll('#setTheme button');
  const sync = () => {
    vbtn.classList.toggle('on', getVoice());
    const cur = getTheme();
    themeBtns.forEach(b => b.classList.toggle('on', b.dataset.t === cur));
  };
  const open = () => { sync(); modal.classList.add('on'); };
  const close = () => modal.classList.remove('on');
  document.getElementById('btnSettings').onclick = open;
  document.getElementById('setClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  document.getElementById('setTeam').onclick = () => { close(); if (getAuth()) openTeamModal(); else openMeModal(); };
  document.getElementById('setMe').onclick = () => { close(); openMeModal(); };
  vbtn.onclick = () => { const nv = !getVoice(); setVoice(nv); vbtn.classList.toggle('on', nv); };
  themeBtns.forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    try { if (t === 'system') localStorage.removeItem(LS_THEME); else localStorage.setItem(LS_THEME, t); } catch(e){}
    applyTheme(t); sync();
  });
  applyTheme(getTheme());
})();

// 내 정보 설정 모달 닫기 (× 버튼 / 배경 클릭)
(function initMeModal(){
  const m = document.getElementById('meModal'); if (!m) return;
  const x = document.getElementById('meClose');
  if (x) x.onclick = closeMeModal;
  m.onclick = e => { if (e.target === m) closeMeModal(); };
})();

initDashboard();

// ══ 서비스 워커 등록 + 자동 업데이트 ══ (공통 모듈)
registerSW();


// ══ 관리자 메뉴: 회원 정보 수정 전용 화면 ══
function renderAdminMemberEditPage(m){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const el = $(`<div>
    <button class="back">← 관리자 메뉴로</button>
    <div class="card">
      <h2 style="margin:0 0 16px 0; font-size:1.3rem;">👤 "${esc(m.display_name||'이름 없음')}" 회원 정보 수정</h2>

      <div style="margin-bottom:16px;">
        <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:6px;">이름 (닉네임)</label>
        <input id="admMName" value="${esc(m.display_name||'')}" maxlength="10" class="field" style="margin:0;">
      </div>

      <div style="margin-bottom:16px;">
        <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:6px;">수지 (점수)</label>
        <select id="admMHd" class="field" style="margin:0;">
          <option value="">수지 선택</option>
          ${[50, 80, 100, 120, 150, 200, 250, 300, 400, 500].map(v => `<option value="${v/10}" ${m.handicap === v/10 ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>

      <div id="admMMsg" style="font-size:0.85rem; min-height:1.2em; margin-bottom:16px; font-weight:600;"></div>

      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <button id="admMBackBtn" class="obtn ghost" style="width:auto; padding:10px 18px; cursor:pointer;">← 목록으로</button>
        <button id="admMSaveBtn" class="bigbtn" style="width:auto; padding:10px 24px;">수정사항 저장</button>
      </div>
    </div>
  </div>`);

  el.querySelector('.back').onclick = () => renderAdminMenu();
  el.querySelector('#admMBackBtn').onclick = () => renderAdminMenu();

  el.querySelector('#admMSaveBtn').onclick = async () => {
    const msg = el.querySelector('#admMMsg');
    const newName = (el.querySelector('#admMName').value || '').trim();
    const hdVal = el.querySelector('#admMHd').value;
    const newHd = hdVal ? parseInt(hdVal, 10) : null;

    if (!newName) { msg.textContent = '이름을 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      await adminApi.renamePlayer(m.user_id, newName, newHd);
      msg.textContent = '✅ 회원 정보가 성공적으로 수정되었습니다.'; msg.style.color = '#4CAF50';
      m.display_name = newName;
      m.handicap = newHd;
      await reloadData();
    } catch(err) {
      msg.textContent = '수정 실패: ' + (/not_authorized|not_authenticated/.test(err.message) ? NO_PERM : err.message);
      msg.style.color = '#f44336';
    }
  };

  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}

