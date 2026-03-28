# Arlo Meeting Assistant — Project Status

**Last Updated:** 2026-03-25
**Version:** v1.0
**Spec:** See [`/SPEC.md`](../SPEC.md) for the authoritative feature specification and version milestones.

---

## Overview

**Developer reference implementation** for building real-time meeting intelligence using Zoom's RTMS (Real-Time Media Streams) — no meeting bot required.

> **Important framing:** Arlo is a reference implementation, not a product. Demos should emphasize what developers can build with RTMS rather than presenting Arlo as the end product. The industry verticals are illustrative examples showing real-time capabilities tailored for specific domains.

**Current state:** The v1.0 UI is feature-complete. The frontend has been decomposed from a monolithic component into a multi-view architecture with HashRouter, 14 views, 5 context providers, and a shared AppShell. All Figma Make designs have been ported into the CRA + plain CSS codebase. In-client OAuth PKCE and browser-based web OAuth (Marketplace install) are both working. OS dark mode detection is implemented. New API endpoints support the home dashboard, upcoming meetings, user preferences, and participant event tracking. RTMS auto-start runs at the provider level (MeetingContext) so transcription begins as soon as the user is authenticated and in a meeting, regardless of which view is active. Upcoming meetings are fetched from Zoom's REST API with per-meeting auto-open toggles via the `open_apps` API. Participant events (join/leave) are tracked with an inline timeline in InMeetingView and a swimlane visualization in MeetingDetailView. Meetings started by RTMS before the user opens Arlo are automatically attributed to the real user via RTMS operator ID. See [SPEC.md](../SPEC.md) for the full feature inventory.

---

## Technology Decisions

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Node.js 20+ | Best ecosystem for Zoom SDK and RTMS |
| **Frontend** | React 18 + CRA 5 | Industry standard, Zoom App compatible |
| **UI Library** | `@base-ui/react` + plain CSS | Unstyled, accessible, CSS custom properties |
| **Routing** | `react-router-dom@6` (HashRouter) | Hash-based routing safe for Zoom iframe |
| **Icons** | `lucide-react` | Lightweight, tree-shakeable icon library |
| **Fonts** | Source Serif 4 + Inter (self-hosted) | Zoom WebView blocks Google CDN fonts |
| **Backend** | Express.js (JavaScript) | Simple, flexible, well-documented |
| **Database** | PostgreSQL 15+ | Full-text search (GIN index), JSON support |
| **ORM** | Prisma | Type-safe, great migrations, modern |
| **AI Provider** | OpenRouter | Free models (Gemini Flash), no API key required |
| **RTMS SDK** | `@zoom/rtms` v1.0.2 | Class-based Client API, multi-meeting support |
| **Auth** | Zoom OAuth (PKCE) | Native to platform, httpOnly session cookies |
| **Containerization** | Docker Compose | Easy local dev, portable |

### Open Questions

| Question | Options | Status |
|----------|---------|--------|
| Redis required? | Redis vs in-memory | Testing needed (currently in-memory) |
| File storage for VTT | Local disk vs S3 | Starting with local |
| Vector DB for RAG? | pgvector vs FTS only | Starting without (FTS works well) |
| Deployment target | Railway, Render, Fly.io | Document all options |

---

## Code Statistics

- **Backend:** ~2,850 lines (9 route files, 4 services, middleware) — JavaScript/Express
- **Frontend:** ~11,600 lines (15 views, 6 contexts, 1 hook, 6 UI primitives, 14 shared components, 5 feature verticals) — React 18 + `@base-ui/react` + plain CSS
- **Feature Verticals:** ~6,400 lines across 5 verticals (general, healthcare, legal, sales, support)
- **RTMS:** ~370 lines (ingestion worker) — @zoom/rtms v1.0.2
- **Documentation:** 15+ guides including reusable Zoom Apps skills
- **Total:** ~15,000+ lines of production-quality code

---

## Progress Summary

### Completed

- Project foundation (monorepo, Docker Compose, Prisma schema, env config)
- Zoom OAuth PKCE flow with encrypted token storage
- RTMS integration (webhook handlers, transcript ingestion, @zoom/rtms v1.0.2)
- Live transcript display with WebSocket broadcast (< 1s latency)
- AI features: summary, action items, chat Q&A (OpenRouter)
- Auto-suggestions at configurable meeting duration
- Meeting history, rename, delete
- Highlights CRUD with timestamps and tags
- Full-text search (PostgreSQL GIN index)
- WebVTT export
- Frontend UI migration to `@base-ui/react` (Feb 2026)
- README, ARCHITECTURE.md, TROUBLESHOOTING.md, CLAUDE.md
- **v1.0 multi-view architecture** — HashRouter, 14 views, 5 context providers, AppShell with shared header
- **In-client OAuth PKCE flow** — `useZoomAuth` hook, session restoration via `GET /api/auth/me`, JWT fallback
- **OS dark mode detection** with localStorage override and theme toggle
- **Self-hosted fonts** — Source Serif 4 + Inter WOFF2 files (Zoom WebView blocks Google CDN)
- **New API endpoints** — `/api/home/highlights`, `/api/home/reminders`, `/api/ai/summary`, `/api/meetings/:id/export/markdown`
- **UI primitives** — Button, Card, Badge, Input, Textarea, LoadingSpinner
- **LiveMeetingBanner** — "Return to live transcript" sticky banner
- **MeetingCard** — Reusable meeting card component with live badge support
- **v1.0 Figma UI implementation** (Feb 2026):
  - **Search Results View** — Full `/search` route with query highlighting, empty/initial states
  - **Delete Meeting Dialog** — Confirmation dialog + trash button in meeting detail
  - **Rename Meeting** — Inline title editing with pencil icon, PATCH API save
  - **Transport Controls** — 3-state (live/paused/stopped) with red recording dot, orange pause badge, destructive stop button
  - **Guest No-Meeting** — Redesigned with 3 feature cards and "Connect with Zoom" CTA
  - **Guest In-Meeting** — Enhanced with live badge, summary skeleton, faded transcript preview, CTA card
  - **Home Dashboard** — Weekly digest, action items with checkboxes, recurring topic badges, AI-powered weekly digest and cross-meeting insights
  - **AI-generated meeting titles** — Sparkle icon generates descriptive title from transcript/summary
  - **Participant Timeline** — 5th tab in MeetingDetail with colored swimlane bars
  - **Settings View** — Transcription toggles, AI provider/model/API key config, test connection
  - **Pause/Resume RTMS** — Real `pauseRTMS`/`resumeRTMS` SDK calls, `rtmsPaused` state in MeetingContext
- **Provider-level RTMS auto-start** — Auto-start logic moved from InMeetingView to MeetingContext so it fires regardless of which view is active. User lands on HomeView with LiveMeetingBanner linking to the live transcript. Context-aware routing via `getRunningContext()` guards InMeetingView.
- **Chat notices for transcription lifecycle** — Automatic Zoom chat messages for start/pause/resume/stop/restart with per-event toggles and customizable templates
- **Upcoming meetings + auto-open** — Zoom REST API integration (`GET /v2/users/me/meetings`, `POST /meetings/{id}/open_apps`) with reusable `zoomApi` service (token auto-refresh, 401 retry). UpcomingMeetingsView with per-meeting auto-open toggles, info/warning banners, sticky bottom bar. Home dashboard shows top 3 upcoming meetings. Settings auto-open toggle reveals compact meeting list. Toast undo support. Requires `meeting:read`, `meeting:write:open_app` scopes and `ZOOM_APP_ID` env var.
- **Web OAuth redirect flow** — Browser-based OAuth for Marketplace installs (`GET /api/auth/start` → Zoom OAuth → `GET /api/auth/callback`). Three new views: LandingPageView, OnboardingView, OAuthErrorView.
- **Participant event tracking + timeline** — `ParticipantEvent` DB model, swimlane timeline visualization (`ParticipantTimeline` component), inline events in InMeetingView. Initial roster filtering via `firstTranscriptReceived` flag.
- **Meeting attribution via RTMS operator ID** — Orphaned meetings (created by system user during RTMS auto-start) are automatically reassigned to the real user when they open Arlo.
- **Industry Verticals** (Mar 2026) — 5 specialized modes with custom UI components:
- **Documentation reframing** (Mar 2026) — Repositioned Arlo as a developer reference implementation showcasing RTMS real-time capabilities, not a product. Added "What You Can Build with RTMS" section to README.
- **Legal vertical enhancements** (Mar 2026):
  - **BillableTimeTracker** — Auto-log billable segments with activity codes, matter association, running totals, and CSV export
  - **ContradictionDetector enhancements** — Real-time flagging, impeachment outline generation, export for case preparation
  - Industry adoption context noting focus on depositions/trials
- **Developer infrastructure** (Mar 2026):
  - GitHub issue templates (bug report, feature request, question)
  - Smoke tests (`tests/smoke.test.js`, run with `npm test`)
  - Fresh install checklist (`docs/FRESH_INSTALL_CHECKLIST.md`)
  - Demo video script (`docs/DEMO_VIDEO_SCRIPT.md`) emphasizing RTMS capabilities
  - **General (Default)**: MeetingSummary, KeyMoments, DecisionsLog, OpenQuestions, ParticipantStats, SmartBookmarks
  - **Healthcare**: SOAPNotesPanel, PatientContextCard, ClinicalAlerts, QuickActions, PreviousSessionsCard, HealthcareTagsSummary
  - **Legal**: ContradictionDetector, BillableTimeTracker, LegalTermsPanel, ExhibitTracker, PrivilegeMarkers
    - *Industry context:* Focused on depositions/trials where recording is standard. Lawyers outside formal proceedings may be hesitant to record calls.
  - **Sales**: DealTracker, QualificationSignals, CompetitorMentions, CommitmentsPanel
  - **Support**: SentimentMeter, EscalationAlerts, ResolutionTracker, AgentAssist
  - VerticalContext provider with accent colors, terminology customization, feature flags
  - VerticalSelectorView for first-run setup, Settings toggle for switching

### Not Yet Done

- CI pipeline (GitHub Actions)
- Demo video recording
- Security audit
- Post-meeting standalone web app (v1.5 goal)
- **Industry Vertical AI Integration** — Vertical components currently use demo data. Future work:
  - Real-time AI extraction for medical terms, legal terms, competitor mentions
  - Sentiment analysis from transcript segments
  - Auto-detection of decisions, questions, action items
  - Integration with existing AI service for vertical-specific prompts

---

## Next Actions

1. [x] End-to-end testing checklist (`docs/FRESH_INSTALL_CHECKLIST.md`)
2. [x] Add basic smoke tests (`tests/smoke.test.js`, run with `npm test`)
3. [x] Add GitHub issue templates (`.github/ISSUE_TEMPLATE/`)
4. [x] Create demo video script (`docs/DEMO_VIDEO_SCRIPT.md`)
5. [ ] Record demo video
6. [ ] Security audit (OWASP checklist)
7. [ ] Set up CI pipeline (GitHub Actions)
8. [ ] Public launch

---

## Related Documentation

- [`/SPEC.md`](../SPEC.md) — Feature specification and version milestones
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — System architecture details
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — Common issues and fixes
- [`/CLAUDE.md`](../CLAUDE.md) — Claude Code quick reference
