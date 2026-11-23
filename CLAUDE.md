# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Arlo Meeting Assistant** is an open-source Zoom Apps reference implementation demonstrating how to build intelligent meeting assistants that capture real-time transcripts using RTMS (Real-Time Media Streams) — **without requiring a meeting bot**. The app runs natively inside Zoom meetings and provides AI-powered summaries, action items, and real-time AI suggestions.

**IMPORTANT - Demo Mode:** This version runs in **secure demo mode** with **no database**. Customer meeting data is **never stored** — all transcription happens in real-time only and data exists only in memory during the active meeting.

## Demo Mode Features

### Available in Demo Mode:
- **Live transcription** — Real-time via WebSocket (data never stored)
- **Real-time AI suggestions** — During active meetings
- **Live AI summary generation** — From current transcript
- **SOAP notes extraction** — For healthcare use cases
- **Sentiment analysis** — Real-time customer sentiment
- **Demo sample data** — Toggle to see UI with sample content

### Not Available in Demo Mode:
- Meeting history
- Search across transcripts
- Upcoming meetings list
- Auto-open meeting feature
- AI chat with past meetings
- VTT/Markdown export

## Development Commands

### Docker Setup (Recommended)

```bash
docker-compose up --build              # Start all services (Backend, Frontend, RTMS)
docker-compose up --build -V           # Rebuild with fresh node_modules
docker-compose logs -f backend         # View backend logs
docker-compose restart backend         # Restart specific service
docker-compose down && docker-compose up --build  # Clean restart
```

### Manual Development

```bash
npm run dev              # Start all services concurrently (backend + frontend + rtms)
npm run dev:backend      # Backend only (nodemon for auto-restart)
npm run dev:frontend     # Frontend only (built bundle, rebuilt on change; `npm run dev -w frontend` for the Vite dev server)
npm run dev:rtms         # RTMS service only
npm run setup            # Install all workspace dependencies
```

### Frontend Build

```bash
npm run build -w frontend    # Vite production build → frontend/build
npm test -w frontend         # Vitest unit + UI state tests (jsdom, Testing Library)
npm run lint -w frontend     # ESLint
```

Files that contain JSX use the `.jsx` extension (Vite requires it).

The frontend container (`npm start`) serves a **built bundle** that is rebuilt on every source change (`frontend/scripts/serve-built.mjs`); reload the Zoom panel to see a change. It does not run Vite's dev server: unbundled modules through ngrok load slowly, and without the hot-reload WebSocket (the backend proxy does not forward it) the Zoom webview can mix cached and new modules and fail to mount. For the hot-reloading dev server in a normal browser, run `npm run dev -w frontend` (set `VITE_HMR=true`).

### ngrok (Required for Zoom App Testing)

```bash
ngrok http 3000                                        # Random domain (changes each restart)
ngrok http 3000 --domain=yourname-arlo.ngrok-free.app  # Static domain (recommended)
# Then update PUBLIC_URL in .env
```

## Architecture

### System Components

1. **In-Meeting Zoom App** (`frontend/`) — React 18 + Base UI + Zoom Apps SDK
   - Runs embedded in Zoom client during meetings
   - Live transcript display, AI suggestions
   - Start/stop RTMS via `zoomSdk.callZoomApi('startRTMS')`

2. **Backend API** (`backend/`) — Node.js/Express (NO DATABASE)
   - Zoom OAuth 2.0 (PKCE flow), session management with httpOnly cookies
   - In-memory token storage (cleared on restart)
   - WebSocket server for live transcript broadcast
   - AI orchestration via OpenRouter (free models, no API key required)

3. **RTMS Service** (`rtms/`) — @zoom/rtms v1.0.2
   - Webhook handlers for `meeting.rtms_started` / `meeting.rtms_stopped`
   - WebSocket-based transcript ingestion from Zoom

### Data Flow (Demo Mode)

```
Zoom RTMS WebSocket → RTMS Service → Backend (broadcast only, NO storage)
    → WebSocket broadcast → Frontend (live transcript display, < 1s end-to-end)
```

**SECURITY:** Data flows through memory only and is never persisted. When the meeting ends or server restarts, all meeting data is gone.

### Stream failover and reconnection

Rules live in `rtms/src/sessions.js` (tested with a fake client in `rtms/test/sessions.test.js`) and follow Zoom's [failover guide](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/). The backend forwards `meeting.rtms_started`, `rtms_stopped` and `rtms_interrupted` to the rtms service, which owns the connection and reports what happened.

| Signal from Zoom | What Arlo does | Panel shows |
|---|---|---|
| `meeting.rtms_started` again for a stream it holds (server failover) | Rejoins at once with the new `server_urls` | Reconnecting… |
| `meeting.rtms_interrupted` (signaling dropped, ~60s window) | Rejoins after a backoff: 3s, 6s, 12s, 24s, 30s; gives up after 5 attempts | Reconnecting… |
| Media connection interrupted (~30s window) | Same rejoin: the `@zoom/rtms` SDK has only `join()`/`leave()`, so there is no media-only reconnect | Reconnecting… |
| `meeting.rtms_stopped` with stop reason 10–19 or 24 | Reports the stop as a fault | "Transcription stopped because of a connection problem" + Restart |

After a fault stop, the panel that started the stream calls `startRTMS` again by itself (at most 3 times per meeting); other panels show the Restart button. A connection that closes on its own is never rejoined before Zoom says what happened.

To watch this in a real meeting, set `CHAOS_DROP_STREAM_AFTER_SEC=15` in `.env` and `docker-compose up -d rtms`: the rtms service drops its connection 15 seconds after every join. Remove it afterwards.

### Authentication Flow (Zoom OAuth PKCE)

Implemented in `useZoomAuth` hook (`frontend/src/hooks/useZoomAuth.js`) — single source of truth for auth.

```
1. Frontend: GET /api/auth/authorize → { codeChallenge, state }
2. Frontend: Register onAuthorized listener BEFORE calling authorize()
3. Frontend: zoomSdk.authorize({ codeChallenge, state })
4. Zoom fires onAuthorized → { code }
5. Frontend: POST /api/auth/callback { code, state }
6. Backend: Exchanges code for tokens, stores in memory (encrypted), creates session cookie
7. Frontend: login(user) → navigate to /home (the session token stays in the httpOnly cookie and is never returned to JavaScript)
```

**Note:** Users and tokens are stored in memory only. A server restart is survived through an encrypted httpOnly `sessionRestore` cookie (user record + Zoom refresh token, AES-GCM with `TOKEN_ENCRYPTION_KEY`) that rebuilds the in-memory session on the next request; see `backend/src/services/sessionRestore.js`. Without that cookie, the app signs in silently when Zoom still reports the user as authorized.

## Key Files & Architecture Details

### Backend (`backend/src/`)
- `server.js` — Express app setup, middleware, route mounting, rate limiting
- `config.js` — Environment variable validation
- `lib/memoryStore.js` — In-memory user and token storage (NO DATABASE)
- `routes/` — 9 route modules: auth, meetings, ai, home, rtms, search, highlights, zoom-meetings, preferences
- `services/` — auth (token/PKCE/encryption), openrouter (LLM), websocket (broadcast)
- `middleware/auth.js` — `requireAuth` and `optionalAuth` session middleware

### Frontend (`frontend/src/`)
- `App.jsx` — HashRouter, route definitions, provider hierarchy: Theme → ZoomSdk → Auth → Meeting → Toast
- `index.css` — Design tokens, typography (Source Serif 4 + Inter), light/dark theme variables
- `views/` — 14 views (Auth, Home, MeetingsList, MeetingDetail, InMeeting, SearchResults, Settings, etc.)
- `contexts/` — AuthContext (session), ZoomSdkContext (SDK init), MeetingContext (active meeting + WS), ServerSettingsContext (demo mode flags)
- `hooks/useZoomAuth.js` — In-client OAuth PKCE flow hook
- `lib/dynamicIndicator.js` + `hooks/useDynamicIndicator.js` — Zoom's Dynamic Indicator (status text in Zoom's meeting window, seen by everyone). Basic version: text only, set by the panel that started the stream, only while transcription is confirmed (`rtmsPhase === 'active'`); "Arlo is thinking…" while a voice command runs. Silent when the client or the Marketplace config lacks `setDynamicIndicator` / `removeDynamicIndicator`
- `components/AppShell.jsx` — Persistent header + `<Outlet />`

### Monorepo (npm workspaces)

The root `package.json` defines 3 workspaces: `backend`, `frontend`, `rtms`. Install dependencies into a specific workspace:

```bash
npm install <package> -w backend      # Add to backend
npm install <package> -w frontend     # Add to frontend
npm install <package> -w rtms         # Add to rtms
```

## Frontend UI (Base UI)

The frontend uses `@base-ui/react` for accessible, unstyled components, styled with plain CSS and CSS custom properties.

### Import Pattern

Import Base UI from the main entry (project convention, kept from the CRA days when subpath imports failed):

```javascript
// CORRECT
import { Tabs, Collapsible, Tooltip } from '@base-ui/react';

// AVOID — subpath imports
import { Tabs } from '@base-ui/react/tabs';
```

### Styling Conventions

- CSS data attributes for state: `[data-active]`, `[data-pressed]`, `[data-panel-open]`
- Design tokens in `frontend/src/index.css` under `:root`
- Dark mode: `.dark` class on `<html>`, toggled via ThemeContext
- Fonts: Source Serif 4 (serif) + Inter (UI chrome)
- Icons: `lucide-react` throughout the app

## REST API Endpoints

### Authentication
- `GET /api/auth/authorize` — Get PKCE challenge for in-client OAuth
- `POST /api/auth/callback` — Exchange code for tokens (in-client PKCE)
- `GET /api/auth/me` — Get current authenticated user
- `GET /api/auth/settings` — Get server settings and feature flags
- `POST /api/auth/logout` — Clear session

### API tokens and RTMS REST testing
Arlo can act as a test proxy for Zoom's RTMS REST API. A script authenticates with a short-lived API token (`Authorization: Bearer arlo_…`) instead of a browser session.
- `POST /api/tokens` — Create a token (browser session only). Body `{ scopes: ["rtms:control","rtms:read"], name?, ttlMinutes? }`. The token is returned once; only its hash is kept, in memory. Default lifetime 1 hour, max 24; max 5 per user
- `GET /api/tokens` / `DELETE /api/tokens/:id` — List / revoke (browser session only)
- `POST /api/rtms/start` — `{ meetingId, action: start|stop|pause|resume }` → Zoom `PATCH /v2/live_meetings/{meetingId}/rtms_app/status` with the user's Zoom token (session or `rtms:control`). 202 = Zoom accepted the request, not "stream started"; a refusal returns Zoom's status, code and message. Needs the Zoom scope `meeting:update:participant_rtms_app_status`
- `GET /api/rtms/events?since=<ISO>` — Timeline for the caller's own meetings: REST requests, Zoom webhooks (`meeting.rtms_*`, `rtms.request_status` with its meaning), Arlo's stream join result (session or `rtms:read`)

### Meetings (Demo Mode - Returns empty/disabled responses)
- `GET /api/meetings` — Returns empty list with demo mode message
- `GET /api/meetings/:id` — Returns demo mode response
- All meeting CRUD operations return demo mode responses

### AI (Some Available in Demo Mode)
- `POST /api/ai/suggest` — Real-time AI suggestions (AVAILABLE)
- `POST /api/ai/summary-live` — Generate summary from provided transcript (AVAILABLE)
- `POST /api/ai/sentiment` — Sentiment analysis (AVAILABLE)
- `POST /api/ai/key-moment` — Key moment detection (AVAILABLE)
- `POST /api/ai/extract-soap` — SOAP notes extraction (AVAILABLE)
- `GET /api/ai/status` — Check AI service status (AVAILABLE)
- `POST /api/ai/summary` — Returns demo mode response (requires stored meeting)
- `POST /api/ai/chat` — Returns demo mode response (requires stored meetings)

### Search (Demo Mode - Disabled)
- `GET /api/search` — Returns empty results with demo mode message

## WebSocket Protocol

**Security:** every WebSocket connection is authenticated by httpOnly cookies sent on the handshake (`meetingAccess`, plus `sessionToken` for signed-in users). No token goes in the URL.

```
Connection: ws://host/ws?meeting_id={uuid}   (cookies authenticate; the server binds the socket to the verified meeting)
Client → Server: { type: 'subscribe', meetingId: 'uuid' }
Server → Client: { type: 'transcript.segment', data: { meetingId, segment: {...} } }
Server → Client: { type: 'ai.suggestion', data: { meetingId, suggestion: {...} } }
Server → Client: { type: 'meeting.status', data: { meetingId, status: '...' } }
```

## Environment Variables

Required in `.env` (copy from `.env.example`):

```bash
ZOOM_CLIENT_ID=...              # From Zoom Marketplace
ZOOM_CLIENT_SECRET=...
ZOOM_WEBHOOK_TOKEN=...          # For webhook verification
PUBLIC_URL=https://...          # ngrok HTTPS URL
SESSION_SECRET=...              # 64 chars: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TOKEN_ENCRYPTION_KEY=...        # Required: 64 hex chars = 32 bytes (AES-256-GCM). 32-char keys and REDIS_ENCRYPTION_KEY are no longer accepted. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
OPENROUTER_API_KEY=...          # Optional — free models work without it
OPENROUTER_MODELS=nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free
DEFAULT_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
FALLBACK_MODEL=nvidia/nemotron-3.5-lightning:free
LOG_LEVEL=info                  # 'debug' adds request shapes (field names, sizes). No level logs transcript text, names, ids or tokens
DEMO_MODE=true                  # Always true in this version
```

**Note:** `DATABASE_URL` is NOT required — this version has no database.

## Testing Zoom App Locally

1. Start ngrok: `ngrok http 3000 --domain=your-domain.ngrok-free.app`
2. Update `PUBLIC_URL` in `.env`
3. Update Home URL and OAuth Redirect URL in Zoom Marketplace
4. `docker-compose restart backend`
5. In Zoom: Apps → Find your app → Open
6. Right-click app → Inspect Element (DevTools)

## Zoom Marketplace Setup (Required)

1. **Domain Allowlist** — Add `appssdk.zoom.us`
2. **OAuth Redirect URL** — `https://{your-domain}/api/auth/callback`
3. **RTMS Scopes** — Enable Transcripts (requires RTMS access approval from Zoom)
4. **SDK Capabilities** — See `.claude/skills/zoom-apps/02-sdk-setup.md`
5. **Home URL** — Your ngrok/production URL
6. **Event Subscriptions** — `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.rtms_interrupted`; optional `rtms.request_status` (shows why a stream request failed). Endpoint: `https://{your-domain}/api/rtms/webhook`
7. **Deauthorization Notification Endpoint URL** — the same `https://{your-domain}/api/rtms/webhook`. On `app_deauthorized` the server deletes the user's record and tokens and ends their session.

## Security (Demo Mode)

This demo mode version prioritizes security by never storing customer data:

- **No database** — All data exists in memory only
- **Tokens in memory** — OAuth tokens stored encrypted in memory, cleared on restart
- **No persistent storage** — Meeting transcripts are broadcast but never saved
- **Session cookies** — httpOnly, secure, SameSite=lax. Three kinds that cannot stand in for each other: `sessionToken` (who you are), `meetingAccess` (which meeting you are in), `sessionRestore` (encrypted, rebuilds a session after a restart)
- **HMAC verification** — All Zoom webhooks verified with timing-safe comparisons
- **Rate limiting** — Global, auth, and AI endpoint limits via `express-rate-limit`
- **WebSocket auth** — verified meeting-access cookie required for all connections

**Privacy Notice:** Your meeting data is processed in real-time and never stored. All data exists only in memory during your active session and is automatically cleared when you leave.

## Branch Information

- **`main`** — Secure demo mode (this version, no database)
- **`feature/database-enabled`** — Full version with MySQL database (for production use)

## Documentation Reference

- `/SPEC.md` — Feature specification and version milestones
- `.claude/skills/zoom-apps/` — General Zoom Apps development guides
- `/docs/ARCHITECTURE.md` — System architecture details
- `/docs/TROUBLESHOOTING.md` — Common issues and fixes

## Known Issues

- Frontend uses Vite + Vitest (migrated from CRA in Nov 2026), NOT Next.js
- Sessions survive a server restart via the `sessionRestore` cookie; a session older than 24 hours signs in again (silently, inside Zoom)
- Features requiring stored data show "not available in demo mode" messaging
