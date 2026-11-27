<div align="center">

<img src="./docs/assets/arlo-logo.svg" alt="Arlo" width="200"/>

# Arlo Meeting Assistant

**An AI agent for Zoom meetings, built on RTMS and the Zoom Apps SDK**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![Zoom RTMS](https://img.shields.io/badge/Zoom-RTMS-2D8CFF.svg)](https://www.zoom.com/en/realtime-media-streams/)

[Get Started](#quick-start) · [What You See](#what-you-see-in-a-meeting) · [Asking Arlo](#asking-arlo-to-do-things) · [Known Limits](#known-limits) · [Troubleshooting](#troubleshooting)

</div>

---

## What is Arlo?

Arlo is an open-source reference implementation of an AI agent that you bring into a Zoom meeting. It is a Zoom App, not a meeting bot: no extra participant joins.

- **It hears the meeting through RTMS** (Real-Time Media Streams): the live transcript arrives on the server over a WebSocket.
- **It acts through the Zoom Apps SDK**: posting to chat, muting, admitting, reactions, timers and screen sharing are SDK calls made by the open Arlo panel of the person who allowed them.
- **One screen at a time, no dashboard.** The panel shows the one thing that matters now: bring Arlo in, the live notes, or what a participant may see.

What it does in a meeting:

| | |
|---|---|
| **Live notes** | A summary, decisions and action items, rewritten about every 45 seconds while people talk |
| **Ask Arlo** | Type a question or a request, or say "Arlo, …" in the meeting |
| **Meeting record** | The transcript and what happened since Arlo joined, for everyone in the meeting |
| **Sharing notes** | The notes belong to the people who brought Arlo in. They can share them with everyone, post them to chat, or open them as a document for the whole meeting |

Use this project to learn how RTMS webhooks, transcript streaming, in-client OAuth and the Apps SDK fit together, or fork it as a starting point.

### Demo Mode (No Database)

This version has no database. A meeting's transcript, notes and record are held **in memory only while that meeting runs** and are deleted when it ends.

- Someone who opens Arlo mid-meeting, or reconnects, sees what was said so far.
- Nothing is written to disk. Nothing carries from one meeting to the next. A server restart clears everything.
- Meeting history, search across transcripts, highlights, export and the upcoming-meetings list need stored data and are off.
- Transcript text is sent to the configured AI provider (OpenRouter) to write notes and answers. That provider's retention terms apply to what it receives.

To add persistence, put a database behind the meeting store interface in `backend/src/storage/` and store only what users consent to.

---

## What You See in a Meeting

Which screen you get depends on whether Arlo is in the meeting and on who you are. An **owner** is an Arlo user who runs a transcript stream of their own in the meeting; the server decides this, not the panel.

| Screen | Who sees it | What it does |
|--------|-------------|--------------|
| **Bring Arlo in** | The host or a co-host, signed in | Choose who can ask Arlo ("Only I" or "Anyone"), then one button. Nothing is requested from Zoom before the click. |
| **Ask the host** | Other signed-in users | One button. Zoom asks the host; the screen waits for the answer. |
| **Live notes** | Each owner | The notes. A status line with Pause, Resume and Remove Arlo. The Ask Arlo input. What Arlo did, listed under "Arlo did". Three actions for the notes: **Share notes with everyone** (live in everyone's Arlo panel until **Stop sharing**), **Post notes to chat** (a one-time copy, after a confirm), **Open notes for everyone** (see below). |
| **Approval sheet** | An owner, over the notes | Rises when someone asks for the notes or asks Arlo for something that changes the meeting. It shows what will happen, a primary button and **Not now**, and closes by itself after a minute. |
| **Participant view** | Everyone else, including guests | Who brought Arlo in and a link to the meeting record. The notes only while an owner shares them, read-only. Ask Arlo when the owner chose "Anyone" and you are signed in. Signed-in people can **ask the owner to share the notes** or **take notes themselves** (start a stream of their own). |
| **Notes for everyone** | Everyone, while Zoom's Collaborate mode runs | The notes as a wide document. Nothing private is on it, because Zoom shows the owner's view as a screen share to people who cannot join Collaborate. **Close for everyone** ends it. |
| **Meeting record** | Everyone in the meeting | What was said and what happened, in time order, including what Arlo was asked to do and how it ended. A toggle shows only Arlo's actions. |
| **After the meeting** | Whoever holds notes | The notes stay on screen with **Copy notes**. They are not stored anywhere else. |

How it works:

- **Who gets the notes.** Owners always. Everyone else only while an owner shares them; sharing stops delivery at once when it is turned off.
- **Controls are per person.** Pause, Resume and Remove act on your own stream, so only owners see them. A host stops someone else's stream with Zoom's own controls.
- **Several streams, one transcript.** Several users can each run a stream. The server stores one transcript and drops a line only when it is known to be a copy (same speaker, same words, close in time) of one just stored from another stream.
- **Reconnection.** The RTMS service follows Zoom's failover signals and rejoins with a backoff; the panel shows "Reconnecting…". See `rtms/src/sessions.js`.
- **When the meeting ends.** The server deletes the transcript, the notes and the record of who brought Arlo in. A panel that is still open keeps the notes it already has.

---

## Asking Arlo to Do Things

Ask in two ways:

- **Spoken:** start a sentence with "Arlo, …" or "Hey Arlo, …". The server finds the request in the transcript. It is heard only while an owner has Arlo open.
- **Typed:** the Ask Arlo input in the panel. For owners, and for other signed-in people when the owner chose "Anyone can ask". Answers to typed questions are private to the asker.

A model picks one tool from a fixed table (`backend/src/services/agent/tools.js`). The server validates the call and decides whether it may run. When no tool fits, a typed request is answered from the transcript.

| Arlo can | Example | Notes |
|---|---|---|
| Answer a question about the meeting | "Arlo, what did we decide about the launch date?" | From the stored transcript |
| Summarize so far | "Arlo, give me a recap" | |
| Post to the meeting chat | "Arlo, post the launch date in the chat" | At most 300 characters, posted as "Arlo: …" |
| Share the notes | "Arlo, share the notes with everyone" | Visible in Arlo for everyone who has it open |
| Invite everyone | "Arlo, invite everyone to the notes" | Shares the notes and sends Zoom's invitation to open Arlo |
| Open the notes for everyone | "Arlo, open the notes for everyone" | Shares the notes and starts Collaborate mode. People who cannot join see the owner's Arlo view as a screen share |
| Send a reaction | "Arlo, give that a thumbs up" | One of 👍 👏 ❤️ 😂 🎉 😮, sent as the owner |
| Mute a participant | "Arlo, mute Danny Lee" | Host or co-host only. One named person. Never unmutes |
| Admit from the waiting room | "Arlo, let Danny Lee in" | Host or co-host only. One named person |
| Set a timer | "Arlo, set a five minute timer" | 1 to 120 minutes. A countdown everyone sees |
| Stop the timer | "Arlo, stop the timer" | |
| Open a GitHub issue | "Arlo, open issue 42 and share it" | Only with `GITHUB_DEFAULT_REPO` set. Opens the issue in the owner's browser; "share" brings up Zoom's share dialog, where the owner picks the window |


To open an issue, Arlo takes a number and nothing else. The server builds the URL from the configured repository; a model or a speaker never supplies a URL or a repository. Nothing calls the GitHub API.

### The Approval Rule

A transcript is text that anyone in the meeting can speak into, and a model's output is untrusted. So:

> **Nothing is posted to the chat, and nothing else changes the meeting, unless an owner has seen exactly what will be posted or done and pressed the button on their own panel, or typed the request themselves in their own panel.**

In practice:

- **Everything spoken goes to an approval sheet**, also a spoken question. The answer is written first and shown on the sheet; approving posts that text as it is, with no second model call.
- **An owner's typed request runs without a sheet only when what it does is plainly in what they typed.** The check is strict (`typedRequestCovers` in `backend/src/services/agent/policy.js`): "mute Danny Lee" runs, "don't mute Danny Lee" and "mute everyone except Danny Lee" get the sheet. Inviting everyone and opening the notes for everyone always get the sheet.
- **The model that picks the tool sees only the request**, not the transcript or the notes, so tool arguments can only come from what was asked.
- **Names, numbers and messages are rebuilt and checked by the server.** A call that fails the check is refused, not repaired.
- **Declined or expired requests leave no trace in the chat.** They appear in the meeting record only.
- **Limits** apply per meeting: spoken and typed requests are rate limited, one request is handled at a time, and at most five sheets are open.

### The Hands

The server cannot act in a Zoom meeting; only the Apps SDK inside a running panel can. So an action that needs the SDK runs on the open panel of the owner who typed the request or pressed the approval, never on another person's.

Each panel announces which actions its Zoom client supports and whether it is a host's. If that owner has no panel open that can do it, the action fails with a plain sentence ("Open Arlo to let it do that.", "Arlo needs the host's panel for that."). The panel reports back whether it did the thing, and the result is listed under "Arlo did" and in the meeting record.

---

## Dynamic Indicator and Timer

Zoom's Dynamic Indicator is a status in the meeting window that everyone sees. The panel that started the stream sets it, only for confirmed state:

| State | Text |
|---|---|
| The owner's stream is paused | "Arlo is paused" |
| An approval sheet is open | "Arlo is waiting for an OK" |
| A spoken request is being handled | "Arlo is thinking…" |
| For 4 seconds after an action | A fixed sentence, for example "Arlo posted to the chat" |
| Otherwise | "Arlo is transcribing" |

Everyone reads the indicator, so it never carries a name, a request or any text from the meeting: every sentence it can show is in a fixed set (`frontend/src/lib/dynamicIndicator.js`).

A timer is Zoom's countdown on the same indicator. While one runs, Arlo sends no status; when it ends or is stopped, the status returns. Any owner's panel can stop it.

---

## Prerequisites

| Requirement | Why You Need It |
|-------------|-----------------|
| **[Node.js 22+](https://nodejs.org/)** | Runtime for the services |
| **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** | Runs all services in containers |
| **[ngrok](https://ngrok.com/)** | A public HTTPS URL for Zoom webhooks |
| **[Zoom Account](https://marketplace.zoom.us/)** | To create and configure your Zoom App |

> **This app requires RTMS access from Zoom.** **[Request RTMS Access](https://www.zoom.com/en/realtime-media-streams/#form)** early; approval may take a few days.

---

## Quick Start

### 1. Clone & Set Up ngrok

```bash
git clone https://github.com/zoom/arlo.git
cd arlo
```

```bash
# Static domain (recommended: free, does not change)
ngrok http 3000 --domain=your-name.ngrok-free.app

# Or a random domain (changes each restart)
ngrok http 3000
```

Keep this terminal running and note your URL. A free static domain from the [ngrok dashboard](https://dashboard.ngrok.com/domains) saves reconfiguring Zoom after each restart.

---

### 2. Create Your Zoom App

1. Go to **[Zoom Marketplace](https://marketplace.zoom.us/)** → Develop → Build App
2. Select **General App** and name it
3. Copy your **Client ID** and **Client Secret**
4. *(Optional)* Set the app icon: upload the 160×160 PNGs in [`docs/assets/marketplace/`](./docs/assets/marketplace/) (`arlo-icon-160.png` for light mode, `arlo-icon-160-dark.png` for dark mode). The manifest has no icon field.

#### Optional: configure the app from the manifest

[`zoom-app-manifest.json`](./zoom-app-manifest.json) contains the settings from [Step 4](#4-configure-zoom-app-settings): scopes, Zoom Apps SDK APIs, OAuth, domain allow list, Collaborate mode and event subscriptions. If your account can upload app manifests (a Marketplace beta), you can upload it instead of configuring each setting by hand. It does not contain `github.com` in the domain allow list or the deauthorization URL: add those by hand if you need them.

> **Before uploading, replace the ngrok URL everywhere it appears in the manifest.** The placeholder `your-ngrok-url.ngrok-free.app` appears 8 times. Replace only the hostname; the manifest already includes `https://` and the paths.
>
> ```bash
> # Writes a filled-in copy and leaves the template unchanged
> sed 's/your-ngrok-url\.ngrok-free\.app/YOUR-NAME.ngrok-free.app/g' zoom-app-manifest.json > my-zoom-app-manifest.json
> grep -c 'your-ngrok-url' my-zoom-app-manifest.json   # should print 0
> ```
>
> Upload the filled-in copy, not the template, and don't commit it.

---

### 3. Configure Environment

```bash
cp .env.example .env
```

Required:

```bash
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret
ZOOM_WEBHOOK_TOKEN=your_secret_token   # Features → Access → Secret Token
PUBLIC_URL=https://your-name.ngrok-free.app

# Generate each with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=
TOKEN_ENCRYPTION_KEY=                  # 64 hex characters (AES-256-GCM)

DEMO_MODE=true
AI_ENABLED=true                        # Without it there are no notes and Arlo answers nothing
```

Optional:

| Variable | Default | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | none | Free models work without a key, with lower rate limits |
| `OPENROUTER_MODELS` | see `.env.example` | The models the server may use, comma separated |
| `DEFAULT_MODEL`, `FALLBACK_MODEL` | see `.env.example` | Must be in `OPENROUTER_MODELS` |
| `NOTES_MODEL` | `DEFAULT_MODEL` | The model that writes the live notes and answers questions. Must be in `OPENROUTER_MODELS` |
| `AGENT_MODEL` | `DEFAULT_MODEL` | The model that picks a tool when someone asks Arlo for something. Must be in `OPENROUTER_MODELS`. Choose it with the [model test](#choosing-the-agents-model) |
| `NOTES_INTERVAL_MS` | `45000` | How often the notes are rewritten while people talk (15000 to 600000). Each run is a model call |
| `APPROVAL_EXPIRY_MS` | `60000` | How long an approval sheet waits for an answer (100 to 600000) |
| `GITHUB_DEFAULT_REPO` | none | `owner/name`. With it Arlo can open an issue of that repository by number. Without it there is no such tool |
| `AUTO_START_RTMS` | `false` | `true` requests transcription as soon as someone opens Arlo. Off by default: a person clicks first |
| `ALLOW_OWN_ARLO_STREAM` | `true` | `false` hides "Take notes yourself" for people in a meeting where someone else runs Arlo. See [Known Limits](#known-limits) |
| `MEETING_FLUSH_GRACE_MS` | `120000` | How long a meeting's data is kept after its stream stopped and the last panel disconnected |
| `LOG_LEVEL` | `info` | `debug` adds request shapes. No level logs transcript text, names or tokens |

A value outside its range is ignored with a warning and the default is used.

---

### 4. Configure Zoom App Settings

In [Zoom Marketplace](https://marketplace.zoom.us/) → Your App. Replace `YOUR-NGROK-URL` with your ngrok hostname.

<details>
<summary><strong>Basic Information</strong></summary>

| Setting | Value |
|---------|-------|
| OAuth Redirect URL | `https://YOUR-NGROK-URL/api/auth/callback` |
| OAuth Allow List | `https://YOUR-NGROK-URL` |

</details>

<details>
<summary><strong>Scopes</strong></summary>

- `zoomapp:inmeeting` — Run the app inside meetings
- `meeting:read:meeting` — Read meeting details
- `meeting:read:meeting_transcript` — Receive live transcripts via RTMS (search "RTMS"; requires RTMS access)
- `meeting:read:list_meetings` — List upcoming meetings
- `user:read:user` — Read user profile (optional)
- `meeting:write:open_app` / `meeting:delete:open_app` — Auto-open in a meeting (optional; needs the database version)
- `meeting:update:participant_rtms_app_status` — Start and stop RTMS through Zoom's REST API (optional; used by the developer tools)

</details>

<details>
<summary><strong>Features → Zoom App SDK</strong></summary>

Click **Add APIs**. The full list is in [`zoom-app-manifest.json`](./zoom-app-manifest.json). The panel asks only for APIs it calls and works without the optional ones: an action whose API is missing is not offered.

| For | APIs |
|---|---|
| Running and signing in | `getAppContext`, `getMeetingContext`, `getMeetingUUID`, `getRunningContext`, `getUserContext`, `getMeetingParticipants`, `authorize`, `onAuthorized`, `promptAuthorize`, `onRunningContextChange`, `onMyUserContextChange`, `showNotification` |
| Transcription | `startRTMS`, `stopRTMS`, `pauseRTMS`, `resumeRTMS`, `getRTMSStatus`, `onRTMSStatusChange` |
| Status and timer | `setDynamicIndicator`, `removeDynamicIndicator` |
| Post to chat | `sendMessageToChat` |
| Admit from the waiting room | `getWaitingRoomParticipants`, `admitParticipantFromWaitingRoom` |
| Mute | `toggleParticipantMediaAudio` |
| Reactions | `setEmojiReaction` |
| Open an issue and share | `openUrl`, `promptShareScreen` |
| Invite everyone | `sendAppInvitationToAllParticipants`, `sendAppInvitation`, `showAppInvitationDialog`, `onSendAppInvitation` |
| Notes for everyone | `startCollaborate`, `endCollaborate`, `joinCollaborate`, `leaveCollaborate`, `onCollaborateChange` |

`promptShareScreen` is requested in the same capability tier as the reactions: a configuration without it loses the reactions too.

Also enable **In-client OAuth** and **Guest mode**.

</details>

<details>
<summary><strong>Features → Collaborate mode</strong></summary>

Switch Collaborate mode on for the app (Zoom asks for a resubmission for review). Without it Zoom refuses `startCollaborate`: "Open notes for everyone" then says it could not, and the notes stay shared in the panels.

</details>

<details>
<summary><strong>Features → Surface</strong></summary>

| Setting | Value |
|---------|-------|
| Home URL | `https://YOUR-NGROK-URL` |
| Domain Allow List | `YOUR-NGROK-URL`, `appssdk.zoom.us`, and `github.com` when `GITHUB_DEFAULT_REPO` is set (Zoom opens only allowlisted domains) |

</details>

<details>
<summary><strong>Features → Event Subscriptions and Deauthorization</strong></summary>

| Setting | Value |
|---------|-------|
| Event notification endpoint | `https://YOUR-NGROK-URL/api/rtms/webhook` |
| Events | `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.rtms_interrupted`; optional `rtms.request_status` (shows why a stream request failed) |
| Deauthorization Notification Endpoint URL | The same `https://YOUR-NGROK-URL/api/rtms/webhook`. On deauthorization the server deletes the user's record and tokens and closes their sockets |

</details>

---

### 5. Start the Application

```bash
docker-compose up --build
```

Three services start: backend (port 3000, the one ngrok points at), frontend (3001 on the host) and the RTMS service (internal to the Docker network).

---

### 6. Test in Zoom

1. Start a Zoom meeting, click **Apps**, open your app
2. As the host, click **Bring Arlo into this meeting**
3. Talk for a minute: the notes appear (Summary, Decisions, Action items)
4. Type a question into **Ask Arlo**
5. Type "post hello team in the chat": it is posted as "Arlo: hello team"
6. Say "Arlo, set a five minute timer": a sheet asks "Start a 5 minute timer for everyone?"
7. Open **Meeting record** to see the transcript and what Arlo did
8. Open Arlo from a second account in the same meeting to see the participant view, and click **Ask … to share notes with everyone**: the first account gets a sheet
9. On the first account, click **Stop sharing**: the notes disappear from the second account's panel

---

### Choosing the Agent's Model

Free models differ a lot in how well they pick a tool. The repository has a test for it:

```bash
docker-compose exec backend node scripts/agent-eval.js
docker-compose exec backend node scripts/agent-eval.js --models model-a,model-b --runs 2
```

It asks each model the synthetic requests in `backend/scripts/agent-eval-cases.json` and prints, per model, how often the tool and the arguments were right and the median time. It calls OpenRouter: it needs `AI_ENABLED=true` and `OPENROUTER_API_KEY`, and tests only models in `OPENROUTER_MODELS`. Free models are rate limited per day, so name one or two models at a time. Set the winner as `AGENT_MODEL`.

---

## Settings

The gear icon opens Settings. Most of it belongs to the classic dashboard.

| Setting | What it does |
|---------|--------------|
| **Show sample data** | Shown only in demo mode. Example data for the classic dashboard; off by default |
| **Auto-open in meetings** | Needs the database version |
| **Start transcription when you open this app** | Shown only when the deployment sets `AUTO_START_RTMS=true` |
| **AI Configuration** | The provider is OpenRouter. The model chosen here is tried first for the classic dashboard's AI features; the live notes and the agent use the server's `NOTES_MODEL` and `AGENT_MODEL` |
| **Chat Notifications** | Messages your panel sends to the Zoom chat when your transcription starts, pauses, resumes, stops or restarts, with editable texts |
| **Show Arlo Responses** | Classic dashboard: show or hide its voice command responses |
| **Start/Stop via REST API** | Developer tool: control RTMS through Zoom's REST API instead of the client SDK |
| **Show AI Prompts** | Developer tool: an info icon next to the classic dashboard's AI components shows the prompt used |
| **Compliance Advisor** | Classic dashboard: flags possible compliance risks by vertical |
| **Classic dashboard** | Shown only while in a meeting. Opens the earlier dashboard |

---

## The Classic Dashboard and Industry Verticals

The earlier dashboard (tabs, vertical cards, suggestions) is still in the app: while in a meeting, open Settings and choose **Classic dashboard**. It has five illustrative modes that show what a domain-specific app can do with a live transcript. The screenshots and videos below show this dashboard, not the screens described above.

<div align="center">

![Arlo Vertical Selector](./docs/images/vertical-selector.png)

</div>

| Vertical | What it shows | Demo |
|---|---|---|
| **Notes** | Summary, decisions, action items, open questions | [Video](https://youtu.be/4N-g5TgGRz0) |
| **Healthcare** | SOAP notes, medication and symptom detection | [Video](https://youtu.be/F496oIqo6ls) |
| **Legal** | Contradiction detection, billable time, exhibits | [Video](https://youtu.be/WNM5YxRTrIU) |
| **Sales** | BANT qualification, competitor mentions, a filler word coach | [Video](https://youtu.be/LKpZAe5_A8o) |
| **Support** | Customer sentiment with trend | [Video](https://youtu.be/1N6hs88nOhA) |

<p align="center">
<img src="./docs/images/notetaker-summary.png" alt="Meeting Summary" width="45%">
<img src="./docs/images/healthcare-soap-notes.png" alt="SOAP Notes" width="45%">
</p>
<p align="center">
<img src="./docs/images/legal-contradictions.png" alt="Contradiction Detection" width="45%">
<img src="./docs/images/support-sentiment.png" alt="Customer Sentiment" width="45%">
</p>

To build your own vertical, start from the components in `frontend/src/features/`.

---

## Developer Tools

- **Show AI Prompts** (Settings): see the prompts behind the classic dashboard's AI features. Also `GET /api/ai/prompts` and `GET /api/ai/prompts/:id`.
- **RTMS through REST**: `POST /api/rtms/start` forwards start, stop, pause and resume to Zoom's REST API with the user's token, and `GET /api/rtms/events` returns a timeline of requests, webhooks and join results for the caller's meetings. A script authenticates with a short-lived token from `POST /api/tokens`.
- **Drop the stream on purpose**: set `CHAOS_DROP_STREAM_AFTER_SEC=15` and restart the rtms service to watch reconnection in a real meeting. Remove it afterwards.

[`CLAUDE.md`](./CLAUDE.md) documents the REST routes, the WebSocket protocol and the agent's rules in detail.

---

## Troubleshooting

<details>
<summary><strong>Clean Restart</strong></summary>

```bash
docker-compose down -v
docker-compose up --build -V    # Rebuild with fresh node_modules
```

</details>

<details>
<summary><strong>App stops working after restarting ngrok</strong></summary>

With a random domain: update `PUBLIC_URL` in `.env`, update all URLs in the Zoom Marketplace settings, then `docker-compose restart backend`. A static ngrok domain avoids this.

</details>

<details>
<summary><strong>A change does not show up</strong></summary>

- The frontend container serves a built bundle that is rebuilt on change. Reload the Zoom panel.
- The rtms container does not reload: `docker-compose restart rtms` after editing `rtms/src`.

</details>

<details>
<summary><strong>No notes, or Arlo does not answer</strong></summary>

- `AI_ENABLED=true` must be set.
- Notes are written only while an owner (or, when shared, anyone) has Arlo open.
- Free models are rate limited. Add an `OPENROUTER_API_KEY` or wait.

</details>

See [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) for more. Parts of it describe the database version.

---

## Development

### Project Structure

```
backend/                 Express API, WebSocket server, no database
  src/services/agent/    Arlo's agent: request detection, tool table, policy, texts
  src/services/          Notes engine, approvals, streams, meeting lifecycle
  src/storage/           In-memory meeting store
  scripts/               agent-eval.js (the model test)
frontend/                React Zoom App (Vite)
  src/components/arlo/   The Arlo screens
  src/lib/               Screen choice, SDK actions, Dynamic Indicator, Collaborate
  src/features/          Classic dashboard verticals
rtms/                    RTMS transcript ingestion service
deploy/                  Deployment scaffolding
docs/                    Documentation
zoom-app-manifest.json   Marketplace app settings
docker-compose.yml       Development environment
```

### Common Commands

```bash
docker-compose up --build            # Start all services
docker-compose logs -f backend       # View backend logs
docker-compose restart rtms          # Restart a service
npm test -w frontend                 # Frontend tests (Vitest)
npm run lint -w frontend             # ESLint
npm run build -w frontend            # Production build
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite, Zoom Apps SDK, Base UI |
| Backend | Node.js 22, Express |
| Storage | In memory |
| AI | OpenRouter (free models available) |
| Real-time | WebSocket, `@zoom/rtms` |

### Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](./CLAUDE.md) | The current reference: architecture, routes, WebSocket protocol, agent rules |
| [Architecture](./docs/ARCHITECTURE.md), [Specification](./SPEC.md), [Project Status](./docs/PROJECT_STATUS.md) | Older documents. Parts describe the database version; check them against the code |

---

## Known Limits

**Built from Zoom's reference, only partly verified in real clients.**

- **Collaborate mode** ("Open notes for everyone") has not been run in a real meeting. Not known: whether the open app switches to Collaborate in place or is loaded anew, whether the meeting id can be read there, and what the app context looks like. If it differs from what the code assumes, the document shows an access notice instead of the notes. A second owner probably cannot end a Collaborate session they did not start.
- **Dynamic Indicator styling and the timer** rest on guesses about Zoom's API (color format, timer units, how a text update affects a running timer). They are collected in one place, `INDICATOR_GUESSES` in `frontend/src/lib/dynamicIndicator.js`.
- **Several people using Arlo at once.** Arlo learns of a stream, and whose it is, from Zoom's `meeting.rtms_started` webhook. In a test with two users of the app in one meeting, the second person's start produced no second webhook. Without it Arlo cannot tell whose stream it is, so the second person does not become an owner: "Take notes yourself" ends in a message that Arlo has not joined, with "Try again". The first person's Arlo is not affected, and the second person can still ask for the notes. `ALLOW_OWN_ARLO_STREAM=false` hides the action.

**Limits of the platform.**

- The Apps SDK cannot read the meeting chat. Arlo can post to it and never sees what others write there.
- The SDK cannot pick the window for a screen share: Arlo opens Zoom's share dialog and the owner chooses.
- Arlo acts only while an owner's panel is open, and admitting and muting need a host's or co-host's panel.
- Shared notes are seen only in the Arlo panel, inside the meeting. Opening them from a link outside the meeting is not built.
- A look-alike name written wholly in another script is not caught when Arlo matches a spoken name to a participant.

**Limits of this implementation.**

| Area | Now | For production |
|------|-----|----------------|
| Process model | One backend process holds all state in memory | Shared store and pub/sub to run more than one instance |
| Meeting data | In memory, deleted when the meeting ends | A database behind `backend/src/storage/`, with consent |
| Sessions and tokens | In memory, encrypted; survive a restart through an encrypted cookie | Database or Redis |
| Credentials | `.env` file | A secrets manager |
| HTTPS | ngrok tunnel | Load balancer with TLS |
| Webhook processing | Synchronous | Queue-based |

---

## Zoom for Government

```bash
# In your .env file
ZOOM_HOST=zoomgov.com
```

Create your app in the [Zoom for Government Marketplace](https://marketplace.zoomgov.com/) and use ZfG URLs in your configuration. RTMS availability on ZfG may differ; contact your Zoom representative.

---

## Deployment

[`render.yaml`](./render.yaml) and [`deploy/`](./deploy/README.md) (AWS Terraform, self-hosted Docker Compose) hold deployment scaffolding. They were written for the database version and expect a MySQL database, which this version does not use. Check them against the current code before relying on them. Whatever the host, this version runs as one backend instance: its state is in that process's memory.

---

## Contributing

Fork the repository, change it for your use case, and send improvements as pull requests. See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Resources

- [Zoom Apps Documentation](https://developers.zoom.us/docs/zoom-apps/)
- [RTMS Documentation](https://developers.zoom.us/docs/rtms/)
- [Zoom Apps SDK Reference](https://appssdk.zoom.us/classes/ZoomSdk.ZoomSdk.html)
- [OpenRouter API](https://openrouter.ai/docs)

## Support

- **Issues:** [GitHub Issues](https://github.com/zoom/arlo/issues)
- **Discussions:** [GitHub Discussions](https://github.com/zoom/arlo/discussions)
- **RTMS Access:** [Request Form](https://www.zoom.com/en/realtime-media-streams/#form)
- **Zoom Developer Forum:** [devforum.zoom.us](https://devforum.zoom.us/)

## License

MIT License — See [LICENSE](./LICENSE) for details.
