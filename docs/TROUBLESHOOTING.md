# Troubleshooting Guide

Common issues and solutions when running Arlo Meeting Assistant.

---

## Quick Fixes

Most issues can be resolved with these commands:

```bash
# Restart services
docker-compose restart backend

# Clean restart (keeps data)
docker-compose down && docker-compose up --build

# Full reset (deletes database!)
docker-compose down -v && docker-compose up --build
```

---

## App Not Loading in Zoom

### Issue: Blank screen or app won't load

**Solutions:**

1. **Verify backend is running:**
   ```bash
   curl http://localhost:3000/health
   # Should return: {"status":"ok",...}
   ```

2. **Check ngrok is running:**
   ```bash
   curl https://your-ngrok-url.ngrok-free.app/health
   ```

3. **Verify Home URL in Zoom Marketplace:**
   - Go to Zoom Marketplace → Your App → Features → Surface
   - Home URL should be: `https://YOUR-NGROK-URL` (no path, just the base URL)

4. **Check browser console for errors:**
   - In Zoom, right-click on the app → Inspect Element
   - Look for red errors in Console tab

5. **Restart services:**
   ```bash
   docker-compose restart backend frontend
   ```

### Issue: "403 Forbidden" or CORS errors

**Cause:** Domain not in allow list or CORS misconfigured.

**Solutions:**

1. **Add domain to Zoom Marketplace allow lists:**
   - OAuth Allow List: `https://YOUR-NGROK-URL`
   - Domain Allow List: `YOUR-NGROK-URL` (without https://)

2. **Check PUBLIC_URL in .env matches your ngrok URL exactly**

3. **Restart backend after .env changes:**
   ```bash
   docker-compose restart backend
   ```

---

## Authentication Issues

### Issue: "Connect with Zoom" button doesn't work

**Solutions:**

1. **Check OAuth Redirect URL in Zoom Marketplace:**
   - Must be exactly: `https://YOUR-NGROK-URL/api/auth/callback`

2. **Verify client credentials in .env:**
   ```bash
   # Check these are set correctly
   ZOOM_CLIENT_ID=your_actual_client_id
   ZOOM_CLIENT_SECRET=your_actual_client_secret
   ```

3. **Check backend logs for OAuth errors:**
   ```bash
   docker-compose logs backend | grep -i "oauth\|auth"
   ```

### Issue: "Invalid state" or "CSRF" error

**Cause:** OAuth state mismatch, usually from stale session.

**Solutions:**

1. **Clear browser/Zoom app cache:**
   - Close and reopen the Zoom app
   - Or restart Zoom client entirely

2. **Restart backend to clear PKCE store:**
   ```bash
   docker-compose restart backend
   ```

### Issue: Logged in but redirected back to auth screen

**Cause:** Session cookie not being set or sent.

**Solutions:**

1. **Check cookie settings in .env:**
   ```bash
   # For development
   NODE_ENV=development
   ```

2. **Verify PUBLIC_URL matches where you're accessing the app**

---

## WebSocket / Live Transcript Issues

### Issue: "Connecting to server..." never resolves

**Solutions:**

1. **Check WebSocket endpoint is accessible:**
   ```bash
   # Backend should log WebSocket connections
   docker-compose logs backend | grep -i "websocket\|ws"
   ```

2. **Verify you're authenticated:**
   - WebSocket requires valid session
   - Try logging out and back in

3. **Check for proxy issues:**
   - ngrok should support WebSocket by default
   - If using custom proxy, ensure WS upgrade is allowed

### Issue: Transcripts not appearing during meeting

**Causes:**
- RTMS not started
- RTMS access not approved
- WebSocket not connected

**Solutions:**

1. **Verify RTMS is started:**
   - Check for "Start Arlo" button in the app
   - Look for RTMS status indicator

2. **Check RTMS service logs:**
   ```bash
   docker-compose logs rtms
   ```

3. **Verify RTMS webhooks are configured:**
   - Event endpoint: `https://YOUR-NGROK-URL/api/rtms/webhook`
   - Events: `meeting.rtms_started`, `meeting.rtms_stopped`

4. **Confirm RTMS access is approved:**
   - RTMS requires approval from Zoom
   - Check your Zoom Marketplace app status

---

## Database / Prisma Issues

### Issue: "Cannot find module '.prisma/client'"

**Cause:** Prisma client not generated for the correct platform.

**Solution:**
```bash
docker-compose exec backend npx prisma generate
docker-compose restart backend
```

### Issue: "Can't reach database server"

**Cause:** PostgreSQL not ready or connection string wrong.

**Solutions:**

1. **Wait for PostgreSQL to be healthy:**
   ```bash
   docker-compose ps
   # postgres should show "healthy"
   ```

2. **Check DATABASE_URL in .env:**
   ```bash
   # For Docker
   DATABASE_URL=postgresql://postgres:postgres@postgres:5432/meeting_assistant
   ```

3. **Restart services:**
   ```bash
   docker-compose restart postgres backend
   ```

### Issue: "Table does not exist"

**Cause:** Database schema not applied.

**Solution:**
```bash
docker-compose exec backend npx prisma db push
```

### Issue: Schema changes not reflected

**Solution:**
```bash
docker-compose exec backend npx prisma generate
docker-compose exec backend npx prisma db push
docker-compose restart backend
```

---

## Docker Issues

### Issue: Port already in use

**Error:** `Error: listen EADDRINUSE: address already in use :::3000`

**Solutions:**

1. **Find and kill process using port:**
   ```bash
   lsof -ti:3000 | xargs kill -9
   ```

2. **Or change port in .env:**
   ```bash
   PORT=3001
   ```

### Issue: Container won't start

**Solutions:**

1. **Check container logs:**
   ```bash
   docker-compose logs backend
   docker-compose logs frontend
   docker-compose logs rtms
   ```

2. **Rebuild containers:**
   ```bash
   docker-compose down
   docker-compose up --build
   ```

3. **Full reset (removes volumes):**
   ```bash
   docker-compose down -v
   docker-compose up --build
   ```

### Issue: Changes not reflecting

**Solutions:**

1. **Frontend changes:** Hot reload should work. If not:
   ```bash
   docker-compose restart frontend
   ```

2. **Backend changes:** Nodemon should auto-restart. If not:
   ```bash
   docker-compose restart backend
   ```

3. **Package.json changes:** Requires rebuild:
   ```bash
   docker-compose up --build -V
   ```

---

## ngrok Issues

### Issue: App stops working after restarting ngrok

**Cause:** Random ngrok URLs change each restart.

**Solutions:**

1. **Use a static ngrok domain (recommended):**
   - Get free static domain at [ngrok dashboard](https://dashboard.ngrok.com/domains)
   - Start with: `ngrok http 3000 --domain=your-static-domain.ngrok-free.app`

2. **If using random domain, update everything:**
   - Update `PUBLIC_URL` in `.env`
   - Update URLs in Zoom Marketplace (OAuth, Home URL, Webhooks)
   - Restart backend: `docker-compose restart backend`

### Issue: ngrok tunnel expired

**Cause:** Free ngrok tunnels expire after 2 hours of inactivity.

**Solution:**
- Restart ngrok: `ngrok http 3000`
- Update URLs if using random domain

---

## Zoom SDK Issues

### Issue: "zoomSdk is not defined"

**Cause:** SDK only works inside Zoom client.

**Solutions:**

1. **Verify app is running in Zoom:**
   - SDK won't work in regular browser
   - Must be opened via Apps menu in Zoom meeting

2. **Check SDK script is loaded:**
   - View page source in Zoom app
   - Look for: `<script src="https://appssdk.zoom.us/sdk.min.js"></script>`

### Issue: "API not supported" errors

**Cause:** SDK capability not enabled in Zoom Marketplace.

**Solutions:**

1. **Check console for which API failed:**
   ```
   ❌ getMeetingParticipants failed: API not supported
   ```

2. **Enable the API in Zoom Marketplace:**
   - Go to Your App → Features → Zoom App SDK
   - Click "Add APIs"
   - Enable the missing API
   - Save and reinstall app

**Common APIs to enable:**
- `getMeetingContext`
- `getMeetingUUID`
- `getUserContext`
- `authorize` / `onAuthorized`
- `callZoomApi` (for RTMS)

---

## AI Features Not Working

### Issue: Summaries/suggestions fail

**Cause:** Usually rate limiting or network issues.

**Solutions:**

1. **Check if using free models (no API key needed):**
   ```bash
   # .env should have:
   DEFAULT_MODEL=google/gemini-2.0-flash-thinking-exp:free
   ```

2. **Check backend logs for AI errors:**
   ```bash
   docker-compose logs backend | grep -i "openrouter\|ai"
   ```

3. **Wait for rate limit reset:**
   - Free tier: 10 requests/minute
   - Add `OPENROUTER_API_KEY` for higher limits

---

## Debugging Commands

```bash
# Health checks
curl http://localhost:3000/health

# View all logs
docker-compose logs -f

# View specific service
docker-compose logs -f backend
docker-compose logs -f frontend
docker-compose logs -f rtms

# Check running containers
docker ps

# Restart specific service
docker-compose restart backend

# Rebuild everything
docker-compose down && docker-compose up --build

# Check database
docker-compose exec backend npx prisma studio

# Check ports in use
lsof -i :3000
lsof -i :3001
lsof -i :3002
```

---

## Still Having Issues?

1. **Enable debug logging:**
   ```bash
   # In .env
   LOG_LEVEL=debug
   ```

2. **Check all prerequisites:**
   - Docker running
   - ngrok running with correct URL
   - All environment variables set
   - RTMS access approved by Zoom

3. **Fresh start:**
   ```bash
   docker-compose down -v
   docker-compose up --build
   ```

4. **Check documentation:**
   - [README.md](../README.md) — Quick start guide
   - [ARCHITECTURE.md](./ARCHITECTURE.md) — System architecture

5. **Get help:**
   - [GitHub Issues](https://github.com/zoom/arlo/issues)
   - [GitHub Discussions](https://github.com/zoom/arlo/discussions)
   - [Zoom Developer Forum](https://devforum.zoom.us/)
