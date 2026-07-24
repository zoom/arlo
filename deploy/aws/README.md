# AWS First Cut

## Recommended Terraform Path

For the scalable RTMS direction, use `deploy/aws/terraform`. It deploys:

- ALB with native AWS FQDN and optional custom domain
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
- As of March 31, 2026, AWS App Runner is no longer open to new customers. This
  path is for existing App Runner customers.
- The template deploys `frontend` and `rtms` as separate App Runner services and
  points the backend at their generated service URLs.
- Private RTMS ingress, RDS VPC networking, and secret-manager wiring are a
  follow-up pass.

## CLI

The existing `deploy.sh` path is still available for AWS CLI users:

```bash
deploy/aws/deploy.sh deploy/common/arlo.deploy.env
```
