# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Arlo Meeting Assistant** is an open-source Zoom Apps reference implementation demonstrating how to build intelligent meeting assistants that capture real-time transcripts using RTMS (Real-Time Media Streams) — **without requiring a meeting bot**. The app runs natively inside Zoom meetings and provides AI-powered summaries, action items, and real-time AI suggestions.

**IMPORTANT - Demo Mode:** This version runs in **secure demo mode** with **no database**. A meeting's transcript, timeline and notes are held **in memory only while that meeting runs** and are deleted when it ends. Nothing is written to disk and nothing carries from one meeting to the next.

## Demo Mode Features

### Available in Demo Mode:
- **Live transcription** — Real-time via WebSocket; held in memory for the meeting so late or reconnecting panels can catch up
- **Live notes** — Summary, decisions and action items, written from the stored transcript on a timer and shown only to the people who brought Arlo in
- **Ask Arlo** — A typed question, answered from the stored transcript, private to the asker
- **Meeting record** — What was said and what happened since Arlo joined, for everyone in the meeting
- **Real-time AI suggestions** — During active meetings (classic dashboard)
- **Live AI summary generation** — From current transcript
- **SOAP notes extraction** — For healthcare use cases
- **Sentiment analysis** — Real-time customer sentiment
- **Demo sample data** — Off by default; a toggle in Settings, shown only when the deployment runs in demo mode

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
   - One screen at a time (see "Arlo screens"): bring Arlo in, live notes, participant view, meeting record, after the meeting
   - Start/stop RTMS via `zoomSdk.callZoomApi('startRTMS')`

2. **Backend API** (`backend/`) — Node.js/Express (NO DATABASE)
   - Zoom OAuth 2.0 (PKCE flow), session management with httpOnly cookies
   - In-memory token storage (cleared on restart)
   - WebSocket server for live transcript broadcast
   - AI orchestration via OpenRouter (free models, no API key required)
   - Knows who brought Arlo in, writes the live notes from the stored transcript, and sends them only to those people

3. **RTMS Service** (`rtms/`) — @zoom/rtms v1.0.2
   - Webhook handlers for `meeting.rtms_started` / `meeting.rtms_stopped`
   - WebSocket-based transcript ingestion from Zoom

### Data Flow (Demo Mode)

```
Zoom RTMS WebSocket → RTMS Service → Backend (kept in memory for the meeting, then broadcast)
    → WebSocket broadcast → Frontend (live transcript display, < 1s end-to-end)
Panel opens late or reconnects → GET /api/meetings/by-zoom-id/{id}/transcript → what was said so far
Stored lines → notes engine (timer) → notes in the meeting store → `notes.updated` to the owners' sockets only
```

**SECURITY:** Meeting data lives in memory only (`backend/src/storage/`) and is never written to disk. `backend/src/services/meetingLifecycle.js` deletes a meeting's data when:
- Zoom reports the stream stopped because the meeting ended (stop reason 6), or
- the stream is stopped and no Arlo panel has been connected for `MEETING_FLUSH_GRACE_MS` (default 2 minutes), or
- it is older than 12 hours.

The notes, the "who can ask" setting, what is known about the meeting's streams (and so who its owners are) and the notes engine's timer go in the same flush. A stop, pause, reconnect or restart inside one meeting keeps the data. A server restart clears everything. A transcript line that arrives within ten minutes after a meeting's data was flushed is dropped, not kept. In the ten minutes after Zoom said a meeting ended, a start or reconnect report for it is ignored too: a meeting UUID that ended does not start again.

### Arlo screens

`frontend/src/lib/arloScreen.js` picks one screen from confirmed state (a request is not a state). `views/ArloMeetingView.jsx` renders it; there are no tabs.

| Screen | Who sees it | What it shows |
|---|---|---|
| Bring Arlo in | Signed-in host or co-host, Arlo not in the meeting | "Who can ask Arlo" (only I / anyone) and one button. Nothing is requested before the click |
| Ask the host | Other signed-in users, Arlo not in the meeting | One button that asks the host through Zoom |
| Waiting | Whoever clicked, while Arlo is not in the meeting yet | "Waiting for the host to allow Arlo…" or "Bringing Arlo in…" |
| Live notes | An owner, while Arlo is or was in the meeting | Status line with Pause / Resume / Remove Arlo / Bring Arlo back, the notes, Ask Arlo, link to the meeting record, and next to it "Post notes to chat" (posts the notes to the Zoom meeting chat for everyone after an inline "Post" / "Cancel" confirm; at most 4000 characters, `notesToChatMessage` in `lib/notesText.js`; only with notes and when the client has `sendMessageToChat`). Pause, Resume and Remove only while the owner's own stream is live (`myStreamLive`); when it has stopped and Arlo is still here through another person's stream: "Arlo is in the meeting", "Your own Arlo has stopped. Notes continue from another person's." and the one action "Bring Arlo back". When a participant asks for the notes, a sheet rises over the notes (`ApprovalSheet`, the notes dimmed and inert behind it): "Share the notes in the meeting chat?", who asked, "Share notes" and "Not now", with a countdown. "Share notes" posts the notes to the chat from this panel (same code as "Post notes to chat", `lib/postNotes.js`) and reports whether it worked; Escape is "Not now"; it disappears when another owner answered or it ran out. Never answered without the click |
| Participant | Everyone else, guests included | Who brought Arlo in, the meeting record link, Ask Arlo when the owner chose "anyone" (signed-in users only), otherwise "Only people using Arlo can ask in this meeting." Never the notes, and no controls. A signed-in participant has one quiet action while Arlo is here, "Ask <owner> for the notes" ("Ask for the notes" without a name): it asks the owners to share the notes in the meeting chat, and a status line then says where the request is (asked, shared, declined, no answer, could not be posted); the button returns two minutes after an outcome. It does not depend on `ALLOW_OWN_ARLO_STREAM` and shows above "Use Arlo yourself" (both show by default). Unless the deployment sets `ALLOW_OWN_ARLO_STREAM=false` (offered by default, see the known gap below), a signed-in participant also has "Use Arlo yourself": it starts a stream of their own on the click (`startRTMS`), shows the wait or the reason it failed in place of the button, and the notes screen follows when the server says they are an owner. A guest gets "Sign in to ask Arlo" instead |
| After the meeting | An owner with notes | The notes, "Copy notes", the demo-mode line |
| Meeting record | Everyone in the meeting (`/meeting/:id/record`, `/guest-meeting/:id/record`) | Transcript and timeline in time order; a toggle for "Only Arlo's actions" |

- An **owner** is an Arlo user who ran a stream of their own in the meeting. The server decides this from the stream's `operator_id` and the Zoom user id from Arlo's sign-in (`backend/src/services/arloPresence.js`). Someone stays an owner after their stream stops, until the meeting's data is flushed. If no operator is signed in to Arlo, nobody is an owner.
- Several people can each use Arlo in one meeting: each runs a stream of their own and is an owner. The panel's stream machine (`lib/rtmsMachine.js`) also follows other people's streams, so a start asked for while Arlo is already in the meeting is marked `alongside`: another stream's lines and statuses do not confirm it, only `arlo.state` with `role: 'owner'` and `myStreamLive: true` does. Each owner's panel sets Zoom's indicator for the stream it started itself.
- The controls are for owners only, also when a host or co-host is not an owner: the Apps SDK's pause and stop act on the caller's own stream. A host stops other people's streams with Zoom's own controls.
- Frontend routes: `/meeting/:id` and `/guest-meeting/:id` → `ArloMeetingView`; `…/record` → `MeetingRecordView`; `/meeting/:id/classic` → the earlier dashboard (`InMeetingView`), linked from Settings only while in a meeting.
- Home in demo mode shows the name, "Demo mode: meetings and notes are not stored." and how to bring Arlo in (inside a meeting: a link back to it). The header's search button is hidden while the search feature is off.

### Several streams in one meeting

Several Zoom users can each run a stream in the same meeting, each with its own stream id under the same meeting UUID. The server stores one transcript per meeting (`backend/src/services/meetingStreams.js`):

- No stream is trusted over another. A line from any stream of the meeting (also one just reported stopped: its lines can still be on their way) is stored, unless it is a copy of a line stored a moment ago from another stream. Losing a line is worse than storing one twice, so a line is dropped only when it is known to be a copy.
- What a copy is: a short per-meeting memory of stored lines (the last 300 lines or 2 minutes) holds for each line the speaker id, a sha256 of the text, its start time, when it arrived and which streams have delivered it. A line from stream S is a copy when the speaker and text match a remembered line that S has not delivered yet, and they are close in time: start times within 5 seconds when both have one, otherwise arrivals within 10 seconds. With several candidates the oldest is taken. So the same words said twice in a row on one stream are two lines, and a stream that is lines ahead or behind, stops, dies without a word or never delivers loses nothing. A copy that arrives outside those windows is stored again. The memory goes with the meeting's flush.
- Participant events arrive once per stream too and are kept once by the same rule: same event type and participant id (the name when there is no id), from a stream that has not reported it yet, within 10 seconds.
- The primary stream is a live stream of the meeting's original host (`is_original_host` on the webhook) when there is one, otherwise the live stream that started first. It decides nothing about what is stored: its operator is the owner named first (`ownerName`), and its connection trouble ("Reconnecting…") is the meeting's. While the panels show "Reconnecting…", data from another running stream tells them a stream is running.
- Each stream's operator is remembered, also after the stream stopped, until the meeting is flushed. Every operator who is signed in to Arlo is an owner and gets the notes.
- The rtms service says with every line and participant event whose stream it is (`streamId`, `operatorId`, `originalHost`). A backend that restarted mid-meeting learns the streams and their owners from the next line, and tells the lifecycle and the panels once that the meeting is running.
- When the same user starts a new stream, the rtms service leaves their old one and reports it stopped with `replaced: true` (an internal-only field, validated as a boolean). The backend keeps it as a stopped stream, so a late line from it does not count as a new stream. When it was the meeting's only stream, the backend does not show a stop to the panels or tell the lifecycle yet: it waits for the new stream's outcome. `rtms_started` → the meeting ran all along (the panels get their `rtms_started`, no "stopped"). `rtms_failed` or a stop for the new stream → that is the meeting's stop. Nothing within 90 seconds → the stop is reported then. The wait ends with the meeting's flush.
- Pause is per stream: each user pauses their own. `POST /api/rtms/status` with `rtms_paused` / `rtms_resumed` from a browser is accepted only from a signed-in user who holds the `meetingAccess` cookie for that meeting and runs a live stream of their own there (their Zoom user id is a live stream's operator); otherwise 403. It marks that stream. A line from a stream clears its mark (it is running after all; lines within 3 seconds of the pause report were still on their way and do not count), and a stream that stops loses it. The meeting is paused (`meeting.status` `rtms_paused`, `arlo.state.paused`) only when at least one stream is live and every live stream is paused; the panels are told once when that answer changes, not per report.

**Known gap, several people using Arlo at once (seen 2026-11-23).** The server side above is built and tested, but it depends on Zoom sending `meeting.rtms_started` (with `operator_id`) for every person's start. In a real meeting with two users of the app, the second person's start was allowed by the host and Zoom showed their app as connected, yet no second `meeting.rtms_started` reached the webhook endpoint. The only trace was a session-added event (`onSessionUpdate`, op 1) on the first person's RTMS connection, which names a session and a stream but no user. Without the webhook Arlo cannot join that stream or tell whose it is, so the second person never becomes an owner. "Use Arlo yourself" is offered by default all the same (`ALLOW_OWN_ARLO_STREAM=false` hides it). When no webhook arrives, the second person sees "Bringing Arlo in…" (or the wait for the host), then a message that Arlo has not joined, ending in "Try again", and stays on the participant view: they never get the notes screen from a start the server did not hear of, and the first person's Arlo is not affected. They can still ask the owner for the notes. A second stream started by someone who does get a webhook (for example with Zoom's own controls) is still handled as described above.

### Live notes

`backend/src/services/notesEngine.js` writes one notes document per meeting (summary, decisions, action items) from the stored transcript:

- Nothing runs for a meeting without an owner, or while no owner has a panel open in that meeting. The lines wait; a run follows when an owner's panel connects.
- The first run happens when 5 lines are stored or one interval after the first line, whichever is first. After that at most one run per `NOTES_INTERVAL_MS`, and only when there are new lines.
- Each run gives the model (`NOTES_MODEL`) the notes so far and the new lines. The answer is treated as untrusted input and rebuilt from the known fields.
- A failed run keeps the old notes and is tried again after the interval (two minutes when the models are rate limited). After 5 failed runs in a row nothing is tried until a new line is stored.
- The notes live in the meeting store and are sent as `notes.updated` only to sockets of owners whose verified meeting is this one.

### Stream failover and reconnection

Rules live in `rtms/src/sessions.js` (tested with a fake client in `rtms/test/sessions.test.js`) and follow Zoom's [failover guide](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/). The backend forwards `meeting.rtms_started`, `rtms_stopped` and `rtms_interrupted` to the rtms service, which owns the connection and reports what happened.

| Signal from Zoom | What Arlo does | Panel shows |
|---|---|---|
| `meeting.rtms_started` again for a stream it holds (server failover) | Rejoins at once with the new `server_urls` | Reconnecting… |
| `meeting.rtms_interrupted` (signaling dropped, ~60s window) | Rejoins after a backoff: 3s, 6s, 12s, 24s, 30s; gives up after 5 attempts | Reconnecting… |
| Media connection interrupted (~30s window) | Same rejoin: the `@zoom/rtms` SDK has only `join()`/`leave()`, so there is no media-only reconnect | Reconnecting… |
| Zoom refuses a join with a status code (16 seen on a start a few seconds after a stop) | Retries with the same backoff, on a first join too. If Zoom ends the stream meanwhile, that is reported as a fault | Starting…, then live or the fault message |
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
- `storage/` — The meeting store (transcript segments and timeline per meeting). One in-memory implementation; a database implementation plugs in behind the same interface
- `services/meetingLifecycle.js` — When a meeting's in-memory data is flushed
- `services/meetingStreams.js` — The streams of each meeting, which one the transcript is taken from, and who ran one
- `services/arloPresence.js` — Who brought Arlo in (the owners), the "who can ask" setting, and what each panel is told
- `services/notesEngine.js` — When the live notes are written again, and validation of the model's answer
- `services/approvals.js` — Requests that an owner answers in their panel (one kind today, `share_notes`: a participant asks for the notes). In memory per meeting, each open for `APPROVAL_EXPIRY_MS` (default one minute), at most 20 open per meeting, one per person every 2 minutes; flushed with the meeting (the lifecycle's `onForget`). Never logs a name or a user id
- `routes/arlo.js` — Arlo's routes for one meeting (state, settings, notes, ask, notes-request, approvals)
- `routes/` — auth, meetings, arlo, ai, home, rtms, search, highlights, zoom-meetings, preferences, tokens
- `services/` — auth (token/PKCE/encryption), openrouter (LLM), websocket (broadcast)
- `middleware/auth.js` — `requireAuth` and `optionalAuth` session middleware

### Frontend (`frontend/src/`)
- `App.jsx` — HashRouter, route definitions, provider hierarchy: Theme → ZoomSdk → Auth → Meeting → Arlo → Toast
- `index.css` — Design tokens, typography (Source Serif 4 + Inter), light/dark theme variables
- `views/` — ArloMeetingView (the in-meeting screens), MeetingRecordView, InMeetingView (the classic dashboard), Auth, Home, Settings, and the views that need stored meetings (MeetingsList, MeetingDetail, SearchResults, Upcoming)
- `components/arlo/` — The Arlo screens' parts: BringArloIn, AskHost, LiveNotes, NotesDocument, StatusLine, AskArlo, PostNotesToChat, ApprovalSheet, ParticipantView, AfterMeeting
- `lib/arloScreen.js` — Which screen to show, and who may control Arlo (owners only). `lib/notesText.js` — notes as plain text. `lib/postNotes.js` — the one place the notes are posted to the meeting chat. `lib/approvalKinds.js` — per kind of approval, the sheet's texts and what agreeing does (a kind that is not listed is not shown and is left to expire). `lib/copyText.js` — copy with a fallback for webviews without the clipboard API
- `contexts/` — AuthContext (session), ZoomSdkContext (SDK init), MeetingContext (active meeting + WS, `meetingEnded`), ArloContext (Arlo's state, notes, ask, settings, the owner's `approvals` queue and a participant's `notesRequest`), ServerSettingsContext (demo mode flags)
- `hooks/useZoomAuth.js` — In-client OAuth PKCE flow hook
- `lib/dynamicIndicator.js` + `hooks/useDynamicIndicator.js` — Zoom's Dynamic Indicator (status text in Zoom's meeting window, seen by everyone). Basic version: text only, set by the panel that started the stream, only for confirmed state: "Arlo is transcribing" while transcription is confirmed (`rtmsPhase === 'active'`), "Arlo is paused" while that user's own stream is paused (this panel's phase is `paused`, or the server's `arlo.state` says `myStreamPaused`, which also covers a pause made with Zoom's own controls); "Arlo is thinking…" while a voice command runs; removed when the stream stops or reconnects. Silent when the client or the Marketplace config lacks `setDynamicIndicator` / `removeDynamicIndicator`
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

### Arlo in one meeting
All under `/api/meetings/by-zoom-id/:zoomMeetingId/arlo`. Every route needs the `meetingAccess` cookie for exactly this meeting; being signed in does not replace it. Who is an owner is decided on the server. Responses are `Cache-Control: no-store`.
- `GET /state` — `{ present, paused, myStreamPaused?, myStreamLive?, role: 'owner' | 'participant', ownerName, whoCanAsk }`. `paused` is the meeting as a whole (every live stream is paused); `myStreamPaused` and `myStreamLive` (booleans, owners only) are about the caller's own stream: whether it is paused, and whether it is running right now. Open to guests in the meeting (a guest is a participant)
- `PUT /settings` — `{ whoCanAsk: 'owner' | 'anyone' }`, owners only. Every panel of the meeting is told over its socket
- `GET /notes` — `{ notes: { summary, decisions, actionItems, updatedAt, throughSeqNo } | null }`, owners only
- `POST /ask` — `{ question }` (1 to 500 characters) → `{ answer }`, from the stored transcript, private to the asker. For an owner, and for other signed-in people in the meeting when the setting is `anyone`. Shares the AI rate limit. Takes no transcript and no model from the client; questions and answers are not stored or logged
- `POST /notes-request` — body `{}` → `{ id, expiresAt }`. A signed-in participant asks the owners to share the notes. 400 for an owner (they have the notes), 409 `{ error: 'no_owner' }` when nobody brought Arlo in, 409 `{ error: 'arlo_absent' }` when Arlo is not in the meeting right now, 429 when this person asked in the last 2 minutes or has a request open. Opens an approval (`services/approvals.js`) and tells the owners' panels. The server never posts to the chat and never sends notes to the asker; the asker's name is never logged
- `POST /approvals/:approvalId` — owners only (403), id a UUID. `{ approve: false }` → declined; `{ approve: true, done: true }` → approved (the owner's panel posted the notes); `{ approve: true, done: false }` → failed (the post did not work). → `{ id, outcome }`. The first answer wins; 404 when unknown, closed, expired, or the meeting's data is gone
- `GET /approvals` — owners only: `{ approvals: [{ meetingId, id, kind, askedBy, expiresAt }] }`, oldest first, so a panel that reloads still shows a pending sheet
- The three routes above take JSON only (415 otherwise) and exactly the fields listed (400 otherwise)
- `GET /api/meetings/by-zoom-id/:id/transcript` and `/participant-events` — what the server holds so far (catch-up and the meeting record)

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
Server → Client: { type: 'meeting.status', data: { meetingId, status: '...', fault?: true, meetingEnded?: true } }
Server → Client: { type: 'arlo.state', data: { meetingId, present, paused, myStreamPaused?, myStreamLive?, role, ownerName, whoCanAsk } }
Server → Client: { type: 'notes.updated', data: { meetingId, notes } }
Server → Client: { type: 'arlo.approval', data: { meetingId, id, kind: 'share_notes', askedBy: name | null, expiresAt } }
Server → Client: { type: 'arlo.approval.closed', data: { meetingId, id, outcome: 'approved' | 'declined' | 'failed' | 'expired' } }
Server → Client: { type: 'participant.event', data: { meetingId, event: {...} } }
```

- `meetingEnded: true` on a stop means the meeting is over and its data is deleted now. The panel keeps the notes it already has (the "after the meeting" screen).
- `arlo.state` differs per person (`role`, `myStreamPaused`, `myStreamLive`). `paused` is the meeting-level value: true only when every live stream is paused. `myStreamPaused` is sent to owners only and says whether their own stream is paused; with two streams it can be true while `paused` is false, because the other stream still delivers. `myStreamLive` is sent to owners only and is true while a stream whose operator is that user runs in this meeting; someone stays an owner after their stream stops, so it can be false while `present` is true (another person's stream still runs). The state is sent when a socket connects or subscribes, when a stream starts, stops, is paused or resumed, and when the setting changes.
- `notes.updated` goes only to owners' sockets whose verified meeting is this one. A guest's socket never gets it.
- `arlo.approval` goes only to those same owners' sockets. `arlo.approval.closed` (an owner answered, or nobody did before `expiresAt`) goes to the owners' sockets and to the sockets of the person who asked, each verified for this meeting, and to nobody else. When the meeting's data is flushed, open approvals are dropped without a message.

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
AUTO_START_RTMS=false           # true = request transcription as soon as someone opens Arlo. Off by default: a person clicks first
ALLOW_OWN_ARLO_STREAM=true      # On by default: "Use Arlo yourself" is offered to a person in a meeting where someone else already runs Arlo. false hides it. See the known gap under "Several streams in one meeting"
NOTES_MODEL=...                 # Optional. The model that writes the live notes and answers Ask Arlo. Must be one of OPENROUTER_MODELS; otherwise DEFAULT_MODEL is used
NOTES_INTERVAL_MS=45000         # Whole milliseconds, 15000 to 600000. How often the live notes are written again while new lines arrive (each run is a model call)
APPROVAL_EXPIRY_MS=60000        # Whole milliseconds, 100 to 600000. How long a request to the owner ("share the notes?") waits for an answer
MEETING_FLUSH_GRACE_MS=120000   # Whole milliseconds, 100 to 3600000. How long a meeting's in-memory data is kept after its stream stopped and the last panel disconnected
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
- **No persistent storage** — A meeting's transcript, notes and owners are held in memory while the meeting runs and deleted when it ends; nothing is saved to disk
- **Notes are private to owners** — sent only to the sockets of the people who brought Arlo in; participants and guests never receive them
- **Session cookies** — httpOnly, secure, SameSite=lax. Three kinds that cannot stand in for each other: `sessionToken` (who you are), `meetingAccess` (which meeting you are in), `sessionRestore` (encrypted, rebuilds a session after a restart)
- **HMAC verification** — All Zoom webhooks verified with timing-safe comparisons
- **Rate limiting** — Global, auth, and AI endpoint limits via `express-rate-limit`
- **WebSocket auth** — verified meeting-access cookie required for all connections

**Privacy Notice:** Arlo keeps a meeting's transcript and notes in memory while the meeting is running, and they are deleted when the meeting ends. Nothing is written to disk or kept between meetings. Transcript text is sent to the configured AI provider to produce notes and answers; that provider's retention terms apply to what it receives.

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
