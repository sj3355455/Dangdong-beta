-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [1/4] 표 만들기
--
-- Supabase → SQL Editor 에 이 파일만 붙여넣고 Run.
-- 순서: 1-tables → 2-rls → 3-vote-counts → 4-plan-spans
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
-- 2) 참여 투표 — 부원이 날짜마다 O(가능) / X(불가) 를 남긴다
-- ─────────────────────────────────────────────────────────────
create table if not exists public.day_votes (
  team_id    uuid not null references public.teams(id) on delete cascade,
  vote_date  date not null,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  choice     text not null check (choice in ('o','x')),
  updated_at timestamptz not null default now(),
  primary key (team_id, vote_date, user_id)
);
create index if not exists day_votes_team_date_idx
  on public.day_votes(team_id, vote_date);

-- 2-1) 표에 붙는 부가 정보 (나중에 추가된 열 — 기존 표는 전부 null 이다)
--   slots             : O 일 때 가능한 시간 토막. 비트합 1=오전(6~12) 2=오후(12~18) 4=저녁(18~24).
--                       여러 개를 함께 고를 수 있어야 해서 비트로 담는다 (오전+저녁 = 5).
--                       null 은 예전 기록 — 아래 from_hour/to_hour 로 환산해서 센다.
--   from_hour/to_hour : slots 이전에 쓰던 "몇 시부터 몇 시까지". 새로 쓰지는 않고 읽기만 한다.
--   reason            : 예전에 X 사유를 담던 열. 지금은 day_plans 로 옮겨 쓰지 않는다.
-- 이 값들도 남에게는 개별로 나가지 않는다 — vote_counts 가 이름 없이 집계해서만 돌려준다.
alter table public.day_votes add column if not exists from_hour smallint;
alter table public.day_votes add column if not exists to_hour   smallint;
alter table public.day_votes add column if not exists reason    text;
alter table public.day_votes add column if not exists slots     smallint;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'day_votes_hours_chk'
                    and conrelid = 'public.day_votes'::regclass) then
    alter table public.day_votes add constraint day_votes_hours_chk check (
      (from_hour is null and to_hour is null)
      or (from_hour between 0 and 23 and to_hour between 1 and 24 and from_hour < to_hour)
    );
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'day_votes_reason_chk'
                    and conrelid = 'public.day_votes'::regclass) then
    alter table public.day_votes add constraint day_votes_reason_chk check (
      reason is null or char_length(reason) <= 20
    );
  end if;
  -- 하나도 안 고른 상태(0)는 없다 — O 를 눌렀으면 최소 한 토막은 가능하다는 뜻이다
  if not exists (select 1 from pg_constraint
                  where conname = 'day_votes_slots_chk'
                    and conrelid = 'public.day_votes'::regclass) then
    alter table public.day_votes add constraint day_votes_slots_chk check (
      slots is null or slots between 1 and 7
    );
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 2-2) 개인 일정 — "12~14일은 시험기간이라 안 된다"
--   day_votes 에 사유를 달아 두던 방식은 기본키가 (팀,날짜,사람)이라 하루에 하나뿐이었다.
--   그래서 같은 날 두 번째 일정을 넣으면 첫 일정을 덮어썼다. 일정을 '이름 + 기간' 한 행으로
--   따로 두면 한 사람이 같은 날에 몇 개든 등록할 수 있고, 지우는 것도 행 하나 지우면 끝난다.
--   day_votes 는 그대로 둔다 — 그냥 누르는 O/X 는 여전히 사람당 하루 하나가 맞다.
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

do $$ begin raise notice '[1/4] 표 생성 완료 — 다음은 2-rls.sql'; end $$;
