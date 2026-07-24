# AWS Terraform: Scalable RTMS First Cut

This template is the AWS-first deployment shape for scaling Arlo RTMS:

- Public CloudFront distribution and public ALB with native AWS FQDN and optional Route53 custom domain.
- Always-on ECS/Fargate services for `frontend`, `backend`, and `rtms-control` in private subnets by default.
- `rtms-control` is where the webhook hub, dispatcher, webhook spoke, and compute launcher should run.
- Per-meeting RTMS compute jobs run as ECS/Fargate `RunTask` tasks from `rtms_worker_image`.
- Optional encrypted private AWS RDS MySQL 8.0 database with `DATABASE_URL` written to SSM.
- DynamoDB On-Demand is the control store for idempotency, routing, leases, task ARNs, and stop handling.
- KMS encrypts the DynamoDB table and SSM `SecureString` secrets.
- CloudWatch logs are disabled by default to avoid log spend.

## Network Hardening

### Admin-Provisioned VPCs

This module currently creates its own VPC and subnets. Do not apply it against
the existing production VPC without first importing the existing resources into
the same Terraform state, or it will propose a second VPC and duplicate
networking resources. If an administrator creates the VPC separately, keep the
VPC CIDR non-overlapping with any connected VPC and either import the VPC,
subnets, route tables, gateways, and security groups into this state or add an
explicit external-VPC adapter before applying. A separate VPC will not provide
connectivity automatically; it requires VPC peering or Transit Gateway routes,
security-group/NACL rules, and deliberate DNS configuration.

The recommended boundary is one shared VPC for Arlo's ALB, ECS services, RTMS
workers, RDS, and Valkey, with private subnets for compute and data services.

The backend can be pinned to one app subnet with
`backend_single_subnet = true` when an external database requires one source
CIDR. This is a connectivity simplification, not a security requirement, and
reduces backend Availability Zone resilience. Frontend can similarly be pinned
to the other app subnet with `frontend_single_subnet = true`. RTMS control
remains multi-AZ by default.

The public entry path is:

```text
User / Zoom -> CloudFront -> public ALB -> private ECS tasks
```

`app_services_assign_public_ip = false` by default, so the always-on
`frontend`, `backend`, and `rtms-control` tasks do not receive public IPs. The
ALB target groups use IP targets and security groups allow traffic from the ALB
to the task ports. `/ws*` still routes through CloudFront and ALB to the backend,
so WebSockets do not require public ECS task IPs.

`rtms_worker_assign_public_ip = false` by default, so per-meeting RTMS workers
also run in private subnets. Private tasks use the shared NAT gateway for
outbound access to Zoom, ECR, SSM/KMS, OpenRouter, and other required APIs.

For large fleets, set `use_scalable_rtms_worker_subnets = true` and provide one
or more dedicated `/20` CIDRs. Each Fargate task in `awsvpc` mode consumes a
private IP, so the original `/24` worker subnets are not sufficient for 2,000
concurrent workers. A single `/20` supports the IP count but concentrates
workers in one AZ; add a second CIDR for AZ resilience. Set
`nat_gateway_per_az = true` for AZ-local egress and resilience; this adds NAT
gateway hourly and per-GB processing charges.

## Does This Sleep?

No, not for the webhook path. This template does not use Lambda or API Gateway.
The ALB is managed by AWS, and the `rtms-control` ECS service keeps
`rtms_control_desired_count = 1` by default. ECS will keep one task running and
replace it if it fails.

Per-meeting RTMS workers are intentionally not always-on. They are launched on
demand by `rtms-control` and exit when the meeting stream ends.

## Secrets

Recommended production location:

- SSM Parameter Store `SecureString`
- Prefix: `/arlo/prod` by default
- KMS key: `alias/arlo-prod` by default

Expected parameter names:

- `/arlo/prod/database-url` generated from AWS RDS when `create_database = true`
- `/arlo/prod/zoom-client-id`
- `/arlo/prod/zoom-client-secret`
- `/arlo/prod/zoom-webhook-secret-token`
- `/arlo/prod/session-secret`
- `/arlo/prod/redis-encryption-key`
- `/arlo/prod/internal-webhook-secret`
- `/arlo/prod/openrouter-api-key` only when `ai_enabled = true`

`zoom-webhook-secret-token` is the Zoom Marketplace Event Subscriptions secret
token used to verify Zoom webhook signatures. `internal-webhook-secret` is for
signing internal control-plane calls.

## Apply Flow

Copy the non-secret variables:

```bash
cd deploy/aws/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with image URIs, `public_url`, and optional
`certificate_arn`/Route53 values.

For production, create the KMS key first, then write secrets directly to SSM so
they do not enter Terraform state:

```bash
terraform init
terraform apply -target=aws_kms_key.secrets -target=aws_kms_alias.secrets

export AWS_REGION=us-east-1
export SSM_PREFIX=/arlo/prod
export KMS_KEY_ID=alias/arlo-prod
export ZOOM_CLIENT_ID='...'
export ZOOM_CLIENT_SECRET='...'
export ZOOM_WEBHOOK_SECRET_TOKEN='...'
export SESSION_SECRET="$(openssl rand -hex 32)"
export REDIS_ENCRYPTION_KEY="$(openssl rand -hex 16)"
export INTERNAL_WEBHOOK_SECRET="$(openssl rand -hex 32)"

SKIP_DATABASE_URL=true ./put-secrets.sh
terraform apply
```

For a disposable bootstrap, copy `secrets.auto.tfvars.example` to
`secrets.auto.tfvars` and fill it in. That is easier, but Terraform state will
contain the secret values.

## HTTPS and FQDN

The ALB output `alb_dns_name` is a native AWS FQDN. For production Zoom webhooks,
use a custom domain plus an ACM certificate:

- Set `public_url = "https://arlo.example.com"`.
- Set `custom_domain_name = "arlo.example.com"`.
- Set `route53_zone_id` if Route53 should create the alias record.
- Set `certificate_arn` to a certificate in the same region as the ALB.

Without `certificate_arn`, Terraform creates an HTTP listener only. That is for
bootstrap testing, not production Zoom webhook delivery.
