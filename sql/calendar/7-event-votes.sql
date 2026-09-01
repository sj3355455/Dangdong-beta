-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [7] 정기전 참석 투표 + 이틀 전 알림
--
-- Supabase → SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전합니다 (멱등).
-- 1-tables.sql / 2-rls.sql / 5-meetups.sql 을 먼저 실행한 뒤에 돌리세요.
--
-- 무엇이 바뀌나:
--   정기전(club_events)도 모임처럼 참/불참을 받는다. 모임(meetups)과 표를 합치지 않고
--   정기전 전용 투표 표를 따로 둔다 — 정기전은 팀장이 회차를 일괄로 등록하고 날짜를
--   옮기거나 지우는 고유한 흐름이 있어서, 두 표를 억지로 맞추면 늘 어긋난다.
--   대신 집계 함수가 모임(meetups_in)과 똑같은 모양의 결과를 돌려주므로,
--   화면에서는 모임 카드와 같은 코드로 그린다.
--
-- 누가 무엇을 볼 수 있나 — 모임과 같은 규칙:
--   · 참석자 → 이름까지. 누가 오는지가 이 기능의 목적이라서.
--   · 불참자 → 인원수만. 못 오는 사람이 눈치 볼 일을 만들지 않는다.
--   · 내 표  → 나에게만.
--   클라이언트는 event_rsvps 를 직접 읽지 못한다(RLS). 공개 범위의 유일한 통로는
--   아래 club_events_in / club_event_one 두 함수다.
--
-- 5-meetups.sql 도 먼저 실행해 두세요 — 앱은 두 표를 같은 카드로 함께 그립니다.
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.club_events') is null then
    raise exception '먼저 1-tables.sql 을 실행해 주세요. (club_events 없음)';
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
-- 1) 표
-- ─────────────────────────────────────────────────────────────
create table if not exists public.event_rsvps (
  event_id   uuid not null references public.club_events(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  status     text not null check (status in ('yes','no')),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists event_rsvps_event_idx on public.event_rsvps(event_id);

-- 이틀 전 알림을 이미 보냈는지. 크론이 하루에 여러 번 돌아도 같은 정기전으로 두 번 보내지 않는다.
-- 별도 표를 두지 않는 이유: 정기전이 지워지면 이 자국도 같이 사라져야 맞다.
alter table public.club_events add column if not exists remind_sent_at timestamptz;

grant select, insert, update, delete on public.event_rsvps to authenticated;
-- 알림을 보내는 Edge Function 이 읽는다 (RLS 를 지나쳐도 표 권한은 따로 필요)
grant select on public.event_rsvps to service_role;
grant select, update on public.club_events to service_role;

alter table public.event_rsvps enable row level security;

-- ─────────────────────────────────────────────────────────────
-- 2) RLS — '내 표'만 읽고 쓴다. 남의 표는 이 정책이 통째로 막는다.
--    화면에 보이는 참석자 이름·불참 인원수는 아래 집계 함수만 내보낸다.
--    (정기전 자체를 만들고 지우는 권한은 2-rls.sql 그대로 — 팀 관리자만)
-- ─────────────────────────────────────────────────────────────
drop policy if exists ersvps_select on public.event_rsvps;
create policy ersvps_select on public.event_rsvps
  for select to authenticated using (user_id = auth.uid());

drop policy if exists ersvps_insert on public.event_rsvps;
create policy ersvps_insert on public.event_rsvps
  for insert to authenticated with check (
    user_id = auth.uid()
    -- 남의 팀 정기전에 표를 밀어 넣지 못하게 — 그 정기전의 팀원인지 여기서 확인한다
    and exists (select 1 from public.club_events e
                 where e.id = event_id and public.is_member_of(e.team_id))
  );

drop policy if exists ersvps_update on public.event_rsvps;
create policy ersvps_update on public.event_rsvps
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ersvps_delete on public.event_rsvps;
create policy ersvps_delete on public.event_rsvps
  for delete to authenticated using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- 3) 집계 — 달력 한 달치 정기전을 참석 현황까지 한 번에 읽는다.
--    반환 열은 앱이 예전에 REST 로 받던 (id, event_date, note) 에 투표 넷을 더한 것이다.
--    반환 타입이 바뀌면 CREATE OR REPLACE 가 막히므로 먼저 지운다.
-- ─────────────────────────────────────────────────────────────
drop function if exists public.club_events_in(uuid, date, date);
create function public.club_events_in(t uuid, d1 date, d2 date)
returns table(
  id uuid, event_date date, note text,
  yes_names text[], yes_cnt integer, no_cnt integer, my_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id, e.event_date, e.note,
    coalesce((
      select array_agg(p.display_name order by p.display_name)
      from public.event_rsvps r join public.profiles p on p.id = r.user_id
      where r.event_id = e.id and r.status = 'yes'
    ), '{}')::text[],
    (select count(*) from public.event_rsvps r where r.event_id = e.id and r.status = 'yes')::integer,
    (select count(*) from public.event_rsvps r where r.event_id = e.id and r.status = 'no')::integer,
    (select r.status from public.event_rsvps r where r.event_id = e.id and r.user_id = auth.uid())
  from public.club_events e
  where e.team_id = t
    and e.event_date between d1 and d2
    and public.is_member_of(t)          -- 팀원이 아니면 한 줄도 나가지 않는다
  order by e.event_date
$$;

grant execute on function public.club_events_in(uuid, date, date) to authenticated;

-- 알림을 눌러 들어왔을 때처럼 정기전 하나만 필요한 경우.
-- 회차(round)는 저장하지 않는다 — 팀의 정기전을 날짜순으로 세는 게 곧 회차다(앱의 eventSeq 와 같은 규칙).
drop function if exists public.club_event_one(uuid);
create function public.club_event_one(e uuid)
returns table(
  id uuid, team_id uuid, event_date date, note text, round_no integer,
  yes_names text[], yes_cnt integer, no_cnt integer, my_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ee.id, ee.team_id, ee.event_date, ee.note,
    (select count(*) from public.club_events c
      where c.team_id = ee.team_id and c.event_date <= ee.event_date)::integer,
    coalesce((
      select array_agg(p.display_name order by p.display_name)
      from public.event_rsvps r join public.profiles p on p.id = r.user_id
      where r.event_id = ee.id and r.status = 'yes'
    ), '{}')::text[],
    (select count(*) from public.event_rsvps r where r.event_id = ee.id and r.status = 'yes')::integer,
    (select count(*) from public.event_rsvps r where r.event_id = ee.id and r.status = 'no')::integer,
    (select r.status from public.event_rsvps r where r.event_id = ee.id and r.user_id = auth.uid())
  from public.club_events ee
  where ee.id = e and public.is_member_of(ee.team_id)
$$;

grant execute on function public.club_event_one(uuid) to authenticated;

-- 알림 버튼으로 바로 투표하던 event_rsvp_by_endpoint 는 모임 쪽 rsvp_by_endpoint 와 함께
-- 걷어냈다(2026-09-01). 이유는 5-meetups.sql · sw.js 의 설명 참고.
-- 남아 있는 서버에서 걷어내는 건 9-drop-endpoint-rsvp.sql 이 맡는다.

do $$ begin raise notice '정기전 투표 설치 완료 — 이틀 전 알림은 8-event-reminder-cron.sql'; end $$;
