<div align="center">

<img src="./docs/assets/arlo-logo.png" alt="Arlo" width="200"/>

# Arlo Meeting Assistant

**Build Real-Time Meeting Intelligence with Zoom RTMS**

[Get Started](#-quick-start) · [Features](#-features) · [Documentation](#-documentation) · [Troubleshooting](#-troubleshooting)

</div>

---

## What is Arlo?

Arlo is an **open-source reference implementation** that demonstrates the power of Zoom's RTMS (Real-Time Media Streams) APIs. It shows developers how to build meeting assistants that capture **live transcripts without requiring a bot in the meeting**.

### Use This Project To:

- **Learn** how RTMS webhooks, WebSockets, and transcript streaming work
- **Fork and customize** for your specific use case (healthcare, legal, sales, etc.)
- **Prototype** your own meeting intelligence applications
- **Understand** authentication, data flow, and Zoom Apps best practices

> **Note:** This is a starting point, not a finished product. The industry verticals (Legal, Healthcare, etc.) are illustrative examples showing what's possible with RTMS.

---

## Features

| Feature | Description |
|---------|-------------|
| **Live Transcription** | Real-time captions via RTMS (< 1 second latency) |
| **AI Insights** | Summaries, action items, and next steps |
| **Full-Text Search** | Search across all your meeting transcripts |
| **Chat with Transcripts** | Ask questions about your meetings |
| **Meeting Highlights** | Create bookmarks with timestamps |
| **Export Options** | Download WebVTT files or Markdown summaries |
| **Dark Mode** | Automatic OS detection with manual toggle |
| **Industry Verticals** | Specialized modes for Healthcare, Legal, Sales, and Support |

---

## Prerequisites

Before you begin, make sure you have:

| Requirement | Description |
|-------------|-------------|
| **Node.js 20+** | [Download here](https://nodejs.org/) |
| **Docker Desktop** | [Download here](https://www.docker.com/products/docker-desktop/) |
| **ngrok** | [Sign up free](https://ngrok.com/) - creates tunnels for webhooks |
| **Zoom Account** | With access to [Zoom Marketplace](https://marketplace.zoom.us/) |
| **RTMS Access** | **Required!** [Request access here](https://www.zoom.com/en/realtime-media-streams/#form) |

> **⚠️ Important:** RTMS access requires approval from Zoom. Without it, this app will not function.
>
> **[Request RTMS Access Here](https://www.zoom.com/en/realtime-media-streams/#form)** — Apply early as approval may take a few days.

---

## Quick Start

### Step 1: Clone the Repository

```bash
git clone https://github.com/zoom/arlo.git
cd arlo
```

### Step 2: Set Up ngrok

ngrok creates a secure tunnel from the internet to your local server (required for Zoom webhooks).

**Option A: Static Domain (Recommended)**

1. Create a free account at [ngrok.com](https://ngrok.com/)
2. Go to [ngrok dashboard](https://dashboard.ngrok.com/domains) → **Create Domain**
3. You'll get a permanent URL like: `yourname-arlo.ngrok-free.app`
4. Start ngrok:
   ```bash
   ngrok http 3000 --domain=yourname-arlo.ngrok-free.app
   ```

**Option B: Random Domain**

```bash
ngrok http 3000
# Copy the https:// URL (changes each restart)
```

> **Tip:** Static domains are free and save you from updating Zoom settings every time you restart ngrok.

### Step 3: Create Your Zoom App

1. Go to [Zoom Marketplace](https://marketplace.zoom.us/) → **Develop** → **Build App**
2. Select **General App** and name it (e.g., "Arlo Meeting Assistant")
3. Note your **Client ID** and **Client Secret**

### Step 4: Configure Environment Variables

```bash
# Copy the example file
cp .env.example .env
```

Edit `.env` and fill in these values:

```bash
# Your Zoom app credentials (from Step 3)
ZOOM_CLIENT_ID=your_client_id_here
ZOOM_CLIENT_SECRET=your_client_secret_here

# Your ngrok URL (from Step 2)
PUBLIC_URL=https://yourname-arlo.ngrok-free.app

# Generate these secrets (run each command and paste the output)
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=paste_64_character_string_here

# node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
REDIS_ENCRYPTION_KEY=paste_32_character_string_here
```

### Step 5: Configure Your Zoom App

In [Zoom Marketplace](https://marketplace.zoom.us/) → Your App, configure these settings:

**Basic Information:**
| Setting | Value |
|---------|-------|
| OAuth Redirect URL | `https://YOUR-NGROK-URL/api/auth/callback` |
| OAuth Allow List | `https://YOUR-NGROK-URL` |

**Features → Zoom App SDK:**
- Click **Add APIs** and enable all required capabilities
- **Enable RTMS → Transcripts** (requires RTMS approval)

**Features → Surface:**
| Setting | Value |
|---------|-------|
| Home URL | `https://YOUR-NGROK-URL` |
| Domain Allow List | Add `https://YOUR-NGROK-URL` |

**Features → Event Subscriptions:**
| Setting | Value |
|---------|-------|
| Event notification endpoint | `https://YOUR-NGROK-URL/api/rtms/webhook` |
| Events | `meeting.rtms_started`, `meeting.rtms_stopped` |

> Replace `YOUR-NGROK-URL` with your actual ngrok domain (e.g., `yourname-arlo.ngrok-free.app`)

### Step 6: Start the Application

```bash
# Start all services with Docker
docker-compose up --build
```

Wait for the services to start. You should see:
- PostgreSQL database starting
- Backend API starting on port 3000
- Frontend starting on port 3001
- RTMS service starting on port 3002

### Step 7: Test in Zoom

1. Start or join a Zoom meeting
2. Click **Apps** in the Zoom toolbar
3. Find and open your app
4. Click **"Start Arlo"** to begin transcription
5. See live transcripts appear!

---

## Troubleshooting

### Database / Prisma Errors

**"Cannot find module '.prisma/client'"**

```bash
# Regenerate Prisma client inside Docker
docker-compose exec backend npx prisma generate
docker-compose restart backend
```

**"Can't reach database server"**

```bash
# Wait for PostgreSQL to be healthy, then restart
docker-compose restart postgres backend
```

**Tables don't exist**

```bash
# Push the schema to database
docker-compose exec backend npx prisma db push
```

### Clean Restart

If you're having persistent issues:

```bash
# Stop everything and remove volumes
docker-compose down -v

# Rebuild with fresh node_modules
docker-compose up --build -V
```

### ngrok Issues

**App stops working after restarting ngrok?**

If using a random domain, you'll need to:
1. Copy the new ngrok URL
2. Update `PUBLIC_URL` in `.env`
3. Update all URLs in Zoom Marketplace settings
4. Restart: `docker-compose restart backend`

> **Pro tip:** Use a static ngrok domain to avoid this!

### More Help

See the full [Troubleshooting Guide](./docs/TROUBLESHOOTING.md) for additional issues.

---

## Industry Verticals

Arlo includes specialized modes that demonstrate RTMS capabilities for different industries:

### General (Default)
Full-featured note-taking for any meeting type.
- Meeting summaries, key moments, decisions
- Participant stats and talk time
- Action items and open questions

### Healthcare
Clinical documentation for patient encounters.
- SOAP notes auto-generation
- Clinical alerts for drug interactions
- Patient context sidebar

### Legal
Deposition and testimony assistance.
- Contradiction detection
- Billable time tracking
- Exhibit and privilege markers

### Sales
Deal tracking and qualification.
- BANT qualification tracking
- Competitor mention detection
- Commitment tracking

### Customer Support
Call center agent assistance.
- Live sentiment meter
- Escalation alerts
- Resolution workflow tracking

---

## Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](./CLAUDE.md) | Quick reference for AI assistants |
| [Architecture](./docs/ARCHITECTURE.md) | System design and data flow |
| [Project Status](./docs/PROJECT_STATUS.md) | Roadmap and current progress |
| [Specification](./SPEC.md) | Feature spec and milestones |
| [Troubleshooting](./docs/TROUBLESHOOTING.md) | Common issues and fixes |

---

## Development

### Project Structure

```
arlo/
├── backend/           # Express API server + Prisma
├── frontend/          # React Zoom App
├── rtms/              # RTMS transcript ingestion service
├── docs/              # Documentation
└── docker-compose.yml # Development environment
```

### Common Commands

```bash
# Start all services
docker-compose up

# View logs
docker-compose logs -f backend

# Restart a service
docker-compose restart backend

# Database GUI
npm run db:studio

# Clean restart (deletes data!)
docker-compose down -v && docker-compose up --build
```

### Tech Stack

- **Frontend:** React 18, Zoom Apps SDK, Base UI
- **Backend:** Node.js 20, Express, Prisma
- **Database:** PostgreSQL 15
- **AI:** OpenRouter (free models available)
- **Real-time:** WebSocket + RTMS SDK

---

## Contributing

This is an open-source starter kit designed to be forked and customized!

1. **Fork** this repository
2. **Customize** for your use case
3. **Share** improvements via pull request (optional)

### Ideas for Extension

- Multi-language support
- Custom AI models (local LLMs)
- Team workspaces
- Calendar integration
- Video replay sync

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

MIT License - See [LICENSE](./LICENSE) for details.

---

<div align="center">

**Ready to build your own meeting assistant?**

[Get Started](#-quick-start) · [Star this repo](https://github.com/zoom/arlo) ⭐

</div>
