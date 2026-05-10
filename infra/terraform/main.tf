# =============================================================================
# OTT Chat - Terraform Infrastructure
# =============================================================================
# This is an EXAMPLE configuration for AWS infrastructure.
# It demonstrates basic Terraform concepts for the capstone project.
# 
# To use:
# 1. Configure AWS credentials
# 2. Run: terraform init
# 3. Run: terraform plan
# 4. Run: terraform apply
# =============================================================================

terraform {
  required_version = ">= 1.0.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# =============================================================================
# Provider Configuration
# =============================================================================

provider "aws" {
  region = var.aws_region
  
  default_tags {
    tags = {
      Project     = "OTT-Chat"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# =============================================================================
# Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t2.micro"
}

variable "db_username" {
  description = "Database admin username"
  type        = string
  default     = "ott_admin"
  sensitive   = true
}

variable "db_password" {
  description = "Database admin password"
  type        = string
  sensitive   = true
}

# =============================================================================
# VPC & Networking
# =============================================================================

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  
  tags = {
    Name = "ott-chat-vpc"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
  
  tags = {
    Name = "ott-chat-public-subnet"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  
  tags = {
    Name = "ott-chat-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  
  tags = {
    Name = "ott-chat-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# =============================================================================
# Security Groups
# =============================================================================

resource "aws_security_group" "app" {
  name        = "ott-chat-app-sg"
  description = "Security group for OTT Chat application"
  vpc_id      = aws_vpc.main.id
  
  # HTTP
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  # HTTPS
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  # SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # Restrict in production!
  }
  
  # API Gateway
  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  tags = {
    Name = "ott-chat-app-sg"
  }
}

# =============================================================================
# EC2 Instance
# =============================================================================

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]  # Canonical
  
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  
  user_data = <<-EOF
              #!/bin/bash
              apt-get update
              apt-get install -y docker.io docker-compose
              systemctl start docker
              systemctl enable docker
              
              # Clone and start application
              # git clone https://github.com/your-repo/chat-server-micro.git
              # cd chat-server-micro
              # docker-compose up -d
              EOF
  
  tags = {
    Name = "ott-chat-server"
  }
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  
  tags = {
    Name = "ott-chat-eip"
  }
}

# =============================================================================
# RDS PostgreSQL (Optional - for production)
# =============================================================================

# Uncomment for production database setup
# resource "aws_db_instance" "postgres" {
#   identifier           = "ott-chat-db"
#   engine               = "postgres"
#   engine_version       = "16"
#   instance_class       = "db.t3.micro"
#   allocated_storage    = 20
#   storage_type         = "gp2"
#   
#   db_name              = "ott_chat"
#   username             = var.db_username
#   password             = var.db_password
#   
#   vpc_security_group_ids = [aws_security_group.app.id]
#   
#   skip_final_snapshot  = true
#   publicly_accessible  = false
#   
#   tags = {
#     Name = "ott-chat-db"
#   }
# }

# =============================================================================
# S3 Bucket (for file uploads)
# =============================================================================

resource "aws_s3_bucket" "files" {
  bucket = "ott-chat-files-${var.environment}"
  
  tags = {
    Name = "ott-chat-files"
  }
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket = aws_s3_bucket.files.id
  
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# =============================================================================
# Outputs
# =============================================================================

output "instance_public_ip" {
  description = "Public IP of the EC2 instance"
  value       = aws_eip.app.public_ip
}

output "instance_public_dns" {
  description = "Public DNS of the EC2 instance"
  value       = aws_instance.app.public_dns
}

output "s3_bucket_name" {
  description = "Name of the S3 bucket for files"
  value       = aws_s3_bucket.files.bucket
}

output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}
