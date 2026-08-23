-- ═══════════════════════════════════════════════════════════════
-- Edge Function 이 읽을 표에 관리 권한(service_role) 붙이기
--
-- Supabase → SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전합니다.
--
-- 왜 필요한가:
--   service_role 은 RLS(어느 '행'을 볼 수 있나)를 통과하는 열쇠지만,
--   그 앞에 있는 테이블 권한(이 '표'를 만질 수 있나)까지 건너뛰지는 않는다.
--   이 프로젝트는 새 표를 만들 때 권한이 자동으로 붙지 않는 설정이라,
--   여기서 손으로 채워 줘야 한다. 이게 없으면 Edge Function 이
--   'permission denied for table team_members' 로 멈춘다.
--
-- 무엇이 열리나: 알림을 보내는 데 꼭 필요한 것만.
--   · team_members / profiles          → 누구에게 보낼지 정하고 이름을 붙이려고 (읽기만)
--   · push_subscriptions_beta          → 보낼 주소 읽기 + 만료된 주소 정리(삭제)
--   · meetups / meetup_rsvps           → 모임 내용 읽기
--   service_role 키는 Edge Functions 의 Secrets 안에만 있고 앱에는 없다.
-- ═══════════════════════════════════════════════════════════════

grant select on public.team_members            to service_role;
grant select on public.teams                   to service_role;
grant select on public.profiles                to service_role;
grant select on public.meetups                 to service_role;
grant select on public.meetup_rsvps            to service_role;
grant select, delete on public.push_subscriptions_beta to service_role;

-- 앞으로 만들 표에도 자동으로 붙게 해 둔다 — 같은 일로 또 막히지 않도록
alter default privileges in schema public
  grant select on tables to service_role;

do $$
declare missing text := '';
begin
  if not has_table_privilege('service_role', 'public.team_members', 'select')
    then missing := missing || ' team_members'; end if;
  if not has_table_privilege('service_role', 'public.profiles', 'select')
    then missing := missing || ' profiles'; end if;
  if not has_table_privilege('service_role', 'public.push_subscriptions_beta', 'select')
    then missing := missing || ' push_subscriptions_beta'; end if;
  if missing = '' then
    raise notice '관리 권한을 붙였습니다. 이제 알림 발송이 표를 읽을 수 있습니다.';
  else
    raise warning '아직 권한이 없는 표:%', missing;
  end if;
end $$;
