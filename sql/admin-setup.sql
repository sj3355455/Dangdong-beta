-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 관리자 기능 설정 SQL
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다 (멱등).
-- ═══════════════════════════════════════════════════════════════

-- 1) 관리자 플래그 컬럼
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- 2) 관리자 판별 함수 (RLS 정책 안에서 재귀 없이 사용)
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- 3) RLS 활성화 + 기본 정책 (기존 앱 동작 유지: 누구나 읽기, 로그인 사용자 쓰기)
alter table public.games enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "public read games" on public.games;
create policy "public read games" on public.games
  for select using (true);

drop policy if exists "auth insert games" on public.games;
create policy "auth insert games" on public.games
  for insert to authenticated with check (true);

drop policy if exists "public read profiles" on public.profiles;
create policy "public read profiles" on public.profiles
  for select using (true);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

-- 3.5) 테이블 권한(GRANT): RLS 이전 단계의 기본 권한.
--      수정·삭제 허용 범위는 아래 RLS 정책이 제한한다.
grant select on public.games to anon;
grant select on public.profiles to anon;
grant select, insert, update, delete on public.games to authenticated;
grant select, insert on public.profiles to authenticated;
-- 프로필 수정은 이름·수지 컬럼만 허용 (is_admin은 SQL Editor에서만 변경 가능)
revoke update on public.profiles from authenticated;
grant update (display_name, handicap) on public.profiles to authenticated;

-- 3.6) 회원 본인 프로필 수정 허용 (기록실 '내 정보' 기능용)
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- 4) 관리자 전용 정책: 경기 수정·삭제, 선수 정보 수정
drop policy if exists "admin update games" on public.games;
create policy "admin update games" on public.games
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin delete games" on public.games;
create policy "admin delete games" on public.games
  for delete to authenticated using (public.is_admin());

drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 5) 관리자 지정 ★ 아래 이름을 본인 표시이름으로 바꾼 뒤 주석(--)을 풀고 실행
-- update public.profiles set is_admin = true where display_name = '홍길동';

-- 지정 확인:
-- select display_name, is_admin from public.profiles where is_admin;
