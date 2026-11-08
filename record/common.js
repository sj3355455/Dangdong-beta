// 당동 공통 모듈 — score/ · record/ · calendar/ 가 공유 (테마 · 설정 창 · 팀 · 서비스워커 · 알림)
import { sbFetch } from './supabase.js';

const $id = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

// ── 테마 ──
export const LS_THEME = 'dangTheme';
export const getTheme = () => { try { return localStorage.getItem(LS_THEME) || 'system'; } catch(e){ return 'system'; } };
export function applyTheme(t){
  const r = document.documentElement;
  if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t);
  else r.removeAttribute('data-theme');
}

// ── 3구 / 4구 ── 점수판·기록실이 같은 값을 나눠 쓴다 (점수판에서 3구를 골랐으면 기록실도 3구로 열린다)
// 3구 경기는 games.players 의 선수마다 ball: 3 이 붙는다. 없으면(그 전 기록 전부) 4구다.
const LS_BALL = 'dangBall';
export const getBall = () => { try { return localStorage.getItem(LS_BALL) === '3구' ? '3구' : '4구'; } catch(e){ return '4구'; } };
export const setBall = b => { try { localStorage.setItem(LS_BALL, b === '3구' ? '3구' : '4구'); } catch(e){} };
export const ballOfGame = g => (Array.isArray(g.players) && g.players[0] && g.players[0].ball === 3) ? '3구' : '4구';
// 3구 수지 = 목표 점수 그대로 저장한다 (4구는 표시 수지 ÷ 10). 마무리 쿠션·파울이 없다.
export const HD3_OPTIONS = [5, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40];

// 팀 명단 → [{ id, display_name, handicap, handicap3 }]
// handicap3 칸이 아직 없는 DB(sql/handicap3.sql 실행 전)면 400 이 난다 → 그 칸만 빼고 다시 읽는다.
export async function fetchRoster(teamId){
  const q = cols => sbFetch('/rest/v1/team_members?select=profiles(' + cols + ')&team_id=eq.' + teamId);
  let rows;
  try { rows = await q('id,display_name,handicap,handicap3'); }
  catch(e){ if (e.status !== 400) throw e; rows = await q('id,display_name,handicap'); }
  return (rows || []).map(r => r && r.profiles).filter(Boolean);
}

// 3구 수지 저장 (본인 또는 관리자). 4구 수지와 달리 rename_player 를 거치지 않고 칸을 직접 고친다.
export async function saveHandicap3(uid, v){
  let rows;
  try {
    rows = await sbFetch('/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ handicap3: v })
    });
  } catch(e){
    if (e.status === 400) throw new Error('3구 수지 칸이 아직 없습니다 — sql/handicap3.sql 을 실행해 주세요');
    throw e;
  }
  if (!rows || !rows.length) throw new Error('권한이 없습니다');   // RLS 에 막히면 오류 대신 빈 배열이 온다
}

// ── 점수 음성 켬/끔 ── 세 화면이 같은 값을 쓴다 (소리는 점수판에서만 나지만 설정은 어디서든 바꾼다)
const LS_VOICE = 'dangScoreVoice';
export const getVoice = () => { try { const v = localStorage.getItem(LS_VOICE); return v == null ? true : JSON.parse(v); } catch(e){ return true; } };
export const setVoice = b => { try { localStorage.setItem(LS_VOICE, JSON.stringify(b)); } catch(e){} };

/* ══ 설정 창 (⚙️) ══ — 세 화면에 같은 마크업(#setModal)이 있다.
   앱마다 다른 건 '팀 설정'·'내 정보 설정'을 눌렀을 때 갈 곳과, 음성을 바꿨을 때 할 일뿐이다.
   opt: { onTeam(), onMe(), onVoice(on) }  — 셋 다 창을 닫은 뒤에 불린다(onVoice 는 창을 닫지 않는다) */
export function initSettingsModal(opt){
  const modal = $id('setModal'); if (!modal) return;
  const vbtn = $id('setVoice');
  const themeBtns = modal.querySelectorAll('#setTheme button');
  const sync = () => {
    vbtn.classList.toggle('on', getVoice());
    const cur = getTheme();
    themeBtns.forEach(b => b.classList.toggle('on', b.dataset.t === cur));
  };
  const close = () => modal.classList.remove('on');
  $id('btnSettings').onclick = () => { sync(); modal.classList.add('on'); };
  $id('setClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  $id('setTeam').onclick = () => { close(); opt.onTeam(); };
  $id('setMe').onclick = () => { close(); opt.onMe(); };
  vbtn.onclick = () => {
    const on = !getVoice();
    setVoice(on); vbtn.classList.toggle('on', on);
    if (opt.onVoice) opt.onVoice(on);
  };
  themeBtns.forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    // '시스템'은 값을 지워서 표현한다 — 문자열로 저장하면 다른 화면이 못 알아본다
    try { if (t === 'system') localStorage.removeItem(LS_THEME); else localStorage.setItem(LS_THEME, t); } catch(e){}
    applyTheme(t); sync();
  });
  applyTheme(getTheme());
}

// ── 소속 팀 ── 세 화면이 localStorage 의 같은 열쇠로 '지금 보는 팀'을 나눠 쓴다
const LS_TEAM = 'dangCurrentTeam';

// 내 소속 팀 목록과 지금 볼 팀. 기억해 둔 팀이 목록에 없으면(나갔거나 처음이면) 첫 팀으로.
// 실패하면 던진다 — 부르는 쪽이 지금 상태를 그대로 두고 넘어간다(my_teams 미배포·오프라인).
export async function fetchMyTeams(){
  const rows = await sbFetch('/rest/v1/rpc/my_teams', { method: 'POST', body: '{}' });
  const teams = Array.isArray(rows) ? rows : [];
  let current = null;
  try { current = JSON.parse(localStorage.getItem(LS_TEAM)); } catch(e){}
  if (!teams.some(t => t.id === current)) current = teams[0] ? teams[0].id : null;
  try { localStorage.setItem(LS_TEAM, JSON.stringify(current)); } catch(e){}
  return { teams, current };
}

// 머리의 소속 팀 스위처(#teamBar / #teamSel). 팀이 하나뿐이면 보여 주기만 한다. onPick(id) = 바꿨을 때 할 일
export function renderTeamBar(authed, teams, current, onPick){
  const bar = $id('teamBar'), sel = $id('teamSel');
  if (!bar || !sel) return;
  if (!authed) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  sel.innerHTML = teams.length
    ? teams.map(t => `<option value="${esc(t.id)}"${t.id === current ? ' selected' : ''}>${esc(t.name)}</option>`).join('')
    : '<option value="">소속 팀 없음</option>';
  sel.disabled = teams.length < 2;
  sel.onchange = () => { if (sel.value) onPick(sel.value); };
}

// 로그아웃 — 알림 구독을 먼저 끊는다(아래 pushDetach 설명). 소속 팀도 지운다 — 남아 있으면
// 로그아웃 상태로 그 팀 id 로 조회를 시도해 빈 결과가 아니라 권한 오류로 떨어진다.
export async function logout(){
  await pushDetach();
  try { localStorage.removeItem('dangScoreAuth'); localStorage.removeItem(LS_TEAM); } catch(e){}
}

// ══ 기간 선택기 (기록실 조회 기간 · 캘린더 일정 기간이 함께 쓴다) ══
// 시작·종료를 따로 두지 않고 달력 한 번으로 둘 다 고른다.
//   · 첫 번째로 누른 날 = 시작일, 두 번째 = 종료일 (거꾸로 눌러도 앞뒤를 맞춘다)
//   · 위쪽 "2026년 7월"을 누르면 고르던 중이든 아니든 그 달이 통째로 들어간다
// 값은 숨은 입력(.<cls>-from / .<cls>-to)에 담고 to 쪽에 change 를 쏜다.
//
// 쓰는 곳마다 경계가 다르다 — 기록실은 지난 기록을 보므로 max=오늘, 캘린더 일정은
// 앞으로의 예정이라 min=오늘이다. 그래서 min/max 를 옵션으로 받는다.
const pad2 = n => String(n).padStart(2, '0');
export const ymd = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
export const todayYmd = () => ymd(new Date());
// 2026-07-01 → 26/07/01 (표시용 축약)
export const ddmy = v => v ? v.slice(2).replace(/-/g, '/') : '';
// 'YYYY-MM-DD' 를 n 일 옮긴다. Date 생성자가 달·해 넘김을 알아서 처리하므로 문자열 계산보다 안전하다.
export const shiftDay = (s, n) =>
  ymd(new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)) + n));

// 기간을 한 줄로 요약. 한쪽이 비면 열린 구간으로 읽는다.
function rangeLabel(from, to, empty){
  if (!from && !to) return empty || '전체 기간';
  if (from && to) return from === to ? ddmy(from) + ' 하루' : ddmy(from) + ' ~ ' + ddmy(to);
  if (from) return ddmy(from) + ' ~ 지금';
  return '처음 ~ ' + ddmy(to);
}

// 같은 줄: [leftHtml] [기간 한 칸]. opt.empty 로 비었을 때 문구를 바꾼다.
export function rangeRowHtml(cls, from, to, leftHtml, opt){
  const o = opt || {};
  const has = !!(from || to);
  return `<div class="${cls}-range" style="display:flex; align-items:center; gap:6px;">
      ${leftHtml || ''}
      <div class="${cls}-disp" role="button" tabindex="0" aria-label="${o.aria || '기간'}" style="flex:1 1 0; min-width:0; height:34px; display:flex; align-items:center; justify-content:center; padding:0 8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:${has?'var(--text)':'var(--muted)'}; font-size:0.9rem; white-space:nowrap; overflow:hidden; cursor:pointer;">📅 ${rangeLabel(from, to, o.empty)}</div>
      <input type="hidden" class="${cls}-from" value="${from||''}">
      <input type="hidden" class="${cls}-to" value="${to||''}">
    </div>`;
}

const DOW_KO = ['일','월','화','수','목','금','토'];
function openCalendar(opt){
  const lo = opt.min || '', hi = opt.max || '';        // '' = 제한 없음
  const today = todayYmd();
  const inBounds = s => (!lo || s >= lo) && (!hi || s <= hi);
  let pend = null;              // 시작일만 고른 상태 (null 이면 처음부터 고르는 중)
  let committed = false;
  // 처음 보여 줄 달: 이미 고른 값 → 오늘 → 경계 안쪽 순으로 잡는다
  let seed = opt.from || opt.to || (inBounds(today) ? today : (lo || hi));
  let cur = new Date(Number(seed.slice(0,4)), Number(seed.slice(5,7)) - 1, 1);

  const mask = document.createElement('div');
  mask.className = 'calmask';
  mask.innerHTML = `<div class="calcard">
      <div class="calhd">
        <button class="calnav cal-prev" aria-label="이전 달">‹</button>
        <button class="caltitle cal-title"></button>
        <button class="calnav cal-next" aria-label="다음 달">›</button>
      </div>
      <div class="calhint cal-hint"></div>
      <div class="calgrid cal-dow">${DOW_KO.map((d,i)=>`<div class="caldow"${i===0?' style="color:#e5484d"':''}>${d}</div>`).join('')}</div>
      <div class="calgrid cal-days"></div>
      <div class="calft">${opt.allowClear ? '<button class="cal-clear">전체 기간</button>' : ''}<button class="cal-close">닫기</button></div>
    </div>`;
  const q = s => mask.querySelector(s);
  const onKey = e => { if (e.key === 'Escape') close(); };
  // 닫기·배경·ESC 로 나갈 때 시작일만 골라 뒀으면 그것만이라도 확정한다.
  // 종료를 빈 값으로 넘기면 부르는 쪽이 "그날 이후 전체"로 읽는다.
  function close(){
    mask.remove();
    document.removeEventListener('keydown', onKey);
    if (!committed && pend) { committed = true; opt.onCommit(pend, ''); }
  }
  function commit(a, b){ committed = true; close(); opt.onCommit(a, b); }
  mask.onclick = e => { if (e.target === mask) close(); };
  document.addEventListener('keydown', onKey);

  function draw(){
    const y = cur.getFullYear(), m = cur.getMonth();
    const first = new Date(y, m, 1), lastD = new Date(y, m + 1, 0).getDate();
    q('.cal-title').textContent = y + '년 ' + (m + 1) + '월';
    // 그 방향으로 고를 수 있는 날이 하나도 없으면 넘기지 못하게 한다
    q('.cal-next').disabled = !!hi && ymd(new Date(y, m + 1, 1)) > hi;
    q('.cal-prev').disabled = !!lo && ymd(new Date(y, m, 0)) < lo;
    q('.cal-hint').innerHTML = pend
      ? `<b>종료일</b>을 고르세요 · 그냥 닫으면 ${ddmy(pend)} 이후 전체`
      : '첫 번째가 <b>시작일</b>, 두 번째가 <b>종료일</b> · 위 <b>연·월</b>을 누르면 그 달 전체';
    // 고르는 중이면 방금 누른 날만, 아니면 확정된 기간을 보여 준다 (뒤집혀 있어도 자연스럽게)
    let a = pend || opt.from, b = pend ? '' : opt.to;
    if (a && b && a > b) { const t = a; a = b; b = t; }
    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
    for (let d = 1; d <= lastD; d++){
      const s = ymd(new Date(y, m, d));
      const dis = !inBounds(s);
      const sel = s === a || s === b;
      const inr = !sel && a && b && s > a && s < b;
      const sun = new Date(y, m, d).getDay() === 0;
      const cl = 'calday' + (sel ? ' sel' : '') + (inr ? ' inr' : '') + (s === today ? ' today' : '');
      const st = (!sel && !dis && sun) ? ' style="color:#e5484d"' : '';
      cells += `<button class="${cl}" data-d="${s}"${dis?' disabled':''}${st}>${d}</button>`;
    }
    q('.cal-days').innerHTML = cells;
    q('.cal-days').querySelectorAll('.calday').forEach(btn => {
      btn.onclick = () => {
        const s = btn.dataset.d;
        if (!pend) { pend = s; draw(); return; }              // 첫 번째 = 시작일
        commit(pend <= s ? pend : s, pend <= s ? s : pend);   // 두 번째 = 종료일
      };
    });
  }
  q('.cal-prev').onclick = () => { cur.setMonth(cur.getMonth() - 1); draw(); };
  q('.cal-next').onclick = () => { cur.setMonth(cur.getMonth() + 1); draw(); };
  q('.cal-title').onclick = () => {
    const y = cur.getFullYear(), m = cur.getMonth();
    let a = ymd(new Date(y, m, 1)), b = ymd(new Date(y, m + 1, 0));
    if (lo && a < lo) a = lo;         // 경계에 걸친 달은 고를 수 있는 쪽으로 잘라 준다
    if (hi && b > hi) b = hi;
    if (a > b) return;                // 통째로 경계 밖인 달은 고를 게 없다
    commit(a, b);                     // 고르던 중이어도 월 선택이 우선
  };
  const clr = q('.cal-clear');
  if (clr) clr.onclick = () => { pend = null; commit('', ''); };
  q('.cal-close').onclick = close;
  draw();
  document.body.appendChild(mask);
}

// ══ 날짜 골라 담기 (캘린더 일정 등록) ══
// openCalendar 는 시작~끝 '한 구간'만 고른다. 여기는 '고른 날들의 집합'을 다뤄서
// 떨어진 날짜(예: 매주 토요일)도 한 번에 담긴다. 붙어 있는 날을 어떻게 묶을지는
// 부르는 쪽이 정한다 — 캘린더는 이어지는 한 덩어리를 막대 하나로 저장한다.
//
// 연속된 날을 담는 게 가장 흔한 쓰임이라, 톡 누르기 말고 가로로 쓸어도 칠해진다.
// (달력 본문의 붓 모드와 같은 손놀림 — 처음 누른 칸의 반대 상태로 지나간 칸을 맞춘다)
//
// opt: { min, max, selected:[], limit, onCommit(dates[]) }
export function openDayPicker(opt){
  const o = opt || {};
  const lo = o.min || '', hi = o.max || '';        // '' = 제한 없음
  const today = todayYmd();
  const inBounds = s => (!lo || s >= lo) && (!hi || s <= hi);
  const limit = o.limit || 0;
  const picked = new Set((o.selected || []).filter(inBounds));
  let warn = '';                                   // 한도에 걸렸을 때만 안내문 자리를 뺏는다
  const seed = [...picked].sort()[0] || (inBounds(today) ? today : (lo || hi));
  let cur = new Date(Number(seed.slice(0, 4)), Number(seed.slice(5, 7)) - 1, 1);

  const mask = document.createElement('div');
  mask.className = 'calmask';
  mask.innerHTML = `<div class="calcard">
      <div class="calhd">
        <button class="calnav cal-prev" aria-label="이전 달">‹</button>
        <button class="caltitle cal-title"></button>
        <button class="calnav cal-next" aria-label="다음 달">›</button>
      </div>
      <div class="calhint cal-hint"></div>
      <div class="calgrid cal-dow">${DOW_KO.map((d,i)=>`<div class="caldow"${i===0?' style="color:#e5484d"':''}>${d}</div>`).join('')}</div>
      <div class="calgrid cal-days" style="touch-action:none"></div>
      <div class="calft"><button class="cal-clear">모두 지우기</button><button class="cal-done primary">확인</button></div>
    </div>`;
  const q = s => mask.querySelector(s);
  const onKey = e => { if (e.key === 'Escape') close(); };

  // 어떻게 닫든 지금 골라 둔 그대로 넘긴다 — 이건 확정 단계가 아니라 선택을 고치는 창이다.
  let closed = false;
  function close(){
    if (closed) return;
    closed = true;
    mask.remove();
    document.removeEventListener('keydown', onKey);
    o.onCommit([...picked].sort());
  }
  mask.onclick = e => { if (e.target === mask) close(); };
  document.addEventListener('keydown', onKey);

  // want=true 담기 / false 빼기 / null 뒤집기
  function toggle(s, want){
    if (!inBounds(s)) return;
    if (want === false || (want == null && picked.has(s))) { picked.delete(s); warn = ''; return; }
    if (picked.has(s)) return;
    if (limit && picked.size >= limit) { warn = `${limit}일까지만 고를 수 있습니다.`; return; }
    picked.add(s);
    warn = '';
  }

  function draw(){
    const y = cur.getFullYear(), m = cur.getMonth();
    const first = new Date(y, m, 1), lastD = new Date(y, m + 1, 0).getDate();
    q('.cal-title').textContent = y + '년 ' + (m + 1) + '월';
    q('.cal-next').disabled = !!hi && ymd(new Date(y, m + 1, 1)) > hi;
    q('.cal-prev').disabled = !!lo && ymd(new Date(y, m, 0)) < lo;
    q('.cal-hint').innerHTML = warn ? `<b>${warn}</b>`
      : picked.size ? `<b>${picked.size}일</b> 선택됨 · 이어지는 날은 하나의 막대가 됩니다`
      : '날짜를 누르거나 가로로 쓸어 고르세요 · 위 <b>연·월</b>은 그 달 전체';

    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
    for (let d = 1; d <= lastD; d++){
      const s = ymd(new Date(y, m, d));
      const dis = !inBounds(s);
      const sel = picked.has(s);
      const col = (first.getDay() + d - 1) % 7;
      // 붙어 있는 선택끼리는 맞닿은 모서리를 펴서 한 덩어리로 보이게 한다.
      // 주가 바뀌는 자리(토→일)는 화면에서 떨어져 있으니 이어 붙이지 않는다.
      const jl = sel && col > 0 && picked.has(shiftDay(s, -1));
      const jr = sel && col < 6 && picked.has(shiftDay(s, 1));
      const cl = 'calday' + (sel ? ' sel' : '') + (jl ? ' jl' : '') + (jr ? ' jr' : '')
               + (s === today ? ' today' : '');
      const st = (!sel && !dis && col === 0) ? ' style="color:#e5484d"' : '';
      cells += `<button class="${cl}" data-d="${s}"${dis?' disabled':''}${st}>${d}</button>`;
    }
    q('.cal-days').innerHTML = cells;
  }

  // 칠하기 — 격자 자체에 걸어 두면 draw() 가 칸을 갈아 끼워도 손을 놓치지 않는다
  const days = q('.cal-days');
  let mode = null, seen = null;                    // seen: 이번 제스처에서 이미 지나간 날
  const dayAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const b = el && el.closest ? el.closest('.calday') : null;
    return b && !b.disabled ? b : null;
  };
  const apply = btn => {
    if (!btn || !seen) return;
    const s = btn.dataset.d;
    if (!s || seen.has(s)) return;                 // 손이 왔다 갔다 해도 결과가 같도록
    seen.add(s);
    toggle(s, mode);
    draw();
  };
  days.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    const btn = dayAt(e.clientX, e.clientY);
    if (!btn) return;
    e.preventDefault();                            // 쓸 때 뒤 화면이 따라 밀리지 않게 (touch-action:none 과 한 쌍)
    mode = !picked.has(btn.dataset.d);             // 처음 누른 칸의 반대 상태로 통일한다
    seen = new Set();
    try { days.setPointerCapture(e.pointerId); } catch(err){}
    apply(btn);
  });
  days.addEventListener('pointermove', e => {
    if (!seen || !e.isPrimary) return;
    apply(dayAt(e.clientX, e.clientY));
  });
  const endPaint = e => {
    if (!seen) return;
    try { days.releasePointerCapture(e.pointerId); } catch(err){}
    mode = null; seen = null;
  };
  days.addEventListener('pointerup', endPaint);
  days.addEventListener('pointercancel', endPaint);
  // 포인터를 가로챘으므로 click 은 오지 않는다 → 키보드는 여기서 따로 받는다
  days.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest && e.target.closest('.calday');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const s = btn.dataset.d;
    toggle(s, null);
    draw();
    const back = days.querySelector(`.calday[data-d="${s}"]`);   // draw() 가 칸을 새로 만들었다
    if (back) back.focus();
  });

  q('.cal-prev').onclick = () => { cur.setMonth(cur.getMonth() - 1); draw(); };
  q('.cal-next').onclick = () => { cur.setMonth(cur.getMonth() + 1); draw(); };
  // 연·월 누르기 = 이 달 통째로. 이미 다 골라 뒀으면 반대로 이 달만 뺀다.
  q('.cal-title').onclick = () => {
    const y = cur.getFullYear(), m = cur.getMonth(), lastD = new Date(y, m + 1, 0).getDate();
    const all = [];
    for (let d = 1; d <= lastD; d++){
      const s = ymd(new Date(y, m, d));
      if (inBounds(s)) all.push(s);
    }
    if (!all.length) return;
    const every = all.every(s => picked.has(s));
    for (const s of all) toggle(s, !every);
    draw();
  };
  q('.cal-clear').onclick = () => { picked.clear(); warn = ''; draw(); };
  q('.cal-done').onclick = close;

  draw();
  document.body.appendChild(mask);
}

// 기간 칸을 누르면 달력을 연다. opt 는 openCalendar 로 그대로 넘어간다.
export function bindRangePicker(el, cls, opt){
  const o = opt || {};
  const fromInp = el.querySelector('.'+cls+'-from');
  const toInp = el.querySelector('.'+cls+'-to');
  const disp = el.querySelector('.'+cls+'-disp');
  if (!fromInp || !toInp || !disp) return;
  // 두 입력의 onchange 는 어차피 같은 함수라(from/to 를 함께 읽는다) 한 번만 쏘면 된다
  const open = () => openCalendar(Object.assign({}, o, {
    from: fromInp.value, to: toInp.value,
    onCommit: (a, b) => {
      fromInp.value = a; toInp.value = b;
      syncRangeDisp(el, cls, o.empty);
      toInp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }));
  disp.onclick = open;
  disp.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
}

// 입력값을 기간 칸에 반영 (툴바를 다시 그리지 않는 화면용)
export function syncRangeDisp(el, cls, empty){
  const f = el.querySelector('.'+cls+'-from');
  const t = el.querySelector('.'+cls+'-to');
  const d = el.querySelector('.'+cls+'-disp');
  if (!f || !t || !d) return;
  d.textContent = '📅 ' + rangeLabel(f.value, t.value, empty);
  d.style.color = (f.value || t.value) ? 'var(--text)' : 'var(--muted)';
}

// ── 서비스워커 등록 + 무중단 자동 업데이트 ──
// sw.js 의 VERSION 변경 → 새 워커 설치·활성화 → controllerchange → 앱 자동 1회 새로고침. 폴링 없음.
export function registerSW(){
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  // 푸터 버전 표시 = sw.js 의 VERSION (단일 소스). SW 가 메시지로 알려준다.
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'appVersion') {
      document.querySelectorAll('[data-app-version]').forEach(el => el.textContent = e.data.version);
    }
  });
  navigator.serviceWorker.register('../sw.js', { updateViaCache: 'none' }).then(reg => {
    // 앱을 다시 열 때 새 배포 확인(모바일 백그라운드 복귀 대응). 폴링 아님.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
    const askVersion = () => { const sw = navigator.serviceWorker.controller; if (sw) sw.postMessage('getVersion'); };
    if (navigator.serviceWorker.controller) askVersion();
    else navigator.serviceWorker.ready.then(askVersion);
  }).catch(() => {});
}

/* ══ 알림 구독을 계정에 붙였다 떼기 ═══════════════════════════════════
   푸시 구독은 '기기'에 남는데 로그인 계정은 바뀐다. 둘을 이어 두지 않으면 이 폰이
   여전히 이전 계정 것으로 남아, 그 계정이 속한 팀의 알림을 계속 받는다 — 팀을 옮기거나
   폰을 빌려준 뒤에도 남의 팀 모임 알림이 울린다는 뜻이다.
   그래서 로그아웃할 때 구독을 끊고, 로그인할 때 지금 계정으로 다시 붙인다.

   점수판·기록실·캘린더 어디서 로그아웃해도 같아야 하므로 공통 모듈에 둔다.
   켜고 끄는 스위치 UI 는 아래 initPushSwitch — 세 화면의 설정 창이 함께 쓴다. */
const VAPID_PUBLIC = 'BJO7jjlFWFhPntIIWsmk0NTUpW67axk-3ikmxIt9OoXZIHjVx88dFUqhL_0OxBMvpeVyLdsrn65A8VpOK0KUwF0';

// 본 앱·테스트 앱 둘 다 쓴다. 구독은 서비스워커 스코프에 묶여 두 앱이 서로 다른 구독이 되고,
// 보내는 쪽은 구독마다 scope 를 보고 알림을 누르면 열 앱을 고른다.
// (표 이름의 _beta 는 테스트 앱에서만 쓰던 시절의 흔적이다 — 이름만 그렇고 두 앱이 함께 쓴다)
const pushUsable = () => 'serviceWorker' in navigator && 'PushManager' in window
  && 'Notification' in window;

// VAPID 공개키(base64url) → subscribe() 가 요구하는 Uint8Array
const b64ToU8 = s => {
  const raw = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const deviceLabel = () => (navigator.userAgent.match(/iPhone|iPad|Android|Windows|Macintosh/) || ['기타'])[0];

/* 주소록에 이 기기를 적어 둔다. endpoint 가 기본키라 같은 기기면 새 행 대신 갱신된다 —
   계정이 바뀌었을 때 user_id 가 지금 계정으로 덮어써지는 게 이 함수의 요점이다. */
export async function pushSaveSub(sub, uid){
  const j = sub.toJSON();
  await sbFetch('/rest/v1/push_subscriptions_beta', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth_key: j.keys.auth,
      user_id: uid || null, label: deviceLabel(), scope: location.pathname
    })
  });
}

/* 로그인 직후 — 알림 권한이 이미 허용돼 있을 때만 구독을 만들어 지금 계정으로 붙인다.
   여기서 권한을 새로 묻지 않는 이유: 맥락 없이 뜨는 권한 창은 대개 거부되고, 한 번 거부되면
   브라우저가 다시 묻지 못하게 막아 버린다. 처음 켜는 건 설정의 스위치가 맡는다.
   돌려주는 값 = 지금 이 기기가 구독 중인가. */
export async function pushAttach(uid){
  if (!pushUsable() || Notification.permission !== 'granted') return false;
  let made = null;                       // 이번 호출에서 새로 만든 구독 (되돌릴 때만 쓴다)
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = made = await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) });
    await pushSaveSub(sub, uid);
    return true;
  } catch(e){
    // 표에 못 넣었는데 구독만 살아 있으면 '보낼 주소를 서버가 모르는 기기'가 된다 → 되돌린다.
    // 원래 있던 구독은 건드리지 않는다 (계정만 다시 붙이려던 것이지 끄려던 게 아니다).
    if (made) await made.unsubscribe().catch(()=>{});
    return false;
  }
}

/* 로그아웃 직전 — 주소록에서 지우고 구독도 해지한다.
   지우기를 먼저 하는 이유: 해지부터 하면 endpoint 를 잃어 어느 행을 지울지 알 수 없게 된다.
   실패해도 로그아웃은 그대로 진행한다 — 죽은 주소는 보내는 쪽이 410 을 받고 정리한다. */
export async function pushDetach(){
  if (!pushUsable()) return;
  try {
    // ready 가 아니라 getRegistration — 서비스워커가 막힌 환경에선 ready 가 끝나지 않아 로그아웃이 멈춘다.
    // 등록이 없으면 구독도 있을 수 없으니 그냥 넘어간다.
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return;
    await sbFetch('/rest/v1/push_subscriptions_beta?endpoint=eq.' + encodeURIComponent(sub.endpoint),
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(()=>{});
    await sub.unsubscribe();
  } catch(e){}
}

/* ══ 설정 창의 '👑 관리자 메뉴' 버튼 ══
   점수판·기록실·캘린더 설정 창에 같은 버튼(#setAdmin)이 숨어 있고, 사이트 관리자(profiles.is_admin)일 때만 보인다.
   여기서 숨기는 건 화면뿐이다 — 관리자 메뉴가 부르는 서버 함수들이 각자 is_admin() 으로 다시 막는다.
   onOpen = 눌렀을 때 할 일. 관리자 메뉴는 기록실에만 있어서 점수판·캘린더는 기록실로 넘긴다.
   돌려주는 값 = 관리자인가(Promise<boolean>) — 기록실이 같은 값을 한 번 더 묻지 않고 그대로 쓴다. */
export async function initAdminEntry(getUid, onOpen){
  const btn = $id('setAdmin');
  if (btn) btn.onclick = () => { const m = $id('setModal'); if (m) m.classList.remove('on'); onOpen(); };
  const uid = getUid();
  if (!uid) return false;
  try {
    const d = await sbFetch('/rest/v1/profiles?select=is_admin&id=eq.' + encodeURIComponent(uid));
    const admin = !!(d && d[0] && d[0].is_admin);
    if (admin && btn) btn.style.display = '';
    return admin;
  } catch(e){ return false; }   // is_admin 컬럼이 없거나 오프라인이면 그냥 숨긴 채로 둔다
}

/* ══ 방문 기록 (관리자 메뉴의 '방문 기록') ══
   '한 번 들어옴' = VISIT_GAP 넘게 안 쓰다가 앱을 다시 연 것. 새로고침이나 점수판·기록실·캘린더를
   오가는 것(전부 페이지 이동이다)은 세지 않는다 — 마지막으로 쓴 시각을 세 화면이 같은 열쇠로 나눠 본다.
   홈 화면 앱은 껐다 켜도 새로 뜨지 않고 뒤에서 깨어나기만 할 때가 많아서, 화면이 다시 보일 때도 같은 검사를 한다.
   로그인 전에는 적지 않는다(서버 함수 log_visit 도 로그인 없으면 무시한다). 표·함수는 sql/app-visits.sql. */
const LS_SEEN = 'dangLastSeen';
const VISIT_GAP = 30 * 60 * 1000;   // 30분

export function logVisit(app, getUid){
  const check = () => {
    // 로그인 전에는 시각도 남기지 않는다 — 남기면 로그인하고 30분 동안은 방문으로 안 잡힌다
    if (!getUid()) return;
    let last = 0;
    try { last = Number(localStorage.getItem(LS_SEEN)) || 0; } catch(e){}
    const now = Date.now();
    try { localStorage.setItem(LS_SEEN, String(now)); } catch(e){}
    if (now - last < VISIT_GAP) return;
    // 실패해도 조용히 넘긴다 — 방문 기록 때문에 앱이 멈추거나 오류를 띄울 일은 아니다
    sbFetch('/rest/v1/rpc/log_visit', {
      method: 'POST',
      body: JSON.stringify({ p_app: app, p_beta: location.pathname.includes('-beta') })
    }).catch(()=>{});
  };
  check();
  // 화면을 떠날 때도 시각을 남긴다 — 안 그러면 두 시간 내내 쓰다가 10분 쉬고 와도
  // '처음 연 때로부터 두 시간'으로 보여 새 방문으로 세어진다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
    else if (getUid()) try { localStorage.setItem(LS_SEEN, String(Date.now())); } catch(e){}
  });
}

/* 알림 방식 — 'sound'(소리·진동, 기본) 또는 'quiet'(소리·진동 없이 알림만). 기기마다 따로 정한다.
   알림은 앱이 꺼져 있을 때 서비스워커가 띄우는데, 서비스워커는 localStorage 를 못 읽는다.
   그래서 둘 다 읽을 수 있는 캐시 저장소에 적어 둔다 (sw.js 의 PUSH_MODE_CACHE 와 같은 이름·열쇠여야 한다).
   열쇠에 서비스워커 스코프를 넣어 본 앱·테스트 앱이 따로 기억한다.
   캐시 이름이 'dangdong/' 로 시작하지 않으므로 새 버전이 옛 캐시를 지울 때 함께 지워지지 않는다. */
const PUSH_MODE_CACHE = 'dangdong-settings';
const pushModeKey = reg => reg.scope + '__push-mode';
async function getPushMode(reg){
  try {
    const r = await (await caches.open(PUSH_MODE_CACHE)).match(pushModeKey(reg));
    return r && (await r.text()) === 'quiet' ? 'quiet' : 'sound';
  } catch(e){ return 'sound'; }
}
async function setPushMode(reg, mode){
  await (await caches.open(PUSH_MODE_CACHE)).put(pushModeKey(reg), new Response(mode));
}

/* 설정 창의 알림 고르기(끄기 / 알림만 / 소리·진동). 점수판·기록실·캘린더 설정 창이 똑같이 쓴다.
   (예전에는 점수판에만 있어서, 기록실이나 캘린더에서 설정을 열면 스위치가 보이지 않았다)
   getUid() = 지금 로그인한 계정 id. 앱마다 로그인 정보를 들고 있는 방식이 달라 받아서 쓴다.
   결과 안내는 바로 아래 줄(#setPushHint)에 적는다 — 토스트가 없는 화면도 있어서다. */
export function initPushSwitch(getUid){
  const row = document.getElementById('setPushRow'), seg = document.getElementById('setPush');
  const hint = document.getElementById('setPushHint');
  if (!row || !seg) return;
  row.style.display = '';
  const btns = [...seg.querySelectorAll('button')];

  const say = t => { if (!hint) return; hint.textContent = t || ''; hint.style.display = t ? '' : 'none'; };
  const mark = m => btns.forEach(b => b.classList.toggle('on', b.dataset.m === m));
  const lock = v => btns.forEach(b => b.disabled = v);
  const ON_MSG = { quiet: '소리·진동 없이 알림만 와요.', sound: '알림이 소리·진동과 함께 와요.' };

  // 이 브라우저에서는 알림을 아예 받을 수 없을 때 — 숨기지 않고 이유를 보여 준다.
  // 아이폰은 Safari 에서 '홈 화면에 추가'로 설치한 앱으로 열어야만 푸시를 쓸 수 있다.
  if (!pushUsable()) {
    lock(true); mark('off');
    say(/iPhone|iPad/.test(navigator.userAgent)
      ? "아이폰은 Safari 공유 버튼 → '홈 화면에 추가'로 설치한 앱에서만 알림을 켤 수 있어요."
      : '이 브라우저는 알림을 지원하지 않아요.');
    return;
  }

  // 추측하지 않고 "이 기기에 구독이 살아 있는가"를 그대로 비춘다. 켜져 있으면 알림 방식까지.
  // 설정을 열 때마다 다시 확인한다 — 페이지 로드 때 한 번만 읽으면 껐다 켠 뒤 옛 상태가 남는다.
  const sync = async () => {
    say('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const on = !!sub && Notification.permission === 'granted';
      mark(on ? await getPushMode(reg) : 'off');
      if (Notification.permission === 'denied') say('브라우저에서 알림이 차단돼 있어요 — 기기 설정에서 허용해 주세요.');
      // 표에 행이 빠졌거나 계정이 바뀌었으면 조용히 지금 계정으로 맞춘다
      if (on) pushSaveSub(sub, getUid()).catch(()=>{});
    } catch (_) { mark('off'); }
  };
  sync();
  const gear = document.getElementById('btnSettings');
  if (gear) gear.addEventListener('click', sync);   // 앱의 initSettings 가 단 onclick 과 별개로 붙는다

  btns.forEach(b => b.onclick = async () => {
    const m = b.dataset.m;
    lock(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (m === 'off') {
        if (sub) await pushDetach();
        mark('off'); say('알림을 껐습니다.');
        return;
      }
      // 방식부터 적어 둔다 — 켜자마자 오는 알림도 고른 방식대로 울리게
      await setPushMode(reg, m);
      if (!sub || Notification.permission !== 'granted') {      // 꺼져 있으면 → 켜기
        if (Notification.permission === 'denied') {
          say('브라우저에서 알림이 차단돼 있어요 — 기기 설정에서 허용해 주세요.'); return;
        }
        if (await Notification.requestPermission() !== 'granted') { say('알림 권한이 없어 켜지 못했습니다.'); return; }
        // pushAttach 는 표에 못 넣으면 false 를 준다 — 켜진 것처럼 보이고 보낼 주소는 없는 상태를 만들지 않는다
        if (!await pushAttach(getUid())) { say('알림을 켜지 못했습니다. 잠시 뒤 다시 시도해 주세요.'); sync(); return; }
      }
      mark(m); say(ON_MSG[m]);
    } catch (e) {
      say('알림 설정 실패: ' + (e && e.message || e));
      sync();
    } finally { lock(false); }
  });
}

// ── 팀 설정 모달 (팀 참가 / 팀 만들기 / 팀장: 코드·이름 변경·팀원 내보내기) ──
// ctx 로 앱별 차이만 주입한다:
//   getAuth()            현재 로그인 정보
//   getCurrentTeam()     현재 팀 id
//   setCurrentTeam(id)   현재 팀 지정 + localStorage 저장
//   getMyTeams()         내 소속 팀 배열
//   reloadTeams()        (async) 앱의 loadTeams — myTeams·currentTeam·팀 스위처 갱신
//   afterChange()        (async) 앱별 데이터/화면 갱신 (점수판: 멤버+설정 / 기록실: 데이터+탭)
//   notify(msg)          (선택) 토스트 — 점수판만 사용
function ensureTeamModalHTML(){
  let modal = $id('teamModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'teamModal';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; z-index:1000; padding:20px;';
  modal.innerHTML = `
    <div style="width:100%; max-width:360px; max-height:88vh; overflow-y:auto; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; color:var(--text);">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:18px;">
        <b style="font-size:1.15rem;">팀 설정</b>
        <button id="tmClose" style="background:none; border:none; color:var(--muted); font-size:1.5rem; line-height:1; cursor:pointer; padding:0 4px;">&times;</button>
      </div>

      <div style="font-size:.8rem; color:var(--muted); margin-bottom:6px; font-weight:600;">팀 참가</div>
      <div style="display:flex; gap:8px; margin-bottom:20px;">
        <input id="tmCode" placeholder="참여 코드 입력" autocapitalize="characters" autocomplete="off" spellcheck="false" style="flex:1 1 auto; min-width:0; padding:10px 12px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:.95rem;">
        <button id="tmJoin" style="flex:0 0 auto; padding:10px 16px; border-radius:8px; background:var(--accent); color:#fff; border:none; font-weight:700; font-size:.9rem; cursor:pointer;">참가</button>
      </div>

      <div style="font-size:.8rem; color:var(--muted); margin-bottom:6px; font-weight:600;">팀 만들기</div>
      <div style="display:flex; gap:8px;">
        <input id="tmName" placeholder="새 팀 이름" maxlength="20" autocomplete="off" style="flex:1 1 auto; min-width:0; padding:10px 12px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:.95rem;">
        <button id="tmCreate" style="flex:0 0 auto; padding:10px 16px; border-radius:8px; background:var(--accent); color:#fff; border:none; font-weight:700; font-size:.9rem; cursor:pointer;">만들기</button>
      </div>

      <div id="tmLeader" style="display:none; margin-top:20px; padding-top:16px; border-top:1px solid var(--line);">
        <div id="tmCodeRow" style="display:none; align-items:center; gap:8px; margin-bottom:14px;">
          <span style="font-size:.9rem; white-space:nowrap;">초대 코드</span>
          <input id="tmCurCode" maxlength="16" autocapitalize="characters" autocomplete="off" spellcheck="false" style="flex:1 1 auto; min-width:0; padding:7px 10px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:.9rem;">
          <button id="tmRegen" style="flex:0 0 auto; padding:7px 11px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:.85rem; cursor:pointer;">변경</button>
        </div>
        <div id="tmNameRow" style="display:none; align-items:center; gap:8px; margin-bottom:14px;">
          <span style="font-size:.9rem; white-space:nowrap;">팀 이름</span>
          <input id="tmTeamName" maxlength="20" autocomplete="off" style="flex:1 1 auto; min-width:0; padding:7px 10px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:.9rem;">
          <button id="tmRename" style="flex:0 0 auto; padding:7px 11px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:.85rem; cursor:pointer;">이름 변경</button>
        </div>
        <div style="font-size:.85rem; color:var(--muted); margin-bottom:6px;">팀원</div>
        <div id="tmRoster" style="display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto;"></div>
        <button id="tmLeave" style="margin-top:16px; width:100%; padding:10px; border-radius:8px; background:var(--card); color:var(--danger,#e5484d); border:1px solid var(--danger,#e5484d); font-weight:700; font-size:.9rem; cursor:pointer;">🚪 팀 나가기</button>
      </div>

      <div id="tmMsg" style="font-size:.85rem; margin-top:16px; min-height:1.2em; line-height:1.5;"></div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

export function initTeamModal(ctx){
  const modal = ensureTeamModalHTML();   // 없으면 만들어 붙이므로 늘 있다

  // 팀장일 때만: 초대코드 표시/변경 + 팀원 내보내기
  async function renderLeaderSection(){
    const box = $id('tmLeader'); if (!box) return;
    const cur = ctx.getCurrentTeam();
    const me = ctx.getMyTeams().find(t => t.id === cur);
    if (!cur || !me) { box.style.display = 'none'; return; }   // 팀 없거나 비회원만 숨김
    box.style.display = 'block';
    const isLeader = !!me.is_admin;
    $id('tmCodeRow').style.display = isLeader ? 'flex' : 'none';   // 코드 변경은 팀장만
    $id('tmNameRow').style.display = isLeader ? 'flex' : 'none';   // 이름 변경도 팀장만
    if (isLeader) $id('tmTeamName').value = me.name || '';
    $id('tmRoster').innerHTML = '';
    try {
      if (isLeader) {
        $id('tmCurCode').value = '';
        const code = await sbFetch('/rest/v1/rpc/team_join_code', { method: 'POST', body: JSON.stringify({ p_team_id: cur }) });
        $id('tmCurCode').value = code || '';
      }
      const rows = await sbFetch('/rest/v1/team_members?select=user_id,is_admin,profiles(display_name)&team_id=eq.' + cur);
      const auth = ctx.getAuth(); const myUid = auth && auth.uid;
      $id('tmRoster').innerHTML = (rows || []).map(r => {
        const nm = (r.profiles && r.profiles.display_name) || r.user_id;
        const self = r.user_id === myUid;
        const right = (isLeader && !self)   // 내보내기 버튼은 팀장에게만
          ? `<button class="tmKick" data-uid="${esc(r.user_id)}" data-nm="${esc(nm)}" style="flex:0 0 auto; padding:6px 10px; border-radius:8px; background:var(--card); color:var(--danger,#e5484d); border:1px solid var(--line); font-size:.8rem; cursor:pointer;">내보내기</button>`
          : (self ? '<span style="color:var(--muted); font-size:.8rem;">나</span>' : '');
        return `<div style="display:flex; align-items:center; gap:8px;">
        <span style="flex:1 1 auto; min-width:0;">${esc(nm)}${r.is_admin ? ' 👑' : ''}</span>
        ${right}
      </div>`;
      }).join('');
      if (isLeader) $id('tmRoster').querySelectorAll('.tmKick').forEach(b => b.onclick = async () => {
        if (!confirm(`${b.dataset.nm}님을 팀에서 내보낼까요?`)) return;
        try {
          await sbFetch('/rest/v1/rpc/remove_member', { method: 'POST', body: JSON.stringify({ p_team_id: cur, p_user_id: b.dataset.uid }) });
          await ctx.afterChange(); renderLeaderSection();
        } catch(e){ alert('내보내기에 실패했어요'); }
      });
    } catch(e){ box.style.display = 'none'; }
  }

  function open(){
    $id('tmCode').value = ''; $id('tmName').value = ''; $id('tmMsg').textContent = '';
    modal.style.display = 'flex';
    renderLeaderSection();
  }
  function close(){ modal.style.display = 'none'; }

  $id('tmClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };

  $id('tmJoin').onclick = async () => {
    const msg = $id('tmMsg');
    const code = ($id('tmCode').value || '').trim().toUpperCase();
    if (!code) { msg.textContent = '참여 코드를 입력하세요'; return; }
    msg.textContent = '참가하는 중...';
    try {
      const tid = await sbFetch('/rest/v1/rpc/join_team', { method: 'POST', body: JSON.stringify({ code }) });
      ctx.setCurrentTeam(tid);
      await ctx.reloadTeams(); await ctx.afterChange();
      close(); if (ctx.notify) ctx.notify('팀에 참여했어요!');
    } catch(e){ msg.textContent = /invalid_code/.test(e.message) ? '참여 코드가 올바르지 않아요' : '참가에 실패했어요'; }
  };

  $id('tmCreate').onclick = async () => {
    const msg = $id('tmMsg');
    const name = ($id('tmName').value || '').trim();
    if (!name) { msg.textContent = '팀 이름을 입력하세요'; return; }
    msg.textContent = '만드는 중...';
    try {
      const r = await sbFetch('/rest/v1/rpc/create_team', { method: 'POST', body: JSON.stringify({ team_name: name }) });
      const t = Array.isArray(r) ? r[0] : r;
      ctx.setCurrentTeam(t.id);
      await ctx.reloadTeams(); await ctx.afterChange();
      $id('tmName').value = '';
      $id('tmMsg').innerHTML = `✅ "${esc(t.name)}" 팀 생성 완료<br>참여 코드: <b style="font-size:1.05rem">${esc(t.join_code)}</b><br><span style="color:var(--muted)">이 코드를 부원에게 공유하세요.</span>`;
    } catch(e){
      if (/name_taken|duplicate|unique/i.test(e.message)) msg.textContent = '이미 사용 중인 팀 이름입니다. 다른 이름을 입력해 주세요';
      else if (/not_authenticated/i.test(e.message)) msg.textContent = '로그인이 만료되었습니다. 다시 로그인해 주세요';
      else msg.textContent = '팀 만들기에 실패했어요 (' + (e.message || '오류') + ')';
    }
  };

  $id('tmRegen').onclick = async () => {
    const msg = $id('tmMsg');
    const code = ($id('tmCurCode').value || '').trim().toUpperCase();
    if (!code) { msg.textContent = '초대 코드를 입력하세요'; return; }
    msg.textContent = '변경 중...';
    try {
      const saved = await sbFetch('/rest/v1/rpc/set_join_code', { method: 'POST', body: JSON.stringify({ p_team_id: ctx.getCurrentTeam(), new_code: code }) });
      $id('tmCurCode').value = saved;
      msg.textContent = '초대 코드가 변경되었습니다.';
    } catch(e){
      if (/not_authorized/.test(e.message)) msg.textContent = '팀장 권한이 없어 코드를 변경할 수 없어요';
      else if (/code_taken|duplicate|unique/i.test(e.message)) msg.textContent = '이미 사용 중인 참여 코드입니다. 다른 코드를 입력해 주세요';
      else msg.textContent = '코드 변경에 실패했어요';
    }
  };

  $id('tmRename').onclick = async () => {
    const msg = $id('tmMsg');
    const name = ($id('tmTeamName').value || '').trim();
    if (!name) { msg.textContent = '팀 이름을 입력하세요'; return; }
    msg.textContent = '변경 중...';
    try {
      await sbFetch('/rest/v1/rpc/rename_team', { method: 'POST', body: JSON.stringify({ p_team_id: ctx.getCurrentTeam(), new_name: name }) });
      await ctx.reloadTeams();   // 스위처 이름 갱신
      renderLeaderSection();
      msg.textContent = '팀 이름이 변경되었습니다.';
    } catch(e){ msg.textContent = /name_taken|duplicate|unique/i.test(e.message) ? '이미 사용 중인 팀 이름입니다. 다른 이름을 입력해 주세요' : '이름 변경에 실패했어요'; }
  };

  // 팀 나가기 — 현재 팀에서 본인 소속 해제 (팀장은 최고참에게 자동 위임 후 나감)
  $id('tmLeave').onclick = async () => {
    const cur = ctx.getCurrentTeam();
    const me = ctx.getMyTeams().find(t => t.id === cur);
    if (!cur || !me) return;
    if (!confirm(`"${me.name}" 팀에서 나가시겠어요?`)) return;
    const msg = $id('tmMsg');
    msg.textContent = '나가는 중...';
    try {
      await sbFetch('/rest/v1/rpc/leave_team', { method: 'POST', body: JSON.stringify({ p_team_id: cur }) });
      ctx.setCurrentTeam(null);            // reloadTeams 가 남은 팀 중 하나(또는 없음)로 재설정
      await ctx.reloadTeams(); await ctx.afterChange();
      renderLeaderSection();
      msg.textContent = '팀에서 나갔습니다.';
      if (ctx.notify) ctx.notify('팀에서 나갔어요');
    } catch(e){ msg.textContent = '나가기에 실패했어요'; }
  };

  return { open };
}
