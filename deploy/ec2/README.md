# Single-host AWS EC2 deployment

For complete first-deployment, update, verification, and rollback commands, see
[Manual AWS CLI deployment](AWS_CLI_DEPLOYMENT.md).

For the scheduled AWS pull/build/deploy workflow, see
[`pipeline/README.md`](pipeline/README.md). The manual procedure remains
available for bootstrap and recovery.

This deployment runs the frontend, backend, and RTMS services on one x86 EC2
instance. CloudFront and the ALB remain the public application entrypoint. The
current `main` application runs in demo mode and does not use a database or
persist users, OAuth tokens, meetings, transcripts, or generated artifacts.

The EC2 instance uses an Elastic IP for outbound Zoom, OpenRouter, SSM, and ECR
access without a NAT Gateway. Its security group must allow ports 3000-3001
only from the ALB security group; do not permit public ingress or SSH. The ALB
continues to reach the instance over its private VPC address.

## Required SSM parameters

All sensitive parameters are `SecureString` values encrypted with
`alias/arlo-prod`:

- `/arlo/prod/zoom-client-id`
- `/arlo/prod/zoom-client-secret`
- `/arlo/prod/zoom-webhook-secret-token`
- `/arlo/prod/session-secret`
- `/arlo/prod/token-encryption-key`
- `/arlo/prod/openrouter-api-key`

Existing deployments may continue using `/arlo/prod/redis-encryption-key`; the
startup script checks that legacy parameter when `token-encryption-key` is not
present. The OpenRouter parameter is optional.

## Host files

Install these files with root ownership:

- `docker-compose.yml` -> `/opt/arlo/docker-compose.yml`
- `start.sh` -> `/opt/arlo/start.sh` with mode `0750`
- `arlo.service` -> `/etc/systemd/system/arlo.service`

Create `/etc/arlo/images.env` with mode `0600` containing immutable ECR image
references. The model variables are optional runtime settings and must contain
only free OpenRouter model IDs:

```dotenv
FRONTEND_IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/arlo-frontend:TAG
BACKEND_IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/arlo-backend:TAG
RTMS_IMAGE=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/arlo-rtms:TAG
AWS_REGION=us-east-1
PARAMETER_PREFIX=/arlo/prod
PUBLIC_URL=https://your-public-domain.example
OPENROUTER_MODELS=nex-agi/nex-n2.5-mini:free,nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free,thinkingmachines/inkling:free,poolside/laguna-s-2.1:free,liquid/lfm-2.5-2.6b:free
DEFAULT_MODEL=nex-agi/nex-n2.5-mini:free
FALLBACK_MODEL=nvidia/nemotron-3.5-lightning:free
```

Then run `systemctl daemon-reload` and `systemctl enable --now arlo`.

Restarting the backend clears its in-memory users and OAuth tokens, so users may
need to authorize the Zoom App again after a deployment or host restart.
