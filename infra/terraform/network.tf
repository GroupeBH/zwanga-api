data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = local.selected_az
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-a"
  }
}

resource "aws_subnet" "public_secondary" {
  count = var.secondary_instance_enabled ? 1 : 0

  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.secondary_public_subnet_cidr
  availability_zone       = local.secondary_selected_az
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-b"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_secondary" {
  count = var.secondary_instance_enabled ? 1 : 0

  subnet_id      = aws_subnet.public_secondary[0].id
  route_table_id = aws_route_table.public.id
}
