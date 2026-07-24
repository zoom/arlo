# Troubleshooting Guide

This guide covers the local Docker Compose path. For AWS, use the same
application checks plus ECS task/service events, ALB target health, CloudFront
behavior configuration, DynamoDB control records, and Valkey connectivity.

## Quick Checks

```bash
docker compose ps
curl http://localhost:3000/health
docker compose logs --tail=100 backend
docker compose logs --tail=100 rtms
```

Restart without deleting data:

```bash
docker compose down
docker compose up --build
```

Full reset, which deletes the local MySQL and Redis volumes:

```bash
docker compose down -v
docker compose up --build
```

## App Does Not Load

1. Confirm `backend` is healthy at `http://localhost:3000/health`.
2. Confirm `frontend` is running on host port 3001 and that the backend can
   reach it through `FRONTEND_UPSTREAM_URL=http://frontend:3000`.
3. If using Zoom, run `ngrok http 3000`; ngrok must point to the backend, not
   directly to the frontend or RTMS port.
4. Set `PUBLIC_URL` to the exact HTTPS ngrok/custom URL and restart the backend.
5. Configure the Zoom Home URL as the base URL and configure the event endpoint
   as `/api/rtms/webhook`.
6. Inspect the Zoom WebView console and backend logs for the first failed
   request. A frontend 503 usually means the backend proxy cannot reach the
   frontend container.

For CORS or 403 errors:

- Put the exact public origin in `CORS_ORIGINS`.
- Put the hostname without a scheme in the Zoom Domain Allow List.
- Put the full HTTPS origin in the OAuth Allow List.
- Restart the backend after changing `.env`.

## OAuth and Authentication

### OAuth callback or `invalid_grant`

- The redirect URL must exactly match the Marketplace value:
  `https://HOST/api/auth/callback`.
- Confirm `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` belong to the same app.
- Do not exchange a code twice; restart the app flow after a failed exchange.
- Clear the Zoom App/WebView session and reauthorize if the PKCE state is stale.
- Check backend logs without printing tokens:

  ```bash
  docker compose logs backend | grep -iE 'oauth|auth|pkce'
  ```

### `/api/auth/me` returns 401 after login

- Confirm the response from OAuth contains a session cookie and `wsToken`.
- The frontend must use `credentials: 'include'` for API requests.
- Confirm `PUBLIC_URL`, `FRONTEND_URL`, and the browser origin are consistent.
- Do not use an HTTP public URL for production; secure cookies and Zoom App
  embedding require HTTPS.

### WebSocket closes with authentication errors

Production WebSockets require the signed `wsToken` returned by the auth flow.
The browser should connect with a URL shaped like:

```text
wss://HOST/ws?meeting_uuid=<meeting UUID>&session_id=<RTMS session ID>&meetingid=<optional numeric meeting ID>&token=<signed token>
```

The current frontend does not need to send `app_user_id` or `zoom_user_id` in
the URL. The signed token is authoritative. Local development may allow an
anonymous socket, but production must not enable `ALLOW_ANONYMOUS_WS`.

## WebSocket and Transcript Problems

### The browser stays on "Connecting"

1. Confirm the Zoom App has a meeting UUID from `getMeetingUUID()`.
2. Confirm `getRTMSStatus()` returns an active session/stream ID. The frontend
   intentionally waits for this before opening `/ws`.
3. Confirm the URL does not contain `:3000` when the public endpoint is
   CloudFront or ngrok. Use the public host and `/ws` path.
4. For a reverse proxy, forward WebSocket upgrades. CloudFront must have a
   `/ws*` behavior that allows WebSockets and points to the ALB origin.
5. Confirm backend heartbeat logs and reconnect attempts:

   ```bash
   docker compose logs backend | grep -iE 'websocket|ws|heartbeat|reconnect'
   ```

The browser sends an application ping every 25 seconds. The backend sends
protocol pings every 30 seconds and closes stale connections after missed
heartbeats. Reconnects use exponential backoff.

### RTMS is active but no transcript appears

- Confirm Zoom delivered `meeting.rtms_started` to
  `https://HOST/api/rtms/webhook`.
- Confirm `ZOOM_WEBHOOK_SECRET_TOKEN` is set and the request signature is
  accepted.
- Confirm RTMS credentials are configured. The service uses
  `ZM_RTMS_CLIENT`/`ZM_RTMS_SECRET`, falling back to
  `ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET`.
- Confirm the RTMS client joined using the `meeting_uuid`, `rtms_stream_id`,
  and `server_urls` from the webhook.
- Check both services:

  ```bash
  docker compose logs --tail=200 backend
  docker compose logs --tail=200 rtms
  ```

- Confirm `INTERNAL_WEBHOOK_SECRET` matches between backend and RTMS when the
  environment is not development.
- Confirm the WebSocket uses the same meeting UUID and RTMS session/stream ID
  that the RTMS service publishes.

### Transcripts arrive, but the UI reconnects repeatedly

This usually means the socket is reaching the backend but the public proxy is
not preserving WebSocket upgrades, or the browser is using a stale meeting or
session ID. Inspect the actual URL, proxy behavior, and the `subscribed` event.
Valkey replay can make transcripts appear after a socket reconnect; that does
not mean the failed socket was healthy.

## Database and Prisma

### MySQL connection refused

The Compose service is named `mysql`, not `db`:

```bash
docker compose ps mysql
docker compose logs mysql
docker compose exec mysql mysqladmin ping -h localhost -u arlo -parlo
```

The local URL is:

```text
mysql://arlo:arlo@mysql:3306/meeting_assistant
```

For a remote MySQL database, use its private hostname and verify VPC/peering,
security groups, DNS, and port 3306 from every task that must connect.

### Prisma client or table errors

The Compose backend generates the client and runs `db push` at startup. Retry
manually when diagnosing a failed startup:

```bash
docker compose exec backend npx prisma generate
docker compose exec backend npx prisma db push
docker compose restart backend
```

Do not run `db push` blindly against production. The repository does not yet
contain a checked-in Prisma migrations directory; see
[`MYSQL_MIGRATION.md`](./MYSQL_MIGRATION.md).

## RTMS Worker and AWS Control Plane

### An AWS worker is not launched

- Check that `rtms-control` has `ECS_CLUSTER_ARN`,
  `RTMS_WORKER_TASK_DEFINITION_ARN`, worker subnet IDs, and worker security
  groups.
- Check that its task role can call ECS `RunTask` and `StopTask` and pass the
  worker task role.
- Check DynamoDB for the `MEETING#...` / `STREAM#...` control record and its
  launch status.
- Check ECS service events and the task definition image URI.
- Confirm the worker subnets have outbound access to Zoom and ECR. Workers do
  not need public IPs when NAT/VPC endpoints are configured.
- Check that the worker image is built for `linux/amd64`, as required by the
  current RTMS native dependency.

### Worker starts slowly

ECS/Fargate task provisioning and image pull are on the RTMS start path. Use an
immutable image already pushed to same-region ECR, keep the image small, and
maintain a warm service/task strategy if the 60-second startup requirement is
strict. Terraform does not build or push the ECR image.

### Worker stopped but realtime data remains

The normal stop path deletes the Valkey session, event list, and aliases, and
deletes the DynamoDB control record. TTLs are a safety net, not the primary
cleanup mechanism. Check the exact meeting UUID and RTMS stream ID, then inspect
the control-plane/backend logs. MySQL meeting history is intentionally retained.

## AI Features

### Summary or key moment returns 4xx/5xx

- Check `GET /api/ai/status` and confirm `AI_ENABLED=true`.
- Summary-live rejects transcript text shorter than 50 characters.
- Key-moment rejects text shorter than 10 characters.
- The backend tries only the free allowlist:
  `openai/gpt-oss-120b:free`, `google/gemma-4-31b-it:free`, and
  `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Key-moment retries the configured model chain and returns 502 only after all
  models fail or return invalid structured output.
- Summary generation returns an extractive fallback when model calls fail.
- The backend rate limits most AI routes to 20 requests/minute and key-moment
  to 120 requests/minute per backend instance. OpenRouter's own limits vary;
  an API key can improve provider limits but does not remove Arlo's limits.

Check logs without exposing the API key:

```bash
docker compose logs backend | grep -iE 'openrouter|ai|summary|key moment'
```

The frontend key-moment job runs every 30 seconds after a 3-second initial
delay, processes a rolling window, and may correctly produce no result for
ordinary speech.

## Demo Data and Vertical Panels

If cards show placeholder decisions, questions, participants, or sales data,
disable the Settings demo-data toggle. Several vertical components are
intentionally visualization scaffolds and do not automatically populate from
the transcript. General summary and key moments, support sentiment, and
healthcare SOAP notes are the primary AI-connected examples.

## Docker and Port Conflicts

```bash
docker compose logs backend frontend rtms
docker compose up --build
```

Host ports are mapped as follows:

- backend: 3000
- frontend: 3001
- RTMS: 3002
- MySQL: 3306
- optional Redis: 6379

Changing the backend `PORT` variable alone does not change the Compose host
mapping. Change the Compose port mapping and the relevant frontend/ngrok URL if
you need a different host port.

## ngrok

Use a static domain to avoid reconfiguring Zoom after each restart:

```bash
ngrok http 3000 --domain=your-static-domain.ngrok-free.app
```

If the URL changes, update `PUBLIC_URL`, OAuth redirect/allow-list values, Home
URL, Domain Allow List, and the RTMS event endpoint. Restart the backend after
changing `.env`.

## SDK Capability Errors

`HybridError`, `API not supported`, or `require_meeting_role` generally means
the capability is unavailable in the current Zoom context, the app was not
reinstalled after Marketplace changes, or the caller lacks the required meeting
role. Compare the enabled capabilities with
`frontend/src/contexts/ZoomSdkContext.js`, especially the RTMS status and
meeting-context APIs. A participant may not be allowed to call every meeting
context/API operation even when the capability is listed.

After changing Marketplace capabilities:

1. Save the app configuration.
2. Reinstall or reauthorize the app in the Zoom client.
3. Close and reopen the Zoom App WebView.
4. Capture the exact SDK error code and running context.

## Still Blocked

Collect:

```bash
docker compose ps
docker compose logs --tail=200 backend
docker compose logs --tail=200 rtms
curl -i http://localhost:3000/health
```

Do not include OAuth tokens, client secrets, webhook secrets, database
passwords, or full signed WebSocket URLs in an issue. See the
[`README.md`](../README.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), and
[`MYSQL_MIGRATION.md`](./MYSQL_MIGRATION.md) guides before opening a report.
