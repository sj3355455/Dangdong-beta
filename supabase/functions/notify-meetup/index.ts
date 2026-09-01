// 당동 — 모임이 만들어지면 팀원들에게 푸시 알림을 보낸다.
//
// 왜 서버가 필요한가:
//   푸시를 보내려면 VAPID 개인키로 서명해야 한다. 그 키가 앱(GitHub Pages)에 들어가면
//   누구나 부원들 폰에 알림을 쏠 수 있게 되므로, 키는 서버에만 두어야 한다.
//   Supabase Edge Function 이 그 '서버' 역할을 한다 — 상시 켜 둘 필요가 없다.
//
// 배포 (대시보드에서 다 된다):
//   1) Edge Functions → Deploy a new function → 이름 notify-meetup → 이 파일 내용 붙여넣기
//   2) Edge Functions → Secrets 에 아래 셋을 등록
//        VAPID_PUBLIC_KEY   ~/Documents/dangdong-push/vapid.json 의 publicKey
//        VAPID_PRIVATE_KEY  같은 파일의 privateKey   ← 절대 앱 코드에 넣지 말 것
//        APP_URL            https://sj3355455.github.io/Dangdong-beta/
//      (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동으로 들어와 있다)
//
// 누구에게 가나: 그 모임이 속한 팀의 팀원 중, 테스트 앱에서 알림을 켜 둔 기기 전부.
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
// 앱의 sbFetch 는 실패 응답에서 message 를 찾아 화면에 띄운다 — 같은 문구를 그 이름으로도 실어 준다
const fail = (message: string, status: number) => json({ error: message, message }, status);

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function dateText(d: string){
  const [y, m, dd] = d.split('-').map(Number);
  return `${m}월 ${dd}일 (${DOW[new Date(y, m - 1, dd).getDay()]})`;
}
function timeText(t: string | null){
  if (!t) return null;
  const [h, mi] = t.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? '오전' : '오후'} ${h12}시${mi ? ` ${mi}분` : ''}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('POST 만 받습니다', 405);

  const SB_URL = Deno.env.get('SUPABASE_URL')!;
  // 관리 권한 키의 이름은 프로젝트가 옛 체계냐 새 체계냐에 따라 다르다 — 있는 걸 쓴다.
  // 이 키가 없으면 팀원 명단·구독 목록이 RLS 에 막혀 조용히 0건이 되므로, 없으면 여기서 멈춘다.
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
               || Deno.env.get('SUPABASE_SECRET_KEY')
               || Deno.env.get('SERVICE_ROLE_KEY');
  const PUB = Deno.env.get('VAPID_PUBLIC_KEY');
  const PRIV = Deno.env.get('VAPID_PRIVATE_KEY');
  const APP_URL = Deno.env.get('APP_URL') || 'https://sj3355455.github.io/Dangdong-beta/';

  if (!PUB || !PRIV) return fail('VAPID 키가 등록되지 않았습니다 (Edge Functions → Secrets)', 500);
  if (!SERVICE) return fail('관리 권한 키를 찾지 못했습니다. Edge Functions → Secrets 에 '
    + 'SERVICE_ROLE_KEY 라는 이름으로 service_role(또는 secret) 키를 등록해 주세요.', 500);

  let meetupId: string;
  try {
    const body = await req.json();
    meetupId = body?.meetup_id;
    if (!meetupId) throw new Error('meetup_id 가 없습니다');
  } catch (e) {
    return fail(String(e instanceof Error ? e.message : e), 400);
  }

  // 1) 부른 사람이 이 모임을 볼 수 있는 사람인지 — 사용자 토큰 그대로 조회해 RLS 에 맡긴다.
  //    (여기서 통과했다는 건 그 팀의 팀원이라는 뜻이다)
  const authHeader = req.headers.get('Authorization') || '';
  const asUser = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }
  });
  const { data: meetup, error: mErr } = await asUser
    .from('meetups')
    .select('id, team_id, meet_date, meet_time, place, note, created_by')
    .eq('id', meetupId)
    .single();
  if (mErr || !meetup) return fail('모임을 찾을 수 없거나 볼 권한이 없습니다', 403);

  // 2) 여기서부터는 service_role — 팀원 명단과 구독 목록은 RLS 로 막혀 있어 관리 권한이 필요하다
  const admin = createClient(SB_URL, SERVICE);

  // 조회 오류를 삼키면 '결과 없음'과 구분이 안 된다 — 관리 권한이 모자란 경우가 딱 그렇게 보인다.
  const { data: members, error: memErr } = await admin
    .from('team_members').select('user_id').eq('team_id', meetup.team_id);
  if (memErr) return fail('팀원 명단을 읽지 못했습니다: ' + memErr.message, 500);
  const memberIds = (members || []).map((m: { user_id: string }) => m.user_id);
  if (!memberIds.length) return json({ sent: 0, failed: 0, note: '이 팀에 팀원이 없습니다' });

  const { data: subs, error: subErr } = await admin
    .from('push_subscriptions_beta')
    .select('endpoint, p256dh, auth_key, label, scope, user_id')
    .in('user_id', memberIds);
  if (subErr) return fail('구독 목록을 읽지 못했습니다: ' + subErr.message, 500);

  // 테스트 앱 구독만 — 본 앱으로는 어떤 경우에도 나가지 않는다
  const targets = (subs || []).filter((s: { scope: string | null }) => (s.scope || '').includes('-beta'));
  if (!targets.length) return json({ sent: 0, failed: 0,
    note: `알림을 켠 기기가 없습니다 (팀원 ${memberIds.length}명, 구독 ${(subs || []).length}건)` });

  const { data: creator } = await admin
    .from('profiles').select('display_name').eq('id', meetup.created_by).single();

  const when = timeText(meetup.meet_time);
  const parts = [when, meetup.place].filter(Boolean);
  const payload = JSON.stringify({
    title: `🎱 ${dateText(meetup.meet_date)} 모임`,
    body: [parts.join(' · ') || '시간·장소 미정',
           meetup.note || '',
           creator?.display_name ? `${creator.display_name}님이 만듦` : ''].filter(Boolean).join('\n'),
    url: `${APP_URL}calendar/?meetup=${meetup.id}`,
    tag: `meetup-${meetup.id}`
  });

  webpush.setVapidDetails(APP_URL, PUB, PRIV);

  let sent = 0, failed = 0;
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
  if (gone.length) await admin.from('push_subscriptions_beta').delete().in('endpoint', gone);

  return json({ sent, failed, cleaned: gone.length });
});
