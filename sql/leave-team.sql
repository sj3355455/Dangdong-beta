-- ═══════════════════════════════════════════════════════════════
-- 팀 나가기 (본인이 자기 소속을 스스로 해제)
-- Supabase SQL Editor에 붙여넣고 Run. 멱등(여러 번 실행 안전).
--
-- 규칙:
--  - 팀장이 나가는데 남은 팀원이 있으면 → 가장 먼저 가입한 팀원을 자동으로 새 팀장 승격
--    (팀이 팀장 없이 남는 것 방지)
--  - 팀원이 아무도 안 남으면 그냥 나간다(빈 팀으로 남음; 팀 삭제는 관리자 delete_team)
--  - 내가 그 팀 멤버가 아니면 조용히 무시
-- ═══════════════════════════════════════════════════════════════

create or replace function public.leave_team(p_team_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  am_leader boolean;
  others int;
begin
  select is_admin into am_leader
    from public.team_members
    where team_id = p_team_id and user_id = auth.uid();
  if not found then
    return;   -- 멤버가 아니면 아무것도 안 함
  end if;

  select count(*) into others
    from public.team_members
    where team_id = p_team_id and user_id <> auth.uid();

  -- 팀장이 나가는데 남은 팀원이 있으면: 최고참(먼저 가입)을 새 팀장으로 승격
  if am_leader and others > 0 then
    update public.team_members
      set is_admin = true
      where team_id = p_team_id
        and user_id = (
          select user_id from public.team_members
          where team_id = p_team_id and user_id <> auth.uid()
          order by joined_at asc nulls last
          limit 1
        );
  end if;

  delete from public.team_members
    where team_id = p_team_id and user_id = auth.uid();
end
$$;

grant execute on function public.leave_team(uuid) to authenticated;
