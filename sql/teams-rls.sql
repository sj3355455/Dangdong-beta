-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 소속 팀 — Phase 1.5: 권한(GRANT) + 새 테이블 RLS + 합류 함수
-- teams-setup.sql 을 먼저 실행한 뒤에 이 파일을 Run 하세요.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- 왜 지금? teams/team_members 는 새 테이블이라 클라이언트 권한이 없다.
-- 권한만 열고 RLS를 안 걸면 "아무 로그인 유저나 임의 팀에 자기를 끼워넣기"가
-- 가능해진다. 그래서 이 두 테이블은 처음부터 RLS로 잠그고, 합류는
-- 초대 코드를 검증하는 SECURITY DEFINER 함수(join_team)로만 하게 한다.
-- (games/profiles 격리 RLS는 이후 단계에서 별도 적용)
-- ═══════════════════════════════════════════════════════════════

-- 0) 내가 특정 팀 소속인지 (RLS 안에서 재귀 없이 쓰려고 SECURITY DEFINER)
create or replace function public.is_member_of(t uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.team_members
    where team_id = t and user_id = auth.uid()
  )
$$;

-- 1) 기본 테이블 권한 (실제 접근 범위는 아래 RLS가 제한)
grant select on public.teams to anon, authenticated;
grant select on public.team_members to anon, authenticated;
-- team_members 직접 INSERT/DELETE 권한은 주지 않는다. 합류는 join_team 함수로만.

-- 2) RLS 활성화
alter table public.teams enable row level security;
alter table public.team_members enable row level security;

-- 3) 정책: 내가 속한 팀만 보이게
drop policy if exists "read my teams" on public.teams;
create policy "read my teams" on public.teams
  for select using (public.is_member_of(id));

drop policy if exists "read team roster" on public.team_members;
create policy "read team roster" on public.team_members
  for select using (public.is_member_of(team_id));

-- 4) 초대 코드로 합류 (코드 노출/임의 삽입 없이 안전하게)
--    - join_code 는 SELECT로 노출되지 않는다 (열거 방지).
--    - 로그인 유저가 올바른 코드를 제시할 때만 자기 자신을 멤버로 추가.
create or replace function public.join_team(code text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare t uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  select id into t from public.teams where join_code = code;
  if t is null then
    raise exception 'invalid_code';
  end if;
  insert into public.team_members (team_id, user_id)
    values (t, auth.uid())
    on conflict (team_id, user_id) do nothing;
  return t;
end
$$;
grant execute on function public.join_team(text) to authenticated;

-- 5) 내가 속한 팀 목록 (스위처용) — 이름까지 한 번에.
--    RLS 때문에 클라이언트가 teams를 직접 조인해도 되지만, 편의 함수도 제공.
create or replace function public.my_teams()
returns table(id uuid, name text, slug text, is_admin boolean)
language sql stable security definer set search_path = public
as $$
  select t.id, t.name, t.slug, m.is_admin
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by t.name
$$;
grant execute on function public.my_teams() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 확인용 (선택): SQL Editor는 service_role이라 RLS를 우회하므로 그냥 보입니다.
-- select id, name, slug from public.teams;
-- select * from public.my_teams();   -- SQL Editor에서는 auth.uid()가 없어 빈 결과일 수 있음(정상)
-- ═══════════════════════════════════════════════════════════════
