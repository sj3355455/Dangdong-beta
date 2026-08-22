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
const VERSION = 'v250';
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
 * 앱이 꺼져 있어도 서버(로컬 send.js)가 보낸 알림을 여기서 받아 띄운다.
 * 구독은 서비스워커 스코프(BASE)에 묶이므로 본 앱(/Dangdong/)과 테스트 앱(/Dangdong-beta/)은
 * 애초에 서로 다른 구독이다 — 한쪽으로 보낸 알림이 다른 쪽에 갈 수 없다.
 */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: e.data ? e.data.text() : '' }; }

  e.waitUntil(self.registration.showNotification(d.title || '당동', {
    body: d.body || '',
    icon: BASE + 'icons/icon-192.png',
    badge: BASE + 'icons/icon-192.png',
    tag: d.tag || 'dangdong',          // 같은 tag 는 알림이 쌓이지 않고 갱신된다
    renotify: true,
    data: { url: d.url || (BASE + 'score/') }
  }));
});

// 알림을 누르면: 이미 열려 있는 앱 창이 있으면 그리로, 없으면 새로 연다.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || (BASE + 'score/');
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
