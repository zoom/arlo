#!/usr/bin/env bash

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
SSM_PREFIX="${SSM_PREFIX:-/arlo/prod}"
KMS_KEY_ID="${KMS_KEY_ID:-alias/arlo-prod}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

put_secret() {
  local name="$1"
  local value="$2"

  aws ssm put-parameter \
    --region "$AWS_REGION" \
    --name "${SSM_PREFIX}/${name}" \
    --type SecureString \
    --key-id "$KMS_KEY_ID" \
    --value "$value" \
    --overwrite >/dev/null

  echo "Wrote ${SSM_PREFIX}/${name}"
}

require_cmd aws

if [[ "${SKIP_DATABASE_URL:-false}" != "true" ]]; then
  require_env DATABASE_URL
fi
require_env ZOOM_CLIENT_ID
require_env ZOOM_CLIENT_SECRET
require_env ZOOM_WEBHOOK_SECRET_TOKEN
require_env SESSION_SECRET
require_env REDIS_ENCRYPTION_KEY
require_env INTERNAL_WEBHOOK_SECRET

if [[ "${#REDIS_ENCRYPTION_KEY}" -ne 32 ]]; then
  echo "REDIS_ENCRYPTION_KEY must be exactly 32 characters. Generate with: openssl rand -hex 16" >&2
  exit 1
fi

aws kms describe-key --region "$AWS_REGION" --key-id "$KMS_KEY_ID" >/dev/null

if [[ "${SKIP_DATABASE_URL:-false}" != "true" ]]; then
  put_secret "database-url" "$DATABASE_URL"
fi
put_secret "zoom-client-id" "$ZOOM_CLIENT_ID"
put_secret "zoom-client-secret" "$ZOOM_CLIENT_SECRET"
put_secret "zoom-webhook-secret-token" "$ZOOM_WEBHOOK_SECRET_TOKEN"
put_secret "session-secret" "$SESSION_SECRET"
put_secret "redis-encryption-key" "$REDIS_ENCRYPTION_KEY"
put_secret "internal-webhook-secret" "$INTERNAL_WEBHOOK_SECRET"

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  put_secret "openrouter-api-key" "$OPENROUTER_API_KEY"
fi
