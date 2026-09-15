# AWS Terraform: Scalable RTMS First Cut

This template is the AWS-first deployment shape for scaling Arlo RTMS:

- Public CloudFront distribution and public ALB with a native AWS HTTPS FQDN.
- Always-on ECS/Fargate services for `frontend`, `backend`, and `rtms-control` in private subnets by default.
- `rtms-control` is where the webhook hub, dispatcher, webhook spoke, and compute launcher should run.
- Per-meeting RTMS compute jobs run as ECS/Fargate `RunTask` tasks from `rtms_worker_image`.
- Optional encrypted private AWS RDS MySQL 8.0 database with `DATABASE_URL` written to SSM.
- DynamoDB On-Demand is the control store for idempotency, routing, leases, task ARNs, and stop handling.
- KMS encrypts the DynamoDB table and SSM `SecureString` secrets.
- CloudWatch logs are disabled by default to avoid log spend.

## Prerequisites

Install and verify:

- AWS CLI with permission to manage the target account and region.
- Terraform >= 1.6.
- Docker with permission to build images and push to ECR.
- A unique VPC CIDR for this environment.
- Zoom credentials and an Arlo-compatible MySQL connection, either created by
  this stack or supplied through SSM.

Confirm the AWS account before applying:

```bash
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

The command must return the account intended for this environment. Do not use
the production Terraform state for a mock deployment.

## Container Images and ECR

Terraform does not build or push images. It expects these four image URIs in
`terraform.tfvars`:

- `arlo-backend`
- `arlo-frontend`
- `arlo-rtms-control`
- `arlo-rtms-worker`

Create the repositories once, if they do not already exist:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

for repository in arlo-backend arlo-frontend arlo-rtms-control arlo-rtms-worker; do
  aws ecr describe-repositories \
    --region "$AWS_REGION" \
    --repository-names "$repository" >/dev/null 2>&1 || \
  aws ecr create-repository \
    --region "$AWS_REGION" \
    --repository-name "$repository" >/dev/null
done
```

Build and push an immutable Git-tagged release. The RTMS control and worker
tasks use the same Dockerfile; `RTMS_WORKER_MODE` selects the runtime mode.

```bash
export IMAGE_TAG="$(git rev-parse --short HEAD)"

docker build -t "$ECR_REGISTRY/arlo-backend:$IMAGE_TAG" ./backend
docker build -t "$ECR_REGISTRY/arlo-frontend:$IMAGE_TAG" ./frontend
docker build -t "$ECR_REGISTRY/arlo-rtms-control:$IMAGE_TAG" ./rtms
docker tag "$ECR_REGISTRY/arlo-rtms-control:$IMAGE_TAG" \
  "$ECR_REGISTRY/arlo-rtms-worker:$IMAGE_TAG"

docker push "$ECR_REGISTRY/arlo-backend:$IMAGE_TAG"
docker push "$ECR_REGISTRY/arlo-frontend:$IMAGE_TAG"
docker push "$ECR_REGISTRY/arlo-rtms-control:$IMAGE_TAG"
docker push "$ECR_REGISTRY/arlo-rtms-worker:$IMAGE_TAG"
```

Use the four resulting URIs, including `IMAGE_TAG`, for `backend_image`,
`frontend_image`, `rtms_control_image`, and `rtms_worker_image`. Avoid using
`latest` for production because ECS will not reliably detect an unchanged tag.

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

Edit `terraform.tfvars` with image URIs and non-secret settings. For the
current supported public path, leave `public_url`, `custom_domain_name`,
`route53_zone_id`, and `certificate_arn` empty; Terraform will use the native
CloudFront HTTPS hostname after apply.

For a new mock environment, use a separate Terraform state directory or a
separate remote-backend state key. Set at least these values so it cannot share
production names or networking:

```hcl
environment          = "mock"
vpc_cidr             = "10.43.0.0/16"
ssm_parameter_prefix = "/arlo/mock"
kms_alias_name       = "alias/arlo-mock"
public_url           = ""
custom_domain_name   = ""
route53_zone_id      = ""
certificate_arn       = ""
```

With an empty `public_url`, Terraform uses the CloudFront distribution's native
HTTPS hostname after apply. A mock stack should use a separate MySQL database;
the default `create_database = true` creates one. If `create_database = false`,
write a dedicated `/arlo/mock/database-url` SecureString and provide network
connectivity to that remote database before starting ECS.

For a mock stack, after editing `terraform.tfvars` and pushing the images, run
the normal validation and apply flow below. Keep its state and secret prefix
separate from production.

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

# If create_database=true, Terraform creates RDS and its database-url parameter.
SKIP_DATABASE_URL=true ./put-secrets.sh
# If create_database=false, supply the existing remote MySQL URL instead:
# export DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/arlo?connection_limit=5'
# ./put-secrets.sh
terraform fmt -check
terraform validate
terraform plan -out=arlo.tfplan
terraform apply arlo.tfplan
```

For a mock stack with `create_database = true`, use the same flow after changing
the values above and use `SSM_PREFIX=/arlo/mock` and
`KMS_KEY_ID=alias/arlo-mock` when running `put-secrets.sh`. If the mock stack
creates RDS, keep `SKIP_DATABASE_URL=true`; Terraform creates the database URL
parameter during the full apply. If `create_database = false`, export
`DATABASE_URL` and run `./put-secrets.sh` without `SKIP_DATABASE_URL=true`.

For a disposable bootstrap, copy `secrets.auto.tfvars.example` to
`secrets.auto.tfvars` and fill it in. That is easier, but Terraform state will
contain the secret values.

## HTTPS and FQDN

The supported viewer endpoint is the CloudFront native hostname returned by
`cloudfront_domain_name`. CloudFront uses its AWS-managed default certificate,
redirects HTTP to HTTPS, and applies the Zoom App security response headers.
Use that hostname for the Zoom App Home URL, OAuth redirect URL, webhook URL,
and browser WebSocket URL.

The current template does not yet implement a working custom domain on
CloudFront. `custom_domain_name` creates a Route 53 alias directly to the ALB;
it does not create a CloudFront alias or viewer certificate. The ALB listener
also requires the CloudFront origin header, so that direct alias is not a
working public endpoint as currently written. A custom production domain needs
additional Terraform for a CloudFront alias and an ACM certificate in
`us-east-1`. Do not set `public_url` to a custom domain until that work is
complete.

`certificate_arn` is a regional ALB certificate input, not a CloudFront viewer
certificate. Setting it alone does not add a custom CloudFront hostname.

## Outputs and Teardown

After apply, retrieve the public endpoints:

```bash
terraform output -raw cloudfront_domain_name
terraform output -raw zoom_rtms_webhook_url
terraform output -raw alb_dns_name
```

Use the CloudFront URL for the Zoom App and webhook configuration. The ALB DNS
name is the CloudFront origin and is not the production viewer endpoint.

To remove a disposable mock stack, first verify the selected Terraform state:

```bash
terraform workspace show
terraform destroy
```

ECR repositories and images created outside this Terraform root are not removed
by `terraform destroy`.
