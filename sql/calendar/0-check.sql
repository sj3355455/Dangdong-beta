-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [진단] 지금 서버에 뭐가 있는지 보기
--
-- 아무것도 만들거나 바꾸지 않습니다. 붙여넣고 Run 한 뒤 결과 표를 그대로 알려주세요.
-- found 칸이 비어(null) 있으면 그게 없는 것입니다.
--
-- day_votes / vote_counts 가 아직 보이면 6-drop-day-votes.sql 을 아직 안 돌린 서버입니다.
-- rsvp_by_endpoint / event_rsvp_by_endpoint 가 보이면 9-drop-endpoint-rsvp.sql 을 돌려 주세요.
-- ═══════════════════════════════════════════════════════════════
with want(이름, 종류) as (values
  ('club_events','table'), ('day_plans','table'),
  ('meetups','table'), ('meetup_rsvps','table'), ('event_rsvps','table'),
  ('plan_spans','function'), ('meetups_in','function'), ('meetup_one','function'),
  ('club_events_in','function'), ('club_event_one','function'),
  ('is_member_of','function'), ('is_team_admin','function'),
  -- 아래 넷은 걷어낸 것들 — 보이면 안 된다
  ('day_votes','table'), ('vote_counts','function'),
  ('rsvp_by_endpoint','function'), ('event_rsvp_by_endpoint','function')
)
select w.이름, w.종류,
       case w.종류
         when 'table' then to_regclass('public.' || w.이름)::text
         else (select p.oid::regprocedure::text
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = w.이름 limit 1)
       end as found
  from want w
union all
select 'search_path',     'setting', current_setting('search_path')
union all
select 'current_user',    'setting', current_user::text
union all
select 'current_database','setting', current_database()::text;
