resource "aws_ssm_document" "deploy" {
  name            = "${var.name_prefix}-deploy"
  document_type   = "Command"
  document_format = "YAML"
  target_type     = "/AWS::EC2::Instance"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Install an Arlo release with health checks and automatic rollback"
    parameters = {
      ArtifactBucket = { type = "String" }
      ArtifactKey    = { type = "String" }
      ArtifactSha256 = { type = "String", allowedPattern = "^[0-9a-f]{64}$" }
      SourceCommit   = { type = "String", allowedPattern = "^[0-9a-f]{40}$" }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deployArlo"
      inputs = {
        timeoutSeconds = "1200"
        runCommand     = [file("${path.module}/../scripts/deploy.sh")]
      }
    }]
  })
}

resource "aws_codepipeline" "release" {
  name           = "${var.name_prefix}-release"
  role_arn       = aws_iam_role.pipeline.arn
  pipeline_type  = "V2"
  execution_mode = "QUEUED"

  artifact_store {
    location = aws_s3_bucket.artifacts.id
    type     = "S3"
  }

  stage {
    name = "Source"
    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "S3"
      version          = "1"
      output_artifacts = ["source"]
      configuration = {
        S3Bucket             = aws_s3_bucket.artifacts.id
        S3ObjectKey          = local.source_object_key
        PollForSourceChanges = "false"
      }
    }
  }

  stage {
    name = "Build"
    action {
      name             = "BuildAndPublish"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["source"]
      output_artifacts = ["release"]
      configuration = {
        ProjectName = aws_codebuild_project.build.name
      }
    }
  }

  stage {
    name = "Deploy"
    action {
      name            = "DeployToEC2"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["release"]
      configuration = {
        ProjectName = aws_codebuild_project.deploy.name
      }
    }
  }
}

resource "aws_sqs_queue" "scheduler_dlq" {
  name                      = "${var.name_prefix}-scheduler-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_scheduler_schedule" "daily" {
  name                         = "${var.name_prefix}-daily"
  description                  = "Check Arlo ${var.github_branch} every day at 09:00 Singapore time"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_codebuild_project.checker.arn
    role_arn = aws_iam_role.scheduler.arn
    input = jsonencode({
      environmentVariablesOverride = [{
        name  = "DRY_RUN"
        type  = "PLAINTEXT"
        value = "false"
      }]
    })
    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 1
    }
  }
}
