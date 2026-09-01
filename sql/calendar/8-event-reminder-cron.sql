-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [8] 정기전 이틀 전 알림 — 매일 한 번 부르는 예약
--
-- 7-event-votes.sql 을 먼저 실행하고, Edge Function `notify-event` 를 배포한 뒤에 돌리세요.
--
-- 얼개: pg_cron 이 매일 정해진 시각에 pg_net 으로 Edge Function 을 부른다.
--   푸시를 보내려면 VAPID 개인키로 서명해야 하는데 그 키는 Edge Function 에만 있다.
--   그래서 DB 는 "지금 확인해 봐"라고 두드리기만 하고, 누구에게 보낼지 고르는 일은
--   함수가 한다 (한국 날짜로 모레인 정기전 전부).
--
-- ▶ 아래 두 곳을 자기 프로젝트 값으로 바꾼 다음 Run 하세요.
--     :project_ref   Supabase 프로젝트 ref  (대시보드 주소의 그 문자열)
--     :service_key   service_role 키        (Settings → API → service_role)
--   service_role 키는 DB 안에만 들어갑니다 — 앱 코드에는 절대 넣지 마세요.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  project_ref text := 'ezwassqurbmzcjfmtjop';                 -- ← 확인만 하고 두면 됩니다
  service_key text := 'PASTE_SERVICE_ROLE_KEY_HERE';          -- ← 반드시 바꿔 주세요
  fn_url text;
begin
  if service_key = 'PASTE_SERVICE_ROLE_KEY_HERE' then
    raise exception 'service_key 를 실제 service_role 키로 바꾼 뒤 다시 실행해 주세요.';
  end if;

  fn_url := 'https://' || project_ref || '.functions.supabase.co/notify-event';

  -- 이미 걸려 있으면 지우고 다시 건다 (여러 번 실행해도 예약이 쌓이지 않게)
  perform cron.unschedule('dangdong-event-reminder')
  where exists (select 1 from cron.job where jobname = 'dangdong-event-reminder');

  -- 매일 한국시간 오전 10시 = UTC 01:00.
  -- 아침에 받아야 이틀 뒤 일정을 조정할 시간이 남는다. 너무 이르면 알림이 잠결에 묻힌다.
  perform cron.schedule(
    'dangdong-event-reminder',
    '0 1 * * *',
    format(
      -- pg_net 은 비동기다 — 이 select 는 요청을 걸어 두고 바로 끝나고, 응답은 뒤에
      -- net._http_response 로 들어온다. 기본 5초는 여러 기기에 푸시를 돌리기엔 짧아서 넉넉히 준다
      -- (짧아도 발송 자체는 되지만 응답이 timeout 으로 남아 결과를 확인할 수 없다).
      $cmd$select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      )$cmd$, fn_url, service_key)
  );

  raise notice '정기전 알림 예약 완료 — 매일 한국시간 10:00 에 % 를 부릅니다', fn_url;
end $$;

-- ── 확인·정리용 ──────────────────────────────────────────────
-- 걸린 예약 보기:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'dangdong-event-reminder';
-- 크론이 돌았는지 보기 (요청을 걸었는지까지만 — 성공/실패는 아래 응답을 봐야 한다):
--   select start_time, status, return_message from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'dangdong-event-reminder')
--    order by start_time desc limit 10;
-- 함수가 뭐라고 답했는지 보기 (pg_net 은 비동기라 결과가 여기 따로 쌓인다):
--   select created, status_code, content from net._http_response order by created desc limit 5;
--   → status_code 200 에 content 가 {"target":...,"sent":N,...} 이면 정상
-- 예약 끄기:
--   select cron.unschedule('dangdong-event-reminder');
--
-- ── 지금 바로 한 번 시험해 보려면 ────────────────────────────
-- 정기전 하나를 골라 그 id 로 함수를 직접 부르면 날짜와 발송 여부를 따지지 않고 보냅니다.
-- (remind_sent_at 도 찍히지 않으므로 몇 번이든 다시 해 볼 수 있습니다)
--   select net.http_post(
--     url := 'https://<project_ref>.functions.supabase.co/notify-event',
--     headers := jsonb_build_object('Content-Type','application/json',
--                                   'Authorization','Bearer <service_role_key>'),
--     body := jsonb_build_object('event_id', '<정기전 uuid>')
--   );
--
-- 이미 알림이 나간 정기전을 다시 보내고 싶다면 자국을 지웁니다:
--   update public.club_events set remind_sent_at = null where id = '<정기전 uuid>';
