-- ── 웹 푸시 구독 저장소 (테스트 앱 전용) ────────────────────────────────
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 한 번 실행하면 된다.
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
  user_id    uuid references auth.users(id) on delete cascade,
  label      text,                             -- 기기 구분용 메모 (iPhone / Android …)
  scope      text,                             -- 구독이 만들어진 경로. 항상 /Dangdong-beta/... 여야 한다
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions_beta enable row level security;

-- 앱에서 알림을 켜고 끄는 동작(추가·갱신·삭제)은 로그인 없이도 되게 열어 둔다.
-- 베타 테스트용이라 이렇게 두는 것이고, 실서비스로 옮길 때는 authenticated 로 좁히고
-- user_id = auth.uid() 조건을 걸어야 한다.
drop policy if exists push_beta_insert on public.push_subscriptions_beta;
create policy push_beta_insert on public.push_subscriptions_beta for insert to anon, authenticated with check (true);

drop policy if exists push_beta_update on public.push_subscriptions_beta;
create policy push_beta_update on public.push_subscriptions_beta for update to anon, authenticated using (true) with check (true);

drop policy if exists push_beta_delete on public.push_subscriptions_beta;
create policy push_beta_delete on public.push_subscriptions_beta for delete to anon, authenticated using (true);

-- 보내는 쪽(send.js)이 anon 키로 목록을 읽을 수 있게 한다.
-- 이 줄을 지우면 send.js 는 service_role 키가 있어야 동작한다 (config.json 의 supabaseKey 교체).
-- 목록이 새 나가도 남이 알림을 대신 보낼 수는 없다 — 푸시 서비스가 구독에 묶인
-- VAPID 개인키 서명을 검사하는데, 그 키는 이 PC 안에만 있다.
drop policy if exists push_beta_select on public.push_subscriptions_beta;
create policy push_beta_select on public.push_subscriptions_beta for select to anon, authenticated using (true);
