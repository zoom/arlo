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

read_optional_parameter() {
  aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || true
}

# Keep decrypted values in this process environment; do not write a plaintext env file.
export ZOOM_CLIENT_ID="$(read_parameter "${PARAMETER_PREFIX}/zoom-client-id")"
export ZOOM_CLIENT_SECRET="$(read_parameter "${PARAMETER_PREFIX}/zoom-client-secret")"
export ZOOM_WEBHOOK_TOKEN="$(read_parameter "${PARAMETER_PREFIX}/zoom-webhook-secret-token")"
export SESSION_SECRET="$(read_parameter "${PARAMETER_PREFIX}/session-secret")"
TOKEN_ENCRYPTION_KEY="$(read_optional_parameter "${PARAMETER_PREFIX}/token-encryption-key")"
if [[ -z "$TOKEN_ENCRYPTION_KEY" ]]; then
  TOKEN_ENCRYPTION_KEY="$(read_parameter "${PARAMETER_PREFIX}/redis-encryption-key")"
fi
export TOKEN_ENCRYPTION_KEY
export OPENROUTER_API_KEY="$(read_optional_parameter "${PARAMETER_PREFIX}/openrouter-api-key")"

export PUBLIC_URL="${PUBLIC_URL:?PUBLIC_URL is required}"
export OPENROUTER_MODELS="${OPENROUTER_MODELS:-nex-agi/nex-n2.5-mini:free,nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free,thinkingmachines/inkling:free,poolside/laguna-s-2.1:free,liquid/lfm-2.5-2.6b:free}"
export DEFAULT_MODEL="${DEFAULT_MODEL:-nex-agi/nex-n2.5-mini:free}"
export FALLBACK_MODEL="${FALLBACK_MODEL:-nvidia/nemotron-3.5-lightning:free}"

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
