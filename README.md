<div align="center">

<img src="./docs/assets/arlo-logo.png" alt="Arlo" width="200"/>

# Arlo Meeting Assistant

**Build Real-Time Meeting Intelligence with Zoom RTMS**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Zoom RTMS](https://img.shields.io/badge/Zoom-RTMS-2D8CFF.svg)](https://www.zoom.com/en/realtime-media-streams/)

[Get Started](#-quick-start) · [See Demos](#-see-it-in-action) · [Features](#-features) · [Troubleshooting](#-troubleshooting)

</div>

---

## What is Arlo?

Arlo is an **open-source reference implementation** that demonstrates the power of Zoom's RTMS (Real-Time Media Streams) APIs. It shows developers how to build meeting assistants that capture **live transcripts without requiring a bot in the meeting**.

<table>
<tr>
<td width="50%">

### Use This Project To

- **Learn** how RTMS webhooks, WebSockets, and transcript streaming work
- **Fork and customize** for your specific use case
- **Prototype** meeting intelligence applications
- **Understand** Zoom Apps authentication and best practices

</td>
<td width="50%">

### What You'll Build

- Live transcription with < 1 second latency
- AI-powered summaries and action items
- Full-text search across meetings
- Industry-specific modes (Healthcare, Legal, Sales)

</td>
</tr>
</table>

> **Note:** This is a starting point for developers. The industry verticals are illustrative examples showing what's possible with RTMS.

---

## See It In Action

<div align="center">

<!--
  DEMO VIDEO PLACEHOLDER
  Replace with: [![Arlo Demo](./docs/assets/demo-thumbnail.png)](https://youtube.com/watch?v=YOUR_VIDEO_ID)
-->

| | |
|:---:|:---:|
| **Live Demo Coming Soon** | |
| We're preparing video walkthroughs showing Arlo in action. | |
| Check back soon or [star this repo](https://github.com/zoom/arlo) to get notified! | |

</div>

---

## Features

| Feature | Description |
|---------|-------------|
| **Live Transcription** | Real-time captions via RTMS (< 1 second latency) |
| **AI Insights** | Summaries, action items, and next steps powered by OpenRouter |
| **Full-Text Search** | Search across all your meeting transcripts instantly |
| **Chat with Transcripts** | Ask questions about your meetings using AI |
| **Meeting Highlights** | Create bookmarks with timestamps for key moments |
| **Export Options** | Download WebVTT files or Markdown summaries |
| **Dark Mode** | Automatic OS detection with manual toggle |
| **Industry Verticals** | Specialized modes for Healthcare, Legal, Sales, and Support |

> **AI features work out of the box** — no API key required! Arlo uses [OpenRouter](https://openrouter.ai/) with free models (Gemini, Llama). Optional: add your own `OPENROUTER_API_KEY` for higher rate limits.

---

## Prerequisites

Before you begin, ensure you have:

| Requirement | Why You Need It |
|-------------|-----------------|
| **[Node.js 20+](https://nodejs.org/)** | Runtime for backend services |
| **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** | Runs PostgreSQL and all services |
| **[ngrok](https://ngrok.com/)** | Creates secure tunnels for Zoom webhooks |
| **[Zoom Account](https://marketplace.zoom.us/)** | To create and configure your Zoom App |

### RTMS Access Required

> **This app requires RTMS access from Zoom.** RTMS (Real-Time Media Streams) enables live transcript streaming.
>
> **[Request RTMS Access](https://www.zoom.com/en/realtime-media-streams/#form)** — Apply early, approval may take a few days.

---

## Quick Start

### 1. Clone & Set Up ngrok

```bash
# Clone the repository
git clone https://github.com/zoom/arlo.git
cd arlo
```

Start ngrok to create a public URL for Zoom webhooks:

```bash
# Option A: Static domain (recommended - free, doesn't change)
ngrok http 3000 --domain=your-name.ngrok-free.app

# Option B: Random domain (changes each restart)
ngrok http 3000
```

> **Tip:** Get a free static domain at [ngrok dashboard → Domains](https://dashboard.ngrok.com/domains) to avoid reconfiguring Zoom settings.

**Keep this terminal running** and note your URL (e.g., `https://your-name.ngrok-free.app`).

---

### 2. Create Your Zoom App

1. Go to **[Zoom Marketplace](https://marketplace.zoom.us/)** → Develop → Build App
2. Select **General App** → name it (e.g., "Arlo Meeting Assistant")
3. Copy your **Client ID** and **Client Secret**

---

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# From Zoom Marketplace (Step 2)
ZOOM_CLIENT_ID=your_client_id
ZOOM_CLIENT_SECRET=your_client_secret

# Your ngrok URL (Step 1)
PUBLIC_URL=https://your-name.ngrok-free.app

# Generate secrets (run these commands, paste the output)
SESSION_SECRET=       # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
REDIS_ENCRYPTION_KEY= # node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

---

### 4. Configure Zoom App Settings

In [Zoom Marketplace](https://marketplace.zoom.us/) → Your App:

<details>
<summary><strong>Basic Information</strong></summary>

| Setting | Value |
|---------|-------|
| OAuth Redirect URL | `https://YOUR-NGROK-URL/api/auth/callback` |
| OAuth Allow List | `https://YOUR-NGROK-URL` |

</details>

<details>
<summary><strong>Scopes</strong></summary>

Add these OAuth scopes:
- `meeting:read` — Read meeting details
- `user:read` — Read user profile

</details>

<details>
<summary><strong>Features → Zoom App SDK</strong></summary>

- Click **Add APIs** and enable required capabilities
- **Enable RTMS → Transcripts** (requires RTMS approval)

</details>

<details>
<summary><strong>Features → Surface</strong></summary>

| Setting | Value |
|---------|-------|
| Home URL | `https://YOUR-NGROK-URL` |
| Domain Allow List | `https://YOUR-NGROK-URL` |

</details>

<details>
<summary><strong>Features → Event Subscriptions</strong></summary>

| Setting | Value |
|---------|-------|
| Event notification endpoint | `https://YOUR-NGROK-URL/api/rtms/webhook` |
| Events to subscribe | `meeting.rtms_started`, `meeting.rtms_stopped` |

</details>

> Replace `YOUR-NGROK-URL` with your actual ngrok URL (e.g., `your-name.ngrok-free.app`)

---

### 5. Start the Application

```bash
docker-compose up --build
```

Wait for all services to start:
- PostgreSQL database
- Backend API (port 3000)
- Frontend (port 3001)
- RTMS service (port 3002)

---

### 6. Test in Zoom

1. Start or join a Zoom meeting
2. Click **Apps** in the toolbar
3. Find and open your app
4. Click **"Start Arlo"** to begin transcription
5. Watch live transcripts appear in the **Transcript** tab
6. Switch to **Arlo Assist** to try AI features:
   - Generate meeting summaries
   - Extract action items
   - Ask questions about your meeting

---

## Industry Verticals

Arlo includes specialized modes demonstrating RTMS capabilities for different industries. Each vertical shows how real-time transcription can power domain-specific features.

<table>
<tr>
<td align="center" width="50%">

### General
**Full-Featured Note-Taking**

Meeting summaries, key decisions, action items, participant stats, and talk time analytics.

<!-- Demo: docs/assets/demos/general-demo.mp4 -->
*Demo video coming soon*

</td>
<td align="center" width="50%">

### Healthcare
**Clinical Documentation**

SOAP notes auto-generation, clinical alerts for drug interactions, patient context sidebar.

<!-- Demo: docs/assets/demos/healthcare-demo.mp4 -->
*Demo video coming soon*

</td>
</tr>
<tr>
<td align="center" width="50%">

### Legal
**Deposition Assistance**

Contradiction detection, billable time tracking, exhibit markers, privilege flags.

<!-- Demo: docs/assets/demos/legal-demo.mp4 -->
*Demo video coming soon*

</td>
<td align="center" width="50%">

### Sales
**Deal Intelligence**

BANT qualification tracking, competitor mention detection, commitment tracking.

<!-- Demo: docs/assets/demos/sales-demo.mp4 -->
*Demo video coming soon*

</td>
</tr>
<tr>
<td align="center" colspan="2">

### Customer Support
**Agent Assistance**

Live sentiment meter, escalation alerts, resolution workflow tracking.

<!-- Demo: docs/assets/demos/support-demo.mp4 -->
*Demo video coming soon*

</td>
</tr>
</table>

> **Building your own vertical?** Fork this repo and customize the frontend components in `frontend/src/features/` for your specific use case.

---

## Troubleshooting

<details>
<summary><strong>Database / Prisma Errors</strong></summary>

**"Cannot find module '.prisma/client'"**
```bash
docker-compose exec backend npx prisma generate
docker-compose restart backend
```

**"Can't reach database server"**
```bash
docker-compose restart postgres backend
```

**Tables don't exist**
```bash
docker-compose exec backend npx prisma db push
```

</details>

<details>
<summary><strong>Clean Restart</strong></summary>

If you're having persistent issues:

```bash
# Stop everything and remove volumes
docker-compose down -v

# Rebuild with fresh node_modules
docker-compose up --build -V
```

</details>

<details>
<summary><strong>ngrok Issues</strong></summary>

**App stops working after restarting ngrok?**

If using a random domain:
1. Copy the new ngrok URL
2. Update `PUBLIC_URL` in `.env`
3. Update all URLs in Zoom Marketplace settings
4. Restart: `docker-compose restart backend`

> **Pro tip:** Use a [static ngrok domain](https://dashboard.ngrok.com/domains) (free) to avoid this!

</details>

<details>
<summary><strong>More Help</strong></summary>

See the full [Troubleshooting Guide](./docs/TROUBLESHOOTING.md) for additional issues.

</details>

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](./docs/ARCHITECTURE.md) | System design and data flow |
| [Project Status](./docs/PROJECT_STATUS.md) | Roadmap and current progress |
| [Specification](./SPEC.md) | Feature spec and milestones |
| [Troubleshooting](./docs/TROUBLESHOOTING.md) | Common issues and fixes |
| [CLAUDE.md](./CLAUDE.md) | Quick reference for AI assistants |

---

## Development

### Project Structure

```
arlo/
├── backend/           # Express API server + Prisma ORM
├── frontend/          # React Zoom App (CRA)
├── rtms/              # RTMS transcript ingestion service
├── docs/              # Documentation
└── docker-compose.yml # Development environment
```

### Common Commands

```bash
docker-compose up                    # Start all services
docker-compose logs -f backend       # View backend logs
docker-compose restart backend       # Restart a service
docker-compose down -v               # Stop and remove volumes
npm run db:studio                    # Open Prisma database GUI
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Zoom Apps SDK, Base UI |
| Backend | Node.js 20, Express, Prisma |
| Database | PostgreSQL 15 |
| AI | OpenRouter (free models available) |
| Real-time | WebSocket + RTMS SDK |

---

## Contributing

This is an open-source starter kit designed to be forked and customized!

1. **Fork** this repository
2. **Customize** for your use case
3. **Share** improvements via pull request

### Ideas for Extension

- Multi-language transcription support
- Custom AI models (local LLMs)
- Team workspaces and sharing
- Calendar integration
- Video replay with transcript sync

---

## Zoom for Government

This application supports Zoom for Government (ZfG) deployments:

```bash
# In your .env file
ZOOM_HOST=zoomgov.com
```

1. Create your app in the [Zoom for Government Marketplace](https://marketplace.zoomgov.com/)
2. Use ZfG-specific URLs in your configuration

> **Note:** RTMS availability on ZfG may differ. Contact your Zoom representative for ZfG-specific access.

---

## Production Deployment

This reference implementation is designed for **learning and prototyping**. Before production deployment:

| Area | Development | Production Recommendation |
|------|-------------|---------------------------|
| **Credentials** | `.env` file | Secrets manager (AWS, Vault, Azure) |
| **Tokens** | PostgreSQL + AES | Add encryption at rest |
| **Sessions** | In-memory | Redis or database-backed |
| **HTTPS** | ngrok tunnel | Load balancer with TLS |
| **WebSockets** | Single instance | Redis pub/sub for scaling |

See [Known Limitations](#known-limitations) for additional considerations.

---

## Known Limitations

This is a reference implementation with intentional simplifications:

| Pattern | Current | Production Recommendation |
|---------|---------|---------------------------|
| PKCE Storage | In-memory Map | Redis with TTL |
| WebSocket Scaling | Single-instance | Redis pub/sub adapter |
| Retry Logic | Basic 401 retry | Exponential backoff |
| Webhook Processing | Synchronous | Queue-based async |
| Input Validation | Basic checks | Schema validation (Zod) |

---

## Resources

- [Zoom Apps Documentation](https://developers.zoom.us/docs/zoom-apps/)
- [RTMS Documentation](https://developers.zoom.us/docs/rtms/)
- [Zoom Apps SDK Reference](https://appssdk.zoom.us/classes/ZoomSdk.ZoomSdk.html)
- [OpenRouter API](https://openrouter.ai/docs)

---

## Support

- **Issues:** [GitHub Issues](https://github.com/zoom/arlo/issues)
- **Discussions:** [GitHub Discussions](https://github.com/zoom/arlo/discussions)
- **RTMS Access:** [Request Form](https://www.zoom.com/en/realtime-media-streams/#form)
- **Zoom Developer Forum:** [devforum.zoom.us](https://devforum.zoom.us/)

---

## License

MIT License — See [LICENSE](./LICENSE) for details.

---

<div align="center">

**Ready to build your own meeting assistant?**

[Get Started](#-quick-start) · [Star this repo](https://github.com/zoom/arlo)

</div>
