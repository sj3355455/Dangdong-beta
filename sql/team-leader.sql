-- ═══════════════════════════════════════════════════════════════
-- 팀장(team leader) 직책 + 권한 함수
-- Supabase SQL Editor에 붙여넣고 Run. 멱등(여러 번 실행 안전).
--
-- 팀장 = team_members.is_admin = true (팀별). 팀 생성자가 자동으로 팀장.
-- 팀장의 권한은 딱 두 가지로 제한한다:
--   1) 초대 코드 변경  → regenerate_join_code(team_id)
--   2) 팀원 내보내기    → remove_member(team_id, user_id)
-- 그 외 경기 수정·삭제·이름변경 같은 건 팀장에게 주지 않는다(전역 관리자만).
-- ═══════════════════════════════════════════════════════════════

-- 내가 이 팀의 팀장인가 (RLS 재귀 방지용 SECURITY DEFINER)
create or replace function public.is_team_leader(t uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.team_members
    where team_id = t and user_id = auth.uid() and is_admin
  )
$$;

-- 1) 초대 코드 변경 (팀장만). 새 코드를 반환.
create or replace function public.regenerate_join_code(p_team_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare new_code text;
begin
  if not public.is_team_leader(p_team_id) then raise exception 'not_authorized'; end if;
  new_code := upper(substr(md5(gen_random_uuid()::text), 1, 4) || '-' || substr(md5(gen_random_uuid()::text), 5, 4));
  update public.teams set join_code = new_code where id = p_team_id;
  return new_code;
end
$$;

-- 2) 팀원 내보내기 (팀장만). 팀장 본인은 못 내보낸다.
create or replace function public.remove_member(p_team_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_team_leader(p_team_id) then raise exception 'not_authorized'; end if;
  if p_user_id = auth.uid() then raise exception 'cannot_remove_self'; end if;
  delete from public.team_members where team_id = p_team_id and user_id = p_user_id;
end
$$;

-- 팀장이 자기 팀 초대 코드를 조회 (팀장만; 아니면 null)
create or replace function public.team_join_code(p_team_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select t.join_code from public.teams t
  where t.id = p_team_id and public.is_team_leader(p_team_id)
$$;

-- 3) 팀 이름 변경 (팀장만)
create or replace function public.rename_team(p_team_id uuid, new_name text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_team_leader(p_team_id) then raise exception 'not_authorized'; end if;
  if new_name is null or length(btrim(new_name)) = 0 then raise exception 'empty_name'; end if;
  if exists (select 1 from public.teams where lower(name) = lower(btrim(new_name)) and id <> p_team_id) then
    raise exception 'name_taken';
  end if;
  update public.teams set name = btrim(new_name) where id = p_team_id;
end
$$;

-- 4) 초대 코드 직접 지정 (팀장만). 다른 팀이 쓰는 코드면 거부.
create or replace function public.set_join_code(p_team_id uuid, new_code text)
returns text
language plpgsql security definer set search_path = public
as $$
declare code text;
begin
  if not public.is_team_leader(p_team_id) then raise exception 'not_authorized'; end if;
  code := upper(btrim(new_code));
  if code is null or length(code) = 0 then raise exception 'empty_code'; end if;
  if exists (select 1 from public.teams where join_code = code and id <> p_team_id) then
    raise exception 'code_taken';
  end if;
  update public.teams set join_code = code where id = p_team_id;
  return code;
end
$$;

grant execute on function public.is_team_leader(uuid) to authenticated;
grant execute on function public.rename_team(uuid, text) to authenticated;
grant execute on function public.set_join_code(uuid, text) to authenticated;
grant execute on function public.regenerate_join_code(uuid) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.team_join_code(uuid) to authenticated;
