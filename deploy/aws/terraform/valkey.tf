resource "random_password" "valkey" {
  count = var.enable_valkey ? 1 : 0

  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "valkey_rtms_control" {
  count = var.enable_valkey ? 1 : 0

  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "valkey_rtms_worker" {
  count = var.enable_valkey ? 1 : 0

  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

locals {
  valkey_realtime_access_string = "on ~arlo:realtime:* resetchannels &arlo:realtime:* -@all +@connection +@read +@write +@pubsub -@dangerous"
}

resource "aws_security_group" "valkey" {
  count = var.enable_valkey ? 1 : 0

  name        = "${local.name}-valkey"
  description = "Valkey realtime fanout cache"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-valkey"
  })
}

resource "aws_security_group_rule" "valkey_from_backend" {
  count = var.enable_valkey ? 1 : 0

  type                     = "ingress"
  security_group_id        = aws_security_group.valkey[0].id
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.backend.id
}

resource "aws_security_group_rule" "valkey_from_rtms_control" {
  count = var.enable_valkey ? 1 : 0

  type                     = "ingress"
  security_group_id        = aws_security_group.valkey[0].id
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.rtms_control.id
}

resource "aws_security_group_rule" "valkey_from_rtms_worker" {
  count = var.enable_valkey ? 1 : 0

  type                     = "ingress"
  security_group_id        = aws_security_group.valkey[0].id
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.rtms_worker.id
}

resource "aws_security_group_rule" "valkey_egress" {
  count = var.enable_valkey ? 1 : 0

  type              = "egress"
  security_group_id = aws_security_group.valkey[0].id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_elasticache_user" "valkey_default" {
  count = var.enable_valkey ? 1 : 0

  user_id       = "${local.name}-default"
  user_name     = "default"
  engine        = "VALKEY"
  access_string = "off ~* &* -@all"

  authentication_mode {
    type      = "password"
    passwords = [random_password.valkey[0].result]
  }

  tags = local.tags
}

resource "aws_elasticache_user" "valkey_backend" {
  count = var.enable_valkey ? 1 : 0

  user_id       = "${local.name}-backend"
  user_name     = "backend"
  engine        = "VALKEY"
  access_string = local.valkey_realtime_access_string

  authentication_mode {
    type      = "password"
    passwords = [random_password.valkey[0].result]
  }

  tags = local.tags
}

resource "aws_elasticache_user" "valkey_rtms_control" {
  count = var.enable_valkey ? 1 : 0

  user_id       = "${local.name}-rtms-control"
  user_name     = "rtms-control"
  engine        = "VALKEY"
  access_string = local.valkey_realtime_access_string

  authentication_mode {
    type      = "password"
    passwords = [random_password.valkey_rtms_control[0].result]
  }

  tags = local.tags
}

resource "aws_elasticache_user" "valkey_rtms_worker" {
  count = var.enable_valkey ? 1 : 0

  user_id       = "${local.name}-rtms-worker"
  user_name     = "rtms-worker"
  engine        = "VALKEY"
  access_string = local.valkey_realtime_access_string

  authentication_mode {
    type      = "password"
    passwords = [random_password.valkey_rtms_worker[0].result]
  }

  tags = local.tags
}

resource "aws_elasticache_user_group" "valkey" {
  count = var.enable_valkey ? 1 : 0

  engine        = "VALKEY"
  user_group_id = "${local.name}-valkey"
  user_ids = [
    aws_elasticache_user.valkey_default[0].user_id,
    aws_elasticache_user.valkey_backend[0].user_id,
    aws_elasticache_user.valkey_rtms_control[0].user_id,
    aws_elasticache_user.valkey_rtms_worker[0].user_id
  ]

  tags = local.tags
}

resource "aws_elasticache_serverless_cache" "valkey" {
  count = var.enable_valkey ? 1 : 0

  name                 = "${local.name}-valkey"
  engine               = "valkey"
  major_engine_version = "8"
  description          = "Arlo realtime WebSocket fanout and reconnect replay"
  kms_key_id           = aws_kms_key.secrets.arn
  security_group_ids   = [aws_security_group.valkey[0].id]
  subnet_ids           = aws_subnet.public[*].id
  user_group_id        = aws_elasticache_user_group.valkey[0].user_group_id

  cache_usage_limits {
    data_storage {
      maximum = var.valkey_data_storage_max_gb
      unit    = "GB"
    }

    ecpu_per_second {
      maximum = var.valkey_ecpu_per_second_max
    }
  }

  tags = merge(local.tags, {
    Name = "${local.name}-valkey"
  })
}

resource "aws_ssm_parameter" "redis_url" {
  count = var.enable_valkey ? 1 : 0

  name   = local.ssm_parameter_names.redis_url
  type   = "SecureString"
  key_id = aws_kms_key.secrets.arn
  value  = "rediss://backend:${urlencode(random_password.valkey[0].result)}@${aws_elasticache_serverless_cache.valkey[0].endpoint[0].address}:${aws_elasticache_serverless_cache.valkey[0].endpoint[0].port}"

  tags = local.tags
}

resource "aws_ssm_parameter" "redis_url_rtms_control" {
  count = var.enable_valkey ? 1 : 0

  name   = local.ssm_parameter_names.redis_url_rtms_control
  type   = "SecureString"
  key_id = aws_kms_key.secrets.arn
  value  = "rediss://rtms-control:${urlencode(random_password.valkey_rtms_control[0].result)}@${aws_elasticache_serverless_cache.valkey[0].endpoint[0].address}:${aws_elasticache_serverless_cache.valkey[0].endpoint[0].port}"

  tags = local.tags
}

resource "aws_ssm_parameter" "redis_url_rtms_worker" {
  count = var.enable_valkey ? 1 : 0

  name   = local.ssm_parameter_names.redis_url_rtms_worker
  type   = "SecureString"
  key_id = aws_kms_key.secrets.arn
  value  = "rediss://rtms-worker:${urlencode(random_password.valkey_rtms_worker[0].result)}@${aws_elasticache_serverless_cache.valkey[0].endpoint[0].address}:${aws_elasticache_serverless_cache.valkey[0].endpoint[0].port}"

  tags = local.tags
}
