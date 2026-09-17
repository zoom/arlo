output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.id
}

output "checker_project" {
  value = aws_codebuild_project.checker.name
}

output "pipeline_name" {
  value = aws_codepipeline.release.name
}

output "schedule" {
  value = "${var.schedule_expression} (${var.schedule_timezone})"
}

output "manual_check_command" {
  value = "aws codebuild start-build --region ${var.aws_region} --profile ${var.aws_profile} --project-name ${aws_codebuild_project.checker.name}"
}
