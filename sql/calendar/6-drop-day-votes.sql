-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [6] 날짜별 참/불참(day_votes) 걷어내기
--
-- ⚠️ 되돌릴 수 없습니다. 지금까지 쌓인 날짜별 O/X 표가 전부 사라집니다.
--    5-meetups.sql 을 먼저 실행하고, 새 모임 투표가 잘 도는 걸 확인한 뒤에 돌리세요.
--
-- 왜 지우나:
--   날짜마다 "그날 되나요?"를 칠해 두는 방식은 날짜만 모을 뿐 약속을 만들지 못했다.
--   모임 투표(meetups)가 그 자리를 대신하므로, 두 벌을 나란히 두면 어느 쪽이
--   진짜인지 헷갈리기만 한다. 앱에서 이미 이 표를 읽지도 쓰지도 않는다.
--
-- 남는 것: club_events(정기전) · day_plans(개인 일정) · plan_spans() 는 그대로다.
-- ═══════════════════════════════════════════════════════════════

-- 집계 함수를 먼저 지운다 (표를 참조하고 있다)
drop function if exists public.vote_counts(uuid, date, date);

-- 표 — 정책·인덱스는 표가 사라질 때 같이 사라진다
drop table if exists public.day_votes;

do $$
begin
  if to_regclass('public.day_votes') is null then
    raise notice 'day_votes 를 걷어냈습니다. 이제 모임 투표(meetups)만 씁니다.';
  else
    raise warning 'day_votes 가 아직 남아 있습니다 — 참조하는 것이 있는지 확인해 주세요.';
  end if;
end $$;
