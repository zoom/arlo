resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, {
    Name = local.name
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, {
    Name = local.name
  })
}

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name = count.index == var.backend_subnet_index ? "${local.name}-backend-${count.index + 1}" : count.index == var.frontend_subnet_index ? "${local.name}-frontend-${count.index + 1}" : "${local.name}-public-${count.index + 1}"
    Role = count.index == var.backend_subnet_index ? "backend" : count.index == var.frontend_subnet_index ? "frontend" : "shared-app"
    Tier = "public"
  })
}

resource "aws_subnet" "rtms_worker_private" {
  count = local.private_subnet_required && !var.use_scalable_rtms_worker_subnets ? var.az_count : 0

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 50)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name = "${local.name}-private-${count.index + 1}"
    Tier = "private"
  })
}

resource "aws_subnet" "rtms_worker_scalable_private" {
  count = local.private_subnet_required && var.use_scalable_rtms_worker_subnets && !var.rtms_worker_assign_public_ip ? length(var.rtms_worker_private_subnet_cidrs) : 0

  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.rtms_worker_private_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name    = "${local.name}-rtms-worker-scalable-private-${count.index + 1}"
    Tier    = "private"
    Purpose = "rtms-worker-scalable"
  })
}

resource "aws_subnet" "database" {
  count = var.create_database ? var.az_count : 0

  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 100)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(local.tags, {
    Name = "${local.name}-database-${count.index + 1}"
    Tier = "database"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.tags, {
    Name = "${local.name}-public"
  })
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "rtms_worker_nat" {
  count = local.private_subnet_required ? (var.nat_gateway_per_az ? var.az_count : 1) : 0

  domain = "vpc"

  depends_on = [aws_internet_gateway.this]

  tags = merge(local.tags, {
    Name = "${local.name}-private-nat"
  })
}

resource "aws_nat_gateway" "rtms_worker" {
  count = local.private_subnet_required ? (var.nat_gateway_per_az ? var.az_count : 1) : 0

  allocation_id = aws_eip.rtms_worker_nat[var.nat_gateway_per_az ? count.index : 0].id
  subnet_id     = aws_subnet.public[var.nat_gateway_per_az ? count.index : 0].id

  tags = merge(local.tags, {
    Name = "${local.name}-private"
  })
}

resource "aws_route_table" "rtms_worker_private" {
  count = local.private_subnet_required ? (var.nat_gateway_per_az ? var.az_count : 1) : 0

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.rtms_worker[var.nat_gateway_per_az ? count.index : 0].id
  }

  tags = merge(local.tags, {
    Name = "${local.name}-private"
  })
}

resource "aws_route_table_association" "rtms_worker_private" {
  count = length(aws_subnet.rtms_worker_private)

  subnet_id      = aws_subnet.rtms_worker_private[count.index].id
  route_table_id = aws_route_table.rtms_worker_private[var.nat_gateway_per_az ? count.index : 0].id
}

resource "aws_route_table_association" "rtms_worker_scalable_private" {
  count = length(aws_subnet.rtms_worker_scalable_private)

  subnet_id      = aws_subnet.rtms_worker_scalable_private[count.index].id
  route_table_id = aws_route_table.rtms_worker_private[var.nat_gateway_per_az ? count.index : 0].id
}
