output "alb_dns_name" {
  description = "Native AWS FQDN for the public Application Load Balancer."
  value       = aws_lb.app.dns_name
}

output "cloudfront_domain_name" {
  description = "AWS-managed HTTPS FQDN for the CloudFront distribution."
  value       = aws_cloudfront_distribution.app.domain_name
}

output "app_url" {
  description = "Configured public app URL."
  value       = local.public_url
}

output "zoom_oauth_callback_url" {
  description = "Zoom OAuth callback URL."
  value       = "${local.public_url}/api/auth/callback"
}

output "zoom_rtms_webhook_url" {
  description = "Zoom RTMS webhook URL routed to the backend, then forwarded internally to RTMS."
  value       = "${local.public_url}/api/rtms/webhook"
}

output "dynamodb_control_table_name" {
  description = "DynamoDB control table for stream routing, idempotency, and leases."
  value       = aws_dynamodb_table.rtms_control.name
}

output "valkey_endpoint" {
  description = "ElastiCache Serverless Valkey endpoint for realtime fanout."
  value       = var.enable_valkey ? aws_elasticache_serverless_cache.valkey[0].endpoint[0].address : null
}

output "database_endpoint" {
  description = "RDS MySQL endpoint when create_database is true."
  value       = var.create_database ? aws_db_instance.mysql[0].address : null
}

output "database_url_parameter_name" {
  description = "SSM SecureString parameter containing DATABASE_URL."
  value       = local.ssm_parameter_names.database_url
}

output "kms_key_arn" {
  description = "KMS key used for SSM SecureString and DynamoDB encryption."
  value       = aws_kms_key.secrets.arn
}

output "kms_alias_name" {
  description = "KMS alias for secret writes."
  value       = aws_kms_alias.secrets.name
}

output "ssm_parameter_prefix" {
  description = "SSM prefix where Arlo secrets are read from."
  value       = local.ssm_prefix
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "rtms_worker_task_definition_arn" {
  description = "Task definition launched once per RTMS stream."
  value       = aws_ecs_task_definition.rtms_worker.arn
}

output "secret_parameter_names" {
  description = "Expected SSM SecureString parameter names."
  value       = local.ssm_parameter_names
}
