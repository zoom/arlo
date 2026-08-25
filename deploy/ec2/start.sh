#!/usr/bin/env bash

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
PARAMETER_PREFIX="${PARAMETER_PREFIX:-/arlo/prod}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/arlo/docker-compose.yml}"

read_parameter() {
  aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text
}

# Keep decrypted values in this process environment; do not write a plaintext env file.
export DATABASE_URL="$(read_parameter "${PARAMETER_PREFIX}/database-url")"
export ZOOM_CLIENT_ID="$(read_parameter "${PARAMETER_PREFIX}/zoom-client-id")"
export ZOOM_CLIENT_SECRET="$(read_parameter "${PARAMETER_PREFIX}/zoom-client-secret")"
export ZOOM_WEBHOOK_TOKEN="$(read_parameter "${PARAMETER_PREFIX}/zoom-webhook-secret-token")"
export SESSION_SECRET="$(read_parameter "${PARAMETER_PREFIX}/session-secret")"
export TOKEN_ENCRYPTION_KEY="$(read_parameter "${PARAMETER_PREFIX}/redis-encryption-key")"
export OPENROUTER_API_KEY="$(read_parameter "${PARAMETER_PREFIX}/openrouter-api-key")"

export PUBLIC_URL="${PUBLIC_URL:-https://d3k9b5xygup21i.cloudfront.net}"
export OPENROUTER_MODELS="${OPENROUTER_MODELS:-z-ai/glm-5.2:free,google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free}"
export DEFAULT_MODEL="${DEFAULT_MODEL:-z-ai/glm-5.2:free}"
export FALLBACK_MODEL="${FALLBACK_MODEL:-google/gemma-4-31b-it:free}"

export FRONTEND_IMAGE="${FRONTEND_IMAGE:?FRONTEND_IMAGE is required}"
export BACKEND_IMAGE="${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
export RTMS_IMAGE="${RTMS_IMAGE:?RTMS_IMAGE is required}"

docker_config="$(mktemp -d)"
trap 'rm -rf "$docker_config"' EXIT
export DOCKER_CONFIG="$docker_config"

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "${FRONTEND_IMAGE%%/*}" >/dev/null

docker compose -f "$COMPOSE_FILE" pull
rm -rf "$docker_config"
trap - EXIT
unset DOCKER_CONFIG

exec docker compose -f "$COMPOSE_FILE" up --pull never --remove-orphans
