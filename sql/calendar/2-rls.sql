-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [2/4] 권한 + RLS
--
-- 1-tables.sql 을 먼저 실행하세요. 여러 번 실행해도 안전합니다.
--
-- 익명성을 어떻게 지키는가:
--   day_votes 는 "내 표만 SELECT" 정책이라, 클라이언트는 남의 표를 아예 읽을 수 없다.
--   day_plans 도 마찬가지로 '내 일정'만 읽힌다.
--   화면에 보이는 인원수는 집계 함수(vote_counts / plan_spans)가 서버에서 세어 숫자만 돌려준다.
--   즉 누가 무엇을 골랐는지는 앱 어디에서도 조회할 방법이 없다.
-- ═══════════════════════════════════════════════════════════════

do $$
declare missing text := '';
begin
  if to_regclass('public.club_events') is null then missing := missing || ' club_events'; end if;
  if to_regclass('public.day_votes')  is null then missing := missing || ' day_votes';  end if;
  if to_regclass('public.day_plans')  is null then missing := missing || ' day_plans';  end if;
  if missing <> '' then
    raise exception '먼저 1-tables.sql 을 실행해 주세요. 없는 표:% (search_path=%)',
                    missing, current_setting('search_path');
  end if;
end $$;

grant select, insert, update, delete on public.club_events to authenticated;
grant select, insert, update, delete on public.day_votes  to authenticated;
grant select, insert, update, delete on public.day_plans  to authenticated;

alter table public.club_events enable row level security;
alter table public.day_votes  enable row level security;
alter table public.day_plans  enable row level security;

-- 일정: 표와 똑같이 '내 것'만 읽고 쓴다. 남의 일정은 조회 자체가 불가능하고,
-- 화면에 보이는 막대는 plan_spans 가 이름과 인원수만 집계해서 돌려준 것이다.
drop policy if exists "read own plan" on public.day_plans;
drop policy if exists "add own plan"  on public.day_plans;
drop policy if exists "edit own plan" on public.day_plans;
drop policy if exists "drop own plan" on public.day_plans;

create policy "read own plan" on public.day_plans
  for select using (user_id = auth.uid());
create policy "add own plan" on public.day_plans
  for insert with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "edit own plan" on public.day_plans
  for update using (user_id = auth.uid())
       with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "drop own plan" on public.day_plans
  for delete using (user_id = auth.uid());

-- 정기전: 팀원이면 읽고, 팀 관리자만 쓴다
drop policy if exists "read team events"   on public.club_events;
drop policy if exists "admin add event"    on public.club_events;
drop policy if exists "admin edit event"   on public.club_events;
drop policy if exists "admin drop event"   on public.club_events;

create policy "read team events" on public.club_events
  for select using (public.is_member_of(team_id));
create policy "admin add event" on public.club_events
  for insert with check (public.is_team_admin(team_id));
create policy "admin edit event" on public.club_events
  for update using (public.is_team_admin(team_id))
       with check (public.is_team_admin(team_id));
create policy "admin drop event" on public.club_events
  for delete using (public.is_team_admin(team_id));

-- 투표: 오직 '내 표'만. 남의 표는 조회 자체가 불가능하다 → 익명 보장.
drop policy if exists "read own vote"   on public.day_votes;
drop policy if exists "add own vote"    on public.day_votes;
drop policy if exists "edit own vote"   on public.day_votes;
drop policy if exists "drop own vote"   on public.day_votes;

create policy "read own vote" on public.day_votes
  for select using (user_id = auth.uid());
create policy "add own vote" on public.day_votes
  for insert with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "edit own vote" on public.day_votes
  for update using (user_id = auth.uid())
       with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "drop own vote" on public.day_votes
  for delete using (user_id = auth.uid());

do $$ begin raise notice '[2/4] RLS 완료 — 다음은 3-vote-counts.sql'; end $$;
