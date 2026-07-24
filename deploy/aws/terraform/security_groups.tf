data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ALB ingress"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-alb"
  })
}

resource "aws_security_group_rule" "alb_http_ingress" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  prefix_list_ids   = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
}

resource "aws_security_group_rule" "alb_egress" {
  type              = "egress"
  security_group_id = aws_security_group.alb.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
}

resource "aws_security_group" "backend" {
  name        = "${local.name}-backend"
  description = "Backend ECS service"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-backend"
  })
}

resource "aws_security_group" "frontend" {
  name        = "${local.name}-frontend"
  description = "Frontend ECS service"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-frontend"
  })
}

resource "aws_security_group" "rtms_control" {
  name        = "${local.name}-rtms-control"
  description = "Always-on RTMS webhook/control service"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-rtms-control"
  })
}

resource "aws_security_group" "rtms_worker" {
  name        = "${local.name}-rtms-worker"
  description = "Per-meeting RTMS compute jobs"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-rtms-worker"
  })
}

resource "aws_security_group" "database" {
  count = var.create_database ? 1 : 0

  name        = "${local.name}-database"
  description = "RDS MySQL database"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = "${local.name}-database"
  })
}

resource "aws_security_group_rule" "backend_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.backend.id
  from_port                = var.backend_container_port
  to_port                  = var.backend_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "backend_from_rtms_control" {
  type                     = "ingress"
  security_group_id        = aws_security_group.backend.id
  from_port                = var.backend_container_port
  to_port                  = var.backend_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.rtms_control.id
}

resource "aws_security_group_rule" "backend_from_rtms_worker" {
  type                     = "ingress"
  security_group_id        = aws_security_group.backend.id
  from_port                = var.backend_container_port
  to_port                  = var.backend_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.rtms_worker.id
}

resource "aws_security_group_rule" "frontend_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.frontend.id
  from_port                = var.frontend_container_port
  to_port                  = var.frontend_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "frontend_from_backend" {
  type                     = "ingress"
  security_group_id        = aws_security_group.frontend.id
  from_port                = var.frontend_container_port
  to_port                  = var.frontend_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.backend.id
}

resource "aws_security_group_rule" "rtms_control_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.rtms_control.id
  from_port                = var.rtms_control_container_port
  to_port                  = var.rtms_control_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "rtms_control_from_backend" {
  type                     = "ingress"
  security_group_id        = aws_security_group.rtms_control.id
  from_port                = var.rtms_control_container_port
  to_port                  = var.rtms_control_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.backend.id
}

resource "aws_security_group_rule" "database_from_backend" {
  count = var.create_database ? 1 : 0

  type                     = "ingress"
  security_group_id        = aws_security_group.database[0].id
  from_port                = var.db_port
  to_port                  = var.db_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.backend.id
}

resource "aws_security_group_rule" "backend_egress" {
  type              = "egress"
  security_group_id = aws_security_group.backend.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "frontend_egress" {
  type              = "egress"
  security_group_id = aws_security_group.frontend.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "rtms_control_egress" {
  type              = "egress"
  security_group_id = aws_security_group.rtms_control.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "rtms_worker_egress" {
  type              = "egress"
  security_group_id = aws_security_group.rtms_worker.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}
