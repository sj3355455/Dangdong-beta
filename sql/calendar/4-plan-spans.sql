-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [4/4] 일정 막대 함수 + 설치 점검
--
-- 1~3 을 먼저 실행하세요. 여러 번 실행해도 안전합니다.
-- 실행 결과(Messages)에 '캘린더 설치 완료' 가 보이면 끝입니다.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 달력에 그릴 일정 막대 — 이름·기간·인원수만 나간다.
--   같은 이름이라도 기간이 다르면 다른 막대다. 예전처럼 날짜별 사유를 클라이언트가
--   이어 붙이지 않으므로, 두 사람의 '시험기간'이 기간이 다른데 하나로 합쳐지던 문제도 없다.
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.day_plans') is null then
    raise exception '먼저 1-tables.sql 을 실행해 주세요. (day_plans 없음, search_path=%)',
                    current_setting('search_path');
  end if;
end $$;

create or replace function public.plan_spans(t uuid, d1 date, d2 date)
returns table(name text, start_date date, end_date date, cnt integer)
language sql
stable
security definer
set search_path = public
as $$
  select btrim(p.name), p.start_date, p.end_date, count(distinct p.user_id)::integer
  from public.day_plans p
  where p.team_id = t
    and p.start_date <= d2
    and p.end_date >= d1
    and public.is_member_of(t)     -- 팀원이 아니면 빈 결과
  group by btrim(p.name), p.start_date, p.end_date
$$;
grant execute on function public.plan_spans(uuid, date, date) to authenticated;

-- PostgREST 스키마 캐시 갱신 — 이걸 빼먹으면 앱에서 rpc 가 404 로 떨어진다.
-- (앱은 이 실패를 화면에 그대로 표시한다. 계속 404 면 이 줄만 다시 실행해 보세요)
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────
-- 자체 점검 — 1~4 가 다 들어갔는지 여기서 확인하고 끝낸다.
-- ─────────────────────────────────────────────────────────────
do $$
declare missing text := '';
begin
  if to_regclass('public.club_events') is null then missing := missing || ' club_events'; end if;
  if to_regclass('public.day_votes')  is null then missing := missing || ' day_votes';  end if;
  if to_regclass('public.day_plans')  is null then missing := missing || ' day_plans';  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'plan_spans')
    then missing := missing || ' plan_spans'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'vote_counts')
    then missing := missing || ' vote_counts'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_team_admin')
    then missing := missing || ' is_team_admin'; end if;

  if missing <> '' then
    raise exception '설치가 덜 됐습니다. 빠진 것:% — 해당 파일을 다시 실행해 주세요.', missing;
  end if;
  raise notice '캘린더 설치 완료 — club_events / day_votes / day_plans / vote_counts / plan_spans / is_team_admin 모두 확인';
end $$;

-- 설치 후 확인 쿼리 (선택)
-- select p.proname, pg_get_function_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('vote_counts','plan_spans','is_member_of','is_team_admin');
-- SQL Editor 는 service_role 이라 RLS 를 우회합니다. 익명성 검증은 앱에서 하세요.
-- ═══════════════════════════════════════════════════════════════
