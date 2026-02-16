# Arlo — v1.0 Implementation Spec

## Overview

Arlo is an open-source AI meeting assistant that runs as an embedded web app inside Zoom meetings. It receives real-time transcripts via Zoom's Realtime Media Streams (RTMS) product, stores them in a database, and provides LLM-generated summaries, action items, and meeting intelligence. The app runs in Zoom's embedded browser panel (Zoom Apps SDK).

This document defines the target v1.0 implementation. Use it to audit the current codebase, identify gaps, and guide build-out.

---

## Technical Context

**Runtime environment:** Embedded web browser inside Zoom desktop client (macOS and Windows). Not a standalone web app — it runs within Zoom's iframe-like container and has access to the Zoom Apps SDK.

**Viewport constraints:**
- Default width: 372px
- Max width: 900px (macOS), 800px (Windows)
- Height: Variable, determined by the user's Zoom window size. Typical range: 500–700px. Can be taller.
- Layout: Fluid between 372px and max width. No fixed breakpoints.
- Mobile: Not in scope.

**Key integrations:**
- **Zoom Apps SDK** — Provides meeting context (current meeting UUID, user role, participant list). Used to determine if the app is running inside a meeting and whether the user is the host.
- **Zoom OAuth** — Authentication. Users connect their Zoom account to authorize Arlo.
- **RTMS (Realtime Media Streams)** — Server-side transcript ingestion. The client reads transcript availability from app state, not directly from RTMS.
- **LLM service** — Generates summaries, highlights, action items, suggestion nudges, and answers to "Ask about this meeting" queries. Implementation details of the LLM layer are outside this spec.
- **Database** — Stores transcripts, meeting metadata, participants, and LLM-generated content.

---

## Theming & Styling

- **Typography:** Source Serif 4 (serif) for headings and body content. Clean sans-serif (Inter or system font stack) for UI chrome: buttons, labels, metadata, tabs.
- **Color palette:** Near-monochrome with one accent color. Minimal, editorial aesthetic.
- **Dark mode:** Support light and dark themes. Provide a toggle in the app header. Persist preference.
- **Design tokens:** If the Figma Make output includes design tokens (colors, spacing, type scale), reference the mockups in `/design/` and extract values. Otherwise, derive from the mockups.
- **Loading states:** Minimal SVG spinners or skeleton placeholders for async content.
- **Error handling:** Toast notifications for errors (RTMS disconnects, LLM failures, network issues). Non-blocking, auto-dismiss, manually dismissible.

---

## Navigation & Layout Shell

### App Shell

Persistent header across all authenticated views:

```
[← Back] [Page Title / Arlo Icon]          [🔍] [🌓] [⚙]
```

- **Left:** Back arrow (when drilled into a sub-view) or Arlo icon/name (at Home root).
- **Right:** Search icon, theme toggle, settings gear.
- **Search:** At 372px, the search icon expands into a full-width input field overlay. Search queries transcript content across all meetings. Results display as a dropdown list of matching meetings — tapping a result navigates to that meeting's detail view. Pressing Enter in the search input navigates to the full `/search` route.

### Navigation Model

Back-arrow drill-down. No persistent tab bar or sidebar. The navigation hierarchy:

```
/ (Root — landing page in browser, redirect to /auth in Zoom)
├── /auth (In-client Zoom OAuth PKCE)
├── /welcome (Post-Marketplace OAuth success/onboarding)
├── /auth-error (OAuth error with retry)
├── /guest (Guest — no meeting context)
├── /guest/{currentMeetingUUID} (Guest — in meeting)
├── /home (Home — authenticated root)
│   ├── /meetings (Meetings List)
│   │   └── /meetings/[meetingID] (Meeting Detail)
│   ├── /meeting/{currentMeetingUUID} (In-Meeting — live)
│   ├── /upcoming (Upcoming Meetings)
│   ├── /search?q=... (Search Results)
│   └── /settings (Settings)
```

### "Return to Live Transcript" Banner

When the user is in an active meeting (determined by Zoom Apps SDK meeting context) and navigates away from the In-Meeting view to Home, Meetings List, or Meeting Detail, display a sticky banner below the header:

```
[🔴 Return to live transcript                          →]
```

- Tapping navigates back to `/meeting/{currentMeetingUUID}`.
- Dismiss automatically when the meeting ends (meeting context clears).
- Do not show on `/guest/*` routes or when no meeting is active.

---

## Routes & View Specifications

### Route: `/` — Root

**Access:** Context-dependent. `RootView` detects the running environment:
- **Inside Zoom client:** Redirect to `/auth` (in-client PKCE flow).
- **Browser + authenticated:** Redirect to `/home`.
- **Browser + unauthenticated:** Render `LandingPageView` (marketing landing page).

**LandingPageView rendering (browser only):**
- Hero section with Owl icon (64px), heading, and value proposition copy.
- 6 feature cards: Live Transcription, AI Summaries, Searchable History, Instant Access, Secure & Private, Team Ready.
- 3-step onboarding guide: Install → Start Meeting → Get AI Insights.
- FAQ section with collapsible answers.
- CTA button: **"Install from Zoom Marketplace"** → links to `GET /api/auth/start` (web OAuth redirect).
- No header, no navigation. Standalone landing page.

**Implementation notes:**
- Auth flow uses **Zoom in-client OAuth with PKCE**, implemented in `useZoomAuth` hook (`frontend/src/hooks/useZoomAuth.js`). This is the single source of truth for the auth flow.
- **PKCE flow sequence:**
  1. Frontend calls `GET /api/auth/authorize` to get a `codeChallenge` and `state` from the backend.
  2. Frontend registers an `onAuthorized` event listener on the Zoom SDK *before* calling `zoomSdk.authorize()` — this ordering is critical to avoid a race condition where the SDK fires the event before the listener is registered.
  3. `zoomSdk.authorize({ codeChallenge, state })` hands off to Zoom's native OAuth UI.
  4. Zoom fires `onAuthorized` with `{ code }`. **Note:** The SDK does *not* return `state` in this event — the hook uses the `state` captured in the closure from step 1.
  5. Frontend calls `POST /api/auth/callback` with `{ code, state }` (with `credentials: 'include'`).
  6. Backend exchanges the code for tokens, creates/updates the user, and returns a session cookie.
  7. Frontend calls `login(user, wsToken)` and navigates to `/home`.
- **Session restoration:** On app load (or Zoom WebView reload), `AuthContext` calls `GET /api/auth/me` to restore the session from the httpOnly cookie. A loading spinner displays during this check to prevent an auth-screen flash.
- **User info fallback:** If the `user:read` OAuth scope is not configured, the backend falls back to decoding the JWT access token payload to extract user ID and name.
- **Token encryption:** Access tokens are stored AES-128-CBC encrypted in Postgres (the `REDIS_ENCRYPTION_KEY` env var provides a 16-byte hex key).
- On successful OAuth callback, redirect to `/home`.

**Web OAuth redirect flow (browser/Marketplace install):**
- `GET /api/auth/start` redirects to `https://zoom.us/oauth/authorize` with `client_id`, `redirect_uri`, and CSRF `state`.
- Zoom redirects back to `GET /api/auth/callback` with `code` and `state`.
- Backend exchanges code for tokens using `client_secret` (no PKCE — server-side flow).
- On success: creates/upserts user, sets session cookie, redirects to `/#/welcome`.
- On error: redirects to `/#/auth-error?error=...&message=...`.

---

### Route: `/welcome` — Post-Install Onboarding

**Access:** Authenticated (redirected here after successful Marketplace OAuth install).

**Rendering:**
- **Loading state:** Spinner + "Connecting to Zoom..." (while `AuthContext` restores session).
- **Success state:** Welcome heading, user name greeting, "Next Steps" instructions (static).
- **Session expired fallback:** "Go to Home" button.

**Implementation notes:** Future enhancement — fetch upcoming meetings via `GET /api/zoom-meetings` and display auto-open toggles to make the post-install experience more actionable.

---

### Route: `/auth-error` — OAuth Error

**Access:** Unauthenticated (redirected here on OAuth failure).

**Rendering:**
- Error message from `?error=...&message=...` query params.
- "Try again" button → `GET /api/auth/start`.
- Diagnostic information for debugging.

---

### Route: `/guest` — Guest Mode (No Meeting Context)

**Access:** Guest users (unauthenticated or authenticated-but-not-authorized) not currently in a meeting. Auto-detected via `getUserContext().status` in `ZoomSdkContext`.

**Rendering:**
- Centered layout (max-width 400px) with OwlIcon (64px) at top.
- Heading: **"You've been invited to use Arlo"** (serif, text-2xl) + subtitle.
- **"What is Arlo?" card** — Explanatory paragraph about live transcripts, AI summaries, and action items.
- **Three feature cards** (vertical stack), each with icon + title + guest-specific description:
  1. Mic icon (accent) + **"Live Transcript"** + "Follow along with a real-time transcript of the conversation. See who said what, with timestamps."
  2. Sparkles icon (accent) + **"AI Summary"** + "Key takeaways, decisions, and action items — generated as the meeting progresses."
  3. Bookmark icon (accent) + **"Highlights"** + "View moments the host has bookmarked as important."
- **Comparison table** — Guest vs Full Access with Check/Minus icons showing read-only access for guests (Live transcript, AI summary, Highlights) and full access features for authorized users (Meeting history, Full-text search).
- **Elevation CTA** — Two-button layout:
  - Primary: **"Sign in to Zoom"** (unauthenticated) or **"Add Arlo to Your Account"** (authenticated) → calls `zoomSdk.promptAuthorize()`.
  - Secondary: **"Continue as guest"** → navigates to `/guest/:meetingUUID` if in meeting.

**Routing logic:** `RootView` detects guest state via `isGuest` (derived from `getUserContext().status !== 'authorized'` in `ZoomSdkContext`). Guests not in a meeting auto-route here. `ProtectedRoute` also redirects unauthorized guests here instead of `/auth`.

---

### Route: `/guest/{currentMeetingUUID}` — Guest Mode (In Meeting)

**Access:** Guest users (unauthenticated or authenticated-but-not-authorized) in a meeting where the host has active transcript data. Auto-detected via `getUserContext().status` + `runningContext === 'inMeeting'` in `ZoomSdkContext`.

**Rendering:**

- **Compact header bar:** OwlIcon (20px) + "Arlo" branding (left), meeting title from `meetingContext.meetingTopic` or DB (center), Live/Ended badge (right). No navigation.

- **Live transcript area** (~60% viewport): WebSocket-powered real-time transcript streaming via `connectWebSocket(null, meetingId)` (anonymous connection, no token required). Chronological timeline merging transcript segments and participant events (join/leave, transcription lifecycle). Speaker labels, timestamps, and text at full opacity. Auto-scroll with "Scroll to live" button. Uses Base UI `ScrollArea`.

- **Collapsible summary card:** Native `<details>/<summary>` element. Collapsed: Sparkles icon + "Meeting Summary" + rotating chevron. Expanded: Overview paragraph + Key Decisions list + Key Points list + Action Items list. Skeleton loading state while live. Auto-expanded when meeting ends. Data from `GET /api/meetings/by-zoom-id/:zoomMeetingId` (uses `optionalAuth`, works without auth).

- **Viewer count:** Subtle bar showing "N others viewing" when `viewerCount > 2` (subtracts self). Data from `meeting.presence` WebSocket events.

- **Disabled AI chat teaser:** Lock icon + "Ask a follow-up question..." placeholder + "Sign in to Zoom / Add Arlo to chat" link → `zoomSdk.promptAuthorize()`.

- **Post-meeting state:** When `meeting.status` → `rtms_stopped` via WebSocket, replaces Live badge with "Ended" muted badge. Shows full summary expanded. Prominent install CTA card with OwlIcon, heading, value prop, and `promptAuthorize` button.

- **Sticky bottom CTA bar:** "Want to capture your own meetings?" + accent "Install Arlo" / "Sign in to Zoom" button (adapts to `userContextStatus`) + X dismiss. Dismissible via `sessionStorage`. Hidden when meeting ended (replaced by inline CTA card).

**Read-only enforcement:** No transport controls, no AI chat, no highlights/bookmarks, no title editing, no settings.

**Data dependencies:**
- WebSocket anonymous connection for live transcript segments, participant events, meeting status, and presence.
- `GET /api/meetings/by-zoom-id/:zoomMeetingId` for meeting title and cached summary (uses `optionalAuth`).
- `GET /api/meetings/by-zoom-id/:zoomMeetingId/transcript` for historical segments on mount.
- `GET /api/meetings/by-zoom-id/:zoomMeetingId/participant-events` for historical participant events.

---

### Route: `/home` — Home

**Access:** Authenticated. This is the default landing for logged-in users.

**Rendering (content hierarchy, top to bottom):**

1. **Upcoming Meetings section** — "Upcoming meetings" heading with "View all" link to `/upcoming`. Shows the next 3 scheduled Zoom meetings fetched from `GET /api/zoom-meetings`. Each card shows: meeting topic, date/time range, and an auto-open toggle with "Auto-open" badge when enabled. "View all" navigates to the full `/upcoming` view.
2. **Meeting in Progress card** (conditional) — Accent-tinted card with "Start Transcription" button. Shown when user is in an active Zoom meeting but RTMS is not yet active.
3. **Weekly Digest card** — "Your week in review" heading with:
   - Stats row: meeting count + total time (large serif numbers with small sans labels)
   - Top topics: Badge components (secondary variant)
   - AI summary text below a border-top separator
   - Data: hardcoded mock data with TODO for future API endpoint.
3. **Action Items section** — "Action items this week" heading with:
   - Cards with checkbox, task text (serif), owner/due/meeting metadata
   - Completed items filtered out of main list
   - Data: hardcoded mock data with TODO for API integration.
5. **Recurring Topics section** — "Recurring topics" heading with:
   - Card with badge chips (outline variant, hover effect), subtitle "Topics mentioned in 2+ meetings this week"
6. **This week's highlights** — LLM-generated highlight cards (from `/api/home/highlights`).
7. **Reminders from yesterday** — Takeaways from previous day's meetings (from `/api/home/reminders`).
8. **View all meetings** — Full-width outline button navigating to `/meetings`.

**Empty state:** When no meetings exist, replace highlights and reminders with a centered message: *"No meetings yet — Connect your Zoom account or start Arlo in a meeting."*

**Data dependencies:**
- List of meetings from the current week with LLM-generated summaries/highlights.
- List of meetings from yesterday with LLM-generated takeaways.
- Meeting count (to determine empty state).
- Weekly digest, action items, and recurring topics (currently mock data — API endpoints planned).

---

### Route: `/meetings` — Meetings List

**Access:** Authenticated.

**Rendering:**
- Compact card list, reverse chronological order (newest first).
- Each meeting card displays: **Title**, **Date**, **Duration**, **Participant display names** (truncate with "+N more" if many), **"View" button** → navigates to `/meetings/[meetingID]`.
- **Live indicator:** If a meeting is currently active (match against current meeting context from Zoom Apps SDK), display a **"Live" badge** on that card. Tapping the card navigates to `/meeting/{currentMeetingUUID}` (In-Meeting view), not the static Meeting Detail.
- Paginate or infinite scroll if the list is long.

**Empty state:** *"Use Arlo in meetings to start capturing context."*

**Data dependencies:**
- All meetings for the authenticated user, ordered by date descending.
- Current meeting context (to flag live meetings).

---

### Route: `/search` — Search Results

**Access:** Authenticated.

**Rendering:**
- Large search input at top (auto-focused, pre-filled with `?q=` query param), search icon inside input.
- Result count text: "N results for 'query'"
- Results as clickable Card components: meeting title (serif), matched transcript text with `<mark>` highlighting, speaker/timestamp/date metadata. Click navigates to `/meetings/[meetingID]`.
- **Empty state (no results):** OwlIcon + "No results found" + help text.
- **Initial state (no query):** Search icon + "Search across all your meetings".
- **Multi-source search:** Queries meeting titles, AI summaries (JSONB fields), and transcripts in parallel. Results are prioritized by source (titles first, summaries second, transcripts third) with section labels and type badges when multiple categories match.
- **AppShell search dropdown:** Typing in the header search shows a dropdown with up to 5 results and type badges. Pressing Enter navigates to the full `/search` route.
- Data: calls `GET /api/search?q=...` endpoint.

---

### Route: `/meetings/[meetingID]` — Meeting Detail

**Access:** Authenticated.

**Layout:** Meeting header (editable title, date, duration) at top, export + delete buttons, then a 5-tab interface below.

**Meeting Title (inline edit):**
- Default state: Title shows normally; pencil icon appears on hover (opacity transition).
- Click title: Switch to edit mode — Input field (serif font, text-2xl, auto-focused, text selected), Check button, X button.
- Enter key: Save via `PATCH /api/meetings/:id` with `{ title }`. Escape key: Cancel.
- Save shows Loader2 spinner on check button during API call.
- **AI title generation:** Sparkle icon button next to the title calls `POST /api/meetings/:id/generate-title` to generate a concise, descriptive title from the transcript/summary. Generated title pre-fills the inline editor for review before saving.

**Delete Meeting:**
- Trash2 icon button in the export row (destructive outline variant).
- Opens a confirmation dialog: "Delete this meeting?" with warning text, Cancel + Delete buttons.
- Delete button (red, destructive) calls `DELETE /api/meetings/:id`, then navigates to `/meetings`.

**Tabs:**

#### Tab 1: Summary
- AI-generated meeting summary.
- **"Ask about this meeting"** input — inline below the summary. Single-question interface: user submits a question, the LLM response renders inline below the input, expanding the section. Input resets for another question. Not a persistent chat history — one question/answer pair visible at a time.

#### Tab 2: Transcript / Timeline
- Full scrollable transcript. Each entry: **speaker label**, **timestamp**, **text**.
- Search within transcript — input at top of the tab, highlights matching terms, "jump to next/previous hit" controls.
- If the meeting is currently live (meetingID matches active meeting context), enable **follow-live mode** by default. Scroll position locks to the latest entry. Scrolling up detaches follow-live. A **"Scroll to live" button** appears anchored at the bottom of the transcript container to re-attach.

#### Tab 3: Participants
- List of participants by display name (no avatars).
- Per participant: attendance (join/leave times or total duration), speaking duration.

#### Tab 4: Highlights & Tasks
- AI-generated takeaways as a list.
- Action items table:

| Owner | Task | Due | Source |
|-------|------|-----|--------|

- **Source** is a timestamp that, when clicked, switches to the Transcript tab and scrolls to that timestamp.

#### Tab 5: Timeline
- Participant timeline visualization showing when each participant joined and left the meeting.
- **Data source:** `ParticipantEvent` model in database — tracks `joined`/`left` events with millisecond timestamps. Events are recorded by the RTMS service during transcript ingestion.
- **Initial roster filtering:** Zoom fires a batch of `participant_joined` events when RTMS connects. These are distinguished from real joins using a `firstTranscriptReceived` flag — events before the first transcript segment are classified as initial roster (not displayed as join events).
- **Rendering:** `ParticipantTimeline` component with:
  - Time axis (15-minute tick marks) and participant swimlanes.
  - Participant name (left, fixed 128px width, right-aligned, sans) + horizontal bar (width = duration/meetingDuration %, muted color, rounded).
  - 5 muted colors cycling: blue, purple, green, orange, pink (light/dark mode variants).
  - Hover: show duration text inside bar (opacity transition).
- **No data state:** Card with "No participant events recorded" message.

**Export (below tabs or in the header area):**
- Two buttons: **"Export VTT"** and **"Export MD"**.
- VTT export: Generate a WebVTT file from the transcript data.
- MD export: Generate a Markdown file including summary, highlights, action items, and transcript.

---

### Route: `/meeting/{currentMeetingUUID}` — In-Meeting (Live)

**Access:** Authenticated. Only renders when the Zoom Apps SDK reports the app is running inside an active meeting.

**Routing logic:** On app load, check `zoomSdk.getMeetingContext()` (or equivalent). If a meeting is active, route to this view. If the user manually navigates here without an active meeting, redirect to `/home`.

**Layout:** Meeting header (meeting title from Zoom context), then two tabs.

#### Tab 1: Transcript
- Live-scrolling transcript with speaker labels and timestamps.
- **Inline participant events:** Join/leave events and transcription lifecycle changes (started, paused, resumed) are displayed inline in the transcript flow as muted system messages.
- **Transport controls card** (above transcript) with 3 states:
  - **Live (recording):** Pulsing red dot + "Transcribing" label, Pause button (outline), Stop button (destructive outline).
  - **Paused:** Orange "Paused" badge, Resume button (accent, Play icon), Stop button (destructive outline). "Transcript paused" floating pill above transcript.
  - **Stopped/not-started:** Start transcription prompt.
- **Follow-live mode:** On by default. Scrolling up detaches. **"Scroll to live" button** anchored at the bottom of the transcript area to re-attach.
- **Suggestion bubbles:** Real-time LLM-generated nudges (e.g., "Summarize the last 5 minutes," "This sounds like a commitment — capture it?"). Render as small dismissible chips/bubbles overlaid at the bottom of the transcript area, above the "Scroll to live" button. Informational only — no action on tap beyond dismiss (X button). New suggestions push older ones out or stack with a limit (e.g., max 2–3 visible).
- **Chat notices:** When transcription state changes (start, pause, resume, stop, restart), Arlo sends an automatic message to the Zoom meeting chat notifying participants. Each event type has an independent toggle and customizable message template with `[meeting-id]` placeholder support. Configured in Settings.
- **Guest count indicator:** When guests are viewing via Arlo, shows Eye icon + "N guest(s) viewing" in the header area (below meeting title). Data from `meeting.presence` WebSocket events, only displayed when `guestCount > 0`.
- **Invite button:** Share2 icon button in transport controls, conditionally shown when `viewers.viewerCount > 1` (other participants present). Dropdown with two options: "Invite all participants" (`sendAppInvitationToAllParticipants`) and "Choose participants..." (`showAppInvitationDialog`). 3-second green check confirmation state after sending. Toast notification on success. Click-outside dismiss.

#### Tab 2: Arlo Assist
- **Notes:** LLM-generated draft meeting notes, displayed as markdown-formatted bullets. User-editable (contenteditable or textarea).
- **Action Items:** LLM-captured commitments with owner assignment. Owner is selected from the meeting's participant list. Simple list format — each item: owner, task description, optional due.

#### Pre-Transcript States

Before transcript data is flowing, the In-Meeting view replaces the tabbed content with one of three states based on client-readable app state:

**State 1 — Host, transcription not started:**
- The user is the meeting host (from Zoom Apps SDK context).
- Transcript data has not started flowing (from client app state).
- Render: Centered prompt with button: **"Start Transcription"**.
- Action: Triggers the RTMS transcription start flow.

**State 2 — Non-host, transcription not started:**
- The user is not the host.
- Transcript data has not started flowing.
- Render: Centered prompt with button: **"Request Transcript Access"**.
- Action: Sends a request (implementation TBD — may be an in-meeting notification to the host or an API call). After tapping, transition to State 3.

**State 3 — Non-host, waiting:**
- The user has requested access or is waiting for the host to start.
- Render: *"Waiting for host to start transcription."* with a subtle loading indicator (spinner or pulsing dot).

**Transition:** When transcript data begins flowing (detected via client state polling or WebSocket/SSE event), automatically transition from any pre-transcript state to the live transcript tab view.

**Note on auto-start:** The host may have configured auto-start transcription in their Zoom web settings (external to Arlo). In this case, transcript data may already be flowing when the app opens — skip pre-transcript states entirely and render the live transcript.

---

### Route: `/settings` — Settings

**Access:** Authenticated.

**Rendering:** Page heading "Settings" (serif, 2xl) + subtitle "Configure Arlo's behavior and AI provider" (sans, muted).

**Transcription Preferences section:** Heading + Card containing:
- **"Auto-open in meetings"** — toggle switch + description ("Automatically open Arlo when your Zoom meetings start"). When enabled, expands to show a compact list of upcoming meetings with per-meeting auto-open toggles (fetched from `GET /api/zoom-meetings`). Links to `/upcoming` for full control. Auto-open state persisted via Zoom `open_apps` API and `User.preferences.autoOpenMeetings`.
- Border-top separator
- **"Auto-start transcription"** — toggle switch + description ("Begin capturing transcript as soon as you join"). Persisted to localStorage and `/api/preferences` API (`autoStartRTMS` key). When enabled, RTMS starts automatically at the provider level (MeetingContext) as soon as the user is authenticated and in a meeting.
- Toggle: custom CSS switch (44px wide, 24px tall, rounded-full, bg muted when off, bg accent when on).

**AI Configuration section:** Heading + Card containing:
- **"AI Provider"** — `<select>` dropdown (OpenRouter, Anthropic, OpenAI, Custom) + helper text
- **"API Key"** — password input with Eye/EyeOff toggle button (hidden when provider = OpenRouter)
- **"Model"** — `<select>` dropdown (options change based on provider) + helper text
- **"Test Connection"** — outline button with status feedback (idle/testing/success/error states using CheckCircle2/XCircle icons)

State is local for now (no backend persistence) — API integration planned.

**Chat Notices section:** Heading + Card containing:
- **Master toggle:** "Send chat notices" — enables/disables all chat notifications.
- **Per-event toggles** (progressive disclosure — visible when master is on):
  - Transcription started
  - Transcription paused
  - Transcription resumed
  - Transcription stopped
  - Transcription restarted
- **Editable message templates:** Each event has a customizable message with `[meeting-id]` placeholder support.
- **Live preview:** Shows the formatted message that will be sent to Zoom chat.
- Preferences persisted via `PUT /api/preferences` (server-side `User.preferences` JSON) and localStorage for zero-latency access during meetings.

---

### Route: `/upcoming` — Upcoming Meetings

**Access:** Authenticated.

**Rendering:**
- Page heading "Upcoming Meetings" (serif, 2xl) + subtitle "Enable auto-open so Arlo launches automatically when a meeting starts" (sans, muted).
- **Info banner** (blue, dismissible): "Auto-open requires the Zoom Apps Quick Launch setting to be enabled. Zoom allows up to 3 apps per meeting."
- **Warning banner** (amber, dismissible): Shown when 3+ meetings have auto-open enabled (Zoom's per-meeting app limit).
- **Meeting list:** Cards for each upcoming Zoom meeting showing:
  - Meeting topic (serif, bold)
  - Full date + time range (e.g., "Monday, February 16, 2026 · 8:00 AM – 8:30 AM")
  - "Recurring" label + Zoom Meeting ID
  - Auto-open toggle switch (right-aligned) with "Auto-open" label and blue "Auto-open" badge when enabled
- **Auto-open toggle action:** `POST /api/zoom-meetings/:meetingId/auto-open` to enable, `DELETE /api/zoom-meetings/:meetingId/auto-open` to disable. Calls Zoom's `open_apps` API to register/unregister Arlo for auto-launch.
- **Sticky bottom bar:** "Manage auto-open preferences" text + link to Settings.

**Data dependencies:**
- Upcoming meetings from `GET /api/zoom-meetings` (proxies Zoom REST API `GET /v2/users/me/meetings?type=upcoming`).
- Auto-open state per meeting from user preferences (`User.preferences.autoOpenMeetings` array).
- Requires `meeting:read` and `meeting:write:open_app` OAuth scopes.
- Requires `ZOOM_APP_ID` environment variable (Marketplace App ID, different from Client ID).

---

## Global Component Inventory

These components are used across multiple views and should be implemented as reusable:

| Component | Used In | Description |
|-----------|---------|-------------|
| **AppShell / Header** | All authenticated routes | Persistent header with back nav, search, theme toggle, settings |
| **SearchOverlay** | Home, Meetings List, In-Meeting | Expands from icon, queries transcripts, returns meeting list dropdown |
| **ThemeToggle** | Header | Light/dark mode switch, persists preference |
| **ReturnToLiveBanner** | All authenticated routes (conditional) | Sticky banner when user navigates away from active In-Meeting view |
| **MeetingCard** | Meetings List, Home (highlights) | Compact card: title, date, duration, participants, live badge |
| **TabBar** | Meeting Detail, In-Meeting | Horizontal tab navigation within a view |
| **TranscriptViewer** | Meeting Detail (Tab 2), In-Meeting (Tab 1) | Scrollable transcript with speaker labels, timestamps, search, follow-live |
| **FollowLiveButton** | TranscriptViewer | "Scroll to live" anchored button, appears when detached from live scroll |
| **SuggestionBubble** | In-Meeting (Tab 1) | Dismissible overlay chip for LLM nudges |
| **AskInput** | Meeting Detail (Tab 1) | Single-question input with inline expandable response |
| **ActionItemsTable** | Meeting Detail (Tab 4), In-Meeting (Tab 2) | Owner / Task / Due / Source table |
| **ExportButtons** | Meeting Detail | "Export VTT" and "Export MD" buttons |
| **DeleteMeetingDialog** | Meeting Detail | Confirmation dialog for meeting deletion |
| **ParticipantTimeline** | Meeting Detail (Tab 5) | Swimlane timeline visualization with colored bars per participant |
| **InfoBanner** | Upcoming Meetings | Blue dismissible banner for contextual guidance |
| **WarningBanner** | Upcoming Meetings | Amber dismissible banner for limit warnings |
| **EmptyState** | Home, Meetings List, Search | Centered message with contextual copy |
| **Toast** | Global | Error/info notifications, auto-dismiss |
| **LoadingIndicator** | Global | SVG spinner or skeleton placeholder |

---

## State & Routing Logic Summary

```
On app load:
├── Is app running inside Zoom client?
│   ├── YES (in-client):
│   │   ├── Is user authenticated?
│   │   │   ├── NO → /auth (in-client PKCE flow)
│   │   │   └── YES → Is the app inside an active meeting?
│   │   │       ├── YES → /meeting/{currentMeetingUUID}
│   │   │       │   └── Is transcript data flowing?
│   │   │       │       ├── YES → Render live transcript tabs
│   │   │       │       └── NO  → Is user the host?
│   │   │       │           ├── YES → "Start Transcription" prompt
│   │   │       │           └── NO  → "Request Access" / "Waiting" state
│   │   │       └── NO  → /home
│   │   └── Guest mode (getUserContext().status !== 'authorized'):
│   │       ├── In meeting? → /guest/{currentMeetingUUID}
│   │       └── Not in meeting → /guest
│   └── NO (browser):
│       ├── Authenticated? → /home
│       └── Not authenticated → / (LandingPageView)
│           ├── "Install from Marketplace" → GET /api/auth/start → Zoom OAuth
│           ├── Success → /welcome (OnboardingView)
│           └── Error → /auth-error (OAuthErrorView)
```

Key client-side state to track:
- **Auth state:** Authenticated vs. guest vs. unauthenticated.
- **Meeting context:** From Zoom Apps SDK — is a meeting active? What is the meeting UUID? Is the user the host?
- **Transcript state:** Is transcript data currently flowing for this meeting? (Polled from server or pushed via WebSocket/SSE.)
- **Theme preference:** Light or dark. Persisted in localStorage or equivalent.
- **Active meeting flag:** Used to conditionally render the "Return to live transcript" banner across non-In-Meeting views.
