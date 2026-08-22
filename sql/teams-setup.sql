-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 소속 팀(Team) — Phase 1: 스키마 + 기존 데이터 백필
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- 이 단계는 "동작 불변"이 목표입니다. 테이블만 만들고 기존 회원·게임을
-- 전부 '당동' 팀으로 귀속시킵니다. 앱 동작은 그대로이며, 이후 앱 코드에서
-- 팀 필터를 켜기 위한 밑작업입니다. (RLS 팀 격리는 이후 단계에서 별도 적용)
-- ═══════════════════════════════════════════════════════════════

-- 1) 팀 테이블
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,               -- 표시 이름  "당구동아리 당동"
  slug text unique,                 -- 짧은 키    "dangdong"
  join_code text not null unique,   -- 합류 코드  "DANG-0001"
  created_at timestamptz default now()
);

-- 2) 사람 ↔ 팀 (N:N). 한 사람이 여러 팀에 소속될 수 있다.
create table if not exists public.team_members (
  team_id  uuid not null references public.teams(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  is_admin boolean not null default false,   -- 팀별 관리자
  joined_at timestamptz default now(),
  primary key (team_id, user_id)
);

create index if not exists team_members_user_idx on public.team_members(user_id);

-- 3) 게임에 소속 팀 컬럼 (지금은 NULL 허용 — 백필 후 코드가 항상 채우게 되면 NOT NULL로 전환)
alter table public.games add column if not exists team_id uuid references public.teams(id);
create index if not exists games_team_idx on public.games(team_id);

-- ─────────────────────────────────────────────────────────────
-- 백필: 기존 회원·게임을 전부 '당동' 팀으로
-- ─────────────────────────────────────────────────────────────

-- 4) 당동 팀 생성 (이미 있으면 건너뜀)
insert into public.teams (name, slug, join_code)
values ('당구동아리 당동', 'dangdong', 'DANG-0001')
on conflict (slug) do nothing;

-- 5) 기존 회원 전원을 당동 멤버로. 전역 is_admin을 팀 관리자로 승계.
insert into public.team_members (team_id, user_id, is_admin)
select (select id from public.teams where slug = 'dangdong'),
       p.id,
       coalesce(p.is_admin, false)
from public.profiles p
on conflict (team_id, user_id) do nothing;

-- 6) 소속이 없는 기존 게임을 전부 당동으로
update public.games
set team_id = (select id from public.teams where slug = 'dangdong')
where team_id is null;

-- ─────────────────────────────────────────────────────────────
-- 확인용 (선택): 주석 풀고 실행
-- ─────────────────────────────────────────────────────────────
-- select name, slug, join_code from public.teams;
-- select count(*) as members from public.team_members;
-- select count(*) as games_without_team from public.games where team_id is null;  -- 0 이어야 정상

-- ═══════════════════════════════════════════════════════════════
-- 다음 팀을 만들 때 (수동 발급 예시):
--   insert into public.teams (name, slug, join_code)
--   values ('○○ 당구모임', 'other', 'OTHR-1234');
-- 부원에게 join_code 'OTHR-1234' 를 공유하면, 가입 화면에서 그 코드로 합류.
-- (가입 화면의 초대 코드 입력은 Phase 2·3 코드에서 구현)
-- ═══════════════════════════════════════════════════════════════
