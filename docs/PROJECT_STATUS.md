# Arlo Meeting Assistant - Project Status

**Last reviewed:** 2026-07-24
**Version:** v1.0 reference implementation plus AWS scalable deployment first cut
**Specification:** [`../SPEC.md`](../SPEC.md)

## Current State

Arlo is a developer reference implementation for Zoom RTMS. The repository
currently has:

- A React 18/Create React App Zoom App with HashRouter and in-meeting views.
- In-client OAuth PKCE plus browser OAuth redirect support.
- A Node.js/Express backend with MySQL/Prisma persistence, REST APIs, and an
  authenticated WebSocket server.
- A separate Node.js RTMS service using `@zoom/rtms` 1.0.2.
- Optional Valkey/Redis realtime fanout, replay, TTL cleanup, and KMS-backed
  AES-256-GCM encryption for sensitive realtime payload fields.
- An AWS Terraform first cut with CloudFront, ALB, ECS/Fargate, DynamoDB
  control state, optional private RDS MySQL, optional serverless Valkey, KMS,
  and SSM secrets.
- Five UI verticals: Notes, Healthcare, Legal, Sales, and Support.

The AWS scalable path launches one `rtms-worker` ECS task per RTMS stream. The
worker is short-lived and is stopped when the RTMS stream ends. The always-on
services are the frontend, backend, and RTMS control plane.

## Technology Decisions

| Component | Current choice |
| --- | --- |
| Runtime | Node.js 20+ |
| Frontend | React 18, CRA 5, `@zoom/appssdk` 0.16 |
| Backend | Express.js, JavaScript, `ws` |
| Database | MySQL 8.0+ through Prisma |
| Realtime bus | Redis-compatible Valkey; optional locally, AWS Serverless Valkey in Terraform |
| Control store | DynamoDB On-Demand in AWS scalable mode |
| RTMS | `@zoom/rtms` 1.0.2 |
| AI | OpenRouter free-model allowlist, optional API key |
| Local runtime | Docker Compose |
| AWS runtime | ECS/Fargate behind CloudFront and an ALB |

## Implemented

- Zoom OAuth PKCE, session restoration, token refresh, and logout.
- RTMS webhook validation and direct RTMS transcript/participant ingestion.
- AWS control-plane dispatch to one ECS worker per RTMS stream.
- Browser WebSocket identity routing using meeting UUID plus RTMS session/stream
  ID, with signed tokens in production.
- WebSocket heartbeats, stale-connection detection, reconnect backoff, Valkey
  pub/sub, bounded replay, and TTL cleanup.
- MySQL transcript, participant event, meeting, summary, highlight, and AI chat
  persistence.
- WebVTT and Markdown export generated from persisted data.
- AI summary, title, action-item, chat, SOAP, sentiment, and key-moment routes.
- Key-moment analysis on a 30-second frontend cadence after sufficient text is
  available. Summary auto-generation is triggered after new segment batches,
  not on a fixed 30-minute timer.
- Configured free-only OpenRouter models:
  `openai/gpt-oss-120b:free`, `google/gemma-4-31b-it:free`, and
  `nvidia/nemotron-3-ultra-550b-a55b:free`.
- Local development Docker Compose, self-hosted deployment scaffolding, AWS
  CloudFormation/App Runner draft, and AWS Terraform deployment.
- Basic smoke tests in `tests/smoke.test.js` and a fresh-install checklist.

## Demo or Partial Features

The vertical selector and feature layout are implemented, but the feature
panels are not all connected to automatic transcript extraction:

- General summary and key moments call live AI endpoints when AI is enabled.
- Support sentiment calls the AI endpoint on a 30-second cadence.
- Healthcare SOAP notes call the AI endpoint as new transcript content arrives.
- Many Notes, Legal, Sales, Healthcare, and Support cards use demo data or
  manual UI state when the Settings demo-data toggle is enabled.
- Decisions, open questions, bookmarks, participant statistics, and several
  industry-specific panels should not be described as fully automatic pipeline
  outputs yet.
- Guest-mode screens are implemented as UI states. Live guest transcript access
  is not enabled by default; production WebSockets require an authenticated
  signed session token and public links are disabled by default.

## Known Limitations

- Prisma schema bootstrap uses `db push`; a production migration history is not
  checked into this repository.
- Search uses MySQL-compatible `LIKE` queries. It is not PostgreSQL FTS and no
  MySQL FULLTEXT index is provisioned by the starter stack.
- OAuth token encryption is application-level AES-128-CBC using the current
  `REDIS_ENCRYPTION_KEY` implementation. Review and harden this before treating
  the project as a production security baseline.
- Without `REDIS_URL`, realtime fanout is in-process and does not scale across
  backend instances.
- MySQL meeting history is durable and is not deleted automatically when RTMS
  stops. Retention/deletion must be implemented operationally.
- CloudWatch logs are disabled by default in the AWS Terraform template; task
  logs are otherwise ephemeral container output.
- Terraform expects ECR image URIs but does not build or push images.
- Exact latency, concurrency, and cost targets are deployment-dependent and
  require load testing; the numbers in design documents are targets, not SLOs.

## Next Actions

1. Complete a security review of OAuth token encryption, WebSocket authorization,
   internal webhook authentication, and production IAM policies.
2. Add a checked-in, reviewed database migration strategy before production
   schema changes.
3. Load-test Valkey routing, WebSocket fanout, ECS worker launch/stop handling,
   and 2,000-stream subnet capacity.
4. Replace demo-only vertical panels with explicitly scoped extraction jobs or
   keep them labeled as demonstrations.
5. Add CI coverage for Terraform, Docker builds, frontend builds, backend tests,
   and smoke-test setup.
6. Record and publish a demo only after the fresh-install and deployment
   checklists pass.

## Related Documentation

- [`../README.md`](../README.md) - local quick start and deployment overview
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) - current component and data flow
- [`FRESH_INSTALL_CHECKLIST.md`](./FRESH_INSTALL_CHECKLIST.md) - local test plan
- [`MYSQL_MIGRATION.md`](./MYSQL_MIGRATION.md) - MySQL and legacy cutover notes
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) - common issues
- [`../CLAUDE.md`](../CLAUDE.md) - developer quick reference
