resource "aws_codebuild_project" "checker" {
  name          = "${var.name_prefix}-checker"
  description   = "Checks the public Arlo branch for a new commit"
  service_role  = aws_iam_role.checker.arn
  build_timeout = 15

  source {
    type      = "NO_SOURCE"
    buildspec = file("${path.module}/../templates/checker-buildspec.yml")
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    type                        = "LINUX_CONTAINER"
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "GITHUB_REPOSITORY_URL"
      value = var.github_repository_url
    }
    environment_variable {
      name  = "GITHUB_BRANCH"
      value = var.github_branch
    }
    environment_variable {
      name  = "DEPLOYED_COMMIT_PARAMETER"
      value = var.deployed_commit_parameter
    }
    environment_variable {
      name  = "PIPELINE_NAME"
      value = aws_codepipeline.release.name
    }
    environment_variable {
      name  = "ARTIFACT_BUCKET"
      value = aws_s3_bucket.artifacts.id
    }
    environment_variable {
      name  = "SOURCE_OBJECT_KEY"
      value = local.source_object_key
    }
    environment_variable {
      name  = "DRY_RUN"
      value = "false"
    }
  }

  logs_config {
    cloudwatch_logs {
      status = "DISABLED"
    }
    s3_logs {
      status              = "ENABLED"
      location            = "${aws_s3_bucket.artifacts.id}/logs/checker"
      encryption_disabled = false
    }
  }
}

resource "aws_codebuild_project" "build" {
  name          = "${var.name_prefix}-build"
  description   = "Tests Arlo and publishes immutable container images"
  service_role  = aws_iam_role.build.arn
  build_timeout = 60

  source {
    type      = "CODEPIPELINE"
    buildspec = "deploy/ec2/pipeline/buildspec-build.yml"
  }

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    type                        = "LINUX_CONTAINER"
    compute_type                = "BUILD_GENERAL1_MEDIUM"
    image                       = "aws/codebuild/standard:7.0"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true

    environment_variable {
      name  = "ECR_REGISTRY"
      value = "${local.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
    }
    environment_variable {
      name  = "FRONTEND_REPOSITORY_URI"
      value = local.repository_uris.frontend
    }
    environment_variable {
      name  = "BACKEND_REPOSITORY_URI"
      value = local.repository_uris.backend
    }
    environment_variable {
      name  = "RTMS_REPOSITORY_URI"
      value = local.repository_uris.rtms
    }
    environment_variable {
      name  = "ARTIFACT_BUCKET"
      value = aws_s3_bucket.artifacts.id
    }
    environment_variable {
      name  = "PARAMETER_PREFIX"
      value = var.parameter_prefix
    }
    environment_variable {
      name  = "PUBLIC_URL"
      value = var.public_url
    }
    environment_variable {
      name  = "OPENROUTER_MODELS"
      value = var.openrouter_models
    }
    environment_variable {
      name  = "DEFAULT_MODEL"
      value = var.default_model
    }
    environment_variable {
      name  = "FALLBACK_MODEL"
      value = var.fallback_model
    }
  }

  logs_config {
    cloudwatch_logs {
      status = "DISABLED"
    }
    s3_logs {
      status              = "ENABLED"
      location            = "${aws_s3_bucket.artifacts.id}/logs/build"
      encryption_disabled = false
    }
  }
}

resource "aws_codebuild_project" "deploy" {
  name          = "${var.name_prefix}-deploy"
  description   = "Deploys an Arlo release to EC2 through Systems Manager"
  service_role  = aws_iam_role.deploy.arn
  build_timeout = 30

  source {
    type      = "CODEPIPELINE"
    buildspec = file("${path.module}/../templates/deploy-buildspec.yml")
  }

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    type                        = "LINUX_CONTAINER"
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "DEPLOY_DOCUMENT_NAME"
      value = aws_ssm_document.deploy.name
    }
    environment_variable {
      name  = "INSTANCE_ID"
      value = var.instance_id
    }
    environment_variable {
      name  = "DEPLOYED_COMMIT_PARAMETER"
      value = var.deployed_commit_parameter
    }
    environment_variable {
      name  = "GITHUB_BRANCH"
      value = var.github_branch
    }
  }

  logs_config {
    cloudwatch_logs {
      status = "DISABLED"
    }
    s3_logs {
      status              = "ENABLED"
      location            = "${aws_s3_bucket.artifacts.id}/logs/deploy"
      encryption_disabled = false
    }
  }
}
