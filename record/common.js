// 당동 공통 모듈 — score/ 와 record/ 가 공유 (테마 · 서비스워커 등록 · 팀 설정 모달)
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
export function rangeLabel(from, to, empty){
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
export function openCalendar(opt){
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
      <div class="calft">${opt.allowClear ? `<button class="cal-clear">${opt.clearLabel || '전체 기간'}</button>` : ''}<button class="cal-close">닫기</button></div>
    </div>`;
  const q = s => mask.querySelector(s);
  const onKey = e => { if (e.key === 'Escape') close(); };
  // 닫기·배경·ESC 로 나갈 때 시작일만 골라 뒀으면 그것만이라도 확정한다.
  // 종료가 빈 값이면 기록실은 "그날 이후 전체", 일정 등록은 "그 하루"로 읽는다(openEnded).
  function close(){
    mask.remove();
    document.removeEventListener('keydown', onKey);
    if (!committed && pend) { committed = true; opt.onCommit(pend, opt.openEnded === false ? pend : ''); }
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
    const tail = opt.openEnded === false ? `그냥 닫으면 ${ddmy(pend)} 하루` : `그냥 닫으면 ${ddmy(pend)} 이후 전체`;
    q('.cal-hint').innerHTML = pend
      ? `<b>종료일</b>을 고르세요 · ${tail}`
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
  const modal = ensureTeamModalHTML();

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
    if (!modal) return;
    $id('tmCode').value = ''; $id('tmName').value = ''; $id('tmMsg').textContent = '';
    modal.style.display = 'flex';
    renderLeaderSection();
  }
  function close(){ if (modal) modal.style.display = 'none'; }

  if (modal) {
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
    const leaveBtn = $id('tmLeave');
    if (leaveBtn) leaveBtn.onclick = async () => {
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
  }

  return { open };
}
