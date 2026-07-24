data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name           = lower("${var.name_prefix}-${var.environment}")
  namespace_name = "${local.name}.local"
  public_url     = var.public_url != "" ? trimsuffix(var.public_url, "/") : "https://${aws_cloudfront_distribution.app.domain_name}"
  websocket_url  = startswith(local.public_url, "https://") ? replace(local.public_url, "https://", "wss://") : replace(local.public_url, "http://", "ws://")
  ssm_prefix     = trimsuffix(var.ssm_parameter_prefix, "/")
  kms_alias_name = var.kms_alias_name != "" ? var.kms_alias_name : "alias/${local.name}"

  tags = merge(
    var.tags,
    {
      Application = "arlo"
      Environment = var.environment
      GroupName   = var.group_name
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  )

  ssm_parameter_names = {
    database_url              = "${local.ssm_prefix}/database-url"
    zoom_client_id            = "${local.ssm_prefix}/zoom-client-id"
    zoom_client_secret        = "${local.ssm_prefix}/zoom-client-secret"
    zoom_webhook_secret_token = "${local.ssm_prefix}/zoom-webhook-secret-token"
    session_secret            = "${local.ssm_prefix}/session-secret"
    redis_encryption_key      = "${local.ssm_prefix}/redis-encryption-key"
    redis_url                 = "${local.ssm_prefix}/redis-url"
    redis_url_rtms_control    = "${local.ssm_prefix}/redis-url-rtms-control"
    redis_url_rtms_worker     = "${local.ssm_prefix}/redis-url-rtms-worker"
    openrouter_api_key        = "${local.ssm_prefix}/openrouter-api-key"
    internal_webhook_secret   = "${local.ssm_prefix}/internal-webhook-secret"
  }

  ssm_parameter_arns = {
    for key, name in local.ssm_parameter_names :
    key => "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${name}"
  }

  backend_url_internal      = "http://backend.${local.namespace_name}:${var.backend_container_port}"
  frontend_url_internal     = "http://frontend.${local.namespace_name}:${var.frontend_container_port}"
  rtms_control_url_internal = "http://rtms-control.${local.namespace_name}:${var.rtms_control_container_port}"
  private_subnet_required   = !var.rtms_worker_assign_public_ip || !var.app_services_assign_public_ip
  app_service_subnet_ids    = var.app_services_assign_public_ip ? aws_subnet.public[*].id : (var.use_scalable_rtms_worker_subnets ? aws_subnet.rtms_worker_scalable_private[*].id : aws_subnet.rtms_worker_private[*].id)
  backend_subnet_ids        = var.backend_single_subnet ? [local.app_service_subnet_ids[var.backend_subnet_index]] : local.app_service_subnet_ids
  frontend_subnet_ids       = var.frontend_single_subnet ? [local.app_service_subnet_ids[var.frontend_subnet_index]] : local.app_service_subnet_ids
  app_service_public_ip     = var.app_services_assign_public_ip
  rtms_worker_subnet_ids    = var.rtms_worker_assign_public_ip ? aws_subnet.public[*].id : (var.use_scalable_rtms_worker_subnets ? aws_subnet.rtms_worker_scalable_private[*].id : aws_subnet.rtms_worker_private[*].id)
  rtms_worker_public_ip     = var.rtms_worker_assign_public_ip ? "ENABLED" : "DISABLED"

  backend_environment = [
    { name = "PUBLIC_URL", value = local.public_url },
    { name = "FRONTEND_URL", value = local.public_url },
    { name = "FRONTEND_UPSTREAM_URL", value = local.frontend_url_internal },
    { name = "RTMS_SERVICE_URL", value = local.rtms_control_url_internal },
    { name = "ZOOM_APP_ID", value = var.zoom_app_id },
    { name = "RTMS_CLIENT_ID", value = var.rtms_client_id },
    { name = "ZOOM_HOST", value = var.zoom_host },
    { name = "DEFAULT_MODEL", value = var.default_model },
    { name = "FALLBACK_MODEL", value = var.fallback_model },
    { name = "FALLBACK_MODELS", value = join(",", var.fallback_models) },
    { name = "AI_ENABLED", value = tostring(var.ai_enabled) },
    { name = "EXTRACTION_ENABLED", value = "false" },
    { name = "PUBLIC_LINKS_ENABLED", value = "false" },
    { name = "DISABLE_MEETING_PERSISTENCE", value = "false" },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "NODE_ENV", value = "production" },
    { name = "TRUST_PROXY_HOPS", value = "2" },
    { name = "PORT", value = tostring(var.backend_container_port) },
    { name = "RTMS_PORT", value = tostring(var.rtms_control_container_port) },
    { name = "CORS_ORIGINS", value = local.public_url },
    { name = "REALTIME_ACTIVE_TTL_SECONDS", value = tostring(var.realtime_active_ttl_seconds) },
    { name = "REALTIME_COMPLETED_TTL_SECONDS", value = tostring(var.realtime_completed_ttl_seconds) },
    { name = "REALTIME_REPLAY_LIMIT", value = tostring(var.realtime_replay_limit) },
    { name = "REALTIME_KMS_KEY_ID", value = aws_kms_key.secrets.arn }
  ]

  backend_secrets = concat(
    [
      { name = "DATABASE_URL", valueFrom = local.ssm_parameter_arns.database_url },
      { name = "ZOOM_CLIENT_ID", valueFrom = local.ssm_parameter_arns.zoom_client_id },
      { name = "ZOOM_CLIENT_SECRET", valueFrom = local.ssm_parameter_arns.zoom_client_secret },
      { name = "ZOOM_WEBHOOK_SECRET_TOKEN", valueFrom = local.ssm_parameter_arns.zoom_webhook_secret_token },
      { name = "INTERNAL_WEBHOOK_SECRET", valueFrom = local.ssm_parameter_arns.internal_webhook_secret },
      { name = "SESSION_SECRET", valueFrom = local.ssm_parameter_arns.session_secret },
      { name = "REDIS_ENCRYPTION_KEY", valueFrom = local.ssm_parameter_arns.redis_encryption_key },
      { name = "REDIS_URL", valueFrom = local.ssm_parameter_arns.redis_url }
    ],
    var.ai_enabled ? [
      { name = "OPENROUTER_API_KEY", valueFrom = local.ssm_parameter_arns.openrouter_api_key }
    ] : []
  )

  frontend_environment = [
    { name = "REACT_APP_API_URL", value = local.public_url },
    { name = "REACT_APP_WS_URL", value = local.websocket_url },
    { name = "DANGEROUSLY_DISABLE_HOST_CHECK", value = "true" }
  ]

  rtms_control_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(var.rtms_control_container_port) },
    { name = "RTMS_PORT", value = tostring(var.rtms_control_container_port) },
    { name = "PUBLIC_URL", value = local.public_url },
    { name = "BACKEND_URL", value = local.backend_url_internal },
    { name = "OWNER", value = var.owner },
    { name = "GROUP_NAME", value = var.group_name },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "DYNAMODB_TABLE_NAME", value = aws_dynamodb_table.rtms_control.name },
    { name = "ECS_CLUSTER_ARN", value = aws_ecs_cluster.this.arn },
    { name = "ECS_CLUSTER_NAME", value = aws_ecs_cluster.this.name },
    { name = "RTMS_WORKER_TASK_DEFINITION_ARN", value = aws_ecs_task_definition.rtms_worker.arn },
    { name = "RTMS_WORKER_CONTAINER_NAME", value = var.rtms_worker_container_name },
    { name = "RTMS_WORKER_SUBNET_IDS", value = join(",", local.rtms_worker_subnet_ids) },
    { name = "RTMS_WORKER_SECURITY_GROUP_IDS", value = aws_security_group.rtms_worker.id },
    { name = "RTMS_WORKER_ASSIGN_PUBLIC_IP", value = local.rtms_worker_public_ip },
    { name = "RTMS_WEBHOOK_PATH", value = var.rtms_webhook_path },
    { name = "ZOOM_HOST", value = var.zoom_host },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "REALTIME_ACTIVE_TTL_SECONDS", value = tostring(var.realtime_active_ttl_seconds) },
    { name = "REALTIME_COMPLETED_TTL_SECONDS", value = tostring(var.realtime_completed_ttl_seconds) },
    { name = "REALTIME_REPLAY_LIMIT", value = tostring(var.realtime_replay_limit) }
  ]

  rtms_control_secrets = [
    { name = "ZOOM_CLIENT_ID", valueFrom = local.ssm_parameter_arns.zoom_client_id },
    { name = "ZOOM_CLIENT_SECRET", valueFrom = local.ssm_parameter_arns.zoom_client_secret },
    { name = "ZM_RTMS_CLIENT", valueFrom = local.ssm_parameter_arns.zoom_client_id },
    { name = "ZM_RTMS_SECRET", valueFrom = local.ssm_parameter_arns.zoom_client_secret },
    { name = "ZOOM_WEBHOOK_SECRET_TOKEN", valueFrom = local.ssm_parameter_arns.zoom_webhook_secret_token },
    { name = "INTERNAL_WEBHOOK_SECRET", valueFrom = local.ssm_parameter_arns.internal_webhook_secret },
    { name = "REDIS_URL", valueFrom = local.ssm_parameter_arns.redis_url_rtms_control }
  ]

  rtms_worker_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "OWNER", value = var.owner },
    { name = "DYNAMODB_TABLE_NAME", value = aws_dynamodb_table.rtms_control.name },
    { name = "BACKEND_URL", value = local.backend_url_internal },
    { name = "RTMS_WORKER_MODE", value = "single-stream" },
    { name = "RTMS_ENVELOPE_SOURCE", value = "dynamodb" },
    { name = "ZM_RTMS_LOG_LEVEL", value = var.log_level },
    { name = "REALTIME_ACTIVE_TTL_SECONDS", value = tostring(var.realtime_active_ttl_seconds) },
    { name = "REALTIME_COMPLETED_TTL_SECONDS", value = tostring(var.realtime_completed_ttl_seconds) },
    { name = "REALTIME_REPLAY_LIMIT", value = tostring(var.realtime_replay_limit) },
    { name = "REALTIME_KMS_KEY_ID", value = aws_kms_key.secrets.arn }
  ]

  rtms_worker_secrets = [
    { name = "ZOOM_CLIENT_ID", valueFrom = local.ssm_parameter_arns.zoom_client_id },
    { name = "ZOOM_CLIENT_SECRET", valueFrom = local.ssm_parameter_arns.zoom_client_secret },
    { name = "ZM_RTMS_CLIENT", valueFrom = local.ssm_parameter_arns.zoom_client_id },
    { name = "ZM_RTMS_SECRET", valueFrom = local.ssm_parameter_arns.zoom_client_secret },
    { name = "INTERNAL_WEBHOOK_SECRET", valueFrom = local.ssm_parameter_arns.internal_webhook_secret },
    { name = "REDIS_URL", valueFrom = local.ssm_parameter_arns.redis_url_rtms_worker }
  ]
}
