# Engineering Release Note (ERN)

**Application:** Arlo Meeting Assistant
**Client ID (Production):** `dAYlkAqpSg6cAleyy2dHQ`
**Version:** 1.0.0
**Date:** 2026-05-14
**Classification:** Internal / Security Review

---

## 1. Application Overview

Arlo Meeting Assistant is an open-source Zoom Apps reference implementation that demonstrates real-time meeting intelligence using Zoom's RTMS (Real-Time Media Streams) APIs. The application runs natively inside Zoom meetings as an embedded surface app.

### Purpose
- Capture live meeting transcripts via RTMS (no bot participant required)
- Generate AI-powered summaries, action items, and meeting insights
- Provide industry-specific modes (Healthcare, Legal, Sales, Support)
- Serve as a reference implementation for developers building meeting tools

### Target Users
- Developers learning Zoom Apps and RTMS integration
- Organizations prototyping meeting intelligence applications

---

## 2. System Architecture

### Components

| Component | Technology | Port | Description |
|-----------|------------|------|-------------|
| **Frontend** | React 18, Zoom Apps SDK | 3001 | In-meeting UI embedded in Zoom client |
| **Backend** | Node.js 20, Express | 3000 | REST API, WebSocket server, OAuth handler |
| **RTMS Service** | Node.js, @zoom/rtms | 3002 | Webhook handler for transcript ingestion |
| **Database** | PostgreSQL 15 | 5432 | Persistent storage for users, meetings, transcripts |

### Data Flow

```
Zoom RTMS WebSocket → RTMS Service → Backend API → PostgreSQL
                                         ↓
                    WebSocket broadcast → Frontend (< 1s latency)
```

---

## 3. Authentication & Authorization

### OAuth 2.0 with PKCE
- **Flow:** Authorization Code with PKCE (in-client flow)
- **Token Storage:** Encrypted in PostgreSQL (AES-256-GCM)
- **Session Management:** httpOnly cookies with secure flag
- **Token Refresh:** Automatic refresh before expiry with mutex lock

### OAuth Scopes Required

| Scope | Purpose |
|-------|---------|
| `meeting:read` | Read meeting details |
| `user:read` | Read user profile information |

### Session Security
- Sessions stored server-side with cryptographically random IDs
- 64-character `SESSION_SECRET` for session signing
- Cookies: `httpOnly`, `secure`, `sameSite=none` (required for Zoom iframe)

---

## 4. Data Storage & Encryption

### Database Schema (PostgreSQL)

| Table | Description | Sensitive Data |
|-------|-------------|----------------|
| `User` | User profiles | Zoom user ID, email, name |
| `UserToken` | OAuth tokens | **Encrypted** access/refresh tokens |
| `Meeting` | Meeting metadata | Title, UUID, timestamps |
| `TranscriptSegment` | Transcript text | Speaker name, spoken text |
| `Speaker` | Speaker mapping | Participant names |
| `Highlight` | User bookmarks | Timestamp references |

### Encryption

| Data | Method | Key Size |
|------|--------|----------|
| OAuth tokens | AES-256-GCM | 256-bit |
| Session cookies | HMAC-SHA256 | 256-bit |
| Passwords | N/A (OAuth only) | N/A |

### Data Isolation
- All database queries filtered by `ownerId`
- Users can only access their own meetings and transcripts
- Row-level security enforced at application layer

---

## 5. API Security

### Rate Limiting

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| Global | 1000 requests | 15 minutes |
| Authentication | 30 requests | 15 minutes |
| AI endpoints | 20 requests | 1 minute |

### Input Validation
- Request body validation on all endpoints
- SQL injection prevention via Prisma ORM (parameterized queries)
- XSS prevention via React's default escaping

### CORS & Headers
- CORS restricted to configured `PUBLIC_URL`
- Security headers enforced:
  - `Strict-Transport-Security`
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy`
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## 6. Webhook Security (RTMS)

### Verification
- HMAC-SHA256 signature verification on all webhooks
- Header: `x-zm-signature` validated against `ZOOM_WEBHOOK_SECRET_TOKEN`
- Timing-safe comparison with length check
- 5-minute replay protection via timestamp validation

### Webhook Events

| Event | Purpose |
|-------|---------|
| `meeting.rtms_started` | Initialize transcript capture |
| `meeting.rtms_stopped` | Finalize meeting data |

---

## 7. Third-Party Integrations

### Zoom APIs

| API | Purpose | Data Sent |
|-----|---------|-----------|
| OAuth 2.0 | Authentication | Auth codes, tokens |
| RTMS WebSocket | Transcript streaming | None (receive only) |
| REST API `/v2/meetings` | Meeting details | Meeting IDs |
| REST API `/v2/users/me` | User profile | None (read only) |

### AI Provider (OpenRouter)

| Setting | Value |
|---------|-------|
| Provider | OpenRouter.ai |
| Default Model | `google/gemini-2.0-flash-thinking-exp:free` |
| Data Sent | Transcript text for summarization |
| Data Retained | Per OpenRouter's privacy policy |

**Note:** AI features are optional. No data is sent to OpenRouter unless AI features are actively used.

---

## 8. Data Retention & Privacy

### Data Collected

| Data Type | Source | Retention |
|-----------|--------|-----------|
| User profile | Zoom OAuth | Until account deletion |
| Meeting metadata | Zoom API | Until user deletes |
| Transcripts | RTMS stream | Until user deletes |
| OAuth tokens | Zoom OAuth | Auto-refreshed, encrypted |

### Data NOT Collected
- Meeting audio/video content
- Screen share content
- Chat messages (only app-initiated notices)
- Participant video or audio files

### User Controls
- Users can delete individual meetings
- Users can delete their account and all associated data
- No data sharing between users

---

## 9. Logging & Monitoring

### Log Levels

| Level | Content |
|-------|---------|
| `info` (default) | API requests, errors, system events |
| `debug` | Transcript content, PII (development only) |

### PII in Logs
- Transcript content only logged at `debug` level
- Production deployments should use `LOG_LEVEL=info`
- No tokens or secrets logged at any level

---

## 10. Deployment Architecture

### Production Environment

| Resource | Configuration |
|----------|---------------|
| Hosting | Azure VM (arlo.westus.cloudapp.azure.com) |
| Containerization | Docker Compose |
| HTTPS | TLS termination at load balancer |
| Database | PostgreSQL in Docker volume |

### Environment Variables (Required)

| Variable | Purpose | Sensitive |
|----------|---------|-----------|
| `ZOOM_CLIENT_ID` | OAuth client ID | No |
| `ZOOM_CLIENT_SECRET` | OAuth client secret | **Yes** |
| `DATABASE_URL` | PostgreSQL connection | **Yes** |
| `SESSION_SECRET` | Session signing key | **Yes** |
| `TOKEN_ENCRYPTION_KEY` | Token encryption key | **Yes** |
| `PUBLIC_URL` | Application base URL | No |

---

## 11. Known Limitations

| Area | Current State | Production Recommendation |
|------|---------------|---------------------------|
| PKCE storage | In-memory | Redis with TTL |
| WebSocket scaling | Single instance | Redis pub/sub |
| Token refresh | Basic retry | Exponential backoff |
| Webhook processing | Synchronous | Queue-based async |

---

## 12. Security Checklist

- [x] OAuth 2.0 with PKCE (no client secret in frontend)
- [x] Encrypted token storage (AES-256-GCM)
- [x] httpOnly session cookies
- [x] Rate limiting on all endpoints
- [x] HMAC webhook verification with replay protection
- [x] Row-level data isolation
- [x] SQL injection prevention (Prisma ORM)
- [x] XSS prevention (React escaping)
- [x] HTTPS enforced
- [x] Security headers configured
- [x] PII logging gated by log level
- [x] No secrets in frontend code

---

## 13. Contact

**Repository:** https://github.com/zoom/arlo
**Maintainer:** Zoom Developer Relations
**Security Issues:** Report via GitHub Issues (private disclosure)

---

*This document is for internal security review purposes.*
