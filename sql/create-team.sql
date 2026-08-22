-- ═══════════════════════════════════════════════════════════════
-- 셀프서비스 팀 만들기: create_team(team_name)
-- Supabase SQL Editor에 붙여넣고 Run 하세요. 멱등(여러 번 실행 안전).
--
-- 로그인한 사용자가 새 팀을 만들면:
--   - public.profiles 에 유저 행이 없으면 자동 생성 (FK 에러 방지)
--   - teams에 팀 생성 (slug·참여코드 자동 발급)
--   - 만든 사람을 그 팀의 관리자(team_members.is_admin=true)로 등록
--   - {id, name, slug, join_code} 반환 → 앱이 참여코드를 보여줌
-- ═══════════════════════════════════════════════════════════════

create or replace function public.create_team(team_name text)
returns table(id uuid, name text, slug text, join_code text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  new_id uuid;
  new_slug text;
  new_code text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  
  if team_name is null or length(btrim(team_name)) = 0 then
    raise exception 'empty_name';
  end if;
  
  if exists (select 1 from public.teams t where lower(t.name) = lower(btrim(team_name))) then
    raise exception 'name_taken';
  end if;

  -- 1) profiles 에 내 계정이 없는 경우 자동 생성 보장 (FK 에러 방지)
  insert into public.profiles (id, display_name)
  values (auth.uid(), '회원')
  on conflict (id) do nothing;

  -- 2) slug 및 무작위 8자리 join_code 생성
  new_slug := 't' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  new_code := upper(substr(md5(gen_random_uuid()::text), 1, 4) || '-' || substr(md5(gen_random_uuid()::text), 5, 4));

  -- 3) teams 추가
  insert into public.teams(name, slug, join_code)
  values (btrim(team_name), new_slug, new_code)
  returning public.teams.id into new_id;

  -- 4) team_members 추가 (팀장 권한 부여)
  insert into public.team_members(team_id, user_id, is_admin)
  values (new_id, auth.uid(), true)
  on conflict (team_id, user_id) do update set is_admin = true;

  return query
    select t.id, t.name, t.slug, t.join_code
    from public.teams t
    where t.id = new_id;
end
$$;

grant execute on function public.create_team(text) to authenticated;
