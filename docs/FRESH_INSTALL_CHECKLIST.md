# Fresh Install Testing Checklist

Use this checklist to verify that the Arlo reference implementation works correctly from a fresh clone.

---

## Prerequisites

- [ ] Node.js 20+ installed
- [ ] Docker + Docker Compose installed
- [ ] ngrok CLI installed and authenticated
- [ ] Zoom account with Marketplace access
- [ ] **RTMS access approved** (critical — app won't work without this)

---

## 1. Clone & Environment Setup

- [ ] Clone repository to fresh directory
  ```bash
  git clone https://github.com/your-org/arlo-meeting-assistant.git
  cd arlo-meeting-assistant
  ```

- [ ] Copy environment template
  ```bash
  cp .env.example .env
  ```

- [ ] Generate secrets
  ```bash
  # SESSION_SECRET (64 chars)
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

  # REDIS_ENCRYPTION_KEY (32 chars)
  node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
  ```

- [ ] Verify `.env` has all required values:
  - [ ] `ZOOM_CLIENT_ID`
  - [ ] `ZOOM_CLIENT_SECRET`
  - [ ] `ZOOM_APP_ID`
  - [ ] `SESSION_SECRET`
  - [ ] `REDIS_ENCRYPTION_KEY`
  - [ ] `PUBLIC_URL` (will be set after ngrok)
  - [ ] `DATABASE_URL` (default works for Docker)

---

## 2. ngrok Setup

- [ ] Start ngrok with static domain (recommended)
  ```bash
  ngrok http 3000 --domain=yourname-arlo.ngrok-free.app
  ```

- [ ] Update `PUBLIC_URL` in `.env` with ngrok URL

- [ ] Verify ngrok is running (visit URL in browser — should show connection refused until app starts)

---

## 3. Zoom Marketplace Configuration

### Basic Information
- [ ] OAuth Redirect URL set to `https://{ngrok-url}/api/auth/callback`
- [ ] OAuth Allow List includes `https://{ngrok-url}`

### Features → Zoom App SDK
- [ ] All required SDK capabilities enabled (getMeetingContext, authorize, etc.)
- [ ] RTMS → Transcripts enabled
- [ ] In-client OAuth enabled

### Features → Surface
- [ ] Home URL set to `https://{ngrok-url}`
- [ ] Domain Allow List includes `https://{ngrok-url}` and `appssdk.zoom.us`

### Event Subscriptions
- [ ] Event notification endpoint URL: `https://{ngrok-url}/api/rtms/webhook`
- [ ] `meeting.rtms_started` subscribed
- [ ] `meeting.rtms_stopped` subscribed

### OAuth Scopes (verify these are enabled)
- [ ] `zoomapp:inmeeting`
- [ ] `meeting:read:meeting`
- [ ] `user:read` (optional but recommended)
- [ ] `meeting:write:open_app` (optional, for auto-open)

---

## 4. Start Application

- [ ] Start with Docker Compose
  ```bash
  docker-compose up --build
  ```

- [ ] Verify all services start:
  - [ ] `db` — PostgreSQL (port 5432)
  - [ ] `backend` — Express API (port 3000)
  - [ ] `frontend` — React dev server (port 3001)
  - [ ] `rtms` — RTMS service (port 3002)

- [ ] Check backend logs for errors
  ```bash
  docker-compose logs -f backend
  ```

- [ ] Verify health endpoints:
  ```bash
  curl http://localhost:3000/health
  curl http://localhost:3002/health
  ```

---

## 5. In-Meeting Test

### First Launch
- [ ] Start or join a Zoom meeting
- [ ] Click Apps → Find your app (or search)
- [ ] Click "Add" or "Open"
- [ ] OAuth flow completes successfully
- [ ] Redirected to Home view

### Start Transcription
- [ ] Click "Start Transcription" (or auto-starts if enabled)
- [ ] Verify RTMS webhook received (check rtms service logs)
- [ ] Live transcript appears within 1-2 seconds of speaking
- [ ] Speaker labels are correct
- [ ] Timestamps are accurate

### Real-Time Features
- [ ] Auto-scroll follows live transcript
- [ ] "Scroll to live" button appears when scrolling up
- [ ] AI suggestions appear (if enabled)
- [ ] Transport controls work (pause/resume/stop)

### Navigation
- [ ] Can navigate to Home while in meeting
- [ ] "Return to live transcript" banner appears
- [ ] Banner navigates back to live view
- [ ] Meeting appears in Meetings list

---

## 6. Post-Meeting Test

### Meeting History
- [ ] Meeting appears in Meetings list
- [ ] Meeting detail view loads
- [ ] Full transcript is saved
- [ ] Participant list is accurate

### AI Features
- [ ] Summary generates successfully
- [ ] "Ask about this meeting" works
- [ ] Action items are extracted (if applicable)

### Export
- [ ] VTT export downloads valid file
- [ ] Markdown export includes summary + transcript

### Search
- [ ] Full-text search finds transcript content
- [ ] Search results link to correct meetings

---

## 7. Guest Mode Test (Optional)

- [ ] Join a meeting as non-authorized user
- [ ] Guest view renders with limited features
- [ ] Can see live transcript (if host has Arlo active)
- [ ] Upgrade CTA is visible

---

## 8. Settings Test

- [ ] Theme toggle works (light/dark)
- [ ] Auto-start preference persists
- [ ] Chat notice preferences save

---

## Common Issues & Solutions

### "RTMS webhook not received"
- Verify event subscriptions are configured correctly
- Check ngrok is forwarding to correct port
- Verify RTMS access is approved for your Zoom account

### "OAuth fails with invalid_grant"
- Client secret may be incorrect
- Code may have already been exchanged (try again)
- Redirect URL must exactly match Marketplace config

### "Transcript not appearing"
- Check WebSocket connection in browser dev tools
- Verify RTMS service is running
- Check for errors in rtms service logs

### "Database connection refused"
- Ensure PostgreSQL container is running
- Check DATABASE_URL in .env

---

## Sign-off

- [ ] All critical tests pass
- [ ] No console errors in browser
- [ ] No unhandled errors in server logs
- [ ] Ready for demo/deployment

**Tested by:** _______________
**Date:** _______________
**Commit:** _______________
