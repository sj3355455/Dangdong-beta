-- ═══════════════════════════════════════════════════════════════
-- 관리자 메뉴: 회원/소속팀 목록 조회 + 팀 삭제 RPC
-- Supabase SQL Editor에 붙여넣고 Run 하세요. 멱등(여러 번 실행 안전).
-- ═══════════════════════════════════════════════════════════════

-- 1) 전체 회원 및 소속 팀 목록 조회 (관리자 전용)
create or replace function public.admin_get_all_members()
returns table(
  user_id uuid,
  display_name text,
  handicap integer,
  teams jsonb
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_authorized';
  end if;

  return query
  select 
    p.id as user_id,
    p.display_name,
    p.handicap,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', t.id,
            'name', t.name,
            'join_code', t.join_code,
            'is_admin', tm.is_admin
          )
        )
        from public.team_members tm
        join public.teams t on t.id = tm.team_id
        where tm.user_id = p.id
      ),
      '[]'::jsonb
    ) as teams
  from public.profiles p
  order by p.display_name;
end;
$$;

grant execute on function public.admin_get_all_members() to authenticated;

-- 2) 팀 삭제 (관리자 또는 팀장)
create or replace function public.delete_team(p_team_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_team_leader(p_team_id)) then
    raise exception 'not_authorized';
  end if;
  delete from public.teams where id = p_team_id;
end;
$$;

grant execute on function public.delete_team(uuid) to authenticated;
