// 당동 — 정기전 이틀 전에 "참석 투표해 주세요" 알림을 보낸다.
//
// notify-meetup 과 다른 점: 사람이 부르는 게 아니라 크론이 하루 한 번 부른다.
//   · 그래서 로그인 토큰이 없다 → service_role 키를 그대로 Authorization 에 실어 부르고,
//     이 함수는 그 키가 맞는지만 확인한다. (아무나 부르면 부원들 폰이 울린다)
//   · 보낼 대상을 스스로 찾는다 — 한국 날짜로 '모레'인 정기전 전부.
//
// 배포 (대시보드에서 다 된다):
//   1) Edge Functions → Deploy a new function → 이름 notify-event → 이 파일 내용 붙여넣기
//   2) Secrets 는 notify-meetup 과 같은 것을 쓴다 (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / APP_URL)
//   3) 매일 부르는 건 sql/calendar/8-event-reminder-cron.sql 이 맡는다
//
// 두 번 보내지 않는 법: 보낸 정기전은 club_events.remind_sent_at 에 시각을 찍는다.
//   크론이 하루에 여러 번 돌거나 재시도가 나도 이미 찍힌 건 건너뛴다.
//
// 누구에게 가나: 그 팀의 팀원 전원 중 테스트 앱에서 알림을 켜 둔 기기.
//   이미 투표한 사람에게도 간다 — '이틀 뒤에 정기전이 있다'는 사실 자체를 알리는 자리라서.
//   scope 에 '-beta' 가 없는 구독은 건너뛴다 → 본 앱에는 어떤 경우에도 가지 않는다.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (message: string, status: number) => json({ error: message, message }, status);

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dateText = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return `${m}월 ${dd}일 (${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`;
};

// 서버는 UTC 로 돈다. 새벽에 크론이 돌면 UTC 날짜가 하루 뒤처져 엉뚱한 정기전을 집는다 →
// 한국 날짜를 직접 만들어 쓴다. (sv-SE 로케일이 'YYYY-MM-DD' 를 그대로 준다)
const seoulToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

type Ev = { id: string; team_id: string; event_date: string; note: string | null };

// 크론만 부를 수 있게 막는다.
//
// 값이 같은지만 보면 안 된다 — SUPABASE_SERVICE_ROLE_KEY 에 들어가는 값이 프로젝트마다
// 레거시 JWT 일 수도, 새 형식(sb_secret_…)일 수도 있어서 멀쩡한 service_role 키로 불러도 막힌다.
// 그래서 토큰 안의 role 을 본다. 그게 이 키의 정체다.
//
// 서명을 여기서 다시 검사하지 않아도 되는 이유: 이 함수는 Verify JWT 가 켜진 채 배포되므로,
// 여기까지 온 토큰은 이미 게이트웨이가 프로젝트 비밀키로 서명을 확인한 것이다.
// 위조 토큰은 애초에 못 들어온다(그때는 UNAUTHORIZED_INVALID_JWT_FORMAT 으로 잘린다).
// 일반 사용자 토큰은 role 이 'authenticated' 라 여기서 걸린다.
function isServiceCaller(token: string, service: string | undefined){
  if (!token) return false;
  if (service && token === service) return true;
  const seg = token.split('.')[1];
  if (!seg) return false;
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    return payload?.role === 'service_role';
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('POST 만 받습니다', 405);

  const SB_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
               || Deno.env.get('SUPABASE_SECRET_KEY')
               || Deno.env.get('SERVICE_ROLE_KEY');
  const PUB = Deno.env.get('VAPID_PUBLIC_KEY');
  const PRIV = Deno.env.get('VAPID_PRIVATE_KEY');
  const APP_URL = Deno.env.get('APP_URL') || 'https://sj3355455.github.io/Dangdong-beta/';

  if (!PUB || !PRIV) return fail('VAPID 키가 등록되지 않았습니다 (Edge Functions → Secrets)', 500);
  if (!SERVICE) return fail('관리 권한 키를 찾지 못했습니다. Edge Functions → Secrets 에 '
    + 'SERVICE_ROLE_KEY 라는 이름으로 service_role(또는 secret) 키를 등록해 주세요.', 500);

  // 부른 사람 확인 — 크론만 부를 수 있다. 사용자 토큰으로는 통과하지 못한다.
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!isServiceCaller(bearer, SERVICE)) return fail(
    'service_role 키로만 호출할 수 있습니다. anon(공개) 키를 보내셨는지 확인해 주세요.', 401);

  // 테스트용 손잡이 — event_id 를 주면 그 정기전 하나만, 날짜와 발송 여부를 따지지 않고 보낸다.
  let forceId: string | null = null;
  try { forceId = (await req.json())?.event_id || null; } catch { /* 본문 없음 = 평소의 크론 호출 */ }

  const admin = createClient(SB_URL, SERVICE);

  // 오늘(한국)로부터 이틀 뒤 = 알림을 보낼 날
  const target = addDays(seoulToday(), 2);

  const pick = admin.from('club_events').select('id, team_id, event_date, note');
  const { data: evs, error: evErr } = forceId
    ? await pick.eq('id', forceId)
    : await pick.eq('event_date', target).is('remind_sent_at', null);
  if (evErr) return fail('정기전 목록을 읽지 못했습니다: ' + evErr.message, 500);
  const events = (evs || []) as Ev[];
  if (!events.length) return json({ target, events: 0, sent: 0, note: '보낼 정기전이 없습니다' });

  webpush.setVapidDetails(APP_URL, PUB, PRIV);

  let sent = 0, failed = 0, cleaned = 0;
  const done: string[] = [];

  for (const ev of events) {
    // 회차는 저장돼 있지 않다 — 그 팀의 정기전을 날짜순으로 세면 그게 회차다 (앱의 eventSeq 와 같은 규칙)
    const { count: round } = await admin
      .from('club_events').select('id', { count: 'exact', head: true })
      .eq('team_id', ev.team_id).lte('event_date', ev.event_date);

    const { data: members, error: memErr } = await admin
      .from('team_members').select('user_id').eq('team_id', ev.team_id);
    if (memErr) { failed++; console.error('팀원 조회 실패', ev.id, memErr.message); continue; }
    const memberIds = (members || []).map((m: { user_id: string }) => m.user_id);
    if (!memberIds.length) { done.push(ev.id); continue; }

    const { data: subs, error: subErr } = await admin
      .from('push_subscriptions_beta')
      .select('endpoint, p256dh, auth_key, label, scope')
      .in('user_id', memberIds);
    if (subErr) { failed++; console.error('구독 조회 실패', ev.id, subErr.message); continue; }

    // 테스트 앱 구독만 — 본 앱으로는 어떤 경우에도 나가지 않는다
    const targets = (subs || []).filter((s: { scope: string | null }) => (s.scope || '').includes('-beta'));
    if (!targets.length) { done.push(ev.id); continue; }

    // 지금까지의 참석 현황 — 알림만 보고도 분위기를 알 수 있게 숫자를 실어 준다
    const { count: yesCnt } = await admin
      .from('event_rsvps').select('event_id', { count: 'exact', head: true })
      .eq('event_id', ev.id).eq('status', 'yes');

    const payload = JSON.stringify({
      title: `🏅 ${round ? `제${round}회 ` : ''}정기전이 이틀 뒤입니다`,
      body: [dateText(ev.event_date), ev.note || '',
             `지금까지 참석 ${yesCnt || 0}명 · 참석 여부를 알려 주세요`].filter(Boolean).join('\n'),
      url: `${APP_URL}calendar/?event=${ev.id}`,
      tag: `event-${ev.id}`
    });

    const gone: string[] = [];
    for (const s of targets) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        // 404/410 = 앱을 지웠거나 구독이 만료된 기기 → 주소록에서 정리한다
        if (code === 404 || code === 410) gone.push(s.endpoint);
        else failed++;
        console.error('push 실패', s.label, code, e);
      }
    }
    if (gone.length) {
      await admin.from('push_subscriptions_beta').delete().in('endpoint', gone);
      cleaned += gone.length;
    }
    done.push(ev.id);
  }

  // 보낸 자국은 마지막에 한 번에 찍는다. 중간에 죽으면 안 찍힌 정기전은 다음 크론이 다시 집는다 —
  // 두 번 오는 게 아예 안 오는 것보다 낫다.
  // (테스트 호출은 찍지 않는다. 같은 정기전으로 여러 번 시험해 볼 수 있어야 한다)
  if (!forceId && done.length) {
    await admin.from('club_events')
      .update({ remind_sent_at: new Date().toISOString() }).in('id', done);
  }

  return json({ target, events: events.length, sent, failed, cleaned });
});
