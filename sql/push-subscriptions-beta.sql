-- ── 웹 푸시 구독 저장소 (테스트 앱 전용) ────────────────────────────────
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행. 여러 번 실행해도 안전하다.
--
-- 이 표는 "어느 기기로 알림을 보낼지" 주소록이다. 앱에서 알림을 켜면 한 줄이 생기고,
-- 끄면 지워진다. 보내는 쪽(로컬 send.js)이 이 표를 읽어서 각 기기로 푸시를 쏜다.
--
-- 이름에 _beta 를 붙인 이유: 본 앱은 이 표를 쓰지 않는다. 테스트에서 뭘 하든
-- 다른 부원들이 쓰는 앱에는 영향이 없다는 걸 표 이름에서부터 분명히 해 둔다.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.push_subscriptions_beta (
  endpoint   text primary key,                 -- 기기 주소. 기기당 하나라 자연스러운 기본키가 된다
  p256dh     text not null,                    -- 페이로드 암호화용 공개키
  auth_key   text not null,                    -- 페이로드 암호화용 인증 시크릿 ("auth" 는 예약어라 _key)
  user_id    uuid,                             -- 누구 기기인지 메모용. auth.users 외래키는 일부러 안 건다(아래 설명)
  label      text,                             -- 기기 구분용 메모 (iPhone / Android …)
  scope      text,                             -- 구독이 만들어진 경로. 항상 /Dangdong-beta/... 여야 한다
  created_at timestamptz not null default now()
);

-- 앞 버전에서 auth.users 외래키를 걸어 뒀다면 떼어낸다.
-- 로그인 안 한 상태로 알림을 켜면 이 검사에서 auth 스키마 권한 문제로 막힌다.
-- 여기서 user_id 는 "어느 기기가 누구 것인지" 적어 두는 메모일 뿐이라 무결성 검사가 필요 없다.
alter table public.push_subscriptions_beta
  drop constraint if exists push_subscriptions_beta_user_id_fkey;

alter table public.push_subscriptions_beta enable row level security;

-- ★ 중요 — RLS 정책만으로는 부족하다.
-- 정책은 "어느 행을 만질 수 있나"를 정하는 것이고, 그 전에 "이 표를 만질 수 있나"라는
-- 테이블 권한(GRANT)이 따로 있어야 한다. 이게 없으면 앱에서 permission denied for table 이 뜬다.
-- service_role 도 함께 — 알림을 보내는 Edge Function 이 이 표를 읽는다.
-- RLS 를 통과하는 키라도 테이블 권한은 따로 있어야 한다.
grant select, insert, update, delete on public.push_subscriptions_beta to anon, authenticated, service_role;

-- 앱에서 알림을 켜고 끄는 동작(추가·갱신·삭제)은 로그인 없이도 되게 열어 둔다.
-- 베타 테스트용이라 이렇게 두는 것이고, 실서비스로 옮길 때는 authenticated 로 좁히고
-- user_id = auth.uid() 조건을 걸어야 한다.
drop policy if exists push_beta_insert on public.push_subscriptions_beta;
create policy push_beta_insert on public.push_subscriptions_beta for insert to anon, authenticated with check (true);

drop policy if exists push_beta_update on public.push_subscriptions_beta;
create policy push_beta_update on public.push_subscriptions_beta for update to anon, authenticated using (true) with check (true);

drop policy if exists push_beta_delete on public.push_subscriptions_beta;
create policy push_beta_delete on public.push_subscriptions_beta for delete to anon, authenticated using (true);

-- ★ 목록 읽기는 아무에게도 열지 않는다.
--
-- endpoint 는 그 기기로 알림을 쏠 수 있는 주소다. 목록이 새 나가면 부원 전원의 폰에
-- 알림을 밀어 넣을 수 있게 되므로, 남의 행은 아예 조회되지 않게 둔다.
-- (endpoint 를 신원 증표로 삼아 투표하던 rsvp_by_endpoint 는 2026-09-01 에 걷어냈다 —
--  sql/calendar/9-drop-endpoint-rsvp.sql)
--
-- 보내는 쪽은 RLS 를 통과하지 않는 service_role 로 읽는다:
--   · Supabase Edge Function → 환경변수로 service_role 키가 자동 주입된다 (추가 작업 없음)
--   · 로컬 send.js          → config.json 의 supabaseKey 를 service_role 키로 바꿔야 한다
--                             (대시보드 → Project Settings → API → service_role)
drop policy if exists push_beta_select on public.push_subscriptions_beta;

-- 내가 켠 알림이 살아 있는지 앱이 확인할 수 있어야 한다 — 딱 내 행만 열어 준다.
drop policy if exists push_beta_select_mine on public.push_subscriptions_beta;
create policy push_beta_select_mine on public.push_subscriptions_beta
  for select to authenticated using (user_id = auth.uid());
