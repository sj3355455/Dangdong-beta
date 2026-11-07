import { sbFetch, sbAuth, patchAuth } from '../record/supabase.js';
import { registerSW, initSettingsModal, getVoice, setVoice, initTeamModal, fetchMyTeams, renderTeamBar as drawTeamBar,
         getBall, setBall, fetchRoster,
         pushAttach, logout, initPushSwitch, logVisit, initAdminEntry } from '../record/common.js';

const $ = s => document.querySelector(s);
const show = id => document.querySelectorAll('.screen').forEach(el => el.style.display = el.id === id ? 'flex' : 'none');
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

const LS_AUTH = 'dangScoreAuth', LS_PREFS = 'dangScorePrefs_v4', LS_MEM = 'dangScoreMem', LS_STATE = 'dangScoreState', LS_QUEUE = 'dangScoreQueue', LS_TEAM = 'dangCurrentTeam';
const MANUAL = '__MANUAL__';

let auth = lsGet(LS_AUTH, null);
let members = lsGet(LS_MEM, []);
let myTeams = [];                        // [{id,name,slug,is_admin}] — 내가 속한 팀들
let currentTeam = lsGet(LS_TEAM, null);  // 현재 기록 대상 팀 id (없으면 전역 폴백)
// myBall — 내 계정이 앉아 있는 자리. null 이면 어느 자리에도 없는 상태(앱을 처음 열었을 때의 기본값).
let prefs = lsGet(LS_PREFS, { gameType:'2인', names:['','','',''], pids:[null,null,null,null], targets:[15,15,15,15], myBall:null, cushGoal:1, timeLimit:0 });
if (prefs.cushGoal == null) prefs.cushGoal = 1;
if (prefs.timeLimit == null) prefs.timeLimit = 0;
if (!Array.isArray(prefs.targets3)) prefs.targets3 = [15,15,15,15];
// 예전에 저장된 자리에 같은 선수가 겹쳐 있으면 앞자리만 남긴다 — 이제는 고를 때 자리를 맞바꾸므로 겹칠 수 없다
prefs.pids.forEach((id, i) => { if (id && prefs.pids.indexOf(id) !== i) { prefs.pids[i] = null; prefs.names[i] = ''; } });
let S = lsGet(LS_STATE, null);

// ── 3구 / 4구 ── 설정 화면에서 고른다. 기록실과 같은 값을 쓴다(common.js).
// 목표 점수는 공 종류마다 따로 기억한다 — 4구 수지 15(=150)와 3구 15점은 전혀 다른 실력이다.
// 3구는 마무리 쿠션·파울이 없다. 수지(handicap3)는 목표 점수를 그대로 저장한다.
let ball = getBall();
const is3 = () => ball === '3구';
const T = () => is3() ? prefs.targets3 : prefs.targets;            // 지금 공 종류의 목표 점수 칸
const hdOf = m => m ? (is3() ? m.handicap3 : m.handicap) : null;    // 그 선수의 지금 공 종류 수지

const ZCOLORS = ['w','y','w','y'];
const ZNAMES = ['⚪ 흰 공', '🟡 노란 공', '⚪ 흰 공', '🟡 노란 공'];
const TZNAMES = ['우리 팀', '상대 팀'];

const api = {
  joinTeam: code => sbFetch('/rest/v1/rpc/join_team', { method: 'POST', body: JSON.stringify({ code }) }),
  myProfile: uid => sbFetch('/rest/v1/profiles?select=display_name&id=eq.' + uid),
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
    // 이 기기에 알림 권한이 이미 있으면 구독을 이 계정으로 다시 붙인다 (권한을 새로 묻지는 않는다).
    // 기다리지 않는다 — 로그인 화면 넘어가는 걸 붙잡을 이유가 없다.
    pushAttach(auth.uid);
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
$('#btnGuest').onclick = () => { syncSetup(); show('setup'); toast('게스트 모드 — 기록은 저장되지 않아요'); };
$('#btnLogout').onclick = async () => {
  if (!confirm('처음 화면으로 돌아갈까요?')) return;
  await logout();   // 알림 구독을 이 계정에서 떼고 로그인·소속 팀을 지운다
  auth = null; currentTeam = null; myTeams = [];
  show('auth');
};

// 내 소속 팀 목록을 불러오고 현재 팀을 확정한다. (실패 시 전역 폴백 유지)
async function loadTeams(){
  if (!auth || !auth.uid) { myTeams = []; renderTeamBar(); return; }
  try { ({ teams: myTeams, current: currentTeam } = await fetchMyTeams()); }
  catch(e){ /* my_teams 함수 미배포 등 → 전역 폴백 */ }
  renderTeamBar();
}

async function loadMembers(){
  try {
    let list = null;
    if (currentTeam) {
      try { list = await fetchRoster(currentTeam); }          // [{id, display_name, handicap, handicap3}]
      catch(e){ list = null; }                                // 로스터 실패 → 전역 폴백
    }
    if (!list) list = (auth && auth.uid) ? [{ id: auth.uid, display_name: auth.name, handicap: null }] : [];
    list.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '', 'ko'));
    members = list; lsSet(LS_MEM, members);
    // 로그인 사용자 본인 이름을 최신 프로필로 동기화 (개인정보에서 이름 변경 시 점수판에도 반영)
    if (auth && auth.uid) {
      const me = members.find(m => m.id === auth.uid);
      if (me && me.display_name && me.display_name !== auth.name) {
        auth = patchAuth({ name: me.display_name }) || auth;   // 갱신된 토큰을 옛 사본으로 덮지 않게
      }
    }
  } catch(e){ /* 완전 실패 시 캐시 유지 */ }
}

// 경기를 정기전에 묶어 저장하던 기능은 없앴다(2026-10). 모든 경기는 그냥 경기다.
// (정기전 일정·투표 자체는 캘린더에 그대로 있다. games.event_id 컬럼은 DB 에 남아 있지만 더는 채우지 않는다)
// 예전에 받아 둔 정기전 목록 캐시는 지운다.
try { localStorage.removeItem('dangClubEvents'); } catch(e){}

// 설정 화면 상단의 소속 팀 스위처
function renderTeamBar(){
  drawTeamBar(!!auth, myTeams, currentTeam, async id => {
    currentTeam = id; lsSet(LS_TEAM, currentTeam);
    await loadMembers(); syncSetup();
    toast('소속 팀 전환됨');
  });
}

// 팀 설정 모달 — 공통 모듈(common.js)로 이동. 앱별 차이(콜백)만 주입.
const { open: openTeamModal } = initTeamModal({
  getAuth: () => auth,
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; lsSet(LS_TEAM, currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: async () => { await loadMembers(); syncSetup(); },
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
            <b class="tval" id="tval${i}" style="font-size:1.2rem; line-height:1; padding-top:2px;">${T()[i]}</b>
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
            <b class="tval" id="tval${i}" style="font-size:1.2rem; line-height:1; padding-top:2px;">${T()[i]}</b>
            <div style="flex:1;"></div>
            <button class="mbtn" onclick="openTargetPopup(${i})">변경</button>
          </div>
        </div>
      `;
    }
  }
  $('#setupCards').innerHTML = html;
  syncCushSeg();
  syncTimeLimit();

  for (let i = 0; i < totalPlayers; i++) {
    fillSelect(i, modeChanged);
    const sel = $('#sel'+i);
    if(sel) {
      sel.onchange = () => {
        // 이미 다른 자리에 있는 선수를 고르면 그 자리와 맞바꾼다 — 같은 사람이 두 자리에 앉지 못하게
        const from = sel.value === MANUAL ? -1 : prefs.pids.indexOf(sel.value);
        if (from >= 0 && from !== i) return swapSeats(i, from);
        applySel(i, true); $('#name'+i).value = prefs.names[i]; syncMeCard();
      };
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
}

// 두 자리의 선수를 맞바꾼다. 목표 점수는 선수를 따라가고(3구·4구 칸 모두), 팀전은 팀 목표를 양쪽 다시 맞춘다.
// 지금 인원수에 안 보이는 자리와도 바꾼다 — 그래야 인원수를 늘렸을 때 겹친 선수가 나타나지 않는다.
function swapSeats(a, b){
  const swap = arr => { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; };
  [prefs.names, prefs.pids].forEach(swap);
  if (prefs.gameType === '팀전') { autoTarget(a); autoTarget(b); }
  else [prefs.targets, prefs.targets3].forEach(swap);
  lsSet(LS_PREFS, prefs);
  syncSetup();
}

// 선수를 바꾼 뒤 '나 / 상대' 표시만 다시 맞춘다. (카드를 통째로 다시 그리면 '직접 입력' 칸이 닫힌다)
function syncMeCard(){
  normalizeMyBall();
  document.querySelectorAll('#setupCards .pcard').forEach((c, i) => {
    const me = prefs.myBall === i;
    c.classList.toggle('me', me);
    const lbl = c.querySelector('.plbl');
    lbl.className = 'plbl ' + (me ? 'me' : 'opp');
    lbl.textContent = me ? '나' : '상대';
  });
}

function fillSelect(i, isUserAction = false){
  const sel = $('#sel'+i);
  if(!sel) return;
  const cur = prefs.pids[i];
  
  // 내 이름은 맨 위에 표시를 붙여 둔다 — 다른 부원과 똑같이 어느 자리에서든 고른다.
  const isMine = m => !!auth && m.id === auth.uid;
  const listMembers = [...members.filter(isMine), ...members.filter(m => !isMine(m))];

  // 아직 아무도 안 고른 자리는 숨긴 빈 옵션을 맨 앞에 둔다 — 그냥 두면 브라우저가 첫 선수를
  // 골라 놓고 applySel 이 그 사람으로 저장해 버린다. ('선수 선택…' 같은 글자는 넣지 않는다)
  const blank = !cur && !prefs.names[i] ? '<option value="" style="display:none;"></option>' : '';
  sel.innerHTML = blank + listMembers.map(m => `<option value="${esc(m.id)}">${esc(m.display_name)}${isMine(m) ? ' ⭐' : ''}</option>`).join('') +
    `<option value="${MANUAL}">✏️ 직접 입력</option>`;
  sel.value = cur || (prefs.names[i] ? MANUAL : '');

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
    if (isUserAction) autoTarget(i);
  } else { prefs.pids[i] = null; prefs.names[i] = ''; }
  lsSet(LS_PREFS, prefs);
}

// 자리 i 의 목표 점수를 그 선수의 수지(지금 공 종류)로 맞춘다. 팀전은 두 선수 평균.
// 수지를 모르는 선수면 그대로 둔다(직접 고친 값이 날아가지 않게).
function autoTarget(i){
  const t = T();
  if (prefs.gameType === '팀전') {
    const k = i % 2;
    const hs = [prefs.pids[k], prefs.pids[k + 2]]
      .map(id => hdOf(members.find(x => x.id === id))).filter(h => h != null).map(Number);
    if (hs.length) t[k] = Math.round(hs.reduce((a, b) => a + b, 0) / hs.length);
    if ($('#tval'+k)) $('#tval'+k).textContent = t[k];
  } else {
    const h = hdOf(members.find(x => x.id === prefs.pids[i]));
    if (h != null) t[i] = scaledTarget(Number(h), prefs.gameType);
    if ($('#tval'+i)) $('#tval'+i).textContent = t[i];
  }
}

// 3구/4구 바꾸기 — 이미 앉혀 둔 선수들의 목표 점수를 새 공 종류의 수지로 다시 맞춘다
document.querySelectorAll('#ballSeg button').forEach(b => {
  b.onclick = () => {
    if (ball === b.dataset.b) return;
    ball = b.dataset.b; setBall(ball);
    const slots = prefs.gameType === '팀전' ? [0, 1] : [0, 1, 2, 3];
    slots.forEach(i => { if (prefs.pids[i] || prefs.pids[i + 2]) autoTarget(i); });
    lsSet(LS_PREFS, prefs); vib(8);
    syncSetup();
  };
});

document.querySelectorAll('#gameTypeSeg button').forEach(b => {
  b.onclick = () => {
    const newVal = b.dataset.v || b.innerText;
    const modeChanged = (prefs.gameType !== newVal);
    prefs.gameType = newVal;
    // 인원수를 바꿔도 내 자리를 임의로 잡아주지 않는다. 내 자리는 normalizeMyBall 이
    // 내 계정이 실제로 있는 자리에서 다시 계산한다(없으면 어디에도 안 속한 상태).
    lsSet(LS_PREFS, prefs);
    syncSetup(modeChanged);
  };
});

// 내 자리는 별도 상태가 아니라 "내 계정이 실제로 들어가 있는 자리"에서 그대로 끌어온다.
// 그래서 아무 자리도 안 고른 첫 진입에는 null(=1~4번 어디에도 안 속함)이 되고,
// 인원수를 바꿔 자리가 사라지면 저절로 풀린다. 자리에 넣는 건 선수 목록에서 내 이름을 고르는 것뿐.
function normalizeMyBall(){
  const isTeam = prefs.gameType === '팀전';
  const slots = isTeam ? 2 : parseInt(prefs.gameType.replace('인',''), 10);
  let me = null;
  if (auth) {
    for (let i = 0; i < slots; i++) {
      // 팀전은 팀 단위라 2번 시드에 내가 있어도 그 팀이 내 자리
      if (prefs.pids[i] === auth.uid || (isTeam && prefs.pids[i + 2] === auth.uid)) { me = i; break; }
    }
  }
  if (prefs.myBall !== me) { prefs.myBall = me; lsSet(LS_PREFS, prefs); }
}

function syncSetup(modeChanged = false){
  normalizeMyBall();
  renderTeamBar();

  document.querySelectorAll('#ballSeg button').forEach(b => b.classList.toggle('on', b.dataset.b === ball));
  $('#cushRow').style.display = is3() ? 'none' : '';   // 3구는 마무리 쿠션이 없다
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
  $('#targetOvlTitle').textContent = `${who} 목표 점수 (${ball})`;
  $('#tvalEdit').textContent = T()[i];
  $('#targetOvl').classList.add('on');
};
const stepTarget = d => e => {
  e.preventDefault(); e.stopPropagation();
  const i = curTargetEdit, t = T();
  t[i] = Math.max(1, Math.min(99, t[i] + d));
  $('#tvalEdit').textContent = t[i];
  if($('#tval'+i)) $('#tval'+i).textContent = t[i];
  lsSet(LS_PREFS, prefs); vib(8);
};
$('#btnTargetMinus').onclick = stepTarget(-1);
$('#btnTargetPlus').onclick = stepTarget(1);

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

$('#btnStart').onclick = () => {
  const err = $('#sErr'); err.textContent = '';
  const isTeam = prefs.gameType === '팀전';
  const N = isTeam ? 4 : parseInt(prefs.gameType.replace('인',''), 10);

  let pNames = [], pPids = [], pTargets = [];
  for(let i=0; i<N; i++){
    const nm = $('#name'+i) ? $('#name'+i).value.trim() : prefs.names[i];
    if(!nm && prefs.pids[i]) pNames.push(members.find(x => x.id === prefs.pids[i])?.display_name || '');
    else pNames.push(nm || '');
    pPids.push(prefs.pids[i] || null);
  }
  
  const uniqueKeys = new Set();
  for(let i=0; i<N; i++){
    if(!pNames[i]) return err.textContent = '모든 선수를 선택하거나 이름을 입력하세요';
    // 직접 입력한 이름이 부원 이름과 같으면 그 부원으로 본다
    const pid = pPids[i] || members.find(m => m.display_name === pNames[i])?.id;
    const key = pid ? 'id:' + pid : 'nm:' + pNames[i];
    if(uniqueKeys.has(key)) return err.textContent = '중복된 선수가 있습니다. 각기 다른 선수를 선택해주세요.';
    uniqueKeys.add(key);
  }
  
  const t = T();
  if (isTeam) {
    pTargets = [t[0], t[1], t[0], t[1]];
  } else {
    for(let i=0; i<N; i++) pTargets.push(t[i]);
  }

  prefs.names = pNames;
  prefs.pids = pPids;
  lsSet(LS_PREFS, prefs);

  S = {
    type: prefs.gameType, ball,
    names: [...pNames], pids: [...pPids], targets: [...pTargets],
    first: 0, timeLimitMs: (prefs.timeLimit ?? 0) * 60000,
    ...freshCounters(N, 0, is3() ? 0 : (prefs.cushGoal ?? 1))
  };
  save(); buildGameZones(); render(); show('game'); wakeLock();
  toast(`${isTeam ? TZNAMES[S.first] : S.names[S.first]} 선공으로 시작!`);
  speak('게임 시작');
};

// ══ Game Logic ══
let ts = null;
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(ts); ts = setTimeout(()=>t.classList.remove('on'), 2500); };
const vib = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch(e){} };

// 점수 음성 안내: 탭할 때마다 현재 점수를 한국어로 읽어준다 (메뉴에서 켜고 끔)
let voiceOn = getVoice();
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

// 한 경기의 진행 기록 — 새 경기와 '점수 초기화'가 같은 출발점을 쓴다.
// (따로 적어 두면 한쪽에만 새 항목이 늘어, 초기화한 뒤에도 개인 점수·알 이닝·파울이 남는다)
// round = 마무리 쿠션 개수. 3구는 늘 0 — 목표에 닿는 순간 달성이고 후구로 넘어간다.
function freshCounters(N, turn, round){
  const z = () => Array(N).fill(0);
  return {
    sc: z(), indSc: z(), inn: z(), ballInn: z(), br: z(), miss: z(), fouls: z(),
    done: Array(N).fill(false), cush: z(), indCush: z(), cushInn: z(),
    finished: Array(N).fill(false), rank: z(), cushGoalAt: Array(N).fill(null),
    plus: z(),   // 3구 연장으로 목표에 더해진 점수 (선수별)
    round, lastInning: false, winners: [],
    tp: 0, tpPts: 0, turn, tc: 0,
    timeMs: z(), turnStart: Date.now(), timeUp: false,
    paused: false, pausedMs: 0, pauseStart: null, bgStart: null,
    hist: [], fin: false, saved: false, t0: Date.now()
  };
}

let wl = null;
// 화면 꺼짐 방지 — 경기 화면에 있는 동안 내내 건다. 앱이 가려지면 브라우저가 풀어 버려서 돌아올 때 다시 건다.
async function wakeLock(){
  if (wl && !wl.released) return;
  try { wl = await navigator.wakeLock.request('screen'); } catch(e){}
}
function wakeUnlock(){
  if (wl) wl.release().catch(()=>{});
  wl = null;
}

// 앱이 화면에서 사라진 동안(전화·메시지 확인 등)은 경기 시계와 선수 시간을 멈춘다.
// 일시정지와 달리 돌아오면 저절로 이어진다. 이미 일시정지 중이면 그쪽 계산이 이 구간까지 덮으므로 건너뛴다.
// bgStart 를 저장해 두므로 백그라운드에서 앱이 꺼져도 다시 켤 때 init 이 마저 계산한다.
function bgPause(){
  if (!S || S.fin || S.paused || S.bgStart) return;
  const now = Date.now();
  if (S.timeMs && S.turnStart != null) {
    S.timeMs[S.turn] = (S.timeMs[S.turn] || 0) + (now - S.turnStart);
  }
  S.turnStart = null;
  S.bgStart = now;
}
function bgResume(){
  if (!S || !S.bgStart) return;
  const now = Date.now();
  S.pausedMs = (S.pausedMs || 0) + (now - S.bgStart);
  S.bgStart = null;
  S.turnStart = now;
  save();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S) wakeLock();
    bgResume();
    queueFlush();
  }
  else { bgPause(); save(); }
});

// 게임 시계: 총 경과 시간 표시 (일시정지된 시간은 제외)
setInterval(() => {
  if (!S || S.fin) return;
  const el = $('#gameClock');
  if (!el) return;
  // 일시정지·백그라운드 중엔 멈춘 순간의 시간으로 고정 표시 (앱을 다시 켠 직후에도 0:00 이 되지 않게)
  const stoppedAt = S.paused ? S.pauseStart : S.bgStart;
  const pausedMs = S.pausedMs || 0;
  const elapsed = (stoppedAt || Date.now()) - S.t0 - pausedMs;
  const secs = Math.floor(elapsed / 1000);
  const mmss = t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const limitStr = S.timeLimitMs > 0 ? mmss(Math.floor(S.timeLimitMs / 1000)) : '∞';
  el.textContent = `${mmss(secs)} / ${limitStr}`;
  el.style.color = S.timeUp ? '#e5484d' : '';
  // 시간제한: 다 되면 플래그만 세우고, 실제 종료는 이번 이닝이 끝날 때(passTurnInner)
  if (!stoppedAt && S.timeLimitMs > 0 && !S.timeUp && elapsed >= S.timeLimitMs) {
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
  } else {
    // 재개: 정지 구간을 누적 정지시간에 더하고, 턴 타이머를 다시 시작
    S.pausedMs = (S.pausedMs || 0) + (now - (S.pauseStart || now));
    S.paused = false;
    S.turnStart = now;
  }
  setPausedUI(S.paused);
  save();
};

// 일시정지 화면 — 점수 칸을 어둡게 막고, 버튼은 누르면 될 일(▶ 재개 / ‖ 정지)을 보여 준다
const ICON_PLAY  = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
function setPausedUI(on){
  $('#gameZones').classList.toggle('paused', on);
  $('#pauseOverlay').style.opacity = on ? '1' : '0';
  $('#btnPause').innerHTML = on ? ICON_PLAY : ICON_PAUSE;
}

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
    gameHtml += `
      <div class="zone" id="zone${i}">
        <button class="minusbtn" id="mbtn${i}">파울</button>
        <span class="runbadge" id="run${i}">+0</span>
        <div class="zname">
          <div class="zname-text"><span id="gball${i}" style="margin-right:4px"></span><span id="gname${i}">${esc(zname)}</span></div>
          <span class="turnchip">치는 중</span>
        </div>
        <div class="zscore" id="gsc${i}">0</div>
        <div class="zstats" id="gstat${i}">에버 0.000 · 하이런 0</div>
      </div>
    `;
  }
  
  // insert zones into #gameZones
  $('#gameZones').innerHTML = gameHtml;
  $('#game').classList.toggle('b3', isB3());   // 3구는 파울 버튼을 숨긴다(CSS)
  
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
    plus: S.plus ? [...S.plus] : null,
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
      const rem = goal(i) - S.sc[i];
      if (S.sc[i] >= goal(i)) {
        S.done[i] = true;
        // 이 이닝의 쿠션 카운트는 턴이 끝날 때 passTurnInner(647)에서 세므로 여기서 세면 이중 카운트가 된다.
        if (S.type === '팀전' && S.sc.length === 4) { const p = (i+2)%4; S.done[p] = true; }
        if (S.round <= 0) {
          // 마무리 쿠션 0개 설정: 목표 도달 즉시 달성
          const firstWin = S.winners.length === 0;
          markGoalReached(i);
          passTurnInner(false, true, true);
          // 바로 끝나지 않으면(후구가 남으면) 쿠션 게임과 동일하게 후구 안내.
          // 이 이닝에서 바로 연장이 붙었으면(lastInning 이 풀림) '연장' 안내를 덮지 않는다.
          if (!S.fin && S.lastInning) speak(firstWin ? '후구' : '후구 성공');
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
        if (!S.fin && S.lastInning) speak(firstWin ? '후구' : '후구 성공');
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
// 지금 경기가 3구인가 (ball 이 없는 진행 중 경기는 이 기능 전에 시작한 4구다)
const isB3 = () => !!S && S.ball === '3구';
// 지금 목표 점수 — 3구 연장이 붙었으면 그만큼 더한다. 저장하는 목표(target)는 원래 값 그대로다.
const goal = i => S.targets[i] + ((S.plus && S.plus[i]) || 0);
// 선수 개인 점수·쿠션 — 팀전은 sc/cush 가 팀 공유값이라 개인 몫은 indSc/indCush 에 따로 센다
const indScore  = i => (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];
const indCushOf = i => (S.indCush && S.indCush[i] !== undefined) ? S.indCush[i] : S.cush[i];

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
    S.lastInning = false;
    S.winners = [];
    vib([40,40,40]);
    const tieLabel = activePlayerCount() < S.sc.length ? '공동 꼴등' : '동점';
    if (isB3()) {
      // 3구는 마무리 쿠션이 없다 → 남아 있는 동점자 모두 목표 +1점으로 연장.
      // (남은 유닛이 전부 동시 달성이라 여기 오므로, 아직 안 끝난 선수 = 동점자다)
      if (!S.plus) S.plus = Array(S.sc.length).fill(0);
      S.sc.forEach((_, i) => { if (!S.finished[i]) { S.plus[i]++; S.done[i] = false; } });
      const p = S.plus[S.finished.indexOf(false)];
      toast(`${tieLabel}! 목표 +${p}점 — 연장`);
    } else {
      S.round++;
      // 연장 이닝은 선구 선수 몫으로 계상. 꼴등전 중이면 이미 끝난 선수 대신 남아 있는 다음 선수에게.
      S.cushInn[S.finished[S.first] ? nextTurnIndex(S.first) : S.first]++;
      toast(`${tieLabel}! 마무리 쿠션 ${S.round} — 연장`);
    }
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
  if (!S || S.fin || i !== S.turn || S.finished[i] || S.paused || isB3()) return;   // 3구는 파울이 없다
  pushHist();
  S.sc[i]--; if (S.indSc) S.indSc[i]--;
  // 파울 횟수는 '선수 개인' 기록 — 팀전이라도 짝꿍에게 미러링하지 않는다(아래 미러링 블록 참고)
  if (!S.fouls) S.fouls = Array(S.sc.length).fill(0);
  S.fouls[i]++;
  // 이미 목표를 달성해 마무리 쿠션 중이었는데 점수가 목표 밑으로 내려가면 완주 상태 해제
  if (S.done[i] && S.sc[i] < goal(i)) {
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
    if (ballSpan) ballSpan.textContent = isWhite ? '⚪ ' : '🟡 ';
    
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
        gscEl.innerHTML = `${S.sc[i]}<span style="font-size:0.45em;opacity:0.55;font-weight:700"> / ${goal(i)}</span>`;
        gscEl.style.fontSize = 'clamp(64px, 22vmin, 150px)';
      }
      // 에버 분모는 알 이닝(= 총 이닝 − 쿠션 이닝). 이 분기는 아직 알을 치는 중이라 현재 턴도 알 이닝으로 센다.
      const curInn = Math.max(1, ballInn(i) + (S.turn === i ? 1 : 0));
      const ev = (indScore(i) / curInn).toFixed(3);
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
    $('#inning').textContent = `${isB3() ? '3구 · ' : ''}${Math.max(...S.inn) + 1} 이닝`;
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

// 새 경기는 event_id 를 보내지 않지만, 정기전 구분을 없애기 전에 오프라인 큐에 쌓인 기록에는
// 남아 있을 수 있다. 그 컬럼 때문에 400 으로 떨어져 경기 기록 자체를 잃으면 안 되니
// 소속만 떼고 한 번 더 보낸다 — 사라진 기록은 되살릴 방법이 없다.
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
    pl.push({
      id: S.pids[i] || null, name: S.names[i], win: rank === 1, rank,
      score: indScore(i), target: S.targets[i], innings: S.inn[i],   // target 은 연장 전 원래 목표
      ballInn: ballInn(i),   // 알 이닝 — 에버·득점률·평균 타수의 분모
      highRun: S.br[i], misses: S.miss[i], fouls: (S.fouls && S.fouls[i]) || 0, cushMade: indCushOf(i),
      cushInn: S.cushInn[i], timeMs: (S.timeMs && S.timeMs[i]) || 0, isTeam,
      // 3구 표시 — 기록실이 이걸로 3구/4구를 가른다. 4구 기록은 예전 모양 그대로 둔다.
      // (3구는 파울이 없으니 fouls 는 0 — '파울 없음'이 사실이라 평균 타수도 계산된다)
      ...(isB3() ? { ball: 3 } : {})
    });
  }
  const payload = { recorded_by: auth.uid, played_at: new Date(S.t0).toISOString(), players: pl, team_id: currentTeam || null };
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
    const indS = indScore(i), indC = indCushOf(i);
    // 이미 등수가 확정된 선수는 그때의 쿠션 개수로 표시(꼴등 연장으로 S.round 가 올라간 경우 대비)
    const cushGoal = (S.cushGoalAt && S.cushGoalAt[i] != null) ? S.cushGoalAt[i] : S.round;
    const scStr = (S.done[i] && cushGoal > 0) ? `쿠션 ${indC}/${cushGoal}` : `${indS}/${goal(i)}`;
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
// 목표를 다 못 채웠어도 지금까지의 진행도로 순위를 매겨 경기를 종료·저장한다.
//   1순위: 알 달성률 = 뺀 점수 ÷ 목표점수 (최대 100%)
//   2순위: 낸 마무리 쿠션 수 — 알 달성률이 같을 때만 본다(쿠션은 알을 다 뺀 뒤에만 치므로 사실상 100%끼리)
//
// 예전엔 쿠션 1개 = 알 3개로 환산해 한 비율로 합쳤는데, 그러면 쿠션 비중이 목표점수에 따라 달라진다
// (목표 10점에겐 쿠션 3개가 목표의 90%, 목표 30점에겐 30%). 그래서 알을 다 뺀 수지 100 선수가
// 아직 알을 치는 수지 300 선수보다 아래로 가는 일이 생겼다. 알과 쿠션은 섞지 않는다.
// sc/cush 는 팀전에서 팀 공유값이다. 3구 연장 중이면 늘어난 목표로 잰다.
const ballRatio = i => goal(i) > 0 ? Math.min(1, S.sc[i] / goal(i)) : 1;
const cushMade = i => S.done[i] ? (S.cush[i] || 0) : 0;
// o 가 r 보다 확실히 앞서 있나 (동률이면 false → 공동 등수)
function progAhead(o, r){
  const EPS = 1e-9, bo = ballRatio(o), br = ballRatio(r);
  if (bo > br + EPS) return true;
  if (br > bo + EPS) return false;
  return cushMade(o) > cushMade(r);
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
  pending.forEach(r => {
    const better = pending.filter(o => progAhead(o, r)).length;
    const rk = nextRank + better;
    out[r] = rk;
    if (isTeam) out[r + 2] = rk;
  });
  return out;
}

// 아직 순위가 확정되지 않은 유닛을 위의 잠정 순위 그대로 확정한다.
// 이미 정식 완주해 순위가 있는 선수는 그대로 두고, 나머지를 그 뒤 등수로 채운다.
function rankRemainingByRatio(){ S.rank = displayRanks(); }

// 지금 점수로 경기를 끝낸다 — 남은 선수는 달성 비율로 순위를 매기고 1등을 승자로 세운다
function finishByRatio(){
  rankRemainingByRatio();
  S.finished = S.finished.map(() => true);
  S.lastInning = false;
  S.winners = S.rank.flatMap((r, i) => r === 1 ? [i] : []);
  S.fin = true;
  save();
  showEarlyResult();
}
// 시간제한 종료: 이닝 경계에서 호출되므로 추가 이닝 마감 없이 현재 점수로 순위 확정
function endGameByTime(){
  if (!S || S.fin) return;
  finishByRatio();
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
  rewindToRoundEnd();   // 한 바퀴가 끝난 시점까지 되감아 반쪽 이닝을 기록에서 뺀다
  finishByRatio();
  saveGame();
}
function showEarlyResult(){
  const N = S.sc.length;
  const isTeam = S.type === '팀전' && N === 4;
  const winOvl = $('#winOvl');
  winOvl.classList.add('on');
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
    const scStr = (S.done[i] && S.round > 0) ? `${S.targets[i]} + 쿠션${indCushOf(i)}` : `${indScore(i)} / ${goal(i)}`;
    // 알 달성률, 그리고 알을 다 뺀 사람은 쿠션 진행을 따로 붙인다 (예: 100.0% + 쿠션 2/3)
    const pct = (ballRatio(i) * 100).toFixed(1) + '%' + (S.done[i] && S.round > 0 ? ` + 쿠션 ${cushMade(i)}/${S.round}` : '');
    const medal = S.rank[i] === 1 ? '🏆 ' : '';
    html += `<tr><td>${esc(nm)}</td><td>${medal}${S.rank[i]}위</td><td>${scStr}</td><td>${pct}</td></tr>`;
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
  $('#winOvl').classList.remove('on'); S = null; save(); wakeUnlock(); syncSetup(); show('setup');
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

$('#btnMenu').onclick = () => $('#menuOvl').classList.add('on');
$('#btnMenuClose').onclick = () => $('#menuOvl').classList.remove('on');

// 음성 켬/끔 — 게임 메뉴 버튼과 설정 창 스위치가 같은 값을 바꾼다
const updVoiceBtn = () => { $('#btnVoice').textContent = voiceOn ? '🔊 점수 음성: 켜짐' : '🔇 점수 음성: 꺼짐'; };
function voiceChanged(on){
  voiceOn = on; updVoiceBtn();
  if (on) speak('음성 안내를 켰습니다'); else { try { speechSynthesis.cancel(); } catch(e){} }
}
updVoiceBtn();
$('#btnVoice').onclick = () => { setVoice(!voiceOn); voiceChanged(!voiceOn); };
$('#btnEndGame').onclick = () => {
  if(confirm('지금까지 뺀 알의 비율로 순위를 정하고(알을 다 뺀 사람끼리는 마무리 쿠션 수로) 경기를 기록할까요?')){
    $('#menuOvl').classList.remove('on');
    endGameEarly();
  }
};
$('#btnMenuNew').onclick = () => {
  if(confirm('진행 중인 경기가 사라집니다. 새 경기를 설정할까요?')){
    $('#menuOvl').classList.remove('on'); S = null; save(); wakeUnlock(); syncSetup(); show('setup');
  }
};
$('#btnMenuRestart').onclick = () => {
  if(confirm('점수를 모두 0으로 초기화할까요?')){
    $('#menuOvl').classList.remove('on');
    Object.assign(S, freshCounters(S.sc.length, S.first, isB3() ? 0 : (prefs.cushGoal ?? 1)));
    setPausedUI(false);
    save(); buildGameZones(); render(); toast('점수가 초기화되었습니다.');
  }
};
document.querySelectorAll('.ovl').forEach(o => o.addEventListener('pointerdown', e => { if (e.target === o) o.classList.remove('on'); }));
$('#btnTargetClose').onclick = () => $('#targetOvl').classList.remove('on');
$('#btnTimeClose').onclick = () => $('#timeOvl').classList.remove('on');

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
  if (auth) { if (auth.loginId) $('#aId').value = auth.loginId; loadTeams().then(loadMembers).then(()=>queueFlush()); }
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
    buildGameZones(); render(); show('game'); queueFlush(); wakeLock();
    // 앱이 꺼져 있던 시간도 시계에서 뺀다 — 일시정지 중이었다면 pauseStart 를 그대로 두면 재개할 때 함께 빠진다
    if (document.visibilityState === 'visible') bgResume();
    if (S.paused) setPausedUI(true);
  } else if (auth) {
    syncSetup(); show('setup');
  }
}
// ══ 설정 모달 (팀 설정 / 내 정보 설정 / 음향 / 테마) ══ — 공통 모듈
initSettingsModal({
  onTeam: () => { if (auth) openTeamModal(); else toast('로그인이 필요합니다'); },
  onMe: () => { location.href = '../record/?tab=me'; },   // 내 정보 화면은 기록실에만 있다
  onVoice: voiceChanged
});

window.addEventListener('online', queueFlush);
init();

// ══ 서비스 워커 등록 + 자동 업데이트 ══ (공통 모듈)
registerSW();
logVisit('score', () => auth?.uid);   // 관리자 메뉴의 방문 기록 (30분 넘게 비웠다 들어올 때만 센다)
initAdminEntry(() => auth?.uid, () => { location.href = '../record/?tab=admin'; });   // 관리자 메뉴는 기록실에 있다

/* ══ 알림(웹 푸시) — 본 앱·테스트 앱 공통 ══════════════════════════
 * 푸시 구독은 서비스워커 스코프(/Dangdong/ 또는 /Dangdong-beta/)에 묶이므로 두 앱은 서로 다른 구독이다.
 * 보내는 쪽이 구독마다 scope 를 보고, 알림을 누르면 그 기기가 구독한 앱이 열리게 한다.
 * 보내는 쪽은 Supabase Edge Function — 모임은 notify-meetup, 정기전 하루 전은 notify-event.
 * (저장소 밖 ~/Documents/dangdong-push/send.js 는 손으로 쏘는 예비 수단)
 */
// 설정의 스위치는 공통 모듈(initPushSwitch)이 그린다 — 기록실·캘린더 설정 창에도 같은 스위치가 있다.
initPushSwitch(() => auth ? auth.uid : null);
