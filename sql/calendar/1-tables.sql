-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [1] 표 만들기
--
-- Supabase → SQL Editor 에 이 파일만 붙여넣고 Run.
-- 순서: 1-tables → 2-rls → 4-plan-spans → 5-meetups → 7-event-votes → 8-...
-- teams-setup.sql / teams-rls.sql 을 먼저 실행한 뒤에 돌려야 합니다.
-- 여러 번 실행해도 안전합니다 (멱등).
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 0-0) 선행 조건 검사
--   SQL Editor 는 스크립트 전체를 한 트랜잭션으로 돌린다. 뒤쪽에서 실패하면 앞에서
--   만든 것까지 전부 롤백되어 "아무것도 안 생겼는데 이유는 모르겠는" 상태가 된다.
--   그래서 의존하는 것들이 있는지 먼저 확인하고, 없으면 읽을 수 있는 문구로 멈춘다.
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.teams') is null or to_regclass('public.team_members') is null then
    raise exception '먼저 teams-setup.sql 을 실행해 주세요. (teams / team_members 테이블이 없습니다)';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'profiles 테이블이 없습니다. 기본 스키마부터 확인해 주세요.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception '먼저 teams-rls.sql 을 실행해 주세요. (is_member_of 함수가 없습니다)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 0) 팀 관리자 판별 (RLS 안에서 재귀 없이 쓰려고 SECURITY DEFINER)
--    is_member_of 는 teams-rls.sql 에서 이미 만들어 둔 것을 그대로 쓴다.
-- ─────────────────────────────────────────────────────────────
create or replace function public.is_team_admin(t uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.team_members
    where team_id = t and user_id = auth.uid() and is_admin
  )
$$;

-- ─────────────────────────────────────────────────────────────
-- 1) 정기전 — 관리자가 "이 날이 몇 회 정기전"인지 직접 지정
-- ─────────────────────────────────────────────────────────────
create table if not exists public.club_events (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  event_date date not null,
  round_no   int,                 -- 회차. 번호를 안 매기는 모임이면 null
  note       text,                -- 짧은 메모 (장소 등). 선택
  created_at timestamptz not null default now(),
  unique (team_id, event_date)    -- 하루에 정기전 하나
);
create index if not exists club_events_team_date_idx
  on public.club_events(team_id, event_date);

-- ─────────────────────────────────────────────────────────────
-- 2) 개인 일정 — "12~14일은 시험기간이라 안 된다"
--   일정을 '이름 + 기간' 한 행으로 두면 한 사람이 같은 날에 몇 개든 등록할 수 있고,
--   지우는 것도 행 하나 지우면 끝난다.
--
--   날짜마다 O/X 를 칠하던 표(day_votes)는 모임 투표(5-meetups.sql)로 대체되어 사라졌다.
--   이미 만들어 둔 서버에서 걷어내는 건 6-drop-day-votes.sql 이 맡는다.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.day_plans (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  created_at timestamptz not null default now(),
  constraint day_plans_name_chk  check (char_length(btrim(name)) between 1 and 20),
  constraint day_plans_range_chk check (end_date >= start_date)
);
create index if not exists day_plans_team_range_idx
  on public.day_plans(team_id, start_date, end_date);

do $$ begin raise notice '[1] 표 생성 완료 — 다음은 2-rls.sql'; end $$;
