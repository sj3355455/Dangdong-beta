-- ═══════════════════════════════════════════════════════════════
-- 수지(handicap) 변경 이력
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- profiles.handicap 은 '현재 값' 하나뿐이라 "지난달 80 → 이번달 100" 같은
-- 변화를 뽑을 수가 없다. 그래서 바뀔 때마다 한 줄씩 남기는 이력 테이블을 둔다.
-- 기록실 홈 탭의 '수지 상승' 카드가 이 테이블을 읽는다.
--
-- 쓰기는 오직 트리거(security definer)만 한다 — 앱에는 select 권한만 준다.
-- ═══════════════════════════════════════════════════════════════

-- 1) 이력 테이블
create table if not exists public.handicap_history (
  id           bigint generated always as identity primary key,
  player_id    uuid not null references public.profiles(id) on delete cascade,
  old_handicap integer,          -- 바뀌기 전 값 (첫 기록이면 null)
  new_handicap integer,          -- 바뀐 후 값 (수지를 지우면 null)
  changed_at   timestamptz not null default now()
);

create index if not exists handicap_history_player_time_idx
  on public.handicap_history (player_id, changed_at desc);

-- 2) 기록 트리거
--    security definer — 앱 계정에 insert 권한이 없어도 이력은 항상 남는다.
--    rename_player() 로 수지를 바꿔도 이 트리거를 거치므로 따로 손댈 필요 없다.
create or replace function public.log_handicap_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- 가입 시 수지를 넣은 경우만 시작점을 남긴다 (old = null → '상승'으로 세지 않는다)
    if new.handicap is not null then
      insert into public.handicap_history (player_id, old_handicap, new_handicap)
      values (new.id, null, new.handicap);
    end if;
  -- update of handicap 은 값이 그대로여도 발동한다 → 실제로 달라졌을 때만 남긴다
  elsif new.handicap is distinct from old.handicap then
    insert into public.handicap_history (player_id, old_handicap, new_handicap)
    values (new.id, old.handicap, new.handicap);
  end if;
  return null;   -- after 트리거라 반환값은 쓰이지 않는다
end
$$;

drop trigger if exists trg_log_handicap_change on public.profiles;
create trigger trg_log_handicap_change
  after insert or update of handicap on public.profiles
  for each row execute function public.log_handicap_change();

-- 3) 권한 — 누구나 읽기, 아무도 직접 쓰기 못함 (트리거만 씀)
alter table public.handicap_history enable row level security;

drop policy if exists "public read handicap_history" on public.handicap_history;
create policy "public read handicap_history" on public.handicap_history
  for select using (true);

grant select on public.handicap_history to anon;
grant select on public.handicap_history to authenticated;

-- 4) 1회 백필 — 지금 수지가 있는 회원의 '시작점'을 한 줄씩 넣는다.
--    과거 변경분은 남아 있지 않으므로 old_handicap 은 null 이다
--    (= 홈 탭의 상승 카드에는 잡히지 않는다. 이번 실행 이후의 변경부터 카드가 뜬다.)
insert into public.handicap_history (player_id, old_handicap, new_handicap, changed_at)
select p.id, null, p.handicap, now()
  from public.profiles p
 where p.handicap is not null
   and not exists (select 1 from public.handicap_history h where h.player_id = p.id);

-- 확인(선택):
-- select p.display_name, h.old_handicap, h.new_handicap, h.changed_at
--   from public.handicap_history h join public.profiles p on p.id = h.player_id
--  order by h.changed_at desc limit 20;
