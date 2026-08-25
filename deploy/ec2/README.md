# Single-host AWS EC2 deployment

This deployment runs the frontend, backend, and RTMS services on one x86 EC2
instance. CloudFront and the ALB remain the public application entrypoint. The
Aurora MySQL database is external to the Compose stack.

The EC2 instance uses an Elastic IP for outbound Zoom, OpenRouter, SSM, and ECR
access without a NAT Gateway. Its security group must allow ports 3000-3001
only from the ALB security group; do not permit public ingress or SSH. The ALB
continues to reach the instance over its private VPC address.

## Required SSM parameters

All sensitive parameters are `SecureString` values encrypted with
`alias/arlo-prod`:

- `/arlo/prod/database-url`
- `/arlo/prod/zoom-client-id`
- `/arlo/prod/zoom-client-secret`
- `/arlo/prod/zoom-webhook-secret-token`
- `/arlo/prod/session-secret`
- `/arlo/prod/redis-encryption-key`
- `/arlo/prod/openrouter-api-key`

The database parameter must contain the existing least-privilege application
connection string, not a database master credential. The service refuses to
start when that parameter is absent.

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
OPENROUTER_MODELS=z-ai/glm-5.2:free,google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free
DEFAULT_MODEL=z-ai/glm-5.2:free
FALLBACK_MODEL=google/gemma-4-31b-it:free
```

Then run `systemctl daemon-reload` and `systemctl enable --now arlo`.

Do not run `prisma db push` during application startup. This deployment uses
the schema and data already present in the Aurora MySQL database.
