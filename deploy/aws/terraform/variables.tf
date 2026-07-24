variable "aws_region" {
  description = "AWS region for the primary Arlo deployment."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Short name used as the prefix for AWS resources."
  type        = string
  default     = "arlo"
}

variable "environment" {
  description = "Environment name, such as prod, stage, or dev."
  type        = string
  default     = "prod"
}

variable "owner" {
  description = "Owner tag value applied to AWS resources."
  type        = string
  default     = "arlo-assistant"
}

variable "group_name" {
  description = "GroupName tag value applied to AWS resources."
  type        = string
  default     = "arlo-assistant"
}

variable "public_url" {
  description = "External URL users and Zoom will use, for example https://arlo.example.com. Leave empty to use the native ALB HTTP URL for bootstrap."
  type        = string
  default     = ""
}

variable "custom_domain_name" {
  description = "Experimental Route53 alias to the ALB; this does not configure a CloudFront custom domain and is not a supported public endpoint with the current origin-header listener rules."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Optional Route53 hosted zone ID for custom_domain_name."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "Optional regional ACM certificate ARN for the ALB listener. It does not configure a CloudFront viewer certificate or custom hostname."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones and public subnets to use."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "backend_image" {
  description = "Container image for the Arlo backend."
  type        = string
}

variable "frontend_image" {
  description = "Container image for the Arlo frontend."
  type        = string
}

variable "rtms_control_image" {
  description = "Container image for the always-on RTMS control service: webhook hub, dispatcher, spoke, and compute launcher."
  type        = string
}

variable "rtms_worker_image" {
  description = "Container image for per-meeting RTMS compute jobs."
  type        = string
}

variable "backend_container_port" {
  description = "Backend container port."
  type        = number
  default     = 3000
}

variable "frontend_container_port" {
  description = "Frontend container port."
  type        = number
  default     = 3000
}

variable "rtms_control_container_port" {
  description = "RTMS control service container port."
  type        = number
  default     = 3002
}

variable "backend_cpu" {
  description = "Backend ECS task CPU units."
  type        = string
  default     = "512"
}

variable "backend_memory" {
  description = "Backend ECS task memory in MiB."
  type        = string
  default     = "1024"
}

variable "frontend_cpu" {
  description = "Frontend ECS task CPU units."
  type        = string
  default     = "512"
}

variable "frontend_memory" {
  description = "Frontend ECS task memory in MiB."
  type        = string
  default     = "1024"
}

variable "rtms_control_cpu" {
  description = "RTMS control ECS task CPU units."
  type        = string
  default     = "512"
}

variable "rtms_control_memory" {
  description = "RTMS control ECS task memory in MiB."
  type        = string
  default     = "1024"
}

variable "rtms_worker_cpu" {
  description = "Per-meeting RTMS worker ECS task CPU units."
  type        = string
  default     = "1024"
}

variable "rtms_worker_memory" {
  description = "Per-meeting RTMS worker ECS task memory in MiB."
  type        = string
  default     = "2048"
}

variable "rtms_worker_assign_public_ip" {
  description = "Assign public IPs to per-meeting RTMS worker tasks. Keep false for production; workers use private subnets with NAT egress."
  type        = bool
  default     = false
}

variable "use_scalable_rtms_worker_subnets" {
  description = "Use dedicated larger private subnets for RTMS worker tasks. Required for high task counts; keep false only for the existing small deployment."
  type        = bool
  default     = false
}

variable "rtms_worker_private_subnet_cidrs" {
  description = "CIDR blocks for dedicated RTMS worker private subnets, one per availability zone."
  type        = list(string)
  default     = ["10.42.64.0/20", "10.42.80.0/20"]

  validation {
    condition     = length(var.rtms_worker_private_subnet_cidrs) >= 1 && length(var.rtms_worker_private_subnet_cidrs) <= var.az_count
    error_message = "rtms_worker_private_subnet_cidrs must contain at least one CIDR and no more than one per availability zone."
  }
}

variable "nat_gateway_per_az" {
  description = "Create one NAT gateway and private route table per availability zone for worker egress resilience."
  type        = bool
  default     = false
}

variable "app_services_assign_public_ip" {
  description = "Assign public IPs to always-on frontend, backend, and RTMS control ECS tasks. Keep false for production; CloudFront/ALB remain public and tasks run privately."
  type        = bool
  default     = false
}

variable "backend_desired_count" {
  description = "Always-on backend task count."
  type        = number
  default     = 1
}

variable "backend_single_subnet" {
  description = "Run backend ECS tasks in one app subnet so remote services can allow one source CIDR. This reduces backend AZ resilience."
  type        = bool
  default     = true
}

variable "backend_subnet_index" {
  description = "Zero-based app subnet index used when backend_single_subnet is true."
  type        = number
  default     = 0

  validation {
    condition     = var.backend_subnet_index >= 0 && var.backend_subnet_index < var.az_count
    error_message = "backend_subnet_index must identify one of the configured availability zones."
  }
}

variable "frontend_desired_count" {
  description = "Always-on frontend task count."
  type        = number
  default     = 1
}

variable "frontend_single_subnet" {
  description = "Run frontend ECS tasks in one app subnet. This reduces frontend AZ resilience."
  type        = bool
  default     = true
}

variable "frontend_subnet_index" {
  description = "Zero-based app subnet index used when frontend_single_subnet is true."
  type        = number
  default     = 1

  validation {
    condition     = var.frontend_subnet_index >= 0 && var.frontend_subnet_index < var.az_count
    error_message = "frontend_subnet_index must identify one of the configured availability zones."
  }
}

variable "rtms_control_desired_count" {
  description = "Always-on RTMS control task count. Keep at least 1 to avoid sleeping."
  type        = number
  default     = 1
}

variable "ssm_parameter_prefix" {
  description = "SSM Parameter Store prefix for Arlo secrets."
  type        = string
  default     = "/arlo/prod"
}

variable "kms_alias_name" {
  description = "KMS alias used to encrypt SSM SecureString parameters. Leave blank for alias/<name_prefix>-<environment>."
  type        = string
  default     = ""
}

variable "manage_secret_values" {
  description = "If true, Terraform creates SecureString parameters from secret_values. This stores secrets in Terraform state."
  type        = bool
  default     = false
}

variable "secret_values" {
  description = "Optional bootstrap-only SecureString values keyed by short parameter name, for example database-url."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "zoom_host" {
  description = "Zoom host. Use zoomgov.com for Zoom for Government."
  type        = string
  default     = "zoom.us"
}

variable "zoom_app_id" {
  description = "Optional Zoom app ID. This is not treated as a secret."
  type        = string
  default     = ""
}

variable "rtms_client_id" {
  description = "Optional RTMS app client ID for deployments that keep a separate RTMS client ID setting."
  type        = string
  default     = ""
}

variable "ai_enabled" {
  description = "Enable OpenRouter-backed AI features."
  type        = bool
  default     = false
}

variable "default_model" {
  description = "Default OpenRouter model."
  type        = string
  default     = "google/gemma-4-31b-it:free"
}

variable "fallback_model" {
  description = "Backward-compatible first fallback OpenRouter model."
  type        = string
  default     = "openai/gpt-oss-120b:free"
}

variable "fallback_models" {
  description = "Ordered fallback OpenRouter models."
  type        = list(string)
  default = [
    "openai/gpt-oss-120b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free"
  ]
}

variable "log_level" {
  description = "Application log level."
  type        = string
  default     = "info"
}

variable "rtms_webhook_path" {
  description = "Public Zoom RTMS webhook path routed to the RTMS control service."
  type        = string
  default     = "/api/rtms/webhook"
}

variable "rtms_worker_container_name" {
  description = "Container name inside the RTMS worker task definition."
  type        = string
  default     = "rtms-worker"
}

variable "enable_cloudwatch_logs" {
  description = "Enable ECS awslogs. Defaults false to avoid CloudWatch log spend."
  type        = bool
  default     = false
}

variable "cloudwatch_log_retention_days" {
  description = "Retention for optional ECS CloudWatch log groups."
  type        = number
  default     = 1
}

variable "enable_dynamodb_pitr" {
  description = "Enable DynamoDB point-in-time recovery for the RTMS control table."
  type        = bool
  default     = false
}

variable "enable_valkey" {
  description = "Create an ElastiCache Serverless Valkey cache for realtime WebSocket fanout."
  type        = bool
  default     = true
}

variable "valkey_data_storage_max_gb" {
  description = "Maximum Valkey Serverless data storage in GB."
  type        = number
  default     = 1
}

variable "valkey_ecpu_per_second_max" {
  description = "Maximum Valkey Serverless ECPU per second."
  type        = number
  default     = 1000
}

variable "realtime_active_ttl_seconds" {
  description = "Valkey TTL for active realtime meeting session data."
  type        = number
  default     = 86400
}

variable "realtime_completed_ttl_seconds" {
  description = "Valkey TTL for completed realtime meeting session data."
  type        = number
  default     = 3600
}

variable "realtime_replay_limit" {
  description = "Maximum recent realtime events retained per meeting session for reconnect replay."
  type        = number
  default     = 250
}

variable "create_database" {
  description = "Create an encrypted private AWS RDS MySQL database and write its connection string to SSM as DATABASE_URL."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Initial MySQL database name for Arlo."
  type        = string
  default     = "meeting_assistant"
}

variable "db_username" {
  description = "MySQL master username."
  type        = string
  default     = "arlo"
}

variable "db_engine_version" {
  description = "RDS MySQL engine version. Pin this to a patch version supported in the target region."
  type        = string
  default     = "8.0.46"
}

variable "db_port" {
  description = "RDS MySQL port."
  type        = number
  default     = 3306
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GiB."
  type        = number
  default     = 20
}

variable "db_backup_retention_days" {
  description = "RDS automated backup retention in days."
  type        = number
  default     = 1
}

variable "db_deletion_protection" {
  description = "Enable deletion protection for the RDS database."
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "Skip final snapshot when destroying the RDS database."
  type        = bool
  default     = true
}

variable "db_connection_limit" {
  description = "Prisma connection_limit appended to DATABASE_URL."
  type        = number
  default     = 5
}

variable "tags" {
  description = "Additional tags to apply to resources."
  type        = map(string)
  default     = {}
}
