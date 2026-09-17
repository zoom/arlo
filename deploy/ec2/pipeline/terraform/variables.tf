variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "889455048101_devreldemos_admin_role"
}

variable "name_prefix" {
  type    = string
  default = "arlo-ec2-cicd"
}

variable "github_repository_url" {
  type    = string
  default = "https://github.com/zoom/arlo.git"
}

variable "github_branch" {
  type    = string
  default = "ec2-main-deployment"
}

variable "instance_id" {
  type    = string
  default = "i-0d276806aa64690e9"
}

variable "ec2_role_name" {
  type    = string
  default = "arlo-main-ec2-role"
}

variable "public_url" {
  type    = string
  default = "https://d3k9b5xygup21i.cloudfront.net"
}

variable "parameter_prefix" {
  type    = string
  default = "/arlo/prod"
}

variable "deployed_commit_parameter" {
  type    = string
  default = "/arlo/cicd/deployed-commit"
}

variable "initial_deployed_commit" {
  type        = string
  description = "Full commit SHA currently deployed before the pipeline takes ownership."
  default     = "780efb75b98bd3f3564f20f6242ddaffe957094e"
}

variable "ecr_repositories" {
  type = map(string)
  default = {
    frontend = "arlo-frontend"
    backend  = "arlo-backend"
    rtms     = "arlo-rtms"
  }
}

variable "schedule_expression" {
  type    = string
  default = "cron(0 9 * * ? *)"
}

variable "schedule_timezone" {
  type    = string
  default = "Asia/Singapore"
}

variable "openrouter_models" {
  type    = string
  default = "nex-agi/nex-n2.5-mini:free,nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free,thinkingmachines/inkling:free,poolside/laguna-s-2.1:free,liquid/lfm-2.5-2.6b:free"
}

variable "default_model" {
  type    = string
  default = "nex-agi/nex-n2.5-mini:free"
}

variable "fallback_model" {
  type    = string
  default = "nvidia/nemotron-3.5-lightning:free"
}
