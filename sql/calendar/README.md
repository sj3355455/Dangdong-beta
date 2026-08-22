# 캘린더 SQL — 나눠서 실행

Supabase SQL Editor 는 긴 스크립트를 한 번에 붙여넣기 어려워서 조각으로 나눴습니다.
**위에서부터 순서대로** 한 파일씩 붙여넣고 Run 하세요.

| 순서 | 파일 | 무엇을 하나 |
|---|---|---|
| 0 | `0-check.sql` | (선택) 진단 전용 — 지금 서버에 뭐가 있는지만 본다. 아무것도 안 바꿈 |
| 1 | `1-tables.sql` | `club_events` · `day_plans` 표와 `is_team_admin` |
| 2 | `2-rls.sql` | 권한(grant) + RLS 정책 |
| 4 | `4-plan-spans.sql` | 일정 막대 함수 `plan_spans` + 설치 점검 |
| 5 | `5-meetups.sql` | **모임 투표** — `meetups` · `meetup_rsvps` 표와 집계 함수 |
| 6 | `6-drop-day-votes.sql` | ⚠️ 옛 날짜별 O/X 투표(`day_votes`)를 지운다. **되돌릴 수 없음** |

전부 **여러 번 실행해도 안전**합니다(멱등). 순서를 건너뛰면 각 파일이 앞 단계가 없다고
알려주고 멈추므로, 반쯤 만들어진 상태로 남지 않습니다.

### 3번(`3-vote-counts.sql`)은 왜 없나

날짜마다 "그날 되나요?"를 칠해 두던 방식이 모임 투표로 바뀌면서 그 집계 함수가 필요 없어졌습니다.
6번이 함수와 표를 함께 걷어냅니다. 1번·2번 파일에 남아 있는 `day_votes` 부분은
이미 만들어진 서버에서는 그냥 무시되고, 6번을 돌리면 사라집니다.

## 앞서 실행해야 하는 것

`../teams-setup.sql` → `../teams-rls.sql` → 여기(1, 2, 4, 5, 6) → (선택) `../event-games.sql`

알림까지 쓰려면 `../push-subscriptions-beta.sql` 도 실행해야 합니다.
발송은 `../../supabase/functions/notify-meetup/` 의 Edge Function 이 맡습니다.

## 나중에 고칠 때

모임 집계 규칙이 바뀌면 대개 **5번만** 다시 돌리면 됩니다.
RLS 정책만 손봤다면 2번(또는 5번)만 돌리면 됩니다.

앱에서 `모임 조회 함수(meetups_in)를 찾지 못했습니다` 가 뜨면 스키마 캐시 문제이니
`notify pgrst, 'reload schema';` 한 줄만 실행해 보세요.
