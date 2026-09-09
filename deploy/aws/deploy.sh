#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/deploy/common/lib.sh"

ENV_FILE="${1:-$ROOT_DIR/deploy/common/arlo.deploy.env}"
load_env_file "$ENV_FILE"

require_cmd aws
require_cmd jq
require_env AWS_REGION
require_env AWS_BACKEND_SERVICE
require_env AWS_FRONTEND_SERVICE
require_env AWS_RTMS_SERVICE
require_env AWS_APP_RUNNER_ECR_ACCESS_ROLE_ARN
require_env BACKEND_IMAGE
require_env FRONTEND_IMAGE
require_env RTMS_IMAGE
require_env DATABASE_URL
require_env PUBLIC_URL
require_env ZOOM_CLIENT_ID
require_env ZOOM_CLIENT_SECRET
require_env SESSION_SECRET
require_env REDIS_ENCRYPTION_KEY

export AWS_REGION

make_env_json() {
  jq -n \
    --arg k1 "PUBLIC_URL" --arg v1 "$PUBLIC_URL" \
    --arg k2 "FRONTEND_URL" --arg v2 "$PUBLIC_URL" \
    --arg k3 "DATABASE_URL" --arg v3 "$DATABASE_URL" \
    --arg k4 "ZOOM_CLIENT_ID" --arg v4 "$ZOOM_CLIENT_ID" \
    --arg k5 "ZOOM_CLIENT_SECRET" --arg v5 "$ZOOM_CLIENT_SECRET" \
    --arg k6 "ZOOM_APP_ID" --arg v6 "${ZOOM_APP_ID:-}" \
    --arg k7 "ZOOM_HOST" --arg v7 "${ZOOM_HOST:-zoom.us}" \
    --arg k8 "SESSION_SECRET" --arg v8 "$SESSION_SECRET" \
    --arg k9 "REDIS_ENCRYPTION_KEY" --arg v9 "$REDIS_ENCRYPTION_KEY" \
    --arg k10 "OPENROUTER_API_KEY" --arg v10 "${OPENROUTER_API_KEY:-}" \
    --arg k11 "DEFAULT_MODEL" --arg v11 "${DEFAULT_MODEL:-}" \
    --arg k12 "FALLBACK_MODEL" --arg v12 "${FALLBACK_MODEL:-}" \
    --arg k13 "AI_ENABLED" --arg v13 "${AI_ENABLED:-true}" \
    --arg k14 "EXTRACTION_ENABLED" --arg v14 "${EXTRACTION_ENABLED:-false}" \
    --arg k15 "PUBLIC_LINKS_ENABLED" --arg v15 "${PUBLIC_LINKS_ENABLED:-false}" \
    --arg k16 "DISABLE_MEETING_PERSISTENCE" --arg v16 "${DISABLE_MEETING_PERSISTENCE:-false}" \
    --arg k17 "LOG_LEVEL" --arg v17 "${LOG_LEVEL:-info}" \
    --arg k18 "NODE_ENV" --arg v18 "production" \
    --arg k19 "PORT" --arg v19 "3000" \
    --arg k20 "RTMS_PORT" --arg v20 "3002" \
    --arg k21 "CORS_ORIGINS" --arg v21 "$PUBLIC_URL" \
    '{
      ($k1): $v1,
      ($k2): $v2,
      ($k3): $v3,
      ($k4): $v4,
      ($k5): $v5,
      ($k6): $v6,
      ($k7): $v7,
      ($k8): $v8,
      ($k9): $v9,
      ($k10): $v10,
      ($k11): $v11,
      ($k12): $v12,
      ($k13): $v13,
      ($k14): $v14,
      ($k15): $v15,
      ($k16): $v16,
      ($k17): $v17,
      ($k18): $v18,
      ($k19): $v19,
      ($k20): $v20,
      ($k21): $v21
    }'
}

make_service_payload() {
  local service_name="$1"
  local image="$2"
  local port="$3"
  local env_json="$4"

  jq -n \
    --arg service_name "$service_name" \
    --arg access_role "$AWS_APP_RUNNER_ECR_ACCESS_ROLE_ARN" \
    --arg image "$image" \
    --arg port "$port" \
    --arg cpu "${AWS_APP_RUNNER_CPU:-0.25 vCPU}" \
    --arg memory "${AWS_APP_RUNNER_MEMORY:-0.5 GB}" \
    --argjson runtime_env "$env_json" \
    '{
      ServiceName: $service_name,
      SourceConfiguration: {
        AuthenticationConfiguration: {
          AccessRoleArn: $access_role
        },
        AutoDeploymentsEnabled: false,
        ImageRepository: {
          ImageIdentifier: $image,
          ImageRepositoryType: "ECR",
          ImageConfiguration: {
            Port: $port,
            RuntimeEnvironmentVariables: $runtime_env
          }
        }
      },
      InstanceConfiguration: {
        Cpu: $cpu,
        Memory: $memory
      }
    }'
}

get_service_arn() {
  local service_name="$1"
  aws apprunner list-services \
    --query "ServiceSummaryList[?ServiceName=='${service_name}'].ServiceArn | [0]" \
    --output text 2>/dev/null
}

wait_for_service_running() {
  local service_arn="$1"
  local status
  local i

  for ((i = 1; i <= 60; i += 1)); do
    status="$(aws apprunner describe-service --service-arn "$service_arn" --query 'Service.Status' --output text)"
    if [[ "$status" == "RUNNING" ]]; then
      return 0
    fi
    sleep 10
  done

  return 1
}

create_or_update_service() {
  local service_name="$1"
  local image="$2"
  local port="$3"
  local env_json="$4"

  local payload
  local tmp
  local service_arn

  payload="$(make_service_payload "$service_name" "$image" "$port" "$env_json")"
  tmp="$(mktemp)"
  printf '%s\n' "$payload" >"$tmp"

  service_arn="$(get_service_arn "$service_name")"
  if [[ -n "$service_arn" && "$service_arn" != "None" ]]; then
    note "Updating App Runner service: $service_name"
    jq --arg arn "$service_arn" 'del(.ServiceName) + {ServiceArn: $arn}' "$tmp" >"${tmp}.update"
    aws apprunner update-service --cli-input-json "file://${tmp}.update" >/dev/null
    rm -f "${tmp}.update"
  else
    note "Creating App Runner service: $service_name"
    aws apprunner create-service --cli-input-json "file://${tmp}" >/dev/null
    service_arn="$(get_service_arn "$service_name")"
  fi

  rm -f "$tmp"

  wait_for_service_running "$service_arn" || die "Timed out waiting for $service_name"
  printf '%s\n' "$service_arn"
}

FRONTEND_ENV='{}'
FRONTEND_ARN="$(create_or_update_service "$AWS_FRONTEND_SERVICE" "$FRONTEND_IMAGE" "3000" "$FRONTEND_ENV")"
FRONTEND_URL="https://$(aws apprunner describe-service --service-arn "$FRONTEND_ARN" --query 'Service.ServiceUrl' --output text)"

RTMS_ENV="$(jq -n \
  --arg k1 "DATABASE_URL" --arg v1 "$DATABASE_URL" \
  --arg k2 "BACKEND_URL" --arg v2 "$PUBLIC_URL" \
  --arg k3 "ZOOM_CLIENT_ID" --arg v3 "$ZOOM_CLIENT_ID" \
  --arg k4 "ZOOM_CLIENT_SECRET" --arg v4 "$ZOOM_CLIENT_SECRET" \
  --arg k5 "ZM_RTMS_CLIENT" --arg v5 "$ZOOM_CLIENT_ID" \
  --arg k6 "ZM_RTMS_SECRET" --arg v6 "$ZOOM_CLIENT_SECRET" \
  --arg k7 "NODE_ENV" --arg v7 "production" \
  --arg k8 "RTMS_PORT" --arg v8 "3002" \
  '{
    ($k1): $v1,
    ($k2): $v2,
    ($k3): $v3,
    ($k4): $v4,
    ($k5): $v5,
    ($k6): $v6,
    ($k7): $v7,
    ($k8): $v8
  }')"
RTMS_ARN="$(create_or_update_service "$AWS_RTMS_SERVICE" "$RTMS_IMAGE" "3002" "$RTMS_ENV")"
RTMS_URL="https://$(aws apprunner describe-service --service-arn "$RTMS_ARN" --query 'Service.ServiceUrl' --output text)"

BACKEND_ENV="$(make_env_json | jq \
  --arg frontend_upstream "$FRONTEND_URL" \
  --arg rtms_service "$RTMS_URL" \
  '. + {FRONTEND_UPSTREAM_URL: $frontend_upstream, RTMS_SERVICE_URL: $rtms_service}')"
BACKEND_ARN="$(create_or_update_service "$AWS_BACKEND_SERVICE" "$BACKEND_IMAGE" "3000" "$BACKEND_ENV")"
BACKEND_URL="https://$(aws apprunner describe-service --service-arn "$BACKEND_ARN" --query 'Service.ServiceUrl' --output text)"

note "AWS deploy complete"
note "Backend URL:  $BACKEND_URL"
note "Frontend URL: $FRONTEND_URL"
note "RTMS URL:     $RTMS_URL"
