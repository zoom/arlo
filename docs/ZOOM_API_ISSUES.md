# Zoom API Issues Log

Captured: 2026-05-05

## Issues to Investigate

### 1. 403 Error on Meeting Details
- `GET /v2/meetings/{id}` returned 403 at 18:51:24 UTC
- Meeting ID: `7%252Bi3kJwAT4ua9zk71SdCfA%253D%253D`
- May indicate permission/scope issue for certain meetings

### 2. 400 Errors on User Endpoints
Multiple 400 errors on:
- `GET /v2/users/me/meetings` - 6 occurrences
- `GET /v2/users/me` - 2 occurrences

These occurred on 2026-05-01, possibly indicating:
- Invalid/expired access token
- Missing OAuth scopes (`user:read`, `meeting:read`)
- Token refresh issue

## Full API Log

| Time (UTC) | Method | Endpoint | Status |
|------------|--------|----------|--------|
| 2026-05-05 21:07:27 | GET | /v2/meetings/{id} | 200 |
| 2026-05-05 19:50:43 | GET | /v2/meetings/{id} | 200 |
| 2026-05-05 19:43:30 | GET | /v2/meetings/{id} | 200 |
| 2026-05-05 18:51:24 | GET | /v2/meetings/{id} | **403** |
| 2026-05-05 18:50:52 | GET | /v2/meetings/{id} | 200 |
| 2026-05-05 14:17:24 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 19:25:47 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 19:22:52 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 19:10:52 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 18:29:59 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 18:29:52 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 18:28:45 | GET | /v2/meetings/{id} | 200 |
| 2026-05-04 18:27:20 | GET | /v2/meetings/{id} | 200 |
| 2026-05-01 18:06:19 | GET | /v2/users/me/meetings | **400** |
| 2026-05-01 18:06:09 | GET | /v2/users/me/meetings | **400** |
| 2026-05-01 18:02:40 | GET | /v2/users/me/meetings | **400** |
| 2026-05-01 18:02:35 | GET | /v2/users/me | **400** |
| 2026-05-01 18:02:04 | GET | /v2/meetings/{id} | 200 |
| 2026-05-01 18:00:36 | GET | /v2/users/me/meetings | **400** |
| 2026-05-01 18:00:34 | GET | /v2/users/me | **400** |

## Guest Mode Issue (2026-05-05)

Guest participants still only seeing transcripts view instead of full meeting view with all vertical features.

### Attempted Fixes:
1. Modified WebSocket to allow anonymous connections
2. Changed REST endpoints to `optionalAuth`
3. Added `/guest-meeting/:id` route with `InMeetingView isGuestMode={true}`
4. Added auto-redirect in `GuestNoMeetingView` when `meetingUUID` available
5. Added wait for `meetingContext` in `RootView` before routing guests

### Still Not Working:
- Guests see old transcript-only view
- "Add Arlo" button not functional

### Next Steps:
- Check if `meetingUUID` is being captured for guests via SDK
- Verify SDK `getMeetingUUID` works for guest users
- Check browser console for routing logs
