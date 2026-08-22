-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [진단] 지금 서버에 뭐가 있는지 보기
--
-- 아무것도 만들거나 바꾸지 않습니다. 붙여넣고 Run 한 뒤 결과 표를 그대로 알려주세요.
-- found 칸이 비어(null) 있으면 그게 없는 것입니다.
-- ═══════════════════════════════════════════════════════════════
select 'club_events'   as 이름, 'table'    as 종류, to_regclass('public.club_events')::text as found
union all
select 'day_votes',      'table',    to_regclass('public.day_votes')::text
union all
select 'day_plans',      'table',    to_regclass('public.day_plans')::text
union all
select 'vote_counts',    'function', (select p.oid::regprocedure::text
                                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public' and p.proname = 'vote_counts' limit 1)
union all
select 'plan_spans',     'function', (select p.oid::regprocedure::text
                                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public' and p.proname = 'plan_spans' limit 1)
union all
select 'is_member_of',   'function', (select p.oid::regprocedure::text
                                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public' and p.proname = 'is_member_of' limit 1)
union all
select 'is_team_admin',  'function', (select p.oid::regprocedure::text
                                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public' and p.proname = 'is_team_admin' limit 1)
union all
select 'search_path',    'setting',  current_setting('search_path')
union all
select 'current_user',   'setting',  current_user::text
union all
select 'current_database','setting', current_database()::text;
