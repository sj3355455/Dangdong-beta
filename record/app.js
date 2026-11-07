import { sbFetch, patchAuth } from './supabase.js';
import { registerSW, initSettingsModal, initTeamModal, fetchMyTeams, renderTeamBar as drawTeamBar,
         ymd, todayYmd, ddmy, rangeRowHtml, bindRangePicker, syncRangeDisp,
         getBall, setBall, ballOfGame, HD3_OPTIONS, fetchRoster, saveHandicap3,
         logout, initPushSwitch, logVisit, initAdminEntry } from './common.js';

let DATA = { updated: '', players: [], games: [] };
// ── 3구 / 4구 ── 기록실 전체가 고른 쪽 경기만 센다. 서버에서 받은 건 ALL_* 에 그대로 두고,
// 화면이 쓰는 RAW_* 는 applyBall() 이 골라 담는다. 그래서 집계 코드는 3구/4구를 몰라도 된다.
// 수지도 공 종류마다 따로다 — 3구면 RAW_MEMBERS 의 handicap 자리에 handicap3(목표 점수 그대로)을 넣는다.
let BALL = getBall();
const is3 = () => BALL === '3구';
let ALL_GAMES = [], ALL_MEMBERS = [];
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

// 정기전/일반 경기 구분(정기전만 보기 필터·⭐ 표시·소속 정정)은 없앴다(2026-10).
// 모든 경기는 그냥 경기다. games.event_id 컬럼은 DB 에 남아 있지만 읽지 않는다.

// ── 순위 탭 집계 범위: 기간 / 최근 N경기 ──
// 'period' 는 달력으로 고른 기간 안의 경기를 모두 센다(rankFrom~rankTo).
// 'recent' 는 사람마다 가장 최근 N경기만 센다 — 날짜가 아니라 경기 순서로 자른다.
// N경기가 안 되는 사람은 빼지 않고 있는 경기 전부로 올린다. N 은 1 이상 아무 값이나 직접 적는다.
// 모드(3인·4인 등)를 고르면 그 모드 경기만 놓고 최근 N경기를 센다.
let rankScope = 'recent';   // 'recent' | 'period' — 기본은 최근 10경기
let recentN = 10;

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
let fullProcessCache = null;
let filteredDataCache = null;
let filteredCacheKey = '';
let recentCache = { key: '', data: null };

function clearProcessCache() {
  fullProcessCache = null;
  filteredDataCache = null;
  filteredCacheKey = '';
  recentCache = { key: '', data: null };
  monthCache = { key: '', data: null };   // 홈 탭의 이번 달/지난 달 집계도 같이 버린다
}

// 경기 종류 — processData 의 typeStr 과 같은 규칙
const gameTypeOf = g => {
  const pls = Array.isArray(g.players) ? g.players : [];
  return (pls.length > 0 && pls[0].isTeam) ? '팀전' : (pls.length + '인');
};
// 같은 사람으로 묶는 열쇠 — processData 의 pmap 키와 같은 규칙
const playerKeyOf = p => p.id ? ('id:' + p.id) : ('nm:' + (p.name || p.id || '알 수 없음'));

/* 사람마다 가장 최근 n경기만 담은 집계. mode 가 '통합'이 아니면 그 모드 경기 중에서 센다.
   경기를 통째로 고르는 게 아니라 (경기, 선수) 짝을 고른다 — 같은 경기라도 A 에겐 최근 10경기 안이고
   B 에겐 밖일 수 있다. 등수·보정 승률은 그 경기 전원의 순위로 내므로 다른 사람을 빼도 값이 같다. */
function getRecentData(mode, n){
  const key = mode + '|' + n + '|' + RAW_GAMES.length;
  if (recentCache.key === key && recentCache.data) return recentCache.data;
  const pick = new Map();   // 경기 → 그 경기에서 담을 선수 객체들
  const cnt = {};
  // RAW_GAMES 는 played_at 오름차순 → 뒤에서부터 훑어야 최근 경기부터 센다
  for (let i = RAW_GAMES.length - 1; i >= 0; i--) {
    const g = RAW_GAMES[i];
    if (!g || !Array.isArray(g.players)) continue;
    if (mode !== '통합' && gameTypeOf(g) !== mode) continue;
    for (const p of g.players) {
      const k = playerKeyOf(p);
      if ((cnt[k] || 0) >= n) continue;
      cnt[k] = (cnt[k] || 0) + 1;
      (pick.get(g) || pick.set(g, new Set()).get(g)).add(p);
    }
  }
  const games = RAW_GAMES.filter(g => pick.has(g));
  const data = processData(games, RAW_MEMBERS, (g, p) => pick.get(g).has(p));
  recentCache = { key, data };
  return data;
}

function getFullProcessData() {
  if (!fullProcessCache) {
    fullProcessCache = processData(RAW_GAMES, RAW_MEMBERS);
  }
  return fullProcessCache;
}

function getFilteredData() {
  const cacheKey = `${rankFrom}|${rankTo}|${RAW_GAMES.length}`;
  if (filteredDataCache && filteredCacheKey === cacheKey) {
    return filteredDataCache;
  }
  const games = (rankFrom || rankTo)
    ? RAW_GAMES.filter(g => inRange(ymd(new Date(g.played_at)), rankFrom, rankTo))
    : RAW_GAMES;
  filteredDataCache = processData(games, RAW_MEMBERS);
  filteredCacheKey = cacheKey;
  return filteredDataCache;
}

const LS_AUTH = 'dangScoreAuth';

// 요청은 전부 sbFetch 로 — 토큰이 만료됐으면 알아서 갱신하고 한 번 더 보낸다
async function fetchGames() {
  if (!currentTeam) return []; // 소속 팀이 없는 사용자는 다른 팀의 게임 정보를 조회하지 않음
  return await sbFetch('/rest/v1/games?select=id,played_at,players&order=played_at.asc&team_id=eq.' + currentTeam) || [];
}

// 머리의 '최종 업데이트 · 총 N경기 · 선수 N명' 줄
function updateSub(){
  const sub = document.getElementById('sub');
  if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
}

// 수지 변경 이력. sql/handicap-history.sql 을 아직 안 돌린 DB에서도 홈 탭이 통째로 죽지 않게
// 실패하면 빈 배열 — 수지 상승 카드만 안 뜬다. (팀 구분이 없는 테이블이라 소속 팀 회원으로 걸러 쓴다)
async function fetchHandicapHistory(){
  if (!currentTeam) return [];
  try {
    const rows = await sbFetch('/rest/v1/handicap_history'
      + '?select=player_id,old_handicap,new_handicap,changed_at&order=changed_at.asc');
    return Array.isArray(rows) ? rows : [];
  } catch(e){ return []; }
}

// 내 소속 팀 로드 + 현재 팀 확정 (실패 시 전역 폴백)
async function loadTeams(){
  const auth = getAuth();
  if (!auth || !auth.uid) { myTeams = []; renderTeamBar(); return; }
  try { ({ teams: myTeams, current: currentTeam } = await fetchMyTeams()); }
  catch(e){ /* my_teams 미배포 등 → 전역 폴백 */ }
  renderTeamBar();
}

// 팀을 바꾸거나 팀 설정을 고친 뒤 — 그 팀 기록을 다시 읽고 보던 탭을 다시 그린다
async function reloadAndShow(){
  await reloadData();
  const on = document.querySelector('.tab.on');
  show(on ? on.dataset.v : 'rank');
  updateSub();
}

// 헤더 소속 팀 스위처
function renderTeamBar(){
  drawTeamBar(!!getAuth(), myTeams, currentTeam, async id => {
    currentTeam = id; tSet(currentTeam);
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '팀 전환 중...';
    await reloadAndShow();
  });
}

// ══ 팀 설정 모달 — 공통 모듈(common.js)로 이동. 앱별 차이(콜백)만 주입. ══
const { open: openTeamModal } = initTeamModal({
  getAuth: () => getAuth(),
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; tSet(currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: reloadAndShow
});

// 수지 선택칸에 값 넣기 — 선택지에 없는 값(관리자가 직접 적은 22 등)이면 그 값을 선택지로 끼워 넣는다.
// 그냥 넣으면 빈칸으로 보이고, 그대로 저장하면 수지가 지워진다.
function setSelVal(sel, v){
  if (v == null || v === '') { sel.value = ''; return; }
  if (![...sel.options].some(o => Number(o.value) === Number(v)) ) sel.insertAdjacentHTML('beforeend', `<option value="${Number(v)}">${Number(v)}</option>`);
  sel.value = String(Number(v));
}

// 원본 명단의 한 사람 (4구 handicap · 3구 handicap3 둘 다 들어 있다)
const memberOf = id => ALL_MEMBERS.find(m => m.id === id);

// 프로필 한 사람 — handicap3 칸이 아직 없는 DB(sql/handicap3.sql 전)면 그 칸만 빼고 다시 읽는다
async function fetchProfile(uid){
  const q = cols => sbFetch('/rest/v1/profiles?select=' + cols + '&id=eq.' + encodeURIComponent(uid));
  let rows;
  try { rows = await q('display_name,handicap,handicap3'); }
  catch(e){ if (e.status !== 400) throw e; rows = await q('display_name,handicap'); }
  return (rows && rows[0]) || null;
}

// 팀 명단 → 평탄한 [{id, display_name, handicap, handicap3}] (processData 의 수지 매칭이 이 모양을 기대한다)
async function fetchMembers() {
  if (!currentTeam) return []; // 소속 팀이 없으면 다른 팀의 회원 정보가 조회되지 않도록 격리
  return await fetchRoster(currentTeam);
}

// 받아 둔 경기·명단에서 지금 공 종류(BALL)의 몫만 골라 화면용 RAW_* 에 담고 집계를 새로 한다
function applyBall(){
  RAW_GAMES = ALL_GAMES.filter(g => ballOfGame(g) === BALL);
  RAW_MEMBERS = is3() ? ALL_MEMBERS.map(m => ({ ...m, handicap: m.handicap3 ?? null })) : ALL_MEMBERS;
  clearProcessCache();
  DATA = getFilteredData();
  syncBallSeg();
}
const syncBallSeg = () => document.querySelectorAll('#ballSeg button').forEach(b => b.classList.toggle('on', b.dataset.b === BALL));
syncBallSeg();

// 3구/4구 토글 — 점수판과 같은 값을 바꾼다. 보던 탭을 그대로 다시 그린다(선수 상세 중이면 순위로)
document.querySelectorAll('#ballSeg button').forEach(b => b.onclick = () => {
  if (BALL === b.dataset.b) return;
  BALL = b.dataset.b; setBall(BALL);
  applyBall(); updateSub();
  const on = document.querySelector('.tab.on');
  show(on && on.dataset.v ? on.dataset.v : 'rank');
});

// ══ 관리자 기능 ══
// 서버(RLS)가 실제 권한을 강제한다. 여기서는 UI 노출 여부만 판단.
// 관리자인지는 설정 창의 관리자 메뉴 버튼(initAdminEntry)이 묻는 김에 같이 받아 온다 — 아래 initDashboard.
let IS_ADMIN = false;
// Prefer: return=representation — RLS에 막히면 빈 배열이 와서 실패를 감지할 수 있다
const REP = { headers: { Prefer: 'return=representation' } };
const adminApi = {
  updateGame: (id, players) => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'PATCH', body: JSON.stringify({ players }) }, REP)),
  deleteGame: id => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'DELETE' }, REP)),
  // 이름 변경을 한 번에: 프로필 + 그 사람이 뛴 모든 경기의 저장된 이름을 서버에서 갱신 (본인/관리자만)
  renamePlayer: (id, name, handicap) => sbFetch('/rest/v1/rpc/rename_player', { method: 'POST', body: JSON.stringify({ target: id, new_name: name, new_handicap: handicap }) })
};
async function reloadData(){
  ALL_GAMES = await fetchGames();
  ALL_MEMBERS = await fetchMembers().catch(() => ALL_MEMBERS);
  RAW_HDCP = await fetchHandicapHistory();   // 수지를 고친 직후면 이력이 한 줄 늘어 있다
  applyBall();
}
const NO_PERM = '권한이 없습니다. 관리자 계정으로 로그인했는지 확인하세요.';

function attachGameAdmin(el, id){
  const raw = RAW_GAMES.find(r => String(r.id) === String(id));
  if (!raw) return;
  const F = [['rank','순위'],['score','점수'],['target','목표'],['innings','이닝'],['highRun','하이런'],['misses','공타'],['fouls','파울'],['cushMade','쿠션성공'],['cushInn','쿠션시도']];
  const bar = $(`<div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🛠 관리자</h3>
    <div style="display:flex; gap:8px;">
      <button class="mbtn" id="gAdmEdit">✏️ 경기 수정</button>
      <button class="mbtn" id="gAdmDel" style="color:#e5484d;border-color:#e5484d">🗑 경기 삭제</button>
    </div>
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

// keep(g, p) 를 주면 false 인 선수 몫은 그 경기에서 집계하지 않는다(최근 N경기용). 경기 목록은 그대로 둔다.
function processData(games, members, keep) {
  const pmap = {};
  const dataGames = [];
  // 이름은 경기에 저장된 값을 그대로 쓴다. (이름 변경 시 rename_player 함수가
  //  프로필과 모든 경기의 저장 이름을 한 번에 갱신하므로 매번 매칭할 필요가 없다.)

  const p2 = n => String(n).padStart(2, '0');
  for (const g of (games || [])) {
    if (!g) continue;
    const dt = new Date(g.played_at);
    const dateStr = ymd(dt);
    const datetimeStr = dateStr + ' ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes()) + ':' + p2(dt.getSeconds());
    const pls = Array.isArray(g.players) ? g.players : [];
    const isTeam = pls.length > 0 && pls[0].isTeam;
    const typeStr = gameTypeOf(g);

    dataGames.unshift({
      id: String(g.id || datetimeStr),
      date: dateStr,
      datetime: datetimeStr,
      type: typeStr,
      ball: ballOfGame(g),
      players: pls.map(p => {
        const bInn = ballInnOf(p);
        return {
          name: p.name || p.id || "알 수 없음", ranking: p.win ? 1 : 2,
          rank: p.rank != null ? p.rank : (p.win ? 1 : 2),
          timeMs: p.timeMs ?? p.time_ms ?? 0,
          target: p.target, score: p.score, innings: p.innings, ballInn: bInn,
          highRun: p.highRun ?? p.high_run ?? 0, misses: missOf(p, bInn), cushMade: p.cushMade ?? p.cush_made ?? 0, cushInn: p.cushInn ?? p.cush_inn ?? 0,
          // 파울은 나중에 추가된 항목 — 예전 기록에는 없으므로 0이 아니라 null(기록 없음)로 둔다
          fouls: p.fouls ?? null
        };
      })
    });

    // 게임 내 각 선수의 평균순위(분수). 동순위는 공동 점유 구간의 평균: 공동 2등 = 2.5, 공동 3등 = 3.5
    const ranks = pls.map(pp => (pp.rank != null ? pp.rank : (pp.win ? 1 : 2)));
    const fracRank = idx => {
      const r = ranks[idx]; let less = 0, eq = 0;
      for (const rr of ranks) { if (rr < r) less++; else if (rr === r) eq++; }
      return less + (eq + 1) / 2;
    };

    for (const p of pls) {
      if (keep && !keep(g, p)) continue;
      const pName = p.name || p.id || "알 수 없음";
      // 회원은 계정 id로 묶어 이름이 바뀌어도 같은 사람으로 집계. 게스트는 이름으로 묶는다.
      const key = playerKeyOf(p);
      const st = pmap[key] || (pmap[key] = { name: pName, handicap: isTeam ? 0 : p.target, history: [], id: p.id || null });
      if (!isTeam) st.handicap = Math.max(st.handicap, p.target);

      const pRank = fracRank(pls.indexOf(p));
      // 보정 승률 점수 — 1등 100 · 꼴등 0 (팀전은 두 팀이라 1등 100 · 2등 0)
      const N = pls.length;
      const pt = isTeam ? (3.5 - pRank) / 2 * 100 : (N > 1 ? (N - pRank) / (N - 1) * 100 : 0);

      const opp = pls.filter(x => (x.name || x.id) !== pName).map(x => x.name || x.id).join(', ');
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

  // 지표는 경기 이력에서 낸다 — 통합과 모드별(2인·3인·4인·팀전) 모두.
  // 선수 상세 화면과 같은 함수(calcStatsForHistory)라 순위표와 상세가 늘 같은 값을 말한다.
  for (const p of pArr) {
    Object.assign(p, calcStatsForHistory(p.history, p.handicap));
    p.modes = {};
    for (const mk of new Set(p.history.map(h => h.type)))
      p.modes[mk] = calcStatsForHistory(p.history.filter(h => h.type === mk), p.handicap);
  }

  const now = new Date();
  return {
    updated: ymd(now) + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes()),
    players: pArr,
    games: dataGames
  };
}

const $ = (h) => { const d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const getAuth = () => { try { return JSON.parse(localStorage.getItem(LS_AUTH)); } catch(e) { return null; } }

const COL_NAME = {k:'name', t:'이름', txt:1};
// 수지 표시 — 4구는 저장값 ×10(15 → 150), 3구는 목표 점수 그대로(20 → 20)
const hdShow = v => v ? (is3() ? v : v * 10) : '—';
const COL_HDCP = {k:'handicap', t:'수지', fmt:hdShow};
// 수지 선택지 (표시값). 저장값은 이 값의 1/10 이고, 그게 곧 2인 기준 게임 목표점수다.
const HD_OPTIONS = [50, 80, 100, 120, 150, 200, 250, 300, 400, 500];
const snapHd = v => HD_OPTIONS.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
const COLS_ALL = [   // 통합: 실력 지표 통합. 승수·승률 대신 보정 승률(준비 중)
  COL_NAME, COL_HDCP,
  {k:'recHd',    t:'권장수지'},
  {k:'games',    t:'경기수'},
  {k:'adjRate',  t:'승률',      fmt:v=>v.toFixed(1)+'%'},
  {k:'avgAvg',   t:'에버리지',   fmt:v=>v.toFixed(3)},
  {k:'streakAvg',t:'평균 타수', fmt:v=>v.toFixed(2)},
  {k:'hitRate',  t:'득점률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'foulRate', t:'파울률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'cushRate', t:'쿠션 성공률', fmt:v=>v.toFixed(1)+'%'},
  {k:'expInn',   t:'기대 이닝', fmt:v=>v.toFixed(1)},
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
  {k:'expInn',   t:'기대 이닝', fmt:v=>v.toFixed(1)},
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
// 3구는 마무리 쿠션·파울이 없고, 권장수지는 아직 기준이 없다 → 그 열들을 뺀다
const NOT_IN_3 = new Set(['foulRate', 'cushRate', 'recHd']);
const colsFor = m => {
  const cols = m==='통합' ? COLS_ALL : (m==='2인'||m==='팀전') ? COLS_VS : COLS_MULTI;
  return is3() ? cols.filter(c => !NOT_IN_3.has(c.k)) : cols;
};
const defSort = m => m==='통합' ? 'avgAvg' : 'winRate';
const cell = (p, c) => p[c.k]==null ? '—' : (c.fmt ? c.fmt(p[c.k]) : p[c.k]);
// 값이 낮을수록 잘한 지표. 표에서 제목을 처음 눌렀을 때와 포디움의 1등이 여기에 달려 있다.
// (기복 = 경기별 에버리지 변동폭이라 낮을수록 안정적이다.
//  평균 인터벌 = 한 타석에 쓴 시간이라 짧을수록 빠르게 친 것이다.
//  기대 이닝 = 한 게임을 끝내는 데 드는 이닝이라 적을수록 빨리 끝낸다)
const bestIsLow = k => k==='avgRank' || k==='foulRate' || k==='volatility' || k==='avgInterval' || k==='expInn';
// 포디움에 올릴 지표 — 승률·에버리지·평균 타수·득점률·하이런·평균 인터벌. 표(COLS)의 순서를 따라간다.
// 승률은 모드마다 열 키가 다르다(통합 adjRate / 나머지 winRate).
const PODIUM_KEYS = ['adjRate','winRate','avgAvg','streakAvg','hitRate','bestHr','avgInterval'];
const podiumCols = COLS => COLS.filter(c => PODIUM_KEYS.includes(c.k));
let rankMode='통합', sortKey='avgAvg', sortAsc=false;
let rankView='table';   // 'table' | 'podium' — 순위 탭 안에서 표/포디움 전환

/* ══ 권장수지 ══
   목표는 '알을 15이닝 안에 다 빼는 것'. 다만 팀 실력이 목표에서 멀면 한 번에 들이대지 않는다
   (당동은 지금 평균 33이닝이라 목표를 그대로 적용하면 수지가 반토막 나고 대부분 최저치에 뭉친다).
   그래서 지금 팀 평균에서 목표 쪽으로 REC_PULL 만큼만 당긴 값을 이번 회차의 기준으로 삼는다.

     팀평균이닝 = 평균( 수지 저장값 ÷ 에버리지 )     ← 저장값이 곧 목표점수, 에버리지 분모는 알 이닝
     기준이닝   = 팀평균이닝 + 0.25 × (15 − 팀평균이닝)
     권장수지   = 개인 에버리지 × 기준이닝 × 10       ← ×10 은 저장값 → 표시 수지

   팀이 목표보다 느리면 기준이 내려가 수지가 낮아지고, 빨라지면 반대로 올라간다.
   목표에 닿으면 괄호가 0이 되어 저절로 멈추므로 하한을 따로 두지 않아도 된다.
   회차가 넘어가는 건 사람이 수지를 실제로 고쳤을 때뿐이다 — 경기 기록만 쌓여서는 움직이지 않는다
   (에버리지가 그대로면 팀평균이닝도 그대로다). 그래서 자동 반영은 하지 않고 추천만 보여 준다. */
const REC_GOAL_INN = 15;    // 목표 이닝
const REC_PULL = 0.25;      // 한 회차에 좁히는 격차 비율
// 아래 둘은 일부러 다르다.
//  · 팀 기준이닝은 여럿을 평균 내는 값이라 한 사람이 흔들려도 묻힌다 → 친 사람은 다 담는다(1경기).
//  · 반대로 개인에게 "수지를 이 값으로 고치세요"라고 내미는 건 표본이 넉넉할 때만 한다(10경기).
// 그래서 10경기가 안 되는 사람도 팀 평균이닝·에버리지 계산에는 그대로 들어가되, 자기 칸은 '—' 로 남는다.
const REC_MIN_GAMES = 1;    // 팀 기준이닝을 낼 때 넣을 최소 경기수 — 한 경기라도 있으면 담는다
const REC_SHOW_GAMES = 10;  // 개인 권장수지를 '표기'할 최소 경기수 (계산에서 빼는 게 아니라 표기만 미룬다)
                            // REC_MAX_GAMES 보다 크면 아무도 못 넘는다 — recentAvg 의 games 는 그 값에서 멈춘다
const REC_MAX_GAMES = 10;   // 최근 몇 경기까지 볼지. 수지는 '지금 실력'에 맞춰야 하므로 통산이 아니다

// 최근 REC_MAX_GAMES 경기만으로 다시 낸 에버리지와 보정 승률. history[0] 이 가장 최근이다
// (processData 가 오래된 경기부터 훑으며 unshift 한다). 승률도 에버리지와 같은 경기들로 낸다 —
// 권장수지를 뒷받침하는지 보는 값이라 구간이 어긋나면 안 된다.
function recentAvg(p){
  let score = 0, binn = 0, games = 0, pts = 0;
  for (const h of (p.history || [])) {
    if (games >= REC_MAX_GAMES) break;
    if (!(h.ballInn > 0)) continue;        // 알 이닝이 없는 기록은 에버리지를 낼 수 없다
    score += h.score; binn += h.ballInn; pts += (h.adjPt || 0); games++;
  }
  return { games, avg: binn > 0 ? score / binn : 0, rate: games > 0 ? pts / games : 0 };
}

/* 권장수지 확신 표시 — 에버리지로 낸 권장수지와 같은 방향을 승률도 가리키면 빨갛게 칠한다.
   보정 승률은 1등 100 · 꼴등 0 이라 수지가 딱 맞으면 50% 근처에 모인다.
   올리라는데 최근 승률이 REC_HOT_UP 이상이면 '정말 올려야 한다', 내리라는데 REC_HOT_DOWN
   이하면 '정말 내려야 한다'. 50 에서 ±15%p 를 둔 건 표본 때문이다 — 최근 10경기의 보정
   승률은 수지가 맞아도 ±13~18%p 쯤 흔들려서, 그보다 좁히면 운으로 칠해지는 경우가 잦다.
   에버리지와 승률이 서로 다른 말을 하면(에버는 올리라는데 승률은 평범) 그냥 검은 글씨다. */
const REC_HOT_UP = 65;
const REC_HOT_DOWN = 35;

/* rows 에 recHd(권장수지)를 붙이고 이번 회차의 기준을 돌려준다. 셀 수 없으면 null.
   화면의 기간·최소 경기 수 필터는 일부러 무시하고 통산 기록(getFullProcessData)에서 최근 경기를 센다.
   '오늘' 하루만 보고 있어도 권장수지는 같은 값이어야 하기 때문이다 — 기간을 좁힐 때마다
   기준이 흔들리면 무엇을 보고 수지를 고쳐야 할지 알 수 없다. 팀 평균도 화면에 걸린 사람이
   아니라 팀 전체에서 낸다. */
function attachRecHd(rows){
  rows.forEach(p => { p.recHd = null; p.recRate = null; p.recHot = false; });
  const stats = getFullProcessData().players
    .filter(p => p.id)                     // 게스트는 수지가 없다
    .map(p => ({ p, ...recentAvg(p) }));
  const base = stats.filter(s => s.games >= REC_MIN_GAMES && s.p.handicap > 0 && s.avg > 0);
  if (base.length < 2) return null;        // 둘도 안 되면 '팀 평균'이라 부를 수 없다
  const teamInn = base.reduce((a, s) => a + s.p.handicap / s.avg, 0) / base.length;
  const goalInn = teamInn + REC_PULL * (REC_GOAL_INN - teamInn);

  const byId = new Map(stats.map(s => [s.p.id, s]));
  rows.forEach(p => {
    const s = byId.get(p.id);
    // 표기 문턱은 REC_SHOW_GAMES — 위 teamInn/goalInn 은 이 사람도 넣어 이미 계산이 끝났다
    if (!(s && s.games >= REC_SHOW_GAMES && s.avg > 0)) return;
    p.recHd = snapHd(s.avg * goalInn * 10);
    p.recRate = s.rate;
    const now = (p.handicap || 0) * 10;
    p.recHot = (p.recHd > now && s.rate >= REC_HOT_UP) || (p.recHd < now && s.rate <= REC_HOT_DOWN);
  });
  return { teamInn, goalInn, n: base.length };
}

/* ══ 튀는 값 ══
   열마다 지금 표에 오른 사람들의 평균·표준편차를 내서, 평균에서 OUTLIER_Z 배 넘게 떨어진 칸을
   빨갛게 칠한다. 잘한 쪽이든 못한 쪽이든 '남들과 확 다른 값'이면 칠한다.
   2.0 은 열마다 한 명 나올까 말까 한 정도로 맞춘 값이다 (1.8 은 경계에 걸린 값까지 칠해
   잦았고, 1.5 면 열마다 두세 명씩 칠해져 강조가 무뎌진다).
   이름·수지·권장수지·경기수·승수는 실력 지표가 아니라 칠하지 않는다.

   대부분은 값의 '차이'로 견주지만, OUTLIER_LOG 열은 로그를 씌워 '배수'로 견준다.
   0 보다 큰 값만 나오고 위로 끝이 없으며 0 에 가까울수록 특별한 지표들이다 —
   기복 2.9% 는 17.6% 와 15 차이밖에 안 나지만 6분의 1 이라 눈에 띄는 값이다.
   반대로 0%·100% 가 자연스럽게 나오는 비율(승률·득점률·파울률·쿠션)이나 하이런 같은 작은
   정수는 차이로 보는 게 맞고, 0 이 있으면 로그를 씌울 수도 없다.
   에버리지는 경계선이다. 배수로 보면 맨 위가 아니라 입문자의 낮은 값(0.045 등)이 칠해져서
   '잘 치는 사람이 튄다'는 쓰임과 어긋나 차이로 둔다. */
const OUTLIER_Z = 2.0;
const OUTLIER_MIN_ROWS = 5;   // 이보다 적으면 표준편차가 뜻이 없다
const OUTLIER_SKIP = new Set(['name', 'handicap', 'recHd', 'games', 'wins']);
const OUTLIER_LOG = new Set(['volatility', 'avgInterval']);   // 기복 · 평균 인터벌
// 돌려주는 값: 열 키 → 그 열에서 튀는 선수 객체들의 Set
function outlierOf(rows, COLS){
  const out = new Map();
  if (rows.length < OUTLIER_MIN_ROWS) return out;
  const num = v => typeof v === 'number' && isFinite(v);
  for (const c of COLS) {
    if (OUTLIER_SKIP.has(c.k)) continue;
    const raw = rows.map(p => p[c.k]).filter(num);
    if (raw.length < OUTLIER_MIN_ROWS) continue;
    // 로그 열이라도 0 이하가 하나라도 있으면 로그를 못 씌우니 그 열은 차이로 견준다
    const useLog = OUTLIER_LOG.has(c.k) && raw.every(v => v > 0);
    const f = useLog ? Math.log : v => v;
    const vs = raw.map(f);
    const m = vs.reduce((a, b) => a + b, 0) / vs.length;
    const sd = Math.sqrt(vs.reduce((a, v) => a + (v - m) ** 2, 0) / vs.length);
    if (!(sd > 0)) continue;
    // 1e-9 — 딱 경계(z = OUTLIER_Z)에 걸친 값이 소수 오차로 빠지지 않게
    const hit = new Set(rows.filter(p => num(p[c.k]) && Math.abs(f(p[c.k]) - m) / sd >= OUTLIER_Z - 1e-9));
    if (hit.size) out.set(c.k, hit);
  }
  return out;
}
const isOut = (outs, p, k) => !!(outs.get(k) && outs.get(k).has(p));

function rankRows(mode, D){
  D = D || DATA;
  if(mode==='통합') return D.players.filter(p=>p.games>0 && p.id);
  return D.players
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

  return `<div class="podhead">${esc(col.t)}</div>${pod}${restHtml}`;
}

// 이미지 저장 버튼 + 안내 줄 — 포디움·순위표·홈 카드가 같은 모양을 쓴다
// 버튼 둘을 나란히 놓을 때는 cls2·label2 를 준다 (안내 줄은 첫 버튼 것을 같이 쓴다)
const saveBtnHtml = (cls, label, cls2, label2) => `<div style="text-align:center;margin-top:18px">
    <button class="mbtn ${cls}">📷 ${label}</button>
    ${cls2 ? `<button class="mbtn ${cls2}">📷 ${label2}</button>` : ''}
    <div class="sub ${cls}-msg" style="margin:8px 0 0;min-height:1.2em"></div>
  </div>`;
// 버튼을 누르면 make() 로 캔버스를 그려 저장한다. 그리는 동안 두 번 눌리지 않게 막는다.
// make() 는 [캔버스, 이름] 한 장, 또는 그 목록을 돌려준다. msgCls 는 안내 줄을 빌려 쓸 버튼.
function bindSaveBtn(el, cls, make, msgCls){
  const btn = el.querySelector('.' + cls);
  if (!btn) return;
  btn.onclick = async () => {
    const msg = el.querySelector('.' + (msgCls || cls) + '-msg');
    btn.disabled = true;
    if (msg) { msg.textContent = '이미지 만드는 중...'; msg.style.color = 'var(--muted)'; }
    try {
      const made = make();
      await saveImages(Array.isArray(made[0]) ? made : [made], msg);
    } catch(err){
      if (msg) { msg.textContent = '저장 실패: ' + err.message; msg.style.color = '#f44336'; }
    }
    btn.disabled = false;
  };
}

/* ══ 저장 이미지 공용 도구 (포디움 · 순위표 · 홈 카드) ══
   DOM 캡처 라이브러리(html2canvas 등)를 쓰지 않고 캔버스에 직접 그린다. 외부 의존성이
   없어야 하고(오프라인·CSP), 화면 그대로가 아니라 제목·기간을 넣은 공유용 카드가 낫기 때문.
   색은 지금 테마의 CSS 변수를 그대로 읽어 와 화면과 같은 톤으로 맞춘다. */
const IMG_FF = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const imgFont = (w, s, italic) => `${italic ? 'italic ' : ''}${w} ${s}px ${IMG_FF}`;
// 캔버스 크기를 정하기 전에 글자 폭부터 재야 할 때(순위표) 쓰는 측정 전용 컨텍스트
const imgMeasure = (() => {
  let m = null;
  return (s, f) => { m = m || document.createElement('canvas').getContext('2d'); m.font = f; return m.measureText(s).width; };
})();

function imgKit(W, H){
  const rootCS = getComputedStyle(document.documentElement);
  const v = (n, d) => (rootCS.getPropertyValue(n) || '').trim() || d;
  const C = { bg:v('--card','#ffffff'), text:v('--text','#1a1d21'), muted:v('--muted','#6b7280'),
              line:v('--line','#e5e7eb'), chip:v('--bg','#f6f7f9'), accent:v('--accent','#2563eb'),
              out:v('--out','#dc2626') };

  const S = 2;                                         // 2배로 그려서 선명하게
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * S); cv.height = Math.round(H * S);
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

  x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
  return { cv, x, C, roundRect, text, clip };
}

// 저장 이미지 머리말의 조건 줄 — 지금 화면에 걸린 모드·필터·기간을 그대로 적는다
function rankCondText(){
  const parts = [BALL, rankMode === '통합' ? '통산 기준' : rankMode + '전'];
  if (rankScope === 'recent') parts.push('최근 ' + recentN + '경기');
  else parts.push((rankFrom || rankTo) ? `${ddmy(rankFrom) || '처음'} ~ ${ddmy(rankTo) || '오늘'}` : '전체 기간');
  return parts.join('  ·  ');
}

/* ══ 포디움을 이미지로 ══ */
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

  // 금·은·동은 테마와 무관하게 고정 (화면 CSS 와 같은 값)
  const METAL = [ {top:'#ffeaa6', a:'#ffd75f', b:'#e0a112', num:'#8a5c00'},
                  {top:'#f0f3f6', a:'#dde2e8', b:'#aab2bd', num:'#525a65'},
                  {top:'#f6dcc4', a:'#e9bb92', b:'#c1854f', num:'#6d4520'} ];
  const font = imgFont;

  // 단 위에 올라가는 이름 줄 수 → 포디움 영역이 얼마나 높아야 하는지 결정한다
  const shown = g => Math.min(g.players.length, G.MAXNAMES) + (g.players.length > G.MAXNAMES ? 1 : 0);
  const maxNameLines = groups.length ? Math.max(...groups.map(shown)) : 0;
  const headH = 192;                                   // 제목 세 줄이 들어가는 영역
  const aboveH = maxNameLines * 30 + 52;               // 이름들 + 값 알약
  const floorY = headH + aboveH + G.H1;
  const restH = rest.length ? 22 + rest.length * G.ROW : 0;
  const H = Math.round(floorY + 18 + restH + 54);

  const { cv, x, C, roundRect, text, clip } = imgKit(G.W, H);
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

  // ── 제목 (세 줄: 앱 이름 / 지표 / 조건). 줄 간격을 넉넉히 벌린다 ──
  const cx = G.W / 2;
  text('당동 기록실', cx, 64, font(700, 20), C.muted, 'center');
  text(col.t, cx, 128, font(800, 38), C.text, 'center');
  text(rankCondText(), cx, 172, font(500, 17), C.muted, 'center');

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

/* ══ 순위표를 이미지로 ══
   화면은 지금 고른 정렬 기준대로지만, 이미지는 늘 이름순으로 모든 선수·모든 열을 한 장에 담는다.
   공유받은 사람이 자기 이름부터 찾아보는 용도라서다. 화면처럼 가로로 밀어 볼 수 없으니
   폭은 열 내용에 맞춰 늘어난다. */
function tableCanvas(rows, COLS){
  const list = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const PAD = 32, CELL = 12, ROW = 40, HROW = 44, HEAD = 184, FOOT = 64;
  const fH = imgFont(700, 15), fB = imgFont(500, 16), fBold = imgFont(700, 16);

  // 권장수지는 화면과 같이 지금 수지와 견준 화살표를 붙인다
  const recArrow = p => {
    if (p.recHd == null) return '';
    const now = (p.handicap || 0) * 10;
    return p.recHd > now ? '↑' : p.recHd < now ? '↓' : '';
  };
  const val = (p, c) => c.k === 'name' ? p.name
    : c.k === 'recHd' ? (p.recHd == null ? '—' : String(p.recHd))
    : String(cell(p, c));
  const cols = [{ k: '#', t: '' }, ...COLS];
  const fontOf = c => c.k === 'name' ? fBold : fB;
  const widths = cols.map(c => {
    let w = imgMeasure(c.t, fH);
    list.forEach((p, i) => {
      const s = c.k === '#' ? String(i + 1)
        : val(p, c) + (c.k === 'recHd' && recArrow(p) ? ' ' + recArrow(p) : '');
      w = Math.max(w, imgMeasure(s, fontOf(c)));
    });
    return Math.ceil(w) + CELL * 2;
  });
  const tableW = widths.reduce((a, b) => a + b, 0);
  const outs = outlierOf(list, COLS);   // 화면 표와 같은 기준으로 튀는 값을 빨갛게
  const title = rankMode === '통합' ? '순위표' : rankMode + '전 순위표';
  const cond = rankCondText() + '  ·  이름순';
  const W = Math.ceil(Math.max(560, tableW + PAD * 2, imgMeasure(cond, imgFont(500, 17)) + PAD * 2));
  const H = HEAD + HROW + list.length * ROW + FOOT;
  const { cv, x, C, roundRect, text } = imgKit(W, H);

  const cx = W / 2;
  text('당동 기록실', cx, 64, imgFont(700, 20), C.muted, 'center');
  text(title, cx, 128, imgFont(800, 38), C.text, 'center');
  text(cond, cx, 172, imgFont(500, 17), C.muted, 'center');

  const x0 = (W - tableW) / 2;
  // 칸 하나 그리기 — 이름은 왼쪽 정렬, 나머지는 가운데
  const drawRow = (y, h, cellText) => {
    let cxs = x0;
    cols.forEach((c, j) => {
      const w = widths[j];
      cellText(c, j, c.k === 'name' ? cxs + CELL : cxs + w / 2, y + h / 2 + 6, c.k === 'name' ? 'left' : 'center');
      cxs += w;
    });
  };

  // 머리줄
  const ty = HEAD;
  x.fillStyle = C.chip; roundRect(x0, ty, tableW, HROW, 10); x.fill();
  drawRow(ty, HROW, (c, j, px, py, al) => text(c.t, px, py, fH, C.muted, al));

  // 본문 — 한 줄 걸러 옅게 깔아 긴 가로줄도 눈으로 따라가기 쉽게
  list.forEach((p, i) => {
    const y = ty + HROW + i * ROW;
    if (i % 2 === 1) { x.fillStyle = C.chip; x.globalAlpha = .55; x.fillRect(x0, y, tableW, ROW); x.globalAlpha = 1; }
    x.fillStyle = C.line; x.fillRect(x0, y + ROW - 1, tableW, 1);
    drawRow(y, ROW, (c, j, px, py, al) => {
      if (c.k === '#') return text(String(i + 1), px, py, fB, C.muted, al);
      const s = val(p, c), ar = c.k === 'recHd' ? recArrow(p) : '';
      const color = c.k === 'name' ? C.text : s === '—' ? C.muted : isOut(outs, p, c.k) ? C.out : C.text;
      if (!ar) return text(s, px, py, fontOf(c), color, al);
      // 숫자 + 화살표(흐리게)를 한 덩어리로 가운데 맞춘다. 승률도 같은 방향이면 둘 다 빨갛게(화면과 같다)
      const sw = imgMeasure(s, fB), aw = imgMeasure(' ' + ar, fB);
      const left = px - (sw + aw) / 2;
      text(s, left, py, fB, p.recHot ? C.out : C.text, 'left');
      text(' ' + ar, left + sw, py, fB, p.recHot ? C.out : C.muted, 'left');
    });
  });

  text(todayYmd().replace(/-/g, '.') + ' 기준', cx, H - 26, imgFont(500, 15), C.muted, 'center');
  return cv;
}

/* ══ 홈 카드를 이미지로 ══
   지금 보이는 카드 한 장을 세로형(4:5) 공유 카드로 그린다. 화면 카드와 같은 순서·색:
   배지 → 이름 → 큰 숫자 → 라벨 → 증가폭 → 밑줄. */
function homeCardCanvas(s){
  const W = 720, H = 900, PAD = 56, MAXW = W - PAD * 2;
  const { cv, x, C, roundRect, text, clip } = imgKit(W, H);
  x.textBaseline = 'middle';

  // 큰 숫자는 HTML 로 들어온다(화살표·단위 span). 조각으로 나눠 조각마다 다른 글꼴로 그린다.
  const segs = [];
  let last = 0;
  String(s.big).replace(/<span class="(ar|un)">(.*?)<\/span>/g, (m, k, t, off) => {
    if (off > last) segs.push({ k: 'v', t: s.big.slice(last, off) });
    segs.push({ k, t });
    last = off + m.length;
  });
  if (last < String(s.big).length) segs.push({ k: 'v', t: String(s.big).slice(last) });
  const segFont = (k, z) => k === 'v' ? imgFont(800, 84 * z, true) : k === 'ar' ? imgFont(700, 48 * z) : imgFont(800, 42 * z);
  const segW = (g, z) => imgMeasure(g.t, segFont(g.k, z)) + (g.k === 'ar' ? 40 * z : g.k === 'un' ? 6 * z : 0);
  const bigW = z => segs.reduce((a, g) => a + segW(g, z), 0);
  const zoom = Math.min(1, MAXW / Math.max(1, bigW(1)));   // 넘치면 통째로 줄인다

  // 이름은 공동 1등이면 여럿이라 줄을 바꿔 가며 최대 3줄
  const fName = imgFont(800, 52);
  const nameLines = [];
  if (s.name) {
    x.font = fName;
    let cur = '';
    for (const w of s.name.split(' ')) {
      const t = cur ? cur + ' ' + w : w;
      if (cur && x.measureText(t).width > MAXW) { nameLines.push(cur); cur = w; } else cur = t;
    }
    if (cur) nameLines.push(cur);
  }
  const names = nameLines.slice(0, 3);

  // 블록 높이를 먼저 합쳐 세로 가운데에 놓는다
  const GAP = 22;
  const blocks = [['badge', 44]];
  names.forEach((n, i) => blocks.push(['name' + i, 62]));
  blocks.push(['big', 104 * zoom + 8], ['label', 36]);
  if (s.delta) blocks.push(['delta', 40]);
  if (s.foot) blocks.push(['foot', 28]);
  const total = blocks.reduce((a, b) => a + b[1], 0) + GAP * (blocks.length - 1);

  // 위쪽 강조 띠 (화면 카드의 진행 막대 자리)
  x.fillStyle = C.accent; x.fillRect(0, 0, W, 8);

  const cx = W / 2;
  let y = Math.max(40, (H - 60 - total) / 2);
  blocks.forEach(([k, h]) => {
    const my = y + h / 2;
    if (k === 'badge') {
      const f = imgFont(700, 19), bw = imgMeasure(s.badge, f) + 36;
      x.fillStyle = C.chip; roundRect(cx - bw / 2, y, bw, h, h / 2); x.fill();
      x.strokeStyle = C.line; x.lineWidth = 1; x.stroke();
      text(s.badge, cx, my + 1, f, C.muted, 'center');
    } else if (k.startsWith('name')) {
      text(clip(names[+k.slice(4)], fName, MAXW), cx, my, fName, C.text, 'center');
    } else if (k === 'big') {
      let px = cx - bigW(zoom) / 2;
      segs.forEach(g => {
        const pad = g.k === 'ar' ? 20 * zoom : g.k === 'un' ? 6 * zoom : 0;
        text(g.t, px + pad, my, segFont(g.k, zoom), g.k === 'ar' ? C.muted : C.accent, 'left');
        px += segW(g, zoom);
      });
    } else if (k === 'label') {
      text(clip(s.label, imgFont(700, 30), MAXW), cx, my, imgFont(700, 30), C.text, 'center');
    } else if (k === 'delta') {
      const f = imgFont(700, 22), dw = imgMeasure(s.delta, f) + 30;
      x.fillStyle = C.chip; roundRect(cx - dw / 2, y, dw, h, h / 2); x.fill();
      x.strokeStyle = C.line; x.lineWidth = 1; x.stroke();
      text(s.delta, cx, my + 1, f, C.accent, 'center');
    } else if (k === 'foot') {
      text(clip(s.foot, imgFont(500, 20), MAXW), cx, my, imgFont(500, 20), C.muted, 'center');
    }
    y += h + GAP;
  });

  text('당동 기록실 · ' + todayYmd().replace(/-/g, '.'), cx, H - 36, imgFont(600, 17), C.muted, 'center');
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
 *  그 외(데스크톱 등): 그냥 내려받기 (다운로드 폴더).
 *    ※ 윈도우 크롬·엣지도 파일 공유를 지원해서 canShare 만 보고 고르면 데스크톱에서
 *      저장 대신 윈도우 공유 창이 뜬다. 그래서 공유 시트는 iOS 에서만 쓴다.
 *
 *  여러 장을 한 번에 저장할 때: iOS 는 공유 시트 하나에 모두 담는다(시트는 버튼을 누를 때 한 번만
 *    열 수 있다). 나머지는 한 장씩 내려받되 간격을 둔다 — 한꺼번에 누르면 브라우저가 뒷장을 버린다.
 */
async function saveImages(items, msgEl){   // items: [[캔버스, 이름], ...]
  const say = (t, err) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = err ? '#f44336' : 'var(--muted)'; } };
  const files = [];
  for (const [cv, metricName] of items) {
    if (items.length > 1) say(`이미지 만드는 중... ${files.length + 1}/${items.length}`);   // 한 장에 1초 넘게 걸릴 수 있다
    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    if (!blob) { say('이미지를 만들지 못했습니다.', true); return; }
    // 홈 카드는 선수 이름이 파일명에 들어간다 — 파일명에 못 쓰는 글자는 걸러 낸다
    const fname = `당동_${metricName}_${todayYmd()}.png`.replace(/\s+/g, '').replace(/[\\/:*?"<>|]/g, '');
    files.push(new File([blob], fname, { type: 'image/png' }));
  }
  const count = files.length > 1 ? files.length + '장을 ' : '';

  const isAndroid = /Android/i.test(navigator.userAgent);
  // 아이패드는 사파리가 데스크톱 맥처럼 자기소개를 해서 터치 지원으로 가려낸다
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canShare = isIOS && !!(navigator.canShare && navigator.canShare({ files }));

  const download = file => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  if (!canShare) {
    try {
      for (let i = 0; i < files.length; i++) {
        if (i) {
          say(`저장하는 중... ${i + 1}/${files.length}`);
          await new Promise(res => setTimeout(res, 400));
        }
        download(files[i]);
      }
      say(count + (isAndroid ? '갤러리에 저장했습니다. (다운로드 앨범)' : '다운로드 폴더에 저장했습니다.'));
    } catch(e){
      say('저장에 실패했습니다.', true);
    }
    return;
  }
  try { await navigator.share({ files }); say(''); }
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
  // 최근 N경기 — 사람마다 그 모드의 최근 N경기만 다시 집계한다. N경기가 안 되는 사람은 있는 만큼 전부.
  const recent = rankScope === 'recent';
  const rows = (recent ? rankRows(rankMode, getRecentData(rankMode, recentN)) : rankRows(rankMode))
    .sort((a,b)=>{
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

  // 권장수지는 통합 성적으로만 낸다. 3인·4인은 게임 목표점수가 인원수만큼 줄어들어
  // (score/app.js 의 scaledTarget) 같은 이닝 기준을 그대로 댈 수 없기 때문이다.
  // 3구는 권장수지 기준(목표 이닝)을 아직 정하지 않았다 — 열도 colsFor 에서 빠진다.
  if (rankMode === '통합' && !is3()) attachRecHd(rows);
  
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
    const outs = outlierOf(rows, COLS);
    const body = rows.map((p,i)=>{
      const rk = rankOf[i];
      const medal = !ranked ? (i+1) : (['🥇','🥈','🥉'][rk-1] || rk);
      const tds = COLS.map(c=>{
        if(c.k==='name') return `<td class="name"><a class="pl" data-p="${esc(p.name)}">${esc(p.name)}</a></td>`;
        // 권장수지는 지금 수지와 견줘야 뜻이 산다 → 오르내림을 화살표로 같이 보여 준다
        if(c.k==='recHd'){
          if(p.recHd==null) return `<td class="rec">—</td>`;
          const now = (p.handicap||0)*10;
          const d = p.recHd>now ? '<span class="up">↑</span>' : p.recHd<now ? '<span class="dn">↓</span>' : '';
          // 승률도 같은 방향이면 빨갛게 (REC_HOT_UP / REC_HOT_DOWN). 눌러 두면 근거 승률이 보인다
          const tip = `최근 ${REC_MAX_GAMES}경기 승률 ${p.recRate.toFixed(1)}%`;
          return `<td class="rec${p.recHot ? ' out' : ''}" title="${tip}">${p.recHd}${d}</td>`;
        }
        return `<td${isOut(outs, p, c.k) ? ' class="out"' : ''}>${cell(p, c)}</td>`;
      }).join('');
      return `<tr><td class="rk">${medal}</td>${tds}</tr>`;
    }).join('');
    inner = `<div class="scroll"><table class="rank"><thead><tr><th class="rk"></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  // 표는 지금 정렬과 상관없이 이름순·전체 열로 저장된다 (tableCanvas) — 버튼에도 그렇게 적어 둔다
  if (rows.length) inner += rankView === 'podium'
    ? saveBtnHtml('p-save', '이미지로 저장')
    : saveBtnHtml('p-save', '이미지로 저장 (이름순)');
  // 지표 선택 — 포디움엔 누를 표 제목이 없으므로 셀렉트로 고른다.
  const metricSel = rankView!=='podium' ? '' :
    `<select class="field p-metric" style="width:100%; height:32px; padding:0 26px 0 10px; font-size:0.85rem; border-radius:999px; margin:6px 0 0;">` +
    podiumCols(COLS).map(c=>`<option value="${c.k}" ${c.k===sortKey?'selected':''}>${esc(c.t)}</option>`).join('') +
    `</select>`;
  const viewBtns = `<div class="seg">
      <button class="p-view ${rankView==='table'?'on':''}" data-v="table">표</button>
      <button class="p-view ${rankView==='podium'?'on':''}" data-v="podium">포디움</button>
    </div>`;

  const note = rankView==='podium'
    ? '지표를 고르면 그 기준으로 세웁니다.'
      // 인터벌만 방향이 거꾸로다 — 왜 값이 작은 사람이 1등인지 한 줄로 알려 준다
      + (sortKey==='avgInterval' ? ' <b>평균 인터벌</b>은 짧을수록 1등입니다.' : '')
    : (rankMode==='3인'||rankMode==='4인')
      ? '표 제목을 누르면 정렬됩니다. · <b>평균순위</b>는 동순위를 분수로 계산합니다(공동 2등 = 2.5등).'
      : '표 제목을 누르면 그 기준으로 정렬됩니다.'
        // 권장수지 빨간 글씨의 뜻 — 통합 표에만 권장수지 열이 있다
        + (rankMode === '통합' && !is3() ? ` · <b>권장수지</b>가 빨간색이면 최근 승률도 같은 쪽(${REC_HOT_UP}% 이상 / ${REC_HOT_DOWN}% 이하)이라 수지를 고칠 때입니다.` : '');
  // 집계 범위 — 기간이면 달력 칸, 경기 수면 같은 자리에 '최근 [N]경기' 칸이 들어간다.
  // 겉모양은 달력 칸과 맞추고, 숫자만 직접 적는다.
  const scopeBtns = `<div class="seg">
      <button class="p-scope ${recent?'on':''}" data-s="recent">경기 수</button>
      <button class="p-scope ${!recent?'on':''}" data-s="period">기간</button>
    </div>`;
  const scopeRow = !recent ? rangeRowHtml('p-period', rankFrom, rankTo, modeSel)
    : `<div style="display:flex; align-items:center; gap:6px;">${modeSel}
        <label style="flex:1 1 0; min-width:0; height:34px; display:flex; align-items:center; justify-content:center; gap:6px; padding:0 8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font-size:0.9rem; white-space:nowrap; cursor:text;">
          최근
          <input class="p-recent" type="number" inputmode="numeric" min="1" step="1" value="${recentN}" aria-label="최근 경기 수"
            style="width:64px; height:26px; padding:0 6px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); font-size:0.9rem; text-align:center;">
          경기
        </label></div>`;
  const el = $(`<div class="card">
      <div style="margin-bottom:14px;">
        ${scopeRow}
        <div class="toolrow">${viewBtns}<div class="push tgrp">${scopeBtns}</div></div>
        ${metricSel}
      </div>
      ${inner}
      <div class="sub" style="margin:10px 0 0">${note}</div></div>`);
  if (!recent) bindRangePicker(el, 'p-period', { max: todayYmd(), allowClear: true, aria: '조회 기간' });

  const applyRankRange = () => {
    rankFrom = el.querySelector('.p-period-from').value;
    rankTo = el.querySelector('.p-period-to').value;
    DATA = getFilteredData();
    updateSub();
    show('rank');
  };
  if (!recent) {
    el.querySelector('.p-period-from').onchange = applyRankRange;
    el.querySelector('.p-period-to').onchange = applyRankRange;
  } else {
    // 칠 때마다 다시 그리면 입력칸이 새로 만들어져 포커스가 날아간다 → 다 적고 나서(엔터·포커스 이탈) 반영
    const inp = el.querySelector('.p-recent');
    inp.onchange = () => {
      const n = Math.floor(Number(inp.value));
      if (!(n >= 1)) { inp.value = recentN; return; }   // 비우거나 0·음수면 원래 값으로 되돌린다
      recentN = n;
      show('rank');
    };
    inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };   // 폰 키패드의 완료/엔터로 바로 반영
  }
  // 범위를 바꿔도 고른 기간(rankFrom/To)은 지우지 않는다 — 경기 탭이 같은 기간을 쓰고, 돌아오면 그대로 있다
  el.querySelectorAll('.p-scope').forEach(b => b.onclick = () => {
    if (rankScope === b.dataset.s) return;
    rankScope = b.dataset.s;
    show('rank');
  });

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
  bindSaveBtn(el, 'p-save', () => {
    if (rankView !== 'podium') return [tableCanvas(rows, COLS), (rankMode === '통합' ? '' : rankMode + '전') + '순위표'];
    const col = COLS.find(c => c.k === sortKey) || COLS[0];
    return [podiumCanvas(rows, rankOf, COLS), col.t];
  });
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

// 선수 상세의 추이 그래프 — 하루치 경기를 calcStatsForHistory 로 묶어 val 로 한 점을 뽑는다.
// val 이 null 이면 그날 점은 뺀다(평균 타수는 파울이 기록된 경기가 없는 날엔 계산 불가).
const METRICS = [
  {k:'avg', t:'에버리지', modes:MODE_TABS, dec:2, val:s=>s.avgAvg, desc:'평균 에버리지 (총 득점 / 알 이닝)'},
  {k:'streak', t:'평균 타수', modes:MODE_TABS, dec:2, val:s=>s.streakAvg, desc:'평균 타수 (파울 차감 전 득점 / 득점한 알 이닝)'},
  {k:'hit', t:'득점률', modes:MODE_TABS, max:100, suffix:'%', dec:0, val:s=>s.hitRate, desc:'평균 득점률 (알 이닝 중 점수를 낸 이닝 비율)'},
  {k:'adj', t:'보정 승률', modes:MODE_TABS, max:100, suffix:'%', dec:1, val:s=>s.adjRate, desc:'평균 보정 승률'},
  {k:'games', t:'경기수', modes:MODE_TABS, dec:0, val:s=>s.games, desc:'총 경기수'},
  {k:'cush', t:'쿠션 성공률', modes:MODE_TABS, max:100, suffix:'%', dec:0, val:s=>s.cushRate ?? 0, desc:'쿠션 성공률'},
  {k:'hr', t:'하이런', modes:MODE_TABS, dec:0, val:s=>s.bestHr, desc:'최고 하이런'},
  {k:'winRate', t:'승률', modes:['2인','팀전'], max:100, suffix:'%', dec:0, val:s=>s.winRate, desc:'평균 승률'},
  {k:'avgRank', t:'평균 순위', modes:['3인','4인'], dec:1, invert:true, min:1, max:4, val:s=>s.avgRank ?? 0, desc:'평균 순위'}
];

/* 기대 이닝 — 수지만큼 알을 빼고 마무리 쿠션 1개를 성공하기까지 평균 몇 이닝이 드는가.
     알 이닝   = 수지 저장값(= 2인 목표점수) ÷ 에버리지
     쿠션 이닝 = 100 ÷ 쿠션 성공률(%)   ← 매 이닝 같은 확률로 시도해 처음 성공할 때까지(기하분포의 평균)
     기대 이닝 = 알 이닝 + 쿠션 이닝 − 1
   목표를 채운 이닝은 알 이닝이기도 하고 쿠션을 쳐볼 수 있는 이닝이기도 해서 양쪽에 다 세인다
   (score/app.js 의 closeInning) → 겹친 1이닝을 뺀다. 그래서 쿠션 성공률 100% 면 알 이닝과 같다.
   3구는 마무리 쿠션이 없어 알 이닝만이다. 쿠션 기록이 없거나 한 번도 성공 못 했으면 셀 수 없다(null). */
function expInnOf(hd, avg, cushRate){
  if (!(hd > 0 && avg > 0)) return null;
  const ball = hd / avg;
  if (is3()) return ball;
  return cushRate > 0 ? ball + 100 / cushRate - 1 : null;
}

// 경기 이력(processData 가 만든 history 줄들) → 지표 한 벌. 순위표(통합·모드별)와 선수 상세가 함께 쓴다.
// hd(수지 저장값)를 주면 기대 이닝도 낸다 — 주지 않으면 expInn 은 null.
function calcStatsForHistory(h, hd) {
  const games = h.length;
  const wins = h.filter(r => r.win).length;
  // f* = 파울이 기록된 경기만 (평균 타수·파울률용) — 파울 수를 모르면 분자(파울 차감 전 득점)를 복원할 수 없다
  let fBallInn = 0, fMiss = 0, fGross = 0, fFoul = 0;
  let sumBallInn = 0, sumScore = 0, totalMisses = 0, maxHr = 0, cushMade = 0, cushInn = 0, sumTime = 0, sumShots = 0, sumAdjPt = 0, rankSum = 0;
  const avgs = [];   // 경기별 에버리지 (기복 계산용)

  h.forEach(r => {
    sumBallInn += (r.ballInn || 0);     // 알 이닝 — 에버·득점률·평균타수의 분모 (마무리 쿠션만 친 이닝은 빠져 있다)
    sumScore += (r.score || 0);
    if (r.foul != null) { fBallInn += (r.ballInn || 0); fMiss += (r.miss || 0); fGross += (r.score || 0) + r.foul; fFoul += r.foul; }
    totalMisses += (r.miss || 0);
    if ((r.highRun || 0) > maxHr) maxHr = r.highRun;
    cushMade += (r.cushMade || 0);
    cushInn += (r.cushInn || 0);
    sumAdjPt += (r.adjPt || 0);
    rankSum += (r.rank || 0);
    if (r.ballInn > 0) avgs.push(r.score / r.ballInn);
    if (r.timeMs > 0) {
      sumTime += r.timeMs;
      sumShots += Math.max(1, r.score + r.inning);   // 총 이닝(알 + 쿠션) — 인터벌용
    }
  });

  const avgAvg = sumBallInn > 0 ? (sumScore / sumBallInn) : 0;
  const cushRate = cushInn > 0 ? (cushMade / cushInn) * 100 : null;
  return {
    games,
    wins,
    winRate: games > 0 ? (wins / games) * 100 : 0,
    // 에버 = 총득점 / 알 이닝
    avgAvg,
    bestHr: maxHr,
    hitRate: sumBallInn > 0 ? ((sumBallInn - totalMisses) / sumBallInn) * 100 : 0,
    // 평균 타수 = (파울 차감 전 득점) / 득점한 알 이닝. 파울이 기록되기 전 경기는 아예 뺀다.
    // 파울 수를 모르면 분자를 복원할 수 없어 실제보다 낮게 나오기 때문. 해당 경기가 없으면 null.
    streakAvg: (fBallInn - fMiss) > 0 ? (fGross / (fBallInn - fMiss)) : null,
    // 파울률 = 파울 / 총 타격수. 타격은 두 종류뿐이라 이렇게 센다:
    //   · 득점한 타격 = 파울 차감 전 득점(fGross)  — 1점당 1타격
    //   · 실패한 타격 = 알 이닝 수(fBallInn)       — 알 이닝은 공타 아니면 파울로 끝난다
    //
    // '공타'를 분모로 쓰면 안 된다. 공타는 빗맞힌 타격 수가 아니라 '한 점도 못 낸 이닝 수'다
    // (score/app.js 의 closeInning: isMiss && tp===0 일 때만 센다). 그래서 3점 뽑고 실패한 이닝의
    // 마지막 타격이 통째로 빠지고, 반대로 무득점 이닝의 파울은 공타로도 세여 이중 계상된다.
    //
    // 한계: 목표를 채우며 끝난 이닝은 실패 타격이 없는데도 fBallInn 에 들어가므로 분모가 경기당 최대
    // 1 만큼 크다(≈ 실제보다 3% 낮게 나옴). 완주 여부는 저장된 값으로 팀전에서 가려낼 수 없어
    // (score 는 개인 점수, target 은 팀 목표) 보정하지 않는다 — 모드별로 다르게 틀리는 게 더 나쁘다.
    foulRate: (fGross + fBallInn) > 0 ? (fFoul / (fGross + fBallInn)) * 100 : null,
    // 쿠션 성공률 = 마무리 쿠션 성공 / 쿠션을 시도한 이닝. 시도가 없으면 null
    cushRate,
    expInn: expInnOf(hd, avgAvg, cushRate),
    // 평균 인터벌 = 1샷(타석) 당 평균 소모 시간(초). 공타/파울 횟수까지 포함
    avgInterval: sumShots > 0 ? (sumTime / sumShots) / 1000 : null,
    // 기복 = 경기별 에버리지의 변동계수(%). 2경기 미만이면 null
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

  // 선수별 원지표 — processData 가 이미 낸 통산 지표를 그대로 쓴다.
  // (축마다 팀 안의 z-score 로 바꾸므로 % 단위든 비율이든 결과는 같다)
  const metricsOf = p => ({
    streak: p.streakAvg,   // 평균 타수
    hit:    p.hitRate,     // 득점률
    // ② 쿠션↔알: 마무리 쿠션 성공률 ÷ 전체 에버리지 (쿠션 1·2개 게임 보정)
    cushRatio: (p.cushRate != null && p.avgAvg > 0) ? p.cushRate / p.avgAvg : null,
    // ③ 안정↔기복: 경기별 에버리지의 변동계수
    volatility: p.volatility
  });

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
  // 3구엔 마무리 쿠션이 없다 → '쿠션↔알' 축은 뺀다
  const rows = t.axes.filter(a => !(is3() && a.L === '쿠션')).map(a => {
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
  // 통산 기록에서 찾는다 — 순위 탭에 걸린 기간과 상관없이 이 화면의 기간 칸이 따로 거른다.
  // (DATA 에서 찾으면 '최근 N경기'로 넘어왔을 때 '전체 기간'이라 적어 놓고 옛 기간만 보여 줬다)
  const p = getFullProcessData().players.find(v=>v.name===name)
         || { name, id: null, handicap: 0, history: [] };
  let playerMode = '통합';
  let chartCur = 'avg';
  // 순위를 '최근 N경기'로 보다 넘어왔으면 순위 탭의 기간은 걸려 있지 않은 셈이라 전체 기간으로 연다
  let playerFrom = rankScope === 'recent' ? '' : rankFrom;
  let playerTo = rankScope === 'recent' ? '' : rankTo;

  // 권장수지 — 순위표와 똑같은 값(통산 최근 경기 기준)이라 기간·모드를 바꿔도 흔들리지 않는다.
  // 그래서 아래 성적 칸이 아니라 지금 수지 옆, 한 번만 그리는 머리말에 붙인다.
  // handicap 도 넘긴다 — 승률 확신 표시(recHot)가 지금 수지와 견줘 방향을 본다
  // (3구는 권장수지를 아직 내지 않는다)
  const recRow = [{ id: p.id, handicap: p.handicap }];
  if (!is3()) attachRecHd(recRow);
  const recHd = recRow[0].recHd;
  const nowHd = (p.handicap || 0) * (is3() ? 1 : 10);
  const recStr = recHd == null ? '' :
    ' · 권장수지 <span' + (recRow[0].recHot ? ' class="rec-hot"' : '') + '>' + recHd +
    (recHd > nowHd ? '<span class="up">↑</span>' : recHd < nowHd ? '<span class="dn">↓</span>' : '') + '</span>';

  const el = $(`<div>
    <button class="back">← 순위로</button>
    <div class="card">
      <h2 style="margin:0">${esc(p.name)}</h2>
      <div class="sub" style="margin:2px 0 10px">${BALL} 수지 ${nowHd || '—'}${recStr}</div>
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
          <th>${is3() ? '이닝' : '알이닝'}</th><th>에버</th><th>하이런</th><th>결과</th></tr></thead>
        <tbody id="pHist"></tbody></table></div></div>
  </div>`);

  el.querySelector('.back').onclick=()=>show('rank');
  el.querySelector('#tendArea').innerHTML = renderTendency(p.name);
  bindRangePicker(el, 'pd-period', { max: todayYmd(), allowClear: true, aria: '조회 기간' });
  let lastW = 0;

  // 지금 고른 기간·모드에 걸리는 경기들 (history[0] 이 가장 최근)
  const curHist = () => p.history.filter(r =>
    (!(playerFrom || playerTo) || inRange(r.date, playerFrom, playerTo)) && (playerMode === '통합' || r.type === playerMode));

  const renderMode = () => {
    const h = curHist();

    if (h.length === 0) {
      el.querySelector('#pStats').innerHTML = '<div class="empty" style="width:100%; text-align:center; padding: 20px 0; color:var(--muted)">이 기간 동안 치러진 경기가 없습니다.</div>';
      el.querySelector('#chartArea').style.display = 'none';
      el.querySelector('#pHist').innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">기록 없음</td></tr>';
      return;
    }

    // 권장수지는 기간·모드를 따라 움직이지 않는 값이라 이 성적 칸에는 넣지 않는다(머리말에 따로 있다)
    const COLS = colsFor(playerMode).filter(c => c.k !== 'name' && c.k !== 'handicap' && c.k !== 'recHd');
    const stObj = calcStatsForHistory(h, p.handicap);
    
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

    const availableMetrics = METRICS.filter(m => m.modes.includes(playerMode) && !(is3() && m.k === 'cush'));
    const sel = el.querySelector('#pMetricSel');
    sel.innerHTML = availableMetrics.map(m => `<option value="${m.k}">${m.t}</option>`).join('');
    if (!availableMetrics.find(m => m.k === chartCur)) chartCur = availableMetrics[0].k;
    sel.value = chartCur;
    sel.onchange = e => draw(e.target.value);

    draw(chartCur);
  };

  // 추이 그래프 — 하루 한 점. 그날 친 경기들을 한 묶음으로 지표를 낸다.
  const draw = key => {
    chartCur = key;
    const m = METRICS.find(v=>v.k===key);
    const box = el.querySelector('#cbox');
    lastW = box.clientWidth || innerWidth-64;

    const days = new Map();   // 날짜 → 그날 경기들 (오래된 날부터)
    for (const r of [...curHist()].reverse()) {
      if (!days.has(r.date)) days.set(r.date, []);
      days.get(r.date).push(r);
    }
    const labels = [], vals = [];
    for (const [date, rs] of days) {
      const v = m.val(calcStatsForHistory(rs));
      if (v == null) continue;          // 값이 없는 날은 점 자체를 뺀다
      labels.push(date.slice(5));       // MM-DD
      vals.push(v);
    }

    box.innerHTML = chart(vals, labels, {...m, W: lastW});
    el.querySelector('#cdesc').textContent = '해당 일별 ' + m.desc;
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
    // 수지는 화면의 p.handicap(지금 공 종류 값)이 아니라 원본 명단에서 4구·3구를 따로 읽는다 —
    // 3구 화면에서 p.handicap 을 4구 칸에 넣으면 3구 값이 4구 수지를 덮어쓴다.
    const mem = memberOf(p.id) || {};
    const adm = $(`<div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🛠 관리자: 선수 정보 수정</h3>
      <div class="sub" style="margin:0 0 8px">이름을 바꾸면 순위·기록에 새 이름으로 표시됩니다. 4구 수지는 저장값 기준(15 = 수지 150), 3구 수지는 목표 점수 그대로입니다.</div>
      <input id="admName" class="field" maxlength="10" value="${esc(p.name)}" placeholder="이름">
      <input id="admHd" class="field" type="number" value="${mem.handicap ?? ''}" placeholder="4구 수지 저장값 (예: 15)">
      <input id="admHd3" class="field" type="number" value="${mem.handicap3 ?? ''}" placeholder="3구 수지 (예: 20)">
      <button class="mbtn on" id="admSave">저장</button>
    </div>`);
    adm.querySelector('#admSave').onclick = async e => {
      const name = adm.querySelector('#admName').value.trim();
      const hd = parseInt(adm.querySelector('#admHd').value, 10);
      const hd3 = parseInt(adm.querySelector('#admHd3').value, 10);
      if (!name) return alert('이름을 입력하세요');
      e.target.disabled = true;
      try {
        if (!p.id) throw new Error('계정이 없는 선수(직접 입력)는 이름을 바꿀 수 없어요');
        await adminApi.renamePlayer(p.id, name, isNaN(hd) ? null : hd);   // 프로필 + 모든 경기 이름 갱신 (4구 수지)
        const nv3 = isNaN(hd3) ? null : hd3;
        if (nv3 !== (mem.handicap3 ?? null)) await saveHandicap3(p.id, nv3);   // 3구 수지는 바뀌었을 때만
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
    if(Math.abs(es[0].contentRect.width - lastW) > 2) draw(chartCur);
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
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; opacity:0.8;">4구 수지</label>
    <select id="meHandicap" class="field">
      <option value="">선택하세요</option>
      ${HD_OPTIONS.map(v => `<option value="${v/10}">${v}</option>`).join('')}
    </select>
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; opacity:0.8;">3구 수지 (목표 점수)</label>
    <select id="meHandicap3" class="field">
      <option value="">선택하세요</option>
      ${HD3_OPTIONS.map(v => `<option value="${v}">${v}</option>`).join('')}
    </select>
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; margin-top:12px; opacity:0.8;">비밀번호 변경 (변경할 때만 입력)</label>
    <input type="password" id="mePwd" class="field" placeholder="새 비밀번호 입력">
    <div id="meMsg" style="margin-bottom:16px; font-size:0.95rem; font-weight:bold; height:20px;"></div>
    <button id="meSave" class="bigbtn">저장하기</button>
    <button id="meLogout" class="obtn ghost" style="margin-top:12px; width:100%; border:1px solid var(--line); color:#f44336;">로그아웃</button>
  </div>`;
  // 우선 받아 둔 명단으로 채우고(4구·3구 따로), 프로필을 읽어 오면 그걸로 덮는다
  const mine = memberOf(auth.uid) || {};
  let saved3 = mine.handicap3 ?? null;   // 3구 수지는 바뀌었을 때만 저장한다
  d.querySelector('#meName').value = auth.name || '';
  d.querySelector('#meHandicap').value = mine.handicap ?? '';
  setSelVal(d.querySelector('#meHandicap3'), saved3);

  fetchProfile(auth.uid).then(r => {
    if (!r) return;
    if (r.display_name) d.querySelector('#meName').value = r.display_name;
    if (r.handicap) d.querySelector('#meHandicap').value = r.handicap;
    if ('handicap3' in r) { saved3 = r.handicap3 ?? null; setSelVal(d.querySelector('#meHandicap3'), saved3); }
  }).catch(()=>{});
  d.querySelector('#meSave').onclick = async () => {
    const btn = d.querySelector('#meSave'), msg = d.querySelector('#meMsg'), name = d.querySelector('#meName').value.trim(), hd = d.querySelector('#meHandicap').value.trim(), pwd = d.querySelector('#mePwd').value;
    const hd3 = d.querySelector('#meHandicap3').value ? Number(d.querySelector('#meHandicap3').value) : null;
    const fail = t => { msg.textContent = '❌ ' + t; msg.style.color = '#f44336'; };
    btn.disabled = true; msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      if (!name) { fail('이름을 입력하세요.'); btn.disabled = false; return; }
      // 이름·4구 수지 변경 + 내가 뛴 모든 경기의 저장 이름을 서버에서 한 번에 갱신
      await adminApi.renamePlayer(auth.uid, name, hd ? parseInt(hd,10) : null);
      patchAuth({ name });   // 위 요청이 토큰을 갱신했을 수 있다 — 저장본에 이름만 고쳐 넣는다
      if(pwd) await sbFetch('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password: pwd }) });
    } catch(e) { fail('저장 실패. 다시 로그인해 보세요.'); btn.disabled = false; return; }
    // 3구 수지는 따로 저장한다 — 실패해도 위에서 저장한 이름·4구 수지는 살아 있으니 이유만 알린다
    try {
      if (hd3 !== saved3) { await saveHandicap3(auth.uid, hd3); saved3 = hd3; }
      msg.textContent = '✅ 성공적으로 저장되었습니다.'; msg.style.color = '#4CAF50'; d.querySelector('#mePwd').value = '';
    } catch(e) { fail('3구 수지를 저장하지 못했습니다: ' + e.message); }
    try { await reloadData(); } catch(e){}   // 바뀐 이름·수지를 순위·경기 화면에 즉시 반영
    btn.disabled = false;
  };
  
  d.querySelector('#meLogout').onclick = async () => {
    await logout();   // 알림 구독을 이 계정에서 떼고 로그인·소속 팀을 지운다 (다른 로그아웃 버튼과 같다)
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

// ══ 관리자 메뉴 (방문 기록 · 전체 회원/소속 팀/알림 상태 · 테스트 알림) ══
// 설정 창의 '👑 관리자 메뉴' 버튼으로 들어온다 (common.js 의 initAdminEntry).
// 방문 기록(sql/app-visits.sql)은 많이 들어온 순으로 따로 본다 — 회원 칸에 섞으면 누가 많이 쓰는지 한눈에 안 보인다.
// 알림 상태(sql/admin-push-status.sql)는 회원 한 사람 칸에 소속 팀과 함께 적는다.
// 방문·알림은 곁들이는 정보라 그쪽 서버 함수가 없거나 실패해도 회원 목록은 그대로 보여 준다.
const admWhen = iso => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const admDay = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
// 함수가 아직 없으면(SQL 을 안 돌렸으면) 무엇을 해야 하는지 알려 준다
const admMissing = (e, fn, file) => new RegExp(fn + '|function|404', 'i').test(e.message + ' ' + e.status)
  ? `${file} 을 SQL Editor 에서 실행하면 보입니다` : '불러오지 못했습니다';

async function renderAdminMenu(){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const el = $(`<div>
    <button class="back">← 기록실로</button>
    <div class="card">
      <h2 style="margin:0 0 12px 0; font-size:1.3rem;">📊 방문 기록</h2>
      <div class="setseg" id="admVisitSpan" style="margin-bottom:10px;">
        <button data-d="1">24시간</button><button data-d="7" class="on">7일</button><button data-d="30">30일</button><button data-d="">전체</button>
      </div>
      <div id="admVisitMsg" style="color:var(--muted); font-size:0.9rem;">불러오는 중...</div>
      <div id="admVisitList" style="display:flex; flex-direction:column; margin-top:8px;"></div>
      <div style="color:var(--muted); font-size:0.78rem; line-height:1.5; margin-top:10px;">30분 넘게 안 쓰다가 다시 열면 1번으로 셉니다. 새로고침이나 화면 이동은 세지 않고, 로그인한 사람만 셉니다.</div>
    </div>
    <div class="card">
      <h2 style="margin:0 0 12px 0; font-size:1.3rem;">👑 관리자 메뉴 (회원 및 소속팀)</h2>
      <div id="adminRosterMsg" style="color:var(--muted); font-size:0.9rem; line-height:1.6;">불러오는 중...</div>
      <div id="adminRosterList" style="display:flex; flex-direction:column; gap:12px; margin-top:12px;"></div>
      <div style="color:var(--muted); font-size:0.78rem; line-height:1.5; margin-top:12px;">알림: 폰 설정에서 알림을 막았거나 앱을 지운 기기는 다음 알림이 실패해 정리되기 전까지 '켬'으로 보일 수 있습니다. 확실히 보려면 아래 테스트 알림을 보내 보세요.</div>
    </div>
    <div class="card">
      <h2 style="margin:0 0 12px 0; font-size:1.3rem;">🔔 테스트 알림</h2>
      <select id="admTestTarget" class="field" style="margin-bottom:10px;">
        <option value="me">나에게 (내 기기 전부)</option>
        <option value="all">알림을 켠 모든 기기</option>
      </select>
      <button id="admTestSend" class="bigbtn">테스트 알림 보내기</button>
      <div id="admTestMsg" style="font-size:0.9rem; margin-top:10px; color:var(--muted);"></div>
      <div id="admTestList" style="display:flex; flex-direction:column; margin-top:6px;"></div>
    </div>
  </div>`);

  el.querySelector('.back').onclick = () => show('home');
  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);

  const container = el.querySelector('#adminRosterList');
  const msg = el.querySelector('#adminRosterMsg');
  let members = [], push = null;          // null = 못 읽음 (이유는 pushErr)
  let pushErr = '';

  // 방문 기록 — 기간 버튼을 누를 때마다 서버에서 다시 센다. 서버가 많이 들어온 순으로 준다.
  // 그 기간에 한 번도 안 들어온 사람도 0회로 흐리게 보여 준다 — 안 들어오는 사람을 찾는 것도 쓸모라서.
  const vMsg = el.querySelector('#admVisitMsg'), vList = el.querySelector('#admVisitList');
  const spanBtns = el.querySelectorAll('#admVisitSpan button');
  const loadVisits = async days => {
    vMsg.textContent = '불러오는 중...'; vList.innerHTML = '';
    try {
      const rows = await sbFetch('/rest/v1/rpc/admin_visit_stats', {
        method: 'POST', body: JSON.stringify({ p_days: days ? Number(days) : null })
      }) || [];
      const sum = rows.reduce((a, r) => a + Number(r.visits), 0);
      const who = rows.filter(r => Number(r.visits) > 0).length;
      vMsg.textContent = `${who}명이 총 ${sum}번 들어왔습니다`;
      vList.innerHTML = rows.map(r => `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px; padding:8px 2px; border-top:1px solid var(--line);${Number(r.visits) ? '' : ' opacity:.5;'}">
          <span style="font-weight:600;">${esc(r.display_name || '이름 없음')}</span>
          <span style="font-size:0.85rem; color:var(--muted); white-space:nowrap;">
            <b style="color:var(--text); font-size:0.95rem;">${Number(r.visits)}회</b>${r.last_visit ? ` · 마지막 ${admWhen(r.last_visit)}` : ''}
          </span>
        </div>`).join('');
    } catch(e) {
      vMsg.textContent = '방문 기록: ' + admMissing(e, 'admin_visit_stats', 'sql/app-visits.sql');
    }
  };
  spanBtns.forEach(b => b.onclick = () => {
    spanBtns.forEach(x => x.classList.toggle('on', x === b));
    loadVisits(b.dataset.d);
  });
  loadVisits('7');

  const loadPush = async () => {
    try {
      const rows = await sbFetch('/rest/v1/rpc/admin_push_status', { method: 'POST', body: '{}' }) || [];
      push = new Map(rows.map(r => [r.user_id, r.devices || []])); pushErr = '';
    } catch(e) { push = null; pushErr = admMissing(e, 'admin_push_status', 'sql/admin-push-status.sql'); }
  };
  const loadMembers = async () => {
    try {
      members = await sbFetch('/rest/v1/rpc/admin_get_all_members', { method: 'POST', body: JSON.stringify({}) }) || [];
    } catch(rpcErr) {
      const profs = await sbFetch('/rest/v1/profiles?select=id,display_name,handicap,team_members(team_id,is_admin,teams(id,name,join_code))&order=display_name');
      members = (profs || []).map(p => ({
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
  };

  const render = () => {
    // 맨 위 요약 — 회원 수 · 알림 켠 사람
    const onCnt = push ? members.filter(m => (push.get(m.user_id) || []).length).length : null;
    msg.innerHTML = `총 <b>${members.length}명</b>의 회원`
      + `<br>🔔 알림 ${push ? `켠 사람 <b>${onCnt}명</b> · 끈 사람 ${members.length - onCnt}명` : `— ${esc(pushErr)}`}`;

    container.innerHTML = members.map(m => {
      const name = m.display_name || '이름 없음';
      const teams = Array.isArray(m.teams) ? m.teams : [];

      const teamChips = teams.length === 0
        ? `<span style="font-size:0.85rem; color:var(--muted);">(소속 팀 없음)</span>`
        : teams.map(t => `<button class="adm-team-chip" data-tid="${esc(t.id)}" data-tname="${esc(t.name)}" data-tcode="${esc(t.join_code||'')}" style="padding:4px 10px; border-radius:6px; background:var(--card2); color:var(--accent); border:1px solid var(--line); font-size:0.85rem; font-weight:600; cursor:pointer; margin-right:6px; margin-top:4px;">${esc(t.name)}${t.is_admin ? ' 👑' : ''}</button>`).join('');

      // 알림 — 켠 기기마다 종류·앱·켠 날짜
      const devs = push ? (push.get(m.user_id) || []) : null;
      const pushLine = !push ? ''
        : devs.length
          ? `<div style="font-size:0.85rem;">🔔 ${devs.map(d => `${esc(d.label || '기기')} · ${d.beta ? '테스트 앱' : '본 앱'}`
              + `<span style="color:var(--muted);"> (${admDay(d.since)}~)</span>`).join(', ')}</div>`
          : `<div style="font-size:0.85rem; color:var(--muted);">🔕 알림 꺼짐</div>`;

      return `<div style="padding:12px; border-radius:10px; background:var(--bg); border:1px solid var(--line); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <a class="adm-pl-name" data-uid="${esc(m.user_id)}" style="font-weight:700; font-size:1.05rem; color:var(--text); text-decoration:underline; cursor:pointer;">👤 ${esc(name)}</a>
          <span style="font-size:0.8rem; color:var(--muted);">4구 수지 ${m.handicap ? m.handicap*10 : '—'}</span>
        </div>
        <div style="font-size:0.85rem; display:flex; flex-wrap:wrap; align-items:center; gap:4px;">
          <span style="color:var(--muted); font-size:0.8rem; margin-right:4px;">소속팀:</span>
          ${teamChips}
        </div>
        ${pushLine}
      </div>`;
    }).join('');

    container.querySelectorAll('.adm-pl-name').forEach(a => {
      a.onclick = (e) => {
        e.preventDefault();
        renderAdminMemberEditPage(members.find(m => m.user_id === a.dataset.uid));
      };
    });
    container.querySelectorAll('.adm-team-chip').forEach(btn => {
      btn.onclick = () => {
        openAdminTeamEditModal({ id: btn.dataset.tid, name: btn.dataset.tname, join_code: btn.dataset.tcode });
      };
    });
  };

  // 테스트 알림이 만료 기기를 지우면 알림 상태가 바뀐다 → 다시 읽어 그린다
  const fillTestTargets = initAdminTest(el, async () => { await loadPush(); render(); });

  try {
    await Promise.all([loadMembers(), loadPush()]);
    fillTestTargets(members);
    render();
  } catch(e) {
    msg.textContent = '회원 목록을 불러오는 데 실패했습니다.';
  }
}

// 테스트 알림 카드 — 서버 함수 notify-test 가 보내고 기기마다 결과를 돌려준다.
// 받는 사람 목록은 아래 회원 목록을 불러온 뒤에 채운다 → 채우는 함수를 돌려준다.
function initAdminTest(el, afterSend){
  const sel = el.querySelector('#admTestTarget'), btn = el.querySelector('#admTestSend');
  const msg = el.querySelector('#admTestMsg'), list = el.querySelector('#admTestList');
  const RESULT = { ok: ['✅', '보냄'], fail: ['❌', '실패'], gone: ['🗑️', '만료된 기기 — 목록에서 지움'] };

  btn.onclick = async () => {
    const target = sel.value;
    const who = sel.options[sel.selectedIndex].textContent;
    // 나에게가 아니면 남의 폰이 울린다 — 한 번 더 묻는다
    if (target !== 'me' && !confirm(`'${who}'에게 테스트 알림을 보낼까요?\n받는 사람 폰이 실제로 울립니다.`)) return;
    btn.disabled = true; msg.style.color = 'var(--muted)'; msg.textContent = '보내는 중...'; list.innerHTML = '';
    try {
      const r = await sbFetch('/functions/v1/notify-test', { method: 'POST', body: JSON.stringify({ target }) }) || {};
      const devs = r.devices || [];
      if (!devs.length) { msg.textContent = r.note || '알림을 켠 기기가 없습니다.'; return; }
      msg.style.color = r.failed ? '#f44336' : 'var(--text)';
      msg.textContent = `${devs.length}대 중 ${r.sent}대에 보냈습니다`
        + (r.failed ? ` · 실패 ${r.failed}대` : '') + (r.cleaned ? ` · 만료 ${r.cleaned}대 정리` : '');
      list.innerHTML = devs.map(d => {
        const [ic, tx] = RESULT[d.result] || ['❔', d.result];
        return `<div style="display:flex; justify-content:space-between; gap:10px; padding:7px 2px; border-top:1px solid var(--line); font-size:0.88rem;">
          <span><b>${esc(d.name)}</b> <span style="color:var(--muted);">${esc(d.label)} · ${esc(d.app)}</span></span>
          <span style="white-space:nowrap;">${ic} ${esc(tx)}${d.code ? ` (${d.code})` : ''}</span>
        </div>`;
      }).join('');
      if (r.cleaned && afterSend) afterSend();   // 만료 기기를 지웠으면 '알림 켠 사람' 명단도 바뀐다
    } catch(e) {
      msg.style.color = '#f44336';
      // 함수가 없으면 브라우저는 CORS 오류(TypeError)로만 알려 준다 → 무엇을 해야 하는지 적어 준다
      msg.textContent = (e instanceof TypeError || e.status === 404)
        ? '알림 서버(notify-test)에 닿지 못했습니다. Supabase → Edge Functions 에서 그 함수의 URL 끝이 notify-test 인지 확인해 주세요.'
        : '보내지 못했습니다: ' + e.message;
    } finally { btn.disabled = false; }
  };

  return members => {
    const me = getAuth()?.uid;
    const opts = (members || []).filter(m => m.user_id && m.user_id !== me)
      .map(m => `<option value="${esc(m.user_id)}">${esc(m.display_name || '이름 없음')}</option>`).join('');
    if (opts) sel.insertAdjacentHTML('beforeend', `<optgroup label="회원 한 명에게">${opts}</optgroup>`);
  };
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
   홈 — 하이라이트 (세로 카드 한 장씩 3초마다)

   다른 탭과 달리 조회 기간 필터를 따르지 않는다. "지난 달 / 최근 N경기"가
   카드의 뜻 자체라서, 사용자가 순위 탭에서 잡아 둔 기간에 따라 내용이 바뀌면
   같은 문구가 다른 의미가 돼 버린다. 결산·성장 모두 달력 기준 지난 달.
   ══════════════════════════════════════════════════════════════════════ */

// off=0 이번 달, -1 지난 달. 달의 첫날~마지막날을 YYYY-MM-DD 로.
function monthOf(off){
  const n = new Date();
  const s = new Date(n.getFullYear(), n.getMonth() + off, 1);
  const e = new Date(s.getFullYear(), s.getMonth() + 1, 0);   // 다음 달 0일 = 이번 달 말일
  return {
    from: ymd(s), to: ymd(e),
    label: s.getFullYear() + '년 ' + (s.getMonth() + 1) + '월',
    m: (s.getMonth() + 1) + '월'     // 두 달을 나란히 적을 때 쓰는 짧은 이름
  };
}

let monthCache = { key: '', data: null };
// 지난 달 결산용 집계. 진행 중인 이번 달은 며칠 치만 쌓여 있어 다 끝난 지난달을 쓴다.
function monthData(){
  const key = RAW_GAMES.length + '|' + todayYmd();
  if (monthCache.key === key && monthCache.data) return monthCache.data;
  const prev = monthOf(-1);
  const at = g => ymd(new Date(g.played_at));
  const data = {
    prev,
    prevD: processData(RAW_GAMES.filter(g => inRange(at(g), prev.from, prev.to)), RAW_MEMBERS)
  };
  monthCache = { key, data };
  return data;
}

const f3 = v => v.toFixed(3);
const fPct = v => v.toFixed(1) + '%';   // 보정 승률 — 통합 순위표와 같은 자릿수
const arrow = (a, b) => a + '<span class="ar">→</span>' + b;

const HOME_TABS = [
  { k: 'grow', t: '성장' },
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

/* ── 성장 ── 달력 기준 '지난 달'의 경기를 그 앞 경기들과 견준다.
   '최근 N경기'로 굴리면 경기를 칠 때마다 카드가 바뀌어서, 결산처럼 한 달에 한 번만 바뀌게 한다.
   지난 달에 n경기를 쳤으면 그 앞의 n경기와 비교하고, 앞 경기가 n개가 안 되면 있는 만큼 전부와 견준다.
   양쪽 다 GROW_MIN 경기 이상이어야 한다 — 한두 경기로는 늘었는지 운인지 가릴 수 없다.
   지난 달에 안 친 사람은 자연히 빠진다(지난 달 0경기).
   하이런 신기록·수지 상승도 같은 '지난 달' 한 칸으로 자른다. */
const GROW_MIN = 3;

// 하이런 신기록 → 수지 → 에버리지 → 승률
function homeGrowCards(){
  const M = monthOf(-1);
  const gap = g => '이전 ' + g.nb + '경기 → ' + M.m + ' ' + g.nc + '경기';
  const out = [];

  // ── 수지 상승 (handicap_history) ──
  // 지난 달 사이 여러 번 바뀌었으면 처음 값 → 마지막 값 하나로 합친다.
  const memName = {};
  for (const m of (RAW_MEMBERS || [])) if (m && m.id) memName[m.id] = m.display_name;
  const hd = {};
  // 이력(handicap_history)은 4구 수지만 남는다 → 3구 화면에선 수지 상승 카드를 내지 않는다
  for (const h of (is3() ? [] : RAW_HDCP)) {
    if (h.old_handicap == null || h.new_handicap == null) continue;
    if (!memName[h.player_id]) continue;                                  // 다른 팀 회원은 뺀다
    // changed_at 은 timestamptz(UTC 로 온다) — 문자열을 자르면 안 되고 로컬 날짜로 바꿔서 견준다.
    // 한국은 UTC+9 라 1일 오전 0~9시 변경분이 전달 말일로 잡혀 통째로 누락된다. 경기(played_at)와 같은 방식.
    if (!inRange(ymd(new Date(h.changed_at)), M.from, M.to)) continue;
    const e = hd[h.player_id] || (hd[h.player_id] = { from: h.old_handicap });
    e.to = h.new_handicap;
  }
  const hdUp = Object.keys(hd).map(id => ({ id, ...hd[id] }))
    .filter(e => e.to > e.from)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from));

  // ── 성적 변화 (지난 달 n경기가 그 앞 n경기보다) ──
  // history[0] 이 가장 최근 경기다 (processData 가 오래된 경기부터 훑으며 unshift 한다)
  // 그래서 지난 달 이전 경기를 앞에서 n개 자르면 '지난 달 바로 앞 n경기'가 된다.
  // 이번 달(진행 중) 경기는 어느 쪽에도 안 넣는다.
  const avgUp = [];
  const rateUp = [];
  const hrNew = [];
  for (const p of getFullProcessData().players) {
    const h = p.history || [];
    const cur = h.filter(x => inRange(x.date, M.from, M.to));
    if (!cur.length) continue;                              // 지난 달에 안 친 사람은 빠진다
    const before = h.filter(x => x.date < M.from);

    const prev = before.slice(0, cur.length);
    if (cur.length >= GROW_MIN && prev.length >= GROW_MIN) {
      const g = { name: p.name, nc: cur.length, nb: prev.length, c: calcStatsForHistory(cur), b: calcStatsForHistory(prev) };
      if (g.b.avgAvg > 0 && g.c.avgAvg > g.b.avgAvg) avgUp.push({ ...g, d: g.c.avgAvg - g.b.avgAvg });
      // 승률은 반드시 보정 승률(adjRate). 모드를 안 가리고 묶는데 원시 승률(wins/games)은
      // 1등만 세서 다인전 2등이 꼴등과 같은 0점 취급이 된다.
      // 통합 순위표의 '승률' 열도 adjRate 다 (COLS_ALL) — 표와 카드가 다른 수를 말하면 안 된다.
      if (g.c.adjRate > g.b.adjRate + 0.5) rateUp.push({ ...g, d: g.c.adjRate - g.b.adjRate });
    }

    // 하이런은 '그 앞 N경기보다'보다 '통산 최고 경신'이 훨씬 값진 소식이라
    // 지난 달 경기의 최고를 그 이전 전체의 최고와 견준다
    if (before.length) {
      const top = arr => arr.reduce((m, x) => Math.max(m, x.highRun || 0), 0);
      const now = top(cur), was = top(before);
      if (was > 0 && now > was) hrNew.push({ name: p.name, now, before: was, d: now - was });
    }
  }

  hrNew.sort((a, b) => b.d - a.d).slice(0, 3).forEach(g => out.push({
    badge: '📈 성장', name: g.name, player: g.name,
    big: arrow(g.before, g.now), label: '하이런 신기록',
    delta: '+' + g.d, foot: M.m + '에 지난 기록을 갈아치웠습니다'
  }));

  hdUp.forEach(e => out.push({
    badge: '📈 성장', name: memName[e.id], player: memName[e.id],
    big: arrow(e.from * 10, e.to * 10), label: '수지 상승',
    delta: '+' + (e.to - e.from) * 10, foot: M.label
  }));
  avgUp.sort((a, b) => b.d - a.d).slice(0, 3).forEach(g => out.push({
    badge: '📈 성장', name: g.name, player: g.name,
    big: arrow(f3(g.b.avgAvg), f3(g.c.avgAvg)), label: '에버리지 상승',
    delta: '+' + f3(g.d), foot: gap(g)
  }));
  rateUp.sort((a, b) => b.d - a.d).slice(0, 2).forEach(g => out.push({
    badge: '📈 성장', name: g.name, player: g.name,
    big: arrow(fPct(g.b.adjRate), fPct(g.c.adjRate)), label: '승률 상승',
    delta: '+' + g.d.toFixed(1) + '%p', foot: gap(g)
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

/* ── 최고 기록 ── 기간 필터와 무관한 통산 전체.
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
  grow: ['📈 성장', '지난 달 성장 소식이 없어요', '지난 달 3경기 이상, 그 이전에도 3경기 이상 쳤으면 여기에 뜹니다'],
  last: ['🏅 지난 달 결산', '지난 달 기록이 없어요', '한 달 치가 쌓이면 결산이 만들어집니다'],
  best: ['👑 통산 최고 기록', '아직 기록이 없어요', '첫 경기를 치면 여기가 채워집니다']
};
function homeSlides(){
  const cards = homeTab === 'last' ? homeLastCards()
              : homeTab === 'best' ? homeBestCards()
              : homeGrowCards();
  if (cards.length) return cards;
  const [badge, label, foot] = HOME_EMPTY[homeTab] || HOME_EMPTY.grow;
  return [{ badge, big: '🎱', label, foot, empty: true }];   // 안내 카드는 저장할 게 없다
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
    ${slides[0].empty ? '' : saveBtnHtml('h-save', '이 카드 저장', 'h-saveall', '전체 카드 저장')}
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
  const cardImage = s => [homeCardCanvas(s), [s.name, s.label].filter(Boolean).join('_')];
  // 누른 순간 보이던 카드를 저장한다 (그리는 사이 다음 카드로 넘어가도 상관없게 idx 를 바로 읽는다)
  bindSaveBtn(el, 'h-save', () => cardImage(slides[idx]));
  // 지금 탭의 카드를 전부 저장한다
  bindSaveBtn(el, 'h-saveall', () => slides.map(cardImage), 'h-save');

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
      <td class="name">${esc(g.date)}</td><td class="name">${esc(g.type)}</td>
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

  const applyGamesRange = () => {
    rankFrom = el.querySelector('.pg-period-from').value;
    rankTo = el.querySelector('.pg-period-to').value;
    DATA = getFilteredData();
    updateSub();
    show('games');
  };
  el.querySelector('.pg-period-from').onchange = applyGamesRange;
  el.querySelector('.pg-period-to').onchange = applyGamesRange;

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
  const b4 = g.ball !== '3구';   // 3구 경기엔 마무리 쿠션·파울 칸이 없다
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
      ${b4 ? `<td>${p.cushInn ? `${p.cushMade}/${p.cushInn}` : '—'}</td>` : ''}
      <td>${p.highRun}</td>
      <td>${p.misses}</td>
      ${b4 ? `<td>${p.fouls == null ? '—' : p.fouls}</td>` : ''}
    </tr>`;
  }).join('');
  // 게임 총 시간 = 선수별 소모 시간 합 (시간 기록이 있는 경기만)
  const totMs = g.players.reduce((a,p)=>a+(p.timeMs||0), 0);
  const totStr = totMs > 0 ? ` · 총 ${Math.floor(totMs/60000)}분 ${Math.round(totMs%60000/1000)}초` : '';
  const el = $(`<div>
    <button class="back">← 경기 목록으로</button>
    <div class="card">
      <h2 style="margin:0 0 4px">🎱 ${esc(g.ball)} ${esc(g.type)}</h2>
      <div class="sub" style="margin:0 0 16px">${esc(g.datetime)}${totStr}</div>
      <div class="scroll">
        <table class="statgrid">
          <thead><tr><th class="name">선수</th><th>순위</th><th>점수</th><th>${b4 ? '알이닝' : '이닝'}</th><th>에버</th><th>인터벌</th>${b4 ? '<th>쿠션</th>' : ''}<th>하이런</th><th>공타</th>${b4 ? '<th>파울</th>' : ''}</tr></thead>
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
    const [games, members, adm, hdcp] = await Promise.all([
      fetchGames(),
      fetchMembers().catch(() => []),
      adminP,
      fetchHandicapHistory()
    ]);
    ALL_GAMES = games;
    ALL_MEMBERS = members;
    IS_ADMIN = adm;
    RAW_HDCP = hdcp;
    applyBall();
    updateSub();
    const t = new URLSearchParams(location.search).get('tab') || 'home';
    if (t === 'me') { show('home'); openMeModal(); }   // 점수판에서 넘어온 내 정보 딥링크 → 팝업
    else if (t === 'admin') { if (IS_ADMIN) renderAdminMenu(); else show('home'); }   // 점수판·캘린더 설정의 관리자 메뉴 버튼
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
      logoutBtn.onclick = async () => {
        if(!confirm('로그아웃할까요? 처음 화면으로 돌아갑니다.')) return;
        await logout();   // 알림 구독을 이 계정에서 떼고 로그인·소속 팀을 지운다
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

// ══ 설정 모달 (팀 설정 / 내 정보 설정 / 음향 / 테마) ══ — 공통 모듈
initSettingsModal({
  onTeam: () => { if (getAuth()) openTeamModal(); else openMeModal(); },   // 로그인 전엔 로그인 안내가 있는 내 정보로
  onMe: openMeModal
});
initPushSwitch(() => getAuth()?.uid || null);

// 내 정보 설정 모달 닫기 (× 버튼 / 배경 클릭)
(function initMeModal(){
  const m = document.getElementById('meModal'); if (!m) return;
  const x = document.getElementById('meClose');
  if (x) x.onclick = closeMeModal;
  m.onclick = e => { if (e.target === m) closeMeModal(); };
})();

// 설정 창의 관리자 메뉴 버튼 — 관리자인지 묻는 김에 받은 답을 initDashboard 가 그대로 쓴다
const adminP = initAdminEntry(() => getAuth()?.uid, renderAdminMenu);
initDashboard();

// ══ 서비스 워커 등록 + 자동 업데이트 ══ (공통 모듈)
registerSW();
logVisit('record', () => getAuth()?.uid);   // 관리자 메뉴의 방문 기록 (30분 넘게 비웠다 들어올 때만 센다)


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
        <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:6px;">4구 수지</label>
        <select id="admMHd" class="field" style="margin:0;">
          <option value="">수지 선택</option>
          ${HD_OPTIONS.map(v => `<option value="${v/10}" ${m.handicap === v/10 ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>

      <div style="margin-bottom:16px;">
        <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:6px;">3구 수지 (목표 점수)</label>
        <select id="admMHd3" class="field" style="margin:0;">
          <option value="">수지 선택</option>
          ${HD3_OPTIONS.map(v => `<option value="${v}">${v}</option>`).join('')}
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

  // 3구 수지는 관리자 회원 목록(admin_get_all_members)에 없어서 따로 읽어 온다
  const sel3 = el.querySelector('#admMHd3');
  let saved3 = null, loaded3 = false;
  fetchProfile(m.user_id).then(r => {
    if (r && 'handicap3' in r) { saved3 = r.handicap3 ?? null; setSelVal(sel3, saved3); }
    loaded3 = true;
  }).catch(() => { loaded3 = true; });

  el.querySelector('#admMSaveBtn').onclick = async () => {
    const msg = el.querySelector('#admMMsg');
    const newName = (el.querySelector('#admMName').value || '').trim();
    const hdVal = el.querySelector('#admMHd').value;
    const newHd = hdVal ? parseInt(hdVal, 10) : null;
    const newHd3 = sel3.value ? Number(sel3.value) : null;

    if (!newName) { msg.textContent = '이름을 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      await adminApi.renamePlayer(m.user_id, newName, newHd);
      // 3구 수지 — 지금 값을 읽어 온 뒤에만, 바뀌었을 때만 쓴다 (못 읽은 채 저장하면 빈 값으로 지워진다)
      if (loaded3 && newHd3 !== saved3) { await saveHandicap3(m.user_id, newHd3); saved3 = newHd3; }
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

