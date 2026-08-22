-- ═══════════════════════════════════════════════════════════════
-- 당동 캘린더 [3/4] 집계 함수 vote_counts
--
-- 1-tables.sql 을 먼저 실행하세요. 여러 번 실행해도 안전합니다.
-- ※ 집계 규칙이 바뀔 때 다시 돌리는 파일은 대개 이것 하나입니다.
--
--    날짜별 O/X 인원수 + 시간대별 인원수 + 일정 이름별 인원수.
--    전부 '몇 명'까지만 나간다. user_id 는 이 함수 밖으로 절대 나가지 않으므로
--    시간과 일정 이름을 공개해도 누가 썼는지는 여전히 알 수 없다.
--    SECURITY DEFINER 라 RLS를 우회하므로, 팀원인지는 함수 안에서 직접 확인한다.
--
--    hours   : [[0,4],[1,5],[2,2]]    → 오전 4명, 오후 5명, 저녁 2명 가능
--                                        (0=오전 1=오후 2=저녁. 예전엔 시(時)별이었는데
--                                         앱이 세 토막으로 바뀌면서 같이 토막 단위가 됐다)
--    reasons : [["시험기간",3],...]   → 그 날 이 일정이 걸린 사람이 3명 (불가 표와는 무관)
--
--    반환 타입이 바뀌면 CREATE OR REPLACE 가 막히므로 먼저 지운다.
-- ═══════════════════════════════════════════════════════════════

do $$
declare missing text := '';
begin
  if to_regclass('public.day_votes') is null then missing := missing || ' day_votes'; end if;
  if to_regclass('public.day_plans') is null then missing := missing || ' day_plans'; end if;
  if missing <> '' then
    raise exception '먼저 1-tables.sql 을 실행해 주세요. 없는 표:% (search_path=%)',
                    missing, current_setting('search_path');
  end if;
end $$;

drop function if exists public.vote_counts(uuid, date, date);

create or replace function public.vote_counts(t uuid, d1 date, d2 date)
returns table(vote_date date, o_cnt integer, x_cnt integer, hours jsonb, reasons jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with mem as (select public.is_member_of(t) as ok),   -- 팀원이 아니면 아래가 전부 빈 결과
  -- 등록된 일정을 날짜별로 펼친다. O/X 인원과는 무관하다 — '그 날 걸려 있는 일정' 목록에만 쓴다.
  -- (일정은 개인 메모일 뿐 참석 여부가 아니다. 못 오면 ❌ 를 따로 누른다.)
  plan_days as (
    select g::date as vote_date, p.user_id, btrim(p.name) as reason
    from public.day_plans p
         cross join lateral generate_series(greatest(p.start_date, d1),
                                            least(p.end_date, d2), interval '1 day') g
    where p.team_id = t and p.start_date <= d2 and p.end_date >= d1
      and (select ok from mem)
  ),
  -- 가능/불가 인원은 오직 표(day_votes)로만 센다.
  -- slots 이 없는 예전 기록은 from_hour~to_hour 와 겹치는 토막으로 환산한다. 시간을 아예
  -- 안 적었던 표('무관')는 아무 때나 된다는 뜻이었으므로 세 토막 전부(7)로 본다.
  mine as (
    select v.vote_date, v.choice, v.user_id,
           coalesce(v.slots,
             case when v.from_hour is null then 7
                  else (case when v.from_hour < 12 and v.to_hour >  6 then 1 else 0 end)
                     + (case when v.from_hour < 18 and v.to_hour > 12 then 2 else 0 end)
                     + (case when v.from_hour < 24 and v.to_hour > 18 then 4 else 0 end)
             end) as slots
    from public.day_votes v
    where v.team_id = t
      and v.vote_date >= d1
      and v.vote_date <= d2
      and (select ok from mem)
  ),
  -- 토막별 가능 인원. 한 사람이 여러 토막을 고르면 고른 토막마다 한 번씩 센다.
  hrs as (
    select m.vote_date, s.i as h, count(distinct m.user_id)::int as cnt
    from mine m
         cross join (values (0, 1), (1, 2), (2, 4)) as s(i, bit)
    where m.choice = 'o' and (m.slots & s.bit) <> 0
    group by m.vote_date, s.i
  ),
  -- 그 날 걸려 있는 일정 이름별 인원수 (이름만 나가고 누구인지는 나가지 않는다)
  rsn as (
    select pd.vote_date, pd.reason, count(distinct pd.user_id)::int as cnt
    from plan_days pd
    group by pd.vote_date, pd.reason
  ),
  -- 표가 하나도 없고 일정만 걸린 날도 행이 나가야 일정 목록이 보인다 → 날짜 축을 합쳐 둔다
  days as (
    select m.vote_date from mine m
    union
    select pd.vote_date from plan_days pd
  )
  -- 한 사람이 같은 날 표를 하나만 갖지만, 방어적으로 distinct user_id 로 센다.
  select d.vote_date,
         (select count(distinct m.user_id) from mine m
           where m.vote_date = d.vote_date and m.choice = 'o')::integer,
         (select count(distinct m.user_id) from mine m
           where m.vote_date = d.vote_date and m.choice = 'x')::integer,
         coalesce((select jsonb_agg(jsonb_build_array(h.h, h.cnt) order by h.h)
                     from hrs h where h.vote_date = d.vote_date), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_array(r.reason, r.cnt) order by r.cnt desc, r.reason)
                     from rsn r where r.vote_date = d.vote_date), '[]'::jsonb)
  from days d
$$;
grant execute on function public.vote_counts(uuid, date, date) to authenticated;

-- 함수를 새로 만들어도 API 쪽 캐시가 갱신되기 전에는 /rest/v1/rpc/vote_counts 가 404 로
-- 떨어진다. 그러면 "내 표는 저장되는데 남의 표가 안 보이는" 증상이 된다.
notify pgrst, 'reload schema';

do $$ begin raise notice '[3/4] vote_counts 완료 — 다음은 4-plan-spans.sql'; end $$;
