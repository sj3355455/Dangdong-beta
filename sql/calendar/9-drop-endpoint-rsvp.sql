-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [9] 알림 버튼 투표 함수 걷어내기
--
-- Supabase → SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전합니다 (멱등).
-- 이미 만들어 둔 서버에만 필요합니다 — 새로 까는 서버에는 애초에 안 생깁니다.
--
-- 무엇을 지우나:
--   rsvp_by_endpoint(text, uuid, text)         모임 참/불참
--   event_rsvp_by_endpoint(text, uuid, text)   정기전 참/불참
--
-- 왜 지우나:
--   알림에 붙였던 [참석]/[불참] 버튼을 걷어냈다(2026-09-01). 어떤 안드로이드 기기에서
--   어느 버튼을 눌러도 두 번째 값이 서버로 가서, 잘못된 표가 조용히 남았다.
--   버튼이 사라진 지금 이 두 함수를 부르는 곳은 앱 어디에도 없다.
--
--   그냥 두면 안 되는 이유: 둘 다 SECURITY DEFINER 인 데다 anon 에게도 실행 권한이
--   열려 있다. 남의 구독 주소(endpoint)를 아는 사람은 로그인 없이 그 사람 대신 표를
--   넣을 수 있다는 뜻이다. 쓰지도 않는 문을 열어 둘 이유가 없다.
--
-- 되살리려면: 이 파일을 돌리지 말고, git 이력에서 5-meetups.sql / 7-event-votes.sql 의
--   해당 블록과 sw.js 의 notificationclick 처리를 함께 꺼내야 한다. 한쪽만으로는 안 된다.
-- ═══════════════════════════════════════════════════════════════

drop function if exists public.rsvp_by_endpoint(text, uuid, text);
drop function if exists public.event_rsvp_by_endpoint(text, uuid, text);

-- 참/불참 자체는 그대로 된다 — 알림을 누르면 캘린더가 그 날을 연 채로 뜨고, 거기서 고른다.
-- (그 경로는 로그인 토큰으로 event_rsvps / meetup_rsvps 에 직접 쓰므로 이 함수와 무관하다)

notify pgrst, 'reload schema';

do $$
declare left_over text := '';
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'rsvp_by_endpoint')
    then left_over := left_over || ' rsvp_by_endpoint'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'event_rsvp_by_endpoint')
    then left_over := left_over || ' event_rsvp_by_endpoint'; end if;

  if left_over = '' then
    raise notice '알림 버튼 투표 함수를 걷어냈습니다.';
  else
    raise warning '아직 남아 있습니다:% — 인자 모양이 다른 옛 함수일 수 있으니 '
                  'select oid::regprocedure from pg_proc where proname like ''%%rsvp_by_endpoint'' 로 확인해 주세요.',
                  left_over;
  end if;
end $$;
