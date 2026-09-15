#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/deploy/common/lib.sh"

ENV_FILE="${1:-$ROOT_DIR/deploy/common/arlo.deploy.env}"
load_env_file "$ENV_FILE"

require_cmd docker
require_env BACKEND_IMAGE
require_env FRONTEND_IMAGE
require_env RTMS_IMAGE
require_env PUBLIC_URL
require_env ZOOM_CLIENT_ID
require_env ZOOM_CLIENT_SECRET
require_env SESSION_SECRET
require_env REDIS_ENCRYPTION_KEY

note "Starting self-hosted stack"
docker compose \
  --project-name "${SELFHOST_PROJECT_NAME:-arlo}" \
  --env-file "$ENV_FILE" \
  -f "$SCRIPT_DIR/docker-compose.prod.yml" \
  up -d

note "Self-hosted deploy complete"
note "Backend URL:  http://localhost:${SELFHOST_BIND_BACKEND_PORT:-3000}"
note "Frontend URL: http://localhost:${SELFHOST_BIND_FRONTEND_PORT:-3001}"
note "RTMS URL:     http://localhost:${SELFHOST_BIND_RTMS_PORT:-3002}"
