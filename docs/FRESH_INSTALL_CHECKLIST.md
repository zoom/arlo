# Fresh Install Testing Checklist

Use this checklist to verify the local reference implementation from a fresh
clone. It tests the local Docker Compose path, not the AWS Terraform stack.

## Prerequisites

- [ ] Node.js 20+ installed
- [ ] Docker and Docker Compose installed
- [ ] ngrok CLI installed and authenticated
- [ ] Zoom Marketplace app access
- [ ] RTMS access approved for the Zoom account/app

## 1. Clone and Environment

- [ ] Clone the repository:

  ```bash
  git clone https://github.com/zoom/arlo.git
  cd arlo
  ```

- [ ] Create the local environment file:

  ```bash
  cp .env.example .env
  ```

- [ ] Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, and
  `ZOOM_WEBHOOK_SECRET_TOKEN` from the Marketplace app.

- [ ] Generate the required local secrets:

  ```bash
  node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
  node -e "console.log('REDIS_ENCRYPTION_KEY=' + require('crypto').randomBytes(16).toString('hex'))"
  node -e "console.log('INTERNAL_WEBHOOK_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
  ```

- [ ] Confirm the local database URL is:
  `mysql://arlo:arlo@mysql:3306/meeting_assistant`.
- [ ] Leave `RTMS_CLIENT_ID` empty unless the RTMS app uses a different client
  ID. The RTMS service falls back to `ZOOM_CLIENT_ID`.
- [ ] Set `AI_ENABLED=true` to test AI features. `OPENROUTER_API_KEY` is
  optional, but free-model rate limits still apply without one.

## 2. Public URL and ngrok

- [ ] Start ngrok to the backend host port:

  ```bash
  ngrok http 3000 --domain=yourname-arlo.ngrok-free.app
  ```

  A random ngrok URL also works, but it must be changed everywhere after each
  restart.

- [ ] Set `PUBLIC_URL=https://yourname-arlo.ngrok-free.app` in `.env`.
- [ ] Keep the ngrok process running while testing. The backend proxies the
  frontend and receives `/api/rtms/webhook` through this URL.

## 3. Zoom Marketplace Configuration

- [ ] OAuth redirect URL:
  `https://YOUR-NGROK-HOST/api/auth/callback`
- [ ] OAuth allow list includes `https://YOUR-NGROK-HOST`.
- [ ] Home URL is `https://YOUR-NGROK-HOST`.
- [ ] Domain Allow List contains `YOUR-NGROK-HOST` without `https://`.
- [ ] Event notification endpoint is
  `https://YOUR-NGROK-HOST/api/rtms/webhook`.
- [ ] Subscribe to `meeting.rtms_started` and `meeting.rtms_stopped`.
- [ ] Enable the Zoom Apps SDK capabilities used by
  `frontend/src/contexts/ZoomSdkContext.js`, especially:
  `getMeetingUUID`, `getMeetingContext`, `getRunningContext`, `getUserContext`,
  `authorize`, `onAuthorized`, `startRTMS`, `stopRTMS`, `pauseRTMS`,
  `resumeRTMS`, `getRTMSStatus`, and `onRTMSStatusChange`.
- [ ] Enable the RTMS transcript capability/feature for the app if it is
  required by the account's Marketplace configuration.
- [ ] Add only the OAuth scopes required by the features being tested. The
  upcoming-meetings auto-open feature additionally requires `ZOOM_APP_ID` and
  the corresponding meeting read/open-app permissions.

## 4. Start and Verify Services

- [ ] Start the stack:

  ```bash
  docker compose up --build
  ```

- [ ] Confirm these Compose services are running:
  - [ ] `mysql` - MySQL on host port 3306
  - [ ] `backend` - API/WebSocket on host port 3000
  - [ ] `frontend` - CRA dev server on host port 3001
  - [ ] `rtms` - RTMS service on host port 3002

- [ ] Verify health endpoints:

  ```bash
  curl http://localhost:3000/health
  curl http://localhost:3002/health
  ```

- [ ] Run the smoke tests after the backend is ready:

  ```bash
  npm test
  ```

- [ ] Include the optional local Redis service when testing the shared realtime
  path:

  ```bash
  printf '\nREDIS_URL=redis://redis:6379\n' >> .env
  docker compose --profile with-redis up --build
  ```

## 5. In-Meeting Test

- [ ] Open Arlo from the Zoom Apps menu while in a meeting.
- [ ] Complete in-client OAuth and verify the app returns to the authenticated
  view.
- [ ] Confirm the browser obtains a meeting UUID and an RTMS session ID before
  opening `/ws`.
- [ ] Start RTMS, or verify the configured auto-start preference starts it.
- [ ] Confirm Zoom sends `meeting.rtms_started` to the public webhook.
- [ ] Confirm the RTMS service joins signaling/media and logs transcript
  callbacks.
- [ ] Confirm transcript segments appear in the app and are saved in MySQL.
- [ ] Confirm the WebSocket reconnects after a temporary disconnect.
- [ ] Verify the browser WebSocket uses `meeting_uuid` and `session_id`; do not
  use port `3000` as a separate WebSocket origin.
- [ ] Verify pause, resume, and stop controls when the Zoom account supports
  those RTMS APIs.
- [ ] Verify key moments are attempted every 30 seconds after enough transcript
  content exists. The result may be empty when no significant moment is found.

## 6. Persistence and Cleanup

- [ ] Verify MySQL contains the meeting and transcript rows.
- [ ] Verify participant events appear after real join/leave events. Initial
  roster events are intentionally classified separately.
- [ ] Stop RTMS without ending the Zoom meeting.
- [ ] Confirm the worker/session path sends `rtms_stopped` and the matching
  realtime Valkey session is deleted when Valkey is enabled.
- [ ] Confirm MySQL records remain after RTMS stops. They are durable history,
  not ephemeral Valkey data.
- [ ] End the meeting and verify the app stops reconnecting after its meeting
  context disappears.

## 7. AI and Verticals

- [ ] Check `GET /api/ai/status` to verify `AI_ENABLED` and the configured
  free-model chain.
- [ ] Generate a live summary with at least 50 characters of transcript.
- [ ] Verify key-moment model fallback by checking backend logs if a model
  returns invalid JSON or an upstream error.
- [ ] Keep the Settings demo-data toggle off when validating real transcript
  behavior. Many vertical cards are intentionally demo/manual components.
- [ ] Test support sentiment separately; it analyzes a rolling window every 30
  seconds when enough text is available.

## 8. Security Checks

- [ ] `/api/auth/me`, `/api/meetings`, and `/api/search` return `401` without a
  session.
- [ ] Production WebSocket deployments reject connections without a valid
  signed token. Local development may allow anonymous sockets by design.
- [ ] Webhook requests with missing or invalid Zoom HMAC headers are rejected.
- [ ] Internal RTMS requests are signed with `INTERNAL_WEBHOOK_SECRET` outside
  development mode.
- [ ] No real credentials are committed to `.env`, logs, screenshots, or docs.

## Sign-off

- [ ] All critical tests pass
- [ ] No unexplained browser console errors
- [ ] No unhandled backend or RTMS errors
- [ ] Test output and commit recorded

**Tested by:** _______________
**Date:** _______________
**Commit:** _______________
