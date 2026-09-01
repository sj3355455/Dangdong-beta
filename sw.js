/* 당동 서비스 워커 — 오프라인 캐시 + 무중단 자동 업데이트
 *
 * ▶ 아래 VERSION 은 손대지 않는다 — 커밋할 때마다 .githooks/pre-commit 이 vN → vN+1 로 올린다.
 *   (한 번만 켜 두면 된다: git config core.hooksPath .githooks)
 *   VERSION 이 바뀌면 이 파일 내용이 바뀌므로 브라우저가 "새 워커"로 감지 →
 *   설치(install) → 활성화(activate) → 제어권 교체(controllerchange) 순으로 진행되고,
 *   그 순간 앱이 자동으로 1회 새로고침된다(app.js 의 controllerchange 처리). 폴링 불필요.
 *
 * 전략:
 *  - 코드(navigate/.html/.js): 네트워크 우선 + HTTP 캐시 우회(cache:'reload') → 항상 최신
 *  - 그 외 정적 자산(아이콘·매니페스트): 캐시 우선 + 백그라운드 갱신
 *  - 외부 출처(Supabase API 등): 가로채지 않음
 */
const VERSION = 'v275';
// 배포 경로를 자동 감지 → 같은 코드가 /Dangdong/(본 앱)·/Dangdong-beta/(테스트)에서 그대로 동작.
const BASE = new URL('.', self.location).pathname;   // 예: '/Dangdong/' 또는 '/Dangdong-beta/'
const CACHE = 'dangdong' + BASE + VERSION;           // 스코프별 캐시 이름 분리(같은 origin이라 겹치면 안 됨)
const ASSETS = [
  '', 'index.html',
  'record/', 'record/index.html', 'record/app.js', 'record/common.js',
  'score/', 'score/index.html', 'score/app.js',
  'calendar/', 'calendar/index.html', 'calendar/app.js',
  'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
].map(p => BASE + p);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 개별 캐싱(allSettled) — 파일 하나가 실패해도 설치가 통째로 깨지지 않는다.
    await Promise.allSettled(ASSETS.map(a => cache.add(new Request(a, { cache: 'reload' }))));
    await self.skipWaiting();   // 새 워커 즉시 대기 해제 → 곧바로 활성화
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const mine = 'dangdong' + BASE;   // 이 앱(경로) 소유 캐시만 정리 — 본 앱/테스트 앱이 서로 캐시를 지우지 않도록
    await Promise.all(keys.filter(k => k.startsWith(mine) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();   // 열려 있는 모든 탭 제어 → controllerchange 발생 → 앱이 새로고침
  })());
});

// 페이지가 현재 버전을 물어보면 알려준다(푸터 표시용). 버전 단일 소스 = 이 파일의 VERSION.
self.addEventListener('message', e => {
  if (e.data === 'getVersion' && e.source) e.source.postMessage({ type: 'appVersion', version: VERSION });
});

/* ── 웹 푸시 알림 ─────────────────────────────────────────────────
 * 앱이 꺼져 있어도 서버가 보낸 알림을 여기서 받아 띄운다.
 * 구독은 서비스워커 스코프(BASE)에 묶이므로 본 앱(/Dangdong/)과 테스트 앱(/Dangdong-beta/)은
 * 애초에 서로 다른 구독이다 — 한쪽으로 보낸 알림이 다른 쪽에 갈 수 없다.
 *
 * 모임·정기전 투표 알림이면 알림 안에 [참석]/[불참] 버튼이 붙는다.
 * ※ 이 버튼은 안드로이드에서만 보인다. iOS 는 알림 버튼(actions)을 지원하지 않아서
 *   알림을 누르면 캘린더가 그 모임을 연 채로 뜨고, 거기서 고르게 된다.
 */
const SB_URL = 'https://ezwassqurbmzcjfmtjop.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6d2Fzc3F1cmJtemNqZm10am9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjMxOTIsImV4cCI6MjA5OTc5OTE5Mn0.O6eHOO4-yxW7HVmNVjOkakrcoEeF5tORylhG1j79BeU';

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: e.data ? e.data.text() : '' }; }

  const opts = {
    body: d.body || '',
    icon: BASE + 'icons/icon-192.png',
    badge: BASE + 'icons/icon-192.png',
    tag: d.tag || 'dangdong',          // 같은 tag 는 알림이 쌓이지 않고 갱신된다
    renotify: true,
    data: { url: d.url || (BASE + 'score/'),
            meetupId: d.meetupId || null, eventId: d.eventId || null }
  };
  // 모임이든 정기전이든 참/불참을 받는 알림이면 버튼을 붙인다
  if (d.meetupId || d.eventId) opts.actions = [
    { action: 'yes', title: '✅ 참석' },
    { action: 'no',  title: '❌ 불참' }
  ];

  e.waitUntil(self.registration.showNotification(d.title || '당동', opts));
});

// 알림에서 참/불참을 눌렀을 때 — 앱을 열지 않고 서버에 바로 표를 남긴다.
//
// 서비스워커는 localStorage 를 못 읽어서 로그인 토큰을 쓸 수 없다. 대신 자기 푸시 구독
// 주소(endpoint)를 알고 있고, 서버가 그 주소로 사람을 찾아 준다(rsvp_by_endpoint).
// 모임(meetupId)과 정기전(eventId)은 표가 달라 부르는 함수도 다르다. 나머지 얼개는 같다.
async function sendRsvp(data, status){
  const sub = await self.registration.pushManager.getSubscription();
  if (!sub) throw new Error('구독 정보가 없습니다');
  const [fn, body] = data.meetupId
    ? ['rsvp_by_endpoint',       { p_endpoint: sub.endpoint, p_meetup: data.meetupId, p_status: status }]
    : ['event_rsvp_by_endpoint', { p_endpoint: sub.endpoint, p_event:  data.eventId,  p_status: status }];
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let m = '';
    try { const b = await res.json(); m = b.message || b.hint || ''; } catch (_) {}
    throw new Error(m || ('오류 ' + res.status));
  }
  // 서버가 실제로 저장한 값을 그대로 돌려준다(RPC 반환값). 확인 문구는 이걸로 띄운다 —
  // '내가 누른 것'으로 띄우면 엉뚱하게 저장돼도 눈치채지 못한다.
  try { const v = await res.json(); return typeof v === 'string' ? v : status; }
  catch (_) { return status; }
}

self.addEventListener('notificationclick', e => {
  const data = e.notification.data || {};
  const url = data.url || (BASE + 'score/');
  const act = e.action;
  e.notification.close();

  // 버튼을 눌렀으면 표만 남기고 끝낸다 — 앱을 여는 건 오히려 방해다.
  if ((act === 'yes' || act === 'no') && (data.meetupId || data.eventId)) {
    e.waitUntil((async () => {
      const base = { icon: BASE + 'icons/icon-192.png', badge: BASE + 'icons/icon-192.png',
                     tag: e.notification.tag, data };
      try {
        // 서버가 저장한 값으로 문구를 만든다 — 누른 것과 저장된 것이 어긋나면 여기서 드러나야 한다
        const saved = await sendRsvp(data, act);
        await self.registration.showNotification(
          saved === 'yes' ? '✅ 참석으로 표시했습니다' : '❌ 불참으로 표시했습니다',
          { ...base, body: e.notification.body || '' });
      } catch (err) {
        // 실패를 조용히 삼키면 눌렀는데 표가 없는 상태가 된다 → 캘린더에서 직접 고르도록 안내한다
        await self.registration.showNotification('표를 남기지 못했습니다', {
          ...base, body: (err && err.message || '') + ' — 눌러서 캘린더에서 골라 주세요.'
        });
      }
    })());
    return;
  }

  // 알림 본문을 누르면: 이미 열려 있는 앱 창이 있으면 그리로, 없으면 새로 연다.
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).pathname.startsWith(BASE)) {
        try { if (c.navigate) await c.navigate(url); } catch (_) {}
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // 외부(API)는 통과

  const path = url.pathname;
  const isCode = req.mode === 'navigate' || path.endsWith('/') || path.endsWith('.html') || path.endsWith('.js');

  if (isCode) {
    // 네트워크 우선. cache:'reload' 로 브라우저 HTTP 캐시(GitHub Pages max-age=600)를 우회 → 항상 최신 코드.
    e.respondWith(
      fetch(req, { cache: 'reload' })
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match(BASE + 'index.html')))
    );
    return;
  }

  // 그 외 정적 자산: 캐시 우선 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); } return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
