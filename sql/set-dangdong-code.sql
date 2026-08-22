-- ═══════════════════════════════════════════════════════════════
-- '당구동아리 당동' 팀 초대 코드를 'DKUMED'로 설정하는 SQL
-- Supabase SQL Editor에 붙여넣고 Run 하세요.
-- ═══════════════════════════════════════════════════════════════

-- 1) '당구동아리 당동' 팀의 초대 코드를 'DKUMED'로 변경
update public.teams
set join_code = 'DKUMED'
where name like '%당동%' or slug = 'dangdong';

-- 2) 모든 회원에게 해당 팀 팀장 권한 부여 (필요 시)
-- update public.team_members set is_admin = true where team_id = (select id from public.teams where slug = 'dangdong');

-- 변경 결과 확인
select id, name, slug, join_code from public.teams where join_code = 'DKUMED';
