-- ═══════════════════════════════════════════════════════════════
-- 유령 계정 청소 + 프로필 삭제 시 auth.users 자동 삭제 트리거
-- Supabase SQL Editor에 붙여넣고 Run 하세요. 멱등(여러 번 실행 안전).
--
-- admin-setup.sql 을 먼저 실행해 두세요 (is_admin 함수가 필요합니다).
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_admin'
  ) then
    raise exception '먼저 admin-setup.sql 을 실행해 주세요. (is_admin 함수가 없습니다)';
  end if;
end $$;

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
--
-- ★ 이 함수는 앱에서 부르지 않는다. 관리자가 SQL Editor 에서 손으로 돌리는 청소 도구다.
--   security definer 라 auth.users 를 지울 수 있으므로, 부를 수 있는 사람을 좁히는 게
--   함수 본문만큼 중요하다. 아래 두 겹으로 막는다:
--     · 본문에서 is_admin() 확인 — 관리자가 아니면 한 줄도 지우지 않는다
--     · 실행 권한 회수      — PostgREST 로 아예 부르지 못하게 한다
--   (postgres 는 두 검사 모두 우회하므로 SQL Editor 에서는 그대로 돌아간다)
create or replace function public.cleanup_ghost_users()
returns integer
language plpgsql security definer set search_path = public, auth
as $$
declare deleted_count integer;
begin
  if not (public.is_admin() or current_user in ('postgres', 'supabase_admin')) then
    raise exception 'not_authorized';
  end if;

  with deleted as (
    delete from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id)
    returning u.id
  )
  select count(*) into deleted_count from deleted;
  return deleted_count;
end;
$$;

-- 새로 만든 함수는 EXECUTE 가 PUBLIC 에 기본으로 열린다 → 명시적으로 걷어낸다.
-- (앞 버전에서 authenticated 에 준 권한도 여기서 함께 사라진다)
revoke all on function public.cleanup_ghost_users() from public, anon, authenticated;

-- 기존 유령 계정 즉시 청소 실행
select public.cleanup_ghost_users();
