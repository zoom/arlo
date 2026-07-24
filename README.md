<div align="center">

<img src="./docs/assets/arlo-logo.png" alt="Arlo" width="200"/>

# Arlo Meeting Assistant

**Build Real-Time Meeting Intelligence with Zoom RTMS**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Zoom RTMS](https://img.shields.io/badge/Zoom-RTMS-2D8CFF.svg)](https://www.zoom.com/en/realtime-media-streams/)

[Get Started](#-quick-start) · [See Demos](#-see-it-in-action) · [Features](#-features) · [Deploy](#deployment-options) · [Troubleshooting](#-troubleshooting)

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

- Near-real-time transcription via RTMS
- AI-powered summaries and action items
- Transcript search across meetings
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
  Replace this placeholder with a thumbnail link to the published demo video.
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
| **Live Transcription** | Near-real-time captions via RTMS |
| **AI Insights** | Summaries, action items, and next steps powered by OpenRouter |
| **Transcript Search** | Search across saved meeting transcripts |
| **Chat with Transcripts** | Ask questions about your meetings using AI |
| **Meeting Highlights** | Create bookmarks with timestamps for key moments |
| **Export Options** | Download WebVTT files or Markdown summaries |
| **Dark Mode** | Automatic OS detection with manual toggle |
| **Industry Verticals** | Specialized modes: Arlo for Notes, Healthcare, Legal, Sales, and Support |

> **AI features use OpenRouter.** The application allowlist currently contains `openai/gpt-oss-120b:free`, `google/gemma-4-31b-it:free`, and `nvidia/nemotron-3-ultra-550b-a55b:free`. An `OPENROUTER_API_KEY` is optional for development, but free-provider rate limits can still cause failures without one.

---

## Prerequisites

Before you begin, ensure you have:

| Requirement | Why You Need It |
|-------------|-----------------|
| **[Node.js 20+](https://nodejs.org/)** | Runtime for backend services |
| **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** | Runs MySQL and all services |
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
- `zoomapp:inmeeting` — Run inside a Zoom meeting
- `meeting:read:meeting` — Read meeting details
- `meeting:read:list_meetings` — List upcoming meetings
- `meeting:read:meeting_transcript` — Meeting transcript access used by the RTMS workflow
- `meeting:write:open_app` — Optional; register the app for upcoming-meeting auto-open
- `user:read` — Optional; read the Zoom user profile

</details>

<details>
<summary><strong>Features → Zoom App SDK</strong></summary>

- Click **Add APIs** and enable the capabilities listed in
  [`ZoomSdkContext.js`](./frontend/src/contexts/ZoomSdkContext.js), including
  `getMeetingUUID`, `getMeetingContext`, `getUserContext`, `getRTMSStatus`,
  `onRTMSStatusChange`, `startRTMS`, `stopRTMS`, and the notification/chat APIs.
- Enable **In-Client OAuth** and **Guest Mode** if those surfaces are used.
- **Enable RTMS → Transcripts** (requires RTMS approval)

</details>

<details>
<summary><strong>Features → Surface</strong></summary>

| Setting | Value |
|---------|-------|
| Home URL | `https://YOUR-NGROK-URL` |
| Domain Allow List | `YOUR-NGROK-HOST` and `appssdk.zoom.us` |

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
docker compose up --build
```

Wait for all services to start:
- MySQL 8.0 database
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

## Deployment Options

Arlo includes first-cut deployment templates in [`deploy/`](./deploy/) for AWS and self-hosted environments. The recommended scalable path today is the AWS Terraform stack because it separates the Zoom App web/API tier from per-stream RTMS workers.

| Target | Path | Format | Intended Use |
|--------|------|--------|--------------|
| **AWS** | [`deploy/aws/terraform`](./deploy/aws/terraform) | Terraform | Scalable ECS/Fargate deployment with per-RTMS-stream workers |
| **AWS quick start** | [`deploy/aws/cloudformation.yml`](./deploy/aws/cloudformation.yml) | CloudFormation YAML | Simpler AWS bootstrap, less complete than Terraform |
| **Self-hosted VM** | [`deploy/selfhost`](./deploy/selfhost) | Docker Compose + nginx | Ubuntu/Debian VM or Proxmox-style deployment |

### Recommended AWS Terraform Architecture

The AWS Terraform stack provisions:

- CloudFront and an Application Load Balancer for HTTPS/FQDN access to the Zoom App, backend API, webhooks, and browser WebSocket endpoint. The current Terraform stack uses the native CloudFront hostname; its Route 53 option points directly at the ALB and is not a CloudFront custom-domain configuration.
- ECS/Fargate services for the frontend, backend, and RTMS control plane.
- One ECS/Fargate RTMS worker task per active RTMS stream. The worker connects to Zoom RTMS signaling/media and publishes realtime events to Valkey.
- Amazon RDS MySQL for persisted meetings/transcripts, ElastiCache Serverless Valkey for realtime fanout/replay, DynamoDB for RTMS control state, and KMS/SSM Parameter Store for secrets. Container images are built and pushed to ECR separately; Terraform consumes their image URIs.
- Private RTMS worker subnets by default, with NAT egress for Zoom/OpenRouter access and no public worker IPs.

Realtime transcript and participant identity fields stored in Valkey are app-encrypted with AES-256-GCM. The RTMS worker calls KMS `GenerateDataKey` once per stream, caches the plaintext data key in memory, and stores only encrypted sensitive payload fields in Valkey. Routing metadata such as meeting UUID/session/stream IDs remains plaintext so the backend can perform lookup and fanout. MySQL persistence is not app-layer encrypted by this starter stack.

CloudWatch application logs are disabled by default in the Terraform variables to keep idle operating cost low. Enable explicit logging only if you have a retention/cost policy.

```mermaid
flowchart LR
  zoomClient["Zoom Client\nZoom App WebView"] --> cloudfront["CloudFront\nHTTPS FQDN"]
  zoomWebhook["Zoom RTMS Webhooks"] --> cloudfront
  cloudfront --> alb["Application Load Balancer"]

  alb --> frontend["Frontend\nECS/Fargate Service"]
  alb --> backend["Backend API + WebSocket\nECS/Fargate Service"]
  alb --> rtmsControl["RTMS Control Plane\nECS/Fargate Service"]

  rtmsControl --> dynamodb["DynamoDB\nRTMS control state"]
  rtmsControl --> ecsRunTask["ECS RunTask\nlaunch per-stream worker"]
  ecsRunTask --> rtmsWorker["RTMS Worker\nECS/Fargate Task"]

  rtmsWorker --> zoomRtms["Zoom RTMS\nSignaling + Media"]
  rtmsWorker --> valkey["ElastiCache Serverless Valkey\nrealtime encrypted events"]
  backend --> valkey
  backend --> rds["RDS MySQL 8.0\npersisted meetings/transcripts"]

  backend --> browserWs["Browser WebSocket fanout\nsingle-user delivery"]
  browserWs --> zoomClient

  kms["KMS"] --> rtmsWorker
  kms --> backend
  ssm["SSM Parameter Store\nruntime secrets"] --> backend
  ssm --> rtmsControl
  ssm --> rtmsWorker
  ecr["ECR Images"] --> frontend
  ecr --> backend
  ecr --> rtmsControl
  ecr --> rtmsWorker
```

### AWS Deployment Flow

The complete guide, including ECR image publishing, mock-environment isolation,
secret bootstrap, and the current custom-domain limitation, is in
[`deploy/aws/terraform/README.md`](./deploy/aws/terraform/README.md).

```bash
cd deploy/aws/terraform
cp terraform.tfvars.example terraform.tfvars

# Edit terraform.tfvars with the ECR image URIs and non-secret settings.
# Build and push the four images before applying Terraform.
terraform init
terraform apply -target=aws_kms_key.secrets -target=aws_kms_alias.secrets

# Export the required secret values in this shell. Do not commit them.
export AWS_REGION=us-east-1
export SSM_PREFIX=/arlo/prod
export KMS_KEY_ID=alias/arlo-prod
export ZOOM_CLIENT_ID='...'
export ZOOM_CLIENT_SECRET='...'
export ZOOM_WEBHOOK_SECRET_TOKEN='...'
export SESSION_SECRET="$(openssl rand -hex 32)"
export REDIS_ENCRYPTION_KEY="$(openssl rand -hex 16)"
export INTERNAL_WEBHOOK_SECRET="$(openssl rand -hex 32)"

# If create_database=true, let Terraform create RDS and its database-url parameter:
SKIP_DATABASE_URL=true ./put-secrets.sh
# If create_database=false, use the existing remote MySQL URL instead:
# export DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/arlo?connection_limit=5'
# ./put-secrets.sh

terraform fmt -check
terraform validate
terraform plan -out=arlo.tfplan
terraform apply arlo.tfplan

terraform output -raw cloudfront_domain_name
terraform output -raw zoom_rtms_webhook_url
```

For a mock deployment, use a separate Terraform state/backend key and set a
unique environment, VPC CIDR, SSM prefix, and KMS alias. Do not reuse the
production state. With `create_database = true`, the mock stack creates an
isolated encrypted RDS MySQL instance; with `create_database = false`, provide
the remote database URL at `/arlo/mock/database-url` and ensure VPC connectivity
before starting ECS.

Do not commit `terraform.tfvars`, `secrets.auto.tfvars`, `.terraform/`, or
Terraform state files from a real deployment. Terraform does not create ECR
repositories, build Docker images, or push image tags.

---

## Industry Verticals

Arlo includes specialized modes demonstrating RTMS capabilities for different industries. Each vertical shows how real-time transcription can power domain-specific features.

<table>
<tr>
<td align="center" width="50%">

### Arlo for Notes
**Full-Featured Note-Taking**

Meeting summaries, key decisions, action items, participant stats, and talk time analytics.

<!-- Demo: docs/assets/demos/notes-demo.mp4 -->
*Demo video coming soon*

</td>
<td align="center" width="50%">

### Arlo for Healthcare
**Clinical Documentation**

SOAP notes auto-generation, clinical alerts for drug interactions, patient context sidebar.

<!-- Demo: docs/assets/demos/healthcare-demo.mp4 -->
*Demo video coming soon*

</td>
</tr>
<tr>
<td align="center" width="50%">

### Arlo for Legal
**Deposition Assistance**

Contradiction detection, billable time tracking, exhibit markers, privilege flags.

<!-- Demo: docs/assets/demos/legal-demo.mp4 -->
*Demo video coming soon*

</td>
<td align="center" width="50%">

### Arlo for Sales
**Deal Intelligence**

BANT qualification tracking, competitor mention detection, commitment tracking.

<!-- Demo: docs/assets/demos/sales-demo.mp4 -->
*Demo video coming soon*

</td>
</tr>
<tr>
<td align="center" colspan="2">

### Arlo for Support
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
docker compose exec backend npx prisma generate
docker compose restart backend
```

**"Can't reach database server"**
```bash
docker compose restart mysql backend
```

**Tables don't exist**
```bash
docker compose exec backend npx prisma db push
```

</details>

<details>
<summary><strong>Clean Restart</strong></summary>

If you're having persistent issues:

```bash
# Stop everything and remove volumes
docker compose down -v

# Rebuild with fresh node_modules
docker compose up --build -V
```

</details>

<details>
<summary><strong>ngrok Issues</strong></summary>

**App stops working after restarting ngrok?**

If using a random domain:
1. Copy the new ngrok URL
2. Update `PUBLIC_URL` in `.env`
3. Update all URLs in Zoom Marketplace settings
4. Restart: `docker compose restart backend`

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
| [ROADMAP.md](./ROADMAP.md) | Completed work and future contribution areas |

---

## Development

### Project Structure

```
arlo/
├── backend/           # Express API server + Prisma ORM
├── frontend/          # React Zoom App (CRA)
├── rtms/              # RTMS transcript ingestion service
├── deploy/            # Cloud and self-host deployment templates
├── docs/              # Documentation
└── docker-compose.yml # Development environment
```

### Common Commands

```bash
docker compose up                    # Start all services
docker compose logs -f backend       # View backend logs
docker compose restart backend       # Restart a service
docker compose down -v               # Stop and remove volumes
npm run db:studio                    # Open Prisma database GUI
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Zoom Apps SDK, Base UI |
| Backend | Node.js 20, Express, Prisma |
| Database | MySQL 8.0 |
| AI | OpenRouter (free models available) |
| Real-time | WebSocket + RTMS SDK; Valkey for scalable deployments |
| Cloud Deployment | Terraform, Docker Compose |

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

This reference implementation is designed for **learning and prototyping**. For production-like AWS tests, prefer the Terraform deployment under [`deploy/aws/terraform`](./deploy/aws/terraform) instead of the local Docker Compose flow.

| Area | Development | Production Recommendation |
|------|-------------|---------------------------|
| **Credentials** | `.env` file | KMS-backed SSM Parameter Store, Secrets Manager, Vault, or cloud equivalent |
| **Tokens** | MySQL + AES | Database encryption at rest plus stricter app-layer policy for sensitive fields |
| **Sessions** | Signed cookie + MySQL-backed OAuth tokens; PKCE exchange state is in-memory | Shared PKCE/session state for multi-instance deployments |
| **HTTPS** | ngrok tunnel | CloudFront, load balancer, or reverse proxy with TLS |
| **WebSockets** | Single instance without `REDIS_URL`; Valkey-backed replay/fanout when configured | Shared realtime bus and per-user fanout routing |
| **RTMS workers** | Single local process | Per-stream container workers with cleanup and TTLs |

See [Known Limitations](#known-limitations) for additional considerations.

---

## Known Limitations

This is a reference implementation with intentional simplifications:

| Pattern | Current | Production Recommendation |
|---------|---------|---------------------------|
| PKCE Storage | In-memory Map | Shared store with TTL for multi-instance OAuth flows |
| WebSocket Scaling | Valkey is optional; local mode is single-instance | Shared realtime bus and per-user fanout routing |
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
