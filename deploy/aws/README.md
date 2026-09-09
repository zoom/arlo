# AWS First Cut

## Recommended Terraform Path

For the scalable RTMS direction, use `deploy/aws/terraform`. It deploys:

- CloudFront with a native AWS HTTPS hostname and a public ALB origin
- always-on ECS/Fargate `frontend`, `backend`, and `rtms-control`
- DynamoDB On-Demand control store
- KMS key plus SSM Parameter Store `SecureString` secret references
- per-meeting RTMS worker ECS task definition launched with `RunTask`

This avoids Lambda cold starts on the webhook path. See
`deploy/aws/terraform/README.md`.

## Legacy App Runner / CloudFormation Draft

CloudFormation quick-create requires the template to be hosted at an AWS-reachable
template URL, normally S3. After uploading `cloudformation.yml` to S3, use a
button like:

```markdown
[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=https://YOUR_BUCKET.s3.amazonaws.com/arlo/cloudformation.yml&stackName=arlo)
```

Target runtime:

- AWS App Runner for `backend`, `frontend`, and `rtms`
- Existing MySQL 8.0 via `DATABASE_URL`

Notes:

- `cloudformation.yml` is the one-click CloudFormation template.
- This first cut assumes your container images already exist in ECR or ECR
  Public.
- Treat this as a legacy scaffold and verify App Runner availability for the
  target AWS account. Use Terraform for the current ECS/Fargate architecture.
- The template deploys `frontend` and `rtms` as separate App Runner services and
  points the backend at their generated service URLs.
- Private RTMS ingress, per-stream worker orchestration, RDS VPC networking, and
  KMS/SSM secret wiring are not implemented in this path.

## Current Custom-Domain Limitation

The current Terraform stack uses the CloudFront default hostname for the
production viewer URL. `custom_domain_name` creates a Route 53 alias directly
to the ALB; it does not configure a CloudFront alias or a CloudFront ACM
certificate. Because the ALB listener accepts the CloudFront origin header,
that direct alias is not a working public endpoint in the current template.
Leave `custom_domain_name`, `route53_zone_id`, and `certificate_arn` empty unless
you are deliberately testing the ALB path and have added the required Terraform
changes. A production custom domain needs a CloudFront alias, an ACM
certificate in `us-east-1`, and corresponding Terraform support.

## CLI

The existing `deploy.sh` path is still available for AWS CLI users:

```bash
deploy/aws/deploy.sh deploy/common/arlo.deploy.env
```
