# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Arlo Meeting Assistant** is an open-source Zoom Apps reference implementation demonstrating how to build intelligent meeting assistants that capture real-time transcripts using RTMS (Real-Time Media Streams) — **without requiring a meeting bot**. The app runs natively inside Zoom meetings and provides AI-powered summaries, action items, and real-time AI suggestions.

**IMPORTANT - Demo Mode:** This version runs in **secure demo mode** with **no database**. A meeting's transcript, timeline and notes are held **in memory only while that meeting runs** and are deleted when it ends. Nothing is written to disk and nothing carries from one meeting to the next.

## Demo Mode Features

### Available in Demo Mode:
- **Live transcription** — Real-time via WebSocket; held in memory for the meeting so late or reconnecting panels can catch up
- **Live notes** — Summary, decisions and action items, written from the stored transcript on a timer and shown to the people who brought Arlo in, and to everyone in the meeting who has Arlo open while one of them shares the notes
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
   - Knows who brought Arlo in, writes the live notes from the stored transcript, and sends them only to those people, or to everyone in the meeting while an owner shares them

3. **RTMS Service** (`rtms/`) — @zoom/rtms v1.0.2
   - Webhook handlers for `meeting.rtms_started` / `meeting.rtms_stopped`
   - WebSocket-based transcript ingestion from Zoom

### Data Flow (Demo Mode)

```
Zoom RTMS WebSocket → RTMS Service → Backend (kept in memory for the meeting, then broadcast)
    → WebSocket broadcast → Frontend (live transcript display, < 1s end-to-end)
Panel opens late or reconnects → GET /api/meetings/by-zoom-id/{id}/transcript → what was said so far
Stored lines → notes engine (timer) → notes in the meeting store → `notes.updated` to the owners' sockets, and to every socket verified for the meeting while the notes are shared
```

**SECURITY:** Meeting data lives in memory only (`backend/src/storage/`) and is never written to disk. `backend/src/services/meetingLifecycle.js` deletes a meeting's data when:
- Zoom reports the stream stopped because the meeting ended (stop reason 6), or
- the stream is stopped and no Arlo panel has been connected for `MEETING_FLUSH_GRACE_MS` (default 2 minutes), or
- it is older than 12 hours (also while a panel is still connected), or
- the store holds 500 meetings and a new one arrives: the one written to longest ago is dropped.

Every one of these calls the lifecycle's `onForget` for the meeting once, so what other services hold per meeting (stream operators, approvals, the notes engine's and the agent's state) goes with the data.

The notes, the "who can ask" setting, whether the notes are shared (`notesShared`), what is known about the meeting's streams (and so who its owners are) and the notes engine's timer go in the same flush. A stop, pause, reconnect or restart inside one meeting keeps the data. A server restart clears everything. A transcript line that arrives within ten minutes after a meeting's data was flushed is dropped, not kept. In the ten minutes after Zoom said a meeting ended, a start or reconnect report for it is ignored too: a meeting UUID that ended does not start again.

### Arlo screens

`frontend/src/lib/arloScreen.js` picks one screen from confirmed state (a request is not a state). `views/ArloMeetingView.jsx` renders it; there are no tabs.

| Screen | Who sees it | What it shows |
|---|---|---|
| Bring Arlo in | Signed-in host or co-host, Arlo not in the meeting | "Who can ask Arlo" (only I / anyone) and one button. Nothing is requested before the click |
| Ask the host | Other signed-in users, Arlo not in the meeting | One button that asks the host through Zoom |
| Waiting | Whoever clicked, while Arlo is not in the meeting yet | "Waiting for the host to allow Arlo…" or "Bringing Arlo in…" |
| Live notes | An owner, while Arlo is or was in the meeting | Status line with Pause / Resume / Remove Arlo / Bring Arlo back (while Arlo handles a request its label says what Arlo is doing, the `step` of `arlo.thinking`, or "Arlo is thinking…" when there is none; the dot breathes and the label has a slow sheen, with one wider ring when the request was spoken; CSS only, driven by `data-thinking` / `data-heard` on the status section, still under `prefers-reduced-motion`), the notes, Ask Arlo, link to the meeting record, and next to it two quiet actions. "Share notes with everyone" makes the notes live in the panel of everyone in the meeting who has Arlo open (`PUT /settings { shareNotes: true }`, no confirm step: it is reversible); while shared the line reads "Shared with everyone in the meeting" with "Stop sharing"; the button is disabled while the request runs and a failure is an error toast. "Post notes to chat" is a one-time copy (posts the notes to the Zoom meeting chat for everyone after an inline "Post" / "Cancel" confirm; at most 4000 characters, `notesToChatMessage` in `lib/notesText.js`; only with notes and when the client has `sendMessageToChat`). A third, "Open notes for everyone", opens the notes as a document for the whole meeting in Zoom's Collaborate mode (only with notes and when the client took `startCollaborate`): the click asks inline, "Everyone in the meeting will see your Arlo view. The notes stay shared until you stop sharing." with "Open" / "Cancel"; "Open" turns sharing on (`POST /open-notes`) and then the panel calls `startCollaborate({ shareScreen: true })`. No approval sheet: it is the owner's own click. Disabled while it runs; when the server refuses nothing is opened, when Zoom refuses the notes stay shared, each an error toast. Pause, Resume and Remove only while the owner's own stream is live (`myStreamLive`); when it has stopped and Arlo is still here through another person's stream: "Arlo is in the meeting", "Your own Arlo has stopped. Notes continue from another person's." and the one action "Bring Arlo back". When a participant asks for the notes, a sheet rises over the notes (`ApprovalSheet`, the notes dimmed and inert behind it): "Share the notes with everyone in the meeting?", who asked, "Share notes" and "Not now", with a countdown. "Share notes" reports `{ approve: true }` and the server turns sharing on (nothing is posted to the chat); Escape is "Not now"; it disappears when another owner answered or it ran out. Never answered without the click |
| Participant | Everyone else, guests included | Who brought Arlo in, the meeting record link, Ask Arlo when the owner chose "anyone" (signed-in users only), otherwise "Only people using Arlo can ask in this meeting." No controls. The notes only while an owner shares them (`notesShared`): the heading becomes "<owner> is sharing Arlo's notes" ("Arlo's notes are shared with everyone" without a name), followed by the same notes document, read-only, or "Notes appear after the first minute or so." before the first notes; they disappear the moment sharing stops. A guest sees shared notes too. Shared notes stay on screen while Arlo is out of the meeting and the meeting goes on (`present: false`, also after a reload: the server keeps the notes and the flag until the meeting's data is flushed): a status line reads "Arlo has left the meeting. These are the notes so far.", the two choices and Ask Arlo are hidden, and below the Meeting record link there is one action by role, with the usual wait and failure wording in its place: "Bring Arlo into this meeting" (Zoom host or co-host; "who can ask" is left as it is), "Ask the host to bring Arlo in" (other signed-in people), "Sign in to bring Arlo in" (a guest who is host or co-host), none for other guests. With sharing off, or shared but nothing written yet, the bring-in and ask-host screens show as before. A signed-in participant has two choices while Arlo is here, two secondary buttons of equal weight with one line of explanation each. "Ask <owner> to share notes with everyone" ("Ask to share notes with everyone" without a name) asks the owners; a status line then says where the request is (asked, declined, no answer, could not be shared), the notes appear when an owner agrees, and the button returns two minutes after an outcome; it is hidden while the notes are shared and does not depend on `ALLOW_OWN_ARLO_STREAM`. "Take notes yourself" (unless the deployment sets `ALLOW_OWN_ARLO_STREAM=false`; offered by default, see the known gap below) starts a stream of their own on the click (`startRTMS`), shows the wait or the reason it failed in place of the button, and the notes screen follows when the server says they are an owner. A guest has neither and gets "Sign in to ask Arlo" instead |
| Notes for everyone | Everyone whose Arlo runs in Zoom's Collaborate mode (`inCollaborate` in `ZoomSdkContext`), in place of the notes screen and the participant view, until Collaborate ends | `components/arlo/CollaborateNotes.jsx`: a wide, centered page in larger type. "Meeting notes", "Written by Arlo · updates as the meeting goes on", then summary, decisions, action items and what Arlo did; "Notes appear after the first minute or so." before the first notes. The owner's view is what Zoom shares as a screen with people who cannot join Collaborate (no app, a browser), so nothing private is on it: no Ask Arlo, no "who can ask", no sharing or chat actions, of "Arlo did" only the public actions, and "thinking" only for a spoken request and without its step (a step can name a person or a ticket). The notes are on the page only while they are shared (`notesShared`), for the owner too: otherwise "The notes are not shared right now.". One bar: the status line and "Close for everyone" (`endCollaborate()`; sharing the notes stays as it is; a failure is an error toast). A request for the owner's approval rises over it as a reduced sheet (`ApprovalSheet` with `reduced`): the fixed heading "Arlo needs your OK", the countdown, "Close the shared notes to see this request.", "Close for everyone" (`endCollaborate()`) and "Not now". Who asked, what was asked, the server's question and the text to post are not rendered, and it cannot be agreed to; when Collaborate has ended and the request is still open, the full sheet follows as a sheet that has just opened. Everyone else reads the same page with "Leave" (`leaveCollaborate()`), no asks and no choices. "Stop sharing" on the notes screen also calls `endCollaborate()` and ignores its failure; and when sharing stops while an owner's panel is in Collaborate (another owner stopped it), that panel calls `endCollaborate()` itself, once, failure ignored. While in Collaborate the app stays on this screen: the shell shows no header (back, logo, search, settings) and no live-meeting banner, and every other route goes back to the meeting's Arlo screen (`components/CollaborateGuard.jsx`, `collaborateRedirect` in `lib/collaborate.js`; `/` and `/auth` are left alone while the app starts or signs in). Toasts still show. Transcription is never requested by itself there (`AUTO_START_RTMS` waits until Collaborate has ended) |
| After the meeting | Whoever holds notes: an owner, or a participant or guest who was reading shared notes | The notes, "Copy notes", the demo-mode line. For a participant the heading is "Notes from this meeting". Held until the panel moves to another meeting or the session ends |
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
- Each stream's operator is remembered, also after the stream stopped, until the meeting is flushed. Every operator who is signed in to Arlo is an owner and gets the notes. Any owner can share them with everyone, or stop.
- The rtms service says with every line and participant event whose stream it is (`streamId`, `operatorId`, `originalHost`). A backend that restarted mid-meeting learns the streams and their owners from the next line, and tells the lifecycle and the panels once that the meeting is running.
- When the same user starts a new stream, the rtms service leaves their old one and reports it stopped with `replaced: true` (an internal-only field, validated as a boolean). The backend keeps it as a stopped stream, so a late line from it does not count as a new stream. When it was the meeting's only stream, the backend does not show a stop to the panels or tell the lifecycle yet: it waits for the new stream's outcome. `rtms_started` → the meeting ran all along (the panels get their `rtms_started`, no "stopped"). `rtms_failed` or a stop for the new stream → that is the meeting's stop. Nothing within 90 seconds → the stop is reported then. The wait ends with the meeting's flush.
- Pause is per stream: each user pauses their own. `POST /api/rtms/status` with `rtms_paused` / `rtms_resumed` from a browser is accepted only from a signed-in user who holds the `meetingAccess` cookie for that meeting and runs a live stream of their own there (their Zoom user id is a live stream's operator); otherwise 403. It marks that stream. A line from a stream clears its mark (it is running after all; lines within 3 seconds of the pause report were still on their way and do not count), and a stream that stops loses it. The meeting is paused (`meeting.status` `rtms_paused`, `arlo.state.paused`) only when at least one stream is live and every live stream is paused; the panels are told once when that answer changes, not per report.

**Known gap, several people using Arlo at once (seen 2026-11-23).** The server side above is built and tested, but it depends on Zoom sending `meeting.rtms_started` (with `operator_id`) for every person's start. In a real meeting with two users of the app, the second person's start was allowed by the host and Zoom showed their app as connected, yet no second `meeting.rtms_started` reached the webhook endpoint. The only trace was a session-added event (`onSessionUpdate`, op 1) on the first person's RTMS connection, which names a session and a stream but no user. Without the webhook Arlo cannot join that stream or tell whose it is, so the second person never becomes an owner. "Use Arlo yourself" is offered by default all the same (`ALLOW_OWN_ARLO_STREAM=false` hides it). When no webhook arrives, the second person sees "Bringing Arlo in…" (or the wait for the host), then a message that Arlo has not joined, ending in "Try again", and stays on the participant view: they never get the notes screen from a start the server did not hear of, and the first person's Arlo is not affected. They can still ask the owner for the notes. A second stream started by someone who does get a webhook (for example with Zoom's own controls) is still handled as described above.

### Live notes

`backend/src/services/notesEngine.js` writes one notes document per meeting (summary, decisions, action items) from the stored transcript:

- Nothing runs for a meeting without an owner, or while no panel that may see the notes is open in that meeting: an owner's, or anyone's while the notes are shared. The lines wait; a run follows when such a panel connects or the notes become shared. The engine is told through an injected function (`hasNotesReaderPanel` in `services/websocket.js`); it does not know sockets or sharing.
- The first run happens when 5 lines are stored or one interval after the first line, whichever is first. After that at most one run per `NOTES_INTERVAL_MS`, and only when there are new lines.
- Each run gives the model (`NOTES_MODEL`) the notes so far and the new lines. The answer is treated as untrusted input and rebuilt from the known fields.
- A failed run keeps the old notes and is tried again after the interval (two minutes when the models are rate limited). After 5 failed runs in a row nothing is tried until a new line is stored.
- The notes live in the meeting store and are sent as `notes.updated` to sockets of owners whose verified meeting is this one. While the meeting's `notesShared` is true they also go to every other socket verified for this meeting, signed in or a guest. Decided per socket at the time of sending, so stopping sharing stops delivery at once. `GET /notes` follows the same rule.
- Sharing (`notesShared` in the meeting's meta, false by default, flushed with the meeting) is turned on or off by an owner: `PUT /settings { shareNotes }`, or by approving a participant's request. Both go through one function (`shareNotes` in `routes/arlo.js`): it logs one line without names, tells every panel the new state, and when turned on sends the notes so far, answers the requests that were still open and wakes the notes engine.

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
- `services/agent/` — Arlo's agent: what happens to a request typed in a panel (`POST /ask`) or heard in the transcript ("Arlo, …", `commandDetector.js`). The transcript is text anyone in the meeting can speak into and a model's output is untrusted, so the rule is: **nothing is posted to the meeting chat, and nothing else changes the meeting, unless an owner has seen exactly what will be posted or done and pressed the button on their own panel, or typed the request themselves in their own panel.** How it is kept (`agent.js`, `policy.js`, `tools.js`, `texts.js`):
  - The model that picks a tool (`openrouter.chooseTool`) gets the request, cleaned and capped, and the tool list. No transcript, no notes: tool arguments can only come from the request.
  - Nothing spoken runs without the approval sheet, also for a speaker verified by `AGENT_SPEAKER_MATCH` and under "Anyone can ask". A spoken question or summary is written first, cleaned, and shown as the sheet's `body` ("Post Arlo's answer in the meeting chat?" / "Post answer"); approving posts that text byte for byte, with no second model call. One sheet per request. Declined, expired or turned away: the action log only. Arlo posts no line of its own to the chat ("busy", "the host declined").
  - An owner's typed request for a tool that changes the meeting runs without a sheet only when what it does is in what they typed (`typedRequestCovers` in `policy.js`). A model picked the tool, so the check is strict: when in doubt, the sheet. It reads the cleaned request, the same string the model was given, once more as NFKC, without invisible format characters (`\p{Cf}`: a soft hyphen or zero-width space hides nothing), every apostrophe the plain one, lower case, single spaces. Two things are shared by the rules below. The polite words that may stand around a plain request (`isPlainRequest`): "Arlo" or "Hey Arlo" with or without a comma, "can you" / "could you" / "would you", "please" before; "please" (with or without a comma) and one "." or "!" after, or one "?" only when the request began with "can you" / "could you" / "would you". The negation words (`NEGATION`), which send a request to the sheet wherever they stand: not, no, never, stop, without, cannot, dont, cant, wont, shouldnt, wouldnt, couldnt, doesnt, didnt, isnt, arent, wasnt, avoid, skip, unless, instead, rather, nobody, nothing, none, neither, nor, and any word ending in "n't". Per tool:
    - `post_to_chat`: the message occurs exactly once in the typed text (compared without case and whitespace), and what is left around it is a small frame and nothing else (`isPlainPost`): one of the verbs post, write, send, say, put; "this" or "that"; the chat named at most once, before or after the message ("in / to / into (the) (meeting) chat"); a ":" or "," before the message, quotes around it; the polite words. "post hello team", "write hello team in the chat", "post this in the chat: hello team" are covered; "dont post hello team", "what does hello mean", "post hello team to Danny", "should I post hello team?" get the sheet.
    - `share_notes`: the typed text as a whole is "share the notes", "share notes", "share arlo's notes" or "share my notes", each with or without " with everyone" / " with everybody" / " with the meeting" / " with all", and the polite words. "share the notes with Danny only", "un-share the notes", "should I share the notes?", "share my screen", "share them" get the sheet.
    - `invite_everyone`: never covered. It shares the notes and sends an invitation, and only the sheet says both, so an owner's typed "invite everyone" gets the sheet too.
    - `send_reaction`: a word of that reaction as a whole word (a letter, digit, "_" or "-" next to it makes it part of another word: "glove", "wowza", "third-party", "enjoy", "thumbnail" cover nothing), or that reaction's emoji itself (👍 👏 ❤️ 😂 🎉 😮), and no negation word. `thumbs_up`: "thumbs up", "thumb up", "thumbs-up" (not "thumbs down"); `clap`: clap, claps, clapping, applause, applaud; `heart`: heart or love, not after "broken "; `joy`: laugh, laughing, laughter, joy; `tada`: celebrate, celebration, party (not after "third "), tada; `open_mouth`: wow, surprise, surprised.
    - `mute_participant`: the typed text as a whole is "mute <name>", where the name equals the tool's `name` as a whole after the same normalization. Around it only the polite words above. So "mute Danny Lee" covers the name "Danny Lee" and not "Danny"; "unmute Danny Lee" (however it is written), "don't mute Danny Lee", "mute everyone except Danny Lee", "mute Danny Lee and Sam", "is Danny Lee muted?" all get the sheet "Mute Danny Lee?".
    - `admit_from_waiting_room`: the same strictness for "admit <name>" and "let <name> in", each with or without "from the waiting room".
    - `open_ticket`: its key among the ticket keys in the typed text (`ticketKeysIn` in `lib/jira.js`), a word that opens as a whole word ("open", "pull up", "bring up", "show"), and no negation word, with or without sharing ("close PROJ-123", "what is PROJ-123 about", "open PROJ-123, don't share" get the sheet). With `share: true` also "share" or "sharing" as a whole word, not after a hyphen ("screen share", "screen-share" and "screenshare" count; "shared drive", "shares", "un-share" do not). A typed key is a project and a number with a dash, an underscore or the word "dash" / "hyphen" between them in any case ("proj-123", "PROJ dash 123"); with only a space between them the project must be typed in upper case ("open PROJ 123"), so "open ticket 42", "in 5 minutes" and "version 2" are no key. (The key a model gives as the tool's argument is still read as before, `normalizeTicketKey`.)
    - `set_timer`: the word "timer" as a whole word; a verb that starts one as a whole word (set, start, put, give), or the bare form and nothing else but the polite words ("5 minute timer", "a ten minute timer", "timer for 5 minutes", "timer 5 minutes"); no negation word and none of cancel, end, skip, add, extend, remove, pause, restart, left, stop ("cancel the 5 minute timer", "add 5 minutes to the timer", "is there a 5 minute timer?", "start a timer when I stop talking" get the sheet); and a length of time in the typed text that is exactly the tool's `minutes` (`minutesIn` in `policy.js`): digits or a number word (one to twenty, thirty, forty-five, sixty, ninety) followed by "minute(s)", "min(s)" or "hour(s)" (N × 60, up to 120), "an hour" (60) or "half an hour" (30). Two different lengths, seconds, more than two hours, a digit right before the amount ("timer 1 5 minutes"), or an amount that is not read for sure ("twenty five minutes", "1.5 minutes", "a minute", "an hour and a half") get the sheet.
    - `stop_timer`: the typed text as a whole is "stop / cancel / end the timer" or "stop / cancel / end timer", with the polite words ("when does the timer end?", "shouldnt cancel the timer", "stop the timer in 5 minutes" get the sheet).

    Otherwise the owner gets the sheet too. `handle()` then answers `waiting_approval` with `askerIsAsked: true` and `POST /ask` says "Check the request on your screen and confirm it."; anyone else who typed (and an owner whose panel does not get a host-only sheet) is answered "I asked the person who brought Arlo in to approve that.".
  - Three tools act in the meeting through the owner's panel (`tools.js`, sentences in `texts.js`). `invite_everyone` (no arguments; sheet "Share the notes and invite everyone to open Arlo?" / "Share and invite") always goes to the sheet, also for an owner's own typed request. When an owner agrees, the server first checks that a panel of that owner announced `invite_everyone` (`hands.whoCan`); without one it fails as `no_hands` ("Open Arlo to let it do that.") and sharing is not turned on. Then it turns `notesShared` on, the same way `share_notes` does (`shareNotes` in `services/notesSharing.js`, as the owner who approved; already on counts), then sends that owner's panel the action `invite_everyone` with `{}`. When sharing cannot be turned on, nothing is sent to a panel. When the panel then does not send the invitation (any code, also a panel that went away meanwhile), the notes stay shared and the action ends as failed with the label "Shared the notes. Couldn't send the invitation.". `send_reaction` (`{ reaction }`, one of `thumbs_up`, `clap`, `heart`, `joy`, `tada`, `open_mouth`; sheet "Send a 👍 reaction as you?" / "Send 👍"): the model picks a name from the list, the server checks it again (anything else is no tool), and the emoji shown is from the server's table (`REACTIONS`), never from the model. `mute_participant` (`{ name }`, 1 to 100 characters, cleaned like the name to admit; sheet "Mute <name>?" / "Mute"): needs a host's or co-host's panel and follows everything admitting does; it only mutes, one person. The panel finds the person by name, for muting and admitting alike (`comparable` and `theOneNamed` in `frontend/src/lib/arloActions.js`): names are compared as NFKC, without format characters (`\p{Cf}`: zero-width space and joiners, soft hyphen, direction marks), lower case, single spaces, so "Danny Lee" and "Danny Lee" plus a zero-width space are one name. Exactly one person must have the whole name. `several_match` when more than one has it, when someone's name begins with it as whole words (asked "Danny", present "Danny Lee", also beside a "Danny"), or when the asked name mixes Latin letters with Cyrillic or Greek ones in one word (a look-alike; a name wholly in one script works as before, and a name written wholly in look-alike letters of another script is not caught). A list of more than 1000 people is not looked through in part: `sdk_error`. Not found is answered "I couldn't find <name> in the meeting.", several matches with a request for the full name. The limits below apply to all three unchanged.
  - `open_ticket` (`{ key, share }`: a key of at most 40 characters and a boolean; `runs: 'panel'`, changes the meeting because a screen share is seen by everyone, no host needed) opens a Jira ticket in the system browser of the owner who typed or approved it and, with `share: true`, brings up Zoom's share dialog, where that owner picks the window (the SDK cannot pick one). It is in the tool table only when `JIRA_BASE_URL` is set (`jiraBaseUrl` in `tools.js`, read at call time like web search); without it there is no such tool and nothing detects a ticket request. The key a model gives is untrusted and rebuilt (`normalizeTicketKey` in `lib/jira.js`): printable ASCII only, trimmed, a to z made upper case, and what stands between the project and the number (a dash with or without spaces, the word "dash" or "hyphen" between spaces, a run of spaces or underscores) becomes one "-"; then it must match `^[A-Z][A-Z0-9]{1,9}-\d{1,7}$`, otherwise the call is no tool (a URL, a path, a look-alike letter, a control character). `share` must be `true` or `false` as such. A model or a speaker never supplies a URL: the server builds `jiraBaseUrl + '/browse/' + key` (`ticketUrl`) and sends the panel `{ url, key, share }`; the URL is in no sheet, label, step or log line. Sheet (spoken, or typed and not covered), no `body`: "Open PROJ-123 in your browser and share your screen?" / "Open and share", or "Open PROJ-123 in your browser?" / "Open". Step "Opening PROJ-123" (owners only). The record is read by everyone in the meeting, so its labels never carry the key: "Asked to open a ticket" while waiting and when declined, expired or failed; "Opened a ticket" or "Opened a ticket and opened the share dialog" when done. The key is only in what owners see (the sheet, the step) and in the asker's own typed answers, "Done: opened PROJ-123." and "Done: opened PROJ-123 and opened the share dialog.". The panel (`openTicket` in `frontend/src/lib/arloActions.js`) takes exactly `{ url, key, share }`, builds the URL again from the base URL in the server's settings (`features.jira.baseUrl`, passed in as a parameter) and opens it only when the two are the same text and it parses as https without credentials; `stillAllowed()` is asked before `openUrl({ url })` and again before `promptShareScreen()` (no options). When the ticket opened and the share dialog did not (no such API, Zoom refused, the panel may no longer act) the panel reports `{ ok: false, code: 'share_failed' }` and the action ends as failed with the label "Opened a ticket. Couldn't open the share dialog." and, for the owner who typed it, the answer "Opened PROJ-123. Couldn't open the share dialog.". Zoom opens only domains on the app's Marketplace allowlist (error 10015 otherwise, reported as `sdk_error`).
  - `set_timer` (`{ minutes }`: a whole number from 1 to 120; a JSON integer, or the same as plain digits, which is rebuilt as the number; "5.5" or "five" is no tool) and `stop_timer` (no arguments) are in every deployment's table: `runs: 'panel'`, change the meeting, no host needed. A timer is Zoom's own countdown on the Dynamic Indicator, seen by everyone. Sheet (everything spoken, or typed and not covered), no `body`: "Start a 5 minute timer for everyone?" / "Start timer"; "Stop the timer?" / "Stop timer". Steps "Starting a 5 minute timer" / "Stopping the timer". Record: "Asked to start a 5 minute timer" / "Started a 5 minute timer", "Asked to stop the timer" / "Stopped the timer"; typed answers "Done: started a 5 minute timer." and "Done: stopped the timer.". The server checks the minutes again before it sends the panel `{ minutes }` or `{}`. The panel (`setTimer` / `stopTimer` in `frontend/src/lib/arloActions.js`) takes exactly those arguments, asks `stillAllowed()`, and calls `setDynamicIndicator({ text: 'Timer', timer: { action: 'start', direction: 'down', start: minutes * 60, showNotification: true, withSound: false } })`; stopping is `removeDynamicIndicator()`. Zoom refusing either is `sdk_error`. Any owner's panel may start one, also one that does not own the indicator.
  - Everything posted goes through one function (`postLine`): "Arlo: " + text cleaned by `chatText` (NFC, control and invisible characters removed, every line break and run of whitespace one space, an "Arlo:" at its start stripped, at most 500 characters for an answer, cut at a word with "…", and 300 for a `post_to_chat` message; empty → not posted, the action failed).
  - `open_notes_for_everyone` (no arguments, a panel's tool, no host needed) opens the notes for the whole meeting as a document in Zoom's Collaborate mode. Always the sheet, also for an owner's typed request (never in `typedRequestCovers`, like `invite_everyone`): "Open the notes for everyone in the meeting? Your Arlo view will be shared, and the notes stay shared until you stop sharing." / "Open notes", no `body`. After approval, in this order: the owner who agreed must have a panel that announced the tool (else `no_hands`, "Open Arlo to let it do that.", nothing shared), the server turns `notesShared` on through the injected `shareNotes`, then that panel is sent the action with `{}` and calls `startCollaborate({ shareScreen: true })`. When Zoom refuses, the panel reports `sdk_error` and does nothing in its place (no invitation: the sheet asked for none); that and every other failure after the notes were shared ends the action as failed with "Shared the notes. Couldn't open them for everyone.". Sharing stays on. `share_notes` only makes the notes visible in Arlo; `invite_everyone` only sends the invitation.
  - The notes feed a summary only for an owner's own typed request (private to them) or while the notes are shared with everyone; otherwise it is written from the transcript.
  - `answerFromTranscript` puts the transcript and the question in marked blocks as data (`buildAskPrompt` removes a marker inside either), and asks for plain sentences without links nobody said.
  - An action that needs the Zoom Apps SDK (`hands.js`: post to chat, admit, invite everyone, send a reaction, mute, open a ticket, start or stop a timer) runs only on a panel of the owner who typed the request or pressed the approval, never on another owner's, host or not. A panel announces what it can do (`arlo.hands`: its Zoom role and a list of at most 10 names, each one of `post_to_chat`, `admit_from_waiting_room`, `invite_everyone`, `send_reaction`, `mute_participant`, `open_ticket` (announced when the client has `openUrl` and the settings name a Jira), `set_timer` and `stop_timer` (announced when the client took the Dynamic Indicator APIs); a host's panel with everything announces eight; an announcement with any other name is refused as a whole). When that owner has no panel that announced the tool (or, for admitting and muting, is not host or co-host) it fails as `no_hands`: "Arlo needs the host's panel for that." for admitting and muting, "Open Arlo to let it do that." for a reaction, a ticket and a timer, "Open Arlo to let it post in the chat." otherwise (the action's label and the typed answer; for inviting, "Open Arlo to let it do that." when no panel of that owner announced it, checked before anything is shared, and "Shared the notes. Couldn't send the invitation." when the panel fails after the notes were shared). The sheet for admitting or muting goes only to owners whose panel announced it as host or co-host (only they find it in `GET /approvals` and may answer it); with none there is no sheet and it fails at once.
  - Limits, all in memory and gone with the meeting: spoken requests 20 per meeting per 10 minutes; typed requests 30 per person per meeting per 10 minutes (speech cannot use up what someone may type); one request handled at a time and 3 waiting; at most 5 `agent_action` sheets open per meeting (a further request is dropped and recorded as failed, "Too many requests are waiting"); 500 actions in the record, where at the cap the oldest ended one is dropped and a new one is refused only when all 500 are still open; 20 seconds per model call or panel action, after which the model request is aborted (`AbortSignal`, also when the meeting's data goes).
  - `arlo.thinking` goes to all owners for a spoken request; for a typed one only to the owner who typed it (nobody when the asker is not an owner). With `on: true` it says what Arlo is doing right now (`step`) and how it was asked (`channel`), and it is sent again each time the step changes. A step is one of the server's own sentences (`STEPS` and `toolStep` in `texts.js`), picked by where the run is, never text from a model: "Heard a request" (spoken, before any model call), "Working out what was asked" (a model picks a tool), "Writing an answer", "Writing a summary", "Posting to the meeting chat", "Sharing the notes with everyone", "Admitting <name> from the waiting room", "Inviting everyone to open Arlo", "Sending a reaction", "Muting <name>". The name is the only variable part: it comes from the request, goes through `cleanName` (`lib/displayName.js`) and is cut to 60 characters; a name that cannot be shown gives "Admitting someone from the waiting room" or "Muting someone". Thinking is off while a sheet waits for an owner; the approved run is a turn of its own and starts with the step of what it does. The step is never logged.
- `services/approvals.js` — Requests that an owner answers in their panel (two kinds: `share_notes`, a participant asks the owners to share the notes with everyone and approving turns `notesShared` on, on the server; `agent_action`, something Arlo was asked that an owner has to see and agree to, see `services/agent/`). In memory per meeting, each open for `APPROVAL_EXPIRY_MS` (default one minute), at most 20 `share_notes` and 5 `agent_action` open per meeting (counted apart, so neither crowds out the other), one `share_notes` per person every 2 minutes; flushed with the meeting (the lifecycle's `onForget`). `tryOpen()` says why a request is refused (`too_soon`, `too_many_open`, `invalid`). Never logs a name or a user id
- `routes/arlo.js` — Arlo's routes for one meeting (state, settings, notes, ask, notes-request, approvals)
- `routes/` — auth, meetings, arlo, ai, home, rtms, search, highlights, zoom-meetings, preferences, tokens
- `services/` — auth (token/PKCE/encryption), openrouter (LLM), websocket (broadcast)
- `middleware/auth.js` — `requireAuth` and `optionalAuth` session middleware

### Frontend (`frontend/src/`)
- `App.jsx` — HashRouter, route definitions, provider hierarchy: Theme → ZoomSdk → Auth → Meeting → Arlo → Toast
- `index.css` — Design tokens, typography (Source Serif 4 + Inter), light/dark theme variables
- `views/` — ArloMeetingView (the in-meeting screens), MeetingRecordView, InMeetingView (the classic dashboard), Auth, Home, Settings, and the views that need stored meetings (MeetingsList, MeetingDetail, SearchResults, Upcoming)
- `components/arlo/` — The Arlo screens' parts: BringArloIn, AskHost, LiveNotes, NotesDocument, StatusLine, AskArlo, PostNotesToChat, ShareNotes, ApprovalSheet, ParticipantView, AfterMeeting, OpenNotesForEveryone, CollaborateNotes (the notes as a document in Zoom's Collaborate mode)
- `lib/arloScreen.js` — Which screen to show, and who may control Arlo (owners only). `lib/notesText.js` — notes as plain text. `lib/postNotes.js` — the one place the notes are posted to the meeting chat ("Post notes to chat" only). `lib/approvalNotice.js` — Zoom's notification "Arlo needs your OK" when a sheet arrives while the panel is not visible: fixed words, once per approval id and at most one per 30 seconds per panel whatever the approval (one held back is not shown later). `lib/approvalKinds.js` — per kind of approval, the sheet's texts; agreeing only reports the answer, the server does the work (a kind that is not listed is not shown and is left to expire). `lib/copyText.js` — copy with a fallback for webviews without the clipboard API. `lib/collaborate.js` — Zoom's Collaborate mode: starting it with the screen-share fallback, where the app must be while it runs (`collaborateRedirect`), and every guess about that API in one commented place (`COLLABORATE_GUESSES`)
- `contexts/` — AuthContext (session), ZoomSdkContext (SDK init; `collaborateSupported`, and `inCollaborate` while the app runs in Collaborate: `runningContext` then still reads `inMeeting`, and the context is read again on `onRunningContextChange` and `onCollaborateChange`), MeetingContext (active meeting + WS, `meetingEnded`), ArloContext (Arlo's state incl. `notesShared`, notes (an owner's, or shared ones for anyone while shared), `setShareNotes`, ask, settings, the owner's `approvals` queue and a participant's `notesRequest`), ServerSettingsContext (demo mode flags)
- `hooks/useZoomAuth.js` — In-client OAuth PKCE flow hook
- `lib/dynamicIndicator.js` + `hooks/useDynamicIndicator.js` + `lib/indicatorTimer.js` — Zoom's Dynamic Indicator (a status in Zoom's meeting window, seen by everyone). Set by the panel that started the stream, only for confirmed state, removed when the stream stops or reconnects; silent when the client or the Marketplace config lacks `setDynamicIndicator` / `removeDynamicIndicator`. `indicatorState(inputs)` → `{ key, text, style } | null` is the whole rule, the first state that holds:
  1. `paused` "Arlo is paused" (muted colors, italic): that user's own stream is paused (this panel's phase is `paused`, or `arlo.state` says `myStreamPaused`, which also covers a pause made with Zoom's own controls).
  2. `waiting` "Arlo is waiting for an OK" (accent colors, bold): this owner has an `agent_action` sheet open.
  3. `thinking` "Arlo is thinking…" (accent colors): Arlo handles a request that was said aloud in the meeting (`arlo.thinking` with `channel: 'voice'`). An owner's own typed question is private to them: it shows on their panel's status line and never here.
  4. `did`, for 4 seconds after an action ends as `done` while the panel is open (`arlo.did`; not the ones loaded from `GET /actions`), a fixed sentence by tool (success colors): "Arlo posted to the chat", "Arlo let someone in", "Arlo shared the notes", "Arlo invited everyone to the notes", "Arlo muted a participant", "Arlo opened a ticket". None for a reaction, an answer, a summary or a timer.
  5. `transcribing` "Arlo is transcribing", in Zoom's own look (no style).
  - Everyone reads the indicator, so nothing of the meeting reaches it: never the step of `arlo.thinking`, a label, a name or a request. The table takes flags and a tool name; every text it can show is in `INDICATOR_STRINGS` (the sentences above and "Timer"), and tests hold the table and the hook to that set.
  - The hook calls Zoom only when the text or style changed, 250 ms after the last change (a state that comes and goes within that time is never sent). A call with a style that Zoom refuses is sent again as text only, and that panel sends text only from then on; a refused text is logged and left.
  - A timer ("Arlo, set a five minute timer", tools `set_timer` / `stop_timer`) is Zoom's countdown on the same indicator. The panel that started one keeps its end time (`lib/indicatorTimer.js`, in memory); while it runs the hook sends no status, and when it is over (its time, plus 1.5 s; a "stop the timer"; Zoom refused it; the stream that panel started stopped; another meeting or none) the hook sets the state of that moment again. A panel that does not own the indicator takes it down at the timer's end instead. A timer is the meeting's, and any owner's panel can stop it: when an owner's panel is told a `stop_timer` action ended as `done` (`arlo.did`, from whichever panel ran it), it ends its own record as stopped (`endTimerStoppedElsewhere`) and the hook sets its status again, whatever it had shown before; the panel that ran the stop does not do it twice. A panel that reloads forgets its timer.
  - **Guesses, none tried in a meeting**, all in `INDICATOR_GUESSES` in `lib/dynamicIndicator.js`: colors are written `#RRGGBB` (copies of `index.css` tokens: the indicator is not this app's DOM, so CSS variables cannot be used); `timer.start` is in seconds; a timer takes the text "Timer"; a text update cancels a running timer (hence the silence while one runs); the 1.5 s wait after a countdown's end. Zoom documents no limit on the text's length (the longest sentence has 37 characters) and says only that the indicator is for status cues and timers, nothing bright or distracting.
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
- `GET /api/auth/settings` — Get server settings and feature flags. `features.jira` is `{ baseUrl: string | null }`: the deployment's Jira base URL as the server uses it (`JIRA_BASE_URL`), told only to a request with a valid session (`optionalAuth`); without one it is `{ baseUrl: null }` (an internal host name is not for anyone who can reach the server). `Cache-Control: no-store`. The panel reads the settings again when someone signs in or out (`ServerSettingsContext`), and then announces `open_ticket`. It opens a ticket only at exactly that base + `/browse/` + the key
- `POST /api/auth/logout` — Clear session: removes the `sessionToken`, `sessionRestore` and `meetingAccess` cookies and closes the user's open sockets (code 4001). A panel that stays open asks for meeting access again and reconnects as a guest

### API tokens and RTMS REST testing
Arlo can act as a test proxy for Zoom's RTMS REST API. A script authenticates with a short-lived API token (`Authorization: Bearer arlo_…`) instead of a browser session.
- `POST /api/tokens` — Create a token (browser session only). Body `{ scopes: ["rtms:control","rtms:read"], name?, ttlMinutes? }`. The token is returned once; only its hash is kept, in memory. Default lifetime 1 hour, max 24; max 5 per user
- `GET /api/tokens` / `DELETE /api/tokens/:id` — List / revoke (browser session only)
- `POST /api/rtms/start` — `{ meetingId, action: start|stop|pause|resume }` → Zoom `PATCH /v2/live_meetings/{meetingId}/rtms_app/status` with the user's Zoom token (session or `rtms:control`). 202 = Zoom accepted the request, not "stream started"; a refusal returns Zoom's status, code and message. Needs the Zoom scope `meeting:update:participant_rtms_app_status`
- `GET /api/rtms/events?since=<ISO>` — Timeline for the caller's own meetings: REST requests, Zoom webhooks (`meeting.rtms_*`, `rtms.request_status` with its meaning), Arlo's stream join result (session or `rtms:read`)

### Arlo in one meeting
All under `/api/meetings/by-zoom-id/:zoomMeetingId/arlo`. Every route needs the `meetingAccess` cookie for exactly this meeting; being signed in does not replace it. Who is an owner is decided on the server. Responses are `Cache-Control: no-store`.
- `GET /state` — `{ present, paused, myStreamPaused?, myStreamLive?, role: 'owner' | 'participant', ownerName, whoCanAsk, notesShared }`. `paused` is the meeting as a whole (every live stream is paused); `myStreamPaused` and `myStreamLive` (booleans, owners only) are about the caller's own stream: whether it is paused, and whether it is running right now. `notesShared` (boolean, for everyone) says whether the owners share the notes with everyone in the meeting. Open to guests in the meeting (a guest is a participant)
- `PUT /settings` — `{ whoCanAsk?: 'owner' | 'anyone', displayName?, shareNotes?: boolean }`, at least one and nothing else, owners only. `shareNotes: true` shares the live notes with everyone in the meeting who has Arlo open (and sends them the notes so far at once); `false` stops it. Every panel of the meeting is told over its socket
- `GET /notes` — `{ notes: { summary, decisions, actionItems, updatedAt, throughSeqNo } | null }`. Owners always. Anyone else with the meeting-access cookie for this meeting (a guest too: no session needed) only while `notesShared` is true; 403 otherwise
- `POST /ask` — `{ question }` (1 to 500 characters) → `{ answer }`, from the stored transcript, private to the asker; when Arlo did more than answer a question, `{ answer, action: { id, tool, status, label } }`, where `id` is the stored action's, the same one `arlo.did` carries when it ends. For an owner, and for other signed-in people in the meeting when the setting is `anyone`. Goes through Arlo's agent (`services/agent/`) as a typed request: a model picks a tool from the table (`agent/tools.js`), the server's policy (`agent/policy.js`) decides. When no tool fits, or the picking model cannot be asked, the text is answered from the transcript as typed, as the Ask input always did; "I didn't catch a request." is never the answer to a valid question. A typed request waits ahead of spoken ones in the meeting's queue (one handled at a time, never interrupted). A spoken request ("Arlo, …" in the transcript) is dropped before any model call while no owner has a panel open in the meeting (`hasOwnerPanel` in `services/websocket.js`). The tools: `answer_from_meeting`, `summarize_so_far`, `post_to_chat`, `admit_from_waiting_room`, `share_notes`, `invite_everyone`, `send_reaction`, `mute_participant` (and `web_search` when it is turned on). `post_to_chat` takes a message of at most 300 characters; the approval sheet shows all of it as its `body`: what an owner approves is what is posted. `invite_everyone`, `send_reaction` and `mute_participant` post nothing, so their sheets have no `body`. A failed action is answered with one sentence of the server: "I couldn't do that: …" by result code, or the tool's own ("I couldn't find <name> in the meeting.", "Shared the notes. Couldn't send the invitation."). A summary for someone who is not an owner uses the notes only while they are shared. Shares the AI rate limit. Takes no transcript and no model from the client; questions and answers are not stored or logged
- `POST /actions/:actionId/result` — `{ ok: true }` or `{ ok: false, code? }` → `{ received: true }`: the panel Arlo sent an action to (`arlo.action` on its socket) reports whether it did it. Owners only, and only the owner it was sent to (404 otherwise, and for an action that is unknown or finished). The same result sent again by that owner within 2 minutes is answered `{ received: true }` again, so a panel can retry a POST whose response was lost; another verdict is 404. `args.message` of a `post_to_chat` action is "Arlo: " + text, at most 506 characters. `code` is one of `not_found`, `several_match`, `no_notes`, `sdk_error`, `unsupported`, `not_allowed`, `share_failed` (a ticket was opened, the share dialog was not); any other `code` is 400. `args` of `admit_from_waiting_room` and `mute_participant` is `{ name }`, of `send_reaction` `{ reaction }` (one of the six names, never an emoji), of `invite_everyone` `{}`
- `POST /open-notes` — body `{}` → `{ shared: true }`. Owners only (403; 401 without a session). The owner pressed "Open notes for everyone" and confirmed it on their own panel: the server turns `notesShared` on (the same code path as the setting; shared already is the same answer) and does nothing else. The panel then starts Zoom's Collaborate mode itself. No model, no sheet
- `POST /notes-request` — body `{}` → `{ id, expiresAt, expiresInMs }` (`expiresInMs`: the time left by the server's clock). A signed-in participant asks the owners to share the notes with everyone. 400 for an owner (they have the notes), 409 `{ error: 'no_owner' }` when nobody brought Arlo in, 409 `{ error: 'already_shared' }` when the notes are shared already, 409 `{ error: 'arlo_absent' }` when Arlo is not in the meeting right now, 429 `{ error: 'too_soon' }` when this person asked in the last 2 minutes or has a request open, 429 `{ error: 'too_many_open' }` when the meeting has as many requests open as it takes (20) or the service is at its meeting cap. Opens an approval (`services/approvals.js`) and tells the owners' panels. The server never posts to the chat; the asker gets the notes like everyone else once an owner agrees; the asker's name is never logged
- `POST /approvals/:approvalId` — owners only (403), id a UUID. `{ approve: false }` → declined; `{ approve: true }` → approved: for `share_notes` the server turns `notesShared` on (the same code path as the setting); for `agent_action` the agent posts the sheet's `body` or runs what was asked, and reports how it ended as `arlo.did`. A boolean `done` is accepted and ignored; `failed` only if the server could not turn sharing on. → `{ id, outcome }`. The first answer wins; 404 when unknown, closed, expired, not put to this owner (an admit sheet goes only to owners with a host's panel), or the meeting's data is gone
- `GET /approvals` — owners only: `{ approvals: [{ meetingId, id, kind, askedBy, expiresAt, expiresInMs }] }` (`expiresInMs` computed when the list is read), oldest first, so a panel that reloads still shows a pending sheet. One of kind `agent_action` has the same extra fields as the `arlo.approval` message below
- The routes above that take a body take JSON only (415 otherwise) and exactly the fields listed (400 otherwise)
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

The two cookies answer different questions. `meetingAccess` says which meeting the socket is in and nothing else: a user id inside that token never makes the socket that user. Who the socket is comes only from a valid session (`sessionToken`, verified as the HTTP middleware verifies it: signature, expiry, not deauthorized, user restored from `sessionRestore` after a restart); without one it is a guest's socket (role `participant`, no owner-only messages, no hands). A session can end while its socket stays open: `userOf(ws)` in `services/websocket.js` checks the session's expiry time and the deauthorized list (both in memory, no token is verified again) every time the socket's user is read, and on the 30-second heartbeat; a socket whose session ended becomes a guest's on the spot and gets a new `arlo.state`. Logout and `app_deauthorized` close the user's sockets (4001).

```
Connection: ws://host/ws?meeting_id={uuid}   (cookies authenticate; the server binds the socket to the verified meeting)
Client → Server: { type: 'subscribe', meetingId: 'uuid' }
Server → Client: { type: 'transcript.segment', data: { meetingId, segment: {...} } }
Server → Client: { type: 'ai.suggestion', data: { meetingId, suggestion: {...} } }
Server → Client: { type: 'meeting.status', data: { meetingId, status: '...', fault?: true, meetingEnded?: true } }
Server → Client: { type: 'arlo.state', data: { meetingId, present, paused, myStreamPaused?, myStreamLive?, role, ownerName, whoCanAsk, notesShared } }
Server → Client: { type: 'notes.updated', data: { meetingId, notes } }
Server → Client: { type: 'arlo.approval', data: { meetingId, id, kind: 'share_notes', askedBy: name | null, expiresAt, expiresInMs } }   (expiresInMs: time left by the server's clock when sent)
Server → Client: { type: 'arlo.approval', data: { meetingId, id, kind: 'agent_action', askedBy: name | null, askerVerified, expiresAt, expiresInMs, question, primaryLabel, channel: 'voice' | 'panel', body?, request? } }
Server → Client: { type: 'arlo.approval.closed', data: { meetingId, id, outcome: 'approved' | 'declined' | 'failed' | 'expired' } }
Server → Client: { type: 'arlo.thinking', data: { meetingId, on: true, step?, channel?: 'voice' | 'panel' } }   (again whenever the step changes)
Server → Client: { type: 'arlo.thinking', data: { meetingId, on: false } }
Server → Client: { type: 'participant.event', data: { meetingId, event: {...} } }
```

- `meetingEnded: true` on a stop means the meeting is over and its data is deleted now. The panel keeps the notes it already has (the "after the meeting" screen), also a participant's shared ones.
- `arlo.state` differs per person (`role`, `myStreamPaused`, `myStreamLive`). `paused` is the meeting-level value: true only when every live stream is paused. `myStreamPaused` is sent to owners only and says whether their own stream is paused; with two streams it can be true while `paused` is false, because the other stream still delivers. `myStreamLive` is sent to owners only and is true while a stream whose operator is that user runs in this meeting; someone stays an owner after their stream stops, so it can be false while `present` is true (another person's stream still runs). The state is sent when a socket connects or subscribes, when a stream starts, stops, is paused or resumed, and when the setting changes.
- `notes.updated` goes to owners' sockets whose verified meeting is this one, and while `notesShared` is true to every socket verified for this meeting (signed-in participants and guests). Never to a socket verified for another meeting. A panel that is not an owner's keeps notes only while the state says they are shared.
- An `agent_action` approval is something Arlo was asked that an owner must agree to. `question` and `primaryLabel` are sentences the server wrote. `body` (at most 500 characters) is the exact text that will be posted to the meeting chat after "Arlo: " when an owner agrees: a model's answer, or the message of `post_to_chat` ("Post this in the meeting chat?"); absent when nothing is posted (admit, share notes, invite everyone, a reaction, mute). `request` (at most 200 characters) is what was asked, cleaned to one line. `askedBy` (at most 60 characters) is, for a spoken request, the speaker's Zoom display name, which anyone can set; `askerVerified` is true only when the server knows who asked: a signed-in person who typed it, or a speaker verified by `AGENT_SPEAKER_MATCH`.
- `arlo.thinking` says Arlo is handling a request, to owners' sockets only: every owner for a spoken request, only the owner who typed it for a typed one. `step` (at most 120 characters) is a sentence the server wrote about what Arlo is doing right now (the table is in `services/agent/texts.js`); `channel` says whether the request was spoken or typed. Neither is sent with `on: false`. The panel reads both as untrusted input (`frontend/src/lib/thinkingStep.js`: a string, invisible and control characters removed, trimmed, 1 to 120 characters, otherwise no step and the line says "Arlo is thinking…"; a channel that is not one of the two is null), shows the step as text in the status line, and ends "thinking" by itself 30 seconds after the last `on: true`. Zoom's Dynamic Indicator, which everyone sees, stays "Arlo is thinking…": no step and no name there.
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
JIRA_BASE_URL=https://yourcompany.atlassian.net  # Optional. With it Arlo has the tool `open_ticket` ("Arlo, open PROJ-123 and share it"). https only, a host and an optional context path (https://tools.example.com/jira); no user name, password, query or fragment; at most 200 characters; a trailing slash is dropped. Anything else is ignored with one warning that does not print the value. Add the same domain to the app's domain allowlist in the Zoom Marketplace
ALLOW_OWN_ARLO_STREAM=true      # On by default: "Take notes yourself" is offered to a person in a meeting where someone else already runs Arlo. false hides it. See the known gap under "Several streams in one meeting"
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

1. **Domain Allowlist** — Add `appssdk.zoom.us`. With `JIRA_BASE_URL` set, add the Jira domain too: `zoomSdk.openUrl` opens only allowlisted domains (error 10015 otherwise, and Arlo answers that Zoom did not do it)
2. **OAuth Redirect URL** — `https://{your-domain}/api/auth/callback`
3. **RTMS Scopes** — Enable Transcripts (requires RTMS access approval from Zoom)
4. **SDK Capabilities** — See `.claude/skills/zoom-apps/02-sdk-setup.md`. Opening a ticket and sharing needs `openUrl` and `promptShareScreen` (in `zoom-app-manifest.json`). The panel asks only for APIs it calls (`getEmojiConfiguration` and `stopShareScreen` are not requested: a client that refused one would lose the tier). `promptShareScreen` is asked for in the same capability tier as the reactions: an app configuration without it loses the reactions too until it is added
5. **Home URL** — Your ngrok/production URL
6. **Event Subscriptions** — `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.rtms_interrupted`; optional `rtms.request_status` (shows why a stream request failed). Endpoint: `https://{your-domain}/api/rtms/webhook`
7. **Collaborate mode** — switch it on for the app under Features (Zoom asks for a resubmission for review). Without it `startCollaborate` is refused (error 10089): "Open notes for everyone" then says it could not, and Arlo's `open_notes_for_everyone` ends as failed with the notes still shared (nothing is sent in its place). The APIs (`startCollaborate`, `endCollaborate`, `joinCollaborate`, `leaveCollaborate`, `onCollaborateChange`) are in the SDK capabilities already
8. **Deauthorization Notification Endpoint URL** — the same `https://{your-domain}/api/rtms/webhook`. On `app_deauthorized` the server deletes the user's record and tokens, ends their session and closes their open sockets; a panel that reconnects is a guest.

## Security (Demo Mode)

This demo mode version prioritizes security by never storing customer data:

- **No database** — All data exists in memory only
- **Tokens in memory** — OAuth tokens stored encrypted in memory, cleared on restart
- **No persistent storage** — A meeting's transcript, notes and owners are held in memory while the meeting runs and deleted when it ends; nothing is saved to disk
- **Notes are the owners' to share** — sent only to the sockets of the people who brought Arlo in, until one of them shares them ("Share notes with everyone", or by approving a request): then everyone verified for that meeting who has Arlo open gets them, guests included, until an owner stops sharing or the meeting ends
- **Session cookies** — httpOnly, secure, SameSite=lax. Three kinds that cannot stand in for each other: `sessionToken` (who you are), `meetingAccess` (which meeting you are in), `sessionRestore` (encrypted, rebuilds a session after a restart)
- **HMAC verification** — All Zoom webhooks verified with timing-safe comparisons
- **Rate limiting** — Global, auth, and AI endpoint limits via `express-rate-limit`
- **WebSocket auth** — verified meeting-access cookie required for all connections; it grants the meeting only. A socket is a signed-in user only through a valid session, re-checked whenever its user is read

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
- Collaborate mode ("Open notes for everyone") is built from Zoom's reference and has not been run in a real meeting. Not known: whether the app that is open changes to `inCollaborate` in place or Zoom loads it anew in the meeting window; whether `getMeetingUUID` answers there; and what the app context (`getAppContext`) looks like in Collaborate. The docs list `typ` as `panel`, `meeting`, `webinar` or `chat` and say only that "the Collaborate UUID is included in the context header", so `POST /api/auth/meeting-access` still takes `meeting` and `webinar` with a `mid` and nothing else (`backend/src/services/zoomAppContext.js`): if a Collaborate context differs, the document shows the access notice instead of the notes. A second owner who did not start Collaborate probably cannot end it ("Close for everyone" then fails with a toast)
- Later: opening shared notes from a link outside the meeting is not built. Shared notes are seen only in the Arlo panel, inside the meeting
