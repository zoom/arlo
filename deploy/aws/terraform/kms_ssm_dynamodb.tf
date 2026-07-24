resource "aws_kms_key" "secrets" {
  description             = "Arlo ${var.environment} secrets and control-store encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.tags, {
    Name = local.name
  })
}

resource "aws_kms_alias" "secrets" {
  name          = local.kms_alias_name
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_ssm_parameter" "managed_secret" {
  for_each = var.manage_secret_values ? toset([
    for key in keys(nonsensitive(var.secret_values)) : key
    if !(var.create_database && key == "database-url")
  ]) : toset([])

  name      = "${local.ssm_prefix}/${each.value}"
  type      = "SecureString"
  value     = var.secret_values[each.value]
  key_id    = aws_kms_key.secrets.arn
  overwrite = true

  tags = local.tags
}

resource "random_password" "db" {
  count = var.create_database ? 1 : 0

  length  = 32
  special = false
}

resource "aws_db_subnet_group" "database" {
  count = var.create_database ? 1 : 0

  name       = "${local.name}-database"
  subnet_ids = aws_subnet.database[*].id

  tags = merge(local.tags, {
    Name = "${local.name}-database"
  })
}

resource "aws_db_instance" "mysql" {
  count = var.create_database ? 1 : 0

  identifier                 = "${local.name}-mysql"
  engine                     = "mysql"
  engine_version             = var.db_engine_version
  instance_class             = var.db_instance_class
  allocated_storage          = var.db_allocated_storage
  storage_encrypted          = true
  kms_key_id                 = aws_kms_key.secrets.arn
  db_name                    = var.db_name
  username                   = var.db_username
  password                   = random_password.db[0].result
  port                       = var.db_port
  db_subnet_group_name       = aws_db_subnet_group.database[0].name
  vpc_security_group_ids     = [aws_security_group.database[0].id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = var.db_backup_retention_days
  deletion_protection        = var.db_deletion_protection
  skip_final_snapshot        = var.db_skip_final_snapshot
  auto_minor_version_upgrade = true
  apply_immediately          = true

  tags = merge(local.tags, {
    Name = "${local.name}-mysql"
  })
}

resource "aws_ssm_parameter" "database_url" {
  count = var.create_database ? 1 : 0

  name   = local.ssm_parameter_names.database_url
  type   = "SecureString"
  key_id = aws_kms_key.secrets.arn
  value  = "mysql://${var.db_username}:${random_password.db[0].result}@${aws_db_instance.mysql[0].address}:${aws_db_instance.mysql[0].port}/${var.db_name}?connection_limit=${var.db_connection_limit}"

  tags = local.tags
}

resource "aws_dynamodb_table" "rtms_control" {
  name         = "${local.name}-rtms-control"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_dynamodb_pitr
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.secrets.arn
  }

  tags = merge(local.tags, {
    Name = "${local.name}-rtms-control"
  })
}
