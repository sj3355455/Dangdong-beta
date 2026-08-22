-- ═══════════════════════════════════════════════════════════════
-- 이름 변경을 "저장 시점에 한 번만" 반영하는 방식 (write-once)
-- Supabase SQL Editor에 붙여넣고 Run. 멱등(여러 번 실행 안전).
--
-- rename_player(target, new_name, new_handicap):
--   프로필 이름·수지를 바꾸고, 그 사람이 뛴 '모든 경기'의 저장된 이름을
--   서버에서 한 번에 갱신한다. 이후 앱은 매번 매칭할 필요 없이
--   경기에 저장된 이름을 그대로 쓰면 된다.
--   권한: 본인이거나 관리자만.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.rename_player(target uuid, new_name text, new_handicap int default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare games_updated integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if auth.uid() <> target and not public.is_admin() then
    raise exception 'not_authorized';
  end if;
  if new_name is null or length(btrim(new_name)) = 0 then
    raise exception 'empty_name';
  end if;

  -- 프로필 갱신
  update public.profiles
     set display_name = new_name,
         handicap     = new_handicap
   where id = target;

  -- 이 사람(target id)이 들어간 모든 경기의 저장된 이름 갱신
  update public.games
     set players = (
       select jsonb_agg(
                case when e->>'id' = target::text
                     then jsonb_set(e, '{name}', to_jsonb(new_name))
                     else e end
              )
       from jsonb_array_elements(players::jsonb) e
     )
   where players::jsonb @> jsonb_build_array(jsonb_build_object('id', target::text));

  get diagnostics games_updated = row_count;
  return games_updated;   -- 갱신된 경기 수
end
$$;

grant execute on function public.rename_player(uuid, text, int) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 1회 백필: 지금까지 쌓인 경기의 저장된 이름을 현재 프로필 이름으로 맞춘다.
--   (계정 id가 있는 선수만. 직접 입력으로 친 이름은 매칭할 id가 없어 그대로 둔다.)
-- ─────────────────────────────────────────────────────────────
update public.games g
   set players = (
     select jsonb_agg(
              case when nullif(e->>'id','') is not null and pr.display_name is not null
                   then jsonb_set(e, '{name}', to_jsonb(pr.display_name))
                   else e end
            )
     from jsonb_array_elements(g.players::jsonb) e
     left join public.profiles pr on pr.id = nullif(e->>'id','')::uuid
   )
 where exists (
   select 1 from jsonb_array_elements(g.players::jsonb) e
   where nullif(e->>'id','') is not null
 );

-- 확인(선택): 경기 속 이름이 현재 프로필과 일치하는지 훑어보기
-- select g.id,
--   (select string_agg(e->>'name', ', ') from jsonb_array_elements(g.players::jsonb) e) as 저장된_이름
-- from public.games g order by g.played_at desc limit 20;
