-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 — 경기를 정기전에 붙이기 (games.event_id)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- calendar/ 의 1~4 를 먼저 실행한 뒤에 돌려야 합니다.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- 왜 필요한가:
--   기록실은 지금까지 played_at 날짜 범위로만 걸렀다. 그래서 "정기전 날에 낀
--   정기전 아닌 경기 하나"를 빼낼 방법이 없었다. 경기를 날짜가 아니라 정기전
--   자체(club_events)에 붙이면 그 한 경기만 소속을 비우면 된다.
--
-- 누가 채우는가:
--   점수판이 경기를 저장할 때 그 날 정기전이 등록돼 있으면 자동으로 넣는다.
--   (예외 경기는 점수판 메뉴에서 '정기전 기록: 제외'로 바꾸고 치면 된다)
--   이미 저장된 경기는 기록실 → 경기 상세 → 관리자 메뉴에서 고친다.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 0) 선행 조건 검사
--    SQL Editor 는 스크립트 전체를 한 트랜잭션으로 돌린다. 뒤에서 실패하면 앞의 것까지
--    전부 롤백되므로, 의존하는 것이 있는지 먼저 확인하고 없으면 읽을 수 있게 멈춘다.
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.club_events') is null then
    raise exception '먼저 calendar/1-tables.sql 을 실행해 주세요. (club_events 테이블이 없습니다)';
  end if;
  if to_regclass('public.games') is null then
    raise exception 'games 테이블이 없습니다. 기본 스키마부터 확인해 주세요.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 1) 컬럼 추가
--    on delete set null: 정기전을 캘린더에서 지워도 경기 기록은 남는다.
--    그 경기는 '일반 경기'로 떨어질 뿐이다. (기록이 사라지면 안 되므로 cascade 금지)
-- ─────────────────────────────────────────────────────────────
alter table public.games
  add column if not exists event_id uuid references public.club_events(id) on delete set null;

create index if not exists games_event_idx on public.games(event_id);

-- 팀 + 정기전으로 거르는 게 기록실의 기본 조회라 복합 인덱스도 같이 둔다.
create index if not exists games_team_event_idx on public.games(team_id, event_id);

-- ─────────────────────────────────────────────────────────────
-- 2) 권한
--    insert 는 이미 authenticated 전체에 열려 있다(admin-setup.sql). 컬럼 단위
--    GRANT 를 쓰고 있지 않으므로 event_id 도 그대로 넣을 수 있다.
--    update 는 여전히 관리자만 (admin update games 정책). 즉 부원은 저장할 때
--    한 번 정하고, 잘못 들어간 건 관리자가 기록실에서 고친다.
-- ─────────────────────────────────────────────────────────────
-- (추가 GRANT 불필요 — 확인용으로만 남겨둠)

-- ─────────────────────────────────────────────────────────────
-- 3) 백필 — 기존 경기를 같은 팀·같은 날 정기전에 붙인다
--
--    자정 넘김 처리: 당구는 밤에 친다. 새벽 1시에 끝난 경기는 played_at 날짜가
--    다음날이라 그대로 날짜를 맞추면 정기전에서 빠진다. 그래서 5시간을 뺀 뒤
--    날짜를 뽑는다 → 새벽 5시 이전 경기는 전날 정기전으로 간다.
--
--    시간대: played_at 은 timestamptz(UTC 저장)다. 한국시간으로 바꾼 뒤 계산해야
--    날짜가 9시간 어긋나지 않는다.
--
--    event_id 가 이미 있는 경기는 건드리지 않는다 → 다시 실행해도 사람이 손으로
--    고쳐 놓은 소속을 되돌리지 않는다.
-- ─────────────────────────────────────────────────────────────
update public.games g
set event_id = e.id
from public.club_events e
where g.event_id is null
  and g.team_id is not null
  and g.team_id = e.team_id
  and (((g.played_at at time zone 'Asia/Seoul') - interval '5 hours')::date) = e.event_date;

-- ─────────────────────────────────────────────────────────────
-- 4) PostgREST 스키마 캐시 갱신
--    컬럼을 추가해도 API 캐시가 갱신되기 전에는 select=...,event_id 가 400 으로
--    떨어진다. 앱에서 "기록을 불러오지 못했습니다"가 뜨면 이 줄만 다시 실행하세요.
-- ─────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────
-- 5) 자체 점검 + 결과 보고
-- ─────────────────────────────────────────────────────────────
do $$
declare
  linked   integer;
  unlinked integer;
  evts     integer;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'games'
                    and column_name = 'event_id') then
    raise exception 'event_id 컬럼이 만들어지지 않았습니다.';
  end if;

  select count(*) into linked   from public.games where event_id is not null;
  select count(*) into unlinked from public.games where event_id is null;
  select count(*) into evts     from public.club_events;

  raise notice '설치 완료 — 등록된 정기전 %개 / 정기전에 붙은 경기 %건 / 일반 경기 %건',
               evts, linked, unlinked;
  if evts = 0 then
    raise notice '주의: 등록된 정기전이 하나도 없습니다. 캘린더에서 정기전 날짜를 먼저 찍어주세요.';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════
-- 아래는 확인·수동 정정용. 필요할 때 주석을 풀고 실행하세요.
-- (보통은 기록실 → 경기 상세 → 관리자 메뉴에서 하는 게 편합니다)
-- ═══════════════════════════════════════════════════════════════

-- 정기전별로 몇 경기가 붙었는지
-- select e.event_date, e.round_no, count(g.id) as games
--   from public.club_events e
--   left join public.games g on g.event_id = e.id
--  group by e.id, e.event_date, e.round_no
--  order by e.event_date desc;

-- 특정 날짜(예: 2026-08-05)에 붙은 경기 목록 — 여기서 뺄 경기의 id 를 확인
-- select g.id,
--        (g.played_at at time zone 'Asia/Seoul') as played_kst,
--        (select string_agg(p->>'name', ', ') from jsonb_array_elements(g.players) p) as players
--   from public.games g
--   join public.club_events e on e.id = g.event_id
--  where e.event_date = date '2026-08-05'
--  order by g.played_at;

-- 위에서 고른 경기를 정기전에서 빼기 (일반 경기로)
-- update public.games set event_id = null where id = '여기에-경기-id';
