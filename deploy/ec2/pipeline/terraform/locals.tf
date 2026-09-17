data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id        = data.aws_caller_identity.current.account_id
  partition         = data.aws_partition.current.partition
  artifact_bucket   = "arlo-cicd-artifacts-${local.account_id}-${var.aws_region}"
  source_object_key = "source/arlo.zip"

  repository_arns = {
    for name, repository in var.ecr_repositories :
    name => "arn:${local.partition}:ecr:${var.aws_region}:${local.account_id}:repository/${repository}"
  }

  repository_uris = {
    for name, repository in var.ecr_repositories :
    name => "${local.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${repository}"
  }

  tags = {
    Application = "arlo"
    Environment = "prod"
    GroupName   = "arlo-assistant"
    ManagedBy   = "terraform"
    Owner       = "chunsiong.tan"
  }
}
