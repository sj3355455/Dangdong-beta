-- ═══════════════════════════════════════════════════════════════
-- 당동 — 팀 격리 마무리 (games · profiles · handicap_history)
--
-- teams-rls.sql 의 마지막 줄에 남아 있던 숙제를 여기서 끝낸다:
--   "(games/profiles 격리 RLS는 이후 단계에서 별도 적용)"
--
-- 지금까지 이 세 표는 초기 '동아리 하나' 시절 정책(using (true))이 그대로였다.
-- 앱은 team_id=eq.<우리팀> 으로만 물어보니 화면에는 남의 팀이 안 나왔지만,
-- 그건 클라이언트가 걸러 준 것일 뿐 서버가 막은 게 아니다. anon 키는 앱 번들에
-- 공개돼 있으므로(정상 설계) 조건만 빼고 부르면 전부 읽혔다.
--
-- 실행 전 상태(2026-08-21 확인) — 비로그인 anon 키로 조회한 결과:
--   games             36행 / 서로 다른 팀 3개   ← 노출
--   profiles          22행 / 실명 포함          ← 노출
--   handicap_history  20행                      ← 노출
--   teams · team_members · club_events · day_votes · day_plans  ← 이미 차단됨
--
-- 여러 번 실행해도 안전하다(멱등). 맨 아래 자체 점검이 통과하면 끝.
-- 되돌리려면 admin-setup.sql 과 handicap-history.sql 을 다시 실행하면 된다.
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 0) 먼저 있어야 하는 것들
-- ─────────────────────────────────────────────────────────────
do $$
declare missing text := '';
begin
  if to_regclass('public.team_members') is null then missing := missing || ' team_members'; end if;
  if to_regclass('public.games')        is null then missing := missing || ' games';        end if;
  if to_regclass('public.profiles')     is null then missing := missing || ' profiles';     end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_member_of')
    then missing := missing || ' is_member_of(teams-rls.sql)'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_admin')
    then missing := missing || ' is_admin(admin-setup.sql)'; end if;
  if missing <> '' then
    raise exception '먼저 실행해야 할 것이 있습니다:% (search_path=%)', missing, current_setting('search_path');
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 1) 헬퍼 — "이 사람이 나와 같은 팀인가"
--
-- profiles·handicap_history 는 team_id 열이 없다. 사람(user_id)으로 걸러야 해서
-- '나와 팀을 하나라도 공유하는가'를 묻는 함수를 둔다.
--
-- SECURITY DEFINER 인 이유: 정책 안에서 team_members 를 읽는데, 그 표에도 RLS 가
-- 걸려 있어 그냥 읽으면 정책이 서로를 물고 늘어진다(재귀). is_member_of 와 같은 이유.
--
-- 본인은 항상 통과시킨다 — 가입 직후 팀에 들어가기 전에도 자기 프로필은 읽어야 한다.
-- ─────────────────────────────────────────────────────────────
create or replace function public.shares_team_with(p uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p = auth.uid() or exists (
    select 1
    from public.team_members me
    join public.team_members other on other.team_id = me.team_id
    where me.user_id = auth.uid()
      and other.user_id = p
  )
$$;
grant execute on function public.shares_team_with(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2) games — 내 팀 경기만
--
-- 읽기: 팀원이거나 사이트 관리자. 관리자를 넣는 이유는 기록실의 경기 수정·삭제가
--       is_admin() 기준인데, 애초에 안 보이면 고칠 수도 없기 때문이다.
-- 쓰기: 팀원만. 예전 정책은 with check (true) 라 로그인만 하면 아무 팀 team_id 로나
--       경기를 밀어 넣을 수 있었다.
-- ─────────────────────────────────────────────────────────────
alter table public.games enable row level security;

drop policy if exists "public read games" on public.games;
drop policy if exists "read team games"   on public.games;
create policy "read team games" on public.games
  for select using (public.is_member_of(team_id) or public.is_admin());

drop policy if exists "auth insert games"  on public.games;
drop policy if exists "insert team games"  on public.games;
create policy "insert team games" on public.games
  for insert to authenticated with check (public.is_member_of(team_id));

-- 비로그인에게는 표 자체를 닫는다 (정책 이전 단계에서 차단 → 0행이 아니라 권한 오류)
revoke select on public.games from anon;

-- ─────────────────────────────────────────────────────────────
-- 3) profiles — 같은 팀 사람 + 나 자신
--
-- 앱이 프로필을 읽는 경로는 셋뿐이고 모두 이 정책을 통과한다:
--   · team_members?select=profiles(...)&team_id=eq.<우리팀>   (점수판·기록실 명단)
--   · profiles?select=is_admin&id=eq.<나>                      (내 관리자 여부)
--   · profiles?select=id,display_name,...&order=display_name   (관리자 화면 → is_admin())
-- ─────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

drop policy if exists "public read profiles" on public.profiles;
drop policy if exists "read team profiles"   on public.profiles;
create policy "read team profiles" on public.profiles
  for select using (public.shares_team_with(id) or public.is_admin());

revoke select on public.profiles from anon;

-- ─────────────────────────────────────────────────────────────
-- 4) handicap_history — 같은 팀 사람의 수지 이력만
--
-- 이 표에는 team_id 가 없다. 기록실도 팀 필터 없이 전부 받아 와서 소속 팀 회원으로
-- 걸러 쓰고 있었다(record/app.js 의 fetchHandicapHistory 주석). 이제 서버가 거른다.
-- 쓰기 권한은 원래부터 없다 — profiles 트리거만 이 표에 쓴다.
-- ─────────────────────────────────────────────────────────────
alter table public.handicap_history enable row level security;

drop policy if exists "public read handicap_history"    on public.handicap_history;
drop policy if exists "read team handicap_history"      on public.handicap_history;
create policy "read team handicap_history" on public.handicap_history
  for select using (public.shares_team_with(player_id) or public.is_admin());

revoke select on public.handicap_history from anon;

-- ─────────────────────────────────────────────────────────────
-- 5) 남아 있는 '전체 공개' 정책 쓸어내기
--
-- 위에서는 이 레포의 SQL 파일에 적힌 이름만 지웠다. 그런데 정책은 대시보드에서도
-- 만들 수 있고 Supabase 기본 템플릿은 "Enable read access for all users" 같은
-- 다른 이름을 쓴다. 정책은 OR 로 합쳐지므로 using (true) 가 하나라도 남으면
-- 위에서 건 팀 조건이 통째로 무의미해진다 → 이름이 아니라 '내용'으로 찾아 지운다.
--
-- 지우는 대상은 SELECT 정책으로 한정한다. 바로 위에서 대체 정책을 이미 만들어 뒀으므로
-- 표가 읽기 불가 상태로 남는 일은 없다. 반면 ALL(쓰기까지 포함) 정책은 함부로 지우면
-- 저장이 막힐 수 있어, 지우지 않고 이름만 알려 주고 멈춘다.
-- ─────────────────────────────────────────────────────────────
do $$
declare
  r record;
  keep text[] := array['read team games','read team profiles','read team handicap_history'];
  blanket text := '';
begin
  for r in
    select tablename, policyname, cmd
      from pg_policies
     where schemaname = 'public'
       and tablename in ('games','profiles','handicap_history')
       and permissive = 'PERMISSIVE'
       and not (policyname = any(keep))
       -- 읽기를 여는 정책만 본다. INSERT 정책은 조건이 qual 이 아니라 with_check 에 있어
       -- qual 이 NULL 인데, 그걸 '조건 없음'으로 오해하면 멀쩡한 쓰기 정책까지 걸린다.
       and cmd in ('SELECT','ALL')
       and qual is not null
       -- 공백·괄호를 지워 'true' / '( true )' 같은 표기 차이를 흡수한다
       and regexp_replace(qual, '[\s()]', '', 'g') = 'true'
  loop
    if r.cmd = 'SELECT' then
      raise notice '전체 공개 읽기 정책을 지웁니다 — %.% : "%"', 'public', r.tablename, r.policyname;
      execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    elsif r.cmd = 'ALL' then
      blanket := blanket || format(E'\n  · %s : "%s"  (cmd=ALL)', r.tablename, r.policyname);
    end if;
  end loop;

  if blanket <> '' then
    raise exception E'읽기·쓰기를 한꺼번에 전체 허용하는 정책이 남아 있습니다:%\n지우면 저장이 막힐 수 있어 자동으로 건드리지 않았습니다. 확인 후 직접 지우거나 조건을 붙이고 다시 실행해 주세요.', blanket;
  end if;
end $$;

-- PostgREST 스키마 캐시 갱신 — 새 함수(shares_team_with)를 곧바로 알아보게 한다.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────
-- 5) 자체 점검
--
-- ⚠️ SQL Editor 는 service_role 이라 RLS 를 통째로 우회한다. 그래서 여기서는
--    "정책과 권한이 의도대로 걸렸는가"만 본다. 실제 차단 확인은 아래 6) 참고.
-- ─────────────────────────────────────────────────────────────
do $$
declare bad text := '';
begin
  -- anon 에게 select 권한이 남아 있으면 안 된다 (어느 표인지까지 알려 준다)
  bad := bad || coalesce((
    select string_agg(format(E'\n  · anon 에게 %s 읽기 권한이 남아 있음', table_name), '')
      from information_schema.role_table_grants
     where grantee = 'anon' and privilege_type = 'SELECT'
       and table_schema = 'public'
       and table_name in ('games','profiles','handicap_history')), '');

  -- 조건 없이 읽기를 여는 정책이 남아 있으면 안 된다
  -- (INSERT 정책은 조건이 with_check 에 있어 qual 이 NULL 이다 → 읽기 정책만 본다)
  bad := bad || coalesce((
    select string_agg(format(E'\n  · %s 에 전체 공개 읽기 정책 "%s" (cmd=%s) 남아 있음',
                             tablename, policyname, cmd), '')
      from pg_policies
     where schemaname = 'public'
       and tablename in ('games','profiles','handicap_history')
       and permissive = 'PERMISSIVE'
       and cmd in ('SELECT','ALL')
       and qual is not null
       and regexp_replace(qual, '[\s()]', '', 'g') = 'true'), '');

  -- 세 표 모두 RLS 가 켜져 있어야 한다
  bad := bad || coalesce((
    select string_agg(format(E'\n  · %s 의 RLS 가 꺼져 있음', c.relname), '')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('games','profiles','handicap_history')
       and not c.relrowsecurity), '');

  if bad <> '' then
    raise exception E'격리가 덜 됐습니다:%\n위 항목을 정리한 뒤 이 파일을 다시 실행해 주세요.', bad;
  end if;
  raise notice '팀 격리 완료 — games / profiles / handicap_history 모두 팀 단위로 잠갔습니다.';
end $$;

-- ─────────────────────────────────────────────────────────────
-- 6) 진짜 확인은 브라우저에서 (SQL Editor 로는 검증되지 않는다)
--
-- 아무 페이지에서나 개발자도구 콘솔에 붙여 넣고 실행. 셋 다 401 이면 성공.
--
--   const U='https://ezwassqurbmzcjfmtjop.supabase.co', K='<앱의 anon 키>';
--   for (const t of ['games','profiles','handicap_history']) {
--     const r = await fetch(`${U}/rest/v1/${t}?select=*&limit=5`, { headers:{ apikey:K } });
--     console.log(t, r.status, await r.json());
--   }
--
-- 그리고 앱에 로그인해서 점수판 명단 · 기록실 순위 · 홈 탭 수지 카드가 그대로
-- 나오는지 한 번 훑어 주세요.
-- ═══════════════════════════════════════════════════════════════
