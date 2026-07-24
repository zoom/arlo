# Arlo Meeting Assistant Architecture

## Scope

Arlo is a developer reference implementation for a Zoom App that consumes
Zoom Real-Time Media Streams (RTMS) without placing a meeting bot in the
meeting. The current repository contains one React Zoom App, one Node.js API
and WebSocket service, one Node.js RTMS service, and a MySQL persistence model.

The industry verticals are UI demonstrations. Several vertical panels use
demo data or local UI state; they are not production clinical, legal, sales, or
support automation.

## Runtime Components

```text
Zoom Client
  Zoom App WebView (React / CRA)
       | HTTPS API and authenticated WebSocket (/ws)
       v
Backend (Node.js / Express)
  - Zoom OAuth and session cookies
  - REST API and browser WebSocket server
  - RTMS webhook verification and forwarding
  - MySQL persistence
  - Valkey pub/sub and replay when REDIS_URL is configured
  - OpenRouter orchestration when AI_ENABLED=true
       |
       +--> MySQL 8.0 (durable meetings, transcripts, users, tokens, summaries)
       +--> Valkey/Redis (ephemeral realtime sessions and events)
       +--> RTMS service / control plane

RTMS service (Node.js / @zoom/rtms)
  - Verifies forwarded internal webhook requests
  - Local mode: joins RTMS directly
  - AWS control mode: records the event and launches one ECS worker task
  - Worker mode: joins exactly one RTMS stream and exits after it stops
       |
       +--> Zoom RTMS signaling and media servers
       +--> Valkey realtime event stream
       +--> Backend internal persistence/broadcast endpoints
```

## Local Docker Compose

The root `docker-compose.yml`, run with the `docker compose` command, starts
these services:

| Service | Container port | Purpose |
| --- | ---: | --- |
| `mysql` | 3306 | MySQL 8.0 development database |
| `backend` | 3000 | Express API, WebSocket server, frontend proxy |
| `frontend` | 3000 (host 3001) | CRA development server |
| `rtms` | 3002 | RTMS webhook receiver and direct RTMS client |
| `redis` | 6379 | Optional local realtime bus, profile `with-redis` |

The backend proxies non-API browser requests to `FRONTEND_UPSTREAM_URL`. The
frontend uses `REACT_APP_API_URL` and `REACT_APP_WS_URL` for managed or local
deployments. In local Compose, the frontend is normally opened through the
backend/ngrok path while the services communicate over Compose DNS names.

Start the normal local stack with:

```bash
cp .env.example .env
docker compose up --build
```

Include Redis when testing the multi-instance realtime path:

```bash
printf '\nREDIS_URL=redis://redis:6379\n' >> .env
docker compose --profile with-redis up --build
```

The root Compose file points the backend at the `redis` service name; adding
the same URL to `.env` also enables the RTMS container to publish realtime
events to the local Redis instance.

The backend runs `prisma db push` during Compose startup for development. This
is not a production migration strategy.

## AWS Terraform Runtime

The scalable AWS first cut is under [`../deploy/aws/terraform/`](../deploy/aws/terraform/).
It provisions:

- CloudFront as the public HTTPS/FQDN entry point.
- A public ALB as the CloudFront origin.
- Private ECS/Fargate services for `frontend`, `backend`, and `rtms-control`.
- One private ECS/Fargate `rtms-worker` task per active RTMS stream.
- DynamoDB On-Demand as the RTMS launch/control store.
- ElastiCache Serverless Valkey for realtime fanout and replay.
- Optional private RDS MySQL 8.0.
- KMS and SSM Parameter Store `SecureString` parameters for secrets.
- Optional CloudWatch log groups, disabled by default.

Terraform does not create ECR repositories, build images, or push tags. Images
must be built and pushed separately, then their immutable image URIs must be
provided in `terraform.tfvars`. The control and worker services use the same
RTMS image; `RTMS_WORKER_MODE=single-stream` selects worker behavior.

```text
Zoom App / Zoom webhook
          |
          v
CloudFront HTTPS FQDN
          |
          v
Public ALB -- only CloudFront-origin requests are allowed by the listener rule
   |                 |                  |
   v                 v                  v
frontend ECS     backend ECS       rtms-control ECS
                                      |
                                      +--> DynamoDB control state
                                      +--> ECS RunTask
                                             |
                                             v
                                      one rtms-worker ECS task
                                             |
                         +-------------------+-------------------+
                         v                                       v
                  Zoom RTMS signaling/media              Valkey realtime bus
                                                                 |
                                                                 v
                                                        backend WebSocket
```

The ALB and ECS tasks use separate security groups. ECS tasks do not need
public IP addresses. Private tasks use NAT or VPC endpoints for required
outbound services such as Zoom, ECR, SSM, KMS, and OpenRouter. The public ALB
DNS name is an origin/testing address, not the recommended Zoom App URL.

## RTMS Lifecycle

### Start

1. The Zoom App obtains the current meeting UUID with `getMeetingUUID()` and
   reads the RTMS session/stream identifier from `getRTMSStatus()`.
2. The browser opens an authenticated WebSocket using the meeting UUID and
   RTMS session ID. The current URL shape is:

   ```text
   wss://HOST/ws?meeting_uuid=<meeting UUID>&session_id=<RTMS session/stream ID>&meetingid=<numeric meeting ID>&token=<signed session token>
   ```

   `meetingid` is optional and is the numeric Zoom meeting number. It is not
   used in place of `meeting_uuid` for realtime routing.
3. The app calls `zoomSdk.callZoomApi('startRTMS', ...)` with transcript
   captions enabled. The app also listens for `onRTMSStatusChange`.
4. Zoom sends `meeting.rtms_started` to `/api/rtms/webhook`. The backend
   verifies the Zoom HMAC signature and forwards the event to the RTMS service
   using the internal HMAC secret.
5. In AWS control mode, `rtms-control` stores the meeting UUID and RTMS stream
   ID in DynamoDB, records the realtime session, and calls ECS `RunTask` with
   `RTMS_WORKER_MEETING_ID` and `RTMS_WORKER_STREAM_ID`.
6. The worker joins RTMS using the `server_urls`, RTMS client ID, and RTMS
   client secret from the webhook/runtime configuration. It subscribes to the
   transcript and participant callbacks implemented in `rtms/src/index.js`.

### Realtime delivery

For each transcript segment or participant event, the RTMS process:

1. Normalizes the RTMS callback into an Arlo event.
2. Publishes the event to Valkey when `REDIS_URL` is available.
3. Calls the backend internal endpoint so the backend can persist the event to
   MySQL. When Valkey is unavailable, the backend uses its local WebSocket
   fanout as a fallback.
4. The backend Valkey subscriber replays and delivers the event only to
   matching authenticated connections. Meeting-wide broadcast is disabled.

The matching identity is the meeting plus RTMS stream/session association and,
where available, the authenticated application or Zoom user identity. Query
parameters supplied by the browser are not trusted as user identity; the
signed WebSocket token is authoritative in production.

The browser sends a JSON `subscribe` message after opening the socket:

```json
{
  "type": "subscribe",
  "payload": {
    "meetingUUID": "<meeting UUID>",
    "sessionId": "<RTMS session/stream ID>",
    "rtmsStreamId": "<RTMS session/stream ID>",
    "meetingID": "<numeric meeting ID or null>"
  }
}
```

The server sends `connected`, `subscribed`, `transcript.segment`,
`participant.event`, `meeting.status`, and `meeting.presence` messages. The
browser sends an application-level `ping` every 25 seconds; the server sends
WebSocket protocol pings every 30 seconds. The browser reconnects with
exponential backoff when the socket closes or becomes stale.

### Stop and cleanup

1. Zoom sends `meeting.rtms_stopped` or the RTMS SDK reports a leave.
2. The control plane stops the recorded ECS worker task, if one exists.
3. The worker leaves RTMS and exits. Its container logs are not durable unless
   an explicit log driver is configured.
4. The backend marks the meeting lifecycle and removes the matching Valkey
   session, event list, and aliases. The RTMS process also attempts cleanup as
   a safety net.
5. DynamoDB control records are deleted on the normal stop path and have TTL as
   a stale-record safety net. Active realtime data defaults to a 24-hour TTL;
   completed data defaults to one hour. These values are configurable through
   `REALTIME_ACTIVE_TTL_SECONDS` and `REALTIME_COMPLETED_TTL_SECONDS`.
6. MySQL meeting and transcript records are durable and are not automatically
   deleted when RTMS stops. Delete them through the authenticated meeting
   delete route or an explicit retention job.

## Data Stores and Encryption

### MySQL

MySQL 8.0 is the Prisma datasource. It stores users, encrypted OAuth tokens,
meeting metadata, speakers, transcript segments, participant events, cached
summaries, highlights, AI chat records, and citations. Application queries
filter user-owned data by `ownerId`; the starter schema does not configure
database-native row-level security.

WebVTT export is generated from MySQL transcript rows and streamed by the API.
The current implementation does not write transcript files to S3 or Blob
Storage. `VttFile` and the storage-related environment variables are extension
points, not an active object-storage pipeline.

OAuth access and refresh tokens are encrypted in the application with the
current AES-128-CBC implementation using the 32-character hex
`REDIS_ENCRYPTION_KEY`. This is separate from the realtime payload encryption.

### Valkey / Redis

When configured, Valkey stores short-lived realtime session metadata, aliases,
and a bounded event replay list. Routing identifiers remain available as
metadata so the backend can resolve the correct session. Sensitive transcript
speaker/text fields and participant names are encrypted with AES-256-GCM when
`REALTIME_KMS_KEY_ID` is configured. The RTMS process calls KMS
`GenerateDataKey` once per stream and caches the plaintext data key in memory;
Valkey stores the encrypted data key and ciphertext, not the plaintext key.

Local Compose can run Redis 7 through the `with-redis` profile. AWS Terraform
uses ElastiCache Serverless Valkey. If `REDIS_URL` is empty, realtime delivery
falls back to in-process WebSocket fanout and does not scale across backend
instances.

### DynamoDB control store

The AWS RTMS control store uses a `MEETING#<meeting UUID>` partition and
`STREAM#<RTMS stream ID>` or `ACTIVE` sort keys. It tracks webhook payloads,
worker task ARNs, launch status, operator metadata, and expiry. This store is
for worker coordination; it is not the durable transcript database.

### KMS and SSM

AWS KMS encrypts the DynamoDB table, RDS storage, and SSM `SecureString`
parameters. ECS task execution roles read the required SSM parameters. KMS
does not make a secret public: access is controlled by IAM, task roles, key
policy, and the encryption context used for realtime data keys.

## Authentication and Data Isolation

- Zoom webhook requests use `x-zm-signature` and
  `x-zm-request-timestamp`, with a five-minute replay window.
- Backend-to-RTMS requests use `INTERNAL_WEBHOOK_SECRET` and an internal HMAC
  header. Production rejects unsigned internal requests.
- OAuth sessions use a signed, httpOnly `sessionToken` cookie. The same signed
  token is returned as `wsToken` for the browser WebSocket.
- Production WebSockets require a valid signed token. The token's user ID and
  Zoom user ID are checked against any supplied hints.
- Meeting REST reads and authenticated AI routes filter records by the logged-in
  user's owner ID. Public links are disabled by default.
- `devAuthBypass` and anonymous WebSocket access are development-only behavior;
  do not enable them in production.
- Helmet supplies CSP, HSTS, X-Content-Type-Options, Referrer-Policy, and
  related headers. CloudFront/ALB deployments should still use an HTTPS public
  URL and an ACM certificate for custom production domains.

## API Surface

The main mounted routes are:

| Method | Path | Access / purpose |
| --- | --- | --- |
| GET | `/api/auth/authorize` | PKCE challenge for in-client OAuth |
| GET | `/api/auth/start` | Browser OAuth redirect start |
| GET/POST | `/api/auth/callback` | OAuth callback variants |
| GET | `/api/auth/me` | Current authenticated user |
| POST | `/api/auth/logout` | End session |
| GET | `/api/meetings` | Authenticated user's meetings |
| GET/PATCH | `/api/meetings/by-zoom-id/:zoomMeetingId` and `/topic` | Meeting lookup/title sync |
| GET | `/api/meetings/:id/transcript` | Authenticated transcript retrieval |
| GET | `/api/meetings/:id/vtt` | Authenticated WebVTT export |
| GET | `/api/meetings/:id/export/markdown` | Authenticated Markdown export |
| PATCH/DELETE | `/api/meetings/:id` | Rename or delete a meeting |
| GET | `/api/search` | Authenticated title/summary/transcript search using MySQL-compatible queries |
| GET/POST/PATCH/DELETE | `/api/highlights` | User highlight CRUD |
| POST | `/api/ai/summary` | Cached meeting summary |
| POST | `/api/ai/summary-live` | Summary from live transcript text |
| POST | `/api/ai/key-moment` | Key moment analysis with model fallback |
| POST | `/api/ai/chat` | Meeting or recent-meetings Q&A |
| POST | `/api/ai/action-items` | Action-item extraction |
| POST | `/api/ai/extract-soap` | Healthcare SOAP extraction |
| POST | `/api/ai/sentiment` | Support sentiment analysis |
| POST | `/api/rtms/webhook` | Zoom-signed RTMS webhook receiver |

Most AI endpoints require `AI_ENABLED=true`. The configured model allowlist is
free-only: `openai/gpt-oss-120b:free`, `google/gemma-4-31b-it:free`, and
`nvidia/nemotron-3-ultra-550b-a55b:free`. The service tries the selected model
and configured fallback models. Summary generation falls back to an extractive
summary if all model calls fail; key-moment extraction returns an error after
all configured models fail.

The browser key-moment component analyzes its recent transcript window every
30 seconds after its initial delay. Meeting summary auto-generation is based on
new segment count, currently after at least 20 new segments, not a fixed
30-minute timer. Many vertical cards remain demo/manual UI unless their
component explicitly calls an AI endpoint.

## Frontend and Verticals

The frontend is Create React App with `HashRouter`, the Zoom Apps SDK, native
WebSocket, and plain CSS. The SDK configuration currently includes meeting and
user context, authorization, RTMS start/stop/pause/resume/status APIs, running
context listeners, chat notices, and app invitations.

Available verticals are Notes, Healthcare, Legal, Sales, and Support. The
`showDemoData` setting controls demo cards. With demo data disabled, many
vertical panels start empty or only support manual actions; the vertical
components are not all wired to automatic extraction.

## Deployment References

- Local setup: [`../README.md`](../README.md)
- AWS scalable deployment: [`../deploy/aws/terraform/README.md`](../deploy/aws/terraform/README.md)
- Self-hosted deployment: [`../deploy/selfhost/README.md`](../deploy/selfhost/README.md)
- Fresh install verification: [`FRESH_INSTALL_CHECKLIST.md`](./FRESH_INSTALL_CHECKLIST.md)
- Troubleshooting: [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
