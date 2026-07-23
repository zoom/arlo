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
npm run dev:frontend     # Frontend only (CRA dev server)
npm run dev:rtms         # RTMS service only
npm run setup            # Install all workspace dependencies
```

### Frontend Build

```bash
cd frontend && npx react-scripts build
```

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

### Authentication Flow (Zoom OAuth PKCE)

Implemented in `useZoomAuth` hook (`frontend/src/hooks/useZoomAuth.js`) — single source of truth for auth.

```
1. Frontend: GET /api/auth/authorize → { codeChallenge, state }
2. Frontend: Register onAuthorized listener BEFORE calling authorize()
3. Frontend: zoomSdk.authorize({ codeChallenge, state })
4. Zoom fires onAuthorized → { code }
5. Frontend: POST /api/auth/callback { code, state }
6. Backend: Exchanges code for tokens, stores in memory (encrypted), creates session cookie
7. Frontend: login(user, wsToken) → navigate to /home
```

**Note:** Users must re-authenticate after server restart since tokens are stored in memory only.

## Key Files & Architecture Details

### Backend (`backend/src/`)
- `server.js` — Express app setup, middleware, route mounting, rate limiting
- `config.js` — Environment variable validation
- `lib/memoryStore.js` — In-memory user and token storage (NO DATABASE)
- `routes/` — 9 route modules: auth, meetings, ai, home, rtms, search, highlights, zoom-meetings, preferences
- `services/` — auth (token/PKCE/encryption), openrouter (LLM), websocket (broadcast)
- `middleware/auth.js` — `requireAuth` and `optionalAuth` session middleware

### Frontend (`frontend/src/`)
- `App.js` — HashRouter, route definitions, provider hierarchy: Theme → ZoomSdk → Auth → Meeting → Toast
- `index.css` — Design tokens, typography (Source Serif 4 + Inter), light/dark theme variables
- `views/` — 14 views (Auth, Home, MeetingsList, MeetingDetail, InMeeting, SearchResults, Settings, etc.)
- `contexts/` — AuthContext (session), ZoomSdkContext (SDK init), MeetingContext (active meeting + WS), ServerSettingsContext (demo mode flags)
- `hooks/useZoomAuth.js` — In-client OAuth PKCE flow hook
- `components/AppShell.js` — Persistent header + `<Outlet />`

### Monorepo (npm workspaces)

The root `package.json` defines 3 workspaces: `backend`, `frontend`, `rtms`. Install dependencies into a specific workspace:

```bash
npm install <package> -w backend      # Add to backend
npm install <package> -w frontend     # Add to frontend
npm install <package> -w rtms         # Add to rtms
```

## Frontend UI (Base UI)

The frontend uses `@base-ui/react` for accessible, unstyled components, styled with plain CSS and CSS custom properties.

### Critical: CRA Import Pattern

CRA 5 does NOT support package.json `exports` subpath patterns. Always import from the main entry:

```javascript
// CORRECT
import { Tabs, Collapsible, Tooltip } from '@base-ui/react';

// WRONG — fails at runtime in CRA
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

**Security:** JWT token is required for all WebSocket connections.

```
Connection: ws://host/ws?meeting_id={uuid}&token={jwt}
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
TOKEN_ENCRYPTION_KEY=...        # 64 chars (AES-256): node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
OPENROUTER_API_KEY=...          # Optional — free models work without it
DEFAULT_MODEL=google/gemini-2.0-flash-thinking-exp:free
LOG_LEVEL=info                  # Set to 'debug' to enable transcript/PII logging
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
6. **Event Subscriptions** — `meeting.rtms_started`, `meeting.rtms_stopped`

## Security (Demo Mode)

This demo mode version prioritizes security by never storing customer data:

- **No database** — All data exists in memory only
- **Tokens in memory** — OAuth tokens stored encrypted in memory, cleared on restart
- **No persistent storage** — Meeting transcripts are broadcast but never saved
- **Session cookies** — httpOnly, secure, SameSite=lax
- **HMAC verification** — All Zoom webhooks verified with timing-safe comparisons
- **Rate limiting** — Global, auth, and AI endpoint limits via `express-rate-limit`
- **WebSocket auth** — JWT token required for all connections

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

- Frontend uses CRA (react-scripts), NOT Next.js — migration to Vite planned
- Users must re-authenticate after server restart (tokens in memory only)
- Features requiring stored data show "not available in demo mode" messaging
