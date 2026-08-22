import { sbFetch, sbAuth } from '../record/supabase.js';
import { registerSW, getTheme, applyTheme, LS_THEME, initTeamModal } from '../record/common.js';

const $ = s => document.querySelector(s);
const show = id => document.querySelectorAll('.screen').forEach(el => el.style.display = el.id === id ? 'flex' : 'none');
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
const reqFS = () => { try { if(document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{}); } catch(e){} };
const exitFS = () => { try { if(document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{}); } catch(e){} };

const LS_AUTH = 'dangScoreAuth', LS_PREFS = 'dangScorePrefs_v4', LS_MEM = 'dangScoreMem', LS_STATE = 'dangScoreState', LS_QUEUE = 'dangScoreQueue', LS_TEAM = 'dangCurrentTeam';
const MANUAL = '__MANUAL__';

let auth = lsGet(LS_AUTH, null);
let members = lsGet(LS_MEM, []);
let myTeams = [];                        // [{id,name,slug,is_admin}] — 내가 속한 팀들
let currentTeam = lsGet(LS_TEAM, null);  // 현재 기록 대상 팀 id (없으면 전역 폴백)
// myBall — '내 공' 자리. null 이면 아직 어느 자리에도 안 들어간 상태(앱을 처음 열었을 때의 기본값).
let prefs = lsGet(LS_PREFS, { gameType:'2인', names:['','','',''], pids:[null,null,null,null], targets:[15,15,15,15], myBall:null, cushGoal:1, timeLimit:0 });
if (prefs.cushGoal == null) prefs.cushGoal = 1;
if (prefs.timeLimit == null) prefs.timeLimit = 0;
let S = lsGet(LS_STATE, null);

const ZCOLORS = ['w','y','w','y'];
const ZNAMES = ['⚪ 흰 공', '🟡 노란 공', '⚪ 흰 공', '🟡 노란 공'];
const TZNAMES = ['우리 팀', '상대 팀'];

const api = {
  members: () => sbFetch('/rest/v1/profiles?select=id,display_name,handicap&order=display_name'),
  teamRoster: teamId => sbFetch('/rest/v1/team_members?select=profiles(id,display_name,handicap)&team_id=eq.' + teamId),
  myTeamsRpc: () => sbFetch('/rest/v1/rpc/my_teams', { method: 'POST', body: JSON.stringify({}) }),
  joinTeam: code => sbFetch('/rest/v1/rpc/join_team', { method: 'POST', body: JSON.stringify({ code }) }),
  createTeam: name => sbFetch('/rest/v1/rpc/create_team', { method: 'POST', body: JSON.stringify({ team_name: name }) }),
  myProfile: uid => sbFetch('/rest/v1/profiles?select=display_name&id=eq.' + uid),
  clubEvents: teamId => sbFetch('/rest/v1/club_events?select=id,event_date,round_no,note&team_id=eq.' + teamId + '&order=event_date.desc&limit=200'),
  createProfile: (uid, name, handicap) => sbFetch('/rest/v1/profiles', { method: 'POST', body: JSON.stringify({ id: uid, display_name: name, handicap: handicap || null }) }),
  submitGame: payload => sbFetch('/rest/v1/games', { method: 'POST', body: JSON.stringify(payload) })
};

// ══ Auth ══
let authMode = 'login';
function setMode(m){
  authMode = m;
  $('#tabLogin').className = m==='login'?'on':'';
  $('#tabSignup').className = m==='signup'?'on':'';
  $('#btnAuth').textContent = m==='login'?'로그인':'회원가입';
  $('#aName').style.display = m==='signup' ? '' : 'none';   // 이름은 회원가입 때만 입력
  if ($('#aCode')) $('#aCode').style.display = m==='signup' ? '' : 'none'; // 초대 코드는 회원가입 때만
  if ($('#aHandicap')) $('#aHandicap').style.display = m==='signup' ? '' : 'none'; // 수지는 회원가입 때만 선택
  $('#aPass').autocomplete = m==='signup' ? 'new-password' : 'current-password';
  $('#aErr').textContent = '';
}
$('#tabLogin').onclick = () => setMode('login');
$('#tabSignup').onclick = () => setMode('signup');

$('#btnAuth').onclick = async () => {
  const btn = $('#btnAuth'), err = $('#aErr');
  const loginId = $('#aId').value.trim();
  const name = $('#aName').value.trim(), pass = $('#aPass').value;
  const code = $('#aCode') ? $('#aCode').value.trim().toUpperCase() : '';
  const hdStr = $('#aHandicap') ? $('#aHandicap').value : '';
  const handicap = hdStr ? parseInt(hdStr, 10) : null;
  const isSignup = authMode === 'signup';
  if (!loginId || pass.length < 6) return err.textContent = '아이디와 6자 이상 비밀번호를 입력하세요';
  if (isSignup && !name) return err.textContent = '기록에 표시할 이름을 입력하세요';
  if (isSignup && members.some(m => m.display_name && m.display_name.trim().toLowerCase() === name.toLowerCase())) return err.textContent = '이미 사용 중인 선수 이름(닉네임)입니다. 다른 이름을 입력해 주세요.';
  err.textContent = ''; btn.disabled = true;

  let joinFailed = false;
  try {
    const a = await sbAuth(loginId, pass, isSignup);   // 로그인 열쇠는 '아이디' — 이름을 바꿔도 안 바뀜
    auth = { uid: a.uid, name: isSignup ? name : '', loginId, token: a.token, refresh: a.refresh };
    lsSet(LS_AUTH, auth);

    if (isSignup) {
      try { await api.createProfile(a.uid, name, handicap); }
      catch(e){
        auth = null; localStorage.removeItem(LS_AUTH);
        throw new Error(e.message);
      }
      if (code) {
        // 초대 코드가 입력되었을 때만 팀 합류 시도 (실패해도 계정은 살림)
        try { const tid = await api.joinTeam(code); currentTeam = tid; lsSet(LS_TEAM, currentTeam); }
        catch(e){ joinFailed = true; }
      }
    } else {
      const p = await api.myProfile(a.uid);
      if (p && p[0]) { auth.name = p[0].display_name; lsSet(LS_AUTH, auth); }
    }
    await loadTeams();
    await loadMembers();
    upsertMember(auth.uid, auth.name);
    queueFlush();
    syncSetup();
    show('setup');
    if (joinFailed) {
      toast('초대 코드가 올바르지 않아 소속 팀 없이 가입되었어요. "팀 설정"에서 팀을 만들거나 합류할 수 있어요.');
    } else if (isSignup && !code) {
      toast(`${auth.name}님, 환영합니다! "팀 설정"에서 새 팀을 만들거나 기존 팀에 합류하세요.`);
    } else {
      toast(`${auth.name}님, 환영합니다!`);
    }
  } catch(e){
    err.textContent = translateAuthError(e.message);
  } finally {
    btn.disabled = false; setMode(authMode);
  }
};
function translateAuthError(m){
  if (/Invalid login/i.test(m)) return '아이디 또는 비밀번호가 틀렸어요';
  if (/already registered|already exists|user_already_exists|unique|duplicate/i.test(m)) return '이미 사용 중인 아이디입니다. 다른 아이디를 입력하거나 로그인해 주세요';
  if (/Password should be/i.test(m)) return '비밀번호는 6자 이상이어야 해요';
  if (/rate limit/i.test(m)) return '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요';
  if (/fetch|Network/i.test(m)) return '인터넷 연결을 확인해 주세요';
  return '문제가 발생했어요. 다시 시도해 주세요';
}
$('#btnGuest').onclick = () => { show('setup'); toast('게스트 모드 — 기록은 저장되지 않아요'); };

// 내 소속 팀 목록을 불러오고 현재 팀을 확정한다. (실패 시 전역 폴백 유지)
async function loadTeams(){
  if (!auth || !auth.uid) { myTeams = []; renderTeamBar(); return; }
  try {
    const rows = await api.myTeamsRpc();
    myTeams = Array.isArray(rows) ? rows : [];
    const remembered = lsGet(LS_TEAM, null);
    if (remembered && myTeams.some(t => t.id === remembered)) currentTeam = remembered;
    else currentTeam = myTeams[0] ? myTeams[0].id : null;
    lsSet(LS_TEAM, currentTeam);
  } catch(e){ /* my_teams 함수 미배포 등 → 전역 폴백 */ }
  renderTeamBar();
}

async function loadMembers(){
  try {
    let list = null;
    if (currentTeam) {
      try {
        const rows = await api.teamRoster(currentTeam);       // [{profiles:{...}}]
        list = (rows || []).map(r => r.profiles).filter(Boolean);
      } catch(e){ list = null; }                              // 로스터 실패 → 전역 폴백
    }
    if (!list) list = (auth && auth.uid) ? [{ id: auth.uid, display_name: auth.name, handicap: null }] : [];
    list.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '', 'ko'));
    members = list; lsSet(LS_MEM, members);
    // 로그인 사용자 본인 이름을 최신 프로필로 동기화 (개인정보에서 이름 변경 시 점수판에도 반영)
    if (auth && auth.uid) {
      const me = members.find(m => m.id === auth.uid);
      if (me && me.display_name && me.display_name !== auth.name) {
        auth.name = me.display_name; lsSet(LS_AUTH, auth);
      }
    }
  } catch(e){ /* 완전 실패 시 캐시 유지 */ }
}

// ══ 정기전 ══
// 경기를 날짜가 아니라 정기전 자체(club_events)에 붙여 둔다. 그래야 나중에 기록실에서
// "정기전 날에 낀 정기전 아닌 경기"를 빼낼 수 있다. 소속은 저장할 때 한 번 정해진다 —
// 부원은 games 를 수정할 권한이 없기 때문(수정은 관리자가 기록실에서).
const LS_EVENTS = 'dangClubEvents';
let clubEvents = lsGet(LS_EVENTS, []);   // [{id, event_date, round_no, note}] — 오프라인 대비 캐시

async function loadClubEvents(){
  if (!currentTeam) { clubEvents = []; lsSet(LS_EVENTS, clubEvents); return; }
  try {
    const rows = await api.clubEvents(currentTeam);
    clubEvents = Array.isArray(rows) ? rows : [];
    lsSet(LS_EVENTS, clubEvents);
  } catch(e){ /* 캘린더 미배포·오프라인 → 캐시 유지 */ }
}

// 경기가 속한 "정기전 날짜". 당구는 밤에 치니 새벽 1시에 끝난 경기도 전날 모임이다.
// 5시간을 빼고 날짜를 뽑아 새벽 5시 이전은 전날로 넘긴다. (백필 SQL 과 같은 규칙)
function clubDateOf(ts){
  const d = new Date((ts || Date.now()) - 5*60*60*1000);
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth()+1) + '-' + p2(d.getDate());
}
function eventForGame(ts){
  const key = clubDateOf(ts);
  return clubEvents.find(e => e && e.event_date === key) || null;
}
const EVT_ICON = '⭐';   // 정기전 표시. 🏆 는 우승 표시로 이미 쓰고 있어 겹치면 안 된다.
const eventLabel = e => e ? (e.round_no ? `제${e.round_no}회 정기전` : '정기전') : '';

// 설정 화면 상단의 소속 팀 스위처
function renderTeamBar(){
  const bar = $('#teamBar'), sel = $('#teamSel');
  if (!bar || !sel) return;
  if (!auth) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (!myTeams.length) {
    sel.innerHTML = '<option value="">소속 팀 없음</option>';
    sel.disabled = true;
  } else {
    sel.innerHTML = myTeams.map(t =>
      `<option value="${esc(t.id)}"${t.id === currentTeam ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    sel.disabled = myTeams.length < 2;   // 팀이 하나면 표시만 (전환 불가)
  }
  sel.onchange = async () => {
    if (!sel.value) return;
    currentTeam = sel.value; lsSet(LS_TEAM, currentTeam);
    await loadMembers(); await loadClubEvents(); syncSetup();
    toast('소속 팀 전환됨');
  };
}

// 팀 설정 모달 — 공통 모듈(common.js)로 이동. 앱별 차이(콜백)만 주입.
const { open: openTeamModal } = initTeamModal({
  getAuth: () => auth,
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; lsSet(LS_TEAM, currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: async () => { await loadMembers(); await loadClubEvents(); syncSetup(); },
  notify: m => toast(m)
});
function upsertMember(id, name){
  if (!id || !name) return;
  const i = members.findIndex(m => m.id === id);
  if (i >= 0) members[i].display_name = name;
  else members.push({ id, display_name:name });
  members.sort((a, b) => a.display_name.localeCompare(b.display_name, 'ko'));
  lsSet(LS_MEM, members);
}

// ══ Setup UI ══
function renderSetupCards(modeChanged = false) {
  const isTeam = prefs.gameType === '팀전';
  const N = isTeam ? 2 : parseInt(prefs.gameType.replace('인',''), 10);
  const totalPlayers = isTeam ? 4 : N;
  
  let html = '';
  if (isTeam) {
    for (let i = 0; i < 2; i++) {
      html += `
        <div class="pcard ${prefs.myBall === i ? 'me' : ''}" id="pcard${i}">
          <div class="prow"><span class="dot ${ZCOLORS[i]}"></span> <span class="plbl ${prefs.myBall === i ? 'me' : 'opp'}">${prefs.myBall === i ? '나' : '상대'}</span></div>
          <div style="font-weight:bold; margin-bottom:8px;">${TZNAMES[i]}</div>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <select class="field" id="sel${i}" style="flex:1; margin:0; padding:10px;"></select>
            <input class="field" id="name${i}" maxlength="10" placeholder="선수 1" style="flex:1; margin:0; padding:10px;">
          </div>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <select class="field" id="sel${i+2}" style="flex:1; margin:0; padding:10px;"></select>
            <input class="field" id="name${i+2}" maxlength="10" placeholder="선수 2" style="flex:1; margin:0; padding:10px;">
          </div>
          <div class="trow" style="justify-content:flex-start; gap:12px; align-items:center;">
            <span class="lbl">팀 목표 점수</span>
            <b class="tval" id="tval${i}" style="font-size:1.2rem; line-height:1; padding-top:2px;">${prefs.targets[i]}</b>
            <div style="flex:1;"></div>
            <button class="mbtn" onclick="openTargetPopup(${i})">변경</button>
          </div>
        </div>
      `;
    }
  } else {
    for (let i = 0; i < N; i++) {
      html += `
        <div class="pcard ${prefs.myBall === i ? 'me' : ''}" id="pcard${i}">
          <div class="prow"><span class="dot ${ZCOLORS[i]}"></span> <span class="plbl ${prefs.myBall === i ? 'me' : 'opp'}">${prefs.myBall === i ? '나' : '상대'}</span>
            <select class="field" id="sel${i}" style="margin:0; padding:8px 12px;"></select></div>
          <input class="field" id="name${i}" maxlength="10" placeholder="${ZNAMES[i]} 선수">
          <div class="trow" style="justify-content:flex-start; gap:12px; align-items:center;">
            <span class="lbl">목표 점수</span>
            <b class="tval" id="tval${i}" style="font-size:1.2rem; line-height:1; padding-top:2px;">${prefs.targets[i]}</b>
            <div style="flex:1;"></div>
            <button class="mbtn" onclick="openTargetPopup(${i})">변경</button>
          </div>
        </div>
      `;
    }
  }
  $('#setupCards').innerHTML = html;
  
  let mbHtml = '';
  for (let i = 0; i < (isTeam ? 2 : N); i++) {
    const ballIcon = i % 2 === 0 ? '⚪' : '🟡';
    const label = `${i + 1}번(${ballIcon})`;
    mbHtml += `<button id="first${i}" class="${prefs.myBall === i ? 'on' : ''}" onclick="applyMyBall(${i})">${label}</button>`;
  }
  $('#myBallSeg').innerHTML = mbHtml;
  syncCushSeg();
  syncTimeLimit();

  for (let i = 0; i < totalPlayers; i++) {
    fillSelect(i, modeChanged);
    const sel = $('#sel'+i);
    if(sel) {
      sel.onchange = () => { applySel(i, true); $('#name'+i).value = prefs.names[i]; };
      if($('#name'+i)){
        $('#name'+i).oninput = e => { prefs.names[i] = e.target.value; lsSet(LS_PREFS, prefs); };
        $('#name'+i).value = prefs.names[i];
      }
    }
  }
  
  const showSel = !!auth && members.length > 0;
  for (let i = 0; i < totalPlayers; i++) {
    const sel = $('#sel'+i);
    if(sel) sel.style.display = showSel ? '' : 'none';
    if(!showSel && $('#name'+i)) $('#name'+i).style.display = '';
  }

  for (let pIdx = 0; pIdx < totalPlayers; pIdx++) {
    const isMe = (prefs.myBall === pIdx);
    if($('#sel'+pIdx)) $('#sel'+pIdx).disabled = isMe;
    if($('#name'+pIdx)) $('#name'+pIdx).disabled = isMe;
  }
}

function fillSelect(i, isUserAction = false){
  const sel = $('#sel'+i);
  if(!sel) return;
  const cur = prefs.pids[i];
  
  // 본인은 '상대' 슬롯 목록에선 제외하되, 본인이 배정된 '나' 슬롯에선 유지(이름 자동 채움용)
  const listMembers = members.filter(m => !auth || m.id !== auth.uid || prefs.pids[i] === auth.uid);
  
  sel.innerHTML = listMembers.map(m => `<option value="${esc(m.id)}">${esc(m.display_name)}</option>`).join('') +
    `<option value="${MANUAL}">✏️ 직접 입력</option>`;
    
  // 현재 값이 있으면 선택하고, 없으면 빈 값(아무것도 선택안됨) 유지
  // option value="" 가 없더라도 강제로 첫번째나 빈 값을 지정
  if (cur) {
    sel.value = cur;
  } else if (prefs.names[i]) {
    sel.value = MANUAL;
  } else {
    // 아무것도 선택되지 않았을 때의 처리를 위해 빈 옵션을 숨겨서 추가해둘 수도 있지만
    // select 요소의 value를 임의로 지정해둔다 (브라우저가 첫번째 옵션을 보여주긴 함)
    // 그러나 "선수 선택.."이라는 글자는 보이지 않음
  }
  
  // 첫 로드 시(isUserAction=false) sel.value가 강제로 첫번째 옵션으로 지정되었다면
  // 현재 prefs에 그 값이 없으므로(cur가 빈값) applySel에서 덮어쓰게 될 수 있음.
  // 따라서 빈 값일 땐 일단은 빈 문자열로 두는 보이지 않는 option 하나가 필요할 수 있음.
  // 사용자가 '선수선택..' 글자를 싫어하는 것이므로 빈 라벨 옵션을 추가.
  if (!cur && !prefs.names[i]) {
    sel.insertAdjacentHTML('afterbegin', '<option value="" style="display:none;"></option>');
    sel.value = '';
  }
  
  applySel(i, isUserAction);
}

// 인원수가 늘어날수록 게임이 비슷한 시간에 끝나도록 목표점수를 보정한다.
// 총 득점량(≈게임 시간)이 인원수에 반비례하도록: 2인 기준 그대로, 3인 ×2/3, 4인 ×2/4(절반).
// 팀전은 2진영이 번갈아 치므로 2인과 동일(보정 없이 평균만 사용).
function scaledTarget(handicap, gameType){
  const n = gameType === '3인' ? 3 : gameType === '4인' ? 4 : 2;
  return Math.max(1, Math.round(handicap * 2 / n));
}

function applySel(i, isUserAction){
  const sel = $('#sel'+i);
  if(!sel) return;
  const v = sel.value;
  const manual = (v === MANUAL);
  if($('#name'+i)) $('#name'+i).style.display = manual ? '' : 'none';
  if (manual) { prefs.pids[i] = null; }
  else if (v) {
    const m = members.find(x => x.id === v);
    prefs.pids[i] = v; prefs.names[i] = m ? m.display_name : '';
    if (isUserAction) {
      if (prefs.gameType === '팀전') {
        const teamIdx = i % 2;
        const p1 = prefs.pids[teamIdx];
        const p2 = prefs.pids[teamIdx + 2];
        const m1 = members.find(x => x.id === p1);
        const m2 = members.find(x => x.id === p2);
        let sum = 0, count = 0;
        if (m1 && m1.handicap != null) { sum += parseInt(m1.handicap, 10); count++; }
        if (m2 && m2.handicap != null) { sum += parseInt(m2.handicap, 10); count++; }
        if (count > 0) {
          prefs.targets[teamIdx] = Math.round(sum / count);
          if($('#tval'+teamIdx)) $('#tval'+teamIdx).textContent = prefs.targets[teamIdx];
        }
      } else if (m && m.handicap != null) {
        prefs.targets[i] = scaledTarget(parseInt(m.handicap, 10), prefs.gameType);
        if($('#tval'+i)) $('#tval'+i).textContent = prefs.targets[i];
      }
    }
  } else { prefs.pids[i] = null; prefs.names[i] = ''; }
  lsSet(LS_PREFS, prefs);
}

document.querySelectorAll('#gameTypeSeg button').forEach(b => {
  b.onclick = () => {
    const newVal = b.dataset.v || b.innerText;
    const modeChanged = (prefs.gameType !== newVal);
    prefs.gameType = newVal;
    // 인원수를 바꿔도 내 자리를 임의로 잡아주지 않는다. '내 공'은 normalizeMyBall 이
    // 내 계정이 실제로 있는 자리에서 다시 계산한다(없으면 어디에도 안 속한 상태).
    lsSet(LS_PREFS, prefs);
    syncSetup(modeChanged);
  };
});

// '내 공'은 별도 상태가 아니라 "내 계정이 실제로 들어가 있는 자리"에서 그대로 끌어온다.
// 그래서 아무 자리도 안 고른 첫 진입에는 null(=1~4번 어디에도 안 속함)이 되고,
// 인원수를 바꿔 자리가 사라지면 저절로 풀린다. 자리에 넣는 건 '내 공' 버튼 클릭(applyMyBall)뿐.
function normalizeMyBall(){
  const isTeam = prefs.gameType === '팀전';
  const slots = isTeam ? 2 : parseInt(prefs.gameType.replace('인',''), 10);
  let me = null;
  if (auth) {
    for (let i = 0; i < slots; i++) {
      // 팀전은 팀 단위라 2번 시드에 내가 있어도 그 팀이 '내 공'
      if (prefs.pids[i] === auth.uid || (isTeam && prefs.pids[i + 2] === auth.uid)) { me = i; break; }
    }
  }
  if (prefs.myBall !== me) { prefs.myBall = me; lsSet(LS_PREFS, prefs); }
}

function syncSetup(modeChanged = false){
  normalizeMyBall();
  const lo = $('#btnLogout');
  if (lo) lo.onclick = () => {
    if (!confirm('처음 화면으로 돌아갈까요?')) return;
    auth = null; localStorage.removeItem(LS_AUTH);
    localStorage.removeItem(LS_TEAM); currentTeam = null; myTeams = [];
    exitFS(); show('auth');
  };

  renderTeamBar();

  document.querySelectorAll('#gameTypeSeg button').forEach(b => {
    if ((b.dataset.v || b.innerText) === prefs.gameType) b.classList.add('on');
    else b.classList.remove('on');
  });
  
  renderSetupCards(modeChanged);

  const q = lsGet(LS_QUEUE, []).length;
  $('#saveNote').innerHTML = auth
    ? (q ? `<span class="pip"></span> 저장 대기 ${q}건` : '')
    : `<span class="pip off"></span> 게스트 모드 — 기록이 저장되지 않아요`;
}

let curTargetEdit = 0;
window.openTargetPopup = function(i) {
  curTargetEdit = i;
  // 공 색은 턴에 따라 바뀌므로 제목엔 선수 이름을 쓴다 (없으면 자리 번호)
  const who = prefs.gameType === '팀전' ? TZNAMES[i] : (prefs.names[i] || `${i + 1}번 선수`);
  $('#targetOvlTitle').textContent = who + ' 목표 점수';
  $('#tvalEdit').textContent = prefs.targets[i];
  $('#targetOvl').classList.add('on');
};
$('#btnTargetMinus').onclick = (e) => {
  e.preventDefault(); e.stopPropagation();
  let t = curTargetEdit;
  prefs.targets[t] = Math.max(1, Math.min(99, prefs.targets[t] - 1));
  $('#tvalEdit').textContent = prefs.targets[t];
  if($('#tval'+t)) $('#tval'+t).textContent = prefs.targets[t];
  lsSet(LS_PREFS, prefs); vib(8);
};
$('#btnTargetPlus').onclick = (e) => {
  e.preventDefault(); e.stopPropagation();
  let t = curTargetEdit;
  prefs.targets[t] = Math.max(1, Math.min(99, prefs.targets[t] + 1));
  $('#tvalEdit').textContent = prefs.targets[t];
  if($('#tval'+t)) $('#tval'+t).textContent = prefs.targets[t];
  lsSet(LS_PREFS, prefs); vib(8);
};

window.setCushGoal = function(n){
  prefs.cushGoal = n;
  lsSet(LS_PREFS, prefs); vib(8);
  syncCushSeg();
};
function syncCushSeg(){
  [0,1,2].forEach(n => { const b = $('#cushSeg'+n); if(b) b.classList.toggle('on', (prefs.cushGoal ?? 1) === n); });
}

// 시간제한 휠 피커 (5분 단위, 0=없음 ~ 180분). 위아래로 돌려서 선택.
const TIME_OPTS = (() => { const a = []; for (let m = 0; m <= 180; m += 5) a.push(m); return a; })();
const TIME_ITEM_H = 40;   // .twheel .ti 높이(px)와 일치해야 함
const timeLabel = m => m === 0 ? '없음' : m + '분';
function syncTimeLimit(){
  const b = $('#timeLimitBtn'); if (b) b.textContent = timeLabel(prefs.timeLimit ?? 0);
}
let timeWheelReady = false;
function buildTimeWheel(){
  const w = $('#timeWheel'); if (!w) return;
  w.innerHTML = '<div class="ti-pad"></div>' +
    TIME_OPTS.map(m => `<div class="ti">${timeLabel(m)}</div>`).join('') +
    '<div class="ti-pad"></div>';
  let raf;
  w.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateTimeWheel); });
  timeWheelReady = true;
}
function updateTimeWheel(){
  const w = $('#timeWheel'); if (!w) return;
  const idx = Math.max(0, Math.min(TIME_OPTS.length - 1, Math.round(w.scrollTop / TIME_ITEM_H)));
  w.querySelectorAll('.ti').forEach((el, i) => el.classList.toggle('sel', i === idx));
  const v = TIME_OPTS[idx];
  if (prefs.timeLimit !== v) { prefs.timeLimit = v; lsSet(LS_PREFS, prefs); vib(6); }   // 한 칸 넘어갈 때마다 '틱'
  syncTimeLimit();
}
window.openTimePopup = function(){
  if (!timeWheelReady) buildTimeWheel();
  $('#timeOvl').classList.add('on');
  const idx = Math.max(0, TIME_OPTS.indexOf(prefs.timeLimit ?? 0));
  const w = $('#timeWheel');
  requestAnimationFrame(() => { w.scrollTop = idx * TIME_ITEM_H; updateTimeWheel(); });
};

window.applyMyBall = function(i) {
  if (!auth) return toast('로그인이 필요합니다.');
  
  // 아직 어느 자리에도 안 들어가 있으면(myBall === null) 맞바꿀 자리가 없으니 그냥 이 자리에 들어간다.
  if (prefs.myBall != null && prefs.myBall !== i) {
    const other = i;
    const current = prefs.myBall;

    // 1시드(혹은 개인전 선수) 스왑
    const tempName = prefs.names[current];
    const tempPid = prefs.pids[current];
    const tempTarget = prefs.targets[current];
    prefs.names[current] = prefs.names[other];
    prefs.pids[current] = prefs.pids[other];
    prefs.targets[current] = prefs.targets[other];
    prefs.names[other] = tempName;
    prefs.pids[other] = tempPid;
    prefs.targets[other] = tempTarget;
    
    // 팀전일 경우 2시드 선수도 함께 스왑하여 팀 전체가 공 색깔을 바꾸도록 함
    if (prefs.gameType === '팀전') {
      const p2Cur = current + 2;
      const p2Oth = other + 2;
      const tName = prefs.names[p2Cur];
      const tPid = prefs.pids[p2Cur];
      prefs.names[p2Cur] = prefs.names[p2Oth];
      prefs.pids[p2Cur] = prefs.pids[p2Oth];
      prefs.names[p2Oth] = tName;
      prefs.pids[p2Oth] = tPid;
    }
  }
  
  prefs.myBall = i;
  prefs.pids[i] = auth.uid;
  if (prefs.gameType !== '팀전') {
    const m = members.find(x => x.id === auth.uid);
    if (m && m.handicap != null) prefs.targets[i] = scaledTarget(parseInt(m.handicap, 10), prefs.gameType);
  }
  lsSet(LS_PREFS, prefs);
  syncSetup(prefs.gameType === '팀전');
}

$('#btnStart').onclick = () => {
  const err = $('#sErr'); err.textContent = '';
  const isTeam = prefs.gameType === '팀전';
  const N = isTeam ? 4 : parseInt(prefs.gameType.replace('인',''), 10);
  const totalPlayers = N;
  
  let pNames = [], pPids = [], pTargets = [];
  for(let i=0; i<totalPlayers; i++){
    const nm = $('#name'+i) ? $('#name'+i).value.trim() : prefs.names[i];
    if(!nm && prefs.pids[i]) pNames.push(members.find(x => x.id === prefs.pids[i])?.display_name || '');
    else pNames.push(nm || '');
    pPids.push(prefs.pids[i] || null);
  }
  
  const uniqueKeys = new Set();
  for(let i=0; i<totalPlayers; i++){
    if(!pNames[i]) return err.textContent = '모든 선수를 선택하거나 이름을 입력하세요';
    const key = pPids[i] ? 'id:' + pPids[i] : 'nm:' + pNames[i];
    if(uniqueKeys.has(key)) return err.textContent = '중복된 선수가 있습니다. 각기 다른 선수를 선택해주세요.';
    uniqueKeys.add(key);
  }
  
  if (isTeam) {
    pTargets = [prefs.targets[0], prefs.targets[1], prefs.targets[0], prefs.targets[1]];
  } else {
    for(let i=0; i<N; i++) pTargets.push(prefs.targets[i]);
  }
  
  prefs.names = pNames;
  prefs.pids = pPids;
  lsSet(LS_PREFS, prefs);
  
  S = {
    type: prefs.gameType,
    names: [...pNames], pids: [...pPids], targets: [...pTargets],
    sc: Array(N).fill(0), indSc: Array(N).fill(0),
    inn: Array(N).fill(0), ballInn: Array(N).fill(0), br: Array(N).fill(0), miss: Array(N).fill(0), fouls: Array(N).fill(0),
    done: Array(N).fill(false),
    cush: Array(N).fill(0), indCush: Array(N).fill(0), cushInn: Array(N).fill(0),
    finished: Array(N).fill(false), rank: Array(N).fill(0), cushGoalAt: Array(N).fill(null),
    round: prefs.cushGoal ?? 1, lastInning: false, winners: [],
    tp: 0, tpPts: 0, turn: 0, first: 0, tc: 0,
    timeMs: Array(N).fill(0), turnStart: Date.now(),
    timeLimitMs: (prefs.timeLimit ?? 0) * 60000, timeUp: false,
    hist: [], fin: false, saved: false, t0: Date.now()
  };
  save(); buildGameZones(); render(); show('game'); reqFS();
  toast(`${isTeam ? TZNAMES[S.first] : S.names[S.first]} 선공으로 시작!`);
  speak('게임 시작');
};

// ══ Game Logic ══
let ts = null;
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(ts); ts = setTimeout(()=>t.classList.remove('on'), 2500); };
const vib = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch(e){} };

// 점수 음성 안내: 탭할 때마다 현재 점수를 한국어로 읽어준다 (메뉴에서 켜고 끔)
const LS_VOICE = 'dangScoreVoice';
let voiceOn = lsGet(LS_VOICE, true);
const KD = ['','일','이','삼','사','오','육','칠','팔','구'];
const koNum = n => {
  if (n < 0) return '마이너스 ' + koNum(-n);
  if (n === 0) return '영';
  const h = Math.floor(n/100), t = Math.floor(n%100/10), u = n%10;
  return (h ? (h>1?KD[h]:'')+'백' : '') + (t ? (t>1?KD[t]:'')+'십' : '') + KD[u];
};
const speak = txt => {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel(); // 빠르게 연속 탭해도 마지막 점수만 읽도록
    const u = new SpeechSynthesisUtterance(txt);
    u.lang = 'ko-KR'; u.rate = 1.1;
    speechSynthesis.speak(u);
  } catch(e){}
};
function save(){ lsSet(LS_STATE, S); }

let wl = null;
async function wakeLock(){ try { wl = await navigator.wakeLock.request('screen'); } catch(e){} }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S) wakeLock();
    if (S && S.timeMs && !S.fin && !S.paused) S.turnStart = Date.now();   // 백그라운드 대기 시간은 선수 시간에 넣지 않음
    queueFlush();
  }
  else save();
});

// 게임 시계: 총 경과 시간 표시 (일시정지된 시간은 제외)
setInterval(() => {
  if (!S || S.fin) return;
  const el = $('#gameClock');
  if (!el) return;
  if (S.paused) return;   // 일시정지 중엔 갱신 안 함(고정 표시)
  const pausedMs = S.pausedMs || 0;
  const elapsed = Date.now() - S.t0 - pausedMs;
  const secs = Math.floor(elapsed / 1000);
  const mmss = t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const limitStr = S.timeLimitMs > 0 ? mmss(Math.floor(S.timeLimitMs / 1000)) : '∞';
  el.textContent = `${mmss(secs)} / ${limitStr}`;
  el.style.color = S.timeUp ? '#e5484d' : '';
  // 시간제한: 다 되면 플래그만 세우고, 실제 종료는 이번 이닝이 끝날 때(passTurnInner)
  if (S.timeLimitMs > 0 && !S.timeUp && elapsed >= S.timeLimitMs) {
    S.timeUp = true; save();
    toast('⏱ 시간 종료 — 이번 이닝까지!');
    speak('시간 종료. 이번 이닝까지입니다');
  }
}, 1000);

window.togglePause = function(){
  if (!S || S.fin) return;
  const now = Date.now();
  if (!S.paused) {
    // 일시정지 시작: 현재 턴 소모 시간을 마감하고, 시계·턴 누적을 멈춘다
    if (S.timeMs && S.turnStart != null) {
      S.timeMs[S.turn] = (S.timeMs[S.turn] || 0) + (now - S.turnStart);
    }
    S.turnStart = null;
    S.paused = true;
    S.pauseStart = now;
    $('#gameZones').classList.add('paused');
    if ($('#pauseOverlay')) $('#pauseOverlay').style.opacity = '1';
    $('#btnPause').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  } else {
    // 재개: 정지 구간을 누적 정지시간에 더하고, 턴 타이머를 다시 시작
    S.pausedMs = (S.pausedMs || 0) + (now - (S.pauseStart || now));
    S.paused = false;
    S.turnStart = now;
    $('#gameZones').classList.remove('paused');
    if ($('#pauseOverlay')) $('#pauseOverlay').style.opacity = '0';
    $('#btnPause').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  }
  save();
};

function buildGameZones() {
  if (!S) return;
  const isTeam = S.type === '팀전';
  const N = S.sc.length;
  // append zones to #game but keep #mid
  let gameHtml = '';
  for(let i=0; i<N; i++){
    let zname = (S.names && S.names[i]) ? S.names[i] : 'Player';
    if (isTeam && S.names) {
      zname = `${i%2 === 0 ? 'A팀' : 'B팀'} ${S.names[i]}`;
    }
    let tgt = (S.targets && S.targets[i]) ? S.targets[i] : 15;
    
    gameHtml += `
      <div class="zone" id="zone${i}">
        <button class="minusbtn" id="mbtn${i}">파울</button>
        <span class="runbadge" id="run${i}">+0</span>
        <div class="zname">
          <div class="zname-text"><span id="gball${i}"></span><span id="gname${i}">${esc(zname)}</span></div>
          <span class="turnchip">치는 중</span>
        </div>
        <div class="zscore" id="gsc${i}">0</div>
        <div class="zstats" id="gstat${i}">에버 0.000 · 하이런 0</div>
      </div>
    `;
  }
  
  // insert zones into #gameZones
  $('#gameZones').innerHTML = gameHtml;
  
  zoneCache = [];
  for(let i=0; i<N; i++){
    const z = $('#zone'+i);
    if (z) {
      zoneCache[i] = {
        zone: z,
        gball: $('#gball'+i),
        gsc: $('#gsc'+i),
        gstat: $('#gstat'+i),
        run: $('#run'+i)
      };
      z.addEventListener('pointerdown', e => {
        if (e.target.closest('.minusbtn')) return;
        tapZone(i);
      });
      z.addEventListener('contextmenu', e => e.preventDefault());
    }
    const mbtn = $('#mbtn'+i);
    if (mbtn) mbtn.addEventListener('pointerdown', e => { e.stopPropagation(); foul(i); });
  }
  
  if ($('#btnUndo')) {
    $('#btnUndo').onclick = e => { e.stopPropagation(); undoTurn(); };
  }
}

function pushHist(){
  S.hist.push(JSON.stringify({
    sc:[...S.sc], indSc: S.indSc ? [...S.indSc] : [...S.sc],
    inn:[...S.inn], ballInn: S.ballInn ? [...S.ballInn] : null, br:[...S.br], miss:[...S.miss], fouls: S.fouls ? [...S.fouls] : null,
    done:[...S.done], cush:[...S.cush], indCush: S.indCush ? [...S.indCush] : [...S.cush], cushInn:[...S.cushInn],
    finished:[...S.finished], rank: S.rank ? [...S.rank] : [], cushGoalAt: S.cushGoalAt ? [...S.cushGoalAt] : null,
    round:S.round, lastInning:S.lastInning, winners:[...S.winners],
    tp:S.tp, tpPts:S.tpPts || 0, turn:S.turn, first:S.first, tc:S.tc, fin:S.fin,
    timeMs: S.timeMs ? [...S.timeMs] : [], turnStart: S.turnStart
  }));
}

function popScore(i){
  const el = $('#gsc'+i);
  if(!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function nextTurnIndex(current) {
  const N = S.sc.length;
  let next = (current + 1) % N;
  let checked = 0;
  while (S.finished[next] && checked < N) {
    next = (next + 1) % N;
    checked++;
  }
  return next;
}

function activePlayerCount() {
  return S.finished.filter(x => !x).length;
}

function markGoalReached(i){
  S.lastInning = true;
  if (!S.winners.includes(i)) S.winners.push(i);
  if (S.type === '팀전' && S.sc.length === 4) { if (!S.winners.includes((i+2)%4)) S.winners.push((i+2)%4); }
  toast(`🎯 목표 달성!`);
}

function tapZone(i){
  if (!S || S.fin || S.finished[i] || S.paused) return;

  if (i === S.turn) {
    if (!S.done[i]) {
      pushHist();
      if (!S.indSc) S.indSc = [...S.sc];
      S.sc[i]++; S.indSc[i]++; S.tp++;
      S.tpPts = (S.tpPts || 0) + 1;   // tp 는 쿠션도 같이 세므로, '알 득점'만 따로 센다
      if (S.type === '팀전' && S.sc.length === 4) S.sc[(i+2)%4]++;
      vib(12); popScore(i);
      const rem = S.targets[i] - S.sc[i];
      if (S.sc[i] >= S.targets[i]) {
        S.done[i] = true;
        // 이 이닝의 쿠션 카운트는 턴이 끝날 때 passTurnInner(647)에서 세므로 여기서 세면 이중 카운트가 된다.
        if (S.type === '팀전' && S.sc.length === 4) { const p = (i+2)%4; S.done[p] = true; }
        if (S.round <= 0) {
          // 마무리 쿠션 0개 설정: 목표 도달 즉시 달성
          const firstWin = S.winners.length === 0;
          markGoalReached(i);
          passTurnInner(false, true, true);
          // 바로 끝나지 않으면(후구가 남으면) 쿠션 게임과 동일하게 후구 안내
          if (!S.fin) speak(firstWin ? '후구' : '후구 성공');
        } else {
          speak('마무리');
          toast(`🎯 마무리 쿠션!`);
        }
      } else if (rem >= 1 && rem <= 5) {
        // 오·사·이는 '점'을 붙여 쓰면 [쩜]으로 읽혀서 띄어 써서 [점] 발음을 유도
        const remWord = {5:'오 점', 4:'사 점', 3:'삼점', 2:'이 점', 1:'일점'}[rem];
        speak(remWord + ' 남았습니다');
      } else {
        speak(koNum(S.sc[i]));
      }
    } else if (S.cush[i] < S.round) {
      pushHist();
      if (!S.indCush) S.indCush = [...S.cush];
      S.cush[i]++; S.indCush[i]++; S.tp++;
      if (S.type === '팀전' && S.sc.length === 4) S.cush[(i+2)%4]++;
      vib(12); popScore(i);
      if (S.tp > S.br[i]) S.br[i] = S.tp;

      if (S.cush[i] >= S.round) {
        // 설정한 쿠션 개수를 모두 채웠을 때만 목표 달성
        const firstWin = S.winners.length === 0;
        markGoalReached(i);
        passTurnInner(false, true, true);
        // 바로 끝나지 않으면: 첫 달성은 "후구"(후구 기회 시작), 후구 중 달성은 "후구 성공"
        if (!S.fin) speak(firstWin ? '후구' : '후구 성공');
      } else {
        speak('쿠션 ' + koNum(S.cush[i]));
        toast(`🎯 쿠션 ${S.cush[i]}/${S.round}`);
      }
    } else {
      vib(8);
    }
  } else {
    passTurnInner(true);
  }
  save(); render();
}

// 한 선수의 턴을 이닝으로 마감하면서 두 가지로 나눠 센다. 둘은 배타적이지 않다 —
// 목표에 도달한 이닝은 알도 치고(도달 전) 쿠션도 쳐볼 수 있어(도달 후) 양쪽에 모두 들어간다.
//   · ballInn  알 이닝  — 알을 쳐서 점수를 노린 이닝. 그중 한 점도 못 낸 이닝이 '공타'.
//                        에버·득점률·평균 타수의 분모.
//   · cushInn  쿠션 이닝 — 마무리 쿠션을 쳐볼 수 있었던 이닝. 쿠션 성공률의 분모.
//                        쿠션만 친 이닝은 알을 칠 수 없으므로 공타로 세지 않는다.
// inn 은 총 턴 수로 남겨 둔다 — 다인전 후구 판정(이닝 경계)이 이 값에 의존한다.
function ballInn(i){ return (S.ballInn && S.ballInn[i]) || 0; }

function closeInning(i, isMiss){
  // 턴이 끝날 때 마무리 쿠션 단계면 이번 이닝에 쿠션을 쳐볼 수 있었다는 뜻.
  const cushPhase = S.round > 0 && S.done[i];
  // 알 득점이 있었으면 이번 이닝에 목표를 채운 것이므로 알 이닝이기도 하다.
  const ballPhase = !cushPhase || S.tpPts > 0;
  S.inn[i]++;
  if (!S.ballInn) S.ballInn = Array(S.sc.length).fill(0);
  if (ballPhase) {
    S.ballInn[i]++;
    if (isMiss && S.tp === 0) S.miss[i]++;
  }
  if (cushPhase) S.cushInn[i]++;
  S.tp = 0; S.tpPts = 0;
}

function passTurnInner(isMiss, skipHist, quiet) {
  if (!skipHist) pushHist();
  if (S.tp > S.br[S.turn]) S.br[S.turn] = S.tp;

  closeInning(S.turn, isMiss);

  const prevTurn = S.turn;
  // 직전 선수가 이번 턴에 소모한 시간을 누적
  if (S.timeMs) {
    const nowT = Date.now();
    S.timeMs[prevTurn] = (S.timeMs[prevTurn] || 0) + (nowT - (S.turnStart || nowT));
    S.turnStart = nowT;
  }
  const next = nextTurnIndex(S.turn);
  S.turn = next;
  S.tc++;
  vib(25);
  
  const isTeam = S.type === '팀전' && S.sc.length === 4;
  const is2p = S.sc.length === 2;

  let inningEnded = false;
  if (isTeam || is2p) {
    const teamOf = i => isTeam ? (i % 2) : i;
    if (teamOf(prevTurn) !== teamOf(S.first)) inningEnded = true;
  } else {
    const activeInns = S.inn.filter((_, idx) => !S.finished[idx]);
    if (activeInns.length > 0 && activeInns.every(v => v === activeInns[0])) {
      inningEnded = true;
    }
  }

  if (inningEnded && S.lastInning) {
    endInning();
  }
  if (inningEnded && S.timeUp && !S.fin) {
    endGameByTime();   // 시간 종료 후 이번 이닝이 끝나면 현재 점수로 순위 확정
  }
  // 턴 안내 (게임이 끝났거나 파울 안내 직후면 생략)
  if (!quiet && !S.fin) speak('턴');
}


// 등수 판정 단위 — 팀전은 팀(0/1), 2인·다인전은 선수 본인
function unitOf(i){ return (S.type === '팀전' && S.sc.length === 4) ? (i % 2) : i; }

function unitTotal(){ return (S.type === '팀전' && S.sc.length === 4) ? 2 : S.sc.length; }

// 아직 등수가 확정되지 않은 유닛 수. extra 는 이번 이닝에 확정될 예정인 선수들.
function pendingUnitCount(extra){
  const settled = new Set();
  (S.rank || []).forEach((r, i) => { if (r) settled.add(unitOf(i)); });
  (extra || []).forEach(i => settled.add(unitOf(i)));
  return unitTotal() - settled.size;
}

// 다음에 매길 등수 = 이미 확정된 유닛 수 + 1.
// 표준 경쟁 순위라 공동 1등이 둘이면 그 다음은 2등이 아니라 3등이 된다.
function nextRankValue(){
  return unitTotal() - pendingUnitCount() + 1;
}

function endInning() {
  if (S.winners.length === 0) return;

  const winUnits = new Set(S.winners.map(unitOf));

  // 연장은 '공동 꼴등'일 때만 — 동시 달성으로 남은 유닛이 전부 확정돼 꼴등을 못 가리는 경우.
  // 공동 1등은 같은 등수로 확정하고, 뒤에 남은 선수들은 '계속치기'로 꼴등전을 이어간다.
  // (2인·팀전은 유닛이 둘뿐이라 동점 = 곧 공동 꼴등 → 기존과 같이 바로 연장)
  if (winUnits.size > 1 && pendingUnitCount(S.winners) === 0) {
    S.round++;
    S.lastInning = false;
    S.winners = [];
    // 연장 이닝은 선구 선수 몫으로 계상. 꼴등전 중이면 이미 끝난 선수 대신 남아 있는 다음 선수에게.
    S.cushInn[S.finished[S.first] ? nextTurnIndex(S.first) : S.first]++;
    vib([40,40,40]);
    const tieLabel = activePlayerCount() < S.sc.length ? '공동 꼴등' : '동점';
    toast(`${tieLabel}! 마무리 쿠션 ${S.round} — 연장`);
    speak('연장');
    return;
  }

  save(); render(); return win(S.winners[0]);
}

window.undoTurn = function(){
  if (!S || !S.hist.length) return;
  try {
    const h = JSON.parse(S.hist.pop());
    Object.assign(S, h);
    vib(15); save(); render();
  } catch(e){}
};

// 파울: 현재 치는 선수의 점수를 실제로 1점 깎고(음수 허용) 턴을 넘긴다.
window.foul = function(i){
  if (!S || S.fin || i !== S.turn || S.finished[i] || S.paused) return;
  pushHist();
  S.sc[i]--; if (S.indSc) S.indSc[i]--;
  // 파울 횟수는 '선수 개인' 기록 — 팀전이라도 짝꿍에게 미러링하지 않는다(아래 미러링 블록 참고)
  if (!S.fouls) S.fouls = Array(S.sc.length).fill(0);
  S.fouls[i]++;
  // 이미 목표를 달성해 마무리 쿠션 중이었는데 점수가 목표 밑으로 내려가면 완주 상태 해제
  if (S.done[i] && S.sc[i] < S.targets[i]) {
    S.done[i] = false;
    S.cush[i] = 0; if (S.indCush) S.indCush[i] = 0;
    S.lastInning = false;
    S.winners = S.winners.filter(x => x !== i && x !== ((i+2)%4));
  }
  if (S.type === '팀전' && S.sc.length === 4) {
    const p = (i+2)%4;
    // 팀 공유값(점수·달성·쿠션)만 미러링한다.
    // indSc·indCush는 '선수 개인' 기록이므로 짝꿍 것을 덮어쓰면 안 된다(파울한 본인만 위에서 차감).
    S.sc[p] = S.sc[i]; S.done[p] = S.done[i]; S.cush[p] = S.cush[i];
  }
  vib(30); popScore(i); speak('파울');
  toast('⚠️ 파울 −1');
  // 파울은 이닝 종료 → 턴 넘김 (스냅샷은 위에서 이미 저장했으므로 skipHist, 음성은 '파울'만)
  passTurnInner(true, true, true);
  save(); render();
};

let zoneCache = [];

function render(){
  if (!S) return;
  const isTeam = S.type === '팀전';
  const N = S.sc.length;
  for(let i=0; i<N; i++) {
    const c = zoneCache[i];
    const el = c ? c.zone : $('#zone'+i);
    if(!el) continue;
    
    el.classList.toggle('on', S.turn === i && !S.fin && !S.finished[i]);
    el.classList.toggle('off', (S.turn !== i || S.fin) && !S.finished[i]);
    if (S.finished[i]) {
      el.style.opacity = '0.3';
      el.classList.add('off');
    } else {
      el.style.opacity = '1';
    }
    
    // 계산: 이 선수가 칠 때의 절대 턴수(tc)
    let expectedTc = S.tc;
    if (!S.finished[i]) {
      let curr = S.turn;
      while (curr !== i) {
        curr = (curr + 1) % N;
        if (!S.finished[curr]) expectedTc++;
      }
    }
    const isWhite = (expectedTc % 2 === 0);
    el.classList.toggle('w', isWhite);
    el.classList.toggle('y', !isWhite);
    
    const ballSpan = c ? c.gball : $('#gball'+i);
    if (ballSpan) {
      ballSpan.textContent = isWhite ? '⚪ ' : '🟡 ';
      ballSpan.style.marginRight = '4px';
    }
    
    const gscEl = c ? c.gsc : $('#gsc'+i);
    const gstatEl = c ? c.gstat : $('#gstat'+i);
    const runEl = c ? c.run : $('#run'+i);

    if (S.done[i] && S.round > 0) {
      if (gscEl) {
        gscEl.innerHTML = `${S.cush[i]}<span style="font-size:0.45em;opacity:0.55;font-weight:700"> / ${S.round}</span>`;
        gscEl.style.fontSize = 'clamp(40px, 15vmin, 100px)';
      }
      if (gstatEl) gstatEl.innerHTML = `<span style="color:var(--accent)">마무리 쿠션 단계</span>`;
    } else {
      if (gscEl) {
        gscEl.innerHTML = `${S.sc[i]}<span style="font-size:0.45em;opacity:0.55;font-weight:700"> / ${S.targets[i]}</span>`;
        gscEl.style.fontSize = 'clamp(64px, 22vmin, 150px)';
      }
      // 에버 분모는 알 이닝(= 총 이닝 − 쿠션 이닝). 이 분기는 아직 알을 치는 중이라 현재 턴도 알 이닝으로 센다.
      const curInn = Math.max(1, ballInn(i) + (S.turn === i ? 1 : 0));
      const indS = (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];   // 팀전은 sc가 팀 공유값 → 개인 에버는 indSc로
      const ev = (indS / curInn).toFixed(3);
      const curHr = (S.turn === i && S.tp > S.br[i]) ? S.tp : S.br[i];
      if (gstatEl) gstatEl.textContent = `에버 ${ev} · 하이런 ${curHr}`;
    }
    
    if (runEl) {
      if (S.turn === i && S.tp > 0) {
        runEl.textContent = '+' + S.tp;
        runEl.classList.add('show');
      } else {
        runEl.classList.remove('show');
      }
    }
  }
  
  if ($('#inning')) {
    $('#inning').textContent = `${Math.max(...S.inn) + 1} 이닝`;
  }
}

// ══ Win / Menu ══
// 이번 라운드 승자를 등수에 반영 (동시 달성이면 같은 등수). 아직 못 끝낸 팀/개인 수를 반환.
function assignRanksAndCountRemaining(){
  if (!S.rank) S.rank = Array(S.sc.length).fill(0);
  // 등수 확정 시점의 마무리 쿠션 개수를 남겨 둔다.
  // 뒤에서 꼴등 연장이 붙어 S.round 가 올라가도 먼저 끝낸 선수 기록이 '쿠션 1/2'처럼 밀리지 않게.
  if (!S.cushGoalAt) S.cushGoalAt = Array(S.sc.length).fill(null);
  const nextRank = nextRankValue();   // 반드시 이번 승자를 반영하기 전에 계산
  S.winners.forEach(w => { if (!S.rank[w]) { S.rank[w] = nextRank; S.cushGoalAt[w] = S.round; } });
  return pendingUnitCount();          // 남은 유닛 수 (팀전은 팀 기준, 개인전은 사람 기준)
}

// event_id 는 마이그레이션(sql/event-games.sql)이 돌아간 뒤에야 있는 컬럼이다. 아직 없거나
// PostgREST 스키마 캐시가 덜 갱신됐으면 400 으로 떨어지는데, 그 때문에 경기 기록 자체를
// 잃으면 안 된다. 소속만 떼고 한 번 더 보낸다 — 소속은 나중에 관리자가 붙일 수 있지만
// 사라진 기록은 되살릴 방법이 없다.
async function submitGameSafe(payload){
  try {
    return await api.submitGame(payload);
  } catch(e){
    const s = e && e.status;
    if (payload.event_id && (s === 400 || s === 404)) {
      const fallback = Object.assign({}, payload);
      delete fallback.event_id;
      return await api.submitGame(fallback);
    }
    throw e;
  }
}

// 게임 종료 시 최종 기록을 서버에 저장 (등수 확정 · 못 끝낸 선수는 공동 꼴찌)
function saveGame(){
  if (S.saved) return;
  S.saved = true; save();
  if (!auth) {
    $('#saveStat').className = 'savestat'; $('#saveStat').textContent = '게스트 모드: 기록이 저장되지 않습니다';
    return;
  }
  const N = S.sc.length, isTeam = S.type === '팀전';
  // 마지막(현재) 턴의 진행 시간을 마감 처리
  if (S.timeMs && S.turnStart != null) {
    S.timeMs[S.turn] = (S.timeMs[S.turn] || 0) + (Date.now() - S.turnStart);
    S.turnStart = Date.now();
  }
  const lastRank = nextRankValue();   // 끝까지 못 친 선수들의 공동 등수
  const pl = [];
  for (let i = 0; i < N; i++) {
    const rank = S.rank[i] || lastRank;
    const indS = (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];
    const indC = (S.indCush && S.indCush[i] !== undefined) ? S.indCush[i] : S.cush[i];
    pl.push({
      id: S.pids[i] || null, name: S.names[i], win: rank === 1, rank,
      score: indS, target: S.targets[i], innings: S.inn[i],
      ballInn: ballInn(i),   // 알 이닝 — 에버·득점률·평균 타수의 분모
      highRun: S.br[i], misses: S.miss[i], fouls: (S.fouls && S.fouls[i]) || 0, cushMade: indC,
      cushInn: S.cushInn[i], timeMs: (S.timeMs && S.timeMs[i]) || 0, isTeam
    });
  }
  // 정기전 소속은 저장할 때 확정된다. 나중에 고치려면 관리자 권한이 필요하므로(RLS),
  // 예외 경기는 치기 전에 메뉴에서 '정기전 기록: 제외'로 바꿔 둬야 한다.
  const evt = S.evtOff ? null : eventForGame(S.t0);
  const payload = { recorded_by: auth.uid, played_at: new Date(S.t0).toISOString(), players: pl, team_id: currentTeam || null, event_id: evt ? evt.id : null };
  $('#saveStat').className = 'savestat'; $('#saveStat').textContent = '서버에 기록 저장 중...';
  submitGameSafe(payload).then(() => {
    $('#saveStat').className = 'savestat ok'; $('#saveStat').textContent = '기록 저장 완료 ✓';
  }).catch(() => {
    queueAdd(payload);
    $('#saveStat').className = 'savestat warn'; $('#saveStat').textContent = '오프라인: 나중에 저장됩니다';
  });
}

function win(winnerIdx){
  S.fin = true;
  const isTeam = S.type === '팀전';
  const N = S.sc.length;
  const remaining = assignRanksAndCountRemaining();
  const isFinal = remaining <= 1;   // 남은 유닛이 1 이하면 더 겨룰 상대가 없음 → 경기 종료
  save();
  const winOvl = $('#winOvl');
  winOvl.classList.add('on');
  updEvtNote();
  // 마지막 점수 탭이 방금 뜬 결과 메뉴 버튼으로 관통되는 것 방지: 잠깐 입력을 무시
  winOvl.style.pointerEvents = 'none';
  setTimeout(() => { winOvl.style.pointerEvents = ''; }, 600);

  const isTie = isTeam && N === 4 ? new Set(S.winners.map(i => i%2)).size > 1 : S.winners.length > 1;
  const first = S.winners[0];
  const placeLabel = (S.rank[first] || 1) === 1 ? '승리' : `${S.rank[first]}위 확정`;
  $('#winTitle').textContent = isTie
    ? '공동 달성!'
    : `${isTeam ? TZNAMES[first%2] : S.names[first]} ${placeLabel}!`;
  speak(isTie
    ? '공동 달성'
    : `${isTeam ? TZNAMES[first%2] : S.names[first]} ${(S.rank[first] || 1) === 1 ? '우승' : S.rank[first] + '위'}`);

  // 미확정 선수도 잠정 순위(달성 비율)를 매겨 결과 표에 2·3·4등을 표시한다.
  const dr = displayRanks();
  let html = '<tr><th>선수</th><th>점수</th><th>에버</th><th>하이런</th></tr>';
  for(let i=0; i<N; i++){
    const nm = isTeam ? `${i%2===0 ? 'A팀' : 'B팀'} ${S.names[i]}` : S.names[i];
    const indS = (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];
    const indC = (S.indCush && S.indCush[i] !== undefined) ? S.indCush[i] : S.cush[i];
    // 이미 등수가 확정된 선수는 그때의 쿠션 개수로 표시(꼴등 연장으로 S.round 가 올라간 경우 대비)
    const cushGoal = (S.cushGoalAt && S.cushGoalAt[i] != null) ? S.cushGoalAt[i] : S.round;
    const scStr = (S.done[i] && cushGoal > 0) ? `쿠션 ${indC}/${cushGoal}` : `${indS}/${S.targets[i]}`;
    const ev = ballInn(i) ? (indS / ballInn(i)).toFixed(3) : '0.000';   // 에버 분모는 알 이닝
    const rankTag = dr[i] === 1 ? ' 🏆' : ` <span style="opacity:.6">${dr[i]}위</span>`;
    html += `<tr><td>${esc(nm)}${rankTag}</td><td>${scStr}</td><td>${ev}</td><td>${S.br[i]}</td></tr>`;
  }
  $('#winStats').innerHTML = html;

  // 아직 겨룰 선수가 남았으면 '계속치기'로 꼴등전 진행.
  // 저장은 자동으로 하지 않는다 — '경기 종료'를 눌러야 기록된다.
  // (자동 저장하면 되돌리기 후 다시 끝냈을 때 같은 경기가 두 번 기록된다)
  $('#btnWinCont').style.display = isFinal ? 'none' : '';
  $('#btnWinUndo').style.display = '';   // 경기 끝내기에서 숨겼을 수 있어 복구
  if ($('#btnWinResume')) $('#btnWinResume').style.display = 'none';   // 시간초과 전용 버튼
  $('#saveStat').className = 'savestat';
  $('#saveStat').textContent = "'경기 종료'를 눌러야 기록이 저장됩니다";
}

// ══ 경기 끝내기(중도 기록) ══
// 목표를 다 못 채웠어도 지금까지의 '달성 비율'로 순위를 매겨 경기를 종료·저장한다.
//   달성 비율 = (뺀 점수 + 낸 마무리쿠션 × 3) ÷ (목표점수 + 필요 마무리쿠션 × 3)
const CUSH_PT = 3;
function progRatio(i){
  const denom = S.targets[i] + (S.round > 0 ? S.round * CUSH_PT : 0);
  const prog = S.sc[i] + (S.cush[i] || 0) * CUSH_PT;   // sc/cush는 팀전에서 팀 공유값
  return denom > 0 ? prog / denom : 0;
}
// 결과 화면 표시용 순위 배열. 확정된 순위는 그대로 두고, 미확정 선수만 달성 비율로
// 잠정 순위를 매겨 돌려준다. (S.rank 원본은 건드리지 않아 꼴등전 진행에 영향 없음)
function displayRanks(){
  const N = S.sc.length;
  const isTeam = S.type === '팀전' && N === 4;
  const out = S.rank.slice();
  const reps = isTeam ? [0, 1] : [...Array(N).keys()];
  const pending = reps.filter(r => !out[r] && !(isTeam && out[r + 2]));
  const nextRank = nextRankValue();
  const EPS = 1e-9;
  pending.forEach(r => {
    const better = pending.filter(o => progRatio(o) > progRatio(r) + EPS).length;
    const rk = nextRank + better;
    out[r] = rk;
    if (isTeam) out[r + 2] = rk;
  });
  return out;
}

// 아직 순위가 확정되지 않은 유닛(개인전=선수, 팀전=팀 대표 0/1)을 달성 비율로 순위 매김.
// 이미 정식 완주해 순위가 있는 선수는 그대로 두고, 나머지를 그 뒤 등수로 채운다.
function rankRemainingByRatio(){
  const N = S.sc.length;
  const isTeam = S.type === '팀전' && N === 4;
  const reps = isTeam ? [0, 1] : [...Array(N).keys()];
  const pending = reps.filter(r => !S.rank[r] && !(isTeam && S.rank[r + 2]));
  if (!pending.length) return;
  const nextRank = nextRankValue();
  const EPS = 1e-9;
  pending.forEach(r => {
    // 표준 경쟁 순위: 나보다 비율이 확실히 높은 유닛 수 + 다음 등수 (동률은 공동)
    const better = pending.filter(o => progRatio(o) > progRatio(r) + EPS).length;
    const rk = nextRank + better;
    S.rank[r] = rk;
    if (isTeam) S.rank[r + 2] = rk;
  });
}
// 시간제한 종료: 이닝 경계에서 호출되므로 추가 이닝 마감 없이 현재 점수로 순위 확정
function endGameByTime(){
  if (!S || S.fin) return;
  const N = S.sc.length;
  rankRemainingByRatio();
  S.finished = S.finished.map(() => true);
  S.lastInning = false;
  S.winners = [];
  for (let i = 0; i < N; i++) if (S.rank[i] === 1) S.winners.push(i);
  S.fin = true;
  save();
  showEarlyResult();
  // 시간초과 종료: 실수/연장 대비로 되돌리기·계속하기 제공.
  // 저장은 '경기 종료'를 누를 때만(되돌리기/계속하기 후 재종료 시 중복 저장 방지).
  $('#btnWinUndo').style.display = '';
  $('#btnWinResume').style.display = '';
  $('#saveStat').className = 'savestat';
  $('#saveStat').textContent = "⏱ 시간 종료 — '경기 종료'를 누르면 기록이 저장됩니다";
}
// '경기 끝내기'는 한 바퀴가 온전히 끝난 시점까지만 기록으로 남긴다.
// 돌다 만 바퀴를 그대로 두면 아직 안 친 선수가 이닝을 덜 갖게 되고, 진행 중이던 턴을
// 이닝으로 마감하면 점수 0짜리 이닝이 에버·평균 타수의 분모만 늘린다.
// 되돌리기 스냅샷(hist)을 되감아 그 시점의 점수·이닝·공타를 통째로 되살린다.
function rewindToRoundEnd(){
  const roundEnded = () => {
    if (S.tp) return false;                                  // 진행 중이던 턴이 남아 있음
    const active = S.inn.filter((_, i) => !S.finished[i]);
    return active.length === 0 || active.every(v => v === active[0]);
  };
  let guard = 0;
  while (!roundEnded() && S.hist.length && guard++ < 1000) {
    try { Object.assign(S, JSON.parse(S.hist.pop())); }
    catch(e){ break; }
  }
}

function endGameEarly(){
  if (!S || S.fin) return;
  const N = S.sc.length;

  rewindToRoundEnd();   // 한 바퀴가 끝난 시점까지 되감아 반쪽 이닝을 기록에서 뺀다

  rankRemainingByRatio();

  S.finished = S.finished.map(() => true);
  S.lastInning = false;
  S.winners = [];
  for (let i = 0; i < N; i++) if (S.rank[i] === 1) S.winners.push(i);
  S.fin = true;
  save();

  showEarlyResult();
  saveGame();
}
function showEarlyResult(){
  const N = S.sc.length;
  const isTeam = S.type === '팀전' && N === 4;
  const winOvl = $('#winOvl');
  winOvl.classList.add('on');
  updEvtNote();
  winOvl.style.pointerEvents = 'none';
  setTimeout(() => { winOvl.style.pointerEvents = ''; }, 600);

  const champ = S.winners[0];
  const isTie = new Set(S.winners.map(i => isTeam ? i % 2 : i)).size > 1;
  const champName = isTeam ? TZNAMES[champ % 2] : S.names[champ];
  $('#winTitle').textContent = isTie ? '공동 1위!' : `${champName} 승리!`;
  speak(isTie ? '공동 승리' : `${champName} 승리`);

  let html = '<tr><th>선수</th><th>순위</th><th>점수</th><th>달성률</th></tr>';
  const order = [...Array(N).keys()].sort((a, b) => (S.rank[a] - S.rank[b]) || (a - b));
  for (const i of order){
    const nm = isTeam ? `${i % 2 === 0 ? 'A팀' : 'B팀'} ${S.names[i]}` : S.names[i];
    const indS = (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];
    const indC = (S.indCush && S.indCush[i] !== undefined) ? S.indCush[i] : S.cush[i];
    const scStr = (S.done[i] && S.round > 0) ? `${S.targets[i]} + 쿠션${indC}` : `${indS} / ${S.targets[i]}`;
    const pct = (progRatio(i) * 100).toFixed(1);
    const medal = S.rank[i] === 1 ? '🏆 ' : '';
    html += `<tr><td>${esc(nm)}</td><td>${medal}${S.rank[i]}위</td><td>${scStr}</td><td>${pct}%</td></tr>`;
  }
  $('#winStats').innerHTML = html;
  $('#btnWinCont').style.display = 'none';
  $('#btnWinUndo').style.display = 'none';
  if ($('#btnWinResume')) $('#btnWinResume').style.display = 'none';
}

// 경기 종료(저장) 후 새 경기 — 꼴등전을 안 하고 바로 끝낼 때도 여기서 저장된다.
// 남은 선수는 공동 꼴찌가 아니라 지금까지의 달성 비율로 순위를 매겨 저장한다.
$('#btnWinNew').onclick = () => {
  if (!S) return;   // 연타로 두 번 눌려도 안전하게
  rankRemainingByRatio();
  saveGame();
  $('#winOvl').classList.remove('on'); S = null; save(); exitFS(); show('setup');
};

$('#btnWinCont').onclick = () => {
  $('#winOvl').classList.remove('on');
  S.winners.forEach(w => S.finished[w] = true);
  S.winners = [];
  S.lastInning = false;
  S.fin = false;

  if (activePlayerCount() <= 1) {
    // 더 겨룰 상대가 없으면 결과 화면으로 되돌아가 '경기 종료'를 누르게 한다(자동 저장 안 함)
    toast('더 이상 진행할 선수가 없습니다.');
    S.fin = true; save();
    $('#winOvl').classList.add('on');
    $('#btnWinCont').style.display = 'none';
    $('#saveStat').className = 'savestat';
    $('#saveStat').textContent = "'경기 종료'를 눌러야 기록이 저장됩니다";
    return;
  }

  // Set turn to the next non-finished player if current is finished
  if (S.finished[S.turn]) S.turn = nextTurnIndex(S.turn);
  save(); render();
};

$('#btnWinUndo').onclick = () => {
  $('#winOvl').classList.remove('on');
  S.fin = false; S.saved = false;
  undoTurn();
};

// 시간초과 종료 화면의 '계속하기' — 시간제한을 해제하고 직전 상태로 돌아가 연장 진행
if ($('#btnWinResume')) $('#btnWinResume').onclick = () => {
  if (!S) return;
  $('#winOvl').classList.remove('on');
  S.fin = false; S.saved = false;
  S.timeUp = false; S.timeLimitMs = 0;   // 연장 — 무제한
  undoTurn();                            // 종료를 부른 마지막 동작을 되돌려 직전 상태로
  toast('연장 — 시간제한 해제됨');
};

$('#btnMenu').onclick = () => { updEvtBtn(); $('#menuOvl').classList.add('on'); };
$('#btnMenuClose').onclick = () => $('#menuOvl').classList.remove('on');

// 정기전 토글 — 그 날 정기전이 등록돼 있을 때만 메뉴에 나온다.
// 기본은 '포함'. 정기전 날에 낀 친선 경기 등은 치기 전에 여기서 빼 둔다.
function updEvtBtn(){
  const b = $('#btnEvt');
  if (!b) return;
  const evt = S ? eventForGame(S.t0) : null;
  if (!evt) { b.style.display = 'none'; return; }
  b.style.display = '';
  b.textContent = S.evtOff
    ? `${EVT_ICON} ${eventLabel(evt)} 기록: 제외`
    : `${EVT_ICON} ${eventLabel(evt)} 기록: 포함`;
}
if ($('#btnEvt')) $('#btnEvt').onclick = () => {
  if (!S) return;
  S.evtOff = !S.evtOff; save(); updEvtBtn();
  toast(S.evtOff ? '이 경기는 정기전 기록에서 빠집니다' : '이 경기는 정기전 기록에 포함됩니다');
};

// 결과 화면에 소속을 한 줄로 알려 준다. 저장 뒤에는 관리자만 고칠 수 있으므로
// 잘못 들어갔으면 여기서 알아채고 기록실에서 고치라는 뜻.
function updEvtNote(){
  const n = $('#evtNote');
  if (!n) return;
  const evt = S ? eventForGame(S.t0) : null;
  if (!evt) { n.style.display = 'none'; n.textContent = ''; return; }
  n.style.display = '';
  n.textContent = S.evtOff
    ? `${eventLabel(evt)} 기록에서 제외됨`
    : `${EVT_ICON} ${eventLabel(evt)} 기록으로 저장`;
}
const updVoiceBtn = () => { const b = $('#btnVoice'); if (b) b.textContent = voiceOn ? '🔊 점수 음성: 켜짐' : '🔇 점수 음성: 꺼짐'; };
updVoiceBtn();
if ($('#btnVoice')) $('#btnVoice').onclick = () => {
  voiceOn = !voiceOn; lsSet(LS_VOICE, voiceOn); updVoiceBtn();
  if (voiceOn) speak('음성 안내를 켰습니다'); else { try { speechSynthesis.cancel(); } catch(e){} }
};
$('#btnEndGame').onclick = () => {
  if(confirm('지금까지의 점수 비율(뺀 점수 + 쿠션×3)로 순위를 정하고 경기를 기록할까요?')){
    $('#menuOvl').classList.remove('on');
    endGameEarly();
  }
};
$('#btnMenuNew').onclick = () => {
  if(confirm('진행 중인 경기가 사라집니다. 새 경기를 설정할까요?')){
    $('#menuOvl').classList.remove('on'); S = null; save(); exitFS(); show('setup');
  }
};
$('#btnMenuRestart').onclick = () => {
  if(confirm('점수를 모두 0으로 초기화할까요?')){
    $('#menuOvl').classList.remove('on');
    const N = S.sc.length;
    Object.assign(S, { sc:Array(N).fill(0), inn:Array(N).fill(0), br:Array(N).fill(0), miss:Array(N).fill(0),
                       done:Array(N).fill(false), cush:Array(N).fill(0), cushInn:Array(N).fill(0),
                       finished:Array(N).fill(false), round:prefs.cushGoal ?? 1, lastInning:false, winners:[],
                       tp:0, turn:S.first, tc:0, timeMs:Array(N).fill(0), turnStart:Date.now(),
                       hist:[], fin:false, saved:false, t0:Date.now(), timeUp:false });
    save(); buildGameZones(); render(); toast('점수가 초기화되었습니다.');
  }
};
document.querySelectorAll('.ovl').forEach(o => o.addEventListener('pointerdown', e => { if (e.target === o) o.classList.remove('on'); }));
$('#targetOvl').addEventListener('pointerdown', e => { if (e.target === $('#targetOvl')) $('#targetOvl').classList.remove('on'); });
$('#btnTargetClose').onclick = () => $('#targetOvl').classList.remove('on');
if ($('#btnTimeClose')) $('#btnTimeClose').onclick = () => $('#timeOvl').classList.remove('on');

// ══ Queue & Init ══
function queueAdd(p){ const q = lsGet(LS_QUEUE, []); q.push(p); lsSet(LS_QUEUE, q); }
async function queueFlush(){
  if (!navigator.onLine) return;
  let q = lsGet(LS_QUEUE, []);
  if (!q.length) return;
  let newQ = [];
  let sent = 0;
  for (const p of q) {
    try {
      await submitGameSafe(p);
      sent++;
    } catch(e) {
      // 회복 가능한 실패는 대기열에 남긴다:
      //  - status 없음 → 네트워크 오류 (fetch 실패)
      //  - 401 토큰 만료, 429 과다요청, 5xx 서버 장애
      // 진짜 잘못된 요청(400/409/422 등)만 폐기해 큐가 막히지 않게 한다.
      const s = e.status;
      const recoverable = !s || s === 401 || s === 429 || s >= 500;
      if (recoverable) newQ.push(p);
      else console.error('Discarding bad payload', e);
    }
  }
  lsSet(LS_QUEUE, newQ);
  if (sent > 0) toast(`오프라인 기록 ${sent}건 동기화 완료!`);
}

function init(){
  setMode('login');
  if (auth) { if (auth.loginId) $('#aId').value = auth.loginId; loadTeams().then(loadMembers).then(loadClubEvents).then(()=>queueFlush()); }
  else { show('auth'); }

  // 구버전 상태 마이그레이션: finished 배열이 없으면 추가
  if (S && S.sc) {
    if (!Array.isArray(S.finished)) {
      const N = S.sc.length;
      S.finished = Array(N).fill(false);
      S.winners = S.winners || [];
      S.lastInning = S.lastInning || false;
      S.round = S.round ?? 1;
      if (!S.type) S.type = '2인';
    }
    if (!Array.isArray(S.rank)) {
      S.rank = Array(S.sc.length).fill(0);
    }
    if (typeof S.tc !== 'number') {
      S.tc = S.inn.reduce((a, b) => a + b, 0);
    }
    // 파울 집계는 도중 도입 — 진행 중이던 경기는 지금까지의 파울을 알 수 없어 0부터 센다
    if (!Array.isArray(S.fouls)) S.fouls = Array(S.sc.length).fill(0);
    // 알 이닝 분리도 도중 도입 — 진행 중이던 경기는 예전 cushInn(마무리 단계로 끝난 이닝)으로 되짚는다
    if (!Array.isArray(S.ballInn)) S.ballInn = S.inn.map((v, i) => Math.max(0, v - (S.cushInn[i] || 0)));
    if (!Array.isArray(S.timeMs)) { S.timeMs = Array(S.sc.length).fill(0); S.turnStart = Date.now(); }
    if (typeof S.timeLimitMs !== 'number') { S.timeLimitMs = 0; S.timeUp = false; }
    save();
  }

  if (S && S.sc && !S.fin) {
    buildGameZones(); render(); show('game'); queueFlush();
    if (S.paused) {
      $('#gameZones').classList.add('paused');
      $('#btnPause').textContent = '►';
      // 앱이 백그라운드/종료돼 있던 동안은 일시정지 구간에 포함시켜 시계에서 계속 제외
      S.pauseStart = Date.now();
    }
  } else if (auth) {
    syncSetup(); show('setup');
  }
}
// ══ 설정 모달 (팀 설정 / 내 정보 설정 / 음향 / 테마) ══ — 테마 헬퍼는 common.js 에서 import
(function initSettings(){
  const modal = $('#setModal'); if (!modal) return;
  const vbtn = $('#setVoice');
  const themeBtns = modal.querySelectorAll('#setTheme button');
  const sync = () => {
    vbtn.classList.toggle('on', voiceOn);
    const cur = getTheme();
    themeBtns.forEach(b => b.classList.toggle('on', b.dataset.t === cur));
  };
  const open = () => { sync(); modal.classList.add('on'); };
  const close = () => modal.classList.remove('on');
  $('#btnSettings').onclick = open;
  $('#setClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  $('#setTeam').onclick = () => { close(); if (auth) openTeamModal(); else toast('로그인이 필요합니다'); };
  $('#setMe').onclick = () => { location.href = '../record/?tab=me'; };
  vbtn.onclick = () => {
    voiceOn = !voiceOn; lsSet(LS_VOICE, voiceOn); updVoiceBtn(); vbtn.classList.toggle('on', voiceOn);
    if (voiceOn) speak('음성 안내를 켰습니다'); else { try { speechSynthesis.cancel(); } catch(e){} }
  };
  themeBtns.forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    try { if (t === 'system') localStorage.removeItem(LS_THEME); else localStorage.setItem(LS_THEME, t); } catch(e){}
    applyTheme(t); sync();
  });
  applyTheme(getTheme());
})();

window.addEventListener('online', queueFlush);
init();

// ══ 서비스 워커 등록 + 자동 업데이트 ══ (공통 모듈)
registerSW();

/* ══ 알림(웹 푸시) — 테스트(beta) 앱 전용 ══════════════════════════
 * 본 앱에서는 아래 -beta 검사에 걸려 UI 자체가 뜨지 않는다.
 * 게다가 푸시 구독은 서비스워커 스코프(/Dangdong-beta/)에 묶이므로,
 * 설령 코드가 본 앱에 올라가더라도 서로 다른 구독이라 알림이 섞일 수 없다.
 * 보내는 쪽은 저장소 밖의 로컬 스크립트: ~/Documents/dangdong-push/send.js
 */
const VAPID_PUBLIC = 'BJO7jjlFWFhPntIIWsmk0NTUpW67axk-3ikmxIt9OoXZIHjVx88dFUqhL_0OxBMvpeVyLdsrn65A8VpOK0KUwF0';
(function initPush(){
  const row = $('#setPushRow'), btn = $('#setPush');
  if (!row || !btn) return;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!location.pathname.includes('-beta') || !supported) return;   // 본 앱·미지원 브라우저는 조용히 숨긴다
  row.style.display = '';

  // VAPID 공개키(base64url) → subscribe() 가 요구하는 Uint8Array
  const b64ToU8 = s => {
    const raw = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  };
  const mark = on => btn.classList.toggle('on', !!on);
  const device = (navigator.userAgent.match(/iPhone|iPad|Android|Windows|Macintosh/) || ['기타'])[0];

  const saveSub = async sub => {
    const j = sub.toJSON();
    await sbFetch('/rest/v1/push_subscriptions_beta', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },   // 같은 기기면 새 행 대신 갱신
      body: JSON.stringify({
        endpoint: j.endpoint, p256dh: j.keys.p256dh, auth_key: j.keys.auth,
        user_id: auth ? auth.uid : null, label: device, scope: location.pathname
      })
    });
  };
  const dropSub = endpoint => sbFetch(
    '/rest/v1/push_subscriptions_beta?endpoint=eq.' + encodeURIComponent(endpoint),
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
  ).catch(()=>{});   // 실패해도 구독은 해지된다 — 죽은 주소는 send.js 가 410 받고 정리한다

  // 스위치는 추측하지 않고 "이 기기에 구독이 살아 있는가"를 그대로 비춘다.
  // 설정을 열 때마다 다시 확인한다 — 페이지 로드 때 한 번만 읽으면 껐다 켠 뒤 옛 상태가 남는다.
  const syncPush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const on = !!sub && Notification.permission === 'granted';
      mark(on);
      if (on) saveSub(sub).catch(()=>{});   // 표에 행이 빠져 있으면 조용히 되살린다
    } catch (_) { mark(false); }
  };
  syncPush();
  $('#btnSettings').addEventListener('click', syncPush);   // initSettings 의 onclick 과 별개로 붙는다

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub) {                                    // 켜져 있으면 → 끄기
        await dropSub(sub.endpoint);
        await sub.unsubscribe();
        mark(false); toast('알림을 껐습니다');
        return;
      }
      if (Notification.permission === 'denied') {
        toast('브라우저에서 알림이 차단돼 있어요 — 기기 설정에서 허용해 주세요'); return;
      }
      if (await Notification.requestPermission() !== 'granted') { toast('알림 권한이 없어 켜지 못했습니다'); return; }
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) });
      // 표에 못 넣으면 구독도 되돌린다 — 스위치는 켜졌는데 보낼 주소는 없는 상태를 만들지 않는다.
      try { await saveSub(sub); }
      catch (e) { await sub.unsubscribe().catch(()=>{}); throw e; }
      mark(true); toast('알림을 켰습니다');
    } catch (e) {
      toast('알림 설정 실패: ' + (e && e.message || e));
      syncPush();
    } finally { btn.disabled = false; }
  };
})();
