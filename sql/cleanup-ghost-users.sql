-- ═══════════════════════════════════════════════════════════════
-- 유령 계정 청소 + 프로필 삭제 시 auth.users 자동 삭제 트리거
-- Supabase SQL Editor에 붙여넣고 Run 하세요. 멱등(여러 번 실행 안전).
-- ═══════════════════════════════════════════════════════════════

-- 1) 프로필 삭제 시 auth.users 자동 삭제 트리거 함수
create or replace function public.on_profile_deleted()
returns trigger
language plpgsql security definer set search_path = public, auth
as $$
begin
  delete from auth.users where id = old.id;
  return old;
end;
$$;

-- 2) 트리거 연결 (profiles 행 삭제 시 auth.users 도 같이 삭제)
drop trigger if exists tr_on_profile_deleted on public.profiles;
create trigger tr_on_profile_deleted
  after delete on public.profiles
  for each row execute function public.on_profile_deleted();

-- 3) 기존 유령 계정 일괄 청소 함수 (profiles 엔트리가 없는 auth.users 삭제)
create or replace function public.cleanup_ghost_users()
returns integer
language plpgsql security definer set search_path = public, auth
as $$
declare deleted_count integer;
begin
  with deleted as (
    delete from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id)
    returning u.id
  )
  select count(*) into deleted_count from deleted;
  return deleted_count;
end;
$$;

grant execute on function public.cleanup_ghost_users() to authenticated;

-- 기존 유령 계정 즉시 청소 실행
select public.cleanup_ghost_users();
