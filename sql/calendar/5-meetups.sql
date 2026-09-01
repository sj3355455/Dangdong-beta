-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [5] 모임 투표
--
-- Supabase → SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전합니다 (멱등).
-- teams-setup.sql / teams-rls.sql / 1-tables.sql 을 먼저 실행한 뒤에 돌리세요.
--
-- 무엇이 바뀌나:
--   예전에는 날짜마다 "그날 되나요?"를 각자 칠해 두는 방식이었다. 그건 날짜만 있고
--   약속이 없어서, 정작 모임을 잡을 땐 다시 이야기를 해야 했다.
--   이제는 "8/25 5시 메카당구장" 처럼 모임 하나를 띄우고 거기에 참/불참을 받는다.
--
-- 누가 무엇을 볼 수 있나 (참석자만 공개):
--   · 참석자   → 이름까지 보인다. 누가 오는지가 이 기능의 목적이라서.
--   · 불참자   → 인원수만 나간다. 못 오는 사람이 눈치 볼 일을 만들지 않는다.
--   · 내 표    → 당연히 나에게만 보인다.
--   이 규칙은 집계 함수(meetups_in)가 서버에서 지킨다. 클라이언트는 rsvp 표를
--   직접 읽지 못하므로(RLS), 앱 코드를 아무리 뜯어봐도 불참자 이름은 나오지 않는다.
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.teams') is null or to_regclass('public.team_members') is null then
    raise exception '먼저 teams-setup.sql 을 실행해 주세요. (teams / team_members 없음)';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'profiles 테이블이 없습니다.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception '먼저 teams-rls.sql 을 실행해 주세요. (is_member_of 함수 없음)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 표
-- ─────────────────────────────────────────────────────────────
create table if not exists public.meetups (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  meet_date  date not null,
  meet_time  time,                       -- null = 시간 미정
  place      text,
  note       text,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists meetups_team_date_idx on public.meetups(team_id, meet_date);

create table if not exists public.meetup_rsvps (
  meetup_id  uuid not null references public.meetups(id) on delete cascade,
  user_id    uuid not null,
  status     text not null check (status in ('yes','no')),
  updated_at timestamptz not null default now(),
  primary key (meetup_id, user_id)
);

grant select, insert, update, delete on public.meetups      to authenticated;
grant select, insert, update, delete on public.meetup_rsvps to authenticated;
-- 알림을 보내는 Edge Function 이 모임 내용을 읽는다 (RLS 통과 키라도 표 권한은 따로 필요)
grant select on public.meetups      to service_role;
grant select on public.meetup_rsvps to service_role;

alter table public.meetups      enable row level security;
alter table public.meetup_rsvps enable row level security;

-- ─────────────────────────────────────────────────────────────
-- RLS — 모임 자체는 팀원 누구나 만들 수 있다.
-- 고치고 지우는 건 만든 사람만. (팀장 특권을 따로 두지 않는다 — 번개 모임이 주 용도라서)
-- ─────────────────────────────────────────────────────────────
drop policy if exists meetups_select on public.meetups;
create policy meetups_select on public.meetups
  for select to authenticated using (public.is_member_of(team_id));

drop policy if exists meetups_insert on public.meetups;
create policy meetups_insert on public.meetups
  for insert to authenticated with check (created_by = auth.uid() and public.is_member_of(team_id));

drop policy if exists meetups_update on public.meetups;
create policy meetups_update on public.meetups
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists meetups_delete on public.meetups;
create policy meetups_delete on public.meetups
  for delete to authenticated using (created_by = auth.uid());

-- rsvp 는 '내 표'만 읽고 쓴다. 남의 표는 이 정책이 통째로 막는다 —
-- 화면에 보이는 참석자 이름·불참 인원수는 아래 집계 함수만 내보낸다.
drop policy if exists rsvps_select on public.meetup_rsvps;
create policy rsvps_select on public.meetup_rsvps
  for select to authenticated using (user_id = auth.uid());

drop policy if exists rsvps_insert on public.meetup_rsvps;
create policy rsvps_insert on public.meetup_rsvps
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists rsvps_update on public.meetup_rsvps;
create policy rsvps_update on public.meetup_rsvps
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rsvps_delete on public.meetup_rsvps;
create policy rsvps_delete on public.meetup_rsvps
  for delete to authenticated using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- 집계 — 달력 한 달치 모임을 한 번에 읽는다.
-- 참석자는 이름 배열, 불참은 숫자 하나. 이 함수가 공개 범위의 유일한 통로다.
-- 반환 타입이 바뀌면 CREATE OR REPLACE 가 막히므로 먼저 지운다.
-- ─────────────────────────────────────────────────────────────
drop function if exists public.meetups_in(uuid, date, date);
create function public.meetups_in(t uuid, d1 date, d2 date)
returns table(
  id uuid, meet_date date, meet_time time, place text, note text,
  created_by uuid, creator_name text,
  yes_names text[], yes_cnt integer, no_cnt integer, my_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id, m.meet_date, m.meet_time, m.place, m.note,
    m.created_by,
    (select p.display_name from public.profiles p where p.id = m.created_by),
    coalesce((
      select array_agg(p.display_name order by p.display_name)
      from public.meetup_rsvps r join public.profiles p on p.id = r.user_id
      where r.meetup_id = m.id and r.status = 'yes'
    ), '{}')::text[],
    (select count(*) from public.meetup_rsvps r where r.meetup_id = m.id and r.status = 'yes')::integer,
    (select count(*) from public.meetup_rsvps r where r.meetup_id = m.id and r.status = 'no')::integer,
    (select r.status from public.meetup_rsvps r where r.meetup_id = m.id and r.user_id = auth.uid())
  from public.meetups m
  where m.team_id = t
    and m.meet_date between d1 and d2
    and public.is_member_of(t)          -- 팀원이 아니면 한 줄도 나가지 않는다
  order by m.meet_date, m.meet_time nulls last, m.created_at
$$;

grant execute on function public.meetups_in(uuid, date, date) to authenticated;

-- 알림을 눌러 들어왔을 때처럼 모임 하나만 필요한 경우
drop function if exists public.meetup_one(uuid);
create function public.meetup_one(m uuid)
returns table(
  id uuid, team_id uuid, meet_date date, meet_time time, place text, note text,
  created_by uuid, creator_name text,
  yes_names text[], yes_cnt integer, no_cnt integer, my_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    mm.id, mm.team_id, mm.meet_date, mm.meet_time, mm.place, mm.note,
    mm.created_by,
    (select p.display_name from public.profiles p where p.id = mm.created_by),
    coalesce((
      select array_agg(p.display_name order by p.display_name)
      from public.meetup_rsvps r join public.profiles p on p.id = r.user_id
      where r.meetup_id = mm.id and r.status = 'yes'
    ), '{}')::text[],
    (select count(*) from public.meetup_rsvps r where r.meetup_id = mm.id and r.status = 'yes')::integer,
    (select count(*) from public.meetup_rsvps r where r.meetup_id = mm.id and r.status = 'no')::integer,
    (select r.status from public.meetup_rsvps r where r.meetup_id = mm.id and r.user_id = auth.uid())
  from public.meetups mm
  where mm.id = m and public.is_member_of(mm.team_id)
$$;

grant execute on function public.meetup_one(uuid) to authenticated;

-- 알림 [참석]/[불참] 버튼으로 바로 투표하던 rsvp_by_endpoint 는 걷어냈다(2026-09-01).
-- 어떤 안드로이드 기기가 어느 버튼을 눌러도 두 번째 값을 보내 잘못된 표가 조용히 남았고,
-- 알림에서 버튼 자체를 뺐기 때문이다(sw.js 의 설명 참고). 남아 있는 서버에서 걷어내는 건
-- 9-drop-endpoint-rsvp.sql 이 맡는다.

do $$ begin raise notice '모임 투표 설치 완료'; end $$;
