resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.tags
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = local.namespace_name
  vpc  = aws_vpc.this.id
  tags = local.tags
}

resource "aws_service_discovery_service" "backend" {
  name = "backend"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = local.tags
}

resource "aws_service_discovery_service" "frontend" {
  name = "frontend"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = local.tags
}

resource "aws_service_discovery_service" "rtms_control" {
  name = "rtms-control"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "backend" {
  count = var.enable_cloudwatch_logs ? 1 : 0

  name              = "/ecs/${local.name}/backend"
  retention_in_days = var.cloudwatch_log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "frontend" {
  count = var.enable_cloudwatch_logs ? 1 : 0

  name              = "/ecs/${local.name}/frontend"
  retention_in_days = var.cloudwatch_log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "rtms_control" {
  count = var.enable_cloudwatch_logs ? 1 : 0

  name              = "/ecs/${local.name}/rtms-control"
  retention_in_days = var.cloudwatch_log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "rtms_worker" {
  count = var.enable_cloudwatch_logs ? 1 : 0

  name              = "/ecs/${local.name}/rtms-worker"
  retention_in_days = var.cloudwatch_log_retention_days
  tags              = local.tags
}

locals {
  backend_log_configuration = var.enable_cloudwatch_logs ? {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.backend[0].name
      "awslogs-region"        = var.aws_region
      "awslogs-stream-prefix" = "backend"
    }
  } : null

  frontend_log_configuration = var.enable_cloudwatch_logs ? {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.frontend[0].name
      "awslogs-region"        = var.aws_region
      "awslogs-stream-prefix" = "frontend"
    }
  } : null

  rtms_control_log_configuration = var.enable_cloudwatch_logs ? {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.rtms_control[0].name
      "awslogs-region"        = var.aws_region
      "awslogs-stream-prefix" = "rtms-control"
    }
  } : null

  rtms_worker_log_configuration = var.enable_cloudwatch_logs ? {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.rtms_worker[0].name
      "awslogs-region"        = var.aws_region
      "awslogs-stream-prefix" = "rtms-worker"
    }
  } : null
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = "backend"
        image       = var.backend_image
        essential   = true
        command     = ["sh", "-lc", "npx prisma db push && npm start"]
        environment = local.backend_environment
        secrets     = local.backend_secrets
        portMappings = [
          {
            containerPort = var.backend_container_port
            hostPort      = var.backend_container_port
            protocol      = "tcp"
          }
        ]
      },
      var.enable_cloudwatch_logs ? { logConfiguration = local.backend_log_configuration } : {}
    )
  ])

  depends_on = [
    aws_iam_role_policy.ecs_task_execution_secrets,
    aws_iam_role_policy_attachment.ecs_task_execution_managed,
    aws_ssm_parameter.database_url,
    aws_ssm_parameter.redis_url,
    aws_ssm_parameter.managed_secret
  ]

  tags = local.tags
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${local.name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.frontend_cpu
  memory                   = var.frontend_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = "frontend"
        image       = var.frontend_image
        essential   = true
        environment = local.frontend_environment
        portMappings = [
          {
            containerPort = var.frontend_container_port
            hostPort      = var.frontend_container_port
            protocol      = "tcp"
          }
        ]
      },
      var.enable_cloudwatch_logs ? { logConfiguration = local.frontend_log_configuration } : {}
    )
  ])

  depends_on = [
    aws_iam_role_policy.ecs_task_execution_secrets,
    aws_iam_role_policy_attachment.ecs_task_execution_managed,
    aws_ssm_parameter.managed_secret
  ]

  tags = local.tags
}

resource "aws_ecs_task_definition" "rtms_worker" {
  family                   = "${local.name}-rtms-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.rtms_worker_cpu
  memory                   = var.rtms_worker_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.rtms_worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = var.rtms_worker_container_name
        image       = var.rtms_worker_image
        essential   = true
        environment = local.rtms_worker_environment
        secrets     = local.rtms_worker_secrets
      },
      var.enable_cloudwatch_logs ? { logConfiguration = local.rtms_worker_log_configuration } : {}
    )
  ])

  depends_on = [
    aws_iam_role_policy.ecs_task_execution_secrets,
    aws_iam_role_policy_attachment.ecs_task_execution_managed,
    aws_iam_role_policy.rtms_worker_task,
    aws_elasticache_user_group.valkey,
    aws_ssm_parameter.redis_url_rtms_worker,
    aws_ssm_parameter.managed_secret
  ]

  tags = local.tags
}

resource "aws_ecs_task_definition" "rtms_control" {
  family                   = "${local.name}-rtms-control"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.rtms_control_cpu
  memory                   = var.rtms_control_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.rtms_control_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = "rtms-control"
        image       = var.rtms_control_image
        essential   = true
        environment = local.rtms_control_environment
        secrets     = local.rtms_control_secrets
        portMappings = [
          {
            containerPort = var.rtms_control_container_port
            hostPort      = var.rtms_control_container_port
            protocol      = "tcp"
          }
        ]
      },
      var.enable_cloudwatch_logs ? { logConfiguration = local.rtms_control_log_configuration } : {}
    )
  ])

  depends_on = [
    aws_iam_role_policy.ecs_task_execution_secrets,
    aws_iam_role_policy_attachment.ecs_task_execution_managed,
    aws_iam_role_policy.rtms_control_task,
    aws_elasticache_user_group.valkey,
    aws_ssm_parameter.redis_url_rtms_control,
    aws_ssm_parameter.managed_secret
  ]

  tags = local.tags
}

resource "aws_ecs_service" "backend" {
  name            = "backend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.backend_desired_count
  launch_type     = "FARGATE"

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 60

  network_configuration {
    subnets          = local.backend_subnet_ids
    security_groups  = [aws_security_group.backend.id]
    assign_public_ip = local.app_service_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = var.backend_container_port
  }

  service_registries {
    registry_arn = aws_service_discovery_service.backend.arn
  }

  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.https,
    aws_lb_listener_rule.backend_api,
    aws_lb_listener_rule.backend_ws,
    aws_lb_listener_rule.backend_health
  ]

  tags = local.tags
}

resource "aws_ecs_service" "frontend" {
  name            = "frontend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.frontend_desired_count
  launch_type     = "FARGATE"

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 60

  network_configuration {
    subnets          = local.frontend_subnet_ids
    security_groups  = [aws_security_group.frontend.id]
    assign_public_ip = local.app_service_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = var.frontend_container_port
  }

  service_registries {
    registry_arn = aws_service_discovery_service.frontend.arn
  }

  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.https
  ]

  tags = local.tags
}

resource "aws_ecs_service" "rtms_control" {
  name            = "rtms-control"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.rtms_control.arn
  desired_count   = var.rtms_control_desired_count
  launch_type     = "FARGATE"

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  network_configuration {
    subnets          = local.app_service_subnet_ids
    security_groups  = [aws_security_group.rtms_control.id]
    assign_public_ip = local.app_service_public_ip
  }

  service_registries {
    registry_arn = aws_service_discovery_service.rtms_control.arn
  }

  tags = local.tags
}
